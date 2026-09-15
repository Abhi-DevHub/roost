import type { Message } from "@roost/contracts";

// ---------------------------------------------------------------------------
// Compaction — when a thread's history exceeds a token threshold, summarize
// older messages into a handoff and keep the most recent ~N tokens. The
// summarizer is injectable; the default is deterministic truncation with an
// explicit marker. The last user message is never dropped.
// ---------------------------------------------------------------------------

export interface Summarizer {
  (messages: Message[]): Promise<string>;
}

export interface CompactionOptions {
  /** Total tokens above which compaction triggers. */
  maxTokens: number;
  /** Tokens of recent messages to retain. */
  keepTokens: number;
  /** Token estimator; defaults to ~4 chars per token. */
  tokenCount?: (text: string) => number;
  /** Summarizer for the older messages; defaults to truncation with a marker. */
  summarize?: Summarizer;
}

/** Deterministic token estimate: ~4 chars/token, bounded below at 1. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Deterministic fallback summarizer: truncated with an explicit marker. */
export function truncateHandoff(messages: Message[]): string {
  const roles = messages.map((m) => m.role);
  const joined = messages.map((m) => `[${m.role}] ${m.text}`).join("\n");
  const head = joined.slice(0, 4000);
  const omitted = joined.length > 4000;
  return `[compacted ${messages.length} message(s): ${roles.join(",")}]${omitted ? " (truncated)" : ""}\n${head}`;
}

/**
 * Split `messages` into `{ older, kept }` by budget. `kept` takes the most
 * recent messages (from the end) until `keepTokens` is exhausted, then always
 * re-includes the last user message if the split would otherwise drop it.
 */
export function splitMessages(
  messages: Message[],
  opts: CompactionOptions,
): { older: Message[]; kept: Message[] } {
  const tokenCount = opts.tokenCount ?? estimateTokens;
  const kept: Message[] = [];
  let budget = 0;
  let i = messages.length;
  while (i > 0) {
    const m = messages[i - 1]!;
    const cost = tokenCount(m.text);
    if (budget + cost > opts.keepTokens && kept.length > 0) break;
    kept.unshift(m);
    budget += cost;
    i--;
  }
  // Never drop the last user message: if it fell into `older`, promote it.
  let lastUserIdx = -1;
  for (let k = messages.length - 1; k >= 0; k--) {
    if (messages[k]!.role === "user") {
      lastUserIdx = k;
      break;
    }
  }
  if (lastUserIdx >= 0 && lastUserIdx < i) {
    kept.unshift(messages[lastUserIdx]!);
    i = lastUserIdx;
  }
  return { older: messages.slice(0, i), kept };
}

/**
 * Compact a message list: returns `null` when under budget, otherwise a new
 * list of `[handoff system message, ...kept]`. The handoff uses `summarize`
 * when provided, else the deterministic truncation marker.
 */
export async function compactMessages(
  messages: Message[],
  opts: CompactionOptions,
  now: () => string = () => new Date().toISOString(),
): Promise<Message[] | null> {
  const tokenCount = opts.tokenCount ?? estimateTokens;
  const total = messages.reduce((sum, m) => sum + tokenCount(m.text), 0);
  if (total <= opts.maxTokens) return null;

  const { older, kept } = splitMessages(messages, opts);
  if (older.length === 0) return null;

  const summary = opts.summarize ? await opts.summarize(older) : truncateHandoff(older);
  const handoff: Message = {
    id: `compaction-${now()}`,
    role: "system",
    text: summary,
    at: now(),
  };
  return [handoff, ...kept];
}
