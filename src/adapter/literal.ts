/**
 * ANCHOR-LITERAL NORMALISATION — shared by every adapter.
 *
 * An anchor stores the text a human reads next to a control. Surfaces decorate
 * that text differently, and the decoration is not part of the control's
 * identity:
 *
 *   5250 panel   MEMBER ID . . . . :      dot leaders track the eye across
 *   Angular      Client Name :            trailing colon
 *   legacy web   MEMBER ID:&nbsp;         non-breaking space
 *   any surface  Total  Savings           collapsed whitespace from markup
 *
 * All four must match one stored literal, or the artifact stops being portable
 * and starts encoding the quirks of whichever surface it was recorded on. That
 * is the whole reason this function is here rather than inside either adapter:
 * if the terminal normalised dot leaders and the web adapter normalised
 * something else, "the same anchor resolves on both surfaces" would be a
 * coincidence of the test data rather than a property of the system.
 *
 * It lives under src/adapter/ and not src/schema/ deliberately. Normalisation
 * is a PERCEPTION concern — how a surface renders a literal — not a contract
 * concern. The schema stores what a human would write; adapters are responsible
 * for recognising it in whatever form their surface presents.
 */

/**
 * Normalise a literal for anchor matching.
 *
 * Case-insensitive because a 5250 panel is upper-case by convention and a web
 * label is title case, and "MEMBER ID" and "Member Id" are the same caption to
 * an operator.
 */
export function normaliseLiteral(raw: string): string {
  return raw
    .replace(/ /g, ' ') // &nbsp; — invisible in the DOM, fatal to a match
    .replace(/[.·]+/g, ' ') // dot leaders -> space
    .replace(/[[\]_]+/g, ' ') // field brackets and rule underscores are decoration
    .replace(/\s+/g, ' ') // collapse runs
    .replace(/\s*:\s*$/, '') // trailing colon
    .trim()
    .toUpperCase();
}
