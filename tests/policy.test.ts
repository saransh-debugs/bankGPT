/**
 * POLICY IS ENFORCED BELOW THE MODEL.
 *
 * The claim under test is not "there is an allowlist" but "an agent cannot act
 * outside it, however it was persuaded". That is a claim about WHERE the check
 * runs, so these tests assert two separate things:
 *
 *   1. The gate's decisions are right — including the near-misses that make
 *      allowlists fail in practice.
 *   2. The refusal actually originates inside `SurfaceAdapter.act()`, before
 *      the surface is touched. A gate that returned the correct answer to a
 *      caller who then ignored it would pass (1) and protect nothing.
 *
 * The prompt-injection case is the reason the design is shaped this way. A
 * hostile string in a member's notes field is data the agent is asked to read,
 * and a model can be talked into acting on it. Here the model is not consulted:
 * `act()` refuses, and the transcript shows nothing was transmitted.
 */

import { describe, expect, it } from 'vitest';
import { AllowlistGate, gateFor } from '../src/policy/gate.js';
import { loadPolicy } from '../src/policy/redact.js';
import { PolicyDenied } from '../src/adapter/surface.js';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import type { ObservedElement } from '../src/adapter/surface.js';

const policy = loadPolicy();
const web = gateFor('web', policy);
const terminal = gateFor('terminal', policy);
const ctx = (surface: 'web' | 'terminal') => ({ surface, screenId: 'test' }) as const;

const el = (over: Partial<ObservedElement> = {}): ObservedElement => ({
  id: 'e1',
  writable: true,
  enabled: true,
  readingOrder: 0,
  position: {},
  ...over,
});

describe('origin allowlist', () => {
  it('permits the demo stack', () => {
    expect(web.check({ kind: 'navigate', url: 'http://localhost:4200/#/clients' }, ctx('web'))).toBeNull();
    expect(web.check({ kind: 'navigate', url: 'https://localhost:8443/fineract-provider' }, ctx('web'))).toBeNull();
  });

  it('refuses an off-allowlist origin', () => {
    const denial = web.check({ kind: 'navigate', url: 'https://evil.example/exfil' }, ctx('web'));
    expect(denial).toMatch(/not on the allowlist/i);
  });

  it('refuses PREFIX near-misses, because origins are compared structurally', () => {
    // Every one of these passes `startsWith('http://localhost:4200')`. That is
    // the classic allowlist bypass and the reason the gate parses the URL
    // rather than comparing strings.
    //
    // The userinfo form is the nastiest of them: it is a perfectly valid URL
    // whose origin is evil.example, and it reads as the allowed host to anyone
    // skimming. Structural comparison is what makes it a non-event.
    for (const url of [
      'http://localhost:4200@evil.example/exfil',
      'http://localhost:42000/exfil',
      'http://localhost:4200.evil.example/exfil',
    ]) {
      expect(web.check({ kind: 'navigate', url }, ctx('web')), url).not.toBeNull();
    }

    // Specifically: the userinfo URL is rejected on ORIGIN, not by failing to
    // parse — proving the structural check is doing the work here.
    expect(
      web.check({ kind: 'navigate', url: 'http://localhost:4200@evil.example/exfil' }, ctx('web')),
    ).toMatch(/not on the allowlist/i);
  });

  it('refuses a scheme with no origin', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<h1>x', 'file:///etc/passwd', 'not a url']) {
      expect(web.check({ kind: 'navigate', url }, ctx('web'))).not.toBeNull();
    }
  });

  it('refuses a different port on an allowed host', () => {
    expect(web.check({ kind: 'navigate', url: 'http://localhost:9999/' }, ctx('web'))).not.toBeNull();
  });
});

describe('action and key allowlists', () => {
  it('refuses navigation on a character grid, which has no origins', () => {
    expect(terminal.check({ kind: 'navigate', url: 'http://localhost:4200' }, ctx('terminal'))).not.toBeNull();
  });

  it('permits the AID keys the host actually defines', () => {
    for (const key of ['Enter', 'F3', 'F5', 'F12']) {
      expect(terminal.check({ kind: 'press', key }, ctx('terminal'))).toBeNull();
    }
  });

  it('refuses an AID key the policy does not list', () => {
    // On a block-mode host the AID key IS the action — it is what transmits —
    // so an unlisted one is refused rather than sent to see what happens.
    expect(terminal.check({ kind: 'press', key: 'F13' }, ctx('terminal'))).toMatch(/not permitted/i);
  });

  it('fails CLOSED for a surface the policy does not mention', () => {
    const unknown = gateFor('desktop', policy);
    expect(unknown.check({ kind: 'click', element: el() }, { surface: 'desktop', screenId: 't' })).not.toBeNull();
  });

  it('denies navigation when a surface declares no origins at all', () => {
    const bare = new AllowlistGate('web', { allowedActions: ['navigate'] });
    expect(bare.check({ kind: 'navigate', url: 'http://localhost:4200' }, ctx('web'))).toMatch(
      /no allowed origins/i,
    );
  });
});

describe('the refusal happens inside act(), not in a caller that could skip it', () => {
  it('throws PolicyDenied before anything reaches the surface', async () => {
    const adapter = new TerminalAdapter({
      evidenceDir: 'evidence/scratch/test-policy',
      gate: gateFor('terminal', policy),
    });
    await adapter.start();
    try {
      await adapter.observe();
      const before = adapter.transcriptLines().length;

      // Stand-in for a prompt-injected instruction: the agent has been told to
      // press a key the policy does not permit. Nothing consults a model here —
      // the adapter simply refuses.
      await expect(adapter.act({ kind: 'press', key: 'F13' })).rejects.toBeInstanceOf(PolicyDenied);

      // And the surface never saw it. If the gate ran AFTER the write, the
      // transcript would have grown and the host would already have the key.
      expect(adapter.transcriptLines().length).toBe(before);
    } finally {
      await adapter.close();
    }
  });

  it('an allowed action still goes through, so the gate is not simply refusing everything', async () => {
    const adapter = new TerminalAdapter({
      evidenceDir: 'evidence/scratch/test-policy',
      gate: gateFor('terminal', policy),
    });
    await adapter.start();
    try {
      const snap = await adapter.observe();
      const field = snap.elements.find((e) => e.writable);
      await expect(
        adapter.act({ kind: 'fill', element: field!, value: '12345' }),
      ).resolves.toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});
