# Evidence

Output of real runs, committed. Every file here was produced by a command in this repo, not
written by hand.

Regenerate all of it with:

```bash
npm run up && npm run wait-ready && npm run seed
npm run replay -- capabilities/member.savings.balance.read.terminal.json --memberId 12345     --evidence evidence/replay-terminal-success
npm run replay -- capabilities/member.savings.balance.read.terminal.json --memberId 99999     --evidence evidence/replay-terminal-notfound
npm run replay -- capabilities/member.savings.balance.read.web.json      --memberId 000000001 --evidence evidence/replay-web-success
npm run replay -- capabilities/member.savings.balance.read.web.json      --memberId 000009999 --evidence evidence/replay-web-notfound
```

---

## What each run proves

### `replay-web-success/` — the core loop, on a real product

A deterministic replay against a live Apache Fineract / Mifos X instance. Exit `0`.

`run.json` is the structured log the brief asks for. Two things in it are worth reading:

- `"modelCalls": 0` — **measured**, not asserted. Same counter that increments when a model
  call is recorded (`tests/no-model.test.ts` proves it moves in both directions).
- `steps[].strategy` — which rung of the resolution ladder resolved each target. The sign-in
  fields resolve via `label-association` because Angular Material declares one; the balance
  resolves via `text-then-reading-order` because the page offers no label, role or id for it
  at all. That field is also the drift signal: a step that used to resolve one way and now
  resolves another has moved.

### `replay-terminal-success/` — the same capability, no DOM

Same `capabilityId` and `capabilityVersion` as the web run above. Different surface,
different perception layer, same schema and same engine. Exit `0`.

Compare `run.json` between the two runs: the capability id, the outputs and
`"modelCalls": 0` match; the `surface`, `screenId` and `strategy` fields differ. **That
comparison is the thesis.**

### `replay-web-notfound/` and `replay-terminal-notfound/` — a business outcome is not a crash

Exit `3`, `OUTCOME MEMBER_NOT_FOUND`, on both surfaces.

Worth noting *how* the web case arrives there. Looking up a member who does not exist leaves
no row to click, so the anchor is genuinely unresolvable — the naive result is
`anchor-unresolved`, a hard failure. The engine gives declared outcomes the last word before
believing a resolution failure, so the caller gets a machine-readable business answer
instead. `outcome-MEMBER_NOT_FOUND.png` and `.page.txt` capture the screen it decided on.

---

## Hand-authored fixture

Both committed capabilities carry
`metadata.discoveryEvidence: "evidence/README.md#hand-authored-fixture"` and
`metadata.recordedBy: "hand-authored"`, and this section is what that points at.

**They were written by hand, not recorded by a model.** That is stated in the artifact
itself rather than left for a reader to infer, because the difference matters: a
hand-authored capability is a *reference* artifact — it defines what good output looks like,
and it is what makes the cross-surface claim checkable independently of whether any
particular discovery run went well.

A model-recorded capability is distinguishable at a glance without reading this file:
`recordedBy: "discovery"`, `metadata.model` naming the provider and model, and
`approvalState: "draft"` until a human runs `npm run approve`.

The two hand-authored artifacts are the pair the thesis rests on — one id, one version, two
surfaces:

| File | Surface | Product |
|---|---|---|
| `capabilities/member.savings.balance.read.web.json` | web | `openmf/web-app` |
| `capabilities/member.savings.balance.read.terminal.json` | terminal | `northridge/terminal` |

## File types

| File | Surface | What it is |
|---|---|---|
| `run.json` | both | Structured result plus a per-step record: screen, strategy, confidence, binding |
| `*.png` | web | Full-page screenshot at the moment of the outcome or failure |
| `*.page.txt` | web | Extracted page text. Diffs, which a screenshot does not — this is what makes a state delta after a human takeover a text diff rather than two images to eyeball |
| `*.actions.txt` | web | What the adapter did, in order |
| `*.screen.txt` | terminal | The 80×24 character plane |
| `*.protocol.txt` | terminal | The line protocol transcript |

Everything written here passes through the redactor built from `policy.json`
(`src/policy/redact.ts`). `tests/redaction.test.ts` asserts that by sweeping the filesystem
for a sentinel credential rather than by testing the redactor in isolation.

---

## `discovery/` — the LLM run

A real model driving the real Mifos X app until it reached the goal, then compiled into a
draft capability. Three files, and the split between them is deliberate — the brief asks for
the artifact to be decoupled from the raw model transcript:

| File | What it is |
|---|---|
| `discovery.log` | Human-readable: every step, its intent, its anchor, and the **rationale the model wrote for why that locator should survive** |
| `trace.json` | The structured record the compiler consumes |
| `transcript.json` | The unedited conversation, so a reviewer can check what the model was actually shown |

What the run demonstrates, beyond "it completed":

- It **recovered from a blocker by itself.** A click timed out because Material's modal
  backdrop was intercepting pointer events; the agent diagnosed it, closed the dialog, and
  retried — independently rediscovering the same interstitial the hand-authored capability
  declares as a `recovery`.
- It **read an adapter refusal and adapted.** It tried `param:"memberId" same-row`, got back
  "this surface declares no row structure … anchor on a literal the page does assert", and
  changed approach on the next step.
- It anchored on **`param:"memberId"`**, not on the member's name. That is what makes the
  compiled artifact work for every member rather than the one it was recorded against —
  proven by `replay-web-draft-other/`, a member the recording never saw.

Reproduce with:

```bash
npm run discover -- --goal "look up member 000000001 and read their current savings balance" \
  --surface web --memberId 000000001 --id member.savings.balance.read
```

## `replay-web-draft/` and `replay-web-draft-other/` — the generality proof

The model-written draft, replayed with no model against two different members:

```
--memberId 000000001  (recorded)      → savingsBalance=4250.00   modelCalls=0
--memberId 000000002  (never seen)    → savingsBalance=812.44    modelCalls=0
```

The second run is the one that matters. Nothing in the artifact mentions Marcus Reyes; the
`param` anchor resolves the account number at replay time.
