/**
 * THE OPERATOR CHANNEL — how a parked run reaches a human, and gets back.
 *
 * The brief permits mocking the operator UI and asks that the HANDOFF MECHANISM
 * and the control-transfer model be real. This file is the mechanism; there is
 * no console, and that boundary is stated rather than blurred.
 *
 * It is a directory of files, deliberately:
 *
 *     <dir>/<interventionId>.request.json    written by the run, describes the stop
 *     <dir>/<interventionId>.release.json    written by the operator, hands control back
 *
 * A queue or a socket would be more impressive and would demonstrate nothing
 * extra. What has to be true is that the automation stops, a human works in the
 * SAME live session, and the run only continues once it has re-checked where it
 * is. A filesystem rendezvous makes all three observable — you can watch the
 * request appear, take over the browser or the terminal yourself, and drop a
 * file to release it — and it works identically for a CLI, a cron job, or a web
 * console someone builds later against the same two files.
 *
 * WHAT THIS DOES NOT DO. It does not drive the surface on the operator's
 * behalf. The human uses the real window: the headed browser the run already
 * opened, or the terminal host's stdio. That is the point of `pause()` keeping
 * the session alive — a channel that replayed the human's clicks would be a
 * second automation, not a handoff.
 */

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { InterventionOutcome, InterventionRequest } from '../replay/engine.js';
import type { Redactor } from '../policy/redact.js';

export interface OperatorChannelOptions {
  dir: string;
  /** How long to wait for a human before giving up. */
  timeoutMs?: number;
  pollMs?: number;
  /** Applied to the request before it is written — an operator brief is evidence. */
  redact?: Redactor;
  /** Called once when the run parks, so a CLI can print something useful. */
  onWaiting?: (req: InterventionRequest, path: string) => void;
}

export interface ReleaseRecord {
  interventionId: string;
  operatorId: string;
  releasedAt: string;
  /** What the human says they did. Free text; the state delta is computed, not trusted. */
  note?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function requestPath(dir: string, id: string): string {
  return join(dir, `${id}.request.json`);
}
export function releasePath(dir: string, id: string): string {
  return join(dir, `${id}.release.json`);
}

/**
 * Build the `escalate` handler the replay engine calls when it parks.
 *
 * Returns an InterventionOutcome once a release file appears. `snapshotTextAfter`
 * is left EMPTY on purpose: the adapter refuses to observe while the operator
 * holds the lease, and the engine re-observes immediately after `resume()`
 * anyway. Having the channel guess at the after-state would mean the recorded
 * state delta was computed from something other than what the run actually saw
 * on resuming.
 */
export function fileOperatorChannel(
  opts: OperatorChannelOptions,
): (req: InterventionRequest) => Promise<InterventionOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 1_000;

  return async (req: InterventionRequest): Promise<InterventionOutcome> => {
    await mkdir(opts.dir, { recursive: true });
    const rPath = requestPath(opts.dir, req.interventionId);
    const body = JSON.stringify(req, null, 2) + '\n';
    await writeFile(rPath, opts.redact ? opts.redact(body) : body, 'utf8');

    opts.onWaiting?.(req, rPath);

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    for (;;) {
      const raw = await readFile(releasePath(opts.dir, req.interventionId), 'utf8').catch(
        () => undefined,
      );
      if (raw !== undefined) {
        const rel = JSON.parse(raw) as ReleaseRecord;
        return {
          ...(rel.operatorId ? { operatorId: rel.operatorId } : {}),
          snapshotTextAfter: '',
          heldMs: Date.now() - startedAt,
        };
      }
      if (Date.now() > deadline) {
        // Time out rather than block forever. The engine treats a failed
        // resync as `escalation-unanswered`; an unanswered request is the same
        // class of problem and must not leave a session pinned open.
        throw new Error(
          `no operator released intervention ${req.interventionId} within ` +
            `${Math.round(timeoutMs / 1000)}s (${releasePath(opts.dir, req.interventionId)})`,
        );
      }
      await sleep(pollMs);
    }
  };
}

/** Parked interventions awaiting a human, newest first. */
export async function listPending(dir: string): Promise<InterventionRequest[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: InterventionRequest[] = [];
  for (const f of files.filter((x) => x.endsWith('.request.json'))) {
    const id = f.replace(/\.request\.json$/, '');
    // A request with a matching release has already been handed back.
    if (files.includes(`${id}.release.json`)) continue;
    const raw = await readFile(join(dir, f), 'utf8').catch(() => undefined);
    if (raw) out.push(JSON.parse(raw) as InterventionRequest);
  }
  return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/**
 * Hand control back.
 *
 * Writing this file is the ONLY thing that releases the lease. It is a
 * deliberate, attributable act by a named person — which is why `operatorId` is
 * required rather than defaulted: an unattributed release of a paused banking
 * session is not something this system should make easy.
 */
export async function release(
  dir: string,
  interventionId: string,
  operatorId: string,
  note?: string,
): Promise<ReleaseRecord> {
  const rec: ReleaseRecord = {
    interventionId,
    operatorId,
    releasedAt: new Date().toISOString(),
    ...(note === undefined ? {} : { note }),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(releasePath(dir, interventionId), JSON.stringify(rec, null, 2) + '\n', 'utf8');
  return rec;
}

/** Remove a resolved pair. Used by tests and by an operator tidying up. */
export async function clear(dir: string, interventionId: string): Promise<void> {
  await rm(requestPath(dir, interventionId), { force: true });
  await rm(releasePath(dir, interventionId), { force: true });
}
