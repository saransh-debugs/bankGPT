/**
 * SEED THE FINERACT INSTANCE.
 *
 * Creates the test data the web capabilities are recorded against: a savings
 * product, several members with activated savings accounts and deposited
 * balances, plus a deliberately UNDER-PRIVILEGED login.
 *
 * That last one matters. A permission denial is one of the runtime conditions
 * the brief asks a replay to handle, and there is a real difference between
 * simulating one and provoking one. Fineract's RBAC is enforced backend-side and
 * is always on, so creating a role WITHOUT `READ_SAVINGSACCOUNT` and logging in
 * as it produces a genuine 403 from the product itself. (An earlier plan called
 * for a `MIFOS_PRODUCTION_MODE_ENABLE_RBAC` switch; no such setting exists — and
 * the real mechanism is better evidence than the switch would have been.)
 *
 * TLS: the instance serves a self-signed certificate on 8443. The exception is
 * scoped to the one HTTPS agent below rather than set process-wide via
 * NODE_TLS_REJECT_UNAUTHORIZED, so nothing else in the process loses
 * certificate validation. Playwright gets the same treatment via
 * `ignoreHTTPSErrors` on its context only.
 */

import { Agent, request as httpsRequest } from 'node:https';
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = process.env.FINERACT_BASE_URL ?? 'https://localhost:8443';
const API = `${BASE}/fineract-provider/api/v1`;
const TENANT = process.env.FINERACT_TENANT ?? 'default';
const USER = process.env.FINERACT_USER ?? 'mifos';
const PASS = process.env.FINERACT_PASSWORD ?? 'password';

const LIMITED_USER = process.env.FINERACT_LIMITED_USER ?? 'teller_readonly';
const LIMITED_PASS = process.env.FINERACT_LIMITED_PASSWORD ?? 'Northridge#2026';

/** Scoped to this client only — see the file header. */
const agent = new Agent({ rejectUnauthorized: false, keepAlive: true });

const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

interface ApiError {
  status: number;
  body: string;
}

function api<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API}${path}`);
    url.searchParams.set('tenantIdentifier', TENANT);
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const req = httpsRequest(
      {
        agent,
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          Authorization: auth,
          'Fineract-Platform-TenantId': TENANT,
          ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve((data === '' ? {} : JSON.parse(data)) as T);
          } else {
            reject({ status, body: data } as ApiError);
          }
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const isApiError = (e: unknown): e is ApiError =>
  typeof e === 'object' && e !== null && 'status' in e && 'body' in e;

/**
 * Run a create that may already have happened. Seeding is re-run constantly
 * while recording flows, so "already exists" must not be fatal.
 */
async function idempotent<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const out = await fn();
    process.stdout.write(`  + ${label}\n`);
    return out;
  } catch (e) {
    if (isApiError(e) && (e.status === 403 || e.status === 400)) {
      const dup = /already|exists|duplicate|unique/i.test(e.body);
      process.stdout.write(`  ${dup ? '=' : '!'} ${label}${dup ? ' (exists)' : ` -> ${e.status} ${e.body.slice(0, 160)}`}\n`);
      return null;
    }
    throw e;
  }
}

/**
 * Fineract requires an explicit dateFormat + locale on bodies that CARRY A DATE,
 * and rejects them as "parameter not supported" on bodies that do not. So this
 * is applied per-endpoint rather than blanket-wrapped: savings-product creation
 * has no date field and 400s if you send them, while client activation and every
 * savings-account command require them.
 */
const DATE_FORMAT = 'dd MMMM yyyy';
const LOCALE = 'en';
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
function fmtDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
const dated = <T extends object>(o: T) => ({ ...o, dateFormat: DATE_FORMAT, locale: LOCALE });

interface Member {
  firstname: string;
  lastname: string;
  deposit: number;
}

/**
 * Deliberately mirrors the terminal host's member list. The SAME capability
 * structure is recorded against both surfaces, so having comparable records on
 * each makes the two runs directly comparable.
 */
const MEMBERS: Member[] = [
  { firstname: 'Janet', lastname: 'Okonkwo', deposit: 4250 },
  { firstname: 'Marcus', lastname: 'Reyes', deposit: 812.44 },
  { firstname: 'Priya', lastname: 'Natarajan', deposit: 15004.19 },
  { firstname: 'Tobias', lastname: 'Ferreira', deposit: 1200 },
];

async function main(): Promise<void> {
  process.stdout.write(`seeding ${API} (tenant=${TENANT})\n`);

  // --- reachability + auth --------------------------------------------------
  const me = await api<{ username: string; officeId: number }>('POST', '/authentication', {
    username: USER,
    password: PASS,
  });
  process.stdout.write(`  authenticated as ${me.username} (office ${me.officeId})\n`);
  const officeId = me.officeId ?? 1;
  const today = fmtDate(new Date());

  // --- currency -------------------------------------------------------------
  // A savings product needs an ENABLED currency. Read what is permitted rather
  // than assuming USD is already on.
  const currencies = await api<{ selectedCurrencyOptions: Array<{ code: string }> }>(
    'GET',
    '/currencies',
  );
  const enabled = (currencies.selectedCurrencyOptions ?? []).map((c) => c.code);
  if (!enabled.includes('USD')) {
    await idempotent('enable USD', () =>
      api('PUT', '/currencies', { currencies: [...enabled, 'USD'] }),
    );
  } else {
    process.stdout.write(`  = USD already enabled\n`);
  }

  // --- savings product ------------------------------------------------------
  const products = await api<Array<{ id: number; name: string }>>('GET', '/savingsproducts');
  let productId = products.find((p) => p.name === 'Regular Savings')?.id;
  if (productId === undefined) {
    const created = await api<{ resourceId: number }>('POST', '/savingsproducts', {
      // No dateFormat/locale here — see the note above `dated`. `locale` alone is
      // still needed so the decimal interest rate parses.
      locale: LOCALE,
      name: 'Regular Savings',
      shortName: 'RSAV',
      description: 'Regular member savings account',
      currencyCode: 'USD',
      digitsAfterDecimal: 2,
      inMultiplesOf: 0,
      nominalAnnualInterestRate: 1.5,
      interestCompoundingPeriodType: 1,
      interestPostingPeriodType: 4,
      interestCalculationType: 1,
      interestCalculationDaysInYearType: 365,
      accountingRule: 1,
    });
    productId = created.resourceId;
    process.stdout.write(`  + savings product 'Regular Savings' (${productId})\n`);
  } else {
    process.stdout.write(`  = savings product 'Regular Savings' (${productId})\n`);
  }

  // --- payment type ---------------------------------------------------------
  // A savings deposit requires a paymentTypeId. Discover a real one rather than
  // hardcoding an id that varies between installs.
  const paymentTypes = await api<Array<{ id: number; name: string }>>('GET', '/paymenttypes');
  let paymentTypeId = paymentTypes[0]?.id;
  if (paymentTypeId === undefined) {
    const pt = await api<{ resourceId: number }>('POST', '/paymenttypes', {
      name: 'Cash',
      description: 'Cash deposit at branch',
      isCashPayment: true,
      position: 1,
    });
    paymentTypeId = pt.resourceId;
    process.stdout.write(`  + payment type Cash (${paymentTypeId})\n`);
  } else {
    process.stdout.write(`  = payment type ${paymentTypes[0]?.name} (${paymentTypeId})\n`);
  }

  // --- members + accounts ---------------------------------------------------
  const seeded: Array<{ clientId: number; name: string; accountNo: string; balance: number }> = [];

  for (const m of MEMBERS) {
    const existing = await api<{ pageItems: Array<{ id: number; displayName: string }> }>(
      'GET',
      `/clients?sqlSearch=&displayName=${encodeURIComponent(m.lastname)}`,
    ).catch(() => ({ pageItems: [] }));

    let clientId = existing.pageItems?.find((c) => c.displayName.includes(m.lastname))?.id;

    if (clientId === undefined) {
      const c = await api<{ clientId: number }>(
        'POST',
        '/clients',
        dated({
          officeId,
          firstname: m.firstname,
          lastname: m.lastname,
          legalFormId: 1,
          active: true,
          activationDate: today,
        }),
      );
      clientId = c.clientId;
      process.stdout.write(`  + client ${m.firstname} ${m.lastname} (${clientId})\n`);
    } else {
      process.stdout.write(`  = client ${m.firstname} ${m.lastname} (${clientId})\n`);
    }

    // CONVERGE to the intended state rather than skipping when an account
    // already exists. A previous partial run can leave an account created but
    // not activated, or activated with no deposit — and silently skipping that
    // makes fixtures/seeded.json claim a balance the instance does not have,
    // which would then be baked into a capability's expected output.
    type Accounts = { savingsAccounts?: Array<{ id: number; accountNo: string; status: { id: number } }> };
    const accts = await api<Accounts>('GET', `/clients/${clientId}/accounts`).catch(
      (): Accounts => ({}),
    );

    let savingsId = accts.savingsAccounts?.[0]?.id;
    if (savingsId === undefined) {
      const s = await api<{ savingsId: number }>(
        'POST',
        '/savingsaccounts',
        dated({ clientId, productId, submittedOnDate: today }),
      );
      savingsId = s.savingsId;
      process.stdout.write(`  + savings account for ${m.lastname} (${savingsId})\n`);
    }

    // Fineract savings status ids: 100 submitted, 200 approved, 300 active.
    let detail = await api<{
      accountNo: string;
      status: { id: number };
      summary?: { accountBalance?: number };
    }>('GET', `/savingsaccounts/${savingsId}`);

    if (detail.status.id < 200) {
      await api('POST', `/savingsaccounts/${savingsId}?command=approve`, dated({ approvedOnDate: today }));
      process.stdout.write(`  + approved ${detail.accountNo}\n`);
    }
    if (detail.status.id < 300) {
      await api('POST', `/savingsaccounts/${savingsId}?command=activate`, dated({ activatedOnDate: today }));
      process.stdout.write(`  + activated ${detail.accountNo}\n`);
      detail = await api('GET', `/savingsaccounts/${savingsId}`);
    }

    const balance = detail.summary?.accountBalance ?? 0;
    if (balance < m.deposit) {
      const topUp = m.deposit - balance;
      await api(
        'POST',
        `/savingsaccounts/${savingsId}/transactions?command=deposit`,
        dated({ transactionDate: today, transactionAmount: topUp, paymentTypeId }),
      );
      process.stdout.write(`  + deposited ${topUp} to ${detail.accountNo} (was ${balance})\n`);
      detail = await api('GET', `/savingsaccounts/${savingsId}`);
    } else {
      process.stdout.write(`  = savings ${detail.accountNo} for ${m.lastname} balance ${balance}\n`);
    }

    // Record the ACTUAL balance the instance holds, never the intended one.
    seeded.push({
      clientId,
      name: `${m.firstname} ${m.lastname}`,
      accountNo: detail.accountNo,
      balance: detail.summary?.accountBalance ?? 0,
    });
  }

  // --- under-privileged login, for a GENUINE 403 ----------------------------
  const roles = await api<Array<{ id: number; name: string }>>('GET', '/roles');
  let roleId = roles.find((r) => r.name === 'TellerReadOnly')?.id;
  if (roleId === undefined) {
    const r = await api<{ resourceId: number }>('POST', '/roles', {
      name: 'TellerReadOnly',
      description: 'Can read clients but NOT savings accounts — used to provoke a real 403.',
    });
    roleId = r.resourceId;
    // Grant only client reads. Omitting READ_SAVINGSACCOUNT is the whole point.
    await idempotent('grant READ_CLIENT only', () =>
      api('PUT', `/roles/${roleId}/permissions`, {
        permissions: { READ_CLIENT: true, READ_OFFICE: true },
      }),
    );
    process.stdout.write(`  + role TellerReadOnly (${roleId})\n`);
  } else {
    process.stdout.write(`  = role TellerReadOnly (${roleId})\n`);
  }

  await idempotent(`user ${LIMITED_USER}`, () =>
    api('POST', '/users', {
      username: LIMITED_USER,
      firstname: 'Read',
      lastname: 'Only',
      email: 'readonly@northridge.test',
      officeId,
      roles: [roleId],
      sendPasswordToEmail: false,
      password: LIMITED_PASS,
      repeatPassword: LIMITED_PASS,
    }),
  );

  // --- record what was seeded ----------------------------------------------
  // Capabilities are recorded against these values, so they are written down
  // rather than left implicit in whatever the database happens to hold.
  await mkdir('fixtures', { recursive: true });
  await writeFile(
    'fixtures/seeded.json',
    JSON.stringify({ seededAt: new Date().toISOString(), baseUrl: BASE, tenant: TENANT, productId, members: seeded }, null, 2) + '\n',
    'utf8',
  );

  process.stdout.write(`\nseeded ${seeded.length} members -> fixtures/seeded.json\n`);
  for (const s of seeded) {
    process.stdout.write(`  client ${s.clientId}  ${s.name}  ${s.accountNo}  ${s.balance}\n`);
  }
}

main().catch((e: unknown) => {
  if (isApiError(e)) {
    process.stderr.write(`\nseed failed: HTTP ${e.status}\n${e.body.slice(0, 900)}\n`);
  } else {
    process.stderr.write(`\nseed failed: ${String(e)}\n`);
  }
  process.exit(1);
});
