/**
 * BLOCK UNTIL THE STACK IS ACTUALLY USABLE.
 *
 * `docker compose up -d` returns as soon as the containers are *started*, which
 * on this stack is 10-15 minutes before they are *ready*: Fineract runs several
 * hundred Liquibase migrations on a fresh volume and is silent the whole time.
 * Without this script the documented demo path is "run seed and hope", and the
 * failure mode is a connection-refused that looks like a broken setup rather
 * than an unfinished boot.
 *
 * Readiness is defined as BOTH surfaces answering, because both are automated:
 *   - the Fineract API on 8443, which `npm run seed` writes through
 *   - the Mifos web app on 4200, which the web adapter drives
 *
 * A container reporting `healthy` is not sufficient evidence for either — the
 * check here is an actual request to the actual port, which is the same thing
 * the adapter will do.
 *
 * TLS: 8443 serves a self-signed certificate. As in scripts/seed.ts the
 * exception is scoped to one agent rather than set process-wide, so nothing
 * else loses certificate validation.
 */

import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const BASE = process.env.FINERACT_BASE_URL ?? 'https://localhost:8443';
const WEB_APP = process.env.WEB_APP_URL ?? 'http://localhost:4200';
const TENANT = process.env.FINERACT_TENANT ?? 'default';

/** Scoped to this client only — see the file header. */
const agent = new Agent({ rejectUnauthorized: false, keepAlive: false });

const TIMEOUT_MS = Number(process.env.WAIT_READY_TIMEOUT_MS ?? 20 * 60 * 1000);
const POLL_MS = 5_000;
const PER_REQUEST_MS = 10_000;

/**
 * Any HTTP response means the port is serving. A 401 from Fineract is a
 * SUCCESS for this purpose — it proves the application is up and enforcing
 * auth, which is strictly more information than a 200 from a health endpoint
 * that might be served before the app finished starting.
 */
function probe(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        ...(isHttps ? { agent } : {}),
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { 'Fineract-Platform-TenantId': TENANT },
        timeout: PER_REQUEST_MS,
      },
      (res) => {
        res.resume(); // drain, we only care about the status line
        resolve(res.statusCode ?? null);
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Check {
  label: string;
  url: string;
  ok: (status: number | null) => boolean;
}

const CHECKS: Check[] = [
  {
    label: 'fineract api',
    url: `${BASE}/fineract-provider/api/v1/offices?tenantIdentifier=${TENANT}`,
    // 401 = up and demanding credentials. 200 = up and (unusually) open.
    // Anything else, including a 5xx from a half-migrated instance, is not ready.
    ok: (s) => s === 401 || s === 200,
  },
  {
    label: 'mifos web app',
    url: WEB_APP,
    ok: (s) => s !== null && s < 500,
  },
];

async function main(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  const pending = new Set(CHECKS.map((c) => c.label));

  process.stdout.write(
    `waiting for the stack (timeout ${Math.round(TIMEOUT_MS / 60000)}m)\n` +
      `  a FIRST boot runs several hundred Liquibase migrations and is silent for 10-15 minutes;\n` +
      `  follow it with: npm run logs\n\n`,
  );

  let tick = 0;
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      process.stderr.write(
        `\ntimed out after ${Math.round(TIMEOUT_MS / 60000)}m waiting for: ${[...pending].join(', ')}\n` +
          `check 'npm run logs'; an out-of-memory kill mid-migration leaves a corrupt\n` +
          `database, in which case 'npm run reset' and start again with >= 6 GB to Docker.\n`,
      );
      process.exit(1);
    }

    const results = await Promise.all(
      CHECKS.filter((c) => pending.has(c.label)).map(async (c) => ({
        check: c,
        status: await probe(c.url),
      })),
    );

    for (const { check, status } of results) {
      if (check.ok(status)) {
        pending.delete(check.label);
        process.stdout.write(`  ✓ ${check.label} (HTTP ${String(status)})\n`);
      }
    }

    if (pending.size === 0) break;

    // A progress line every ~30s. Silence for 15 minutes is indistinguishable
    // from a hang, which is the exact failure this script exists to remove.
    if (tick % 6 === 0) {
      const mins = ((Date.now() - (deadline - TIMEOUT_MS)) / 60000).toFixed(1);
      process.stdout.write(`  … ${mins}m elapsed, still waiting for: ${[...pending].join(', ')}\n`);
    }
    tick++;
    await sleep(POLL_MS);
  }

  process.stdout.write(`\nstack ready. next: npm run seed\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`wait-ready failed: ${String(e)}\n`);
  process.exit(1);
});
