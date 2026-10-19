/**
 * A host's refusal of a forwarded message is read, logged, and — when it is
 * about the message's inline media — answered with one resend that keeps the
 * text.
 *
 * Before agent-framework #266 a host checked a coalesced message's whole
 * content against 1 MiB, inline base64 included, and refused a message with a
 * large screenshot per item (`coalesce_invalid` on channels/incoming, a
 * -32602 error on push/event). discord-mcpl never read the per-item result
 * and logged the message as sent: the message, text and all, was lost
 * without a trace on either side.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { textContent } from '@animalabs/mcpl-core';
import type { ContentBlock } from '@animalabs/mcpl-core';
import type { DiscordAdapter, MessageEventInfo } from '../src/discord-adapter.js';
import { ChannelManager, toDescriptor } from '../src/channels.js';
import { DiscordMcplServer } from '../src/server.js';
import {
  errorRejection,
  incomingOutcome,
  isContentRejection,
  pushOutcome,
  summarizeAttachments,
  withoutInlineMedia,
} from '../src/incoming-results.js';

type Responder = (method: string, params: any, n: number) => unknown | Promise<unknown>;
type EditHandler = (c: string, m: string, t: string, isDM: boolean, info?: MessageEventInfo) => void;

/** ~1.2 MB of base64: over the 1 MiB budget a pre-#266 host applied. */
const BIG_IMAGE = 'A'.repeat(1_200_000);

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function wire(respond: Responder, opts: { open?: boolean } = {}) {
  const server = new DiscordMcplServer({} as DiscordAdapter);
  const s = server as unknown as Record<string, unknown>;
  let edit: EditHandler | undefined;
  const noop = () => {};
  s.discord = {
    botUserId: 'bot',
    onMessage: noop, onReaction: noop,
    onChannelCreate: noop, onChannelUpdate: noop, onChannelDelete: noop, onGuildCreate: noop,
    onGuildRename: noop, onThreadUpdate: noop, onThreadDelete: noop, onThreadsSynced: noop, onGuildDelete: noop, onGuildAvailable: noop,
    onChannelRefreshed: noop,
    onChannelStale: noop,
    refreshStale: async () => {},
    getCachedChannelFacts: (id: string) =>
      id === 'chan1' ? { id, guildId: 'g1', guildName: 'Guild', type: 'text', name: 'general' } : null,
    getCachedChannelFactsFor: () => new Map(),
    isStale: () => false,
    hasGuild: () => true,
    channelAdmitted: () => true,
    onMessageEdit: (h: EditHandler) => { edit = h; },
    onMessageDelete: noop,
  };
  const sent: Array<{ method: string; params: any }> = [];
  s.conn = {
    sendRequest: (method: string, params: unknown) => {
      sent.push({ method, params });
      try {
        return Promise.resolve(respond(method, params, sent.length));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    sendNotification: noop,
  };
  s.mcplEnabled = true;
  // A coalescing host, as the fleet's are: every create carries `coalesce`.
  s.hostCoalescing = { pushEvents: true, channelsIncoming: true, channelScopedPush: false };
  (s.enabledFeatureSets as Set<string>).add('discord.messaging');
  (s.ensureSubscriptionsLoaded as () => void).call(server);
  (s.subscribedChannels as Set<string>).add('chan1');
  (s.setupDiscordForwarding as () => void).call(server);
  if (opts.open) {
    const manager = s.channelManager as ChannelManager;
    manager.register(toDescriptor({ id: 'chan1', guildId: 'g1', guildName: 'Guild', type: 'text', name: 'general' }));
    manager.open('discord:g1:chan1');
  }
  return { server, sent, edit: () => edit! };
}

/** A message with one image attachment; the fetch + downsample is stubbed. */
async function deliver(server: DiscordMcplServer, image: string | null): Promise<void> {
  const s = server as unknown as Record<string, unknown>;
  s.buildAttachmentBlocks = async (): Promise<ContentBlock[]> => image === null ? [] : [
    { type: 'image', data: image, mimeType: 'image/png' } as ContentBlock,
    textContent('[image attachment: shot.png — https://cdn.example/shot.png]'),
  ];
  await (server as any).handleDiscordMessage({
    id: 'm1', content: 'look at this', cleanContent: 'look at this', authorId: 'u1', authorName: 'someone',
    isBot: false, channelId: 'chan1', guildId: 'g1', guildName: 'Guild', channelName: 'general',
    mentions: [], timestamp: new Date(),
    attachments: image === null ? [] : [{ name: 'shot.png', contentType: 'image/png', size: 900_000, url: 'https://cdn.example/shot.png' }],
  });
}

const contentOf = (req: { method: string; params: any }): ContentBlock[] =>
  req.method === 'channels/incoming' ? req.params.messages[0].content : req.params.payload.content;
const eventIdOf = (req: { method: string; params: any }): string =>
  req.method === 'channels/incoming' ? req.params.messages[0].eventId : req.params.eventId;
const coalesceOf = (req: { method: string; params: any }): any =>
  req.method === 'channels/incoming' ? req.params.messages[0].coalesce : req.params.coalesce;

let errors: string[] = [];
let realError: typeof console.error;
beforeEach(() => {
  errors = [];
  realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
});
afterEach(() => { console.error = realError; });

describe('channels/incoming (open channel): the per-message result is read', () => {
  it('an accepted message is sent once and nothing is logged as refused', async () => {
    const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: true }] }), { open: true });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'channels/incoming');
    assert.deepEqual(errors.filter((e) => e.includes('rejected')), []);
  });

  it('a coalesce_invalid refusal of a message with an inline image is logged, then resent once with a note instead of the image', async () => {
    const { server, sent } = wire((_m, _p, n) => n === 1
      ? { results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }
      : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
    await deliver(server, BIG_IMAGE);

    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: coalesce_invalid'), errors.join('\n'));
    assert.equal(sent.length, 2, 'exactly one resend');
    const [first, second] = sent;
    assert.equal(second.method, 'channels/incoming');
    // The resend carries no inline media, keeps the text, and says an image was omitted.
    assert.equal(contentOf(second).some((b: any) => b.type === 'image'), false);
    const texts = contentOf(second).map((b: any) => b.text ?? '').join('\n');
    assert.match(texts, /someone: look at this/);
    assert.match(texts, /\[image omitted: the host refused this message with the image inline \(image\/png, ~\d+(\.\d)?(KB|MB); host said: coalesce_invalid\)/);
    assert.match(texts, /\[image attachment: shot\.png — https:\/\/cdn\.example\/shot\.png\]/);
    // A fresh occurrence id on the same subject, still the subject's first occurrence.
    assert.equal(eventIdOf(first), 'discord_msg_m1');
    assert.equal(eventIdOf(second), 'discord_msg_m1_media_omitted');
    assert.deepEqual(coalesceOf(second), { key: 'message:m1', initial: true });
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] resent message m1 in discord:g1:chan1 with 1 inline attachment(s) replaced by a note: accepted')), errors.join('\n'));
  });

  it('a refusal of a message without inline media is logged and not resent', async () => {
    const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }), { open: true });
    await deliver(server, null);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: coalesce_invalid'));
  });

  it('a refusal that is not about content (empty_content) is logged and not resent', async () => {
    const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false, reason: 'empty_content' }] }), { open: true });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: empty_content'));
  });

  it('a resend the host refuses too is logged, and nothing more is sent', async () => {
    const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }), { open: true });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 2);
    assert.ok(errors.some((e) => e.endsWith('host rejected it again: coalesce_invalid')), errors.join('\n'));
  });
});

describe('push/event (closed channel): the result or error is read', () => {
  it('a -32602 "content exceeds host byte limit" error is a refusal: logged, then resent once without the image', async () => {
    const { server, sent } = wire((_m, _p, n) => {
      if (n === 1) throw rpcError(-32602, 'content exceeds host byte limit');
      return { accepted: true, inferenceId: 'i1' };
    });
    await deliver(server, BIG_IMAGE);
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: content exceeds host byte limit'), errors.join('\n'));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].method, 'push/event');
    assert.equal(contentOf(sent[1]).some((b: any) => b.type === 'image'), false);
    assert.equal(eventIdOf(sent[1]), 'discord_msg_m1_media_omitted');
    assert.equal(coalesceOf(sent[1]).key, 'message:m1');
    assert.equal(coalesceOf(sent[1]).initial, true);
    // The rest of the push is the same message.
    assert.deepEqual(sent[1].params.origin, sent[0].params.origin);
  });

  it('an {accepted:false} result for a non-content reason is logged and not resent', async () => {
    const { server, sent } = wire(() => ({ accepted: false, reason: 'duplicate' }));
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: duplicate'));
  });

  it('a transport failure (timeout) is logged as a send failure and not resent', async () => {
    const { server, sent } = wire(() => { throw rpcError(-32000, 'Request timed out after 30000ms: push/event'); });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] push/event failed:')), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes('host rejected')), false);
  });

  it('an accepted push logs nothing as refused', async () => {
    const { server, sent } = wire(() => ({ accepted: true, inferenceId: 'i1' }));
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.deepEqual(errors, []);
  });
});

describe('edits: a refused edit is logged', () => {
  it('logs the refusal of an edit', async () => {
    const { sent, edit } = wire(() => ({ accepted: false, reason: 'coalesce_invalid' }));
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected edit of message m9 in discord:g1:chan1: coalesce_invalid'), errors.join('\n'));
  });
});

describe('incoming-results helpers', () => {
  it('reads per-message verdicts, and treats a missing one as no verdict', () => {
    assert.deepEqual(incomingOutcome({ results: [{ messageId: 'a', accepted: true }] }, 'a'), { kind: 'accepted' });
    assert.deepEqual(incomingOutcome({ results: [{ messageId: 'a', accepted: false }] }, 'a'), { kind: 'rejected', reason: 'unspecified' });
    assert.deepEqual(incomingOutcome({}, 'a'), { kind: 'no-result' });
    assert.deepEqual(incomingOutcome(undefined, 'a'), { kind: 'no-result' });
    assert.deepEqual(pushOutcome({ accepted: true }), { kind: 'accepted' });
    assert.deepEqual(pushOutcome(null), { kind: 'no-result' });
  });

  it('only -32602 errors are refusals', () => {
    assert.deepEqual(errorRejection(rpcError(-32602, 'bad')), { reason: 'bad', code: -32602 });
    assert.equal(errorRejection(rpcError(-32000, 'timed out')), undefined);
    assert.equal(errorRejection(new Error('closed')), undefined);
  });

  it('classifies content refusals', () => {
    assert.equal(isContentRejection({ reason: 'coalesce_invalid' }), true);
    assert.equal(isContentRejection({ reason: 'content exceeds host byte limit' }), true);
    assert.equal(isContentRejection({ reason: 'anything', code: -32602 }), true);
    assert.equal(isContentRejection({ reason: 'empty_content' }), false);
    assert.equal(isContentRejection({ reason: 'duplicate' }), false);
    assert.equal(isContentRejection({ reason: 'unknown channel "x" — register it first (§14.5)' }), false);
    assert.equal(isContentRejection({ reason: 'host could not persist the acceptance; retry' }), false);
  });

  it('replaces only inline media, and summarizes what was inline', () => {
    const content = [
      textContent('hi'),
      { type: 'image', data: 'QUFB', mimeType: 'image/png' } as ContentBlock,
      { type: 'image', uri: 'https://x' } as unknown as ContentBlock,
    ];
    const summary = summarizeAttachments(content);
    assert.equal(summary.inline, 1);
    assert.deepEqual(summary.kinds, ['image/png']);
    assert.equal(summary.inlineBase64Bytes, 4);
    const { content: out, replaced } = withoutInlineMedia(content, 'coalesce_invalid');
    assert.equal(replaced, 1);
    assert.equal((out[0] as any).text, 'hi');
    assert.equal((out[1] as any).type, 'text');
    assert.deepEqual(out[2], content[2]);
  });
});
