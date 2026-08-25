/**
 * THE CONDITION EVALUATOR — the single place assertions are decided.
 *
 * Preconditions, per-step checkpoints, success conditions, outcome detectors and
 * recovery triggers all run through this one function, so there is exactly one
 * set of semantics to keep deterministic and exactly one thing to reason about
 * when a run reports "expected X, observed Y".
 *
 * Every failure path returns a HUMAN-READABLE `detail`, because that string is
 * what ends up in `FailureResult.observed` and in the intervention request an
 * operator has to act on. "checkpoint failed" is useless at 3am; "no element on
 * MBR001 reads BALANCE" is actionable.
 */

import type { Condition, TextMatch } from '../schema/condition.js';
import { describeCondition } from '../schema/condition.js';
import type { ResolveContext, SurfaceAdapter, SurfaceSnapshot } from '../adapter/surface.js';

export interface EvalResult {
  ok: boolean;
  /** What was actually observed, for the result contract and operator handoff. */
  detail: string;
}

/**
 * "Effective text" — the surface-independent notion the `text` condition
 * compares against. An input's current contents on web, a field's buffer on a
 * character grid, textContent for static elements. The artifact never has to
 * know which of those it is dealing with.
 */
function effectiveText(el: { value?: string; text?: string }): string {
  return el.value ?? el.text ?? '';
}

function matches(actual: string, expected: string, mode: TextMatch | undefined): boolean {
  const a = actual.trim();
  const e = expected.trim();
  switch (mode ?? 'exact') {
    case 'exact':
      return a === e;
    case 'contains':
      return a.includes(e);
    case 'regex':
      // A capability author's regex is reviewed content, not user input, but an
      // invalid pattern must fail the assertion rather than crash the run.
      try {
        return new RegExp(e).test(a);
      } catch {
        return false;
      }
  }
}

export async function evaluate(
  cond: Condition,
  adapter: SurfaceAdapter,
  ctx: ResolveContext,
): Promise<EvalResult> {
  switch (cond.type) {
    case 'settled': {
      const ok = await adapter.settle(5_000);
      return { ok, detail: ok ? 'surface settled' : 'surface did not settle' };
    }

    case 'present': {
      const out = await adapter.resolve(cond.target, ctx);
      return out.ok
        ? { ok: true, detail: `resolved via ${out.resolution.strategy}` }
        : { ok: false, detail: out.detail };
    }

    case 'absent': {
      const out = await adapter.resolve(cond.target, ctx);
      // An AMBIGUOUS match still means "present", so `absent` must be false.
      // Treating ambiguity as absence would let a dialog that appeared twice
      // read as gone, which is the wrong way to be wrong.
      if (out.ok) {
        return { ok: false, detail: `still present at ${JSON.stringify(out.resolution.element.position)}` };
      }
      if (out.reason === 'anchor-ambiguous') {
        return { ok: false, detail: `still present (${out.candidates} matches)` };
      }
      return { ok: true, detail: 'absent' };
    }

    case 'enabled': {
      const out = await adapter.resolve(cond.target, ctx);
      if (!out.ok) return { ok: false, detail: out.detail };
      const el = out.resolution.element;
      return el.enabled
        ? { ok: true, detail: 'enabled' }
        : { ok: false, detail: 'resolved but not enabled' };
    }

    case 'text': {
      const out = await adapter.resolve(cond.target, ctx);
      if (!out.ok) return { ok: false, detail: out.detail };
      const actual = effectiveText(out.resolution.element);
      // Expanded through the engine, which owns inputs and bindings. A literal
      // stays a literal when no expander is supplied, so terminal capabilities
      // written before this existed behave identically.
      const expected = ctx.expand ? ctx.expand(cond.text) : cond.text;
      const ok = matches(actual, expected, cond.match);
      return {
        ok,
        detail: ok ? `text "${actual}"` : `text was "${actual}", expected ${cond.match ?? 'exact'} "${expected}"`,
      };
    }

    case 'all': {
      const details: string[] = [];
      for (const sub of cond.of) {
        const r = await evaluate(sub, adapter, ctx);
        details.push(r.detail);
        // Short-circuit and report WHICH conjunct failed, not just that one did.
        if (!r.ok) return { ok: false, detail: `${describeCondition(sub)} -> ${r.detail}` };
      }
      return { ok: true, detail: details.join('; ') };
    }

    case 'any': {
      const details: string[] = [];
      for (const sub of cond.of) {
        const r = await evaluate(sub, adapter, ctx);
        if (r.ok) return { ok: true, detail: r.detail };
        details.push(`${describeCondition(sub)} -> ${r.detail}`);
      }
      return { ok: false, detail: `none matched: ${details.join('; ')}` };
    }
  }
}

/** Convenience: evaluate against a freshly observed snapshot. */
export async function evaluateFresh(
  cond: Condition,
  adapter: SurfaceAdapter,
  base: Omit<ResolveContext, 'snapshot'>,
): Promise<{ result: EvalResult; snapshot: SurfaceSnapshot }> {
  const snapshot = await adapter.observe();
  const result = await evaluate(cond, adapter, { ...base, snapshot });
  return { result, snapshot };
}
