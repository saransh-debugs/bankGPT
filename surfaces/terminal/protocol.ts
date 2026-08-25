/**
 * THE TERMINAL WIRE PROTOCOL — a shared contract module, imported by both the
 * host (surfaces/terminal/app.ts) and the adapter (src/adapter/terminal.ts).
 * Think of it as the .proto file for this surface.
 *
 * WHY IT LOOKS LIKE THIS
 *
 * The point of the second surface is to prove the artifact schema is not
 * web-shaped, so the perception constraints have to be real rather than
 * decorative. A 5250 display station does not hand software a DOM; it holds a
 * FORMAT TABLE describing each field, and each field carries a FIELD ATTRIBUTE
 * byte (set by a Start of Field order) that says, among other things, whether
 * the field is protected or unprotected. The station buffers keystrokes locally
 * and transmits the changed screen only when an AID key (Enter, a command key,
 * Field Exit) is pressed. That is block mode.
 *
 * So this protocol carries exactly two planes and nothing else:
 *
 *   1. the CHARACTER plane   — 24 rows of 80 columns, verbatim
 *   2. the ATTRIBUTE plane   — one FIELD record per field, protected or not
 *
 * plus cursor position and the message line. There is no element tree, no
 * roles, no names, no identifiers, no styling. If the adapter can find "the
 * field labelled MEMBER ID" given only this, the anchor-relation model is
 * genuinely surface-independent; if it needs anything more, it isn't.
 *
 * MIGRATION PATH — deliberately verb-for-verb with a real emulator.
 *
 * For a 3270 host (IBM mainframe, TN3270E) the swap-in is `s3270`, the
 * script-only member of the x3270 suite. The mapping is close to exact:
 *
 *   this protocol          s3270
 *   ---------------------  ------------------------------------------------
 *   READBUFFER -> SCREEN   ReadBuffer(Ascii) — which emits SF(aa=nn) and
 *                          SA(aa=nn) start-of-field / extended-attribute
 *                          tokens, so protected vs unprotected really is
 *                          recoverable from it. That is the fact this
 *                          protocol's FIELD records stand in for.
 *   CURSOR                 Query(Cursor)
 *   SCREEN <rows> <cols>   Query(ScreenCurSize)
 *   FILL                   MoveCursor(...) then String("...")
 *   AID Enter              Enter()
 *   AID F3                 PF(3)
 *
 * For a 5250 host (IBM i — SilverLake, CIF 20/20) s3270 is the WRONG protocol:
 * 5250 is a different telnet data stream (RFC 1205) and x3270 does not
 * implement it. The defensible 5250 path is `lib5250` from the tn5250 project
 * for an in-process client, a JVM emulator exposing a real screen API
 * (tn5250j's Screen5250, or Blazemeter's xtn5250), or — on IBM-supported
 * ground — IBM i Access Client Solutions, which exposes EHLLAPI and Host
 * On-Demand macro scripting.
 *
 * Either way what changes is the TRANSPORT behind `observe()`. The projection
 * into ObservedElement, the relation vocabulary, the artifact schema and the
 * replay engine are untouched.
 */

export const ROWS = 24;
export const COLS = 80;

/**
 * One field in the format table.
 *
 * `protected` is the field attribute that matters here: an unprotected field is
 * one the operator can type into. It is what `next-writable` resolves against,
 * and it is the reason that relation needs a writability predicate at all —
 * on a character grid there is no other way to say "the input beside this
 * label".
 */
export interface FieldRecord {
  row: number;
  col: number;
  length: number;
  protected: boolean;
  /**
   * Host-side identifier. Deliberately NOT exposed to the adapter's resolution
   * path — it exists so the host can wire its own business logic, and so a test
   * can assert the adapter resolved a field WITHOUT consulting it. Treating it
   * as a locator would smuggle a test ID onto a surface that has none.
   */
  name?: string;
}

/** A decoded screen: the two planes, plus cursor and message line. */
export interface ScreenBuffer {
  screenId: string;
  rows: number;
  cols: number;
  /** `rows` strings, each exactly `cols` characters. */
  plane: string[];
  fields: FieldRecord[];
  cursor: { row: number; col: number };
  message: string;
}

/** Commands the client sends to the host. */
export type HostCommand =
  /** Local buffer edit. Does NOT transmit — block mode. */
  | { kind: 'fill'; row: number; col: number; text: string }
  /** Press an AID key: transmits the changed screen and the host replies. */
  | { kind: 'aid'; key: string }
  /** Re-emit the current screen without changing anything. */
  | { kind: 'readbuffer' };

// ---------------------------------------------------------------------------
// Encoding. Line-oriented and human-readable on purpose: the transcript of a
// terminal session is then diffable, which makes a state delta for the
// human-handoff record a literal text diff rather than a bespoke format.
// ---------------------------------------------------------------------------

export function encodeScreen(s: ScreenBuffer): string {
  const out: string[] = [];
  out.push(`SCREEN ${s.screenId} ${s.rows} ${s.cols}`);
  for (const [i, line] of s.plane.entries()) {
    // Pad rather than trim so every ROW is exactly `cols` wide: column index is
    // load-bearing for position, so a short row would silently shift fields.
    out.push(`ROW ${i} ${line.padEnd(s.cols, ' ').slice(0, s.cols)}`);
  }
  for (const f of s.fields) {
    out.push(
      `FIELD ${f.row} ${f.col} ${f.length} ${f.protected ? 'P' : 'U'}${f.name ? ` ${f.name}` : ''}`,
    );
  }
  out.push(`CURSOR ${s.cursor.row} ${s.cursor.col}`);
  out.push(`MSG ${s.message}`);
  out.push('END');
  return out.join('\n') + '\n';
}

export function decodeScreen(text: string): ScreenBuffer {
  const lines = text.split('\n');
  let screenId = '';
  let rows = ROWS;
  let cols = COLS;
  const plane: string[] = [];
  const fields: FieldRecord[] = [];
  let cursor = { row: 0, col: 0 };
  let message = '';

  for (const line of lines) {
    if (line.startsWith('SCREEN ')) {
      const [, id, r, c] = line.split(' ');
      screenId = id ?? '';
      rows = Number(r ?? ROWS);
      cols = Number(c ?? COLS);
    } else if (line.startsWith('ROW ')) {
      // Only the first two tokens are structural; the rest is the row verbatim,
      // so it must be sliced by offset and never split on spaces.
      const sp = line.indexOf(' ', 4);
      const idx = Number(line.slice(4, sp));
      plane[idx] = line.slice(sp + 1);
    } else if (line.startsWith('FIELD ')) {
      const parts = line.split(' ');
      const rec: FieldRecord = {
        row: Number(parts[1]),
        col: Number(parts[2]),
        length: Number(parts[3]),
        protected: parts[4] === 'P',
      };
      if (parts[5] !== undefined) rec.name = parts.slice(5).join(' ');
      fields.push(rec);
    } else if (line.startsWith('CURSOR ')) {
      const [, r, c] = line.split(' ');
      cursor = { row: Number(r ?? 0), col: Number(c ?? 0) };
    } else if (line.startsWith('MSG')) {
      message = line.length > 4 ? line.slice(4) : '';
    }
  }

  for (let i = 0; i < rows; i++) {
    plane[i] = (plane[i] ?? '').padEnd(cols, ' ').slice(0, cols);
  }

  return { screenId, rows, cols, plane, fields, cursor, message };
}

export function encodeCommand(c: HostCommand): string {
  switch (c.kind) {
    case 'fill':
      return `FILL ${c.row} ${c.col} ${c.text}\n`;
    case 'aid':
      return `AID ${c.key}\n`;
    case 'readbuffer':
      return `READBUFFER\n`;
  }
}

export function decodeCommand(line: string): HostCommand | null {
  const t = line.trim();
  if (t.startsWith('FILL ')) {
    const sp1 = t.indexOf(' ', 5);
    const sp2 = t.indexOf(' ', sp1 + 1);
    if (sp1 < 0 || sp2 < 0) return null;
    return {
      kind: 'fill',
      row: Number(t.slice(5, sp1)),
      col: Number(t.slice(sp1 + 1, sp2)),
      text: t.slice(sp2 + 1),
    };
  }
  if (t.startsWith('AID ')) return { kind: 'aid', key: t.slice(4).trim() };
  if (t === 'READBUFFER') return { kind: 'readbuffer' };
  return null;
}

/**
 * Anchor-literal normalisation moved to src/adapter/literal.ts when the web
 * adapter landed.
 *
 * Dot leaders are a real IBM i panel-design convention, not decoration: a
 * caption is written "MEMBER ID . . . . :" so the eye tracks across the screen.
 * But the *same* normalisation is what lets one stored literal match both that
 * panel and an Angular label reading "Client Name :" — so it is a property of
 * anchor matching in general, not of this protocol. Leaving it here would have
 * forced the web adapter to import the terminal surface package, which is
 * exactly the layering the SurfaceAdapter seam exists to prevent.
 *
 * Re-exported so this module's consumers do not have to care where it went.
 */
export { normaliseLiteral } from '../../src/adapter/literal.js';
