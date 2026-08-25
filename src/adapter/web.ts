/**
 * THE WEB ADAPTER — the other half of the proof.
 *
 * The terminal adapter shows that the artifact schema does not need a DOM. This
 * one shows the converse: that the schema is not secretly terminal-shaped
 * either. The SAME capability id, the same anchors, the same relations, the same
 * conditions and the same replay engine run here, against a real Angular
 * application, with a different perception layer underneath.
 *
 * This is the ONLY file in the repository permitted to import Playwright, and
 * that rule is worth stating plainly because it is checkable: `grep -rl
 * playwright src/ surfaces/` should return this path and nothing else. Above the
 * SurfaceAdapter seam a capability is a list of anchored targets; if any of that
 * leaked into the artifact, the artifact would stop being portable.
 *
 * WHY THIS SURFACE IS A FAIR TEST
 *
 * The Mifos web app is not a friendly automation target, and that is the point.
 * The values a capability has to read are laid out like this:
 *
 *     <b>Total Savings</b> ... <span>4,250.00</span>
 *     <b>Account No.</b>  ... <span>000000001</span>
 *
 * No `for`, no `aria-label`, no `role`, no test id. A locator model built on
 * `role` + accessible name has nothing to bind to here — you cannot ask for
 * "the textbox named Total Savings" because there is no textbox and there is no
 * name. What there IS, on this surface exactly as on a 5250 panel, is a visible
 * literal and a control sitting in a known relation to it. `label` +
 * `next-value` resolves the balance on both.
 *
 * PERCEPTION: the universal spine
 *
 *   readingOrder   a monotonic counter in document order. The terminal derives
 *                  the same number from `row * COLS + col`. Both are "the order
 *                  a human reads this", which is all the relation vocabulary
 *                  needs — it never asks how the number was produced.
 *   writable       editable, enabled and not read-only. The terminal's
 *                  equivalent is the UNPROTECTED field attribute.
 *   position.row   for elements inside a table, the row/cell INDEX rather than
 *   position.col   pixels. That is what makes `same-row` and `under-column`
 *                  mean the same thing on a `<table>` and on a character grid,
 *                  and it is why those two relations share one implementation
 *                  shape across the adapters instead of being special-cased.
 *
 * HANDLES. `observe()` stamps each projected element with a `data-cua-id`
 * attribute and returns that as `ObservedElement.id`. Element handles go stale
 * across navigations and re-renders; an attribute survives them and is
 * re-derivable. As on the terminal, the id is adapter-local and meaningless
 * across snapshots — it is never written into an artifact.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  Evidence,
  ObservedElement,
  PolicyGate,
  ResolveContext,
  ResolveOutcome,
  ResolveStrategy,
  ResolvedAction,
  Resolution,
  SessionHandle,
  SurfaceAdapter,
  SurfaceSnapshot,
} from './surface.js';
import { PolicyDenied } from './surface.js';
import { normaliseLiteral } from './literal.js';
import type { Anchor, SurfaceKind, Target } from '../schema/target.js';
import { describeTarget } from '../schema/target.js';

/** Attribute used to carry an adapter-local handle across the evaluate boundary. */
const HANDLE_ATTR = 'data-cua-id';

export interface WebAdapterOptions {
  baseUrl?: string;
  /** Headed is the demo mode: a human takes over the SAME window during a handoff. */
  headed?: boolean;
  gate?: PolicyGate;
  evidenceDir?: string;
  sessionId?: string;
  /** Applied to persisted evidence. Injected so the adapter owes nothing to a policy module. */
  redact?: (s: string) => string;
  defaultTimeoutMs?: number;
}

/**
 * Everything the projection captures that ObservedElement does not carry.
 * Kept beside the snapshot rather than widened into the shared type, because
 * these are resolution mechanics for THIS surface — nothing above the seam
 * should be able to depend on them.
 */
interface WebExtras {
  /** Which rung would be entitled to claim a direct hit on this element. */
  nameSource?: ObservedElement['nameSource'];
  /** data-cua-id of the nearest ancestor row, when inside a table-like structure. */
  rowId?: string;
  /** Ancestor data-cua-ids, outermost first. Makes `scope` mean containment. */
  ancestors: string[];
  /** A CSS selector, only ever produced for adapter-hint resolution. */
  tag: string;
}

export class WebAdapter implements SurfaceAdapter {
  readonly kind: SurfaceKind = 'web';

  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly gate: PolicyGate | undefined;
  private readonly evidenceDir: string;
  private readonly sessionId: string;
  private readonly redact: (s: string) => string;
  private readonly defaultTimeoutMs: number;
  private leaseHeld = false;
  /** Keyed by ObservedElement.id, rebuilt on every observe(). */
  private extras = new Map<string, WebExtras>();
  /** Structured trail of what the adapter did. Committed as evidence. */
  private transcript: string[] = [];

  constructor(private readonly opts: WebAdapterOptions = {}) {
    this.gate = opts.gate;
    this.evidenceDir = opts.evidenceDir ?? 'evidence/scratch';
    this.sessionId = opts.sessionId ?? `web-${Math.random().toString(36).slice(2, 10)}`;
    this.redact = opts.redact ?? ((s) => s);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.opts.headed !== true });
    // ignoreHTTPSErrors is scoped to this context, exactly as scripts/seed.ts
    // scopes its https.Agent: the Fineract instance serves a self-signed
    // certificate on 8443 and the app's XHRs go there, but nothing else in the
    // process loses certificate validation.
    this.ctx = await this.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
    });
    this.ctx.setDefaultTimeout(this.defaultTimeoutMs);

    // BUILD-TOOL SHIM, not a product concern. `projectPage` is serialised with
    // Function.prototype.toString and re-evaluated inside the browser, but the
    // TypeScript runners this repo uses (tsx, vitest) both compile through
    // esbuild with `keepNames`, which rewrites named functions to reference a
    // `__name` helper that only exists in the Node bundle. The helper is a
    // no-op identity function, so defining it in the page restores the
    // function's own semantics exactly. Without this, observe() throws
    // "__name is not defined" — and only when run through a transpiler, which
    // makes it the kind of failure that looks like a page bug and is not one.
    await this.ctx.addInitScript(() => {
      const g = globalThis as unknown as { __name?: unknown };
      if (typeof g.__name !== 'function') g.__name = <T>(fn: T): T => fn;
    });

    this.page = await this.ctx.newPage();
    this.transcript.push(`# session ${this.sessionId} started`);
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('web adapter not started');
    if (this.leaseHeld) {
      // Hard stop, not a convention: while an operator holds the lease the
      // adapter must emit ZERO actions. tests/lease.test.ts asserts this for
      // both adapters.
      throw new Error('operator holds the session lease; automation must not act');
    }
    return this.page;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  async observe(): Promise<SurfaceSnapshot> {
    const page = this.requirePage();

    const projected = await page.evaluate(projectPage, HANDLE_ATTR);

    this.extras = new Map(projected.elements.map((e) => [e.element.id, e.extras]));
    const elements: ObservedElement[] = projected.elements.map((e) => e.element);

    this.transcript.push(`< observe ${projected.screenId} (${elements.length} elements)`);

    return {
      surface: 'web',
      screenId: projected.screenId,
      elements,
      text: projected.text,
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
    // A `scope` narrows the pool first. On this surface containment is real —
    // the projection records ancestry — so a scope means "inside this region"
    // rather than the terminal's weaker "after this literal in reading order".
    // The artifact does not change; the guarantee under it is simply stronger
    // where the surface can offer more.
    let scoped = pool;
    if (target.scope) {
      const outer = this.resolveIn(target.scope, ctx, pool);
      if (!outer.ok) return outer;
      const scopeId = outer.resolution.element.id;
      scoped = pool.filter((e) => this.extras.get(e.id)?.ancestors.includes(scopeId) === true);
      if (scoped.length === 0) {
        return {
          ok: false,
          reason: 'anchor-unresolved',
          detail: `scope '${describeTarget(target.scope)}' resolved but contains no elements`,
          candidates: 0,
        };
      }
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

    // --- the ladder ---------------------------------------------------------
    // Rungs are tried most-specific first, and the rung that fired is recorded
    // on the Resolution so a strategy downgrade between runs is visible as
    // drift.
    //
    // Note what is NOT treated as degradation. `text-then-reading-order` is the
    // PRIMARY mechanism of this system, not a fallback — it is the same
    // algorithm the terminal adapter runs over its character grid, and on a
    // page whose values carry no label, role or id it is the only thing that
    // can resolve them at all. Reporting it as a fallback would mark every
    // honest run "degraded" and leave the word meaning nothing. Degradation is
    // reserved for resolutions that genuinely cost something: a per-surface
    // adapter hint, a positional `nth-in-region`, a recovery firing, a human
    // being pulled in.
    for (const rung of LADDER) {
      const outcome = rung.run({
        adapter: this,
        target,
        ctx,
        scoped,
        wanted,
        norm,
      });
      if (outcome === null) continue; // rung not applicable to this target
      if (!outcome.ok) return outcome; // ambiguity halts; it does not fall through
      return outcome;
    }

    const rowish = target.relation === 'same-row' || target.relation === 'under-column';
    const declaresRows = scoped.some((e) => e.position.row !== undefined);
    return {
      ok: false,
      reason: 'anchor-unresolved',
      detail:
        `no element on ${ctx.snapshot.screenId} reads "${wanted}" (normalised "${norm}") ` +
        `with a '${target.relation}' relation available` +
        (rowish && !declaresRows
          ? `. This surface declares no row structure (no <tr>, role="row" or mat-row), so ` +
            `'${target.relation}' has nothing to resolve against; anchor on a literal the ` +
            `page does assert rather than inferring rows from layout.`
          : ''),
      candidates: 0,
    };
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
      ctx.onFallback?.('text-then-reading-order', `lexicon: "${base}" -> "${translated}"`);
      return translated;
    }
    return base;
  }

  /**
   * Apply a relation from a resolved anchor. Deliberately the same shape as
   * TerminalAdapter's — one relation vocabulary, two perception layers. If this
   * ever needs a web-only relation, the vocabulary is wrong, not this function.
   */
  private applyRelation(
    target: Target,
    anchor: ObservedElement,
    scoped: ObservedElement[],
  ): { element: ObservedElement; strategy: ResolveStrategy } | undefined {
    const after = scoped.filter((e) => e.readingOrder > anchor.readingOrder);
    const anchorRow = anchor.position.row;
    const sameRow =
      anchorRow === undefined
        ? []
        : scoped.filter((e) => e.position.row === anchorRow && e.readingOrder > anchor.readingOrder);

    switch (target.relation) {
      case 'is':
        return { element: anchor, strategy: 'text-then-reading-order' };
      case 'next-writable': {
        const el = after.find((e) => e.writable);
        return el && { element: el, strategy: 'text-then-reading-order' };
      }
      case 'next-value': {
        // A readable display value: not writable, has text, and is not itself
        // another caption. On this surface the value is a sibling <span> after
        // a <b> caption; on a grid it is the next PROTECTED field.
        const el =
          after.find((e) => !e.writable && (e.value ?? e.text ?? '').trim().length > 0) ??
          after.find((e) => !e.writable && e.text !== undefined);
        return el && { element: el, strategy: 'text-then-reading-order' };
      }
      // `same-row` and `under-column` require the surface to declare row and
      // cell structure — <tr>/<td>, role=row/cell, or Material's mat-row. When
      // it does, position.row/col carry the same meaning they carry on the
      // character grid and these resolve identically on both surfaces.
      //
      // When it does NOT — and the Mifos client list is exactly that case, a
      // stack of <div class="list-row"> with no table, no ARIA and no test ids
      // — this returns undefined and the run halts. That is deliberate. The
      // available alternative is to infer rows by banding y-coordinates, which
      // reads a sticky header or a wrapped cell as a row of its own and would
      // silently return a neighbouring member's value. On this surface a wrong
      // row is a wrong account, so not-resolving is the correct outcome and an
      // artifact for such a list must anchor on something the page does assert
      // — the member's own account number is one, and is what the web
      // capability uses.
      case 'same-row': {
        const el = target.index === undefined ? sameRow[0] : sameRow[target.index];
        // Reported as table-cell because it used real row geometry, not the
        // reading-order fallback — the ladder rung and the relation agree.
        return el && { element: el, strategy: 'table-cell' };
      }
      case 'under-column': {
        const col = anchor.position.col;
        if (col === undefined) return undefined;
        const el = scoped.find(
          (e) =>
            e.position.col === col &&
            (e.position.row ?? -1) > (anchor.position.row ?? -1) &&
            e.readingOrder > anchor.readingOrder,
        );
        return el && { element: el, strategy: 'table-cell' };
      }
      case 'within': {
        const el = scoped.find(
          (e) =>
            e.readingOrder > anchor.readingOrder &&
            this.extras.get(e.id)?.ancestors.includes(anchor.id) === true,
        );
        return el && { element: el, strategy: 'text-then-reading-order' };
      }
      case 'nth-in-region': {
        const el = after[target.index ?? 0];
        return el && { element: el, strategy: 'text-then-reading-order' };
      }
    }
  }

  /** Shared by every rung: one match resolves, several halt, none falls through. */
  private decide(
    candidates: ObservedElement[],
    target: Target,
    ctx: ResolveContext,
    wanted: string,
    strategy: ResolveStrategy,
    confidence: number,
    applyRelation: boolean,
  ): ResolveOutcome | null {
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      // HALT. Never pick the first. Two rows sharing the literal "Balance" is
      // exactly the case where guessing reads the wrong member's money.
      return {
        ok: false,
        reason: 'anchor-ambiguous',
        detail:
          `"${wanted}" matches ${candidates.length} elements on ${ctx.snapshot.screenId} via ${strategy} ` +
          `(${candidates.slice(0, 5).map((c) => c.id).join(', ')}). Add a scope to disambiguate.`,
        candidates: candidates.length,
      };
    }

    const anchor = candidates[0] as ObservedElement;
    if (!applyRelation) {
      return { ok: true, resolution: { element: anchor, strategy, candidates: 1, confidence } };
    }

    const found = this.applyRelation(target, anchor, ctx.snapshot.elements);
    if (!found) return null;
    const resolution: Resolution = {
      element: found.element,
      strategy: found.strategy === 'table-cell' ? 'table-cell' : strategy,
      candidates: 1,
      confidence: target.relation === 'nth-in-region' ? Math.min(confidence, 0.6) : confidence,
    };
    return { ok: true, resolution };
  }

  // Rungs need controlled access to the private helpers above.
  /** @internal */ _decide = this.decide.bind(this);
  /** @internal */ _extras = (id: string): WebExtras | undefined => this.extras.get(id);

  // -------------------------------------------------------------------------
  // Action
  // -------------------------------------------------------------------------

  async act(action: ResolvedAction): Promise<void> {
    // POLICY FIRST, always, before the surface is touched.
    const screenId = this.page ? screenIdOf(this.page.url()) : 'unknown';
    const denial = this.gate?.check(action, { surface: 'web', screenId });
    if (denial) throw new PolicyDenied(action.kind, denial);

    const page = this.requirePage();

    switch (action.kind) {
      case 'fill': {
        const locator = this.locate(action.element);
        this.transcript.push(
          `> fill ${action.element.id} = ${action.redact === true ? '<redacted>' : action.value}`,
        );
        await locator.fill(action.value, { timeout: this.defaultTimeoutMs });
        return;
      }
      case 'click': {
        const locator = this.locate(action.element);
        this.transcript.push(`> click ${action.element.id}`);
        await locator.click({ timeout: this.defaultTimeoutMs });
        return;
      }
      case 'select': {
        const locator = this.locate(action.element);
        this.transcript.push(`> select ${action.element.id} = ${action.value}`);
        await locator.selectOption({ label: action.value }, { timeout: this.defaultTimeoutMs });
        return;
      }
      case 'press': {
        this.transcript.push(`> press ${action.key}`);
        await page.keyboard.press(action.key);
        return;
      }
      case 'navigate': {
        this.transcript.push(`> navigate ${action.url}`);
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        return;
      }
      case 'wait':
        await page.waitForTimeout(action.ms);
        return;
    }
  }

  /**
   * An element resolved in a PREVIOUS snapshot may have been re-rendered by
   * Angular since. The handle attribute is re-stamped on every observe(), so a
   * missing one means the page moved on — and failing loudly there is correct:
   * silently re-resolving would let a step act on a control the engine never
   * checked its precondition against.
   */
  private locate(element: ObservedElement) {
    const page = this.requirePage();
    return page.locator(`[${HANDLE_ATTR}="${element.id}"]`).first();
  }

  /**
   * Unlike block mode, a browser can be mid-XHR with a stale DOM on screen.
   * Angular in particular renders a value only after its HTTP call resolves, so
   * a checkpoint asserted too early reads the previous member's data — the
   * exact class of bug that makes replay look flaky and is actually a missing
   * wait.
   */
  async settle(timeoutMs: number): Promise<boolean> {
    const page = this.requirePage();
    const deadline = Date.now() + timeoutMs;
    let clean = true;

    // Network idle is necessary and NOT sufficient. A single-page app resolves
    // its HTTP call, then routes, then renders — so the moment the network goes
    // quiet the DOM can still be the previous screen. Checkpointing there reads
    // the old page and reports a checkpoint failure that is really a missing
    // wait, which is the single most common way replay gets branded "flaky".
    try {
      await page.waitForLoadState('networkidle', { timeout: Math.max(0, deadline - Date.now()) });
    } catch {
      // Some pages poll forever and never reach network idle. That is
      // information, not a failure — fall through to the DOM check.
      clean = false;
    }

    // Then wait for the DOM itself to stop changing. Quiescence is the surface's
    // own statement that it has finished rendering, and unlike a fixed sleep it
    // costs nothing when the page was already still.
    //
    // Two things make this harder than "wait for mutations to stop", and both
    // were found by watching this fail rather than by reasoning about it:
    //
    //   THE PRE-TRANSITION RACE. A router navigation does not begin in the same
    //   tick as the click that caused it. Attach an observer immediately and the
    //   page is briefly, genuinely still — so a naive quiet window expires
    //   before the app has done anything, and settle() reports "settled" while
    //   the OLD screen is on display. Downstream that produced a checkpoint
    //   which resolved "Account No." against the client LIST's column header
    //   instead of the detail page's field, and read the neighbouring column.
    //   A grace period fixes it: the quiet window cannot start until the app
    //   has had a chance to react.
    //
    //   THE URL IS ALSO STATE. In a hash-routed SPA the route can change with
    //   only a handful of DOM mutations. Treating an href change as a mutation
    //   keeps a navigation from slipping through a quiet window.
    try {
      const remaining = Math.max(0, deadline - Date.now());
      const quiet = await page.evaluate(
        ([quietMs, graceMs, budgetMs]: [number, number, number]) =>
          new Promise<boolean>((resolve) => {
            const started = Date.now();
            let href = location.href;
            let timer: ReturnType<typeof setTimeout> | undefined;

            const finish = (value: boolean): void => {
              observer.disconnect();
              clearInterval(poll);
              clearTimeout(budget);
              if (timer) clearTimeout(timer);
              resolve(value);
            };
            // Never conclude "settled" before the grace period: the elapsed
            // check is what stops a not-yet-started transition from counting.
            const armQuiet = (): void => {
              if (timer) clearTimeout(timer);
              const wait = Math.max(quietMs, started + graceMs - Date.now());
              timer = setTimeout(() => finish(true), wait);
            };

            const observer = new MutationObserver(armQuiet);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
            });
            const poll = setInterval(() => {
              if (location.href !== href) {
                href = location.href;
                armQuiet();
              }
            }, 50);
            const budget = setTimeout(() => finish(false), budgetMs);

            armQuiet();
          }),
        [400, 700, Math.min(remaining, 8_000)] as [number, number, number],
      );
      return clean && quiet;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Evidence and session control
  // -------------------------------------------------------------------------

  async evidence(label: string): Promise<Evidence> {
    const safe = label.replace(/[^a-z0-9._-]/gi, '_');
    const shotPath = join(this.evidenceDir, `${safe}.png`);
    const textPath = join(this.evidenceDir, `${safe}.page.txt`);
    const tracePath = join(this.evidenceDir, `${safe}.actions.txt`);
    await mkdir(dirname(shotPath), { recursive: true });

    // Screenshots are the richer signal the brief asks for on failure; the text
    // dump is the one that DIFFS, which is what makes a state delta after a
    // human takeover a literal diff rather than two images to eyeball.
    if (this.page && !this.leaseHeld) {
      await this.page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
      const text = await this.page.innerText('body').catch(() => '<unavailable>');
      await writeFile(textPath, this.redact(text) + '\n', 'utf8');
    } else {
      await writeFile(textPath, '<no page>\n', 'utf8');
    }
    await writeFile(tracePath, this.redact(this.transcript.join('\n')) + '\n', 'utf8');

    return { primaryPath: shotPath, extraPaths: [textPath, tracePath] };
  }

  /**
   * Cede control WITHOUT tearing anything down. Same browser, same context,
   * same page, same cookies, same in-flight session token. This is what "the
   * human operates the same live session" means concretely — a fresh window
   * would be a different session with a different login, and the requirement
   * would be met only in the README.
   */
  async pause(): Promise<SessionHandle> {
    const snapshotText = this.page ? await this.page.innerText('body').catch(() => '') : '';
    this.leaseHeld = true;
    this.transcript.push(`# lease taken by operator`);
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
    this.transcript.push(`# lease released`);
    // Re-observe. The engine revalidates the checkpoint before continuing; it
    // never resumes blind.
    await this.observe();
  }

  /** Action trail, for the state-delta record. */
  transcriptLines(): string[] {
    return [...this.transcript];
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.ctx = null;
    this.page = null;
  }
}

// ---------------------------------------------------------------------------
// The resolution ladder
// ---------------------------------------------------------------------------

interface RungInput {
  adapter: WebAdapter;
  target: Target;
  ctx: ResolveContext;
  scoped: ObservedElement[];
  wanted: string;
  norm: string;
}

interface Rung {
  strategy: ResolveStrategy;
  /** null = this rung has nothing to say about this target; try the next one. */
  run(i: RungInput): ResolveOutcome | null;
}

/** Which name sources count as an authored association rather than a guess. */
const EXPLICIT: ReadonlyArray<ObservedElement['nameSource']> = ['label-for', 'label-wrap', 'field-label'];

const LADDER: Rung[] = [
  {
    // Strongest rung: the author explicitly tied this label to this control.
    // Resolves DIRECTLY to the control — no relation walk — because the
    // association already answers the question the relation would have asked.
    strategy: 'label-association',
    run: ({ adapter, target, ctx, scoped, wanted, norm }) => {
      if (target.relation !== 'next-writable' && target.relation !== 'next-value') return null;
      const hits = scoped.filter(
        (e) =>
          e.name !== undefined &&
          normaliseLiteral(e.name) === norm &&
          EXPLICIT.includes(e.nameSource) &&
          (target.relation === 'next-writable' ? e.writable : true),
      );
      return adapter._decide(hits, target, ctx, wanted, 'label-association', 1, false);
    },
  },
  {
    strategy: 'aria-labelledby',
    run: ({ adapter, target, ctx, scoped, wanted, norm }) => {
      if (target.relation !== 'next-writable' && target.relation !== 'next-value') return null;
      const hits = scoped.filter(
        (e) =>
          e.name !== undefined &&
          normaliseLiteral(e.name) === norm &&
          e.nameSource === 'aria-labelledby' &&
          (target.relation === 'next-writable' ? e.writable : true),
      );
      return adapter._decide(hits, target, ctx, wanted, 'aria-labelledby', 1, false);
    },
  },
  {
    // For `is` on a control that carries its own name — a button, a link, a tab.
    strategy: 'accessible-name',
    run: ({ adapter, target, ctx, scoped, wanted, norm }) => {
      if (target.relation !== 'is') return null;
      const hits = scoped.filter(
        (e) => e.name !== undefined && normaliseLiteral(e.name) === norm && e.nameSource !== 'text',
      );
      return adapter._decide(hits, target, ctx, wanted, 'accessible-name', 1, false);
    },
  },
  {
    // THE UNIVERSAL RUNG. Find the literal as visible text, then walk the
    // relation over readingOrder. This is the same algorithm the terminal runs
    // over its grid, and it is the one that resolves `Total Savings` ->
    // `4,250.00` on a page where nothing else would.
    strategy: 'text-then-reading-order',
    run: ({ adapter, target, ctx, scoped, wanted, norm }) => {
      const hits = scoped.filter(
        (e) => e.text !== undefined && normaliseLiteral(e.text) === norm,
      );
      return adapter._decide(hits, target, ctx, wanted, 'text-then-reading-order', 1, true);
    },
  },
  {
    // Last resort before giving up: a documented per-surface escape hatch.
    // Using one is recorded as a portability warning rather than passed
    // silently, because an artifact that needs it is no longer surface-neutral
    // and a reviewer should be able to see that from the run.
    strategy: 'adapter-hint',
    run: ({ adapter, target, ctx, scoped, wanted }) => {
      const hint = target.adapterHints?.['web'];
      if (typeof hint !== 'string') return null;
      ctx.onFallback?.('adapter-hint', `web adapterHint '${hint}' used for ${describeTarget(target)}`);
      const hits = scoped.filter((e) => adapter._extras(e.id)?.tag === hint);
      return adapter._decide(hits, target, ctx, wanted, 'adapter-hint', 0.5, false);
    },
  },
];

// ---------------------------------------------------------------------------
// In-page projection
// ---------------------------------------------------------------------------

/** Route identity, used for logs, evidence and checkpoint messages. */
function screenIdOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.hash || u.pathname).replace(/^#/, '') || '/';
  } catch {
    return url;
  }
}

interface ProjectedElement {
  element: ObservedElement;
  extras: WebExtras;
}

interface Projection {
  screenId: string;
  text: string;
  elements: ProjectedElement[];
}

/**
 * Runs INSIDE THE BROWSER. Everything it needs must be self-contained — it is
 * serialised across the evaluate boundary, so it cannot close over anything in
 * this module.
 */
function projectPage(handleAttr: string): Projection {
  const out: ProjectedElement[] = [];
  let order = 0;
  let handle = 0;

  const ACTIONABLE_TAGS = new Set(['button', 'a', 'summary', 'option']);
  const ACTIONABLE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'checkbox']);
  const ROW_SELECTOR = 'tr,[role="row"],mat-row,mat-header-row';
  const CELL_SELECTOR = 'td,th,[role="cell"],[role="gridcell"],[role="columnheader"],mat-cell,mat-header-cell';

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = window.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  /** Only DIRECT text children. A container's text belongs to its leaves. */
  const ownText = (el: Element): string =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').trim())
      .filter((t) => t.length > 0)
      .join(' ')
      .trim();

  const isEditable = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      return !['hidden', 'submit', 'button', 'reset', 'image'].includes(t);
    }
    return (el as HTMLElement).isContentEditable === true;
  };

  const isDisabled = (el: Element): boolean =>
    (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

  /**
   * Accessible name, and — crucially — WHERE it came from. The ladder needs the
   * provenance, not just the string: a name from `<label for>` is an authored
   * association and a name from a placeholder is the browser guessing.
   */
  const nameOf = (el: Element): { name?: string; source?: string } => {
    const aria = el.getAttribute('aria-label');
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return { name: text, source: 'aria-labelledby' };
    }
    if (aria) return { name: aria, source: 'aria-label' };

    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = forLabel?.textContent?.trim();
      if (t) return { name: t, source: 'label-for' };
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const t = wrapping.textContent?.trim();
      if (t) return { name: t, source: 'label-wrap' };
    }
    // Angular Material does not emit `for`; the label lives in a <mat-label>
    // inside the enclosing <mat-form-field>. Treating that as an authored
    // association is correct — it IS one, just expressed by a framework rather
    // than by the HTML attribute.
    const field = el.closest('mat-form-field,.mat-mdc-form-field');
    if (field) {
      const t = field.querySelector('mat-label')?.textContent?.trim();
      if (t) return { name: t, source: 'field-label' };
    }
    const placeholder = (el as HTMLInputElement).placeholder;
    if (placeholder) return { name: placeholder, source: 'placeholder' };
    const title = el.getAttribute('title');
    if (title) return { name: title, source: 'title' };

    const own = ownText(el);
    if (own) return { name: own, source: 'text' };
    // A button whose label is in a child <span> — extremely common in Material.
    const tag = el.tagName.toLowerCase();
    if (ACTIONABLE_TAGS.has(tag) || ACTIONABLE_ROLES.has(el.getAttribute('role') ?? '')) {
      const t = (el as HTMLElement).innerText?.trim();
      if (t) return { name: t, source: 'text' };
    }
    return {};
  };

  /** ENRICHMENT ONLY. Nothing in the resolver may require this to be right. */
  const roleOf = (el: Element): string | undefined => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag.endsWith('-button')) return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td' || tag === 'th') return 'cell';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      return 'textbox';
    }
    return undefined;
  };

  const indexAmong = (el: Element, selector: string): number | undefined => {
    const parent = el.parentElement;
    if (!parent) return undefined;
    const siblings = Array.from(parent.children).filter((c) => c.matches(selector));
    const i = siblings.indexOf(el);
    return i < 0 ? undefined : i;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.currentNode;

  while ((node = walker.nextNode())) {
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
    if (!isVisible(el)) continue;

    const editable = isEditable(el);
    const own = ownText(el);
    const role = roleOf(el);
    const actionable = ACTIONABLE_TAGS.has(tag) || ACTIONABLE_ROLES.has(role ?? '');

    // Emit captions, controls and actionable things. Layout containers with no
    // text of their own contribute nothing an anchor could bind to, and
    // emitting them would only dilute reading order.
    if (!editable && !actionable && own.length === 0) continue;

    const id = `w${handle++}`;
    el.setAttribute(handleAttr, id);

    const { name, source } = nameOf(el);

    // Table geometry, when there is any. These become position.row/col — the
    // same fields the terminal fills from the character grid — so `same-row`
    // and `under-column` mean one thing across both surfaces.
    const rowEl = el.closest(ROW_SELECTOR);
    const cellEl = el.closest(CELL_SELECTOR);
    const rowIndex = rowEl ? indexAmong(rowEl, ROW_SELECTOR) : undefined;
    const colIndex = cellEl ? indexAmong(cellEl, CELL_SELECTOR) : undefined;

    const ancestors: string[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const pid = p.getAttribute(handleAttr);
      if (pid) ancestors.unshift(pid);
    }

    const rect = el.getBoundingClientRect();

    // Enclosing named regions: a dialog, a card title, the nearest heading.
    // Human-readable, used by `within` and in intervention requests.
    const regionPath: string[] = [];
    const dialog = el.closest('[role="dialog"],mat-dialog-container');
    if (dialog) {
      const t = dialog.querySelector('h1,h2,[mat-dialog-title]')?.textContent?.trim();
      regionPath.push(t ? `dialog:${t}` : 'dialog');
    }
    const card = el.closest('mat-card,[role="region"],section');
    if (card) {
      const t = card.querySelector('mat-card-title,h1,h2,h3')?.textContent?.trim();
      if (t) regionPath.push(t);
    }

    const element: ObservedElement = {
      id,
      writable: editable && !isDisabled(el) && (el as HTMLInputElement).readOnly !== true,
      enabled: !isDisabled(el),
      readingOrder: order++,
      position: {
        ...(rowIndex === undefined ? {} : { row: rowIndex }),
        ...(colIndex === undefined ? {} : { col: colIndex }),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      },
      ...(regionPath.length > 0 ? { regionPath } : {}),
      ...(role === undefined ? {} : { role: role as ObservedElement['role'] }),
      ...(name === undefined ? {} : { name }),
      ...(source === undefined ? {} : { nameSource: source as ObservedElement['nameSource'] }),
      // An editable control's content is its value; a caption's is its text.
      // Unlike the grid, this surface can tell the difference, so it does.
      ...(editable
        ? { value: (el as HTMLInputElement).value ?? '' }
        : own.length > 0
          ? { text: own }
          : {}),
    };

    out.push({
      element,
      extras: {
        ancestors,
        tag,
        ...(source === undefined ? {} : { nameSource: source as ObservedElement['nameSource'] }),
        ...(rowEl?.getAttribute(handleAttr) ? { rowId: rowEl.getAttribute(handleAttr) as string } : {}),
      },
    });
  }

  const url = location.hash || location.pathname;
  return {
    screenId: url.replace(/^#/, '') || '/',
    text: document.body.innerText,
    elements: out,
  };
}
