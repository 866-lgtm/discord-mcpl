/**
 * Reading the host's answer to a forwarded Discord message.
 *
 * `channels/incoming` answers per message (`results[]`, each with `accepted`
 * and, from hosts that say why, a `reason`); `push/event` answers once
 * (`{accepted, reason?}`) or, on most hosts, refuses with a JSON-RPC error
 * (`code`, `message`). A refused message never reaches the agent, so the
 * refusal has to be read and reported here: sending is not delivering.
 *
 * The case this exists for: a host before agent-framework #266 checked a
 * coalesced message's whole content against a 1 MiB budget, inline base64
 * images included, and refused a message carrying a large screenshot as
 * `coalesce_invalid` (channels/incoming) or with a -32602 error
 * (push/event). Nothing on either side logged it. The message, its text
 * included, was lost.
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

/** A JSON-RPC error that is the host refusing this content (as opposed to a
 *  timeout, a closed connection, or a host fault): -32602, invalid params,
 *  is what a host answers for content it will not admit. */
export function errorRejection(err: unknown): HostRejection | undefined {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (!e || typeof e.code !== 'number') return undefined;
  if (e.code !== -32602) return undefined;
  return { reason: typeof e.message === 'string' && e.message ? e.message : 'invalid params', code: e.code };
}

/**
 * Whether a refusal is about the message's CONTENT, so that the same message
 * without its inline media might be admitted.
 *
 * Reasons a host gives (agent-framework channel-registry / push-handler):
 * `coalesce_invalid` (a coalesced item's content or coalesce member failed
 * validation — before #266 that included the 1 MiB content budget), the
 * error text "content exceeds host byte limit", and -32602 errors. Other
 * reasons (`empty_content`, `unknown channel …`, `duplicate`, "host could not
 * persist the acceptance; retry", identity errors) are not about size, and
 * resending without media would not change them.
 */
export function isContentRejection(rejection: HostRejection): boolean {
  if (rejection.code === -32602) return true;
  const reason = rejection.reason.toLowerCase();
  if (reason === 'coalesce_invalid') return true;
  return /\b(byte|bytes|size|too large|limit|content block|payload\.content)\b/.test(reason)
    && !/empty/.test(reason);
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
export function withoutInlineMedia(
  content: ContentBlock[],
  hostReason: string,
): { content: ContentBlock[]; replaced: number } {
  let replaced = 0;
  const out = content.map((b): ContentBlock => {
    if (!isInlineMedia(b)) return b;
    replaced++;
    const block = b as { type: string; data: string; mimeType?: string };
    // base64 → bytes: 3 bytes per 4 characters.
    const approx = Math.floor((block.data.length * 3) / 4);
    const what = block.type === 'audio' ? 'audio' : 'image';
    return {
      type: 'text',
      text: `[${what} omitted: the host refused this message with the ${what} inline `
        + `(${block.mimeType || what}, ~${fmtBytes(approx)}; host said: ${hostReason}). `
        + `The attachment line below names it and links to it.]`,
    } as ContentBlock;
  });
  return { content: out, replaced };
}
