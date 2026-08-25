/**
 * REDACTION, ASSERTED AGAINST THE FILESYSTEM.
 *
 * The interesting question is not "does the redactor function work" — that is
 * easy to test and easy to pass while still leaking. The question the brief
 * actually asks is whether a secret ends up persisted ANYWHERE, and the honest
 * way to answer it is to run something real, then read back every byte it
 * wrote and look.
 *
 * So these tests drive a live adapter with a sentinel credential, let it write
 * its evidence, then walk the whole evidence directory and assert the sentinel
 * does not appear in any file. A leak through a path nobody thought to unit
 * test — the protocol transcript, the character-plane dump, the handoff
 * snapshot an operator is shown — fails this test without anyone having had to
 * predict it.
 *
 * The sentinels are deliberately shaped like the real thing but are not real:
 * a value that only this test knows, so a hit is unambiguous.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import { buildRedactor, fingerprint, loadPolicy } from '../src/policy/redact.js';

const SENTINEL_PASSWORD = 'Zx9-Northridge-SENTINEL-Pw';
const SENTINEL_SSN = '123-45-6789';
const EVIDENCE_DIR = 'evidence/scratch/test-redaction';

/** Every file under a directory, recursively. Nothing is exempt from the sweep. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

beforeEach(async () => {
  await rm(EVIDENCE_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(EVIDENCE_DIR, { recursive: true, force: true });
});

describe('nothing a run writes contains the credential it ran with', () => {
  it('keeps a typed secret out of every file the adapter produces', async () => {
    // The redactor is built from the SAME policy the CLI uses, with the
    // sentinel injected as the environment value it would find in production.
    const policy = loadPolicy();
    const redact = buildRedactor(policy.redaction, { FINERACT_PASSWORD: SENTINEL_PASSWORD });

    const adapter = new TerminalAdapter({ evidenceDir: EVIDENCE_DIR, redact });
    await adapter.start();
    try {
      const snap = await adapter.observe();
      const field = snap.elements.find((e) => e.writable);
      expect(field).toBeDefined();

      // Type the credential into the surface. It now exists in the screen
      // buffer AND in the protocol transcript — two different persistence
      // paths, which is the point.
      await adapter.act({ kind: 'fill', element: field!, value: SENTINEL_PASSWORD, redact: true });
      await adapter.evidence('secret-typed');
    } finally {
      await adapter.close();
    }

    const files = await walk(EVIDENCE_DIR);
    expect(files.length).toBeGreaterThan(0); // a sweep over nothing proves nothing

    const offenders: string[] = [];
    for (const f of files) {
      if ((await readFile(f, 'utf8')).includes(SENTINEL_PASSWORD)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('POSITIVE CONTROL: the same sweep DOES find the secret when redaction is off', async () => {
    // Without this, the test above passes for the wrong reason — an evidence
    // writer that silently failed, or a sweep looking in the wrong directory,
    // would look identical to correct redaction.
    const adapter = new TerminalAdapter({ evidenceDir: EVIDENCE_DIR });
    await adapter.start();
    try {
      const snap = await adapter.observe();
      const field = snap.elements.find((e) => e.writable);
      await adapter.act({ kind: 'fill', element: field!, value: SENTINEL_PASSWORD, redact: true });
      await adapter.evidence('secret-typed');
    } finally {
      await adapter.close();
    }

    const files = await walk(EVIDENCE_DIR);
    const hits: string[] = [];
    for (const f of files) {
      if ((await readFile(f, 'utf8')).includes(SENTINEL_PASSWORD)) hits.push(f);
    }
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('pattern redaction covers data the run never held', () => {
  const redact = buildRedactor(loadPolicy().redaction, {});

  it('removes a US SSN rendered by the surface', () => {
    expect(redact(`MEMBER SSN ${SENTINEL_SSN} ON FILE`)).not.toContain(SENTINEL_SSN);
  });

  it('removes bearer tokens and JWTs from an error banner', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redact(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
  });

  it('leaves the working data a capability exists to return', () => {
    // Scope is a claim this system makes explicitly. A redactor that ate member
    // names would make every capability useless, so names and account numbers
    // are protected by the artifact contract instead — parameters are stored by
    // name, and recorded sample values as fingerprints.
    const out = redact('Client Name : Janet Okonkwo   Total Savings 4,250.00');
    expect(out).toContain('Janet Okonkwo');
    expect(out).toContain('4,250.00');
  });
});

describe('an empty or missing secret cannot shred the evidence', () => {
  it('ignores unset and trivially short values instead of matching everywhere', () => {
    // An unset variable reads as "" and an empty needle matches at every
    // position. A redactor that replaced the whole document would "pass" a
    // leak test while destroying the thing it was supposed to protect.
    const redact = buildRedactor(
      { secretEnvVars: ['MISSING', 'EMPTY', 'TINY'] },
      { EMPTY: '', TINY: 'ab' },
    );
    const text = 'Client Name : Janet Okonkwo';
    expect(redact(text)).toBe(text);
  });
});

describe('fingerprints stand in for recorded sample values', () => {
  it('is stable and does not contain the value', () => {
    const fp = fingerprint('000000001');
    expect(fp).toBe(fingerprint('000000001'));
    expect(fp).not.toContain('000000001');
    expect(fp.startsWith('sha256:')).toBe(true);
  });

  it('separates values that differ', () => {
    expect(fingerprint('000000001')).not.toBe(fingerprint('000000002'));
  });
});
