/**
 * THE THESIS TEST.
 *
 * These cases are the argument of the whole submission reduced to assertions.
 * If they pass, then anchor + relation identifies controls on a surface with no
 * DOM, no accessibility tree, no roles and no names — and therefore `role` +
 * accessible name is an enrichment, not an identity.
 *
 * The load-bearing case is `roleHint is never consulted`: it hands the resolver a
 * DELIBERATELY WRONG roleHint and asserts resolution succeeds anyway. A schema
 * that merely made roleHint optional could still have a resolver that quietly
 * depends on it; this makes the claim falsifiable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import type { ResolveContext, SurfaceSnapshot } from '../src/adapter/surface.js';
import type { Target } from '../src/schema/target.js';
import { normaliseLiteral } from '../surfaces/terminal/protocol.js';

let adapter: TerminalAdapter;
let snapshot: SurfaceSnapshot;

const ctx = (s: SurfaceSnapshot, extra: Partial<ResolveContext> = {}): ResolveContext => ({
  snapshot: s,
  inputs: {},
  ...extra,
});

const target = (t: Partial<Target> & Pick<Target, 'anchor' | 'relation'>): Target => ({
  rationale: 'test',
  description: 'test target',
  ...t,
});

beforeAll(async () => {
  adapter = new TerminalAdapter({ evidenceDir: 'evidence/scratch/test-terminal' });
  await adapter.start();
  snapshot = await adapter.observe();
});

afterAll(async () => {
  await adapter?.close();
});

describe('perception: what this surface actually offers', () => {
  it('projects the grid into a non-empty, reading-order-sorted element list', () => {
    expect(snapshot.surface).toBe('terminal');
    expect(snapshot.screenId).toBe('MBR001');
    expect(snapshot.elements.length).toBeGreaterThan(5);

    const orders = snapshot.elements.map((e) => e.readingOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('exposes NO role and NO name on any element — the thesis precondition', () => {
    const withRole = snapshot.elements.filter((e) => e.role !== undefined);
    const withName = snapshot.elements.filter((e) => e.name !== undefined);
    expect(withRole).toEqual([]);
    expect(withName).toEqual([]);
  });

  it('carries a writability predicate derived from the field attribute', () => {
    const writable = snapshot.elements.filter((e) => e.writable);
    // Exactly one unprotected field on the member-inquiry panel.
    expect(writable).toHaveLength(1);
    expect(writable[0]?.position).toEqual({ row: 4, col: 22 });
  });
});

describe('dot-leader normalisation is a real 5250 detail, not decoration', () => {
  it('normalises captions written with dot leaders and a trailing colon', () => {
    expect(normaliseLiteral('MEMBER ID . . . . :')).toBe('MEMBER ID');
    expect(normaliseLiteral('  SAVINGS ACCT  . . ')).toBe('SAVINGS ACCT');
    // The same normalisation lets ONE artifact literal match a web label too.
    expect(normaliseLiteral('Member ID:')).toBe('MEMBER ID');
  });

  it('harvests the panel caption as an anchorable element', () => {
    const captions = snapshot.elements
      .filter((e) => e.text !== undefined)
      .map((e) => normaliseLiteral(e.text as string));
    expect(captions).toContain('MEMBER ID');
    expect(captions).toContain('BALANCE');
    expect(captions).toContain('SAVINGS ACCT');
  });
});

describe('relations resolve with only a grid and field attributes', () => {
  it("resolves 'next-writable' from a label to the first UNPROTECTED field", async () => {
    const out = await adapter.resolve(
      target({ anchor: { kind: 'label', text: 'MEMBER ID' }, relation: 'next-writable' }),
      ctx(snapshot),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.resolution.element.writable).toBe(true);
    expect(out.resolution.element.position).toEqual({ row: 4, col: 22 });
    expect(out.resolution.strategy).toBe('grid-scan');
    expect(out.resolution.candidates).toBe(1);
  });

  it("resolves 'next-value' from a label to the following PROTECTED display field", async () => {
    // Populate the panel first, so there is a value to read.
    const fill = await adapter.resolve(
      target({ anchor: { kind: 'label', text: 'MEMBER ID' }, relation: 'next-writable' }),
      ctx(snapshot),
    );
    expect(fill.ok).toBe(true);
    if (!fill.ok) return;
    await adapter.act({ kind: 'fill', element: fill.resolution.element, value: '12345' });
    await adapter.act({ kind: 'press', key: 'Enter' });

    const after = await adapter.observe();
    const out = await adapter.resolve(
      target({ anchor: { kind: 'label', text: 'BALANCE' }, relation: 'next-value' }),
      ctx(after),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.resolution.element.writable).toBe(false);
    expect(out.resolution.element.value).toBe('4,250.00');
  });

  it('roleHint is NEVER consulted — a deliberately wrong hint still resolves', async () => {
    const out = await adapter.resolve(
      target({
        anchor: { kind: 'label', text: 'MEMBER ID' },
        relation: 'next-writable',
        // Nonsense for a text entry field. If the resolver used this, it would
        // fail or resolve elsewhere. It must be ignored entirely.
        roleHint: 'table',
      }),
      ctx(snapshot),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.resolution.element.position).toEqual({ row: 4, col: 22 });
  });
});

describe('ambiguity halts instead of guessing', () => {
  it('returns anchor-ambiguous when a literal matches more than one element', async () => {
    // Synthetic snapshot: the same literal twice, as when two panels or two
    // account rows both show "BALANCE". Picking the first would write to, or
    // read from, the wrong record.
    const duplicated: SurfaceSnapshot = {
      surface: 'terminal',
      screenId: 'SYNTH',
      capturedAt: new Date().toISOString(),
      text: '',
      elements: [
        { id: 'a', text: 'BALANCE', writable: false, enabled: true, readingOrder: 100, position: { row: 1, col: 0 } },
        { id: 'b', text: '0.00', writable: false, enabled: true, readingOrder: 110, position: { row: 1, col: 20 } },
        { id: 'c', text: 'BALANCE', writable: false, enabled: true, readingOrder: 200, position: { row: 2, col: 0 } },
        { id: 'd', text: '9.99', writable: false, enabled: true, readingOrder: 210, position: { row: 2, col: 20 } },
      ],
    };

    const out = await adapter.resolve(
      target({ anchor: { kind: 'label', text: 'BALANCE' }, relation: 'next-value' }),
      ctx(duplicated),
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('anchor-ambiguous');
    expect(out.candidates).toBe(2);
    // The message must tell an operator how to fix it, not just that it broke.
    expect(out.detail).toMatch(/scope/i);
  });

  it('returns anchor-unresolved for a literal that is not on the screen', async () => {
    const out = await adapter.resolve(
      target({ anchor: { kind: 'label', text: 'ROUTING NUMBER' }, relation: 'next-writable' }),
      ctx(snapshot),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('anchor-unresolved');
  });
});

describe('the field attribute is enforced, not advisory', () => {
  it('refuses to write into a protected display field', async () => {
    const fresh = await adapter.observe();
    // Reach the field the way an artifact would — via a relation — rather than
    // by hunting the element list. Note that a CAPTION is also non-writable, so
    // "not writable" alone does not mean "a display field"; `next-value`
    // requires a field carrying a value, which is the distinction that matters.
    const out = await adapter.resolve(
      target({ anchor: { kind: 'label', text: 'NAME' }, relation: 'next-value' }),
      ctx(fresh),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const field = out.resolution.element;
    expect(field.writable).toBe(false);
    expect(field.position).toEqual({ row: 6, col: 21 });

    await expect(adapter.act({ kind: 'fill', element: field, value: 'HACKED' })).rejects.toThrow(
      /PROTECTED/i,
    );
  });

  it('rejects actions that have no meaning on a character grid', async () => {
    await expect(adapter.act({ kind: 'navigate', url: 'https://example.test' })).rejects.toThrow(
      /no meaning on a character grid/i,
    );
  });
});

describe('per-tenant lexicon translates anchor literals at resolve time', () => {
  it('resolves a translated caption without touching the artifact', async () => {
    // A tenant whose panel is Spanish. The artifact still says "MEMBER ID";
    // only the dictionary changes. This is the payoff of anchoring on named
    // literals rather than opaque selectors.
    const spanish: SurfaceSnapshot = {
      ...snapshot,
      elements: snapshot.elements.map((e) =>
        e.text !== undefined && normaliseLiteral(e.text) === 'MEMBER ID'
          ? { ...e, text: 'ID DE MIEMBRO . . :' }
          : e,
      ),
    };

    const base = target({ anchor: { kind: 'label', text: 'MEMBER ID' }, relation: 'next-writable' });

    // Without the lexicon the anchor is gone — which is the drift signal.
    const before = await adapter.resolve(base, ctx(spanish));
    expect(before.ok).toBe(false);

    // With it, the same artifact resolves.
    const fallbacks: string[] = [];
    const after = await adapter.resolve(
      base,
      ctx(spanish, {
        lexicon: { 'MEMBER ID': 'ID DE MIEMBRO' },
        onFallback: (_s, detail) => fallbacks.push(detail),
      }),
    );
    expect(after.ok).toBe(true);
    expect(fallbacks.join()).toMatch(/lexicon/);
  });
});
