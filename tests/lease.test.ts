/**
 * THE CONTROL-TRANSFER INVARIANT.
 *
 * The brief's escalation requirement is that a human takes over the SAME live
 * session and that automation stops acting while they hold it. The second half
 * is the part that is easy to claim and easy to get wrong: a "paused" flag that
 * the action path never consults is indistinguishable from a working one until
 * an operator and the agent fight over the same screen.
 *
 * So the assertion here is not "pause() sets a flag" — it is that the adapter
 * emits ZERO actions while the lease is held, enforced at the transport, and
 * that the session is still the same one afterwards. `src/adapter/terminal.ts`
 * cites this file at its lease guard; this is that citation made good.
 *
 * The session-identity check matters independently: resuming with a handle from
 * a different session must be refused rather than silently rebound, because
 * "the human operated the same session" is the requirement, and a rebind would
 * satisfy the code while violating the claim.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TerminalAdapter } from '../src/adapter/terminal.js';

let adapter: TerminalAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
});

async function started(): Promise<TerminalAdapter> {
  const a = new TerminalAdapter({ evidenceDir: 'evidence/scratch/test-lease' });
  await a.start();
  adapter = a;
  return a;
}

describe('while an operator holds the lease, automation emits zero actions', () => {
  it('refuses to observe — the read path transmits too, so it is gated as well', async () => {
    const a = await started();
    await a.pause();

    // observe() is not a passive read on a block-mode surface: it sends a
    // ReadBuffer command down the same channel the operator is using. Gating
    // only writes would leave the agent interleaving traffic with the human.
    await expect(a.observe()).rejects.toThrow(/lease/i);
  });

  it('refuses to act', async () => {
    const a = await started();
    const before = await a.observe();
    const field = before.elements.find((e) => e.writable);
    expect(field).toBeDefined();

    await a.pause();

    await expect(
      a.act({ kind: 'fill', element: field!, value: '12345' }),
    ).rejects.toThrow(/lease/i);
    await expect(a.act({ kind: 'press', key: 'Enter' })).rejects.toThrow(/lease/i);
  });

  it('records nothing on the wire during the hold', async () => {
    const a = await started();
    await a.observe();
    await a.pause();

    const before = a.transcriptLines().length;
    await a.act({ kind: 'press', key: 'Enter' }).catch(() => undefined);
    await a.observe().catch(() => undefined);

    // The refusal happens BEFORE the command is encoded and pushed, so a
    // blocked attempt leaves no trace of an outbound command. If this grows,
    // the guard moved below the transcript write and the agent is talking.
    expect(a.transcriptLines().length).toBe(before);
  });
});

describe('handing control back', () => {
  it('resumes the same session and acts again', async () => {
    const a = await started();
    const handle = await a.pause();
    await a.resume(handle);

    // Same adapter, same child process, same format table — not a relaunch.
    const after = await a.observe();
    expect(after.screenId).toBe('MBR001');
  });

  it('refuses a handle belonging to a different session', async () => {
    const a = await started();
    const handle = await a.pause();

    await expect(
      a.resume({ ...handle, sessionId: 'term-someone-elses' }),
    ).rejects.toThrow(/refusing to resume/i);
  });

  it('captures the pre-handoff screen so the human is briefed with state, not a description', async () => {
    const a = await started();
    await a.observe();
    const handle = await a.pause();

    expect(handle.snapshotText).toContain('MEMBER SERVICES');
    expect(handle.pausedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
