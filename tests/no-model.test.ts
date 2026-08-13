/**
 * PROVING "NO MODEL IN THE REPLAY DECISION LOOP".
 *
 * This is the requirement most easily claimed and least often demonstrated, so
 * it is attacked from three directions, each closing a hole the others leave:
 *
 *   1. TRANSITIVE IMPORT GRAPH. Not a regex over one file — a walk of every
 *      module reachable from the engine. A single-file scan passes happily while
 *      a provider client sits one hop away in a helper.
 *
 *   2. THE COUNTER IS OBSERVABLE IN BOTH DIRECTIONS. Asserting `modelCalls === 0`
 *      proves nothing if the field is a hardcoded zero — the test would be
 *      tautological, passing because of a constant rather than because nothing
 *      happened. So one case asserts it INCREMENTS when a model call is
 *      recorded, and another asserts a real replay leaves it at zero.
 *
 *   3. RUNTIME EGRESS. Even a clean import graph cannot rule out a dynamic
 *      `await import()` or a transitive dependency phoning home, so the guard
 *      also fails the run if a provider host is dialled while a replay is in
 *      flight.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ModelCallInReplayError,
  __resetModelCalls,
  isReplayGuardActive,
  modelCalls,
  recordModelCall,
  withReplayGuard,
} from '../src/replay/guard.js';
import { TerminalAdapter } from '../src/adapter/terminal.js';
import { replay } from '../src/replay/engine.js';
import { Capability } from '../src/schema/capability.js';

/** Bare specifiers that mean "this module can talk to a model". */
const PROVIDER_SDKS = [
  '@anthropic-ai/sdk',
  'openai',
  '@google/generative-ai',
  '@google-cloud/aiplatform',
  'cohere-ai',
  '@mistralai/mistralai',
  'langchain',
  '@langchain/core',
  'ollama',
];

const IMPORT_RE = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Walk every module reachable from an entry file, returning the set of bare
 * (non-relative) specifiers encountered anywhere in the graph.
 *
 * Imports are written with `.js` extensions for ESM correctness while the files
 * on disk are `.ts`, so resolution maps between them.
 */
async function transitiveBareImports(entry: string): Promise<{ bare: Set<string>; visited: string[] }> {
  const bare = new Set<string>();
  const visited: string[] = [];
  const seen = new Set<string>();

  const walk = async (file: string): Promise<void> => {
    const abs = resolvePath(file);
    if (seen.has(abs)) return;
    seen.add(abs);

    let src: string;
    try {
      src = await readFile(abs, 'utf8');
    } catch {
      return; // a specifier that does not resolve to a local file
    }
    visited.push(abs);

    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) {
        const candidate = spec.endsWith('.js') ? spec.replace(/\.js$/, '.ts') : `${spec}.ts`;
        await walk(resolvePath(dirname(abs), candidate));
      } else if (!spec.startsWith('node:')) {
        bare.add(spec);
      }
    }
  };

  await walk(entry);
  return { bare, visited };
}

describe('the replay path cannot reach a model — static', () => {
  it('imports no provider SDK anywhere in its transitive graph', async () => {
    const { bare, visited } = await transitiveBareImports('src/replay/engine.ts');

    // Sanity-check the walker itself: a graph of one file would make the
    // assertion below vacuous.
    expect(visited.length).toBeGreaterThan(4);

    const offenders = [...bare].filter((spec) =>
      PROVIDER_SDKS.some((sdk) => spec === sdk || spec.startsWith(`${sdk}/`)),
    );
    expect(offenders, `replay reaches provider SDK(s): ${offenders.join(', ')}`).toEqual([]);
  });

  it('POSITIVE CONTROL: the walker does detect a provider SDK when one is present', async () => {
    // Without this, "no SDK found on the replay path" is indistinguishable from
    // "this walker never finds anything". The fixture imports the SDK and
    // nothing in src/ imports the fixture.
    const { bare } = await transitiveBareImports('tests/fixtures/imports-a-model-sdk.ts');
    expect([...bare]).toContain('@anthropic-ai/sdk');
  });
});

describe('the model-call counter is real, not a constant', () => {
  beforeEach(() => {
    __resetModelCalls();
  });

  it('INCREMENTS when a model call is recorded', () => {
    expect(modelCalls()).toBe(0);
    recordModelCall();
    expect(modelCalls()).toBe(1);
    recordModelCall();
    expect(modelCalls()).toBe(2);
  });

  it('refuses to record a model call while a replay is in flight', async () => {
    await expect(
      withReplayGuard(async () => {
        expect(isReplayGuardActive()).toBe(true);
        recordModelCall();
      }),
    ).rejects.toThrow(ModelCallInReplayError);
  });

  it('reports zero for a real end-to-end replay', async () => {
    const cap = Capability.parse(
      JSON.parse(await readFile('capabilities/member.savings.balance.read.terminal.json', 'utf8')),
    );
    const adapter = new TerminalAdapter({ evidenceDir: 'evidence/scratch/test-no-model' });
    await adapter.start();
    try {
      const result = await replay({
        capability: cap,
        inputs: { memberId: '12345' },
        adapter,
        tenant: 'northridge',
        evidenceDir: 'evidence/scratch/test-no-model',
      });
      expect(result.kind).toBe('success');
      // Measured across the run, not read from a literal.
      expect(result.modelCalls).toBe(0);
    } finally {
      await adapter.close();
    }
  });
});

describe('runtime egress guard', () => {
  beforeEach(() => {
    __resetModelCalls();
  });

  it('throws if a provider host is dialled during a replay', async () => {
    await expect(
      withReplayGuard(async () => {
        await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
      }),
    ).rejects.toThrow(ModelCallInReplayError);
  });

  it('leaves non-provider hosts alone, and restores fetch afterwards', async () => {
    const original = globalThis.fetch;
    await withReplayGuard(async () => {
      expect(globalThis.fetch).not.toBe(original);
      // A localhost URL is allowed through the guard; it is expected to fail to
      // CONNECT, which is a different error than the guard's refusal.
      await expect(fetch('http://127.0.0.1:9/nothing')).rejects.not.toThrow(ModelCallInReplayError);
    });
    expect(globalThis.fetch).toBe(original);
  });

  it('restores fetch even when the guarded body throws', async () => {
    const original = globalThis.fetch;
    await expect(
      withReplayGuard(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(globalThis.fetch).toBe(original);
  });
});

afterAll(() => {
  __resetModelCalls();
});
