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

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Capability, lintCapability } from './schema/capability.js';
import { TenantOverride, overrideRatio, FORK_THRESHOLD } from './schema/override.js';
import { describeResult, exitCodeFor } from './schema/result.js';
import { TerminalAdapter } from './adapter/terminal.js';
import type { SurfaceAdapter } from './adapter/surface.js';
import { replay } from './replay/engine.js';

const CAPABILITY_DIR = 'capabilities';

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  validate [dir]                          parse and lint every capability',
      '  replay <file> [--key value ...]         replay a capability',
      '',
      'replay options:',
      '  --tenant <name>        tenant to replay as (default: as recorded)',
      '  --override <file>      apply a tenant override',
      '  --attended             a human is watching (permits irreversible drafts)',
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

  let adapter: SurfaceAdapter;
  if (cap.surface === 'terminal') {
    const t = new TerminalAdapter({
      evidenceDir: evidenceDir ?? join('evidence', 'scratch'),
      ...(typeof flags['expire-after'] === 'string'
        ? { env: { TERM_EXPIRE_AFTER_AIDS: flags['expire-after'] } }
        : {}),
    });
    await t.start();
    adapter = t;
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

async function main(): Promise<void> {
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
    default:
      usage();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err instanceof Error ? err.stack ?? err.message : err)}\n`);
  process.exit(1);
});
