/**
 * THE RESULT CONTRACT — what a caller gets back from a replay.
 *
 * Three TERMINAL cases, deliberately not collapsible into two:
 *
 *   success   the flow completed; typed outputs are returned
 *   outcome   a legitimate business answer the caller needs to know about
 *             ("no such member"), carrying a machine-readable code
 *   failure   something went wrong; carries enough detail to debug without
 *             re-running (reason, step, expected, observed, evidence)
 *
 * Conflating a business outcome with a crash is the single most common design
 * error in this problem. "No such member" is an answer, not an exception: the
 * caller decides what to do about it, and a caller that has to parse an error
 * string to find out is a caller that will get it wrong.
 *
 * Plus one NON-TERMINAL case:
 *
 *   intervention   the run is parked awaiting a human, and is resumable
 *
 * `intervention` is not a fourth result. It is the absence of a result yet: the
 * run has neither succeeded, produced a business answer, nor failed. Modelling
 * it as a `failure` would conflate "nobody answered" (which really is a failure
 * — see `escalation-unanswered`) with "waiting, and you can pick this up". A
 * caller asking "what does replay return while a human holds the session?"
 * deserves a better answer than a fabricated error.
 *
 * Two things every terminal result carries, both of which exist because silent
 * degradation is how brittle automation hides rot:
 *
 *   `warnings`   a weaker locator rung fired, a recovery ran, a step was slow,
 *                an optional output was missing, a tenant override applied
 *   `degraded`   on success: TRUE if the run needed help to get there
 *
 * That last field matters more than it looks. A run that succeeded only after
 * auto-dismissing an interstitial, or only after a human took over, must not be
 * shape-identical to a clean run — otherwise the fact that a human was involved
 * is discoverable only by diffing sibling log files, and nobody does that.
 * `degraded`, `recoveries` and `interventions` put it in the returned value.
 */

import { z } from 'zod';
import { Reversibility } from './capability.js';
import { SurfaceKind } from './target.js';

/**
 * Why a run failed. Each value implies a different response, which is the test
 * for whether it deserves to exist:
 *
 *   input-invalid         caller's fault; nothing was touched. Fix the call.
 *   artifact-invalid      the artifact does not parse or was tampered with.
 *   policy-blocked        the guardrail refused the action. Not a bug.
 *   approval-required     a draft/irreversible capability refused to run
 *                         unattended. Get it approved.
 *   anchor-unresolved     a target matched nothing. The UI changed, or the
 *                         screen is not the one we expected.
 *   anchor-ambiguous      a target matched MORE THAN ONE control. Distinct from
 *                         unresolved on purpose: this is the case where
 *                         guessing writes to the wrong record, so it halts.
 *   precondition-failed   refused to act — the screen was not what the step
 *                         expected. Nothing was done.
 *   checkpoint-failed     acted, but the state afterwards was wrong. Something
 *                         MAY have happened. Different blast radius entirely.
 *   timeout               the surface never settled.
 *   recovery-exhausted    a declared recovery hit its maxAttempts cap.
 *   escalation-unanswered a human was asked and did not respond in time.
 *   output-missing        a required output could not be extracted.
 *   adapter-error         the surface itself broke (browser crash, pty closed).
 */
export const FailureReason = z.enum([
  'input-invalid',
  'artifact-invalid',
  'policy-blocked',
  'approval-required',
  'anchor-unresolved',
  'anchor-ambiguous',
  'precondition-failed',
  'checkpoint-failed',
  'timeout',
  'recovery-exhausted',
  'escalation-unanswered',
  'output-missing',
  'adapter-error',
]);
export type FailureReason = z.infer<typeof FailureReason>;

/**
 * Non-fatal signals. Every one of these is a thing that worked but should not
 * be relied on continuing to work — which makes this list the drift feed.
 */
export const WarningKind = z.enum([
  /** Resolved, but via a weaker rung than the primary. Earliest drift signal. */
  'ladder-fallback',
  /** A documented per-surface escape hatch was used. Portability cost. */
  'adapter-hint-used',
  /** A declared recovery policy fired. */
  'recovery-fired',
  /** A step took materially longer than its historical norm. */
  'slow-step',
  /** An `optional: true` output could not be extracted. */
  'optional-output-missing',
  /** A per-tenant lexicon translated an anchor literal. */
  'lexicon-applied',
  /** A per-tenant sparse override patched a step. */
  'override-applied',
]);
export type WarningKind = z.infer<typeof WarningKind>;

export const RunWarning = z
  .object({
    kind: WarningKind,
    stepId: z.string().optional(),
    detail: z.string(),
  })
  .strict();
export type RunWarning = z.infer<typeof RunWarning>;

/** One firing of a declared recovery policy. */
export const RecoveryRecord = z
  .object({
    policyId: z.string(),
    triggeredAtStep: z.string(),
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1),
    succeeded: z.boolean(),
  })
  .strict();
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;

/**
 * One human takeover, summarised. `stateDelta` is a DIFF OF SNAPSHOTS taken
 * before and after the operator held the lease — not a keylog. We record what
 * changed, because that is what replay has to reconcile with; capturing
 * keystrokes in a regulated environment would mean capturing whatever the
 * operator typed, including things we have no business storing.
 */
export const InterventionRecord = z
  .object({
    interventionId: z.string(),
    reason: z.string(),
    atStep: z.string(),
    operatorId: z.string().optional(),
    heldMs: z.number().int().min(0),
    stateDelta: z.array(z.string()),
    /** Whether the post-resume checkpoint revalidated. Never resume blind. */
    resyncPassed: z.boolean(),
  })
  .strict();
export type InterventionRecord = z.infer<typeof InterventionRecord>;

/** Fields shared by every result, terminal or not. */
const RunBase = {
  runId: z.string().min(1),
  capabilityId: z.string().min(1),
  capabilityVersion: z.string().min(1),
  tenant: z.string().min(1),
  surface: SurfaceKind,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  /**
   * Number of model API calls made during this run.
   *
   * This is a REAL COUNTER incremented by the only module that can construct an
   * Anthropic client (src/replay/guard.ts), not a constant. A hardcoded zero
   * would make any test asserting it tautological, which is exactly the trap
   * this field exists to avoid. On any replay it must be 0; the guard also
   * throws if the API host is dialled at all.
   */
  modelCalls: z.number().int().min(0),
  warnings: z.array(RunWarning),
  /** Relative paths into evidence/, for debugging without re-running. */
  evidence: z.array(z.string()),
} as const;

/** Records shared by the three terminal shapes. */
const TerminalExtras = {
  recoveries: z.array(RecoveryRecord),
  interventions: z.array(InterventionRecord),
} as const;

export const SuccessResult = z
  .object({
    kind: z.literal('success'),
    ...RunBase,
    ...TerminalExtras,
    outputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    /**
     * TRUE if the run needed help: a recovery fired, a human intervened, or a
     * locator resolved via a fallback rung. A clean run and a rescued run must
     * not be indistinguishable in the returned value.
     */
    degraded: z.boolean(),
  })
  .strict();
export type SuccessResult = z.infer<typeof SuccessResult>;

export const OutcomeResult = z
  .object({
    kind: z.literal('outcome'),
    ...RunBase,
    ...TerminalExtras,
    /** Declared in the capability's `outcomes`. Never invented at runtime. */
    code: z.string(),
    description: z.string(),
    /** Whatever was extractable before the outcome was detected. */
    partialOutputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();
export type OutcomeResult = z.infer<typeof OutcomeResult>;

export const FailureResult = z
  .object({
    kind: z.literal('failure'),
    ...RunBase,
    ...TerminalExtras,
    reason: FailureReason,
    /** Absent for pre-flight failures (input-invalid, artifact-invalid). */
    failedStepId: z.string().optional(),
    /** What the engine asserted. Rendered from the Condition. */
    expected: z.string(),
    /** What it actually observed. */
    observed: z.string(),
    /**
     * For `checkpoint-failed` and `timeout`: whether the action may already have
     * taken effect. An irreversible step that timed out is NOT safe to retry,
     * and the caller cannot know that without being told.
     */
    retrySafe: z.boolean(),
    /** Worst reversibility among steps that had already executed. */
    executedUpTo: Reversibility,
  })
  .strict();
export type FailureResult = z.infer<typeof FailureResult>;

/**
 * NON-TERMINAL. The run is parked; a human has been asked to act.
 *
 * Note what is NOT here: the operator's claim and release tokens. Those are
 * capability tokens for taking control of a live session, they are delivered
 * out-of-band to the operator channel, and a result object gets logged,
 * serialised into evidence and handed to a calling agent. Putting them in the
 * return value would mean writing session-takeover credentials into the audit
 * trail. The caller resumes by `interventionId`; authorisation comes from the
 * operator having released the lease, not from the caller holding a secret.
 */
export const PendingResult = z
  .object({
    kind: z.literal('intervention'),
    ...RunBase,
    interventionId: z.string().min(1),
    /** Why automation stopped, in words a human operator can act on. */
    reason: z.string(),
    atStep: z.string(),
    /** Snapshot the operator needs to see: screenshot, or a grid dump. */
    snapshotPath: z.string(),
    /** The live session being held open. Same context, same page, same pty. */
    sessionId: z.string(),
    requestedAt: z.string().datetime(),
    /** After this, an unanswered escalation becomes `escalation-unanswered`. */
    expiresAt: z.string().datetime(),
  })
  .strict();
export type PendingResult = z.infer<typeof PendingResult>;

export const TerminalResult = z.discriminatedUnion('kind', [
  SuccessResult,
  OutcomeResult,
  FailureResult,
]);
export type TerminalResult = z.infer<typeof TerminalResult>;

export const ReplayResult = z.discriminatedUnion('kind', [
  SuccessResult,
  OutcomeResult,
  FailureResult,
  PendingResult,
]);
export type ReplayResult = z.infer<typeof ReplayResult>;

export function isTerminal(r: ReplayResult): r is TerminalResult {
  return r.kind !== 'intervention';
}

/**
 * Process exit codes, so the CLI is scriptable and a business outcome is not
 * mistaken for a crash by a shell:
 *   0  success
 *   3  business outcome (a real answer — NOT an error)
 *   4  parked awaiting a human
 *   1  failure
 */
export function exitCodeFor(r: ReplayResult): 0 | 1 | 3 | 4 {
  switch (r.kind) {
    case 'success':
      return 0;
    case 'outcome':
      return 3;
    case 'intervention':
      return 4;
    case 'failure':
      return 1;
  }
}

/** One-line summary for CLI output and the evidence index. */
export function describeResult(r: ReplayResult): string {
  const head = `${r.capabilityId}@${r.capabilityVersion} [${r.surface}/${r.tenant}] ${r.durationMs}ms`;
  switch (r.kind) {
    case 'success': {
      const flag = r.degraded ? ' DEGRADED' : '';
      const outs = Object.entries(r.outputs)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      return `SUCCESS${flag} ${head} ${outs}`;
    }
    case 'outcome':
      return `OUTCOME ${r.code} ${head} — ${r.description}`;
    case 'failure':
      return `FAILURE ${r.reason} ${head} at ${r.failedStepId ?? '<pre-flight>'} — expected ${r.expected}, observed ${r.observed}`;
    case 'intervention':
      return `AWAITING OPERATOR ${head} at ${r.atStep} — ${r.reason} (${r.interventionId})`;
  }
}
