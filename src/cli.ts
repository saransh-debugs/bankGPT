/**
 * THE CLI — the surface an operator and a reviewer actually touch.
 *
 * Exit codes are meaningful, because a business outcome is not a crash and a
 * shell must be able to tell them apart:
 *
 *   0  success
 *   3  business outcome (a real answer)
 *   4  parked awaiting a human operator
 *   1  failure
 *   2  usage / load error
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Capability, lintCapability } from './schema/capability.js';
import { TenantOverride, overrideRatio, FORK_THRESHOLD } from './schema/override.js';
import { describeResult, exitCodeFor } from './schema/result.js';
import { TerminalAdapter } from './adapter/terminal.js';
import { WebAdapter } from './adapter/web.js';
import { gateFor } from './policy/gate.js';
import { buildRedactor, loadPolicy } from './policy/redact.js';
import type { SurfaceAdapter } from './adapter/surface.js';
import { replay } from './replay/engine.js';
import { discover } from './discover/loop.js';
import { compile } from './discover/compile.js';
import { fileOperatorChannel, listPending, release } from './operator/channel.js';

const CAPABILITY_DIR = 'capabilities';

/**
 * Load .env if present, so `redact: true` steps and `{{env.*}}` templates
 * resolve on the documented demo path without the operator exporting anything
 * by hand. Uses the runtime's own loader rather than a dependency; a missing
 * file is not an error, because the terminal surface needs no configuration at
 * all and should stay runnable with nothing set up.
 *
 * Values already in the environment win — process.loadEnvFile does not
 * overwrite them — which keeps CI and one-off overrides working.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env is fine */
  }
}

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  validate [dir]                          parse and lint every capability',
      '  discover --goal "..." [--surface web] [--entry <url>]',
      '                                          LLM-driven recording -> draft capability',
      '  replay <file> [--key value ...]         replay a capability, no model',
      '  approve <file> [--by name]              draft -> approved',
      '  operator [list]                         parked interventions awaiting a human',
      '  operator release <id> --by <name>       hand control back to automation',
      '',
      'replay options:',
      '  --tenant <name>        tenant to replay as (default: as recorded)',
      '  --override <file>      apply a tenant override',
      '  --attended             a human is watching (permits irreversible drafts)',
      '  --headed               web only: show the browser (handoff demo mode)',
      '  --escalate             bring a human in when stuck, instead of failing',
      '  --operator-dir <dir>   where intervention requests are exchanged',
      '  --evidence <dir>       where to write evidence',
      '  --<param> <value>      any capability input parameter',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

/** Parse `--flag value` pairs plus positionals. */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function loadCapability(path: string): Promise<Capability> {
  const raw = await readFile(path, 'utf8');
  // Artifacts loaded from disk are UNTRUSTED input: hand-edited, produced by a
  // model, or moved between environments. Parsing is the boundary where that
  // stops being a risk, which is why the schema is a runtime validator and not
  // just a set of TypeScript types.
  const parsed = Capability.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    process.stderr.write(`✗ ${path} is not a valid capability:\n`);
    for (const issue of parsed.error.issues) {
      process.stderr.write(`    ${issue.path.join('.') || '<root>'}: ${issue.message}\n`);
    }
    process.exit(2);
  }
  return parsed.data;
}

async function cmdValidate(dir: string): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    process.stderr.write(`cannot read ${dir}\n`);
    return 2;
  }
  if (files.length === 0) {
    process.stderr.write(`no capability files in ${dir}\n`);
    return 2;
  }

  let bad = 0;
  let warnings = 0;

  for (const f of files.sort()) {
    const path = join(dir, f);
    const raw = await readFile(path, 'utf8');
    const parsed = Capability.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      bad++;
      process.stdout.write(`✗ ${f}\n`);
      for (const issue of parsed.error.issues) {
        process.stdout.write(`    ${issue.path.join('.') || '<root>'}: ${issue.message}\n`);
      }
      continue;
    }
    const cap = parsed.data;
    const lint = lintCapability(cap);
    warnings += lint.length;
    process.stdout.write(
      `✓ ${f}  ${cap.id}@${cap.version} [${cap.surface}] ${cap.steps.length} steps, ` +
        `${cap.outcomes.length} outcomes, ${cap.maxReversibility}, ${cap.approvalState}\n`,
    );
    for (const l of lint) process.stdout.write(`    warn: ${l.message}\n`);
  }

  // Overrides are validated too, including the fork-vs-patch threshold: the
  // point of computing that ratio is to act on it.
  const overrideDir = join(dir, 'overrides');
  let overrides: string[] = [];
  try {
    overrides = (await readdir(overrideDir)).filter((f) => f.endsWith('.json'));
  } catch {
    /* no overrides directory is fine */
  }
  for (const f of overrides.sort()) {
    const raw = await readFile(join(overrideDir, f), 'utf8');
    const parsed = TenantOverride.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      bad++;
      process.stdout.write(`✗ overrides/${f}\n`);
      for (const issue of parsed.error.issues) {
        process.stdout.write(`    ${issue.path.join('.') || '<root>'}: ${issue.message}\n`);
      }
      continue;
    }
    const ov = parsed.data;
    const baseFile = files.find((bf) => bf.startsWith(ov.capabilityId));
    let ratioNote = '';
    if (baseFile) {
      const baseCap = Capability.safeParse(JSON.parse(await readFile(join(dir, baseFile), 'utf8')));
      if (baseCap.success) {
        const ratio = overrideRatio(ov, baseCap.data.steps.length);
        ratioNote = ` patches ${(ratio * 100).toFixed(0)}% of steps`;
        if (ratio > FORK_THRESHOLD) {
          warnings++;
          ratioNote += ` — above the ${(FORK_THRESHOLD * 100).toFixed(0)}% fork threshold; consider forking`;
        }
      }
    }
    process.stdout.write(
      `✓ overrides/${f}  ${ov.capabilityId} @${ov.baseVersion} tenant=${ov.tenant}` +
        `${ov.lexicon ? ` lexicon=${Object.keys(ov.lexicon).length}` : ''}${ratioNote}\n`,
    );
  }

  process.stdout.write(
    `\n${files.length} capabilities, ${overrides.length} overrides, ${bad} invalid, ${warnings} warnings\n`,
  );
  return bad > 0 ? 2 : 0;
}

async function cmdReplay(file: string, flags: Record<string, string | true>): Promise<number> {
  const cap = await loadCapability(file);

  let override: TenantOverride | undefined;
  if (typeof flags.override === 'string') {
    const parsed = TenantOverride.safeParse(JSON.parse(await readFile(flags.override, 'utf8')));
    if (!parsed.success) {
      process.stderr.write(`✗ invalid override ${flags.override}\n`);
      return 2;
    }
    override = parsed.data;
  }

  // Any flag that names a declared input becomes an input value. Keeps the CLI
  // honest: it cannot silently accept a parameter the capability does not
  // declare, because the engine validates against `cap.inputs`.
  const inputs: Record<string, string> = {};
  for (const p of cap.inputs) {
    const v = flags[p.name];
    if (typeof v === 'string') inputs[p.name] = v;
  }

  const tenant = typeof flags.tenant === 'string' ? flags.tenant : (override?.tenant ?? cap.recordedForTenant);
  const evidenceDir = typeof flags.evidence === 'string' ? flags.evidence : undefined;

  // Policy and redaction are constructed HERE and injected into the adapter,
  // so the adapter owes nothing to a policy module and a test can substitute
  // its own. Both are built before the surface is opened: a run that could not
  // load its allowlist must not start, rather than start unguarded.
  const policy = loadPolicy();
  const redact = buildRedactor(policy.redaction);

  let adapter: SurfaceAdapter;
  if (cap.surface === 'terminal') {
    const t = new TerminalAdapter({
      evidenceDir: evidenceDir ?? join('evidence', 'scratch'),
      gate: gateFor('terminal', policy),
      redact,
      // The host is BRANDED per institution, the way a real 5250 shop runs one
      // vendor panel with its own text constants. Replaying `--tenant summit`
      // therefore has to bring up Summit's panel, or the lexicon would be
      // translating captions that were never on screen and the demo would prove
      // nothing.
      env: {
        ...(typeof flags['expire-after'] === 'string'
          ? { TERM_EXPIRE_AFTER_AIDS: flags['expire-after'] }
          : {}),
        TERM_TENANT: tenant,
      },
    });
    await t.start();
    adapter = t;
  } else if (cap.surface === 'web') {
    const w = new WebAdapter({
      evidenceDir: evidenceDir ?? join('evidence', 'scratch'),
      gate: gateFor('web', policy),
      redact,
      // Headed is the handoff mode: the operator takes over THIS window, not a
      // second browser pointed at the same app.
      headed: flags.headed === true,
    });
    await w.start();
    adapter = w;
  } else {
    process.stderr.write(`surface '${cap.surface}' has no adapter wired into the CLI yet\n`);
    return 2;
  }

  try {
    const result = await replay({
      capability: cap,
      inputs,
      adapter,
      tenant,
      ...(override === undefined ? {} : { override }),
      attended: flags.attended === true,
      escalateOnStuck: flags.escalate === true,
      // With --escalate but no channel the engine PARKS and returns a resumable
      // intervention (exit 4). Supplying a channel makes it wait for a person.
      ...(flags.escalate === true && flags['operator-dir'] !== undefined
        ? {
            escalate: fileOperatorChannel({
              dir: String(flags['operator-dir']),
              redact,
              onWaiting: (req, path) => {
                process.stdout.write(
                  `\n  ⏸  PARKED at step '${req.stepId}': ${req.reason}\n` +
                    `     the session is still open — take it over, then:\n` +
                    `     npm run operator -- release ${req.interventionId} --by "your name"\n` +
                    `     request: ${path}\n\n`,
                );
              },
            }),
          }
        : {}),
      ...(evidenceDir === undefined ? {} : { evidenceDir }),
    });

    process.stdout.write(describeResult(result) + '\n');
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        process.stdout.write(`  warn [${w.kind}] ${w.stepId ? `${w.stepId}: ` : ''}${w.detail}\n`);
      }
    }
    // The measured counter, printed on every run. The claim is checkable from
    // the CLI output, not just from a test.
    process.stdout.write(`  modelCalls=${result.modelCalls}\n`);
    if (result.evidence.length > 0) {
      process.stdout.write(`  evidence: ${result.evidence.join(', ')}\n`);
    }
    return exitCodeFor(result);
  } finally {
    await adapter.close();
  }
}

/**
 * THE ONE COMMAND WITH A MODEL IN IT.
 *
 * Everything else in this CLI is deterministic. This is the recording step:
 * an LLM drives the live surface until it reaches the goal, the run is written
 * to /evidence/discovery/ as evidence, and the trace is compiled into a DRAFT
 * capability that can then be replayed with no model at all.
 */
async function cmdDiscover(flags: Record<string, string | true>): Promise<number> {
  const goal = typeof flags.goal === 'string' ? flags.goal : undefined;
  if (goal === undefined) {
    process.stderr.write(`discover requires --goal "<what to accomplish>"\n`);
    return 2;
  }
  const surface = (typeof flags.surface === 'string' ? flags.surface : 'web') as 'web' | 'terminal';

  const policy = loadPolicy();
  const redact = buildRedactor(policy.redaction);
  const evidenceDir = typeof flags.evidence === 'string' ? flags.evidence : join('evidence', 'discovery');

  // Sample values the run is driven with. Any flag that is not a known option
  // is treated as a parameter, so `--memberId 000000001` needs no declaration
  // ahead of a capability existing to declare it.
  const RESERVED = new Set(['goal', 'surface', 'evidence', 'out', 'id', 'tenant', 'headed', 'max-steps', 'model', 'entry']);
  const inputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!RESERVED.has(k) && typeof v === 'string') inputs[k] = v;
  }

  let adapter: SurfaceAdapter;
  if (surface === 'terminal') {
    const t = new TerminalAdapter({ evidenceDir, gate: gateFor('terminal', policy), redact });
    await t.start();
    adapter = t;
  } else {
    const w = new WebAdapter({
      evidenceDir,
      gate: gateFor('web', policy),
      redact,
      headed: flags.headed === true,
    });
    await w.start();
    adapter = w;
  }

  try {
    // The brief's input is a goal AND a target entry point. For web that
    // defaults to the configured app URL, so the common case needs no flag;
    // the terminal host has no address at all and correctly gets none.
    const entryUrl =
      typeof flags.entry === 'string'
        ? flags.entry
        : surface === 'web'
          ? (process.env.WEB_APP_URL ?? 'http://localhost:4200')
          : undefined;

    const trace = await discover({
      goal,
      adapter,
      inputs,
      evidenceDir,
      redact,
      ...(entryUrl === undefined ? {} : { entryUrl }),
      // Tell the agent what it may reach. Left to discover it, it guesses a
      // relative URL, gets refused, and reads that as a broken application.
      ...(policy.surfaces?.[surface]?.allowedOrigins
        ? { allowedOrigins: policy.surfaces[surface]!.allowedOrigins! }
        : {}),
      ...(policy.surfaces?.[surface]?.credentialEnvVars
        ? { credentialEnvVars: policy.surfaces[surface]!.credentialEnvVars! }
        : {}),
      ...(typeof flags.model === 'string' ? { model: flags.model } : {}),
      ...(typeof flags['max-steps'] === 'string' ? { maxSteps: Number(flags['max-steps']) } : {}),
    });

    process.stdout.write(
      `\ndiscovery ${trace.outcome} after ${trace.entries.length} steps, ${trace.modelCalls} model calls\n` +
        `  evidence: ${evidenceDir}/\n`,
    );
    if (trace.reason) process.stdout.write(`  reason: ${trace.reason}\n`);
    if (trace.outcome !== 'goal-met') return 1;

    const id = typeof flags.id === 'string' ? flags.id : 'discovered.capability';
    const capability = compile(trace, {
      id,
      product: surface === 'web' ? 'openmf/web-app' : 'northridge/terminal',
      tenant: typeof flags.tenant === 'string' ? flags.tenant : 'default',
      // Passed so the compiler can REFUSE rather than warn if a literal
      // credential made it into a step.
      secrets: (policy.redaction?.secretEnvVars ?? [])
        .map((n) => process.env[n])
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    });

    const out =
      typeof flags.out === 'string' ? flags.out : join(CAPABILITY_DIR, `${id}.${surface}.draft.json`);
    await writeFile(out, JSON.stringify(capability, null, 2) + '\n', 'utf8');

    const lint = lintCapability(capability);
    process.stdout.write(`  compiled -> ${out} (${capability.steps.length} steps, ${capability.approvalState})\n`);
    for (const l of lint) process.stdout.write(`    warn: ${l.message}\n`);
    process.stdout.write(
      `\nThis is a DRAFT: a model wrote it and no human has reviewed it.\n` +
        `Replay it, read the rationales, then: npm run approve -- ${out}\n`,
    );
    return 0;
  } finally {
    await adapter.close();
  }
}

/**
 * The draft -> approved gate.
 *
 * Approval is a human act, so it records WHO. The engine refuses unattended
 * replay of an irreversible capability that is still a draft, which is what
 * makes this more than a label.
 */
async function cmdApprove(file: string, flags: Record<string, string | true>): Promise<number> {
  const cap = await loadCapability(file);
  if (cap.approvalState === 'approved') {
    process.stdout.write(`${cap.id}@${cap.version} is already approved\n`);
    return 0;
  }

  const lint = lintCapability(cap);

  // Lint is advisory for a SAFE capability — a read-only flow with an
  // unverified step is a review note. It is not advisory for an irreversible
  // one: approving that is what permits unattended replay, and a step whose
  // success is unverified means the run cannot tell whether the irreversible
  // thing happened. That combination needs a human to say so explicitly.
  if (cap.maxReversibility === 'irreversible' && lint.length > 0 && flags.force !== true) {
    process.stderr.write(
      `refusing to approve ${cap.id}@${cap.version}: it is '${cap.maxReversibility}' and has ` +
        `${lint.length} unresolved review warning(s):\n`,
    );
    for (const l of lint) process.stderr.write(`  ${l.message}\n`);
    process.stderr.write(`\nFix them, or approve deliberately with --force.\n`);
    return 2;
  }

  const by = typeof flags.by === 'string' ? flags.by : (process.env.USER ?? 'unknown');
  const approved: Capability = {
    ...cap,
    approvalState: 'approved',
    metadata: { ...cap.metadata, approvedBy: by, approvedAt: new Date().toISOString() },
  };
  await writeFile(file, JSON.stringify(approved, null, 2) + '\n', 'utf8');

  process.stdout.write(`approved ${cap.id}@${cap.version} (${cap.maxReversibility}) by ${by}\n`);
  for (const l of lint) process.stdout.write(`  warn: ${l.message}\n`);
  return 0;
}

/**
 * THE OPERATOR SURFACE.
 *
 * A bare CLI over the intervention directory, which is what the brief permits:
 * the handoff mechanism and the control-transfer model are real, the console is
 * not. A human takes over the SAME live session — the headed browser or the
 * terminal host the run already has open — and releases it here.
 */
async function cmdOperator(
  positional: string[],
  flags: Record<string, string | true>,
): Promise<number> {
  const dir = typeof flags['operator-dir'] === 'string' ? flags['operator-dir'] : 'evidence/interventions';
  const sub = positional[1] ?? 'list';

  if (sub === 'list') {
    const pending = await listPending(dir);
    if (pending.length === 0) {
      process.stdout.write(`no parked interventions in ${dir}\n`);
      return 0;
    }
    for (const p of pending) {
      process.stdout.write(
        `${p.interventionId}  ${p.capabilityId}@${p.capabilityVersion}\n` +
          `  step:      ${p.stepId}\n` +
          `  reason:    ${p.reason}\n` +
          `  session:   ${p.sessionId}   (still open — take it over)\n` +
          `  requested: ${p.requestedAt}\n` +
          `  screen:    ${p.snapshotPath}\n\n`,
      );
    }
    process.stdout.write(`${pending.length} awaiting a human. Release with:\n`);
    process.stdout.write(`  npm run operator -- release <id> --by "your name"\n`);
    return 0;
  }

  if (sub === 'release') {
    const id = positional[2];
    if (id === undefined) {
      process.stderr.write('operator release <interventionId> --by <name>\n');
      return 2;
    }
    // Attribution is required, not defaulted: releasing a paused banking
    // session is a deliberate act by a named person.
    const by = typeof flags.by === 'string' ? flags.by : undefined;
    if (by === undefined) {
      process.stderr.write('--by <name> is required: a release must be attributable\n');
      return 2;
    }
    const rec = await release(dir, id, by, typeof flags.note === 'string' ? flags.note : undefined);
    process.stdout.write(`released ${rec.interventionId} by ${rec.operatorId} at ${rec.releasedAt}\n`);
    process.stdout.write(`the run will re-observe and revalidate its checkpoint before continuing\n`);
    return 0;
  }

  process.stderr.write(`unknown operator subcommand '${sub}'\n`);
  return 2;
}

async function main(): Promise<void> {
  loadDotEnv();
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  switch (cmd) {
    case 'validate':
      process.exit(await cmdValidate(positional[1] ?? CAPABILITY_DIR));
    // eslint-disable-next-line no-fallthrough
    case 'replay': {
      const file = positional[1];
      if (file === undefined) usage();
      process.exit(await cmdReplay(file, flags));
    }
    // eslint-disable-next-line no-fallthrough
    case 'discover':
      process.exit(await cmdDiscover(flags));
    // eslint-disable-next-line no-fallthrough
    case 'approve': {
      const file = positional[1];
      if (file === undefined) usage();
      process.exit(await cmdApprove(file, flags));
    }
    // eslint-disable-next-line no-fallthrough
    case 'operator':
      process.exit(await cmdOperator(positional, flags));
    // eslint-disable-next-line no-fallthrough
    default:
      usage();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err instanceof Error ? err.stack ?? err.message : err)}\n`);
  process.exit(1);
});
