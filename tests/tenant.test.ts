/**
 * ONE ARTIFACT, TWO INSTITUTIONS.
 *
 * The multi-tenant claim is that a capability recorded at one institution can
 * be specialised for another with a sparse patch instead of a re-record. This
 * file is that claim as an assertion: the SAME capability file, byte for byte,
 * replayed against a host branded for a different institution whose panel is in
 * a different language, producing the same typed outputs.
 *
 * The test is only meaningful because the second host genuinely differs. Summit
 * FCU's panel says "ID DE MIEMBRO" where Northridge's says "MEMBER ID" — so a
 * run that resolved anything at all had to go through the lexicon. The first
 * case below proves that directly: WITHOUT the override, the same replay fails
 * to find its anchors. That is the control that stops this file from passing
 * for the wrong reason.
 *
 * This is also the sharpest illustration of why the schema-level inversion
 * earns its cost. There is nothing in a CSS selector to translate, and no
 * accessible name to translate on a surface that exposes none. A visible
 * literal can be translated with a dictionary.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import { replay } from '../src/replay/engine.js';
import { Capability } from '../src/schema/capability.js';
import { TenantOverride } from '../src/schema/override.js';
import type { ReplayResult } from '../src/schema/result.js';

const CAP_PATH = 'capabilities/member.savings.balance.read.terminal.json';
const OVERRIDE_PATH = 'capabilities/overrides/summit.member.savings.balance.read.json';

const capability = Capability.parse(JSON.parse(readFileSync(CAP_PATH, 'utf8')));
const override = TenantOverride.parse(JSON.parse(readFileSync(OVERRIDE_PATH, 'utf8')));

async function runAs(
  tenant: string,
  opts: { withOverride: boolean },
): Promise<ReplayResult> {
  const adapter = new TerminalAdapter({
    evidenceDir: `evidence/scratch/test-tenant-${tenant}`,
    env: { TERM_TENANT: tenant },
  });
  await adapter.start();
  try {
    return await replay({
      capability,
      inputs: { memberId: '12345' },
      adapter,
      tenant,
      ...(opts.withOverride ? { override } : {}),
    });
  } finally {
    await adapter.close();
  }
}

describe('a tenant is a patch, not a re-recording', () => {
  it('replays as recorded against the institution it was recorded at', async () => {
    const r = await runAs('northridge', { withOverride: false });
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') return;
    // A `money` output is a NORMALISED STRING, not a float. Deliberate: a
    // balance parsed into a JS number is a rounding bug waiting to happen, and
    // the locale-aware cleanup has already stripped the thousands separator.
    expect(r.outputs.savingsBalance).toBe('4250.00');
  });

  it('replays the SAME artifact against a Spanish-language institution', async () => {
    const r = await runAs('summit', { withOverride: true });
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') return;

    // Same typed outputs, from a panel that shares not one caption with the
    // one this capability was recorded against.
    expect(r.outputs.savingsBalance).toBe('4250.00');
    expect(r.outputs.memberName).toBe('OKONKWO, JANET A');
    expect(r.tenant).toBe('summit');
  });

  it('CONTROL: without the override, the same replay cannot find its anchors', async () => {
    // Without this, the Spanish case above would pass just as happily if the
    // lexicon were never applied and the host had quietly stayed in English.
    const r = await runAs('summit', { withOverride: false });
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') return;

    // `precondition-failed`, not `anchor-unresolved`, and the distinction
    // matters: the first step asserts it is on the Member Services panel BEFORE
    // typing. On Summit's host that caption reads SERVICIOS AL MIEMBRO, so the
    // run refuses to act having touched nothing — rather than keying a member
    // id into whatever field happened to be first. Failing earlier and more
    // safely than the test originally assumed.
    expect(r.reason).toBe('precondition-failed');
    expect(r.retrySafe).toBe(true);
  });

  it('records that the lexicon fired, rather than translating silently', async () => {
    // A translation is a per-tenant deviation from the base artifact. It is
    // reported as a warning so a reviewer reading a run can see which literals
    // this institution needed patched, and how many.
    const r = await runAs('summit', { withOverride: true });
    const applied = r.warnings.filter((w) => w.kind === 'lexicon-applied');
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.some((w) => w.detail.includes('ID DE MIEMBRO'))).toBe(true);
  });
});

describe('an override is refused when it no longer matches its base', () => {
  it('rejects a patch reviewed against a different capability version', async () => {
    // A patch reviewed against 1.0.0 has no business applying to a capability
    // that has since moved. Silently applying it is how a tenant ends up running
    // a flow nobody approved.
    const adapter = new TerminalAdapter({
      evidenceDir: 'evidence/scratch/test-tenant-stale',
      env: { TERM_TENANT: 'summit' },
    });
    await adapter.start();
    try {
      const r = await replay({
        capability,
        inputs: { memberId: '12345' },
        adapter,
        tenant: 'summit',
        override: { ...override, baseVersion: '2.0.0' },
      });
      expect(r.kind).toBe('failure');
      if (r.kind !== 'failure') return;
      expect(r.reason).toBe('artifact-invalid');
      expect(r.observed).toMatch(/re-review/i);
    } finally {
      await adapter.close();
    }
  });
});
