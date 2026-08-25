/**
 * THE COMPILER, TESTED AGAINST A FROZEN TRACE.
 *
 * Discovery has a nondeterministic half and a deterministic half, and this file
 * exists because of that split. The loop — a model driving a live UI — cannot
 * be meaningfully unit-tested; asserting on what a model chose would either be
 * vacuous or flaky. The compiler is a pure function of the trace the loop
 * emits, so it can be pinned exactly.
 *
 * That is why the trace is a committed fixture rather than something generated
 * here: it is the recorded output of a real run, and holding it still means the
 * graded half of discovery is repeatable without the unfakeable half being
 * faked.
 *
 * The fixture is built to contain the cases that actually matter:
 *   - a step anchored on the sample value, which MUST become a param anchor
 *   - a step carrying {{env.*}}, which MUST be marked redact
 *   - a refused step, which MUST NOT appear in the compiled flow
 *   - a declared output with no read step behind it, which MUST be dropped
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile, CompileError } from '../src/discover/compile.js';
import type { DiscoveryTrace } from '../src/discover/loop.js';
import { Capability, lintCapability } from '../src/schema/capability.js';
import { fingerprint } from '../src/policy/redact.js';

const TRACE: DiscoveryTrace = JSON.parse(
  readFileSync('tests/fixtures/trace-web-balance.json', 'utf8'),
) as DiscoveryTrace;

const OPTS = {
  id: 'member.savings.balance.read',
  product: 'openmf/web-app',
  tenant: 'default',
};

const compiled = () => compile(TRACE, OPTS);

describe('the compiled artifact is a valid capability', () => {
  it('passes the same schema that guards artifacts loaded from disk', () => {
    expect(Capability.safeParse(compiled()).success).toBe(true);
  });

  it('is a DRAFT, because a model wrote it and nobody has reviewed it', () => {
    expect(compiled().approvalState).toBe('draft');
  });

  it('records the model and goal it came from', () => {
    const cap = compiled();
    expect(cap.metadata.recordedBy).toBe('discovery');
    expect(cap.metadata.model).toBe('claude-opus-5');
    // Parameterised, not verbatim: the goal an operator typed named a specific
    // member, and the artifact must not carry it.
    expect(cap.metadata.goalPrompt).toBe(
      'look up member {{inputs.memberId}} and read their current savings balance',
    );
  });
});

describe('parameterisation — the run must not hard-code the record it saw', () => {
  it('rewrites an anchor that matched the sample value into a param anchor', () => {
    // THE case this whole mechanism exists for. The model anchored on the
    // literal "000000001" because that is what was on screen. Left alone, the
    // capability would only ever open that one member.
    const cap = compiled();
    const open = cap.steps.find((s) => s.id.includes('open-the-member'));
    expect(open).toBeDefined();
    expect(open!.target?.anchor).toEqual({ kind: 'param', name: 'memberId' });
  });

  it('leaves genuine captions alone', () => {
    const cap = compiled();
    const balance = cap.steps.find((s) => s.bindTo === 'balanceValue');
    expect(balance!.target?.anchor).toEqual({ kind: 'label', text: 'Total Savings' });
  });

  it('declares the parameter it now depends on', () => {
    const cap = compiled();
    expect(cap.inputs.map((i) => i.name)).toEqual(['memberId']);
    expect(cap.inputs[0]!.required).toBe(true);
  });

  it('stores a FINGERPRINT of the sample value, never the value', () => {
    // A capability is a reviewable document that gets copied between
    // environments. A real member id sitting inside it is regulated data at
    // rest, for the sole benefit of an example field.
    const cap = compiled();
    const serialised = JSON.stringify(cap);
    expect(serialised).not.toContain('000000001');
    expect(cap.inputs[0]!.example).toBe(fingerprint('000000001'));
  });
});

describe('secrets', () => {
  it('marks an env-sourced value redact so replay resolves it from the environment', () => {
    const cap = compiled();
    const pw = cap.steps.find((s) => s.value === '{{env.FINERACT_PASSWORD}}');
    expect(pw).toBeDefined();
    expect(pw!.redact).toBe(true);
  });

  it('REFUSES to compile a literal credential rather than warning about it', () => {
    // The artifact is the thing that gets committed, so this is a hard error.
    const leaked: DiscoveryTrace = {
      ...TRACE,
      entries: TRACE.entries.map((e, i) =>
        i === 1 ? { ...e, step: { ...e.step, value: 'hunter2-actual-password' } } : e,
      ),
    };
    expect(() => compile(leaked, { ...OPTS, secrets: ['hunter2-actual-password'] })).toThrow(
      CompileError,
    );
  });
});

describe('only what actually happened gets compiled', () => {
  it('drops the step the policy refused', () => {
    // A refused action is evidence of an attempted injection, not a step of the
    // flow. It stays in the trace as evidence and out of the artifact.
    const cap = compiled();
    expect(JSON.stringify(cap)).not.toContain('evil.example');
    expect(cap.steps.some((s) => s.action === 'navigate' && s.url?.includes('evil'))).toBe(false);
  });

  it('drops an output no read step ever captured', () => {
    const cap = compiled();
    expect(cap.outputs.map((o) => o.name).sort()).toEqual(['memberName', 'savingsBalance']);
  });

  it('keeps every successful step, in order', () => {
    const cap = compiled();
    expect(cap.steps.map((s) => s.action)).toEqual([
      'fill',
      'fill',
      'click',
      'navigate',
      'click',
      'read',
      'read',
    ]);
  });

  it('refuses to compile a run that did not reach its goal', () => {
    // A capability describes a flow that works. A run that gave up describes
    // one that did not, and compiling it would produce a confident artifact
    // for something nobody ever completed.
    for (const outcome of ['gave-up', 'max-steps', 'error'] as const) {
      expect(() => compile({ ...TRACE, outcome }, OPTS)).toThrow(CompileError);
    }
  });
});

describe('assertions are derived from evidence, not invented', () => {
  it('gives an acting step a checkpoint the recording actually witnessed', () => {
    const cap = compiled();
    const openMember = cap.steps.find((s) => s.id.includes('open-the-member'))!;
    expect(openMember.checkpoint).toBeDefined();
    expect(openMember.checkpoint!.type).toBe('present');
    // The justification says where it came from, so a reviewer can tell an
    // observed post-condition from a plausible-sounding guess.
    expect(JSON.stringify(openMember.checkpoint)).toContain('Observed during discovery');
  });

  it('leaves a step UNVERIFIED rather than borrowing an assertion across a navigate', () => {
    // The step after the sign-in click is a navigate, which produces a
    // different screen. Reaching past it for an assertion would claim the
    // recording witnessed something it did not. No checkpoint is the honest
    // answer, and the linter is what tells a reviewer to supply one.
    const cap = compiled();
    const submit = cap.steps.find((s) => s.id.includes('submit-the-sign-in'))!;
    expect(submit.checkpoint).toBeUndefined();
    expect(lintCapability(cap).some((l) => l.message.includes(submit.id))).toBe(true);
  });

  it('never leaks the sample value through a checkpoint', () => {
    // Checkpoints are derived from the NEXT step's target. Built from the raw
    // trace they would carry the un-parameterised anchor and reintroduce the
    // recorded member id after the step itself had been correctly rewritten.
    const cap = compiled();
    const beforeMember = cap.steps.find((s) => s.id.includes('open-the-client-list'))!;
    expect(JSON.stringify(beforeMember.checkpoint)).not.toContain('000000001');
    expect(JSON.stringify(beforeMember.checkpoint)).toContain('"param"');
  });

  it('does not fabricate outcome detectors from a single happy path', () => {
    // One successful run is no evidence about what a not-found screen looks
    // like. A guessed detector is worse than none: it gives a caller a
    // confident wrong answer.
    const cap = compiled();
    expect(cap.outcomes).toEqual([]);
    expect(cap.recoveries).toEqual([]);
  });

  it('defines success as the final read still resolving', () => {
    const cap = compiled();
    expect(cap.successCondition.type).toBe('present');
    expect(JSON.stringify(cap.successCondition)).toContain('Total Savings');
  });

  it('reports maxReversibility from the steps, not from a guess', () => {
    expect(compiled().maxReversibility).toBe('safe');

    const risky: DiscoveryTrace = {
      ...TRACE,
      entries: TRACE.entries.map((e, i) =>
        i === 3 ? { ...e, step: { ...e.step, reversibility: 'irreversible' as const } } : e,
      ),
    };
    expect(compile(risky, OPTS).maxReversibility).toBe('irreversible');
  });
});
