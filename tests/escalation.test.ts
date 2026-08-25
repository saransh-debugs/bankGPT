/**
 * ESCALATION AND HANDOFF, END TO END.
 *
 * `tests/lease.test.ts` proves the adapter-level invariants — zero actions while
 * held, same session, resync on resume. This file proves the thing those
 * invariants exist for: a run that cannot safely proceed stops, a human works in
 * the same live session, and the run continues only after re-checking where it
 * is.
 *
 * The capability under test is deliberately made to get stuck: it looks up a
 * member id the host does not have, so its checkpoint fails. What the operator
 * "does" is key a valid member id into the SAME host process the run is holding
 * — which is only possible because `pause()` keeps the session alive. A channel
 * that had torn the session down and reopened it would fail these tests.
 *
 * The case worth reading twice is the last one: an operator who releases WITHOUT
 * fixing anything must not be able to wave a run through. The engine revalidates
 * the checkpoint after resume and fails with `escalation-unanswered`, which is
 * the difference between a handoff and a rubber stamp.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import { replay } from '../src/replay/engine.js';
import { Capability } from '../src/schema/capability.js';
import type { InterventionRequest } from '../src/replay/engine.js';
import {
  fileOperatorChannel,
  listPending,
  release,
  requestPath,
} from '../src/operator/channel.js';
import { readFileSync } from 'node:fs';

const DIR = 'evidence/scratch/test-interventions';
const EVIDENCE = 'evidence/scratch/test-escalation';

const base = Capability.parse(
  JSON.parse(readFileSync('capabilities/member.savings.balance.read.terminal.json', 'utf8')),
);

/**
 * The capability under test has NO declared outcome detectors, and that is the
 * realistic case rather than a contrivance: it is exactly what the compiler
 * emits from a single discovery run, and exactly what `lintCapability` warns
 * about — "no outcome detectors declared: every non-success becomes a failure".
 *
 * With detectors, looking up a missing member is a business outcome and the
 * engine answers it (the last case in this file asserts that). Without them,
 * the same lookup is a run that is simply STUCK on an unexpected screen — which
 * is precisely the situation a human should be brought into.
 */
const capability = { ...base, outcomes: [] };

/** A member id the host does not know, so the inquiry checkpoint fails. */
const MISSING = '99999';
const REAL = '12345';

beforeEach(async () => {
  await rm(DIR, { recursive: true, force: true });
  await rm(EVIDENCE, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
  await rm(EVIDENCE, { recursive: true, force: true });
});

async function adapter(): Promise<TerminalAdapter> {
  const a = new TerminalAdapter({ evidenceDir: EVIDENCE });
  await a.start();
  return a;
}

describe('a run with no operator channel PARKS rather than inventing an error', () => {
  it('returns a resumable intervention carrying enough context to act on', async () => {
    const a = await adapter();
    try {
      const r = await replay({
        capability,
        inputs: { memberId: MISSING },
        adapter: a,
        tenant: 'northridge',
        evidenceDir: EVIDENCE,
        escalateOnStuck: true,
        // no `escalate` handler on purpose
      });

      expect(r.kind).toBe('intervention');
      if (r.kind !== 'intervention') return;

      // Everything a human needs to act, per the brief: which capability, which
      // step, why it stopped, the screen, and the session that is still open.
      expect(r.atStep.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.sessionId).toMatch(/^term-/);
      expect(r.snapshotPath).toContain(EVIDENCE);
      expect(r.interventionId).toMatch(/^int-/);

      // The captured screen is the state at the moment control was ceded — a
      // human is briefed with the surface, not a description of it.
      expect(await readFile(r.snapshotPath, 'utf8')).toContain('MEMBER SERVICES');
    } finally {
      await a.close();
    }
  });
});

describe('a human takes over the same live session and hands it back', () => {
  it('resumes and completes once the operator has fixed the state', async () => {
    const a = await adapter();
    let seen: InterventionRequest | undefined;

    // Stand-in for a person: waits for the request, then keys a valid member id
    // into the SAME host process the run is holding, using the operator's raw
    // channel rather than the automation's action path.
    const channel = fileOperatorChannel({
      dir: DIR,
      pollMs: 20,
      timeoutMs: 10_000,
      onWaiting: (req) => {
        seen = req;
        void (async () => {
          const op = a.operatorChannel();
          const field = a.currentFields().find((f) => !f.protected);
          op.write(`FILL ${field!.row} ${field!.col} ${REAL}`);
          op.write('AID Enter');
          await new Promise((r) => setTimeout(r, 150));
          await release(DIR, req.interventionId, 'test-operator', 'keyed a valid member id');
        })();
      },
    });

    try {
      const r = await replay({
        capability,
        inputs: { memberId: MISSING },
        adapter: a,
        tenant: 'northridge',
        evidenceDir: EVIDENCE,
        escalateOnStuck: true,
        escalate: channel,
      });

      expect(seen).toBeDefined();
      expect(r.kind).toBe('success');
      if (r.kind !== 'success') return;

      // The run continued to completion after the handoff, and read the value
      // the OPERATOR put on screen — not the one it was asked for.
      expect(r.outputs.savingsBalance).toBe('4250.00');

      const record = r.interventions[0]!;
      expect(record.operatorId).toBe('test-operator');
      expect(record.resyncPassed).toBe(true);
      expect(record.heldMs).toBeGreaterThanOrEqual(0);

      // What the human did is recorded as a STATE DELTA — a diff of the surface
      // before and after — rather than as a keylog or as their own account of it.
      expect(record.stateDelta.length).toBeGreaterThan(0);
      expect(record.stateDelta.join('\n')).toContain(REAL);
    } finally {
      await a.close();
    }
  });

  it('publishes the request as a file another process can see and answer', async () => {
    const a = await adapter();
    const channel = fileOperatorChannel({
      dir: DIR,
      pollMs: 20,
      timeoutMs: 6_000,
      onWaiting: (req) => {
        void (async () => {
          // Exercised through the same functions the `operator` CLI calls, so
          // the test covers the operator surface rather than a shortcut.
          const pending = await listPending(DIR);
          expect(pending.map((p) => p.interventionId)).toContain(req.interventionId);
          expect(await readFile(requestPath(DIR, req.interventionId), 'utf8')).toContain(req.stepId);

          const op = a.operatorChannel();
          const field = a.currentFields().find((f) => !f.protected);
          op.write(`FILL ${field!.row} ${field!.col} ${REAL}`);
          op.write('AID Enter');
          await new Promise((r) => setTimeout(r, 150));
          await release(DIR, req.interventionId, 'cli-operator');

          // Once released it is no longer pending.
          expect(await listPending(DIR)).toHaveLength(0);
        })();
      },
    });

    try {
      const r = await replay({
        capability,
        inputs: { memberId: MISSING },
        adapter: a,
        tenant: 'northridge',
        evidenceDir: EVIDENCE,
        escalateOnStuck: true,
        escalate: channel,
      });
      expect(r.kind).toBe('success');
    } finally {
      await a.close();
    }
  });
});

describe('a release is not a rubber stamp', () => {
  it('fails with escalation-unanswered if the operator changed nothing', async () => {
    const a = await adapter();

    // Releases immediately without touching the surface. The checkpoint that
    // parked the run is still false.
    const channel = fileOperatorChannel({
      dir: DIR,
      pollMs: 20,
      timeoutMs: 6_000,
      onWaiting: (req) => {
        void release(DIR, req.interventionId, 'lazy-operator');
      },
    });

    try {
      const r = await replay({
        capability,
        inputs: { memberId: MISSING },
        adapter: a,
        tenant: 'northridge',
        evidenceDir: EVIDENCE,
        escalateOnStuck: true,
        escalate: channel,
      });

      expect(r.kind).toBe('failure');
      if (r.kind !== 'failure') return;
      expect(r.reason).toBe('escalation-unanswered');
      // Not retry-safe: a human held this session and we cannot assume the
      // surface is where we left it.
      expect(r.retrySafe).toBe(false);
    } finally {
      await a.close();
    }
  });
});

describe('escalation is opt-in', () => {
  it('fails normally when the caller did not ask for a human', async () => {
    // Escalation pins a live session open waiting for a person. An unattended
    // batch run must not start doing that because a checkpoint went red.
    const a = await adapter();
    try {
      const r = await replay({
        capability: base, // the reviewed capability, WITH outcome detectors
        inputs: { memberId: MISSING },
        adapter: a,
        tenant: 'northridge',
        evidenceDir: EVIDENCE,
      });
      // A declared outcome is not a stuck run. This is the contrast that makes
      // escalation meaningful: a reviewed capability ANSWERS this id, and only
      // the un-reviewed draft needs a human.
      expect(r.kind).toBe('outcome');
      if (r.kind !== 'outcome') return;
      expect(r.code).toBe('MEMBER_NOT_FOUND');
    } finally {
      await a.close();
    }
  });
});
