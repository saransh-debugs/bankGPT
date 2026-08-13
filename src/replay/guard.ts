/**
 * ENFORCING "NO MODEL IN THE REPLAY DECISION LOOP".
 *
 * The brief's central requirement is that replay runs WITHOUT invoking the LLM
 * for decisions. That is easy to claim and easy to believe about your own code,
 * so this module makes it checkable three different ways — because each one on
 * its own has a hole:
 *
 *   1. A REAL COUNTER (`recordModelCall`). Incremented by the one module that
 *      is allowed to talk to a model. `modelCalls` on every result comes from
 *      here.
 *
 *      Why it matters: a `modelCalls: 0` field that is a hardcoded literal makes
 *      any test asserting it TAUTOLOGICAL — the assertion passes because the
 *      constant says so, not because nothing happened. So the counter must be
 *      observable in both directions, and `tests/no-model.test.ts` asserts both:
 *      that replay leaves it at zero, AND that it actually increments when a
 *      model call is recorded. A counter that can only ever read zero proves
 *      nothing.
 *
 *   2. A RUNTIME EGRESS GUARD (`withReplayGuard`). While a replay is in flight,
 *      `fetch` is wrapped and any request to a known model-provider host throws.
 *      This catches what static reasoning cannot: a dynamic `await import()`, a
 *      transitive dependency phoning home, a stray SDK construction inside a
 *      code path nobody read.
 *
 *   3. A TRANSITIVE IMPORT-GRAPH ASSERTION (in `tests/no-model.test.ts`). Walks
 *      every module reachable from the engine and fails if any of them can even
 *      resolve a provider SDK. A single-file regex over the engine source would
 *      miss a client reached one hop away, which is exactly the hole worth
 *      closing.
 *
 * Note what this module deliberately does NOT import: no provider SDK, no
 * discovery code. It is imported BY the engine, so anything it imported would
 * land in the engine's import graph and break requirement 3. The counter lives
 * here; the SDK lives only in src/discovery/, which imports this and calls
 * `recordModelCall()` before each request.
 */

/** Hosts that mean "a model is being consulted". */
const MODEL_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'openrouter.ai',
  'bedrock-runtime',
  'aws-external-anthropic',
  'api.together.xyz',
  'api.groq.com',
];

let modelCallCount = 0;
let replayDepth = 0;

/** Raised when something tries to consult a model inside a guarded replay. */
export class ModelCallInReplayError extends Error {
  constructor(url: string) {
    super(
      `a model API was called during deterministic replay: ${url}. ` +
        `Replay must contain no model in the decision loop.`,
    );
    this.name = 'ModelCallInReplayError';
  }
}

/**
 * Called by src/discovery/ immediately before each model request.
 *
 * Throws if a replay is in flight, so the failure is loud and local rather than
 * an anomalous number noticed later in a log.
 */
export function recordModelCall(): void {
  if (replayDepth > 0) {
    throw new ModelCallInReplayError('<recordModelCall inside guarded replay>');
  }
  modelCallCount += 1;
}

export function modelCalls(): number {
  return modelCallCount;
}

/** Test-only: reset the counter between cases. */
export function __resetModelCalls(): void {
  modelCallCount = 0;
}

export function isReplayGuardActive(): boolean {
  return replayDepth > 0;
}

function hostIsModelProvider(url: string): boolean {
  const lower = url.toLowerCase();
  return MODEL_HOSTS.some((h) => lower.includes(h));
}

/**
 * Run a replay with the egress guard installed.
 *
 * Returns the model-call delta observed across the run alongside the result, so
 * the engine can put a MEASURED number on the result rather than a constant.
 * Reentrant (nested replays keep the guard installed exactly once) and restores
 * the original `fetch` on both success and failure.
 */
export async function withReplayGuard<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; modelCallsDuring: number }> {
  const before = modelCallCount;
  const originalFetch = globalThis.fetch;
  const outermost = replayDepth === 0;

  if (outermost) {
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input === 'object' && input !== null && 'url' in input
              ? String((input as { url: unknown }).url)
              : String(input);

      if (hostIsModelProvider(url)) throw new ModelCallInReplayError(url);

      return (originalFetch as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
    }) as typeof globalThis.fetch;
  }

  replayDepth += 1;
  try {
    const result = await fn();
    return { result, modelCallsDuring: modelCallCount - before };
  } finally {
    replayDepth -= 1;
    if (outermost) globalThis.fetch = originalFetch;
  }
}

/** Exported for the import-graph test, so the denylist has a single source. */
export const __MODEL_HOSTS = MODEL_HOSTS;
