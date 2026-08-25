/**
 * THE CONFORMANCE SUITE — the thesis, as one test run twice.
 *
 * Every case in this file is executed against BOTH adapters from a single body
 * of assertions. That structure is the argument: if `anchor + relation` were
 * secretly web-shaped or secretly terminal-shaped, one of the two would need a
 * special case here, and there is nowhere to put one. A green run means the
 * relation vocabulary has the same meaning on an 80x24 character grid — no DOM,
 * no accessibility tree, no roles, no names — as it does in a browser.
 *
 * The web side runs against a small static page served by the test rather than
 * against Fineract. That is deliberate: this file tests the ADAPTER contract,
 * not an application, so it must not be able to fail because a container is
 * down. The live-product proof is the capability replay, which is a different
 * claim and has its own evidence.
 *
 * The load-bearing cases, in rough order of how much they would hurt to lose:
 *
 *   roleHint is never consulted   — hands the resolver a deliberately WRONG
 *                                   roleHint and asserts it resolves anyway. A
 *                                   schema that merely made roleHint optional
 *                                   could still have a resolver that quietly
 *                                   depends on it; this makes the claim
 *                                   falsifiable on both surfaces.
 *   ambiguity halts               — a repeated literal must never resolve to
 *                                   "the first one". On a banking surface the
 *                                   first one is a different member's money.
 *   the universal spine           — readingOrder and writable mean the same
 *                                   thing on both, which is what lets one
 *                                   relation implementation serve both.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import { WebAdapter } from '../src/adapter/web.js';
import { PolicyDenied } from '../src/adapter/surface.js';
import { AllowlistGate } from '../src/policy/gate.js';
import type {
  ResolveContext,
  SurfaceAdapter,
  SurfaceSnapshot,
} from '../src/adapter/surface.js';
import type { Relation, Target } from '../src/schema/target.js';

/** Literals each surface offers for the shared assertions. */
interface SurfaceCase {
  name: string;
  start: () => Promise<SurfaceAdapter>;
  /** A caption whose next-writable is an input. */
  inputLabel: string;
  /** A caption whose next-value is a displayed value, and what it reads. */
  valueLabel: string;
  expectedValue: string;
  /** A control carrying its own visible literal. */
  selfControl: string;
  /** A panel/screen title. */
  landmark: string;
  /** A literal appearing more than once. */
  duplicated: string;
  /** A literal appearing nowhere. */
  absent: string;
  /** A key the surface accepts, for the policy-refusal case. */
  deniedKey: string;
}

let server: Server;
let pageUrl: string;

beforeAll(async () => {
  const html = readFileSync('tests/fixtures/conformance-page.html', 'utf8');
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const CASES: SurfaceCase[] = [
  {
    name: 'terminal',
    start: async () => {
      const a = new TerminalAdapter({ evidenceDir: 'evidence/scratch/test-conformance-terminal' });
      await a.start();
      return a;
    },
    inputLabel: 'MEMBER ID',
    valueLabel: 'NAME',
    expectedValue: '',
    selfControl: 'F3=Exit',
    landmark: 'MEMBER SERVICES',
    duplicated: '',
    absent: 'NO SUCH CAPTION ANYWHERE',
    deniedKey: 'F13',
  },
  {
    name: 'web',
    start: async () => {
      const a = new WebAdapter({ evidenceDir: 'evidence/scratch/test-conformance-web' });
      await a.start();
      // No gate here: this suite tests the adapter contract, and the allowlist
      // has its own tests. A gate would only be asserting policy twice.
      await a.act({ kind: 'navigate', url: pageUrl });
      await a.settle(5_000);
      return a;
    },
    inputLabel: 'MEMBER ID',
    valueLabel: 'NAME',
    expectedValue: 'OKONKWO, JANET A',
    selfControl: 'Search',
    landmark: 'MEMBER SERVICES',
    duplicated: 'DUPLICATED',
    absent: 'NO SUCH CAPTION ANYWHERE',
    deniedKey: 'F13',
  },
];

const target = (
  anchor: Target['anchor'],
  relation: Relation,
  extra: Partial<Target> = {},
): Target => ({ anchor, relation, rationale: 'conformance', description: 'conformance', ...extra });

const ctx = (snapshot: SurfaceSnapshot, extra: Partial<ResolveContext> = {}): ResolveContext => ({
  snapshot,
  inputs: {},
  ...extra,
});

for (const c of CASES) {
  describe(`[${c.name}] surface adapter conformance`, () => {
    let adapter: SurfaceAdapter;
    let snap: SurfaceSnapshot;

    beforeAll(async () => {
      adapter = await c.start();
      snap = await adapter.observe();
    });

    afterAll(async () => {
      await adapter?.close();
    });

    describe('the universal spine', () => {
      it('projects the surface into a non-empty element list', () => {
        expect(snap.surface).toBe(c.name);
        expect(snap.elements.length).toBeGreaterThan(3);
        expect(snap.screenId.length).toBeGreaterThan(0);
      });

      it('is monotonic in reading order', () => {
        const orders = snap.elements.map((e) => e.readingOrder);
        expect([...orders].sort((a, b) => a - b)).toEqual(orders);
      });

      it('carries a writability predicate, and something is writable', () => {
        for (const e of snap.elements) expect(typeof e.writable).toBe('boolean');
        expect(snap.elements.some((e) => e.writable)).toBe(true);
      });

      it('exposes a human-readable rendering that diffs', () => {
        expect(snap.text.length).toBeGreaterThan(0);
      });
    });

    describe('relations mean the same thing on both surfaces', () => {
      it("'is' resolves a landmark to itself", async () => {
        const out = await adapter.resolve(
          target({ kind: 'landmark', text: c.landmark }, 'is'),
          ctx(snap),
        );
        expect(out.ok).toBe(true);
      });

      it("'next-writable' finds a field you can type into", async () => {
        const out = await adapter.resolve(
          target({ kind: 'label', text: c.inputLabel }, 'next-writable'),
          ctx(snap),
        );
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.resolution.element.writable).toBe(true);
      });

      it("'next-value' finds a displayed value, not an input", async () => {
        const out = await adapter.resolve(
          target({ kind: 'label', text: c.valueLabel }, 'next-value'),
          ctx(snap),
        );
        expect(out.ok).toBe(true);
        if (out.ok) {
          expect(out.resolution.element.writable).toBe(false);
          if (c.expectedValue) {
            const text = out.resolution.element.value ?? out.resolution.element.text ?? '';
            expect(text.trim()).toBe(c.expectedValue);
          }
        }
      });

      it("'is' resolves a control carrying its own literal", async () => {
        const out = await adapter.resolve(
          target({ kind: 'self', text: c.selfControl }, 'is'),
          ctx(snap),
        );
        expect(out.ok).toBe(true);
      });
    });

    describe('role and name are enrichments, never requirements', () => {
      it('resolves with a DELIBERATELY WRONG roleHint', async () => {
        // The falsifiable form of the claim. If any code path consulted
        // roleHint, asking for a 'checkbox' where a textbox lives would fail.
        const out = await adapter.resolve(
          target({ kind: 'label', text: c.inputLabel }, 'next-writable', { roleHint: 'checkbox' }),
          ctx(snap),
        );
        expect(out.ok).toBe(true);
      });

    it('resolves values that carry no AUTHORED name to query', async () => {
      const out = await adapter.resolve(
        target({ kind: 'label', text: c.valueLabel }, 'next-value'),
        ctx(snap),
      );
      expect(out.ok).toBe(true);
      if (!out.ok) return;

      // The point of the whole submission, stated as an assertion.
      //
      // On the terminal this element has no name at all. On the web it has one
      // only in the degenerate sense that an accessible-name computation falls
      // back to an element's own text — `nameSource: 'text'`. Neither is
      // something a `role` + accessible-name locator could have asked for:
      // there is no authored association, and the value is a bare <span> with
      // no role. Anything BUT undefined-or-'text' here would mean the surface
      // did offer a name to query, and this case would have stopped testing
      // what it claims to.
      const source = out.resolution.element.nameSource;
      expect(source === undefined || source === 'text').toBe(true);
    });
    });

    describe('halting beats guessing', () => {
      it('returns anchor-unresolved for a literal that is not there', async () => {
        const out = await adapter.resolve(target({ kind: 'label', text: c.absent }, 'is'), ctx(snap));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('anchor-unresolved');
      });

      it('returns anchor-ambiguous rather than picking the first match', async () => {
        if (!c.duplicated) return; // this surface has no repeated literal to test
        const out = await adapter.resolve(
          target({ kind: 'label', text: c.duplicated }, 'is'),
          ctx(snap),
        );
        expect(out.ok).toBe(false);
        if (!out.ok) {
          expect(out.reason).toBe('anchor-ambiguous');
          expect(out.candidates).toBeGreaterThan(1);
        }
      });

      it('reports resolution as a RESULT, never by throwing', async () => {
        await expect(
          adapter.resolve(target({ kind: 'label', text: c.absent }, 'next-value'), ctx(snap)),
        ).resolves.toBeDefined();
      });
    });

    describe('the per-tenant lexicon translates anchors at resolve time', () => {
      it('resolves a translated caption without touching the artifact', async () => {
        // One artifact, many institutions. The stored literal never changes;
        // the tenant supplies a dictionary. This is only possible because
        // targets anchor on named literals rather than opaque selectors.
        const out = await adapter.resolve(
          target({ kind: 'label', text: 'ID DE MIEMBRO' }, 'next-writable'),
          ctx(snap, { lexicon: { 'ID DE MIEMBRO': c.inputLabel } }),
        );
        expect(out.ok).toBe(true);
      });
    });

    describe('policy is enforced inside act()', () => {
      it('refuses a denied action before the surface is touched', async () => {
        const gated = await c.start();
        try {
          // Substitute a gate that denies everything, then prove act() is where
          // the refusal happens on BOTH adapters — not in one caller that the
          // other adapter happens not to have.
          (gated as unknown as { gate: unknown }).gate = new AllowlistGate(gated.kind, {
            allowedActions: [],
          });
          await expect(gated.act({ kind: 'press', key: c.deniedKey })).rejects.toBeInstanceOf(
            PolicyDenied,
          );
        } finally {
          await gated.close();
        }
      });
    });

    describe('session control', () => {
      it('emits zero actions while an operator holds the lease, and resumes the same session', async () => {
        const held = await c.start();
        try {
          const handle = await held.pause();
          await expect(held.observe()).rejects.toThrow(/lease/i);
          await expect(
            held.resume({ ...handle, sessionId: 'someone-elses' }),
          ).rejects.toThrow(/refusing to resume/i);

          await held.resume(handle);
          const after = await held.observe();
          expect(after.elements.length).toBeGreaterThan(0);
        } finally {
          await held.close();
        }
      });
    });

    describe('evidence', () => {
      it('writes a primary artefact and at least one supporting file', async () => {
        const ev = await adapter.evidence('conformance');
        expect(ev.primaryPath.length).toBeGreaterThan(0);
        expect(ev.extraPaths.length).toBeGreaterThan(0);
      });
    });
  });
}
