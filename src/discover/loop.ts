/**
 * THE DISCOVERY LOOP — the one place a model is in the decision loop.
 *
 * Observe → decide → act, bounded, against a live surface. Everything the model
 * asks for goes through `SurfaceAdapter.act()`, which means the policy gate
 * applies to the agent exactly as it applies to replay, with no special-casing
 * and nothing for the agent to route around. That is the whole reason this file
 * needs no security logic of its own.
 *
 * WHY A HAND-WRITTEN LOOP rather than the SDK's tool runner. Three things have
 * to happen between the model naming a step and the surface receiving it:
 * the step is recorded into a trace that will be compiled, the action is
 * translated into the adapter's vocabulary, and the result — including a policy
 * refusal or an unresolvable anchor — is fed back as an observation the model
 * must reason about. Owning the loop makes each of those explicit and keeps the
 * beta tool-runner dependency out of a submission whose thesis is determinism.
 *
 * WHAT THIS FILE PRODUCES is a trace, not an artifact. The compiler
 * (src/discover/compile.ts) turns a trace into a capability. Keeping them apart
 * is what makes the unfakeable half — a real model driving a real UI —
 * testable at all: the loop is nondeterministic by construction, while the
 * compiler is a pure function over a recorded trace and is unit-tested against
 * a frozen one.
 *
 * MODEL-CALL ACCOUNTING. `recordModelCall()` is called immediately before every
 * request. That counter is the same one every replay result reports, which is
 * what makes `modelCalls=0` on a replay a measurement rather than a claim.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedAction, SurfaceAdapter, SurfaceSnapshot } from '../adapter/surface.js';
import { PolicyDenied } from '../adapter/surface.js';
import type { Relation, Target } from '../schema/target.js';
import { recordModelCall } from '../replay/guard.js';
import { renderSnapshot } from './observe.js';
import { DISCOVERY_SYSTEM, DISCOVERY_TOOLS } from './tools.js';
import { selectProvider, type ModelProvider, type ToolDef, type ToolResult } from './provider.js';
import type { Redactor } from '../policy/redact.js';

export const DISCOVERY_MODEL = 'claude-opus-5';

export interface ProposedTarget {
  anchorKind: 'label' | 'self' | 'column-header' | 'landmark' | 'param';
  anchorText: string;
  relation: Relation;
  index?: number;
  rationale: string;
  description: string;
}

export interface ProposedStep {
  action: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'read' | 'wait';
  intent: string;
  target?: ProposedTarget;
  value?: string;
  key?: string;
  url?: string;
  bindTo?: string;
  reversibility: 'safe' | 'reversible' | 'irreversible';
}

export interface TraceEntry {
  index: number;
  step: ProposedStep;
  /** What actually happened when the step was executed against the surface. */
  status: 'ok' | 'unresolved' | 'refused' | 'error';
  detail?: string;
  screenBefore: string;
  screenAfter: string;
  /** For `read` steps: the value captured. Fingerprinted, never stored raw. */
  captured?: string;
  /** Which ladder rung resolved the target — drift signal, kept as evidence. */
  strategy?: string;
}

export interface DiscoveryOutput {
  name: string;
  from: string;
  type: 'string' | 'number' | 'money' | 'date' | 'boolean';
  description: string;
}

export interface DiscoveryTrace {
  goal: string;
  surface: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  /** How the run ended. Only `goal-met` is worth compiling. */
  outcome: 'goal-met' | 'gave-up' | 'max-steps' | 'error';
  summary?: string;
  outputs: DiscoveryOutput[];
  /** Sample values the run was driven with, for parameter inference. */
  inputs: Record<string, string>;
  entries: TraceEntry[];
  reason?: string;
  modelCalls: number;
}

export interface DiscoverDeps {
  goal: string;
  adapter: SurfaceAdapter;
  /** Sample values. The compiler turns these into typed input parameters. */
  inputs: Record<string, string>;
  /**
   * Where the flow starts. The brief's input is "a goal AND a target
   * (app/URL/entry point)", and this is the second half.
   *
   * Without it the agent opens on a blank page and has to guess an address it
   * was never told — which it cannot do, because the policy gate correctly
   * refuses a relative URL. The first real run failed exactly that way: the
   * model proposed navigating to "/", was refused, probed twice and gave up.
   * That was the harness's fault, not the model's.
   */
  entryUrl?: string;
  /** Origins the agent may navigate to. Told to it, not left to be discovered. */
  allowedOrigins?: string[];
  /**
   * NAMES of environment variables holding sign-in credentials — never values.
   *
   * The agent is told it must write {{env.NAME}} rather than a literal secret,
   * but not told which names exist, it will invent one. The second real run
   * failed exactly there: it guessed {{env.USERNAME}}, got "no value for this
   * run", and gave up rather than fabricating a credential. Correct behaviour,
   * missing input.
   */
  credentialEnvVars?: string[];
  maxSteps?: number;
  model?: string;
  evidenceDir: string;
  redact: Redactor;
  /** Injected in tests to script the model. Selected from the environment otherwise. */
  provider?: ModelProvider;
  /** Injectable clock, so a trace fixture is reproducible. */
  now?: () => Date;
}

/** Rebuild the schema's discriminated union from the model's flat proposal. */
export function toTarget(p: ProposedTarget): Target {
  const anchor =
    p.anchorKind === 'param'
      ? ({ kind: 'param', name: p.anchorText } as const)
      : ({ kind: p.anchorKind, text: p.anchorText } as const);
  return {
    anchor,
    relation: p.relation,
    rationale: p.rationale,
    description: p.description,
    ...(p.index === undefined ? {} : { index: p.index }),
  };
}

/** Expand {{inputs.x}} / {{env.x}} in a proposed value, for live execution. */
function expand(raw: string, inputs: Record<string, string>): string {
  return raw.replace(/\{\{\s*(inputs|env)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, scope, name) => {
    const v = scope === 'inputs' ? inputs[name] : process.env[name];
    if (v === undefined) throw new Error(`${scope}.${name} has no value for this discovery run`);
    return v;
  });
}

export async function discover(deps: DiscoverDeps): Promise<DiscoveryTrace> {
  const now = deps.now ?? (() => new Date());
  const maxSteps = deps.maxSteps ?? 24;
  const startedAt = now().toISOString();

  const provider =
    deps.provider ??
    selectProvider({
      system: DISCOVERY_SYSTEM,
      tools: DISCOVERY_TOOLS as unknown as ToolDef[],
      ...(deps.model === undefined ? {} : { model: deps.model }),
    });

  const entries: TraceEntry[] = [];
  let outputs: DiscoveryOutput[] = [];
  let outcome: DiscoveryTrace['outcome'] = 'max-steps';
  let summary: string | undefined;
  let reason: string | undefined;
  let modelCallsMade = 0;

  // Open the entry point BEFORE the first observation, and record it as the
  // flow's first step so the compiled capability starts where the run did.
  // Routed through act() like everything else, so the policy gate applies to
  // the entry point too rather than it being a privileged back door.
  if (deps.entryUrl !== undefined) {
    entries.push({
      index: 0,
      step: {
        action: 'navigate',
        intent: 'open the application entry point',
        url: deps.entryUrl,
        reversibility: 'safe',
      },
      status: 'ok',
      screenBefore: 'about:blank',
      screenAfter: 'about:blank',
    });
    try {
      await deps.adapter.act({ kind: 'navigate', url: deps.entryUrl });
      await deps.adapter.settle(20_000);
    } catch (err) {
      const first = entries[0] as TraceEntry;
      first.status = err instanceof PolicyDenied ? 'refused' : 'error';
      first.detail = String(err);
    }
  }

  let snapshot: SurfaceSnapshot = await deps.adapter.observe();
  if (entries[0]) entries[0].screenAfter = snapshot.screenId;

  // The opening turn: goal, where we are, what the agent may reach, the sample
  // values, and the screen. Everything after this is a tool result plus the
  // new screen.
  let next: { userText?: string; toolResults?: ToolResult[] } = {
    userText:
      `GOAL: ${deps.goal}\n\n` +
      (deps.entryUrl !== undefined
        ? `You have already been navigated to the application entry point: ${deps.entryUrl}\n`
        : '') +
      // Told, not discovered. An agent that has to guess an address will guess
      // a relative one, and the policy gate will refuse it — which reads to the
      // agent as a broken application rather than as a missing instruction.
      (deps.allowedOrigins?.length
        ? `You may only navigate within these origins; anything else is refused by a policy layer beneath you: ${deps.allowedOrigins.join(', ')}\n` +
          `Always use an absolute URL, never a relative path.\n`
        : '') +
      (deps.credentialEnvVars?.length
        ? `If a sign-in is required, these environment variables hold the credentials. Reference them ` +
          `EXACTLY as shown and never write a literal secret: ` +
          deps.credentialEnvVars.map((n) => `{{env.${n}}}`).join(', ') +
          `\n`
        : '') +
      '\n' +
      (Object.keys(deps.inputs).length > 0
        ? `You are being driven with these sample parameter values. Refer to them as {{inputs.NAME}} in any step so the recording works for every caller:\n` +
          Object.entries(deps.inputs)
            .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
            .join('\n') +
          '\n\n'
        : '') +
      `Current screen:\n\n${renderSnapshot(snapshot)}`,
  };

  try {
    for (let i = 0; i < maxSteps; i++) {
      // Counted HERE, not in the provider: one increment per turn, whoever is
      // answering. That keeps the replay guard binding on every provider —
      // including a scripted test double — rather than on the two that happen
      // to remember to call it.
      recordModelCall();
      modelCallsMade += 1;
      const turn = await provider.send(next);

      if (turn.refusal !== undefined) {
        outcome = 'error';
        reason = turn.refusal;
        break;
      }

      if (turn.calls.length === 0) {
        // The model answered in prose instead of acting. Nudge once with the
        // screen again rather than treating it as terminal.
        next = {
          userText: `You did not call a tool. Act on the goal using perform_step, or stop with finish or give_up.\n\nCurrent screen:\n\n${renderSnapshot(snapshot)}`,
        };
        continue;
      }

      const results: ToolResult[] = [];
      let stop = false;

      for (const call of turn.calls) {
        if (call.name === 'finish') {
          const input = call.input as unknown as { summary: string; outputs: DiscoveryOutput[] };
          summary = input.summary;
          outputs = input.outputs ?? [];
          outcome = 'goal-met';
          stop = true;
          results.push({ id: call.id, content: 'recorded' });
          break;
        }
        if (call.name === 'give_up') {
          reason = (call.input as unknown as { reason: string }).reason;
          outcome = 'gave-up';
          stop = true;
          results.push({ id: call.id, content: 'recorded' });
          break;
        }

        const step = call.input as unknown as ProposedStep;
        const entry = await executeStep(step, deps, snapshot, entries.length);
        entries.push(entry);
        snapshot = await deps.adapter.observe();
        entry.screenAfter = snapshot.screenId;

        results.push({
          id: call.id,
          ...(entry.status === 'ok' ? {} : { isError: true }),
          content:
            (entry.status === 'ok'
              ? `OK${entry.captured !== undefined ? ` — captured ${JSON.stringify(entry.captured)}` : ''}${entry.strategy ? ` (resolved via ${entry.strategy})` : ''}`
              : `${entry.status.toUpperCase()}: ${entry.detail ?? 'no detail'}`) +
            `\n\nCurrent screen:\n\n${renderSnapshot(snapshot)}`,
        });
      }

      next = { toolResults: results };
      if (stop) break;
    }
  } catch (err) {
    outcome = 'error';
    reason = String(err);
  }

  const model = provider.model;

  const trace: DiscoveryTrace = {
    goal: deps.goal,
    surface: deps.adapter.kind,
    model: `${provider.name}:${model}`,
    startedAt,
    finishedAt: now().toISOString(),
    outcome,
    ...(summary === undefined ? {} : { summary }),
    outputs,
    inputs: deps.inputs,
    entries,
    ...(reason === undefined ? {} : { reason }),
    modelCalls: modelCallsMade,
  };

  await writeTraceEvidence(trace, provider.transcript(), deps);
  return trace;
}

/** Translate one proposed step into an adapter action and run it. */
async function executeStep(
  step: ProposedStep,
  deps: DiscoverDeps,
  snapshot: SurfaceSnapshot,
  index: number,
): Promise<TraceEntry> {
  const entry: TraceEntry = {
    index,
    step,
    status: 'ok',
    screenBefore: snapshot.screenId,
    screenAfter: snapshot.screenId,
  };

  try {
    let action: ResolvedAction;

    if (step.action === 'navigate') {
      action = { kind: 'navigate', url: expand(step.url ?? '', deps.inputs) };
    } else if (step.action === 'press') {
      action = { kind: 'press', key: step.key ?? 'Enter' };
    } else if (step.action === 'wait') {
      action = { kind: 'wait', ms: 1_000 };
    } else {
      if (!step.target) {
        entry.status = 'error';
        entry.detail = `action '${step.action}' requires a target`;
        return entry;
      }
      const res = await deps.adapter.resolve(toTarget(step.target), {
        snapshot,
        inputs: deps.inputs,
      });
      if (!res.ok) {
        entry.status = 'unresolved';
        entry.detail = res.detail;
        return entry;
      }
      entry.strategy = res.resolution.strategy;
      const el = res.resolution.element;

      if (step.action === 'read') {
        // A read changes nothing, so it never reaches act(). The captured value
        // is what the caller will eventually get back.
        entry.captured = el.value ?? el.text ?? '';
        return entry;
      }

      const value = expand(step.value ?? '', deps.inputs);
      const isSecret = /\{\{\s*env\./.test(step.value ?? '');
      action =
        step.action === 'fill'
          ? { kind: 'fill', element: el, value, ...(isSecret ? { redact: true } : {}) }
          : step.action === 'select'
            ? { kind: 'select', element: el, value }
            : { kind: 'click', element: el };
    }

    await deps.adapter.act(action);
    await deps.adapter.settle(10_000);
  } catch (err) {
    if (err instanceof PolicyDenied) {
      // Reported back to the model as a refusal it must respect, not as a
      // failure to route around. This is the path a prompt-injected instruction
      // takes, and the trace records that it was refused.
      entry.status = 'refused';
      entry.detail = err.message;
      return entry;
    }
    entry.status = 'error';
    entry.detail = String(err);
  }
  return entry;
}

/**
 * Persist the run as EVIDENCE, not as an artifact.
 *
 * The brief asks for the artifact to be decoupled from the raw model
 * transcript, so both are written and they are different things: the trace is
 * the structured record the compiler consumes, and the transcript is the
 * unedited conversation kept so a reviewer can check that the run happened and
 * see what the model was actually shown.
 */
async function writeTraceEvidence(
  trace: DiscoveryTrace,
  transcript: unknown,
  deps: DiscoverDeps,
): Promise<void> {
  await mkdir(deps.evidenceDir, { recursive: true });

  await writeFile(
    join(deps.evidenceDir, 'trace.json'),
    deps.redact(JSON.stringify(trace, null, 2)) + '\n',
    'utf8',
  );
  await writeFile(
    join(deps.evidenceDir, 'transcript.json'),
    deps.redact(JSON.stringify(transcript, null, 2)) + '\n',
    'utf8',
  );

  const log = trace.entries
    .map(
      (e) =>
        `#${e.index} ${e.step.action.toUpperCase()} ${e.status}` +
        `\n    intent: ${e.step.intent}` +
        (e.step.target
          ? `\n    target: ${e.step.target.anchorKind}:${JSON.stringify(e.step.target.anchorText)} ${e.step.target.relation}` +
            `\n    why:    ${e.step.target.rationale}`
          : '') +
        (e.strategy ? `\n    via:    ${e.strategy}` : '') +
        (e.captured !== undefined ? `\n    read:   ${JSON.stringify(e.captured)}` : '') +
        (e.detail ? `\n    detail: ${e.detail}` : ''),
    )
    .join('\n');

  await writeFile(
    join(deps.evidenceDir, 'discovery.log'),
    deps.redact(
      `goal: ${trace.goal}\nsurface: ${trace.surface}\nmodel: ${trace.model}\n` +
        `started: ${trace.startedAt}\nfinished: ${trace.finishedAt}\n` +
        `outcome: ${trace.outcome}${trace.reason ? ` (${trace.reason})` : ''}\n` +
        `model calls: ${trace.modelCalls}\n\n${log}\n`,
    ),
    'utf8',
  );
}
