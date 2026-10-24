/**
 * Reading the host's answer to a forwarded Discord message.
 *
 * `channels/incoming` answers per message (`results[]`, each with `accepted`
 * and, from hosts that say why, a `reason`); `push/event` answers once
 * (`{accepted, reason?}`) or, on most hosts, refuses with a JSON-RPC error
 * (`code`, `message`). A refused message never reaches the agent, so the
 * refusal has to be read and reported here: sending is not delivering.
 *
 * discord-mcpl serves more than one kind of host, so what it does with an
 * answer rests only on what the MCPL spec defines (answerClass): the
 * refusal codes of SPEC Appendix A and RFC-006 §13, `accepted`, and the
 * retry contract of RFC-006 §3.1. A host's `reason` is free text, kept for
 * the operator's log and never matched.
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

/** The refusal codes the MCPL spec defines in JSON-RPC's server-error range
 *  (SPEC Appendix A). Any other code in that range is implementation-defined. */
const SPEC_SERVER_RANGE_CODES = new Set([-32001, -32002, -32003, -32005, -32017, -32023, -32024]);

/** The codes JSON-RPC and SPEC Appendix A define in JSON-RPC's reserved
 *  range (-32768 to -32000). */
const DEFINED_RESERVED_CODES = new Set([-32700, -32600, -32601, -32602, -32603, ...SPEC_SERVER_RANGE_CODES]);

/**
 * The host's refusal in the error a request was rejected with, or undefined
 * when the error isn't a verdict on this message:
 * - no code: a closed connection, or any error that isn't JSON-RPC's;
 * - -32603: JSON-RPC's internal error;
 * - any other code in JSON-RPC's reserved range (-32768 to -32000) that
 *   neither JSON-RPC nor SPEC Appendix A defines: an implementation-defined
 *   server error (-32000 to -32099), which mcpl-core's own timeout is too
 *   (-32000, "Request timed out after <n>ms: <method>" in 0.2.1), or a code
 *   JSON-RPC reserves and gives no meaning.
 *
 * Every other code is the host refusing this request: -32602 (malformed),
 * the spec's feature-set, capability and channel codes, JSON-RPC's -32600,
 * -32601 and -32700, and any code outside the reserved range.
 *
 * channels/incoming answers each message as a result without a code, so a
 * host's own failure there comes back as a refusal it gives no reason code
 * for (answerClass reads that as `refused`).
 */
export function errorRejection(err: unknown): HostRejection | undefined {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e || typeof e.code !== 'number') return undefined;
  if (e.code === -32603) return undefined;
  if (e.code <= -32000 && e.code >= -32768 && !DEFINED_RESERVED_CODES.has(e.code)) return undefined;
  const message = typeof e.message === 'string' ? e.message : '';
  // mcpl-core 0.2.1 puts "RPC error <code>: " in front of the host's message,
  // and later versions don't. The reason is the host's own words.
  const prefix = `RPC error ${e.code}: `;
  const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return { reason: reason || 'unspecified', code: e.code };
}

/**
 * Whether a refusal might be about the message's inline media, so that the
 * same message without it, as a new occurrence, might be admitted: a -32602
 * error, or the item reason `coalesce_invalid`.
 *
 * A compatibility measure for one host, not something the spec says: in the
 * spec both mean a MALFORMED request (RFC-006 §13), and "coalescing capacity
 * alone is never a reason to refuse". agent-framework's coalescing hosts
 * before 0.22.2, its 0.21 line included, gave those two answers to a
 * coalesced message over a 1 MiB content budget, inline base64 included
 * (agent-framework #266, removed by #267 in 0.22.2). On any other host the
 * resend it leads to costs one request, for a refusal that is this server's
 * bug either way. Every other refusal isn't one the media caused, so it isn't
 * resent without it.
 */
export function isContentRejection(rejection: HostRejection): boolean {
  return rejection.code === -32602 || rejection.reason === 'coalesce_invalid';
}

/**
 * What an answer to a forwarded occurrence leaves the sender to do, read
 * only from what the MCPL spec defines, never from one host's wording:
 *
 * - `done`: accepted, or answered without a per-message verdict.
 * - `final`: a refusal the spec gives a meaning that resending can't change:
 *   -32602 / `coalesce_invalid` (malformed, RFC-006 §13), every other code
 *   SPEC Appendix A defines but -32023, and JSON-RPC's -32600, -32601 and
 *   -32700. (A permission refusal before the connection's policy is settled
 *   is "not yet": isAuthorityRefusal, sendWithRetries.)
 * - `unknown-channel`: -32023, the host has no such channel registered: the
 *   sender can register it and send the same occurrence again.
 * - `refused`: a refusal the spec gives no meaning: `accepted: false` with a
 *   free-text reason or none, or an error code outside JSON-RPC's reserved
 *   range. The host didn't admit it, so the same occurrence sent again can't
 *   be a duplicate, and as its cause is unknown, it may pass.
 * - `uncertain`: no verdict: no answer (a timeout, a closed connection),
 *   -32603, or another code in JSON-RPC's reserved range that neither it
 *   nor the spec defines (an implementation-defined server error, say). It may have been
 *   admitted, so only the same occurrence may be sent again, which RFC-006
 *   §3.1's retry window makes safe on a coalescing host.
 */
export type AnswerClass = 'done' | 'final' | 'unknown-channel' | 'refused' | 'uncertain';

/** The refusal codes after which the same occurrence is never sent again. */
const FINAL_CODES = new Set([
  // JSON-RPC's: invalid request, method not found, invalid params, parse error.
  -32600, -32601, -32602, -32700,
  // Every code SPEC Appendix A defines, but an unknown channel's.
  ...[...SPEC_SERVER_RANGE_CODES].filter((code) => code !== -32023),
]);

/** Of those, the permission refusals (isAuthorityRefusal). */
const AUTHORITY_CODES = new Set([-32001, -32002, -32017].filter((code) => SPEC_SERVER_RANGE_CODES.has(code)));

/** The spec's permission refusals: feature set not enabled (-32001),
 *  capability denied (-32002), channel not permitted (-32017). A host denies
 *  with them until its §5.3 policy is settled, too. */
export function isAuthorityRefusal(outcome: ForwardOutcome | { kind: 'failed' }): boolean {
  return outcome.kind === 'rejected' && outcome.code !== undefined && AUTHORITY_CODES.has(outcome.code);
}

export function answerClass(outcome: ForwardOutcome | { kind: 'failed' }): AnswerClass {
  switch (outcome.kind) {
    case 'accepted':
    case 'no-result':
      return 'done';
    case 'failed':
      return 'uncertain';
    case 'rejected':
      if (outcome.code === undefined) return outcome.reason === 'coalesce_invalid' ? 'final' : 'refused';
      if (outcome.code === -32023) return 'unknown-channel';
      return FINAL_CODES.has(outcome.code) ? 'final' : 'refused';
  }
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
