/**
 * HOW A CONTROL IS IDENTIFIED — the centrepiece of this design.
 *
 * The usual answer is `role` + accessible name. That is not a surface-
 * independent identity; it is an artifact of the accessibility layer that
 * browsers and desktop toolkits happen to expose. The systems this product has
 * to reach do not all have that layer. Jack Henry SilverLake and CIF 20/20 run
 * on IBM i and present 5250 green screens: an 80x24 character grid with no DOM,
 * no event model, no CSS selectors and no accessibility tree. A schema built on
 * `role` + name does not extend there. It has to be rewritten.
 *
 * The primitive that exists on every surface is AN ANCHOR PLUS A RELATION.
 * A control is identified by a stable visible literal near it, and by how it
 * sits relative to that literal.
 *
 *   Surface      | "the field labelled MEMBER ID" resolves as
 *   -------------|--------------------------------------------------------------
 *   Modern web   | <label for> association, or role + accessible name
 *   Legacy web   | the <td> immediately right of the <td> holding the literal
 *   Desktop (AX) | the AXTitleUIElement / labelled-by relation
 *   5250 / 3270  | the first unprotected field after the literal in the grid
 *
 * So `role` and `name` become ENRICHMENTS an adapter may use when the surface
 * offers them — not the schema's primary concept. That inversion is the whole
 * submission, and it is a schema-level decision: it cannot be retrofitted onto
 * a role-and-name artifact without rewriting every stored artifact.
 *
 * Two invariants that fall out of this and are enforced elsewhere:
 *
 *   1. THERE IS NO COORDINATE LOCATOR. Coordinates are not an identity — they
 *      break on DPI, window size and a shifted banner. If a control cannot be
 *      anchored, the run halts rather than guessing. See ReplayResult's
 *      `anchor-unresolved`.
 *
 *   2. AMBIGUITY HALTS. If an anchor resolves to more than one control we fail
 *      with `anchor-ambiguous` and never pick the first. On a grid where two
 *      screens share the literal "BALANCE", guessing writes to the wrong
 *      record.
 */

import { z } from 'zod';

/** Surfaces the adapter seam is defined over. `desktop` is a documented seam, not implemented. */
export const SurfaceKind = z.enum(['web', 'terminal', 'desktop']);
export type SurfaceKind = z.infer<typeof SurfaceKind>;

/**
 * ENRICHMENT ONLY — never required to resolve a target.
 *
 * The terminal adapter ignores this field entirely; a 5250 field attribute
 * distinguishes protected from unprotected, not "button" from "textbox". If any
 * resolution path ever *requires* a roleHint, the abstraction has leaked and
 * `tests/terminal-resolve.test.ts` will fail.
 */
export const ControlRole = z.enum([
  'button',
  'link',
  'textbox',
  'select',
  'checkbox',
  'cell',
  'row',
  'table',
  'region',
  'heading',
  'dialog',
  'alert',
]);
export type ControlRole = z.infer<typeof ControlRole>;

/**
 * WHAT identifies this control semantically — a stable visible literal.
 *
 * Anchors are matched against normalised text, so a 5250 panel's dot leaders
 * ("MEMBER ID . . . . :") and a web app's colon suffix both normalise to
 * "MEMBER ID". Normalisation lives in the adapters; the artifact stores the
 * human-meaningful literal.
 */
export const Anchor = z.discriminatedUnion('kind', [
  /** A caption beside or above the control. "MEMBER ID" */
  z.object({ kind: z.literal('label'), text: z.string().min(1) }).strict(),
  /** The control's own visible text. Buttons and links. "Search" */
  z.object({ kind: z.literal('self'), text: z.string().min(1) }).strict(),
  /** A table column header, for cell addressing. "Balance" */
  z.object({ kind: z.literal('column-header'), text: z.string().min(1) }).strict(),
  /** A named region / screen section / panel title. "Savings Account Overview" */
  z.object({ kind: z.literal('landmark'), text: z.string().min(1) }).strict(),
  /**
   * Resolve against the runtime VALUE of an input parameter rather than a
   * literal baked into the artifact. Lets one artifact select the row for
   * whichever member id the caller passed, without the id ever being stored.
   */
  z.object({ kind: z.literal('param'), name: z.string().min(1) }).strict(),
]);
export type Anchor = z.infer<typeof Anchor>;

/**
 * HOW the control sits relative to the anchor.
 *
 * Every relation below is defined purely in terms of two properties that
 * EVERY adapter must produce for every observed element — `readingOrder` and
 * `writable` (see ObservedElement in ../adapter/surface.ts). Nothing here is
 * expressed as a CSS selector, an XPath axis or a DOM API call. That is
 * precisely why the same relation vocabulary executes against a character grid.
 *
 *   is              the anchor IS the control (buttons, links)
 *   next-writable   first WRITABLE element after the anchor in reading order.
 *                   Needs the writability predicate — this is the relation that
 *                   makes "the input beside MEMBER ID" mean something on a 5250
 *                   screen, where the answer is "the next unprotected field".
 *   next-value      first readable value after the anchor. Read-only displays.
 *   same-row        element in the anchor's row; `index` is the column offset.
 *   under-column    cell beneath a column header.
 *   within          contained inside the anchor's region.
 *   nth-in-region   positional inside a named region. LAST RESORT: ordinal
 *                   position is the weakest anchor there is, so a target using
 *                   it must justify itself in `rationale`.
 */
export const Relation = z.enum([
  'is',
  'next-writable',
  'next-value',
  'same-row',
  'under-column',
  'within',
  'nth-in-region',
]);
export type Relation = z.infer<typeof Relation>;

export interface Target {
  anchor: Anchor;
  relation: Relation;
  /** Ordinal for `nth-in-region` (0-based); column offset for `same-row`. */
  index?: number;
  /** Enrichment. Undefined on terminal. Never required. */
  roleHint?: ControlRole;
  /** Resolve only within this region — disambiguates repeated literals. */
  scope?: Target;
  /**
   * REQUIRED. Why this target survives change.
   *
   * The brief asks for "how each target element/control is identified, with your
   * reasoning about robustness". An unexplained locator is an unauditable one: a
   * reviewer should be able to assess the robustness argument without replaying
   * the flow. Making this non-optional is a deliberate cost imposed on the
   * discovery agent — it must state a reason, which is also the artifact's
   * review surface.
   */
  rationale: string;
  /** Human-readable, used in logs, drift reports and intervention requests. */
  description: string;
  /**
   * Documented escape hatch for a surface-specific quirk that genuinely cannot
   * be anchored. Using one is recorded as a `adapter-hint-used` portability
   * warning on the result — never passed silently. A capability that needs
   * these on most steps is a capability that should be forked per surface, and
   * the warning count is how you find that out.
   */
  adapterHints?: Partial<Record<SurfaceKind, unknown>>;
}

/** Recursive via `scope`, so the schema needs an explicit annotation + z.lazy. */
export const Target: z.ZodType<Target> = z.lazy(() =>
  z
    .object({
      anchor: Anchor,
      relation: Relation,
      index: z.number().int().min(0).optional(),
      roleHint: ControlRole.optional(),
      scope: Target.optional(),
      rationale: z.string().min(1, 'rationale is required — an unexplained locator is unauditable'),
      description: z.string().min(1),
      adapterHints: z.record(SurfaceKind, z.unknown()).optional(),
    })
    .strict()
    .superRefine((t, ctx) => {
      // `nth-in-region` is the only relation that is meaningless without an
      // ordinal, and it is also the weakest. Require the ordinal explicitly
      // rather than defaulting to 0, so "first one" is always a stated choice.
      if (t.relation === 'nth-in-region' && t.index === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['index'],
          message: "relation 'nth-in-region' requires an explicit index",
        });
      }
      // A column header anchors a cell. Pairing it with `next-writable` would
      // silently mean "some editable thing after the header", which is not what
      // anyone means and resolves differently on every surface.
      if (t.anchor.kind === 'column-header' && t.relation !== 'under-column' && t.relation !== 'same-row') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relation'],
          message: "anchor 'column-header' requires relation 'under-column' or 'same-row'",
        });
      }
      // `self` means the anchor text IS the control's own text, so the only
      // coherent relation is identity.
      if (t.anchor.kind === 'self' && t.relation !== 'is') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relation'],
          message: "anchor 'self' requires relation 'is'",
        });
      }
    }),
);

/**
 * A sparse patch over a Target, for per-tenant overrides.
 *
 * Declared explicitly rather than derived with `.partial()`, because Target is
 * recursive and therefore a `ZodType` rather than a `ZodObject`. Being explicit
 * is the better outcome regardless: this is the exact list of things a tenant is
 * permitted to change, and it is reviewable as such.
 */
export const TargetPatch = z
  .object({
    anchor: Anchor.optional(),
    relation: Relation.optional(),
    index: z.number().int().min(0).optional(),
    roleHint: ControlRole.optional(),
    scope: Target.optional(),
    /** A tenant that changes the anchor should say why it still holds. */
    rationale: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    adapterHints: z.record(SurfaceKind, z.unknown()).optional(),
  })
  .strict();
export type TargetPatch = z.infer<typeof TargetPatch>;

/** Stable one-line rendering of a target, for logs and drift reports. */
export function describeTarget(t: Target): string {
  const anchorText = t.anchor.kind === 'param' ? `{{${t.anchor.name}}}` : t.anchor.text;
  const ordinal = t.index === undefined ? '' : `[${t.index}]`;
  const scope = t.scope ? ` within(${describeTarget(t.scope)})` : '';
  return `${t.relation}${ordinal} of ${t.anchor.kind}:"${anchorText}"${scope}`;
}
