/**
 * FIXTURE — deliberately imports a provider SDK.
 *
 * Nothing in src/ imports this file. It exists so that
 * `tests/no-model.test.ts` can prove its import-graph walker actually DETECTS a
 * provider SDK. Without a positive control, "the walker found no SDK on the
 * replay path" is indistinguishable from "the walker finds nothing, ever" — and
 * a test that cannot fail is not evidence.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type Anthropic from '@anthropic-ai/sdk';

export type NotUsed = Anthropic;
