/**
 * THE HOST — a small back-office application perceived as an 80x24 character
 * grid, with an authentically 5250-flavoured panel design.
 *
 * HONEST FRAMING, stated here and in README/REPORT: a real 5250 host could not
 * lawfully be obtained, and the brief says not to try. So this reproduces the
 * PERCEPTION CONSTRAINTS of one — block-mode entry, a fixed character grid, no
 * DOM, no accessibility tree, fields addressable only by label proximity and
 * position, protected vs unprotected field attributes, AID-key transmit — and
 * nothing else. Its conditions (member not found, not authorised, session
 * expiry, slow response) are induced BY US, which is exactly the difference
 * between this surface and the Fineract one, where the conditions are the
 * product's own. Both claims are made plainly rather than blurred.
 *
 * PANEL DESIGN follows IBM i CUA convention, because the details are what make
 * the surface a real test of the schema rather than a costume:
 *   - a screen identifier in the top-right (SCR MBR001)
 *   - captions written with dot leaders ("MEMBER ID . . . . :")
 *   - a command-key legend near line 23
 *   - a one-line message area on line 24 (the message subfile)
 *   - F3=Exit, F12=Cancel
 *
 * THE TEMPLATE IS THE FORMAT TABLE. Rather than hand-maintaining field
 * coordinates (and getting them wrong), each panel is written as literal text
 * and the field records are DERIVED from it by scanning:
 *
 *     [      ]   -> an UNPROTECTED field (operator can type here)
 *     ______     -> a PROTECTED field (host writes, operator cannot)
 *
 * which is close to how a real DDS panel is specified, and means the picture a
 * human sees and the attributes the adapter perceives cannot drift apart.
 */

import { COLS, ROWS, type FieldRecord, type ScreenBuffer } from './protocol.js';

export interface Member {
  id: string;
  name: string;
  status: string;
  savingsAccount: string;
  balance: string;
  /** Simulates a record this operator's profile may not read. */
  restricted?: boolean;
  /** Simulates a slow host response, in ms. */
  slowMs?: number;
}

export const MEMBERS: Member[] = [
  { id: '12345', name: 'OKONKWO, JANET A', status: 'ACTIVE', savingsAccount: 'SAV-0001234567', balance: '4,250.00' },
  { id: '23456', name: 'REYES, MARCUS T', status: 'ACTIVE', savingsAccount: 'SAV-0002345678', balance: '812.44' },
  { id: '34567', name: 'NATARAJAN, PRIYA', status: 'DORMANT', savingsAccount: 'SAV-0003456789', balance: '15,004.19' },
  // Induces NOT AUTHORIZED on the message line.
  { id: '77777', name: 'CLASSIFIED', status: 'ACTIVE', savingsAccount: 'SAV-0007777777', balance: '0.00', restricted: true },
  // Induces a slow host response, to exercise timeout and `settled` handling.
  { id: '55555', name: 'SLOWMAN, OTTO', status: 'ACTIVE', savingsAccount: 'SAV-0005555555', balance: '99.01', slowMs: 3000 },
];

/** Member Services inquiry panel. `{}` markers are substituted before scanning. */
const MBR001 = [
  '================================================================================',
  ' NORTHRIDGE CU             MEMBER SERVICES                        SCR MBR001     ',
  '================================================================================',
  '                                                                                ',
  '   MEMBER ID . . . . [        ]                                                 ',
  '                                                                                ',
  '   NAME  . . . . . . ____________________                                       ',
  '   STATUS  . . . . . _______                                                    ',
  '   SAVINGS ACCT  . . ______________                                             ',
  '   BALANCE . . . . . ____________                                               ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  ' F3=Exit   F5=Refresh   F12=Cancel                                              ',
  ' MSG:                                                                           ',
];

/**
 * Sign-on panel. Swapped in when the session expires mid-flow, which is the
 * interesting case: the screen changes UNDER the automation, so a replay that
 * assumed its screen is still there must detect it rather than typing a member
 * id into a password field.
 */
const SEC001 = [
  '================================================================================',
  ' NORTHRIDGE CU               SIGN ON                              SCR SEC001    ',
  '================================================================================',
  '                                                                                ',
  '   SESSION HAS ENDED. PLEASE SIGN ON AGAIN.                                     ',
  '                                                                                ',
  '   USER  . . . . . . [          ]                                               ',
  '   PASSWORD  . . . . [          ]                                               ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  '                                                                                ',
  ' F3=Exit                                                                        ',
  ' MSG: SESSION EXPIRED                                                           ',
];

/**
 * Derive the character plane and the format table from a panel template.
 *
 * Returns the plane with markers replaced by blanks/underscores as a human would
 * see them, plus one FieldRecord per field. Field NAMES are assigned by scan
 * order per panel and are host-side only — the adapter must never use them to
 * resolve a target, and `tests/terminal-resolve.test.ts` asserts it doesn't.
 */
function scanTemplate(template: string[], fieldNames: string[]): { plane: string[]; fields: FieldRecord[] } {
  const plane: string[] = [];
  const fields: FieldRecord[] = [];
  let nameIdx = 0;

  for (let r = 0; r < ROWS; r++) {
    const raw = (template[r] ?? '').padEnd(COLS, ' ').slice(0, COLS);
    let line = '';
    let c = 0;
    while (c < COLS) {
      const ch = raw[c] as string;
      if (ch === '[') {
        // Unprotected field: everything up to the matching ']'.
        const close = raw.indexOf(']', c);
        const inner = close < 0 ? COLS - c - 1 : close - c - 1;
        const rec: FieldRecord = { row: r, col: c + 1, length: inner, protected: false };
        const nm = fieldNames[nameIdx++];
        if (nm !== undefined) rec.name = nm;
        fields.push(rec);
        // Brackets are panel decoration and stay visible, as on a real panel.
        line += '[' + ' '.repeat(inner) + ']';
        c = c + inner + 2;
      } else if (ch === '_') {
        // Protected display field: the run of underscores.
        let len = 0;
        while (c + len < COLS && raw[c + len] === '_') len++;
        const rec: FieldRecord = { row: r, col: c, length: len, protected: true };
        const nm = fieldNames[nameIdx++];
        if (nm !== undefined) rec.name = nm;
        fields.push(rec);
        line += ' '.repeat(len);
        c += len;
      } else {
        line += ch;
        c++;
      }
    }
    plane[r] = line;
  }
  return { plane, fields };
}

export type ScreenId = 'MBR001' | 'SEC001';

export interface HostState {
  screen: ScreenId;
  /** Contents of unprotected fields, keyed by "row:col". Block-mode local buffer. */
  input: Map<string, string>;
  /** Contents of protected display fields, keyed by host-side field name. */
  display: Map<string, string>;
  message: string;
  cursor: { row: number; col: number };
}

const MBR001_FIELDS = ['memberIdInput', 'nameOut', 'statusOut', 'acctOut', 'balanceOut'];
const SEC001_FIELDS = ['userInput', 'passwordInput'];

/**
 * Position of a host-side named field. The TEMPLATE owns field coordinates, so
 * the host's own business logic resolves them by name rather than restating
 * them — otherwise editing a panel silently breaks the logic behind it, which is
 * the exact class of drift this design is meant to eliminate.
 */
function fieldPos(screen: ScreenId, name: string): { row: number; col: number; length: number } {
  const f = fieldsFor(screen).find((x) => x.name === name);
  if (!f) throw new Error(`panel ${screen} has no field named '${name}'`);
  return { row: f.row, col: f.col, length: f.length };
}

/** Read an unprotected field's local buffer contents by host-side name. */
function readInput(state: HostState, name: string): string {
  const p = fieldPos(state.screen, name);
  return state.input.get(`${p.row}:${p.col}`) ?? '';
}

/** Cursor starts on the first unprotected field, as a panel does on display. */
function homeCursor(screen: ScreenId): { row: number; col: number } {
  const first = fieldsFor(screen).find((f) => !f.protected);
  return first ? { row: first.row, col: first.col } : { row: 0, col: 0 };
}

export function initialState(): HostState {
  return {
    screen: 'MBR001',
    input: new Map(),
    display: new Map(),
    message: '',
    cursor: homeCursor('MBR001'),
  };
}

/** Render current state into the two planes the protocol carries. */
export function render(state: HostState): ScreenBuffer {
  const isMbr = state.screen === 'MBR001';
  const { plane, fields } = scanTemplate(
    isMbr ? MBR001 : SEC001,
    isMbr ? MBR001_FIELDS : SEC001_FIELDS,
  );

  // Overlay field contents onto the character plane. Both input and display
  // values are written the same way, because on a character grid there IS no
  // other difference — only the field attribute distinguishes them.
  const write = (row: number, col: number, len: number, text: string) => {
    const line = plane[row] as string;
    const val = text.slice(0, len).padEnd(len, ' ');
    plane[row] = line.slice(0, col) + val + line.slice(col + len);
  };

  for (const f of fields) {
    if (!f.protected) {
      const v = state.input.get(`${f.row}:${f.col}`);
      if (v !== undefined) write(f.row, f.col, f.length, v);
    } else if (f.name !== undefined) {
      const v = state.display.get(f.name);
      if (v !== undefined) write(f.row, f.col, f.length, v);
    }
  }

  // Message subfile on line 24.
  const msgRow = ROWS - 1;
  const prefix = ' MSG: ';
  plane[msgRow] = (prefix + state.message).padEnd(COLS, ' ').slice(0, COLS);

  return {
    screenId: state.screen,
    rows: ROWS,
    cols: COLS,
    plane,
    fields,
    cursor: state.cursor,
    message: state.message,
  };
}

/** Field records for the current screen, without rendering values. */
export function fieldsFor(screen: ScreenId): FieldRecord[] {
  return scanTemplate(screen === 'MBR001' ? MBR001 : SEC001, screen === 'MBR001' ? MBR001_FIELDS : SEC001_FIELDS)
    .fields;
}

export interface AidResult {
  /** Host processing delay, so a slow response is observable as a slow response. */
  delayMs: number;
}

/**
 * Process an AID key — the only thing that changes host state, because this is
 * block mode. Everything typed before now sat in the local buffer.
 */
export function handleAid(state: HostState, key: string, opts: { expireNow?: boolean } = {}): AidResult {
  const K = key.toUpperCase();

  if (state.screen === 'SEC001') {
    // Signing on again returns to the inquiry panel, which is what makes the
    // human-handoff demo meaningful: an operator can recover the session.
    if (K === 'ENTER') {
      const user = readInput(state, 'userInput');
      if (user.trim().length > 0) {
        const fresh = initialState();
        state.screen = fresh.screen;
        state.input = fresh.input;
        state.display = fresh.display;
        state.cursor = fresh.cursor;
        state.message = 'SIGN ON COMPLETE';
        return { delayMs: 0 };
      }
      state.message = 'USER REQUIRED';
      return { delayMs: 0 };
    }
    return { delayMs: 0 };
  }

  // --- MBR001 ---------------------------------------------------------------
  if (K === 'F3' || K === 'F12') {
    const fresh = initialState();
    state.input = fresh.input;
    state.display = fresh.display;
    state.cursor = fresh.cursor;
    state.message = K === 'F3' ? 'EXIT REQUESTED' : 'CANCELLED';
    return { delayMs: 0 };
  }

  if (opts.expireNow) {
    state.screen = 'SEC001';
    state.input = new Map();
    state.display = new Map();
    state.message = 'SESSION EXPIRED';
    state.cursor = homeCursor('SEC001');
    return { delayMs: 0 };
  }

  if (K === 'F5' || K === 'ENTER') {
    const id = readInput(state, 'memberIdInput').trim();
    state.display.clear();

    if (id.length === 0) {
      state.message = 'MEMBER ID REQUIRED';
      return { delayMs: 0 };
    }

    const m = MEMBERS.find((x) => x.id === id);
    if (!m) {
      // A legitimate business answer, not a crash. The artifact declares it as
      // an OutcomeDetector keyed on this literal.
      state.message = 'MEMBER NOT FOUND';
      return { delayMs: 0 };
    }
    if (m.restricted) {
      state.message = 'NOT AUTHORIZED';
      return { delayMs: 0 };
    }

    state.display.set('nameOut', m.name);
    state.display.set('statusOut', m.status);
    state.display.set('acctOut', m.savingsAccount);
    state.display.set('balanceOut', m.balance);
    state.message = 'INQUIRY COMPLETE';
    return { delayMs: m.slowMs ?? 0 };
  }

  state.message = `KEY ${K} NOT ACTIVE`;
  return { delayMs: 0 };
}

/** Apply a local buffer edit. Rejects writes to protected fields outright. */
export function applyFill(state: HostState, row: number, col: number, text: string): string | null {
  const fields = fieldsFor(state.screen);
  const f = fields.find((x) => x.row === row && x.col === col);
  if (!f) return `NO FIELD AT ${row}:${col}`;
  if (f.protected) return `FIELD AT ${row}:${col} IS PROTECTED`;
  state.input.set(`${row}:${col}`, text.slice(0, f.length));
  state.cursor = { row, col };
  return null;
}
