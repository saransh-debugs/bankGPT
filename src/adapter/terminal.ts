/**
 * THE TERMINAL ADAPTER — the proof that the artifact schema is not web-shaped.
 *
 * It perceives an 80x24 character plane plus a format table of field attributes.
 * That is all. There is no DOM, no accessibility tree, no CSS, no event model,
 * no identifiers. Every ObservedElement it produces has `role: undefined` and
 * `name: undefined`, and `tests/terminal-resolve.test.ts` asserts that.
 *
 * If the SAME artifact — same anchors, same relations, same conditions, same
 * engine — resolves and replays here as it does on a browser, then anchor +
 * relation is genuinely surface-independent and `role` + accessible name is
 * genuinely an enrichment. That is the whole argument, and it is made by running
 * code rather than by an essay.
 *
 * WHAT PERCEPTION LOOKS LIKE HERE
 *
 * Two kinds of element come out of one grid:
 *
 *   TEXT RUNS   contiguous non-blank characters OUTSIDE any field. These are the
 *               captions — the anchors. "MEMBER ID . . . . :" is one of these.
 *   FIELDS      entries in the format table. Unprotected ones are writable (the
 *               operator types there); protected ones hold host-written values.
 *
 * `readingOrder` is `row * COLS + col` — a left-to-right, top-to-bottom scan.
 * That single number is what makes `next-writable` mean "the first field the
 * operator can type into, after this caption", which is exactly how a human
 * reads a green screen and exactly what the relation means on a DOM.
 *
 * TRANSPORT. The host runs as a child process and speaks the line protocol in
 * surfaces/terminal/protocol.ts over stdio pipes. Swapping that for a real
 * emulator — s3270's ReadBuffer(Ascii)/Enter()/PF(n) for a 3270 host, or
 * lib5250 / tn5250j's Screen5250 / IBM i ACS EHLLAPI for a 5250 host — replaces
 * everything below `observe()` and nothing above it. Not one field of the
 * artifact schema changes. That is the migration path, stated as a code
 * boundary rather than a promise.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  COLS,
  decodeScreen,
  encodeCommand,
  normaliseLiteral,
  type FieldRecord,
  type ScreenBuffer,
} from '../../surfaces/terminal/protocol.js';
import type {
  Evidence,
  ObservedElement,
  PolicyGate,
  ResolveContext,
  ResolveOutcome,
  ResolvedAction,
  Resolution,
  SessionHandle,
  SurfaceAdapter,
  SurfaceSnapshot,
} from './surface.js';
import { PolicyDenied } from './surface.js';
import type { Anchor, SurfaceKind, Target } from '../schema/target.js';
import { describeTarget } from '../schema/target.js';

/** Panel decoration that is not part of a caption's identity. */
const DECORATION = /^[\s._\-=|[\](){}:·]*$/;

export interface TerminalAdapterOptions {
  /** Command to launch the host. Defaults to the bundled Northridge CU host. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  gate?: PolicyGate;
  evidenceDir?: string;
  sessionId?: string;
  /** Applied to persisted evidence. Injected so the adapter owes nothing to a policy module. */
  redact?: (s: string) => string;
}

export class TerminalAdapter implements SurfaceAdapter {
  readonly kind: SurfaceKind = 'terminal';

  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = [];
  private lastScreen: ScreenBuffer | null = null;
  private readonly gate: PolicyGate | undefined;
  private readonly evidenceDir: string;
  private readonly sessionId: string;
  private readonly redact: (s: string) => string;
  /** Full protocol transcript. Committed as evidence; also the state-delta source. */
  private transcript: string[] = [];
  private leaseHeld = false;

  constructor(private readonly opts: TerminalAdapterOptions = {}) {
    this.gate = opts.gate;
    this.evidenceDir = opts.evidenceDir ?? 'evidence/scratch';
    this.sessionId = opts.sessionId ?? `term-${Math.random().toString(36).slice(2, 10)}`;
    this.redact = opts.redact ?? ((s) => s);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const command = this.opts.command ?? process.execPath;
    const args =
      this.opts.args ??
      [
        // Launch the host through tsx so the surface runs from source, keeping
        // this repo free of a build step for the demo path.
        join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(process.cwd(), 'surfaces', 'terminal', 'app.ts'),
      ];

    const proc = spawn(command, args, {
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.transcript.push(`# host stderr: ${chunk.trimEnd()}`);
    });
    proc.on('exit', (code) => {
      const err = new Error(`terminal host exited with code ${String(code)}`);
      for (const p of this.pending.splice(0)) p.reject(err);
    });

    // The host presents its opening panel unprompted.
    const first = await this.awaitMessage();
    this.lastScreen = decodeScreen(first);
  }

  /**
   * Accumulate stdout and dispatch complete messages. A message is either a
   * screen block terminated by `END`, or a single-line `ACK` / `ERR ...`.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const endIdx = this.buffer.indexOf('\nEND\n');
      const nl = this.buffer.indexOf('\n');

      if (endIdx >= 0 && (this.buffer.startsWith('SCREEN ') || this.buffer.trimStart().startsWith('SCREEN '))) {
        const msg = this.buffer.slice(0, endIdx + 1);
        this.buffer = this.buffer.slice(endIdx + 5);
        this.deliver(msg);
        continue;
      }
      if (nl >= 0 && !this.buffer.startsWith('SCREEN ')) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim().length > 0) this.deliver(line);
        continue;
      }
      break;
    }
  }

  private deliver(msg: string): void {
    this.transcript.push(`< ${msg.trimEnd().split('\n')[0] ?? ''}${msg.includes('\n') ? ' …' : ''}`);
    const p = this.pending.shift();
    if (p) p.resolve(msg);
  }

  private awaitMessage(timeoutMs = 15_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`terminal host did not reply within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.pending.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private async send(cmd: Parameters<typeof encodeCommand>[0], timeoutMs?: number): Promise<string> {
    if (!this.proc) throw new Error('terminal adapter not started');
    if (this.leaseHeld) {
      // Hard stop, not a convention: while an operator holds the lease the
      // adapter must emit ZERO actions. tests/lease.test.ts asserts this.
      throw new Error('operator holds the session lease; automation must not act');
    }
    const wire = encodeCommand(cmd);
    this.transcript.push(`> ${wire.trimEnd()}`);
    this.proc.stdin.write(wire);
    return this.awaitMessage(timeoutMs);
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  async observe(): Promise<SurfaceSnapshot> {
    const msg = await this.send({ kind: 'readbuffer' });
    const screen = decodeScreen(msg);
    this.lastScreen = screen;
    return this.project(screen);
  }

  /** Snapshot from the last screen the host sent, without re-reading. */
  private snapshotFromLast(): SurfaceSnapshot {
    if (!this.lastScreen) throw new Error('no screen observed yet');
    return this.project(this.lastScreen);
  }

  /**
   * Project a character grid into the flat element list the relation vocabulary
   * runs over. This function is the entire "perception" story for this surface.
   */
  private project(screen: ScreenBuffer): SurfaceSnapshot {
    const elements: ObservedElement[] = [];

    // Columns covered by a field, per row. Field contents are values, not
    // captions, so they must not also be harvested as anchor text.
    const masked: boolean[][] = Array.from({ length: screen.rows }, () =>
      Array.from({ length: screen.cols }, () => false),
    );
    for (const f of screen.fields) {
      for (let c = f.col; c < f.col + f.length && c < screen.cols; c++) {
        const row = masked[f.row];
        if (row) row[c] = true;
      }
    }

    // --- text runs (the captions / anchors) --------------------------------
    for (let r = 0; r < screen.rows; r++) {
      const line = screen.plane[r] ?? '';
      let c = 0;
      while (c < screen.cols) {
        const maskRow = masked[r];
        if ((maskRow && maskRow[c]) || (line[c] ?? ' ') === ' ') {
          c++;
          continue;
        }
        const start = c;
        let run = '';
        while (c < screen.cols && !(maskRow && maskRow[c]) && (line[c] ?? ' ') !== ' ') {
          run += line[c];
          c++;
        }
        // A caption may contain single spaces ("MEMBER ID", "SAVINGS ACCT"), so
        // extend across single blanks that are still followed by text on the
        // same row and outside a field. Dot leaders are handled by
        // normaliseLiteral, not here.
        while (
          c + 1 < screen.cols &&
          (line[c] ?? ' ') === ' ' &&
          (line[c + 1] ?? ' ') !== ' ' &&
          !(maskRow && maskRow[c + 1])
        ) {
          run += ' ';
          c++;
          while (c < screen.cols && !(maskRow && maskRow[c]) && (line[c] ?? ' ') !== ' ') {
            run += line[c];
            c++;
          }
        }

        if (DECORATION.test(run)) continue; // separator rules, stray brackets
        elements.push({
          id: `text:${r}:${start}`,
          text: run.trim(),
          writable: false,
          enabled: true,
          readingOrder: r * COLS + start,
          position: { row: r, col: start },
          regionPath: [screen.screenId],
          // role and name are intentionally absent. This is the point.
        });
      }
    }

    // --- fields (from the format table) -----------------------------------
    for (const f of screen.fields) {
      const line = screen.plane[f.row] ?? '';
      const raw = line.slice(f.col, f.col + f.length);
      elements.push({
        id: `field:${f.row}:${f.col}`,
        value: raw.trim(),
        // A protected field's contents read as its text, because on a grid
        // there is no distinction to draw.
        text: raw.trim(),
        writable: !f.protected,
        enabled: true,
        readingOrder: f.row * COLS + f.col,
        position: { row: f.row, col: f.col },
        regionPath: [screen.screenId],
      });
    }

    elements.sort((a, b) => a.readingOrder - b.readingOrder);

    return {
      surface: 'terminal',
      screenId: screen.screenId,
      elements,
      text: screen.plane.join('\n'),
      capturedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  async resolve(target: Target, ctx: ResolveContext): Promise<ResolveOutcome> {
    return this.resolveIn(target, ctx, ctx.snapshot.elements);
  }

  private resolveIn(target: Target, ctx: ResolveContext, pool: ObservedElement[]): ResolveOutcome {
    // A `scope` narrows the pool first, so repeated literals can be
    // disambiguated by the region they sit in rather than by position.
    let scoped = pool;
    if (target.scope) {
      const outer = this.resolveIn(target.scope, ctx, pool);
      if (!outer.ok) return outer;
      const anchorOrder = outer.resolution.element.readingOrder;
      scoped = pool.filter((e) => e.readingOrder >= anchorOrder);
    }

    const wanted = this.anchorLiteral(target.anchor, ctx);
    if (wanted === null) {
      return {
        ok: false,
        reason: 'anchor-unresolved',
        detail: `param anchor '${describeTarget(target)}' has no runtime value`,
        candidates: 0,
      };
    }

    const norm = normaliseLiteral(wanted);
    const anchors = scoped.filter((e) => e.text !== undefined && normaliseLiteral(e.text) === norm);

    if (anchors.length === 0) {
      return {
        ok: false,
        reason: 'anchor-unresolved',
        detail: `no element on ${ctx.snapshot.screenId} reads "${wanted}" (normalised "${norm}")`,
        candidates: 0,
      };
    }
    if (anchors.length > 1) {
      // HALT. Never pick the first. Two panels sharing a literal is exactly the
      // case where guessing writes to the wrong record.
      return {
        ok: false,
        reason: 'anchor-ambiguous',
        detail:
          `"${wanted}" matches ${anchors.length} elements on ${ctx.snapshot.screenId} at ` +
          anchors.map((a) => `${a.position.row}:${a.position.col}`).join(', ') +
          `. Add a scope to disambiguate.`,
        candidates: anchors.length,
      };
    }

    const anchor = anchors[0] as ObservedElement;
    const after = scoped.filter((e) => e.readingOrder > anchor.readingOrder);
    const sameRow = scoped.filter(
      (e) => e.position.row === anchor.position.row && e.readingOrder > anchor.readingOrder,
    );

    const found = ((): ObservedElement | undefined => {
      switch (target.relation) {
        case 'is':
          return anchor;
        case 'next-writable':
          // THE relation that needs the writability predicate. On this surface
          // it means "the next unprotected field", which is what a 5250
          // operator's eye and hand both do.
          return after.find((e) => e.writable);
        case 'next-value':
          return after.find((e) => !e.writable && e.value !== undefined && e.value.length > 0)
            ?? after.find((e) => !e.writable && e.value !== undefined);
        case 'same-row':
          return target.index === undefined ? sameRow[0] : sameRow[target.index];
        case 'under-column': {
          const col = anchor.position.col ?? 0;
          return scoped.find(
            (e) =>
              (e.position.row ?? -1) > (anchor.position.row ?? -1) &&
              Math.abs((e.position.col ?? -1) - col) <= 1,
          );
        }
        case 'within': {
          const region = anchor.regionPath?.at(-1);
          return after.find((e) => e.regionPath?.at(-1) === region);
        }
        case 'nth-in-region':
          return after[target.index ?? 0];
      }
    })();

    if (!found) {
      return {
        ok: false,
        reason: 'anchor-unresolved',
        detail:
          `found anchor "${wanted}" at ${anchor.position.row}:${anchor.position.col} but no ` +
          `'${target.relation}' element follows it on ${ctx.snapshot.screenId}`,
        candidates: 0,
      };
    }

    const resolution: Resolution = {
      element: found,
      strategy: 'grid-scan',
      candidates: 1,
      confidence: target.relation === 'nth-in-region' ? 0.6 : 1,
    };
    return { ok: true, resolution };
  }

  /** The literal to match, after per-tenant lexicon translation. */
  private anchorLiteral(anchor: Anchor, ctx: ResolveContext): string | null {
    if (anchor.kind === 'param') {
      const v = ctx.inputs[anchor.name];
      return v === undefined ? null : v;
    }
    const base = anchor.text;
    const translated = ctx.lexicon?.[base];
    if (translated !== undefined && translated !== base) {
      ctx.onFallback?.('grid-scan', `lexicon: "${base}" -> "${translated}"`);
      return translated;
    }
    return base;
  }

  // -------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------

  async act(action: ResolvedAction): Promise<void> {
    // POLICY FIRST, always, before the surface is touched.
    const screenId = this.lastScreen?.screenId ?? 'unknown';
    const denial = this.gate?.check(action, { surface: 'terminal', screenId });
    if (denial) throw new PolicyDenied(action.kind, denial);

    switch (action.kind) {
      case 'fill': {
        const { row, col } = action.element.position;
        if (row === undefined || col === undefined) {
          throw new Error('cannot fill an element without grid coordinates');
        }
        const reply = await this.send({ kind: 'fill', row, col, text: action.value });
        if (reply.startsWith('ERR')) throw new Error(`host refused fill: ${reply.trim()}`);
        return;
      }
      case 'press': {
        // On a block-mode surface this is the ONLY action that transmits.
        const msg = await this.send({ kind: 'aid', key: action.key }, 30_000);
        this.lastScreen = decodeScreen(msg);
        return;
      }
      case 'click': {
        // A character grid has no pointer. Clicking a control means putting the
        // cursor on it; committing still requires an AID key. Modelling this
        // honestly is part of the point — the artifact for this surface uses
        // `press`, and a capability that assumed click-to-submit would fail
        // here loudly rather than silently doing nothing.
        const { row, col } = action.element.position;
        if (row === undefined || col === undefined) throw new Error('click needs coordinates');
        const reply = await this.send({ kind: 'fill', row, col, text: action.element.value ?? '' });
        if (reply.startsWith('ERR')) throw new Error(`host refused cursor move: ${reply.trim()}`);
        return;
      }
      case 'select':
        throw new Error("action 'select' has no meaning on a character grid; use fill + press");
      case 'navigate':
        throw new Error("action 'navigate' has no meaning on a character grid; use press with an AID key");
      case 'wait':
        await new Promise((r) => setTimeout(r, action.ms));
        return;
    }
  }

  /**
   * Block mode makes this simple and honest: the host replies to an AID key only
   * when it has finished, so by the time `act({press})` resolves the surface has
   * settled. There is no equivalent of a background XHR to race.
   */
  async settle(_timeoutMs: number): Promise<boolean> {
    return true;
  }

  // -------------------------------------------------------------------------
  // Evidence and session control
  // -------------------------------------------------------------------------

  async evidence(label: string): Promise<Evidence> {
    const safe = label.replace(/[^a-z0-9._-]/gi, '_');
    const planePath = join(this.evidenceDir, `${safe}.screen.txt`);
    const transcriptPath = join(this.evidenceDir, `${safe}.protocol.txt`);
    await mkdir(dirname(planePath), { recursive: true });

    const plane = this.lastScreen
      ? this.lastScreen.plane.join('\n')
      : '<no screen observed>';
    // A character-plane dump is BETTER evidence than a screenshot here: it is
    // text, so two states diff, which is what makes a state delta after a human
    // takeover a literal diff rather than an eyeball comparison of two images.
    await writeFile(planePath, this.redact(plane) + '\n', 'utf8');
    await writeFile(transcriptPath, this.redact(this.transcript.join('\n')) + '\n', 'utf8');
    return { primaryPath: planePath, extraPaths: [transcriptPath] };
  }

  /**
   * Cede control WITHOUT tearing anything down. The host process, its format
   * table and its local input buffer all stay exactly as they are; the operator
   * console then drives the same stdio channel. This is what "the human
   * operates the same live session" means concretely.
   */
  async pause(): Promise<SessionHandle> {
    const snapshotText = this.lastScreen?.plane.join('\n') ?? '';
    this.leaseHeld = true;
    // Redacted here too: the handle's snapshot is what an operator is shown in
    // an intervention request, and that request is written to disk.
    return {
      sessionId: this.sessionId,
      pausedAt: new Date().toISOString(),
      snapshotText: this.redact(snapshotText),
    };
  }

  async resume(handle: SessionHandle): Promise<void> {
    if (handle.sessionId !== this.sessionId) {
      throw new Error(
        `refusing to resume: handle is for session ${handle.sessionId}, this is ${this.sessionId}`,
      );
    }
    this.leaseHeld = false;
    // Re-observe. The engine revalidates the checkpoint before continuing; it
    // never resumes blind.
    await this.observe();
  }

  /** Raw stdio channel, for the operator console to drive during a handoff. */
  operatorChannel(): { write: (line: string) => void; screen: () => ScreenBuffer | null } {
    return {
      write: (line: string) => {
        if (!this.proc) throw new Error('adapter not started');
        this.transcript.push(`>[operator] ${line.trim()}`);
        this.proc.stdin.write(line.endsWith('\n') ? line : line + '\n');
      },
      screen: () => this.lastScreen,
    };
  }

  /** Protocol transcript, for the state-delta record. */
  transcriptLines(): string[] {
    return [...this.transcript];
  }

  currentFields(): FieldRecord[] {
    return this.lastScreen?.fields ?? [];
  }

  async close(): Promise<void> {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
  }
}
