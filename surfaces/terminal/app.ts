/**
 * THE HOST PROCESS — speaks the wire protocol on stdio and nothing else.
 *
 * Run it directly to poke at the surface by hand:
 *
 *     npm run terminal
 *     READBUFFER
 *     FILL 4 21 12345
 *     AID Enter
 *
 * ONE CHANNEL, ONE SESSION. There is deliberately no separate "human mode".
 * The host exposes exactly one interface, and both the replay engine and a
 * human operator drive it through that same interface — the operator console
 * renders the character plane it receives and translates keystrokes back into
 * FILL/AID commands. So when control transfers to a human mid-run, the human is
 * acting on the SAME process, the SAME format table and the SAME local input
 * buffer, not on a reconstruction of them. A lease decides who is allowed to
 * write; the session itself never forks.
 *
 * INDUCED CONDITIONS (this surface is ours, so we say so plainly):
 *   TERM_EXPIRE_AFTER_AIDS=<n>  the (n+1)th AID key expires the session and
 *                               swaps in the sign-on panel mid-flow
 *   member 99999                MEMBER NOT FOUND   (declared business outcome)
 *   member 77777                NOT AUTHORIZED
 *   member 55555                a ~3s host response
 */

import { createInterface } from 'node:readline';
import { decodeCommand, encodeScreen } from './protocol.js';
import { applyFill, handleAid, initialState, render } from './screens.js';

const state = initialState();

const expireAfter = process.env.TERM_EXPIRE_AFTER_AIDS
  ? Number(process.env.TERM_EXPIRE_AFTER_AIDS)
  : Number.POSITIVE_INFINITY;
let aidCount = 0;

const out = (s: string) => process.stdout.write(s);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // The host announces its opening screen unprompted, exactly as a real
  // terminal session presents a panel on connect.
  out(encodeScreen(render(state)));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;

    const cmd = decodeCommand(line);
    if (!cmd) {
      out(`ERR UNRECOGNISED COMMAND\n`);
      continue;
    }

    switch (cmd.kind) {
      case 'readbuffer':
        out(encodeScreen(render(state)));
        break;

      case 'fill': {
        // Block mode: a fill edits the local buffer and transmits NOTHING.
        // The host does not know about it until an AID key is pressed. An
        // adapter that expected a fresh screen here would be misreading the
        // surface, so the protocol gives it only an acknowledgement.
        const err = applyFill(state, cmd.row, cmd.col, cmd.text);
        out(err ? `ERR ${err}\n` : `ACK\n`);
        break;
      }

      case 'aid': {
        aidCount += 1;
        const expireNow = aidCount > expireAfter;
        const { delayMs } = handleAid(state, cmd.key, { expireNow });
        // Actually wait, so a slow host is observably slow rather than merely
        // labelled slow. This is what the engine's `settled` handling and the
        // per-step timeout are tested against.
        if (delayMs > 0) await sleep(delayMs);
        out(encodeScreen(render(state)));
        break;
      }
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`HOST FAILED: ${String(err)}\n`);
  process.exit(1);
});
