/**
 * RENDERING A SURFACE FOR A MODEL.
 *
 * What the discovery agent is shown determines what it can produce, so this
 * function is doing more design work than its size suggests.
 *
 * IT DOES NOT SHOW SELECTORS. No CSS, no XPath, no DOM path, no tag names — not
 * because they are unavailable but because a model shown selectors proposes
 * selectors, and the artifact would end up encoding the recording surface. What
 * it shows instead is what an operator sees: visible text, whether a control can
 * be typed into, reading order, and table position. Those are exactly the
 * inputs the anchor-and-relation vocabulary is defined over, so the model is
 * reasoning in the same terms the artifact will be written in.
 *
 * IT DOES NOT SHOW SCREENSHOTS EITHER. Coordinates are not reviewable and not
 * stable, and a model given pixels will reach for them. The accessibility-style
 * projection is both cheaper and better-shaped for the thing being compiled.
 *
 * It DOES show `name` and its provenance where the surface offers one, because
 * a control with an authored label association is genuinely easier to anchor
 * and the model should be able to prefer it. That is the enrichment position
 * the whole design takes: available when the surface has it, never required.
 */

import type { SurfaceSnapshot } from '../adapter/surface.js';

/** Keep one observation bounded. A 900-element page would crowd out the goal. */
const MAX_ELEMENTS = 140;
const MAX_TEXT = 90;

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

export function renderSnapshot(snap: SurfaceSnapshot): string {
  const lines: string[] = [
    `SCREEN ${snap.screenId}  (surface: ${snap.surface}, ${snap.elements.length} elements)`,
    '',
  ];

  const shown = snap.elements.slice(0, MAX_ELEMENTS);
  for (const e of shown) {
    const bits: string[] = [];
    if (e.writable) bits.push('WRITABLE');
    if (!e.enabled) bits.push('disabled');
    if (e.position.row !== undefined) bits.push(`row=${e.position.row}`);
    if (e.position.col !== undefined) bits.push(`col=${e.position.col}`);
    // Provenance matters to the model's choice, so it is spelled out rather
    // than flattened into a bare name.
    if (e.name !== undefined) bits.push(`name=${JSON.stringify(clip(e.name))}${e.nameSource ? `(${e.nameSource})` : ''}`);

    const content = e.value !== undefined ? `value=${JSON.stringify(clip(e.value))}` : e.text !== undefined ? JSON.stringify(clip(e.text)) : '<no text>';

    lines.push(`  #${e.readingOrder} ${content}${bits.length ? '  [' + bits.join(' ') + ']' : ''}`);
  }

  if (snap.elements.length > shown.length) {
    lines.push(`  … ${snap.elements.length - shown.length} more elements not shown`);
  }
  return lines.join('\n');
}
