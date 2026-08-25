/**
 * THE MODEL-PROVIDER SEAM.
 *
 * The same move the SurfaceAdapter makes for surfaces, made for model APIs: one
 * loop above, provider-specific transports below. The discovery loop asks for a
 * turn and receives tool calls; it never learns whose API answered.
 *
 * This exists because the two shapes are genuinely different, not cosmetically
 * so. Anthropic's Messages API returns `content` blocks of type `tool_use` with
 * parsed input; the OpenAI chat-completions shape — which is what OpenRouter
 * speaks, and the only shape it speaks — returns `tool_calls` whose arguments
 * are a JSON *string* that has to be parsed and may not parse. Tool definitions,
 * result messages and system prompts all differ too. Leaving that difference in
 * the loop would put two conversation formats in the middle of the one file
 * that is supposed to be about observe/decide/act.
 *
 * Each provider owns its own conversation history, in whatever shape its API
 * wants. The loop drives the alternation and asks for `transcript()` at the end
 * for evidence.
 *
 * WHAT IS LOST GOING THROUGH AN OPENAI-COMPATIBLE GATEWAY, stated plainly
 * because it is a real cost and not a footnote:
 *
 *   - Prompt caching. The system prompt is byte-stable across every turn and
 *     would otherwise be cached; the gateway has no equivalent, so it is re-sent
 *     and re-billed every turn.
 *   - `output_config.effort`. There is no portable way to ask for more thinking.
 *   - Strict tool-schema validation is best-effort: it is forwarded, but whether
 *     it is enforced depends on the upstream provider the gateway routes to.
 *
 * None of that changes what gets compiled — the artifact is identical either
 * way — but a run through the gateway costs more and may need more turns.
 *
 * NOTE ON MODEL-CALL ACCOUNTING. Providers deliberately do NOT call
 * `recordModelCall()`. The loop does, once per turn, before it asks for one —
 * so the counter and the replay guard apply to every provider including a test
 * double, and a scripted provider cannot quietly bypass the guarantee that
 * nothing consults a model inside a replay.
 */

import type { Redactor } from '../policy/redact.js';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentTurn {
  calls: ToolCall[];
  text: string;
  /** Set when the provider declined the request outright. */
  refusal?: string;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface TurnInput {
  userText?: string;
  toolResults?: ToolResult[];
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  send(input: TurnInput): Promise<AgentTurn>;
  /** The raw conversation, for evidence. Redacted by the caller. */
  transcript(): unknown;
}

/** Provider-neutral tool definition, translated per transport. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Marker the loop appends before every screen render. */
const SCREEN_MARKER = 'Current screen:';

/**
 * Drop stale screen renders from the conversation before sending it.
 *
 * THE DOMINANT COST OF A DISCOVERY RUN, and it buys nothing. Every turn appends
 * a full element listing, and every turn re-sends the entire history — so an
 * N-step run pays for roughly N²/2 screen renders, of which exactly one (the
 * latest) can still be acted on. A 13-step run against the Mifos client list
 * re-sent ~80 elements a dozen times over.
 *
 * The agent decides from the CURRENT screen; earlier ones are already
 * summarised by the outcomes recorded beside them ("OK — captured …", "REFUSED:
 * …"), which are kept. So the older renders are replaced with a one-line note
 * rather than deleted outright, which keeps the turn structure intact and tells
 * the model plainly that the screen it is no longer being shown is simply
 * superseded — not hidden from it.
 *
 * Pure and non-mutating: providers keep their real history for the evidence
 * transcript, so what a reviewer reads is still the whole conversation.
 */
function trimStaleObservations<T extends { content?: unknown }>(messages: T[]): T[] {
  // Find the last message that carries a screen render; everything before it is
  // fair game.
  let lastScreenIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (typeof messages[i]?.content === 'string' && (messages[i]!.content as string).includes(SCREEN_MARKER)) {
      lastScreenIdx = i;
      break;
    }
  }

  return messages.map((m, i) => {
    if (i >= lastScreenIdx) return m;
    if (typeof m.content !== 'string') return m;
    const at = m.content.indexOf(SCREEN_MARKER);
    if (at === -1) return m;
    return {
      ...m,
      content:
        m.content.slice(0, at) +
        '(screen omitted — superseded by a later observation in this conversation)',
    };
  });
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private messages: unknown[] = [];
  private client: unknown;

  constructor(
    readonly model: string,
    private readonly system: string,
    private readonly tools: ToolDef[],
    client?: unknown,
  ) {
    this.client = client;
  }

  private async ensureClient(): Promise<{
    messages: { create: (b: Record<string, unknown>) => Promise<Record<string, unknown>> };
  }> {
    if (!this.client) {
      // Imported lazily so the SDK is only loaded when this provider is the one
      // actually selected.
      const mod = await import('@anthropic-ai/sdk');
      const Ctor = (mod.default ?? mod) as new () => unknown;
      this.client = new Ctor();
    }
    return this.client as { messages: { create: (b: Record<string, unknown>) => Promise<Record<string, unknown>> } };
  }

  async send(input: TurnInput): Promise<AgentTurn> {
    const client = await this.ensureClient();

    if (input.userText !== undefined) {
      this.messages.push({ role: 'user', content: input.userText });
    }
    if (input.toolResults?.length) {
      this.messages.push({
        role: 'user',
        content: input.toolResults.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          ...(r.isError ? { is_error: true } : {}),
          content: r.content,
        })),
      });
    }

    const res = await client.messages.create({
      model: this.model,
      max_tokens: 16_000,
      // Thinking is on by default on Opus 5, and max_tokens caps thinking and
      // response text together — hence the headroom.
      system: [
        {
          type: 'text',
          text: this.system,
          // Byte-stable across every turn of every run, so it is worth caching.
          // The volatile observation goes in messages, after the cached prefix.
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: { effort: 'high' },
      tools: this.tools.map((t) => ({ ...t, strict: true })),
      messages: trimStaleObservations(this.messages as Array<{ content?: unknown }>),
    });

    // Check stop_reason BEFORE reading content: a refusal returns HTTP 200 with
    // content that may be empty, and indexing into it would replace a legible
    // error with a confusing one.
    if (res.stop_reason === 'refusal') {
      const details = res.stop_details as { category?: string } | null;
      return { calls: [], text: '', refusal: `model declined (${details?.category ?? 'unspecified'})` };
    }

    const content = (res.content ?? []) as Array<Record<string, unknown>>;
    this.messages.push({ role: 'assistant', content });

    return {
      calls: content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: String(b.id),
          name: String(b.name),
          input: (b.input ?? {}) as Record<string, unknown>,
        })),
      text: content
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n'),
    };
  }

  transcript(): unknown {
    return this.messages;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions (OpenRouter, and anything speaking its shape)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export class OpenAICompatProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  private messages: ChatMessage[] = [];

  constructor(
    readonly model: string,
    system: string,
    private readonly tools: ToolDef[],
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      referer?: string;
      title?: string;
      /** Output ceiling. Also the amount a gateway reserves per call — see send(). */
      maxTokens?: number;
    },
  ) {
    // No cached-prefix concept here, so the system prompt is an ordinary first
    // message and is re-sent every turn.
    this.messages.push({ role: 'system', content: system });
  }

  async send(input: TurnInput): Promise<AgentTurn> {
    if (input.userText !== undefined) {
      this.messages.push({ role: 'user', content: input.userText });
    }
    for (const r of input.toolResults ?? []) {
      // A tool result is its own message here, not a block inside a user turn.
      this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }

    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
        // OpenRouter uses these for attribution; harmless elsewhere.
        ...(this.opts.referer ? { 'HTTP-Referer': this.opts.referer } : {}),
        ...(this.opts.title ? { 'X-Title': this.opts.title } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        // Trimmed, not truncated: the full history is kept for evidence.
        messages: trimStaleObservations(this.messages),
        // MUST be set, and not for the reason it is usually set.
        //
        // A gateway reserves the MAXIMUM POSSIBLE cost of a request against the
        // account balance before running it. With no ceiling declared it has to
        // assume the model's full output window — 32k tokens on an Opus-class
        // model — and reserve several dollars for a call that will actually emit
        // a few hundred tokens. A funded account then fails with
        // `in_flight_budget_exhausted`, which reads as "you are out of credits"
        // and is not: it is one over-large reservation blocking the next call.
        //
        // A discovery turn emits one tool call plus a short rationale, so this
        // is generous. The Anthropic path sets its own, higher ceiling because
        // thinking tokens count against it there.
        max_tokens: this.opts.maxTokens ?? 4096,
        tools: this.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
            // Forwarded, but only enforced if the upstream provider supports
            // it — hence the defensive parse below rather than trust.
            strict: true,
          },
        })),
        tool_choice: 'auto',
      }),
    });

    if (!res.ok) {
      throw new Error(`${this.opts.baseUrl} returned ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
      error?: { message?: string };
    };
    if (body.error) throw new Error(`gateway error: ${body.error.message ?? 'unknown'}`);

    const message = body.choices?.[0]?.message;
    if (!message) throw new Error('gateway returned no choices');
    this.messages.push(message);

    const calls: ToolCall[] = [];
    for (const c of message.tool_calls ?? []) {
      // Arguments arrive as a JSON STRING and are not guaranteed to parse.
      // A malformed call is surfaced as a tool result the model must correct,
      // which is the same treatment a refused action gets — never a crash.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsed = { __malformed: c.function.arguments };
      }
      calls.push({ id: c.id, name: c.function.name, input: parsed });
    }

    return { calls, text: typeof message.content === 'string' ? message.content : '' };
  }

  transcript(): unknown {
    return this.messages;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ProviderChoice {
  system: string;
  tools: ToolDef[];
  model?: string;
  env?: Record<string, string | undefined>;
  redact?: Redactor;
}

/** Default model per provider. Overridable with --model. */
export const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5',
  // Cheap by default: a discovery turn is 'read a labelled element list and
  // pick an anchor', which does not need a frontier model. Roughly 25x cheaper
  // per token than an Opus-class model. Override with OPENROUTER_MODEL.
  openrouter: 'google/gemini-3.5-flash-lite',
} as const;

/**
 * Pick a provider from the environment.
 *
 * ANTHROPIC_API_KEY wins when both are present: it is the first-party path, it
 * supports prompt caching and effort, and it is what the README documents. The
 * gateway is the fallback so a contributor with only an OpenRouter key can
 * still perform a real discovery run.
 */
/**
 * Is this a real credential, or the placeholder shipped in .env.example?
 *
 * A prefix check alone is not enough, and the failure it causes is genuinely
 * confusing: `.env.example` ships `ANTHROPIC_API_KEY=sk-ant-...`, which starts
 * with `sk-ant-` and therefore *passes* a naive prefix test. The selector then
 * picks the first-party provider, sends the literal placeholder, and the run
 * dies on a 401 — while an OpenRouter key sitting in the same file is never
 * even considered, because the placeholder shadowed it.
 *
 * So a value must also be long enough to be a key and must not contain the
 * ellipsis or angle brackets that mark a template. Erring toward "not real"
 * is right: the failure mode is falling through to the other provider or to a
 * clear "no credentials" error, both of which beat an unexplained 401.
 */
function looksReal(value: string | undefined, prefix: string): value is string {
  if (value === undefined) return false;
  const v = value.trim();
  if (!v.startsWith(prefix)) return false;
  if (v.includes('...') || v.includes('<') || v.includes('…')) return false;
  return v.length >= prefix.length + 20;
}

export function selectProvider(choice: ProviderChoice): ModelProvider {
  const env = choice.env ?? process.env;

  if (looksReal(env.ANTHROPIC_API_KEY, 'sk-ant-')) {
    return new AnthropicProvider(
      choice.model ?? DEFAULT_MODELS.anthropic,
      choice.system,
      choice.tools,
    );
  }

  if (looksReal(env.OPENROUTER_API_KEY, 'sk-or-')) {
    return new OpenAICompatProvider(
      choice.model ?? env.OPENROUTER_MODEL ?? DEFAULT_MODELS.openrouter,
      choice.system,
      choice.tools,
      {
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
        referer: 'https://github.com/',
        title: 'bankgpt-computer-use',
        ...(env.OPENROUTER_MAX_TOKENS ? { maxTokens: Number(env.OPENROUTER_MAX_TOKENS) } : {}),
      },
    );
  }

  // Name which keys were seen but rejected, without ever echoing a value —
  // "no credentials found" while a key sits in .env is the single most
  // annoying possible error message.
  const present: string[] = [];
  if (env.ANTHROPIC_API_KEY) present.push('ANTHROPIC_API_KEY (expected sk-ant-…)');
  if (env.OPENROUTER_API_KEY) present.push('OPENROUTER_API_KEY (expected sk-or-…)');

  throw new Error(
    'no usable model credentials. Set ANTHROPIC_API_KEY (preferred) or OPENROUTER_API_KEY in .env.\n' +
      (present.length > 0
        ? `Found but rejected as a placeholder or wrong shape: ${present.join(', ')}.\n`
        : '') +
      'Discovery is the one command that needs a model; replay never does.',
  );
}
