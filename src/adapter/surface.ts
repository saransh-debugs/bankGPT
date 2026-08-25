/**
 * THE SURFACE ADAPTER SEAM — the only place that knows what kind of surface
 * this is.
 *
 * The brief asks: "What's the seam between 'how we perceive/act on a surface'
 * and 'the recorded flow'?" This file is that seam. Above it, a capability is a
 * list of anchored targets and conditions; below it, one implementation talks
 * Playwright and another talks to a character grid over a pty. Neither the
 * artifact schema nor the replay engine imports either implementation.
 *
 * THE UNIVERSAL SPINE IS `readingOrder` + `writable`.
 *
 * Every adapter must project its surface into a flat list of ObservedElements
 * carrying those two properties, and the entire relation vocabulary
 * (`next-writable`, `next-value`, `same-row`, ...) is defined over them. That is
 * what makes one relation vocabulary executable on a DOM and on an 80x24 grid:
 *
 *   readingOrder   DOM order on web; AX-tree order on desktop; left-to-right,
 *                  top-to-bottom grid scan on a terminal
 *   writable       :enabled and editable on web; the UNPROTECTED field
 *                  attribute on a 5250 panel
 *
 * `role` and `name` are OPTIONAL here, and undefined for the terminal adapter.
 * That is the inversion: they are enrichments a surface may offer, not the
 * identity of a control.
 */

import type { ControlRole, SurfaceKind, Target } from '../schema/target.js';

export interface ObservedElement {
  /** Adapter-local handle. Meaningless across snapshots; never stored in an artifact. */
  id: string;
  /** Visible text, if the surface has any for this element. */
  text?: string;
  /**
   * Current value, where distinct from text (an input's contents, a field's
   * buffer). Conditions compare against "effective text", which is this when
   * present and `text` otherwise — so the artifact never has to care which.
   */
  value?: string;
  /** ENRICHMENT. Undefined on terminal. Never required to resolve. */
  role?: ControlRole;
  /** ENRICHMENT. Undefined on terminal. Never required to resolve. */
  name?: string;
  /**
   * ENRICHMENT. Where `name` came from, when the surface can say.
   *
   * An accessible name is not one thing: a name from a `<label for>` is an
   * explicit authored association, and a name from a placeholder is a guess the
   * browser made on the author's behalf. They deserve different confidence, and
   * the resolution ladder reports which rung fired from this. Undefined on
   * terminal, which has no naming layer at all.
   */
  nameSource?: 'label-for' | 'label-wrap' | 'field-label' | 'aria-labelledby' | 'aria-label' | 'placeholder' | 'title' | 'text';
  /** Can the operator put data here? The predicate `next-writable` needs. */
  writable: boolean;
  /** Is it currently actionable (not disabled)? */
  enabled: boolean;
  /** THE UNIVERSAL SPINE. Monotonic in reading order within a snapshot. */
  readingOrder: number;
  /** Grid coordinates on terminal; pixel box on web. Diagnostics only — never a locator. */
  position: { row?: number; col?: number; x?: number; y?: number };
  /** Enclosing named regions, outermost first. Used by `within` / `scope`. */
  regionPath?: string[];
}

export interface SurfaceSnapshot {
  surface: SurfaceKind;
  /** Screen or page identity, for logs and evidence. */
  screenId: string;
  elements: ObservedElement[];
  /**
   * Human-readable rendering of the whole surface — the character plane for a
   * terminal, extracted text for a page. Committed as evidence because it
   * diffs: a state delta after a human takes over is then a literal text diff
   * rather than a bespoke format.
   */
  text: string;
  capturedAt: string;
}

/** Which rung of the resolution ladder produced a match. Drift signal when it degrades. */
export type ResolveStrategy =
  | 'label-association'
  | 'aria-labelledby'
  | 'accessible-name'
  | 'text-then-reading-order'
  | 'table-cell'
  | 'grid-scan'
  | 'adapter-hint';

export interface Resolution {
  element: ObservedElement;
  /** Which rung fired. A weaker rung than usual is the earliest drift warning. */
  strategy: ResolveStrategy;
  /** How many candidates matched. Anything but 1 is not a resolution. */
  candidates: number;
  /** 1.0 for a primary-rung unique match, lower for weaker rungs. */
  confidence: number;
}

/**
 * Resolution is a RESULT, not an exception.
 *
 * Ambiguity in particular must be a first-class outcome the engine maps to its
 * own `anchor-ambiguous` failure, because the correct behaviour is to HALT. On a
 * grid where two panels both contain the literal "BALANCE", picking the first
 * match writes to the wrong record. "Resolved to 3 things" is information, and
 * throwing it away as a generic error is how that bug ships.
 */
export type ResolveOutcome =
  | { ok: true; resolution: Resolution }
  | {
      ok: false;
      reason: 'anchor-unresolved' | 'anchor-ambiguous';
      detail: string;
      candidates: number;
    };

/** An action the engine has already resolved to a concrete element. */
export type ResolvedAction =
  | { kind: 'click'; element: ObservedElement }
  | { kind: 'fill'; element: ObservedElement; value: string; redact?: boolean }
  | { kind: 'select'; element: ObservedElement; value: string }
  /** No element: an AID key on terminal, a keypress on web. */
  | { kind: 'press'; key: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'wait'; ms: number };

/**
 * POLICY IS ENFORCED HERE, BELOW THE MODEL.
 *
 * Every adapter calls its gate inside `act()` before touching the surface. It is
 * deliberately not a prompt instruction and not a check in the agent loop: an
 * instruction can be talked out of, and a hostile string in a record's notes
 * field is exactly the thing that will try. Because the gate sits under the
 * adapter, a discovery agent that has been successfully persuaded to do
 * something off-policy still cannot do it — the refusal happens at the point of
 * action, with no model in the path.
 */
export interface PolicyGate {
  /** Returns null to allow, or a human-readable reason to refuse. */
  check(action: ResolvedAction, ctx: { surface: SurfaceKind; screenId: string }): string | null;
}

/** Refusal raised by a gate. The engine maps it to `policy-blocked`. */
export class PolicyDenied extends Error {
  constructor(
    readonly action: string,
    reason: string,
  ) {
    super(`policy denied ${action}: ${reason}`);
    this.name = 'PolicyDenied';
  }
}

/** Opaque handle proving a paused session is the same one being resumed. */
export interface SessionHandle {
  sessionId: string;
  pausedAt: string;
  /** Snapshot text at the moment control was ceded, for the state delta. */
  snapshotText: string;
}

export interface Evidence {
  /** Screenshot on web, character-plane dump on terminal. */
  primaryPath: string;
  /** Additional artefacts: DOM dump, protocol transcript. */
  extraPaths: string[];
}

export interface SurfaceAdapter {
  readonly kind: SurfaceKind;

  /** Perceive the surface as a flat, ordered list of elements. */
  observe(): Promise<SurfaceSnapshot>;

  /** Resolve one anchored target against a snapshot. Never guesses. */
  resolve(target: Target, ctx: ResolveContext): Promise<ResolveOutcome>;

  /** Perform a resolved action. Calls the PolicyGate first. */
  act(action: ResolvedAction): Promise<void>;

  /** Wait for the surface to quiesce. `settled` conditions use this. */
  settle(timeoutMs: number): Promise<boolean>;

  /** Capture evidence for the current state. */
  evidence(label: string): Promise<Evidence>;

  /** Cede control, keeping the session ALIVE. Same page, same pty. */
  pause(): Promise<SessionHandle>;

  /** Take control back and re-observe. The engine revalidates before continuing. */
  resume(handle: SessionHandle): Promise<void>;

  close(): Promise<void>;
}

export interface ResolveContext {
  /** Live snapshot to resolve against. */
  snapshot: SurfaceSnapshot;
  /** Input parameter values, for `param` anchors. */
  inputs: Record<string, string>;
  /**
   * Per-tenant anchor-literal translations. Applied at resolve time so ONE
   * artifact serves many tenants — see src/schema/override.ts.
   */
  lexicon?: Record<string, string>;
  /** Called when a weaker-than-primary rung fires, to record a drift warning. */
  onFallback?: (strategy: ResolveStrategy, detail: string) => void;
  /**
   * Expand `{{inputs.*}}` / `{{bindings.*}}` in a condition's expected text.
   *
   * Supplied by the replay engine, which is the one component that knows the
   * run's inputs and bindings; the evaluator must not re-implement
   * substitution, or two places would define what a template means. A
   * checkpoint like `text = "{{inputs.memberId}}"` is what lets a capability
   * assert it landed on the RIGHT record rather than merely on a record.
   *
   * Deliberately cannot reach `env`: environment values are how secrets are
   * carried, and a failed assertion writes its expected text into the result,
   * the run log and the intervention request.
   */
  expand?: (raw: string) => string;
}
