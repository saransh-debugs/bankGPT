/**
 * CONDITIONS — the assertion language used for preconditions, per-step
 * checkpoints, success conditions, outcome detectors and recovery triggers.
 *
 * One vocabulary serves all five so that a reviewer learns it once, and so the
 * engine has exactly one evaluator to keep deterministic.
 *
 * Every condition is expressed over Targets (anchor + relation), so conditions
 * are as surface-independent as the locators are. There is deliberately no
 * `url` condition and no `selector` condition: a URL is a web-only concept and
 * a 5250 screen has no address. "Am I on the right screen?" is asked as
 * `present` on a landmark anchor — the screen's own title literal — which is
 * exactly how a human operator answers the same question.
 */

import { z } from 'zod';
import { Target, describeTarget } from './target.js';

/** How a `text` condition compares. Defaults to `exact` when omitted. */
export const TextMatch = z.enum(['exact', 'contains', 'regex']);
export type TextMatch = z.infer<typeof TextMatch>;

export type Condition =
  /** The target resolves to exactly one control. */
  | { type: 'present'; target: Target }
  /** The target resolves to nothing. Used to assert a dialog is gone. */
  | { type: 'absent'; target: Target }
  /** The target resolves and is interactable (not disabled, not protected). */
  | { type: 'enabled'; target: Target }
  /**
   * The target's EFFECTIVE TEXT matches. Effective text is the adapter's job:
   * an input's value on web, a field's buffer contents on a character grid,
   * textContent for static elements. The artifact does not care which.
   */
  | { type: 'text'; target: Target; text: string; match?: TextMatch }
  /**
   * The surface has quiesced. On web: no in-flight navigation or pending
   * requests. On terminal: the host has replied and the keyboard is unlocked
   * after an AID key. This is the only condition with no target — it is about
   * the surface, not a control.
   */
  | { type: 'settled' }
  | { type: 'all'; of: Condition[] }
  | { type: 'any'; of: Condition[] };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('present'), target: Target }).strict(),
    z.object({ type: z.literal('absent'), target: Target }).strict(),
    z.object({ type: z.literal('enabled'), target: Target }).strict(),
    z
      .object({
        type: z.literal('text'),
        target: Target,
        text: z.string(),
        match: TextMatch.optional(),
      })
      .strict(),
    z.object({ type: z.literal('settled') }).strict(),
    z.object({ type: z.literal('all'), of: z.array(Condition).min(1) }).strict(),
    z.object({ type: z.literal('any'), of: z.array(Condition).min(1) }).strict(),
  ]),
);

/** Stable one-line rendering, for checkpoint failure messages and drift reports. */
export function describeCondition(c: Condition): string {
  switch (c.type) {
    case 'settled':
      return 'surface settled';
    case 'present':
      return `present(${describeTarget(c.target)})`;
    case 'absent':
      return `absent(${describeTarget(c.target)})`;
    case 'enabled':
      return `enabled(${describeTarget(c.target)})`;
    case 'text':
      return `text(${describeTarget(c.target)}) ${c.match ?? 'exact'} "${c.text}"`;
    case 'all':
      return `all(${c.of.map(describeCondition).join(', ')})`;
    case 'any':
      return `any(${c.of.map(describeCondition).join(', ')})`;
  }
}

/** Every Target mentioned anywhere in a condition tree, for the drift probe. */
export function targetsOf(c: Condition): Target[] {
  switch (c.type) {
    case 'settled':
      return [];
    case 'present':
    case 'absent':
    case 'enabled':
    case 'text':
      return [c.target];
    case 'all':
    case 'any':
      return c.of.flatMap(targetsOf);
  }
}
