/**
 * REDACTION — applied to everything that reaches disk.
 *
 * The brief's requirement is that secrets and raw sensitive data never get
 * persisted into artifacts or logs. That is not the same as "mask a password
 * field in the UI": the leak paths that matter here are the ones nobody looks
 * at until an auditor does — a full-page text dump, an action transcript, a
 * failure `observed` string, an intervention request handed to an operator.
 *
 * TWO MECHANISMS, because either alone has a hole.
 *
 *   BY VALUE. Secrets the run actually holds — the credentials it signs in
 *   with — are removed by matching their literal value. This is the only way to
 *   reliably keep a password out of a page dump, because once an application
 *   has echoed it somewhere unexpected no pattern would recognise it as
 *   anything but an ordinary word.
 *
 *   BY PATTERN. Data the run never saw but the SURFACE might render — an SSN on
 *   a member record, a card number, a bearer token in an error banner. Patterns
 *   catch the shapes; they cannot catch a password that looks like "hunter2".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not try to be a PII classifier.
 * Names and account numbers are the working data of this system — a capability
 * that redacted the member's name would return nothing useful — so they are
 * handled by the artifact contract instead: parameters are stored by NAME, and
 * a recorded sample value is stored as a fingerprint rather than the value.
 * Redaction covers credentials and regulated identifiers; scope is stated
 * rather than implied, because a redactor that claims to catch everything is
 * how a leak gets shipped.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface RedactionConfig {
  secretEnvVars?: string[];
  patterns?: Array<{ name: string; regex: string }>;
}

export interface PolicyFile {
  surfaces?: Record<
    string,
    {
      allowedOrigins?: string[];
      allowedActions?: string[];
      allowedKeys?: string[];
      /** NAMES of env vars a discovery agent may cite as {{env.NAME}}. Never values. */
      credentialEnvVars?: string[];
    }
  >;
  redaction?: RedactionConfig;
}

/**
 * A literal shorter than this is not treated as a secret to strip.
 *
 * Not a nicety: an unset variable reads as "" and an empty needle matches at
 * every position, which would replace the entire document with mask markers.
 * A very short one ("1", "no") would shred ordinary prose. A redactor that
 * destroys the evidence is as useless as one that leaks it.
 */
const MIN_SECRET_LENGTH = 4;

const MASK = '«redacted»';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate the inline `(?i)` flag some of the configured patterns use.
 * JavaScript has no inline flag syntax, so it is lifted to a real flag rather
 * than silently failing to compile and leaving the pattern unenforced.
 */
function compile(pattern: string): RegExp {
  const ci = pattern.startsWith('(?i)');
  return new RegExp(ci ? pattern.slice(4) : pattern, ci ? 'gi' : 'g');
}

export type Redactor = (input: string) => string;

/**
 * Build a redactor from configuration plus the live environment.
 *
 * `env` is injected rather than read from `process.env` directly so tests can
 * prove the redactor removes a specific value without putting a real credential
 * in the test environment.
 */
export function buildRedactor(
  config: RedactionConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): Redactor {
  const secrets: string[] = [];
  for (const name of config?.secretEnvVars ?? []) {
    const value = env[name];
    if (value !== undefined && value.trim().length >= MIN_SECRET_LENGTH) secrets.push(value.trim());
  }
  // Longest first: a short secret that is a substring of a longer one must not
  // mask part of it and leave the remainder legible.
  secrets.sort((a, b) => b.length - a.length);

  const patterns = (config?.patterns ?? []).map((p) => ({ name: p.name, re: compile(p.regex) }));

  return (input: string): string => {
    let out = input;
    for (const secret of secrets) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), MASK);
    }
    for (const { name, re } of patterns) {
      // Named so a reviewer reading the evidence can tell WHAT was removed and
      // therefore whether the run saw something it should not have.
      out = out.replace(re, `«redacted:${name}»`);
    }
    return out;
  };
}

/**
 * A stable, non-reversible stand-in for a recorded sample value.
 *
 * The compiler stores this instead of the literal a discovery run happened to
 * be driven with, so an artifact records that "a value shaped like this was
 * used" without publishing the member id it was recorded against. Truncated
 * because it is an identity check, not a security boundary.
 */
export function fingerprint(value: string): string {
  return 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/** Load policy.json. Absent config is an error, not a silent open door. */
export function loadPolicy(path = 'policy.json'): PolicyFile {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as PolicyFile;
}
