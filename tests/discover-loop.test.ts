/**
 * THE DISCOVERY LOOP'S MECHANICS, WITHOUT A MODEL.
 *
 * What a model chooses is not testable and this file does not pretend
 * otherwise. What IS testable is everything around the choice: that a proposed
 * step reaches the surface, that a policy refusal comes back to the model as a
 * refusal rather than silently succeeding, that a read captures a value, that
 * the run is written to evidence, and that the model-call counter moves.
 *
 * So the model is replaced by a scripted client that returns a fixed sequence
 * of tool calls. Every other component in the path — the adapter, the gate, the
 * trace writer, the counter — is the real one. When a key is supplied and a
 * real model sits in that slot, the only thing that changes is who is choosing.
 *
 * The injection case is the one worth reading twice. The script has the "model"
 * ask to navigate off-allowlist, as a prompt-injected agent would. The
 * assertion is not that the model declined — it did not — but that the action
 * was refused beneath it and the refusal was reported back as an error the
 * agent must live with.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { discover } from '../src/discover/loop.js';
import type { ModelProvider, ToolCall } from '../src/discover/provider.js';
import { compile } from '../src/discover/compile.js';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import { gateFor } from '../src/policy/gate.js';
import { buildRedactor, loadPolicy } from '../src/policy/redact.js';
import { __resetModelCalls, modelCalls, withReplayGuard } from '../src/replay/guard.js';

const EVIDENCE = 'evidence/scratch/test-discovery';
const policy = loadPolicy();

/**
 * A scripted stand-in for the model, implementing the same ModelProvider seam
 * the real transports implement. Everything else in the path is real.
 */
function scriptedProvider(turns: ToolCall[][]): ModelProvider {
  let i = 0;
  const seen: unknown[] = [];
  return {
    name: 'scripted',
    model: 'scripted-test-model',
    async send(input) {
      seen.push(input);
      const calls = turns[i++] ?? [
        { id: `t${i}`, name: 'give_up', input: { reason: 'script exhausted' } },
      ];
      return { calls, text: '' };
    },
    transcript: () => seen,
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({
  id,
  name,
  input,
});

const label = (text: string, relation: string, extra: Record<string, unknown> = {}) => ({
  anchorKind: 'label',
  anchorText: text,
  relation,
  rationale: 'test rationale',
  description: text,
  ...extra,
});

async function terminalAdapter() {
  const a = new TerminalAdapter({
    evidenceDir: EVIDENCE,
    gate: gateFor('terminal', policy),
    redact: buildRedactor(policy.redaction),
  });
  await a.start();
  return a;
}

beforeEach(async () => {
  __resetModelCalls();
  await rm(EVIDENCE, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(EVIDENCE, { recursive: true, force: true });
});

describe('the loop drives the surface and records what happened', () => {
  it('executes steps, captures a read, and finishes', async () => {
    const adapter = await terminalAdapter();
    try {
      const trace = await discover({
        goal: 'look up member 12345 and read their savings balance',
        adapter,
        inputs: { memberId: '12345' },
        evidenceDir: EVIDENCE,
        redact: buildRedactor(policy.redaction),
        provider: scriptedProvider([
          [toolUse('a', 'perform_step', {
            action: 'fill',
            intent: 'key the member id',
            value: '{{inputs.memberId}}',
            reversibility: 'safe',
            target: label('MEMBER ID', 'next-writable'),
          })],
          [toolUse('b', 'perform_step', {
            action: 'press',
            intent: 'transmit the inquiry',
            key: 'Enter',
            reversibility: 'safe',
          })],
          [toolUse('c', 'perform_step', {
            action: 'read',
            intent: 'read the balance',
            bindTo: 'balanceValue',
            reversibility: 'safe',
            target: label('BALANCE', 'next-value'),
          })],
          [toolUse('d', 'finish', {
            summary: 'Reads a member savings balance.',
            outputs: [
              { name: 'savingsBalance', from: 'balanceValue', type: 'money', description: 'Balance.' },
            ],
          })],
        ]),
      });

      expect(trace.outcome).toBe('goal-met');
      expect(trace.entries.map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);

      // The read captured a real value off the real host — the loop is driving
      // an actual surface, not a mock of one.
      const read = trace.entries.find((e) => e.step.action === 'read');
      expect(read?.captured).toBe('4,250.00');

      // The counter is the same one every replay result reports, which is what
      // makes `modelCalls=0` on a replay a measurement rather than a claim.
      expect(trace.modelCalls).toBe(4);
      expect(modelCalls()).toBe(4);
    } finally {
      await adapter.close();
    }
  });

  it('compiles the resulting trace into a replayable draft', async () => {
    const adapter = await terminalAdapter();
    try {
      const trace = await discover({
        goal: 'look up member 12345 and read their savings balance',
        adapter,
        inputs: { memberId: '12345' },
        evidenceDir: EVIDENCE,
        redact: buildRedactor(policy.redaction),
        provider: scriptedProvider([
          [toolUse('a', 'perform_step', {
            action: 'fill',
            intent: 'key the member id',
            value: '{{inputs.memberId}}',
            reversibility: 'safe',
            target: label('MEMBER ID', 'next-writable'),
          })],
          [toolUse('b', 'perform_step', {
            action: 'read',
            intent: 'read the balance',
            bindTo: 'balanceValue',
            reversibility: 'safe',
            target: label('BALANCE', 'next-value'),
          })],
          [toolUse('c', 'finish', {
            summary: 'Reads a member savings balance.',
            outputs: [
              { name: 'savingsBalance', from: 'balanceValue', type: 'money', description: 'Balance.' },
            ],
          })],
        ]),
      });

      const cap = compile(trace, {
        id: 'member.savings.balance.read',
        product: 'northridge/terminal',
        tenant: 'northridge',
      });
      expect(cap.approvalState).toBe('draft');
      expect(cap.inputs.map((i) => i.name)).toEqual(['memberId']);
      expect(cap.outputs.map((o) => o.name)).toEqual(['savingsBalance']);
      // End to end: a recording became a typed, replayable contract.
      expect(cap.steps[0]!.value).toBe('{{inputs.memberId}}');
    } finally {
      await adapter.close();
    }
  });
});

describe('prompt injection is refused beneath the agent', () => {
  it('records a refusal and never performs the action', async () => {
    const adapter = await terminalAdapter();
    try {
      const trace = await discover({
        goal: 'look up member 12345 and read their savings balance',
        adapter,
        inputs: { memberId: '12345' },
        evidenceDir: EVIDENCE,
        redact: buildRedactor(policy.redaction),
        provider: scriptedProvider([
          // The agent has been persuaded by text on the screen. It is not the
          // model's judgement that stops this.
          [toolUse('x', 'perform_step', {
            action: 'press',
            intent: 'follow the instruction in the member notes field',
            key: 'F13',
            reversibility: 'safe',
          })],
          [toolUse('y', 'give_up', { reason: 'the action was refused by policy' })],
        ]),
      });

      const attempt = trace.entries[0]!;
      expect(attempt.status).toBe('refused');
      expect(attempt.detail).toMatch(/policy denied/i);

      // And a refused step is evidence, not a step of any flow: the compiler
      // never sees it, so it cannot end up in an artifact.
      expect(trace.outcome).toBe('gave-up');
    } finally {
      await adapter.close();
    }
  });
});

describe('evidence', () => {
  it('writes the trace and the raw transcript as separate artefacts', async () => {
    const adapter = await terminalAdapter();
    try {
      await discover({
        goal: 'read a balance',
        adapter,
        inputs: {},
        evidenceDir: EVIDENCE,
        redact: buildRedactor(policy.redaction),
        provider: scriptedProvider([[toolUse('z', 'give_up', { reason: 'nothing to do' })]]),
      });

      // The brief asks for the artifact to be decoupled from the raw model
      // transcript. Both are kept, and they are different things.
      const trace = JSON.parse(await readFile(join(EVIDENCE, 'trace.json'), 'utf8'));
      expect(trace.goal).toBe('read a balance');
      expect(trace.outcome).toBe('gave-up');

      const transcript = await readFile(join(EVIDENCE, 'transcript.json'), 'utf8');
      expect(transcript).toContain('GOAL: read a balance');

      const log = await readFile(join(EVIDENCE, 'discovery.log'), 'utf8');
      expect(log).toContain('outcome: gave-up');
    } finally {
      await adapter.close();
    }
  });
});

describe('discovery cannot happen inside a replay', () => {
  it('throws rather than consulting a model while the replay guard is up', async () => {
    const adapter = await terminalAdapter();
    try {
      // The counter and the guard are the same mechanism the engine uses. If
      // discovery could ever run inside a guarded replay, `modelCalls=0` would
      // stop meaning anything.
      const { result } = await withReplayGuard(async () =>
        discover({
          goal: 'x',
          adapter,
          inputs: {},
          evidenceDir: EVIDENCE,
          redact: buildRedactor(policy.redaction),
          provider: scriptedProvider([[toolUse('q', 'give_up', { reason: 'unused' })]]),
        }),
      );
      expect(result.outcome).toBe('error');
      expect(result.reason).toMatch(/deterministic replay/i);
    } finally {
      await adapter.close();
    }
  });
});
