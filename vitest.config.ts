import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The terminal adapter spawns a real host process; the web adapter drives a
    // real browser. Both are integration tests on purpose — a resolver tested
    // only against a hand-built fixture proves very little about whether it can
    // perceive a real surface.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Serial: the suite starts host processes and (later) a browser, and
    // parallel workers competing for them makes failures non-deterministic.
    fileParallelism: false,
  },
});
