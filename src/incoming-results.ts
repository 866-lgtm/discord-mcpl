/**
 * Reading the host's answer to a forwarded Discord message.
 *
 * `channels/incoming` answers per message (`results[]`, each with `accepted`
 * and, from hosts that say why, a `reason`); `push/event` answers once
 * (`{accepted, reason?}`) or, on most hosts, refuses with a JSON-RPC error
 * (`code`, `message`). A refused message never reaches the agent, so the
 * refusal has to be read and reported here: sending is not delivering.
 *
 * The case this exists for: agent-framework's coalescing hosts before 0.22.2,
 * its 0.21 line included, check a coalesced message's whole content against
 * a 1 MiB budget, inline base64 images included (agent-framework #266; #267
 * removed the budget in 0.22.2). They refuse a message carrying a large
 * screenshot as `coalesce_invalid` (channels/incoming) or with a -32602 error
 * (push/event), and the host logs nothing about it. The message, its text
 * included, never reaches the agent.
 */

import type { ContentBlock } from '@animalabs/mcpl-core';

/** A host refusal of one forwarded message. */
export interface HostRejection {
  /** The host's reason (result `reason`, or the error message). */
  reason: string;
  /** The JSON-RPC error code, when the refusal came as an error. */
  code?: number;
}

/** Outcome of one forwarded message as the host answered it. */
export type ForwardOutcome =
  | { kind: 'accepted' }
  /** The host answered without a per-message verdict (an older host, or a
   *  result shape this server does not know). Treated as delivered. */
  | { kind: 'no-result' }
  | ({ kind: 'rejected' } & HostRejection);

/** The verdict for `messageId` in a `channels/incoming` response. */
export function incomingOutcome(response: unknown, messageId: string): ForwardOutcome {
  const results = (response as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return { kind: 'no-result' };
  const mine = results.find((r) => (r as { messageId?: unknown } | null)?.messageId === messageId)
    // A single-message request whose answer lost its id still answers it.
    ?? (results.length === 1 ? results[0] : undefined);
  if (!mine || typeof mine !== 'object') return { kind: 'no-result' };
  const r = mine as { accepted?: unknown; reason?: unknown };
  if (r.accepted === true) return { kind: 'accepted' };
  if (r.accepted === false) {
    return { kind: 'rejected', reason: typeof r.reason === 'string' && r.reason ? r.reason : 'unspecified' };
  }
  return { kind: 'no-result' };
}

/** The verdict in a `push/event` response. */
export function pushOutcome(response: unknown): ForwardOutcome {
  const r = response as { accepted?: unknown; reason?: unknown } | null | undefined;
  if (r && r.accepted === true) return { kind: 'accepted' };
  if (r && r.accepted === false) {
    return { kind: 'rejected', reason: typeof r.reason === 'string' && r.reason ? r.reason : 'unspecified' };
  }
  return { kind: 'no-result' };
}

/**
 * The host's refusal in the error a request was rejected with, or undefined
 * when the error isn't a verdict on this message:
 * - no code: a closed connection;
 * - -32000: mcpl-core's own timeout (0.2.1's RpcError, and the
 *   ConnectionTimeoutError of later versions), or the host's own failure,
 *   such as agent-framework's "host could not persist the acceptance; retry",
 *   which it can answer after it has already delivered the message;
 * - -32603: the host's internal error.
 *
 * Any other code is the host refusing this request: agent-framework answers
 * codes such as -32602 for content or params it won't admit, -32001 and
 * -32003 for a feature set, and -32017 and -32023 for a channel. This is the
 * line agent-framework draws itself (coalesceRejectionReason in its
 * push-coalescer.ts, since 0.22.2): -32000 and -32603 are the host's own
 * failure, and every other answer is the sender's.
 *
 * channels/incoming answers each message as a result without a code, so the
 * host's own failure there comes back as a reason that reads like a refusal.
 */
export function errorRejection(err: unknown): HostRejection | undefined {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e || typeof e.code !== 'number') return undefined;
  if (e.code === -32000 || e.code === -32603) return undefined;
  const message = typeof e.message === 'string' ? e.message : '';
  // mcpl-core 0.2.1 puts "RPC error <code>: " in front of the host's message,
  // and later versions don't. The reason is the host's own words.
  const prefix = `RPC error ${e.code}: `;
  const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return { reason: reason || 'unspecified', code: e.code };
}

/**
 * Whether a refusal is about the message's CONTENT, so that the same message
 * without its inline media might be admitted: a -32602 error, or the item
 * reason `coalesce_invalid`. Those are the two answers agent-framework gives a
 * coalesced message over its 1 MiB content budget (push/event and
 * channels/incoming, on the hosts before 0.22.2 that have one). The host
 * gives them for malformed content or a malformed coalesce member too, which
 * this server doesn't send. Every other refusal, such as `empty_content`,
 * `duplicate`, `unknown channel …` or a feature-set error, isn't one the
 * media caused, so it isn't resent without it.
 */
export function isContentRejection(rejection: HostRejection): boolean {
  return rejection.code === -32602 || rejection.reason === 'coalesce_invalid';
}

/**
 * What agent-framework's event coalescer answers, with -32000, when it took a
 * coalesced occurrence but could not keep the acceptance (push-coalescer.ts,
 * the same in 0.22.0 and main):
 * - "host could not persist the acceptance; retry": writing the receipt
 *   failed. "Not acknowledged: the work would be lost while its receipt
 *   suppressed a retry. The producer retries within the window."
 * - "host could not make the acceptance durable; retry": committing it
 *   failed; "the producer retries once more".
 *
 * The window is the coalescer's `retryWindowMs`, 3,600,000 ms (one hour),
 * which it advertises as `eventCoalescing.retryWindowMs` at initialize. A
 * retry is the SAME occurrence: same `eventId`, same `coalesce` member, so
 * the host can match it to a receipt it did keep. On push/event the words
 * come as a JSON-RPC error; on channels/incoming as a message's `reason`,
 * without a code.
 *
 * Only these exact words. A -32000 is also mcpl-core's own timeout
 * ("Request timed out after <n>ms: <method>" in 0.2.1) and the host's
 * "host is stopping": a timed-out request's outcome is unknown, and a
 * stopping host won't keep it either, so neither is retried.
 */
export const UNPERSISTED_ACCEPTANCE_ANSWERS: readonly string[] = [
  'host could not persist the acceptance; retry',
  'host could not make the acceptance durable; retry',
];

/** Whether `words` are one of the host's "took it, couldn't keep it; retry" answers. */
export function isUnpersistedAnswer(words: string | undefined): boolean {
  return typeof words === 'string' && UNPERSISTED_ACCEPTANCE_ANSWERS.includes(words.trim());
}

/** The host's "couldn't keep it; retry" words in a request's error, or
 *  undefined: the error must carry -32000 and exactly those words (mcpl-core
 *  0.2.1's `RPC error -32000: ` prefix dropped). */
export function unpersistedError(err: unknown): string | undefined {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e || e.code !== -32000 || typeof e.message !== 'string') return undefined;
  const prefix = 'RPC error -32000: ';
  const words = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
  return isUnpersistedAnswer(words) ? words.trim() : undefined;
}

/** The host's advertised retry window (`eventCoalescing.retryWindowMs`), when
 *  it gives a positive number. */
export function advertisedRetryWindowMs(advertised: unknown): number | undefined {
  const w = (advertised as { retryWindowMs?: unknown } | null | undefined)?.retryWindowMs;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : undefined;
}

/** Inline media blocks: an image or audio block that carries its bytes. */
function isInlineMedia(b: ContentBlock): boolean {
  const block = b as { type?: unknown; data?: unknown };
  return (block.type === 'image' || block.type === 'audio') && typeof block.data === 'string';
}

/** What a message carried as attachments, for the refusal log line. */
export interface AttachmentSummary {
  /** Inline image/audio blocks. */
  inline: number;
  /** Media types of the inline blocks, e.g. ["image/png"]. */
  kinds: string[];
  /** Total base64 characters across the inline blocks. */
  inlineBase64Bytes: number;
  /** JSON size of the whole content array, what a byte budget would count. */
  contentJsonBytes: number;
}

export function summarizeAttachments(content: ContentBlock[]): AttachmentSummary {
  const media = content.filter(isInlineMedia) as Array<{ data: string; mimeType?: string; type: string }>;
  return {
    inline: media.length,
    kinds: [...new Set(media.map((b) => b.mimeType || b.type))],
    inlineBase64Bytes: media.reduce((n, b) => n + b.data.length, 0),
    contentJsonBytes: Buffer.byteLength(JSON.stringify(content)),
  };
}

/** `n` bytes in KB/MB, as the attachment notes write sizes. */
function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
}

/**
 * The content with every inline image/audio block replaced by a text note,
 * so the message's text and the fact that media was attached still reach the
 * agent. The attachment line that follows each inline image (name and link)
 * is kept as it is. `replaced` is 0 when there was nothing to replace.
 */
export function withoutInlineMedia(content: ContentBlock[]): { content: ContentBlock[]; replaced: number } {
  let replaced = 0;
  const out = content.map((b): ContentBlock => {
    if (!isInlineMedia(b)) return b;
    replaced++;
    const block = b as { type: string; data: string; mimeType?: string };
    // base64 → bytes: 3 bytes per 4 characters.
    const approx = Math.floor((block.data.length * 3) / 4);
    const what = block.type === 'audio' ? 'audio' : 'image';
    // The host's reason is the operator's (the refusal line on stderr); the
    // agent is told what it is missing and where to find it.
    return {
      type: 'text',
      text: `[${what} omitted: the host refused this message with the ${what} inline `
        + `(${block.mimeType || what}, ~${fmtBytes(approx)}). `
        + `The attachment line below names it and links to it.]`,
    } as ContentBlock;
  });
  return { content: out, replaced };
}
