/**
 * THE REPLAY ENGINE — the production execution path.
 *
 * This is what an AI agent triggers. It takes a saved capability plus input
 * parameters and re-runs the recorded flow with NO MODEL IN THE DECISION LOOP.
 * Every branch it can take is declared in the artifact: a step's precondition
 * and checkpoint, a declared OutcomeDetector, a declared RecoveryPolicy with a
 * hard attempt cap, or a halt. There is no path that improvises.
 *
 * FOUR ORDERING DECISIONS THAT CARRY THE DESIGN
 *
 * 1. OUTCOMES ARE CHECKED BEFORE A CHECKPOINT FAILURE IS BELIEVED.
 *    Searching for a member who does not exist makes "balance is present"
 *    legitimately false. If the engine treated checkpoint-false as failure
 *    first, every business answer would surface as a crash — the exact error the
 *    brief calls the most common one in this problem. So after acting we ask
 *    "did something the capability DECLARED happen?" before asking "did what I
 *    expected happen?".
 *
 * 2. RECOVERY IS TRIED ONLY AFTER OUTCOMES, AND IS CAPPED.
 *    A declared recovery fires only for a declared condition, at most
 *    `maxAttempts` times, and then the run fails with `recovery-exhausted`
 *    rather than looping. A recurring dialog cannot spin forever.
 *
 * 3. A PRECONDITION FAILURE AND A CHECKPOINT FAILURE ARE DIFFERENT FAILURES.
 *    Precondition means we refused to act and NOTHING happened. Checkpoint means
 *    we acted and the result was wrong, so something may well have happened.
 *    Those have different blast radii, so `retrySafe` and `executedUpTo` are
 *    reported and the reasons are distinct.
 *
 * 4. THE APPROVAL GATE RUNS BEFORE THE BROWSER IS EVEN TOUCHED.
 *    An irreversible capability that is still a draft is refused up front, so a
 *    refusal can never leave a half-executed side effect behind.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Capability, OutcomeDetector, Step } from '../schema/capability.js';
import { templateRefs } from '../schema/capability.js';
import type { TenantOverride } from '../schema/override.js';
import { describeCondition } from '../schema/condition.js';
import type {
  ResolveContext,
  ResolveStrategy,
  ResolvedAction,
  SurfaceAdapter,
  SurfaceSnapshot,
} from '../adapter/surface.js';
import { PolicyDenied } from '../adapter/surface.js';
import type {
  FailureReason,
  InterventionRecord,
  RecoveryRecord,
  ReplayResult,
  RunWarning,
} from '../schema/result.js';
import type { Reversibility } from '../schema/capability.js';
import { evaluate } from './conditions.js';
import { modelCalls, withReplayGuard } from './guard.js';

const RANK: Record<Reversibility, number> = { safe: 0, reversible: 1, irreversible: 2 };

/** Context handed to a human when automation stops. */
export interface InterventionRequest {
  interventionId: string;
  capabilityId: string;
  capabilityVersion: string;
  goal: string;
  stepId: string;
  reason: string;
  snapshotPath: string;
  sessionId: string;
  requestedAt: string;
}

/** What the operator channel reports back after a takeover. */
export interface InterventionOutcome {
  operatorId?: string;
  /** Snapshot text after the human acted, for the state delta. */
  snapshotTextAfter: string;
  heldMs: number;
}

export interface ReplayDeps {
  capability: Capability;
  inputs: Record<string, string>;
  adapter: SurfaceAdapter;
  tenant: string;
  override?: TenantOverride;
  /**
   * True when a human is watching. Unattended replay of an irreversible,
   * unapproved capability is refused.
   */
  attended?: boolean;
  evidenceDir?: string;
  /**
   * Handler for a takeover. If omitted, the engine PARKS and returns a
   * non-terminal `intervention` result — a caller with no operator channel
   * should get a resumable state, not an invented error.
   */
  escalate?: (req: InterventionRequest) => Promise<InterventionOutcome>;
  /**
   * Bring a human in when a step gets stuck, instead of failing.
   *
   * OFF by default, and deliberately so. Escalation pins a live session open
   * waiting for a person; turning that on implicitly would mean an unattended
   * batch run could hang on a checkpoint nobody is watching. A caller that
   * wants a human in the loop says so.
   *
   * With this on and no `escalate` handler, the run PARKS: it returns a
   * resumable `intervention` result (exit 4) rather than inventing an error —
   * which is the right answer for a caller that has no operator channel wired
   * up but still wants the session preserved.
   */
  escalateOnStuck?: boolean;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => Date;
  /** Secret resolution for `redact: true` steps. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * One line of the run's own account of itself, written for every step.
 *
 * Deliberately records HOW a target resolved, not just that it did: a step that
 * used to resolve by explicit label association and now resolves by reading
 * order has not failed, but it has drifted, and comparing this field across
 * runs is where that shows up.
 */
interface StepRecord {
  id: string;
  action: string;
  status: 'ok' | 'failed';
  screenId?: string;
  strategy?: string;
  confidence?: number;
  resolved?: string;
  bindTo?: string;
  detail?: string;
}

interface RunState {
  stepLog: StepRecord[];
  bindings: Map<string, string>;
  warnings: RunWarning[];
  recoveries: RecoveryRecord[];
  interventions: InterventionRecord[];
  evidence: string[];
  recoveryAttempts: Map<string, number>;
  executedUpTo: Reversibility;
  snapshot: SurfaceSnapshot | null;
}

export async function replay(deps: ReplayDeps): Promise<ReplayResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const runId = `run-${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const cap = deps.capability;
  const modelCallsBefore = modelCalls();

  const state: RunState = {
    stepLog: [],
    bindings: new Map(),
    warnings: [],
    recoveries: [],
    interventions: [],
    evidence: [],
    recoveryAttempts: new Map(),
    executedUpTo: 'safe',
    snapshot: null,
  };

  const finish = (partial: Omit<ReplayResult, keyof RunBaseShape> & Partial<RunBaseShape>): ReplayResult => {
    const finishedAt = now().toISOString();
    const base = {
      runId,
      capabilityId: cap.id,
      capabilityVersion: cap.version,
      tenant: deps.tenant,
      surface: cap.surface,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      // MEASURED, not asserted. See src/replay/guard.ts for why this matters.
      modelCalls: modelCalls() - modelCallsBefore,
      warnings: state.warnings,
      evidence: state.evidence,
    };
    return { ...base, ...partial } as ReplayResult;
  };

  const fail = (
    reason: FailureReason,
    expected: string,
    observed: string,
    opts: { stepId?: string; retrySafe?: boolean } = {},
  ): ReplayResult =>
    finish({
      kind: 'failure',
      reason,
      ...(opts.stepId === undefined ? {} : { failedStepId: opts.stepId }),
      expected,
      observed,
      retrySafe: opts.retrySafe ?? true,
      executedUpTo: state.executedUpTo,
      recoveries: state.recoveries,
      interventions: state.interventions,
    } as never);

  // ---------------------------------------------------------------------------
  // PRE-FLIGHT — before the surface is touched at all.
  // ---------------------------------------------------------------------------

  for (const p of cap.inputs) {
    if (p.required && (deps.inputs[p.name] === undefined || deps.inputs[p.name] === '')) {
      return fail('input-invalid', `input '${p.name}' provided`, `'${p.name}' missing`);
    }
  }

  if (deps.override && deps.override.baseVersion !== cap.version) {
    // A patch reviewed against another version must not apply unexamined.
    return fail(
      'artifact-invalid',
      `override baseVersion ${deps.override.baseVersion} matches capability ${cap.version}`,
      `override targets ${deps.override.baseVersion}, capability is ${cap.version} — re-review required`,
    );
  }

  const attended = deps.attended ?? false;
  if (cap.maxReversibility === 'irreversible' && cap.approvalState !== 'approved' && !attended) {
    return fail(
      'approval-required',
      `approved capability for unattended irreversible replay`,
      `capability is '${cap.approvalState}' with maxReversibility '${cap.maxReversibility}'`,
    );
  }

  // ---------------------------------------------------------------------------
  // EXECUTION — everything below runs inside the egress guard.
  // ---------------------------------------------------------------------------

  const evidenceDir = deps.evidenceDir ?? join('evidence', runId);
  const lexicon = deps.override?.lexicon;

  const warn = (kind: RunWarning['kind'], detail: string, stepId?: string) => {
    state.warnings.push({ kind, detail, ...(stepId === undefined ? {} : { stepId }) });
  };

  /**
   * Expand templates in a condition's expected text.
   *
   * Scoped to `inputs` and `bindings` on purpose. `env` is where secrets live,
   * and a condition's expected text is written verbatim into the failure
   * result, the run log and any intervention request — so an artifact that
   * asserts on `{{env.*}}` is rejected as invalid rather than quietly
   * publishing the value it was trying to check.
   */
  const expandCondition = (raw: string): string => {
    let out = raw;
    for (const ref of templateRefs(raw)) {
      if (ref.scope === 'env') {
        throw new Error(
          `a condition references env.${ref.name}; conditions may not read the environment, ` +
            `because their expected text is written to evidence`,
        );
      }
      const value = ref.scope === 'inputs' ? deps.inputs[ref.name] : state.bindings.get(ref.name);
      if (value === undefined) {
        throw new Error(`a condition references ${ref.scope}.${ref.name}, which has no value yet`);
      }
      out = out.replace(new RegExp(`\\{\\{\\s*${ref.scope}\\.${ref.name}\\s*\\}\\}`, 'g'), value);
    }
    return out;
  };

  const baseCtx = (snapshot: SurfaceSnapshot): ResolveContext => ({
    snapshot,
    inputs: deps.inputs,
    expand: expandCondition,
    ...(lexicon === undefined ? {} : { lexicon }),
    onFallback: (strategy: ResolveStrategy, detail: string) => {
      // A weaker rung firing is the earliest available drift signal, so it is
      // recorded as a warning rather than swallowed because the run passed.
      if (detail.startsWith('lexicon:')) warn('lexicon-applied', detail);
      else warn('ladder-fallback', `${strategy}: ${detail}`);
    },
  });

  const guarded = await withReplayGuard(async (): Promise<ReplayResult> => {
    for (const step of cap.steps) {
      const patched = applyStepOverride(step, deps.override, warn);
      const outcome = await runStep(patched);
      if (outcome !== null) return outcome;
    }

    // --- success condition ---------------------------------------------------
    const snap = await deps.adapter.observe();
    state.snapshot = snap;
    const successEval = await evaluate(cap.successCondition, deps.adapter, baseCtx(snap));
    if (!successEval.ok) {
      // Before declaring failure, give declared outcomes the last word: the
      // success condition failing is exactly what a business outcome looks like.
      const oc = await checkOutcomes(cap.outcomes.filter((o) => o.afterStep === undefined), snap);
      if (oc) return oc;
      await capture('success-condition-failed');
      return fail(
        'checkpoint-failed',
        describeCondition(cap.successCondition),
        successEval.detail,
        { retrySafe: state.executedUpTo === 'safe' },
      );
    }

    // --- outputs -------------------------------------------------------------
    const outputs: Record<string, string | number | boolean | null> = {};
    for (const field of cap.outputs) {
      const raw = state.bindings.get(field.from);
      if (raw === undefined) {
        if (field.optional === true) {
          warn('optional-output-missing', `output '${field.name}' (binding '${field.from}') not captured`);
          outputs[field.name] = null;
          continue;
        }
        await capture('output-missing');
        return fail(
          'output-missing',
          `output '${field.name}' from binding '${field.from}'`,
          `binding '${field.from}' was never captured`,
        );
      }
      outputs[field.name] = coerce(raw, field.type, deps.override);
    }

    const degraded =
      state.recoveries.length > 0 ||
      state.interventions.length > 0 ||
      state.warnings.some((w) => w.kind === 'ladder-fallback' || w.kind === 'adapter-hint-used');

    return finish({
      kind: 'success',
      outputs,
      degraded,
      recoveries: state.recoveries,
      interventions: state.interventions,
    } as never);
  });

  // EVERY run leaves a record, not only the ones that went wrong.
  //
  // Capturing evidence solely on failure is the tempting shape and the wrong
  // one: the brief asks for a structured log of what the run did and why, and
  // the cases you most want to compare are a good run against a bad one. It is
  // also what makes a successful replay auditable at all — "it returned 4250"
  // is not evidence, "it resolved Total Savings via text-then-reading-order at
  // step 09 and read 4,250.00" is.
  //
  // Written outside the guarded block so a run that failed inside the guard
  // still produces its record.
  await writeJson(join(evidenceDir, 'run.json'), {
    ...guarded.result,
    // The step-level detail the result contract does not carry, so a reviewer
    // can follow the run without re-executing it.
    steps: state.stepLog,
  }).catch(() => undefined);

  return guarded.result;

  // ---------------------------------------------------------------------------
  // Step execution. Returns null to continue, or a terminal/pending result.
  // ---------------------------------------------------------------------------

  async function runStep(step: Step): Promise<ReplayResult | null> {
    // --- precondition: refuse to act on an unexpected screen -----------------
    if (step.precondition) {
      const snap = await deps.adapter.observe();
      state.snapshot = snap;
      const pre = await evaluate(step.precondition, deps.adapter, baseCtx(snap));
      if (!pre.ok) {
        const oc = await checkOutcomes(outcomesFor(step.id), snap);
        if (oc) return oc;
        await capture(`precondition-${step.id}`);
        // Nothing was done, so this is unambiguously safe to retry.
        return fail('precondition-failed', describeCondition(step.precondition), pre.detail, {
          stepId: step.id,
          retrySafe: true,
        });
      }
    }

    // --- resolve and act -----------------------------------------------------
    const acted = await performAction(step);
    if (acted !== null) return acted;

    if (RANK[step.reversibility] > RANK[state.executedUpTo]) {
      state.executedUpTo = step.reversibility;
    }

    // --- settle, then look for DECLARED outcomes before judging the checkpoint
    await deps.adapter.settle(step.timeoutMs ?? 10_000);
    const snap = await deps.adapter.observe();
    state.snapshot = snap;

    const oc = await checkOutcomes(outcomesFor(step.id), snap);
    if (oc) return oc;

    // --- checkpoint ----------------------------------------------------------
    if (step.checkpoint) {
      let check = await evaluate(step.checkpoint, deps.adapter, baseCtx(snap));

      if (!check.ok) {
        const recovered = await tryRecover(step);
        if (recovered !== null) return recovered;

        // Re-evaluate after a recovery may have changed the surface.
        const after = await deps.adapter.observe();
        state.snapshot = after;
        const post = await checkOutcomes(outcomesFor(step.id), after);
        if (post) return post;
        check = await evaluate(step.checkpoint, deps.adapter, baseCtx(after));
      }

      if (!check.ok) {
        // STUCK, and a human might be able to fix it. Escalation is tried
        // before failure so the session is preserved rather than torn down —
        // and only when the caller asked for it.
        if (deps.escalateOnStuck === true) {
          const esc = await escalate(step, `checkpoint failed: ${check.detail}`);
          if (esc !== null) return esc;
          return null; // operator resolved it and the checkpoint revalidated
        }
        await capture(`checkpoint-${step.id}`);
        return fail('checkpoint-failed', describeCondition(step.checkpoint), check.detail, {
          stepId: step.id,
          // We acted. For anything past `safe`, the caller must not assume the
          // action did not land.
          retrySafe: step.reversibility === 'safe',
        });
      }
    }

    return null;
  }

  async function performAction(step: Step): Promise<ReplayResult | null> {
    let action: ResolvedAction;

    if (step.action !== 'navigate' && step.action !== 'press' && step.action !== 'wait') {
      /* targeted actions are recorded after resolution, below */
    } else {
      state.stepLog.push({
        id: step.id,
        action: step.action,
        status: 'ok',
        ...(step.url === undefined ? {} : { detail: step.url }),
        ...(step.key === undefined ? {} : { detail: `key ${step.key}` }),
      });
    }

    if (step.action === 'navigate') {
      // Templates resolve in `url` for the same reason they resolve in `value`:
      // the entry point of a web capability is per-environment configuration,
      // and a hostname baked into an artifact is precisely the thing that makes
      // one tenant's recording useless to the next. `{{env.WEB_APP_URL}}/#/login`
      // keeps the flow in the artifact and the address in the environment.
      action = { kind: 'navigate', url: substituteUrl(substitute(step.url as string, step)) };
    } else if (step.action === 'press') {
      action = { kind: 'press', key: step.key as string };
    } else if (step.action === 'wait') {
      action = { kind: 'wait', ms: step.timeoutMs ?? 500 };
    } else {
      const snap = state.snapshot ?? (await deps.adapter.observe());
      state.snapshot = snap;

      const target = step.target;
      if (!target) return fail('artifact-invalid', 'a target', `step '${step.id}' has none`, { stepId: step.id });

      if (target.adapterHints !== undefined) {
        // Never silent: a per-surface escape hatch is a portability cost, and the
        // warning count is how a reviewer finds out it is being paid.
        warn('adapter-hint-used', `step '${step.id}' resolved with a surface-specific hint`, step.id);
      }

      const res = await deps.adapter.resolve(target, baseCtx(snap));
      if (!res.ok) {
        // GIVE DECLARED OUTCOMES THE LAST WORD BEFORE CALLING THIS A FAILURE.
        //
        // A target that will not resolve is often the evidence that a declared
        // business outcome happened, not evidence that the automation broke.
        // Looking up a member who does not exist leaves no row to click: the
        // anchor is genuinely unresolvable, and "no such member" is the correct,
        // useful answer for the caller — not `anchor-unresolved`.
        //
        // Conflating those two is the single most common design error in this
        // problem, and the giveaway is the exit code: a caller that has to
        // distinguish "this member has no account" from "your automation is
        // broken" cannot do it from a failure reason. Ambiguity is deliberately
        // excluded — if an anchor matched several elements, something IS there
        // and the run must halt rather than report a tidy business outcome.
        if (res.reason !== 'anchor-ambiguous') {
          const oc = await checkOutcomes(outcomesFor(step.id), snap);
          if (oc) return oc;
        }
        if (deps.escalateOnStuck === true) {
          const esc = await escalate(step, `${res.reason}: ${res.detail}`);
          if (esc !== null) return esc;
          return null;
        }
        await capture(`unresolved-${step.id}`);
        return fail(res.reason, `resolve ${describeCondition({ type: 'present', target })}`, res.detail, {
          stepId: step.id,
          retrySafe: true,
        });
      }

      const el = res.resolution.element;
      state.stepLog.push({
        id: step.id,
        action: step.action,
        status: 'ok',
        screenId: snap.screenId,
        strategy: res.resolution.strategy,
        confidence: res.resolution.confidence,
        resolved: target.description,
        ...(step.bindTo === undefined ? {} : { bindTo: step.bindTo }),
      });
      if (res.resolution.confidence < 1) {
        warn('ladder-fallback', `step '${step.id}' resolved at confidence ${res.resolution.confidence}`, step.id);
      }

      if (step.action === 'read') {
        const value = el.value ?? el.text ?? '';
        state.bindings.set(step.bindTo as string, value);
        return null; // reading changes nothing on the surface
      }

      const value = substitute(step.value ?? '', step);
      action =
        step.action === 'fill'
          ? { kind: 'fill', element: el, value, ...(step.redact === true ? { redact: true } : {}) }
          : step.action === 'select'
            ? { kind: 'select', element: el, value }
            : { kind: 'click', element: el };
    }

    try {
      await deps.adapter.act(action);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        await capture(`policy-blocked-${step.id}`);
        return fail('policy-blocked', 'an allowed action', err.message, {
          stepId: step.id,
          retrySafe: true,
        });
      }
      await capture(`adapter-error-${step.id}`);
      return fail('adapter-error', 'the surface to accept the action', String(err), {
        stepId: step.id,
        retrySafe: step.reversibility === 'safe',
      });
    }
    return null;
  }

  function outcomesFor(stepId: string): OutcomeDetector[] {
    const extra = deps.override?.additionalOutcomes ?? [];
    return [...cap.outcomes, ...extra].filter((o) => o.afterStep === undefined || o.afterStep === stepId);
  }

  async function checkOutcomes(
    detectors: OutcomeDetector[],
    snap: SurfaceSnapshot,
  ): Promise<ReplayResult | null> {
    for (const d of detectors) {
      const r = await evaluate(d.when, deps.adapter, baseCtx(snap));
      if (!r.ok) continue;
      if (!d.terminal) {
        warn('recovery-fired', `non-terminal outcome '${d.code}' observed: ${d.description}`);
        continue;
      }
      await capture(`outcome-${d.code}`);
      // A declared business answer. NOT a failure.
      const partialOutputs: Record<string, string | number | boolean | null> = {};
      for (const f of cap.outputs) {
        const raw = state.bindings.get(f.from);
        if (raw !== undefined) partialOutputs[f.name] = coerce(raw, f.type, deps.override);
      }
      return finish({
        kind: 'outcome',
        code: d.code,
        description: d.description,
        partialOutputs,
        recoveries: state.recoveries,
        interventions: state.interventions,
      } as never);
    }
    return null;
  }

  /**
   * Bounded recovery. Returns null when recovery succeeded (or none applied) so
   * the caller re-checks, or a terminal result when the cap is exhausted.
   */
  async function tryRecover(step: Step): Promise<ReplayResult | null> {
    const policies = [...cap.recoveries, ...(deps.override?.additionalRecoveries ?? [])];

    for (const policy of policies) {
      const snap = state.snapshot ?? (await deps.adapter.observe());
      const hit = await evaluate(policy.when, deps.adapter, baseCtx(snap));
      if (!hit.ok) continue;

      const used = state.recoveryAttempts.get(policy.id) ?? 0;
      if (used >= policy.maxAttempts) {
        await capture(`recovery-exhausted-${policy.id}`);
        return fail(
          'recovery-exhausted',
          `recovery '${policy.id}' to resolve ${describeCondition(policy.when)} within ${policy.maxAttempts} attempts`,
          `condition still present after ${used} attempts`,
          { stepId: step.id, retrySafe: false },
        );
      }
      state.recoveryAttempts.set(policy.id, used + 1);

      let ok = true;
      for (const rs of policy.then) {
        const r = await performAction(rs);
        if (r !== null) {
          ok = false;
          break;
        }
        await deps.adapter.settle(rs.timeoutMs ?? 5_000);
      }

      state.recoveries.push({
        policyId: policy.id,
        triggeredAtStep: step.id,
        attempt: used + 1,
        maxAttempts: policy.maxAttempts,
        succeeded: ok,
      });
      warn('recovery-fired', `'${policy.id}' fired at step '${step.id}' (attempt ${used + 1})`, step.id);
      return null;
    }
    return null;
  }

  /**
   * Ask a human. With no operator channel wired, PARK and return a resumable
   * non-terminal result rather than fabricating a failure.
   */
  async function escalate(step: Step, reason: string): Promise<ReplayResult | null> {
    const handle = await deps.adapter.pause();
    const ev = await deps.adapter.evidence(`intervention-${step.id}`);
    state.evidence.push(ev.primaryPath);

    const req: InterventionRequest = {
      interventionId: `int-${randomUUID().slice(0, 8)}`,
      capabilityId: cap.id,
      capabilityVersion: cap.version,
      goal: cap.metadata.goalPrompt ?? cap.description,
      stepId: step.id,
      reason,
      snapshotPath: ev.primaryPath,
      sessionId: handle.sessionId,
      requestedAt: now().toISOString(),
    };
    await writeJson(join(evidenceDir, `intervention-${step.id}.json`), req);

    if (!deps.escalate) {
      return finish({
        kind: 'intervention',
        interventionId: req.interventionId,
        reason,
        atStep: step.id,
        snapshotPath: ev.primaryPath,
        sessionId: handle.sessionId,
        requestedAt: req.requestedAt,
        expiresAt: new Date(Date.parse(req.requestedAt) + 15 * 60_000).toISOString(),
      } as never);
    }

    const res = await deps.escalate(req);
    await deps.adapter.resume(handle);

    // RESYNC: never resume blind. Re-observe and revalidate this step's
    // checkpoint before letting automation continue.
    const after = await deps.adapter.observe();
    state.snapshot = after;
    const resync = step.checkpoint
      ? await evaluate(step.checkpoint, deps.adapter, baseCtx(after))
      : { ok: true, detail: 'no checkpoint to revalidate' };

    state.interventions.push({
      interventionId: req.interventionId,
      reason,
      atStep: step.id,
      ...(res.operatorId === undefined ? {} : { operatorId: res.operatorId }),
      heldMs: res.heldMs,
      // The channel usually cannot supply an after-state: the adapter refuses
      // to observe while the operator holds the lease. So the delta is computed
      // from what the run ACTUALLY SAW on resuming, which is the stronger
      // source anyway — a record of what changed, not a report of what the
      // human said they changed.
      stateDelta: diffLines(handle.snapshotText, res.snapshotTextAfter || after.text),
      resyncPassed: resync.ok,
    });

    if (!resync.ok) {
      return fail(
        'escalation-unanswered',
        `checkpoint to hold after operator handoff: ${describeCondition(step.checkpoint!)}`,
        `after resume: ${resync.detail}`,
        { stepId: step.id, retrySafe: false },
      );
    }
    return null;
  }

  async function capture(label: string): Promise<void> {
    try {
      const ev = await deps.adapter.evidence(label);
      state.evidence.push(ev.primaryPath, ...ev.extraPaths);
    } catch {
      // Evidence capture must never mask the failure it is documenting.
    }
  }

  function substitute(raw: string, step: Step): string {
    let out = raw;
    for (const ref of templateRefs(raw)) {
      let value: string | undefined;
      if (ref.scope === 'inputs') value = deps.inputs[ref.name];
      else if (ref.scope === 'bindings') value = state.bindings.get(ref.name);
      else value = (deps.env ?? process.env)[ref.name];

      if (value === undefined) {
        throw new Error(
          `step '${step.id}' references ${ref.scope}.${ref.name}, which has no value at replay time`,
        );
      }
      out = out.replace(new RegExp(`\\{\\{\\s*${ref.scope}\\.${ref.name}\\s*\\}\\}`, 'g'), value);
    }
    return out;
  }

  function substituteUrl(raw: string): string {
    const base = deps.override?.baseUrl;
    if (base && raw.startsWith('/')) return base.replace(/\/$/, '') + raw;
    return raw;
  }

  async function writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
    state.evidence.push(path);
  }
}

/** Shape of the fields `finish` always supplies, for the local cast. */
interface RunBaseShape {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  tenant: string;
  surface: Capability['surface'];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  modelCalls: number;
  warnings: RunWarning[];
  evidence: string[];
}

/** Apply a tenant's sparse step patch, recording that it happened. */
function applyStepOverride(
  step: Step,
  override: TenantOverride | undefined,
  warn: (kind: RunWarning['kind'], detail: string, stepId?: string) => void,
): Step {
  if (!override) return step;
  const patch = override.targets?.[step.id];
  const valuePatch = override.stepValues?.[step.id];
  if (!patch && valuePatch === undefined) return step;

  warn('override-applied', `tenant '${override.tenant}' patched step '${step.id}'`, step.id);
  return {
    ...step,
    ...(valuePatch === undefined ? {} : { value: valuePatch }),
    ...(patch && step.target ? { target: { ...step.target, ...patch } } : {}),
  };
}

/**
 * Coerce an extracted string to its declared type, respecting per-tenant locale.
 *
 * This is not pedantry: a balance rendered "1.234,56" under a European locale
 * parses to 1.234 under naive rules, and silently returning a number that is a
 * thousand times too small is far worse than failing. `money` is kept as a
 * normalised STRING rather than a float, because binary floating point is the
 * wrong representation for currency and an artifact should not quietly choose it.
 */
function coerce(
  raw: string,
  type: 'string' | 'number' | 'money' | 'date' | 'boolean',
  override: TenantOverride | undefined,
): string | number | boolean | null {
  const decimal = override?.locale?.decimalSeparator ?? '.';
  const thousands = override?.locale?.thousandsSeparator ?? ',';
  const trimmed = raw.trim();

  switch (type) {
    case 'string':
    case 'date':
      return trimmed;
    case 'boolean':
      return /^(true|yes|y|active|1)$/i.test(trimmed);
    case 'money': {
      const cleaned = trimmed
        .replace(/[^\d.,\-]/g, '')
        .split(thousands)
        .join('')
        .replace(decimal, '.');
      return cleaned === '' ? null : cleaned;
    }
    case 'number': {
      const cleaned = trimmed
        .replace(/[^\d.,\-]/g, '')
        .split(thousands)
        .join('')
        .replace(decimal, '.');
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
  }
}

/** Line-level diff, for recording what a human changed as a state delta. */
function diffLines(before: string, after: string): string[] {
  const b = before.split('\n');
  const a = after.split('\n');
  const out: string[] = [];
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i++) {
    const x = b[i] ?? '';
    const y = a[i] ?? '';
    if (x.trimEnd() !== y.trimEnd()) out.push(`line ${i}: "${x.trim()}" -> "${y.trim()}"`);
  }
  return out;
}
