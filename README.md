# Computer-Use Automation System

An LLM discovers how to complete a task inside a UI that has no API. The successful run is
compiled into a typed, versioned **capability**. That capability is then replayed
deterministically, with **no model in the decision loop**.

The submission's argument is one line long:

> The same capability — same id, same anchors, same relations, same engine — replays against
> a modern web application **and** against an 80×24 character grid that has no DOM, no
> accessibility tree, no roles and no names.

```
$ npm run replay -- capabilities/member.savings.balance.read.web.json --memberId 000000001
SUCCESS member.savings.balance.read@1.0.0 [web/default] memberName=Janet Okonkwo … savingsBalance=4250.00
  modelCalls=0

$ npm run replay -- capabilities/member.savings.balance.read.terminal.json --memberId 12345
SUCCESS member.savings.balance.read@1.0.0 [terminal/northridge] memberName=OKONKWO, JANET A … savingsBalance=4250.00
  modelCalls=0
```

Design rationale is in **[REPORT.md](REPORT.md)**. Evidence from real runs is in
**[evidence/](evidence/)**.

---

## Setup

Requires Node ≥ 20.11 and Docker (≥ 6 GB / 4 CPU allocated).

```bash
npm install
npx playwright install chromium
cp .env.example .env          # then edit — see "Configuration" below
```

### Bring up the target application

The primary surface is **Apache Fineract + the Mifos X web app** — a real open-source core
banking platform, chosen over a self-authored mock so the failure modes belong to the
product rather than to us.

```bash
npm run up          # docker compose: postgres + fineract + web-app
npm run wait-ready  # blocks until BOTH surfaces answer; see note below
npm run seed        # creates members, savings accounts, and an under-privileged login
```

> **First boot takes 10–15 minutes and is silent.** Fineract runs several hundred Liquibase
> migrations on a fresh volume. `npm run wait-ready` polls both ports and prints progress so
> the wait is distinguishable from a hang; follow along with `npm run logs`. An
> out-of-memory kill mid-migration leaves a corrupt database — if that happens,
> `npm run reset` and start again with more memory allocated to Docker.

### Configuration

Everything lives in `.env` (gitignored; `.env.example` documents each key).

| Variable | Needed for | Notes |
|---|---|---|
| `WEB_APP_URL`, `FINERACT_*` | replay against the web surface | Defaults match the compose file |
| `FINERACT_USER` / `FINERACT_PASSWORD` | replay against the web surface | Resolved at replay time for `redact: true` steps. **Never stored in an artifact** |
| `ANTHROPIC_API_KEY` | `npm run discover` only | Preferred provider |
| `OPENROUTER_API_KEY` | `npm run discover` only | Fallback. Any OpenAI-compatible gateway |

Only `discover` needs a model. **Replay never reads a model key**, and that is enforced
rather than promised — see [No model in the replay path](#no-model-in-the-replay-path).

---

## Running without live services

The **terminal surface needs no configuration and no Docker at all.** It is a local
character-grid host, so the full loop — capability, replay, business outcomes, evidence —
runs immediately after `npm install`:

```bash
npm run replay -- capabilities/member.savings.balance.read.terminal.json --memberId 12345
npm test
```

`npm test` is likewise hermetic: the web half of the conformance suite runs against a small
static page the test serves itself, so the suite never fails because a container is down.

---

## Demo path

```bash
# 1. Both capabilities parse and lint
npm run validate

# 2. Replay on a REAL web application — no model
npm run replay -- capabilities/member.savings.balance.read.web.json --memberId 000000001
#    → SUCCESS … savingsBalance=4250.00   modelCalls=0     exit 0

# 3. The SAME capability id on a character grid — no DOM, no roles, no names
npm run replay -- capabilities/member.savings.balance.read.terminal.json --memberId 12345
#    → SUCCESS … savingsBalance=4250.00   modelCalls=0     exit 0

# 4. A business outcome is not a crash
npm run replay -- capabilities/member.savings.balance.read.web.json --memberId 000009999
#    → OUTCOME MEMBER_NOT_FOUND                             exit 3

# 5. Record a NEW capability with an LLM, then replay it with no model
npm run discover -- --goal "look up member 000000001 and read their current savings balance" \
  --surface web --memberId 000000001 --id member.savings.balance.read
npm run replay -- capabilities/member.savings.balance.read.web.draft.json --memberId 000000002
#    → SUCCESS savingsBalance=812.44   modelCalls=0
#    a member the recording NEVER saw — the param anchor is what generalises it

# 6. ONE artifact, TWO institutions — Summit FCU's panel is in Spanish
npm run replay -- capabilities/member.savings.balance.read.terminal.json --memberId 12345 \
  --tenant summit --override capabilities/overrides/summit.member.savings.balance.read.json
#    → SUCCESS … savingsBalance=4250.00   modelCalls=0
#    six lexicon entries, 0% of steps patched, artifact unchanged

# 7. Human-in-the-loop: park a stuck run, take over, hand it back
npm run replay -- <capability> --escalate --operator-dir evidence/interventions
npm run operator                                    # list parked interventions
npm run operator -- release <id> --by "your name"   # hand control back

# 8. The claims, as executable assertions
npm test
```

### Recording a new capability with an LLM

```bash
npm run discover -- \
  --goal "look up member 000000001 and read their current savings balance" \
  --surface web \
  --memberId 000000001 \
  --id member.savings.balance.read

# → evidence/discovery/{trace.json,transcript.json,discovery.log}
# → capabilities/member.savings.balance.read.web.draft.json   (approvalState: draft)

npm run replay -- capabilities/member.savings.balance.read.web.draft.json --memberId 000000001
npm run approve -- capabilities/member.savings.balance.read.web.draft.json --by "your name"
```

Any `--flag value` that is not a known option is passed through as a sample parameter
value, so the recording is parameterised on it. The compiler rewrites every occurrence to
`{{inputs.memberId}}` and stores a **fingerprint** of the sample value, never the value.

---

## Commands

| Command | What it does | Model? |
|---|---|---|
| `npm run up` / `down` / `reset` / `logs` | Manage the Fineract stack | — |
| `npm run wait-ready` | Block until both surfaces answer | — |
| `npm run seed` | Create members, savings accounts, and an under-privileged login | — |
| `npm run validate` | Parse and lint every capability and tenant override | — |
| `npm run discover` | LLM-driven recording → draft capability | **yes** |
| `npm run replay` | Deterministic replay | no |
| `npm run approve` | draft → approved | — |
| `npm run operator` | List / release parked interventions | — |
| `npm run terminal` | Run the character-grid host on its own | — |
| `npm test` / `npm run typecheck` | Suite (115 tests) / types | — |

### Exit codes

A shell has to be able to tell a real answer from a crash, so the CLI distinguishes them:

| Code | Meaning |
|---|---|
| `0` | success, with typed outputs |
| `3` | a declared **business outcome** — e.g. `MEMBER_NOT_FOUND`. A legitimate answer |
| `4` | parked awaiting a human operator |
| `1` | failure — step, expected, observed |
| `2` | usage or artifact-load error |

### Replay options

```
--tenant <name>     replay as a given tenant
--override <file>   apply a tenant override (copy/locator patch + lexicon)
--attended          a human is watching (permits irreversible drafts)
--headed            web only: show the browser
--escalate          bring a human in when stuck, instead of failing
--operator-dir <d>  where intervention requests are exchanged
--evidence <dir>    where to write evidence
--<param> <value>   any declared capability input
```

---

## No model in the replay path

The central requirement is easy to claim, so it is attacked three ways, each closing a hole
the others leave:

1. **A transitive import-graph walk** from the engine fails if any reachable module can even
   resolve a provider SDK. A single-file regex would miss a client one hop away.
2. **A measured counter**, printed on every run as `modelCalls=`. It is asserted in *both*
   directions — one test proves it increments when a call is recorded, another proves a real
   replay leaves it at zero. A field hardcoded to `0` would make the assertion tautological.
3. **A runtime egress guard** wraps `fetch` during replay and throws if a known model-provider
   host is dialled — catching a dynamic import or a dependency phoning home, which static
   reasoning cannot.

---

## Layout

```
capabilities/     the artifacts. Two files, ONE capability id, two surfaces
policy.json       the allowlist, enforced inside SurfaceAdapter.act()
src/schema/       the artifact contract (Zod: runtime validation + static types)
src/adapter/      surface.ts is the seam; terminal.ts and web.ts implement it
src/replay/       the engine, the condition evaluator, the no-model guard
src/policy/       allowlist gate and redaction
src/discover/     the ONLY place a model appears: loop, tool contract, compiler
surfaces/terminal/ the character-grid host
evidence/         committed output of real runs
tests/            105 assertions; adapter-conformance.test.ts runs on both surfaces
```

---

## Known limits

Stated here rather than discovered by a reviewer; expanded in REPORT §6 and §7.

- **Discovery drafts still need review — that is the point of `draft`.** The recorded run
  produces two lint warnings (an unverified step, and no declared outcome detectors), and
  an earlier run of the same goal anchored on the member's *name* rather than the parameter,
  which would have silently opened the wrong member for every other caller. The gate, the
  ambiguity halt and the linter caught all of it. A draft is a proposal, not a capability.
- `same-row` and `under-column` need the surface to *declare* row structure (`<tr>`,
  `role="row"`, `mat-row`). The Mifos client list is `<div class="list-row">` and declares
  none, so those relations halt there rather than inferring rows from layout. The web
  capability anchors on the member's own account number instead.
- The desktop surface is not implemented. The seam is real and the terminal adapter proves
  it carries a non-DOM surface, but a third adapter is a claim, not a demonstration.
- Redaction covers credentials and regulated identifiers. It is deliberately **not** a PII
  classifier — member names and account numbers are the working data these capabilities
  exist to return.
