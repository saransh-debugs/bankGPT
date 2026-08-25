/**
 * PER-TENANT SPECIALISATION — the multi-tenant reuse answer.
 *
 * The environment this targets has hundreds of institutions running ~20 apps
 * each, and many run the SAME underlying vendor product, configured, branded
 * and versioned differently. Re-recording a capability per tenant does not
 * scale, and forking it per tenant means every fix has to be applied N times.
 *
 * A TenantOverride is a SPARSE PATCH over a base capability. The base is the
 * shared truth; a tenant contributes only its differences.
 *
 * THE LEXICON IS THE PAYOFF OF ANCHOR-RELATION TARGETING.
 *
 * Because targets are anchored on NAMED VISIBLE LITERALS rather than opaque
 * selectors, the commonest per-tenant difference — this institution calls it
 * "ID de Miembro", that one calls it "CIF Number" — is a DICTIONARY, not a
 * re-record:
 *
 *     lexicon: { "Member ID": "ID de Miembro" }
 *
 * Every target anchored on "Member ID" now resolves for that tenant, across
 * every step, every checkpoint, every outcome detector, with no change to the
 * base artifact. A selector-based schema cannot do this: there is nothing in
 * `#mbrId > td:nth-child(2)` to translate. This is the concrete reason the
 * schema-level inversion earns its cost.
 *
 * FORK-VS-PATCH THRESHOLD. An override is the right tool for renamed literals,
 * a different base URL, locale and date formats, and a handful of patched
 * steps. If a tenant needs to override more than roughly a quarter of the
 * steps, its flow is not the same flow any more and it should be forked into
 * its own capability. `overrideRatio()` below computes the number so the
 * decision is made on evidence rather than vibes, and `validate` warns past the
 * threshold.
 */

import { z } from 'zod';
import { ApprovalState, OutcomeDetector, RecoveryPolicy } from './capability.js';
import { TargetPatch } from './target.js';

/** Past this share of patched steps, fork the capability instead of patching it. */
export const FORK_THRESHOLD = 0.25;

export const TenantOverride = z
  .object({
    capabilityId: z.string().min(1),
    /**
     * The base version this override was reviewed against. A mismatch forces
     * re-review rather than silently patching a capability that has moved —
     * an override written for 1.0.0 has no business applying to 2.0.0
     * unexamined.
     */
    baseVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver'),
    tenant: z.string().min(1),

    /**
     * Why this tenant differs, in prose, for the human who reviews the patch.
     *
     * The same argument that makes `Target.rationale` mandatory applies here: a
     * patch that changes what automation does to a live banking system, with no
     * statement of why, is unreviewable. A reader must be able to tell "this
     * institution's panels are in Spanish" from "someone patched a step to make
     * a failing run go green" without diffing against the base.
     */
    description: z.string().min(1).optional(),
    /** Longer reviewer notes — scope, caveats, what was deliberately not patched. */
    notes: z.array(z.string()).optional(),

    /**
     * THE LOCALISATION ANSWER. Anchor literals translated for this tenant,
     * applied to every target in the capability. Keys are the base literals.
     */
    lexicon: z.record(z.string(), z.string()).optional(),

    /**
     * Sparse per-step target patches, keyed by step id. Merged shallowly over
     * the base target, so a tenant can change a relation or add a scope without
     * restating the anchor.
     */
    targets: z.record(z.string(), TargetPatch).optional(),

    /** Sparse per-step literal value patches, keyed by step id. */
    stepValues: z.record(z.string(), z.string()).optional(),

    /** This tenant's deployment of the same product. */
    baseUrl: z.string().optional(),

    /**
     * Locale differences that change how VALUES are read and written, not just
     * how controls are found. A balance rendered "1.234,56" is not the number
     * "1.234" — getting this wrong silently corrupts extracted money values,
     * which is worse than failing.
     */
    locale: z
      .object({
        language: z.string().optional(),
        dateFormat: z.string().optional(),
        decimalSeparator: z.string().optional(),
        thousandsSeparator: z.string().optional(),
      })
      .strict()
      .optional(),

    /** Conditions this tenant can produce that the base cannot. */
    additionalOutcomes: z.array(OutcomeDetector).optional(),
    additionalRecoveries: z.array(RecoveryPolicy).optional(),

    /** An override carries its OWN approval state, independent of the base. */
    approvalState: ApprovalState,
  })
  .strict();
export type TenantOverride = z.infer<typeof TenantOverride>;

/**
 * Share of a capability's steps this override patches. Used to decide whether a
 * tenant should be patched or forked.
 */
export function overrideRatio(o: TenantOverride, totalSteps: number): number {
  if (totalSteps === 0) return 0;
  const touched = new Set([...Object.keys(o.targets ?? {}), ...Object.keys(o.stepValues ?? {})]);
  return touched.size / totalSteps;
}

/**
 * Apply a lexicon to a single anchor literal. Exact match on the base literal;
 * a lexicon is a reviewed dictionary, not a fuzzy matcher, because a
 * near-miss translation resolving to the wrong control is precisely the failure
 * mode anchoring is meant to eliminate.
 */
export function translateLiteral(literal: string, lexicon: Record<string, string> | undefined): string {
  if (!lexicon) return literal;
  return lexicon[literal] ?? literal;
}
