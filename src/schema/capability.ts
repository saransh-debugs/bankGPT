/**
 * THE CAPABILITY ARTIFACT — the contract between discovery and replay.
 *
 * A capability is what an AI agent calls. It is typed, versioned and reviewable:
 * a human reviewer and a calling agent should both be able to read it and know
 * what it does, what it needs, and what it returns, without replaying it and
 * without reading the model transcript it came from.
 *
 * Three properties are load-bearing and each is enforced by `superRefine` at
 * the bottom of this file rather than left to convention:
 *
 *   1. NO SECRET IS EVER STORED. A step that submits a credential stores the
 *      NAME of an environment variable, never the value, and must be marked
 *      `redact: true`. Parsing rejects the alternative.
 *
 *   2. `maxReversibility` CANNOT LIE. It is denormalised so a caller can gate a
 *      capability without walking its steps — which makes it exactly the kind
 *      of field that drifts out of sync and silently under-reports risk.
 *      Parsing recomputes it.
 *
 *   3. OUTPUTS TRACE TO A STEP. Every declared output names a binding produced
 *      by a `read` step, so "where did this number come from" is answerable
 *      from the artifact alone.
 */

import { z } from 'zod';
import { Condition, targetsOf } from './condition.js';
import { Target, SurfaceKind } from './target.js';

export const SCHEMA_VERSION = '1.0' as const;

/**
 * `press` is not a web afterthought — it is how a block-mode terminal works at
 * all. The operator fills fields locally and the screen is transmitted only when
 * an AID key (Enter, F3, Field Exit) is pressed. A vocabulary without `press`
 * cannot express a 5250 flow.
 */
export const ActionKind = z.enum(['navigate', 'click', 'fill', 'select', 'press', 'read', 'wait']);
export type ActionKind = z.infer<typeof ActionKind>;

/**
 * Declared PER STEP, never inferred from the action kind. A click can be
 * harmless (open a tab) or irreversible (post a transaction); the action verb
 * does not know which, and guessing from the verb is how automation posts a
 * payment twice.
 */
export const Reversibility = z.enum(['safe', 'reversible', 'irreversible']);
export type Reversibility = z.infer<typeof Reversibility>;

const REVERSIBILITY_RANK: Record<z.infer<typeof Reversibility>, number> = {
  safe: 0,
  reversible: 1,
  irreversible: 2,
};

export const ApprovalState = z.enum(['draft', 'in-review', 'approved', 'deprecated']);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const ValueType = z.enum(['string', 'number', 'money', 'date', 'boolean']);
export type ValueType = z.infer<typeof ValueType>;

/**
 * Template references allowed in `Step.value`. Anything else is a literal.
 *   {{inputs.memberId}}         a declared input parameter
 *   {{bindings.accountId}}      a value captured by an earlier `read` step
 *   {{env.FINERACT_PASSWORD}}   resolved from the environment AT REPLAY TIME;
 *                               only legal on a step marked redact: true
 */
const TEMPLATE_RE = /\{\{\s*(inputs|bindings|env)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface TemplateRef {
  scope: 'inputs' | 'bindings' | 'env';
  name: string;
}

export function templateRefs(value: string): TemplateRef[] {
  const out: TemplateRef[] = [];
  for (const m of value.matchAll(TEMPLATE_RE)) {
    out.push({ scope: m[1] as TemplateRef['scope'], name: m[2] as string });
  }
  return out;
}

export const Step = z
  .object({
    id: z.string().min(1),
    action: ActionKind,
    /** Absent for `navigate` (uses `url`), `wait` and `settled`-style pauses. */
    target: Target.optional(),
    /** Literal or template. Never a literal secret — see superRefine. */
    value: z.string().optional(),
    /** 'Enter', 'F3', 'F12', 'Tab'. Essential on a block-mode terminal. */
    key: z.string().optional(),
    /** Entry point for `navigate`. Web-only; a terminal capability has none. */
    url: z.string().optional(),
    /** Names the binding a `read` step captures, referenced by outputs. */
    bindTo: z.string().min(1).optional(),
    reversibility: Reversibility,
    /** Value is a secret: resolve from env at replay, mask in all evidence. */
    redact: z.boolean().optional(),
    /** Asserted BEFORE acting. Refuse to act on an unexpected screen. */
    precondition: Condition.optional(),
    /**
     * Asserted AFTER acting. Do not assume the click worked.
     *
     * A step without a checkpoint is a step whose success is unverified, which
     * is how a replay ends up reading a stale value off the previous screen.
     * `validateCapability` warns on any non-`read` step that omits one.
     */
    checkpoint: Condition.optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();
export type Step = z.infer<typeof Step>;

/**
 * BUSINESS OUTCOMES ARE DECLARED, NOT CAUGHT.
 *
 * "No such member" is a legitimate answer the caller needs, not a crash.
 * Conflating the two is the single most common design error in this problem, so
 * a capability states in advance which real-world answers it can produce. An
 * undeclared condition is a failure by construction — the engine has no path
 * that invents an outcome code at runtime.
 */
export const OutcomeDetector = z
  .object({
    /** Machine-readable and stable. 'MEMBER_NOT_FOUND'. */
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'outcome codes are SCREAMING_SNAKE_CASE'),
    description: z.string().min(1),
    when: Condition,
    /** Only checked after this step id. Omit to check after every step. */
    afterStep: z.string().optional(),
    /** Terminal outcomes stop the run; non-terminal ones annotate and continue. */
    terminal: z.boolean(),
  })
  .strict();
export type OutcomeDetector = z.infer<typeof OutcomeDetector>;

/**
 * RECOVERY IS BOUNDED BY CONSTRUCTION — a named condition, a fixed remedy and a
 * hard attempt cap. There is deliberately no open-ended repair path: an
 * open-ended repair is a model back in the decision loop, which is the thing
 * this design exists to remove. Exhausting `maxAttempts` fails the run with
 * `recovery-exhausted` rather than looping.
 */
export const RecoveryPolicy = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    when: Condition,
    then: z.array(Step).min(1),
    maxAttempts: z.number().int().min(1).max(5),
  })
  .strict();
export type RecoveryPolicy = z.infer<typeof RecoveryPolicy>;

export const InputParam = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    type: ValueType,
    required: z.boolean(),
    description: z.string().min(1),
    /** Used by the catalog to show an agent how to call this. */
    example: z.string().optional(),
  })
  .strict();
export type InputParam = z.infer<typeof InputParam>;

export const OutputField = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    type: ValueType,
    /** Binding name produced by a `read` step's `bindTo`. */
    from: z.string().min(1),
    description: z.string().min(1),
    /** A missing optional output is a warning, not a failure. */
    optional: z.boolean().optional(),
  })
  .strict();
export type OutputField = z.infer<typeof OutputField>;

export const CapabilityMetadata = z
  .object({
    recordedAt: z.string().datetime(),
    recordedBy: z.string().min(1),
    /** The model that discovered this flow. Absent on a hand-authored artifact. */
    model: z.string().optional(),
    /** Natural-language goal the agent was given. */
    goalPrompt: z.string().optional(),
    /** Relative path to the committed discovery evidence directory. */
    discoveryEvidence: z.string().optional(),
    replayStats: z
      .object({
        runs: z.number().int().min(0),
        passed: z.number().int().min(0),
        /** passed / runs. Gates promotion to `approved`. */
        stability: z.number().min(0).max(1),
        lastRunAt: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
    approvedBy: z.string().optional(),
    approvedAt: z.string().datetime().optional(),
  })
  .strict();
export type CapabilityMetadata = z.infer<typeof CapabilityMetadata>;

export const Capability = z
  .object({
    /** Dotted and stable. 'member.savings.balance.read'. */
    id: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver'),
    schemaVersion: z.literal(SCHEMA_VERSION),
    name: z.string().min(1),
    description: z.string().min(1),
    /** 'fineract/web-app' | 'northridge/terminal'. */
    product: z.string().min(1),
    productVersion: z.string().optional(),
    surface: SurfaceKind,
    recordedForTenant: z.string().min(1),
    approvalState: ApprovalState,
    inputs: z.array(InputParam),
    outputs: z.array(OutputField),
    steps: z.array(Step).min(1),
    successCondition: Condition,
    outcomes: z.array(OutcomeDetector),
    recoveries: z.array(RecoveryPolicy),
    /** Denormalised max over steps. Recomputed at parse time — cannot lie. */
    maxReversibility: Reversibility,
    metadata: CapabilityMetadata,
  })
  .strict()
  .superRefine((cap, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // ---- step ids are unique; recovery steps share the namespace -------------
    const allSteps = [...cap.steps, ...cap.recoveries.flatMap((r) => r.then)];
    const seen = new Set<string>();
    for (const s of allSteps) {
      if (seen.has(s.id)) issue(`duplicate step id '${s.id}'`, ['steps']);
      seen.add(s.id);
    }

    // ---- maxReversibility must equal the real maximum ------------------------
    const worst = allSteps.reduce<z.infer<typeof Reversibility>>(
      (acc, s) => (REVERSIBILITY_RANK[s.reversibility] > REVERSIBILITY_RANK[acc] ? s.reversibility : acc),
      'safe',
    );
    if (worst !== cap.maxReversibility) {
      issue(
        `maxReversibility is '${cap.maxReversibility}' but the riskiest step is '${worst}'. ` +
          `This field gates unattended replay, so it is recomputed rather than trusted.`,
        ['maxReversibility'],
      );
    }

    // ---- secrets: never literal, always env-referenced, always redacted ------
    for (const [i, s] of allSteps.entries()) {
      const refs = s.value ? templateRefs(s.value) : [];
      const usesEnv = refs.some((r) => r.scope === 'env');
      if (usesEnv && s.redact !== true) {
        issue(`step '${s.id}' reads {{env.*}} so it must be marked redact: true`, ['steps', i, 'redact']);
      }
      if (s.redact === true && !usesEnv) {
        issue(
          `step '${s.id}' is marked redact: true but its value is not an {{env.*}} reference. ` +
            `A secret must never be stored in an artifact.`,
          ['steps', i, 'value'],
        );
      }
    }

    // ---- templates must reference things that exist --------------------------
    const inputNames = new Set(cap.inputs.map((p) => p.name));
    const bindings = new Set(
      allSteps.filter((s) => s.bindTo !== undefined).map((s) => s.bindTo as string),
    );
    for (const [i, s] of allSteps.entries()) {
      for (const r of s.value ? templateRefs(s.value) : []) {
        if (r.scope === 'inputs' && !inputNames.has(r.name)) {
          issue(`step '${s.id}' references undeclared input '${r.name}'`, ['steps', i, 'value']);
        }
        if (r.scope === 'bindings' && !bindings.has(r.name)) {
          issue(`step '${s.id}' references unknown binding '${r.name}'`, ['steps', i, 'value']);
        }
      }
    }

    // ---- `param` anchors must reference a declared input ---------------------
    const conditionTargets = [
      ...targetsOf(cap.successCondition),
      ...cap.outcomes.flatMap((o) => targetsOf(o.when)),
      ...cap.recoveries.flatMap((r) => targetsOf(r.when)),
      ...allSteps.flatMap((s) => [
        ...(s.precondition ? targetsOf(s.precondition) : []),
        ...(s.checkpoint ? targetsOf(s.checkpoint) : []),
      ]),
    ];
    const walk = (t: Target): Target[] => (t.scope ? [t, ...walk(t.scope)] : [t]);
    const everyTarget = [
      ...allSteps.flatMap((s) => (s.target ? walk(s.target) : [])),
      ...conditionTargets.flatMap(walk),
    ];
    for (const t of everyTarget) {
      if (t.anchor.kind === 'param' && !inputNames.has(t.anchor.name)) {
        issue(`target anchors on undeclared input '${t.anchor.name}'`, ['steps']);
      }
    }

    // ---- outputs trace to a read step ---------------------------------------
    for (const [i, o] of cap.outputs.entries()) {
      if (!bindings.has(o.from)) {
        issue(
          `output '${o.name}' reads binding '${o.from}', which no step produces. ` +
            `Add bindTo: '${o.from}' to the read step that captures it.`,
          ['outputs', i, 'from'],
        );
      }
    }

    // ---- action/field coherence ---------------------------------------------
    for (const [i, s] of allSteps.entries()) {
      const need = (cond: boolean, msg: string, field: string) => {
        if (!cond) issue(`step '${s.id}': ${msg}`, ['steps', i, field]);
      };
      switch (s.action) {
        case 'navigate':
          need(s.url !== undefined, "action 'navigate' requires a url", 'url');
          break;
        case 'fill':
        case 'select':
          need(s.target !== undefined, `action '${s.action}' requires a target`, 'target');
          need(s.value !== undefined, `action '${s.action}' requires a value`, 'value');
          break;
        case 'click':
          need(s.target !== undefined, "action 'click' requires a target", 'target');
          break;
        case 'press':
          need(s.key !== undefined, "action 'press' requires a key", 'key');
          break;
        case 'read':
          need(s.target !== undefined, "action 'read' requires a target", 'target');
          need(s.bindTo !== undefined, "action 'read' requires bindTo", 'bindTo');
          break;
        case 'wait':
          break;
      }
    }

    // ---- outcome codes unique; afterStep resolves ----------------------------
    const codes = new Set<string>();
    for (const [i, o] of cap.outcomes.entries()) {
      if (codes.has(o.code)) issue(`duplicate outcome code '${o.code}'`, ['outcomes', i, 'code']);
      codes.add(o.code);
      if (o.afterStep !== undefined && !seen.has(o.afterStep)) {
        issue(`outcome '${o.code}' names unknown step '${o.afterStep}'`, ['outcomes', i, 'afterStep']);
      }
    }
  });
export type Capability = z.infer<typeof Capability>;

/** Non-fatal review findings. Surfaced by `npm run validate`, never thrown. */
export interface CapabilityLint {
  level: 'warn';
  message: string;
}

/**
 * Advisory checks that a well-formed artifact can still fail. These are review
 * signals, not schema violations — a `read`-only step legitimately has no
 * checkpoint, and one adapter hint is a documented escape hatch rather than a
 * defect. They exist so the cost of a weak locator is visible at review time
 * instead of at 3am.
 */
export function lintCapability(cap: Capability): CapabilityLint[] {
  const out: CapabilityLint[] = [];
  const warn = (message: string) => out.push({ level: 'warn', message });

  for (const s of cap.steps) {
    if (s.action !== 'read' && s.action !== 'wait' && s.checkpoint === undefined) {
      warn(`step '${s.id}' (${s.action}) has no checkpoint — its success is unverified`);
    }
    if (s.target?.relation === 'nth-in-region') {
      warn(
        `step '${s.id}' anchors positionally (nth-in-region), the weakest relation. ` +
          `rationale: "${s.target.rationale}"`,
      );
    }
    if (s.target?.adapterHints !== undefined) {
      warn(`step '${s.id}' uses an adapterHint — replay will emit a portability warning`);
    }
  }
  if (cap.outcomes.length === 0) {
    warn('no outcome detectors declared: every non-success becomes a failure');
  }
  if (cap.maxReversibility === 'irreversible' && cap.approvalState !== 'approved') {
    warn(
      `capability is '${cap.maxReversibility}' and '${cap.approvalState}' — ` +
        `unattended replay will be refused with approval-required`,
    );
  }
  return out;
}
