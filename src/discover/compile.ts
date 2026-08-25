/**
 * THE COMPILER — a trace becomes a capability.
 *
 * This is where a recording stops being "what happened once" and becomes a
 * contract. It is a PURE FUNCTION of the trace, and that is a deliberate
 * architectural split rather than tidiness: the discovery loop is
 * nondeterministic by construction and cannot be meaningfully unit-tested,
 * while everything downstream of it can be. `tests/compile.test.ts` runs this
 * against a frozen trace from a real run, so the graded half of discovery is
 * repeatable without the unfakeable half being faked.
 *
 * WHAT COMPILING ACTUALLY DOES
 *
 *   PARAMETERISES. A run driven with member 000000001 must not produce a
 *   capability that only reads member 000000001. Every occurrence of a sample
 *   value is rewritten to `{{inputs.NAME}}` — in step values, in navigate URLs,
 *   and in the anchor text of any target that matched the value as a literal
 *   (which becomes a `param` anchor). Miss that last one and the artifact
 *   silently hard-codes the record it was recorded against.
 *
 *   FORGETS THE SAMPLE VALUE. The input parameter records a FINGERPRINT of the
 *   value the run used, never the value. A capability is a reviewable document
 *   that gets copied between environments; a real member id recorded inside it
 *   is regulated data at rest for no benefit. The fingerprint preserves the only
 *   thing anyone actually needs — "was this recorded against the same value?"
 *
 *   REFUSES TO LAUNDER SECRETS. A step whose value came from `{{env.*}}` is
 *   marked `redact`, so replay resolves it from the environment. Any step
 *   carrying a literal that matches a known secret is a compile error rather
 *   than a warning, because the artifact is the thing that gets committed.
 *
 *   EMITS A DRAFT. `approvalState: 'draft'`. A model wrote this; it has not been
 *   reviewed. The engine already refuses unattended replay of an irreversible
 *   draft, so the gate is load-bearing rather than decorative.
 *
 * WHAT IT DOES NOT DO: invent checkpoints it cannot justify. Every step gets the
 * checkpoint the trace supports — for a `read` none is required, and for an
 * acting step the honest default is that the screen it produced is still the
 * screen it produced. Fabricating a richer assertion would make the artifact
 * look more rigorous than the evidence behind it.
 */

import type { Capability, Step, InputParam, OutputField } from '../schema/capability.js';
import { Capability as CapabilitySchema } from '../schema/capability.js';
import type { Condition } from '../schema/condition.js';
import type { SurfaceKind } from '../schema/target.js';
import { fingerprint } from '../policy/redact.js';
import { toTarget, type DiscoveryTrace, type ProposedStep, type TraceEntry } from './loop.js';

export interface CompileOptions {
  id: string;
  version?: string;
  name?: string;
  product: string;
  productVersion?: string;
  tenant: string;
  /** Values that must never appear as literals in the artifact. */
  secrets?: string[];
}

export class CompileError extends Error {}

/** Sample values, longest first, so a value containing another is rewritten first. */
function paramsByLength(inputs: Record<string, string>): Array<[string, string]> {
  return Object.entries(inputs)
    .filter(([, v]) => v.trim().length > 0)
    .sort((a, b) => b[1].length - a[1].length);
}

/** Rewrite every occurrence of a sample value to its parameter reference. */
function parameterise(raw: string, params: Array<[string, string]>): string {
  let out = raw;
  for (const [name, value] of params) {
    out = out.split(value).join(`{{inputs.${name}}}`);
  }
  return out;
}

export function compile(trace: DiscoveryTrace, opts: CompileOptions): Capability {
  if (trace.outcome !== 'goal-met') {
    throw new CompileError(
      `refusing to compile a run that ended '${trace.outcome}'${trace.reason ? `: ${trace.reason}` : ''}. ` +
        `Only a run that reached its goal describes a flow worth replaying.`,
    );
  }

  const params = paramsByLength(trace.inputs);
  const usable = trace.entries.filter((e) => e.status === 'ok');
  if (usable.length === 0) {
    throw new CompileError('the run recorded no successfully executed steps');
  }

  // Two passes, and the order matters. Checkpoints are derived from the NEXT
  // step's target, so they must be built from the ALREADY-PARAMETERISED steps —
  // deriving them from the raw trace would copy the run's sample value into a
  // checkpoint and leak the recorded member id into the artifact through the
  // back door, after the step itself had been correctly rewritten.
  const bare = usable.map((e, i) => compileStep(e, i, params, opts));
  const steps = bare.map((s, i) => {
    const checkpoint = checkpointFor(s, bare[i + 1]);
    return checkpoint === undefined ? s : { ...s, checkpoint };
  });

  // Only parameters the compiled steps actually reference become inputs. A run
  // may be driven with more sample values than the flow ends up needing, and an
  // input the capability never reads is a lie in its signature.
  //
  // A parameter is referenced two different ways and BOTH count. `{{inputs.x}}`
  // is the obvious one, in a value or a URL. The other is a `param` anchor,
  // which names the input directly rather than templating it — that is how a
  // step finds one record among many, and missing it produces a capability
  // whose steps depend on an input its signature never declares. The schema
  // catches that, which is the point of validating our own output.
  const body = JSON.stringify(steps);
  const anchored = new Set(
    steps
      .map((s) => s.target?.anchor)
      .filter((a): a is { kind: 'param'; name: string } => a?.kind === 'param')
      .map((a) => a.name),
  );
  const inputs: InputParam[] = params
    .filter(([name]) => body.includes(`{{inputs.${name}}}`) || anchored.has(name))
    .map(([name, value]) => ({
      name,
      type: 'string',
      required: true,
      description: `Supplied by the caller. Recorded against a value fingerprinted as ${fingerprint(value)}.`,
      // The sample value itself is NOT stored — see the header.
      example: fingerprint(value),
    }));

  const bound = new Set(usable.map((e) => e.step.bindTo).filter(Boolean) as string[]);
  const outputs: OutputField[] = trace.outputs
    .filter((o) => bound.has(o.from))
    .map((o) => ({ name: o.name, type: o.type, from: o.from, description: o.description }));

  if (trace.outputs.length > 0 && outputs.length === 0) {
    throw new CompileError(
      `the run declared outputs ${trace.outputs.map((o) => o.name).join(', ')} but no read step captured them`,
    );
  }

  const maxReversibility = steps.reduce<Step['reversibility']>(
    (acc, s) =>
      s.reversibility === 'irreversible' || acc === 'irreversible'
        ? 'irreversible'
        : s.reversibility === 'reversible' || acc === 'reversible'
          ? 'reversible'
          : 'safe',
    'safe',
  );

  const capability: Capability = {
    id: opts.id,
    version: opts.version ?? '0.1.0',
    schemaVersion: '1.0',
    name: opts.name ?? `${opts.id} (discovered)`,
    // Parameterised like everything else. The goal an operator typed reads
    // "look up member 000000001…", and the summary a model wrote may quote it
    // back — so prose is a leak path for the recorded value exactly like a step
    // value is, and the artifact must not carry the record it was recorded
    // against in ANY field.
    description: parameterise(trace.summary ?? trace.goal, params),
    product: opts.product,
    ...(opts.productVersion === undefined ? {} : { productVersion: opts.productVersion }),
    surface: trace.surface as SurfaceKind,
    recordedForTenant: opts.tenant,
    // A model wrote this. It is a proposal until a human says otherwise.
    approvalState: 'draft',
    inputs,
    outputs,
    steps,
    successCondition: successConditionFor(steps),
    // Declared outcomes and recoveries are NOT invented here. A single happy-path
    // run is no evidence at all about what a not-found screen looks like, and a
    // guessed detector is worse than none: it would give a caller a confident
    // wrong answer. They are added when reviewing the draft.
    outcomes: [],
    recoveries: [],
    maxReversibility,
    metadata: {
      recordedAt: trace.startedAt,
      recordedBy: 'discovery',
      model: trace.model,
      goalPrompt: parameterise(trace.goal, params),
    },
  };

  // Validate what we produced against the same schema that guards artifacts
  // loaded from disk. A compiler that can emit an invalid capability just moves
  // the failure to replay time.
  const parsed = CapabilitySchema.safeParse(capability);
  if (!parsed.success) {
    throw new CompileError(
      `compiled an invalid capability: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

function compileStep(
  entry: TraceEntry,
  index: number,
  params: Array<[string, string]>,
  opts: CompileOptions,
): Step {
  const p: ProposedStep = entry.step;
  const secrets = opts.secrets ?? [];

  const rawValue = p.value;
  if (rawValue !== undefined) {
    for (const secret of secrets) {
      if (secret.length >= 4 && rawValue.includes(secret)) {
        throw new CompileError(
          `step '${p.intent}' carries a literal secret value. Capabilities store the ` +
            `NAME of a credential ({{env.NAME}}), never the credential.`,
        );
      }
    }
  }

  const isSecret = rawValue !== undefined && /\{\{\s*env\./.test(rawValue);

  const step: Step = {
    id: stepId(p, index),
    action: p.action,
    reversibility: p.reversibility,
    ...(p.target === undefined
      ? {}
      : {
          target: (() => {
            let t = toTarget(p.target);

            // REPAIR: a `self` anchor with a relation other than `is`.
            //
            // `self` means "the anchor IS the control", so the schema requires
            // `is`. A model that writes `self:"Total Savings"` + `next-value`
            // has picked the wrong anchorKind, not the wrong relation — it
            // means "the caption Total Savings, and the value after it", which
            // is exactly a `label` anchor.
            //
            // Rewriting is lossless rather than a guess: the adapters resolve
            // `self` and `label` through the same reading-order rung, so the
            // step already EXECUTED with these semantics during discovery and
            // read the right value. Only the schema's validation rule
            // distinguishes them. Throwing the run away over a naming slip
            // would discard a recording that demonstrably worked.
            if (t.anchor.kind === 'self' && t.relation !== 'is') {
              t = { ...t, anchor: { kind: 'label', text: t.anchor.text } };
            }
            // A target that anchored on the RUN'S sample value must become a
            // `param` anchor, or the artifact only ever finds that one record.
            if (t.anchor.kind !== 'param') {
              const match = params.find(([, v]) => 'text' in t.anchor && t.anchor.text === v);
              if (match) {
                return { ...t, anchor: { kind: 'param' as const, name: match[0] } };
              }
            }
            return t;
          })(),
        }),
    ...(rawValue === undefined ? {} : { value: parameterise(rawValue, params) }),
    ...(p.key === undefined ? {} : { key: p.key }),
    ...(p.url === undefined ? {} : { url: parameterise(p.url, params) }),
    ...(p.bindTo === undefined ? {} : { bindTo: p.bindTo }),
    ...(isSecret ? { redact: true } : {}),
  };

  return step;
}

/**
 * The checkpoint a single observed run can actually justify.
 *
 * If the IMMEDIATELY following step resolved a target, then that target was
 * present right after this step ran — a real, observed post-condition rather
 * than an invented one.
 *
 * Strictly the immediately-following step, never a later one. If the next step
 * is a `navigate`, the screen it produced is not the screen this step produced,
 * and borrowing an assertion from across it would be a claim the recording does
 * not support. In that case the step gets NO checkpoint and `lintCapability`
 * warns that its success is unverified — which is the correct outcome, because
 * it points a reviewer at exactly the place the draft needs a human to supply
 * an assertion the recording could not.
 */
function checkpointFor(step: Step, next: Step | undefined): Condition | undefined {
  if (step.action === 'read' || step.action === 'wait') return undefined;
  if (!next?.target) return undefined;

  const target = next.target;
  return {
    type: 'present',
    target: {
      ...target,
      rationale:
        `Observed during discovery: this control was present immediately after the step ran, ` +
        `so its presence is a post-condition the recording actually witnessed. ` +
        `Original locator rationale: ${target.rationale}`,
    },
  };
}

/** Success is "the last thing we read was there", which the run did observe. */
function successConditionFor(steps: Step[]): Condition {
  const lastRead = [...steps].reverse().find((s) => s.action === 'read' && s.target);
  if (lastRead?.target) {
    return {
      type: 'present',
      target: {
        ...lastRead.target,
        rationale:
          `The final value the capability exists to return. Asserted so success is defined by ` +
          `the application still rendering it, not by the steps having run without throwing. ` +
          `Original locator rationale: ${lastRead.target.rationale}`,
      },
    };
  }
  const lastTargeted = [...steps].reverse().find((s) => s.target);
  if (lastTargeted?.target) {
    return { type: 'present', target: lastTargeted.target };
  }
  return { type: 'settled' };
}

/** Stable, readable step ids derived from intent. Ids are referenced by outcomes. */
function stepId(p: ProposedStep, index: number): string {
  const slug = p.intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-');
  return slug.length > 0 ? `${String(index + 1).padStart(2, '0')}-${slug}` : `step-${index + 1}`;
}
