/**
 * A host's refusal of a forwarded message is read, logged, and — when it is
 * about the message's inline media — answered with one resend that keeps the
 * text.
 *
 * agent-framework's coalescing hosts before 0.22.2, its 0.21 line included,
 * check a coalesced message's whole content against 1 MiB, inline base64
 * included, and refuse a message with a large screenshot per item
 * (`coalesce_invalid` on channels/incoming, a -32602 error on push/event).
 * discord-mcpl didn't read the per-item result and logged the
 * channels/incoming refusal as sent, so the message, text and all, was lost
 * with nothing on either side saying so.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';

import { ConnectionClosedError, McplConnection, RpcError, textContent } from '@animalabs/mcpl-core';
import type { ContentBlock } from '@animalabs/mcpl-core';
import type { DiscordAdapter, MessageEventInfo } from '../src/discord-adapter.js';
import { ChannelManager, toDescriptor } from '../src/channels.js';
import { DiscordMcplServer } from '../src/server.js';
import {
  advertisedRetryWindowMs,
  errorRejection,
  incomingOutcome,
  isContentRejection,
  isUnpersistedAnswer,
  pushOutcome,
  summarizeAttachments,
  unpersistedError,
  withoutInlineMedia,
} from '../src/incoming-results.js';

type Responder = (method: string, params: any, n: number) => unknown | Promise<unknown>;
type EditHandler = (c: string, m: string, t: string, isDM: boolean, info?: MessageEventInfo) => void;
type DeleteHandler = (c: string, m: string, isDM: boolean, info?: MessageEventInfo) => void;

/** ~1.2 MB of base64: over the 1 MiB budget of agent-framework's coalescing
 *  hosts before 0.22.2. */
const BIG_IMAGE = 'A'.repeat(1_200_000);
/** ~40 KB of base64: small enough that a create remembers the image's blocks
 *  for a replacing edit (64 KiB). */
const SMALL_IMAGE = 'A'.repeat(40_000);

/** The error mcpl-core rejects a request with when the host answers with one. */
function rpcError(code: number, message: string): RpcError {
  return new RpcError(code, message);
}

type Answer = { result: unknown } | { error: { code: number; message: string } } | 'no answer';

/**
 * A real mcpl-core connection to a scripted host, for the errors only
 * mcpl-core makes: each request is answered as `answer` says, or not at all,
 * and an unanswered one times out in mcpl-core itself, after 50 ms.
 */
function scriptedHost(answer: (method: string, params: any, n: number) => Answer) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const conn = McplConnection.fromStreams(toServer, fromServer);
  conn.requestTimeout = 50;
  const sent: Array<{ method: string; params: any }> = [];
  createInterface({ input: fromServer }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    sent.push({ method: msg.method, params: msg.params });
    const a = answer(msg.method, msg.params, sent.length);
    if (a !== 'no answer') toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...a })}\n`);
  });
  return { conn, sent };
}

/** Wait until `done()` holds, a tick at a time, failing after 2 s. */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setImmediate(r));
  }
}

function wire(respond: Responder, opts: { open?: boolean; host?: ReturnType<typeof scriptedHost> } = {}) {
  const server = new DiscordMcplServer({} as DiscordAdapter);
  const s = server as unknown as Record<string, unknown>;
  let edit: EditHandler | undefined;
  let del: DeleteHandler | undefined;
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
    onMessageDelete: (h: DeleteHandler) => { del = h; },
  };
  const sent: Array<{ method: string; params: any }> = opts.host?.sent ?? [];
  s.conn = opts.host?.conn ?? {
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
  return { server, sent, edit: () => edit!, del: () => del! };
}

/** A message with one image attachment; the fetch + downsample is stubbed. */
async function deliver(server: DiscordMcplServer, image: string | null, extra: ContentBlock[] = []): Promise<void> {
  const s = server as unknown as Record<string, unknown>;
  s.buildAttachmentBlocks = async (): Promise<ContentBlock[]> => image === null ? extra : [
    { type: 'image', data: image, mimeType: 'image/png' } as ContentBlock,
    textContent('[image attachment: shot.png — https://cdn.example/shot.png]'),
    ...extra,
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
    assert.deepEqual(errors.filter((e) => e.includes('rejected') || e.includes("didn't take")), []);
  });

  it('a coalesce_invalid refusal of a message with an inline image is logged, then resent once with a note instead of the image', async () => {
    const { server, sent } = wire((_m, _p, n) => n === 1
      ? { results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }
      : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
    await deliver(server, BIG_IMAGE);

    assert.ok(errors.includes("[discord-mcpl] host didn't take message m1 in discord:g1:chan1: coalesce_invalid"), errors.join('\n'));
    assert.equal(sent.length, 2, 'exactly one resend');
    const [first, second] = sent;
    assert.equal(second.method, 'channels/incoming');
    // The resend carries no inline media, keeps the text, and says an image was omitted.
    assert.equal(contentOf(second).some((b: any) => b.type === 'image'), false);
    const texts = contentOf(second).map((b: any) => b.text ?? '').join('\n');
    assert.match(texts, /someone: look at this/);
    assert.match(texts, /\[image omitted: the host refused this message with the image inline \(image\/png, ~\d+(\.\d)?(KB|MB)\)\. The attachment line below names it and links to it\.\]/);
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
    assert.ok(errors.includes("[discord-mcpl] host didn't take message m1 in discord:g1:chan1: coalesce_invalid"));
  });

  it('a refusal that is not about content (empty_content) is logged and not resent', async () => {
    const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false, reason: 'empty_content' }] }), { open: true });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes("[discord-mcpl] host didn't take message m1 in discord:g1:chan1: empty_content"));
  });

  it('a resend the host refuses too is logged, and nothing more is sent', async () => {
    const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }), { open: true });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 2);
    assert.ok(errors.some((e) => e.endsWith("host didn't take it again: coalesce_invalid")), errors.join('\n'));
  });

  it('a -32602 error for the whole request is the host refusing it: logged in its own words, then resent without the image', async () => {
    const host = scriptedHost((_m, _p, n) => n === 1
      ? { error: { code: -32602, message: 'invalid params' } }
      : { result: { results: [{ messageId: 'm1', accepted: true }] } });
    const { server, sent } = wire(() => undefined, { open: true, host });
    await deliver(server, BIG_IMAGE);
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: invalid params'), errors.join('\n'));
    assert.equal(sent.length, 2);
    assert.equal(contentOf(sent[1]).some((b: any) => b.type === 'image'), false);
  });

  it('a channels/incoming request mcpl-core times out is a send failure, not a refusal, and is not resent', async () => {
    const host = scriptedHost(() => 'no answer');
    const { server, sent } = wire(() => undefined, { open: true, host });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] channels/incoming failed:')), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes('host rejected') || e.includes("didn't take")), false);
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

  it('a push/event request mcpl-core times out is a send failure, not a refusal, and is not resent', async () => {
    const host = scriptedHost(() => 'no answer');
    const { server, sent } = wire(() => undefined, { host });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] push/event failed:')), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes('host rejected') || e.includes("didn't take")), false);
  });

  it('a resend mcpl-core times out is logged as a failed resend, not as sent', async () => {
    const host = scriptedHost((_m, _p, n) => n === 1
      ? { error: { code: -32602, message: 'content exceeds host byte limit' } }
      : 'no answer');
    const { server, sent } = wire(() => undefined, { host });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 2);
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: content exceeds host byte limit'), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] resent message m1 in discord:g1:chan1 with 1 inline attachment(s) replaced by a note: send failed:')), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes('sent (no verdict)')), false);
  });

  it("a feature-set refusal (-32001) is a refusal in the host's words, and is not resent", async () => {
    const host = scriptedHost(() => ({ error: { code: -32001, message: 'Feature set not enabled: discord.messaging' } }));
    const { server, sent } = wire(() => undefined, { host });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: Feature set not enabled: discord.messaging'), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes('failed')), false);
  });

  it('an accepted push logs nothing as refused', async () => {
    const { server, sent } = wire(() => ({ accepted: true, inferenceId: 'i1' }));
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 1);
    assert.deepEqual(errors, []);
  });
});

describe('edits and deletes: a refusal is logged', () => {
  it('logs the refusal of an edit', async () => {
    const { sent, edit } = wire(() => ({ accepted: false, reason: 'coalesce_invalid' }));
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.length > 0);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected edit of message m9 in discord:g1:chan1: coalesce_invalid'), errors.join('\n'));
  });

  it('logs an edit the host refuses with an error code, in the host\'s words', async () => {
    const { sent, edit } = wire(() => { throw rpcError(-32023, 'channel not declared'); });
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.length > 0);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected edit of message m9 in discord:g1:chan1: channel not declared'), errors.join('\n'));
  });

  it('logs the refusal of a delete', async () => {
    const { sent, del } = wire(() => ({ accepted: false, reason: 'duplicate' }));
    del()('chan1', 'm9', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.length > 0);
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected delete of message m9 in discord:g1:chan1: duplicate'), errors.join('\n'));
  });
});

describe('an edit that replaces a create carries what the agent was sent', () => {
  // Refuses the create as a budgeted host does, on either lane, and accepts
  // the resend and the edit.
  const refuseCreate: Responder = (m, _p, n) => {
    if (m === 'channels/incoming') {
      return n === 1
        ? { results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }
        : { results: [{ messageId: 'm1', accepted: true }] };
    }
    if (n === 1) throw rpcError(-32602, 'content exceeds host byte limit');
    return { accepted: true, inferenceId: 'i1' };
  };
  const editM1 = (edit: () => EditHandler) =>
    edit()('chan1', 'm1', 'look at this one', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });

  for (const lane of ['channels/incoming', 'push/event'] as const) {
    for (const [size, image] of [['under', SMALL_IMAGE], ['over', BIG_IMAGE]] as const) {
      it(`after a ${lane} create refused and resent, keeps the omission note and the link, without the image, for an image ${size} the 64 KiB a create remembers`, async () => {
        const { server, sent, edit } = wire(refuseCreate, { open: lane === 'channels/incoming' });
        await deliver(server, image);
        assert.deepEqual(sent.map((r) => r.method), [lane, lane]);
        editM1(edit);
        await until(() => sent.length === 3);
        assert.equal(sent[2].method, 'push/event');
        const edited = contentOf(sent[2]);
        assert.equal(edited.some((b: any) => b.type === 'image'), false);
        const texts = edited.map((b: any) => b.text ?? '').join('\n');
        assert.match(texts, /look at this one \[edited\]/);
        assert.match(texts, /\[image omitted: the host refused this message with the image inline/);
        assert.match(texts, /\[image attachment: shot\.png — https:\/\/cdn\.example\/shot\.png\]/);
      });
    }
  }

  it('after a resend whose attachment blocks still pass 64 KiB, carries the placeholder, so the memory stays bounded', async () => {
    const big = 'x'.repeat(70_000);
    const { server, sent, edit } = wire(refuseCreate, { open: true });
    await deliver(server, SMALL_IMAGE, [textContent(`[attachment: notes.txt]\n${big}`)]);
    editM1(edit);
    await until(() => sent.length === 3);
    const edited = contentOf(sent[2]);
    const texts = edited.map((b: any) => b.text ?? '').join('\n');
    assert.equal(edited.some((b: any) => b.type === 'image'), false);
    assert.match(texts, /\[attachments as in the original message\]/);
    assert.equal(texts.includes(big), false, 'the large text attachment is not kept for the edit');
  });

  it('after an accepted create, carries an image the create remembers, and the placeholder for one over 64 KiB', async () => {
    for (const [image, kept] of [[SMALL_IMAGE, true], [BIG_IMAGE, false]] as const) {
      const { server, sent, edit } = wire((m) => m === 'channels/incoming'
        ? { results: [{ messageId: 'm1', accepted: true }] }
        : { accepted: true, inferenceId: 'i1' }, { open: true });
      await deliver(server, image);
      editM1(edit);
      await until(() => sent.length === 2);
      const edited = contentOf(sent[1]);
      const texts = edited.map((b: any) => b.text ?? '').join('\n');
      if (kept) {
        assert.equal(edited.filter((b: any) => b.type === 'image' && b.data === image).length, 1, 'the image the create remembers');
        assert.match(texts, /\[image attachment: shot\.png — https:\/\/cdn\.example\/shot\.png\]/);
      } else {
        assert.equal(edited.some((b: any) => b.type === 'image'), false);
        assert.match(texts, /\[attachments as in the original message\]/);
      }
    }
  });

  it('an edit that arrives while the resend is unanswered waits for it', async () => {
    let answerResend!: () => void;
    const resendAnswered = new Promise<void>((r) => { answerResend = r; });
    const { server, sent, edit } = wire(async (m, p, n) => {
      if (n === 2) await resendAnswered;
      return refuseCreate(m, p, n);
    }, { open: true });
    const delivered = deliver(server, SMALL_IMAGE);
    await until(() => sent.length === 2);
    edit()('chan1', 'm1', 'look at this one', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 2, 'the edit waits while the resend is unanswered');
    answerResend();
    await delivered;
    await until(() => sent.length === 3);
    assert.equal(sent[2].method, 'push/event');
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

  it("reads an error the host refuses a request with as its refusal, in the host's own words", () => {
    assert.deepEqual(errorRejection(rpcError(-32602, 'bad')), { reason: 'bad', code: -32602 });
    assert.deepEqual(errorRejection(rpcError(-32001, 'Feature set not enabled: x')), { reason: 'Feature set not enabled: x', code: -32001 });
    assert.deepEqual(errorRejection(rpcError(-32601, 'Method not found')), { reason: 'Method not found', code: -32601 });
    assert.deepEqual(errorRejection(rpcError(-32602, '')), { reason: 'unspecified', code: -32602 });
    // Stands in for a later mcpl-core, whose RpcError keeps the host's message
    // as it came; 0.2.1 can't make this one.
    assert.deepEqual(errorRejection({ code: -32602, message: 'bad' }), { reason: 'bad', code: -32602 });
  });

  it('an error that is no verdict on the message is no refusal: no answer, or the host failing', () => {
    assert.equal(errorRejection(new ConnectionClosedError()), undefined);
    assert.equal(errorRejection(new Error('closed')), undefined);
    assert.equal(errorRejection(rpcError(-32000, 'host could not persist the acceptance; retry')), undefined);
    assert.equal(errorRejection(rpcError(-32603, 'Internal error')), undefined);
    // mcpl-core 0.2.1's own timeout comes from mcpl-core in the lanes' tests.
    // This stands in for a later mcpl-core's ConnectionTimeoutError, an
    // RpcError with -32000, which 0.2.1 can't make.
    const later = Object.assign(new Error('push/event timed out: no reply came within 50 ms, so whether it ran is unknown.'),
      { name: 'ConnectionTimeoutError', code: -32000 });
    assert.equal(errorRejection(later), undefined);
  });

  it('counts a -32602 error and coalesce_invalid as content refusals, and nothing else', () => {
    assert.equal(isContentRejection({ reason: 'coalesce_invalid' }), true);
    assert.equal(isContentRejection({ reason: 'content exceeds host byte limit', code: -32602 }), true);
    assert.equal(isContentRejection({ reason: 'anything', code: -32602 }), true);
    assert.equal(isContentRejection({ reason: 'rate limit exceeded' }), false);
    assert.equal(isContentRejection({ reason: 'empty_content' }), false);
    assert.equal(isContentRejection({ reason: 'duplicate' }), false);
    assert.equal(isContentRejection({ reason: 'unknown channel "x" — register it first (§14.5)' }), false);
    assert.equal(isContentRejection({ reason: 'host could not persist the acceptance; retry', code: -32000 }), false);
    assert.equal(isContentRejection({ reason: 'Feature set not enabled: x', code: -32001 }), false);
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
    const { content: out, replaced } = withoutInlineMedia(content);
    assert.equal(replaced, 1);
    assert.equal((out[0] as any).text, 'hi');
    // The agent is told what is missing and where to find it; the host's
    // reason is the operator's, on stderr.
    assert.equal((out[1] as any).text,
      '[image omitted: the host refused this message with the image inline (image/png, ~3B). The attachment line below names it and links to it.]');
    assert.deepEqual(out[2], content[2]);
  });
});

/**
 * agent-framework's coalescer answers -32000 "host could not persist the
 * acceptance; retry" (or "… make the acceptance durable; retry") when it took
 * an occurrence but couldn't keep its receipt, and asks the producer to send
 * the SAME occurrence again within its retry window. One retry, same eventId
 * and coalesce member; never for mcpl-core's own -32000 timeout.
 */
describe("an acceptance the host couldn't keep is sent once more as the same occurrence", () => {
  const PERSIST = 'host could not persist the acceptance; retry';
  const DURABLE = 'host could not make the acceptance durable; retry';
  const fast = (server: DiscordMcplServer, ms = 5) => { (server as any).persistRetryDelayMs = ms; };

  it('channels/incoming: a persist failure is retried once with the same eventId and content, and the acceptance logged', async () => {
    const { server, sent } = wire((_m, _p, n) => n === 1
      ? { results: [{ messageId: 'm1', accepted: false, reason: PERSIST }] }
      : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
    fast(server);
    await deliver(server, SMALL_IMAGE);
    assert.equal(sent.length, 2, 'exactly one retry');
    assert.equal(eventIdOf(sent[1]), eventIdOf(sent[0]));
    assert.equal(eventIdOf(sent[1]), 'discord_msg_m1');
    assert.deepEqual(coalesceOf(sent[1]), coalesceOf(sent[0]));
    // The same occurrence: the image is still inline (not the media-omitted resend).
    assert.deepEqual(contentOf(sent[1]), contentOf(sent[0]));
    assert.ok(errors.includes(`[discord-mcpl] host couldn't keep message m1 in discord:g1:chan1 (${PERSIST}); retrying once with the same event id in 5ms`), errors.join('\n'));
    assert.ok(errors.includes('[discord-mcpl] retried message m1 in discord:g1:chan1 with the same event id: accepted'), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes("didn't take") || e.includes('host rejected')), false);
  });

  it('push/event: the host\'s -32000 "durable; retry" error (through mcpl-core) is retried once with the same eventId', async () => {
    const host = scriptedHost((_m, _p, n) => n === 1
      ? { error: { code: -32000, message: DURABLE } }
      : { result: { accepted: true } });
    const { server, sent } = wire(() => undefined, { host });
    fast(server);
    await deliver(server, SMALL_IMAGE);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].method, 'push/event');
    assert.equal(eventIdOf(sent[1]), eventIdOf(sent[0]));
    assert.deepEqual(coalesceOf(sent[1]), coalesceOf(sent[0]));
    assert.deepEqual(contentOf(sent[1]), contentOf(sent[0]));
    assert.ok(errors.includes('[discord-mcpl] retried message m1 in discord:g1:chan1 with the same event id: accepted'), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes('push/event failed')), false);
  });

  it('a retry the host still can\'t keep is logged and nothing more is sent', async () => {
    const host = scriptedHost(() => ({ error: { code: -32000, message: PERSIST } }));
    const { server, sent } = wire(() => undefined, { host });
    fast(server);
    await deliver(server, SMALL_IMAGE);
    assert.equal(sent.length, 2, 'one retry, no loop');
    assert.ok(errors.includes(`[discord-mcpl] retried message m1 in discord:g1:chan1 with the same event id: still not kept: ${PERSIST}`), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] push/event failed:') && e.includes('(after one retry)')), errors.join('\n'));
  });

  it("a retry the host refuses is handled as that refusal (here: for its content, so the media-omitted resend follows)", async () => {
    const { server, sent } = wire((_m, _p, n) => n === 1
      ? { results: [{ messageId: 'm1', accepted: false, reason: PERSIST }] }
      : n === 2
        ? { results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }
        : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
    fast(server);
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 3);
    assert.equal(eventIdOf(sent[1]), 'discord_msg_m1');
    assert.equal(eventIdOf(sent[2]), 'discord_msg_m1_media_omitted');
    assert.ok(errors.includes('[discord-mcpl] retried message m1 in discord:g1:chan1 with the same event id: host rejected it: coalesce_invalid'), errors.join('\n'));
  });

  it("mcpl-core's own -32000 timeout is not retried: its outcome is unknown", async () => {
    const host = scriptedHost(() => 'no answer');
    const { server, sent } = wire(() => undefined, { host });
    fast(server);
    await deliver(server, SMALL_IMAGE);
    assert.equal(sent.length, 1);
    assert.equal(errors.some((e) => e.includes('retrying once') || e.includes('retried')), false);
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] push/event failed:')), errors.join('\n'));
  });

  it('"host is stopping" (-32000) is not retried', async () => {
    const host = scriptedHost(() => ({ error: { code: -32000, message: 'host is stopping' } }));
    const { server, sent } = wire(() => undefined, { host });
    fast(server);
    await deliver(server, SMALL_IMAGE);
    assert.equal(sent.length, 1);
    assert.equal(errors.some((e) => e.includes('retrying once')), false);
  });

  it('an edit the host couldn\'t keep is retried once with the same eventId', async () => {
    const { server, sent, edit } = wire((_m, _p, n) => n === 1 ? { accepted: false, reason: PERSIST } : { accepted: true });
    fast(server);
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.some((e) => e.startsWith('[discord-mcpl] retried edit')));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].params.eventId, sent[0].params.eventId);
    assert.ok(errors.includes('[discord-mcpl] retried edit of message m9 in discord:g1:chan1 with the same event id: accepted'), errors.join('\n'));
  });

  it('an edit is not retried once a later edit of the message has been sent: the later one supersedes it', async () => {
    let answerFirst!: (v: unknown) => void;
    const firstAnswer = new Promise((r) => { answerFirst = r; });
    const { server, sent, edit } = wire((_m, _p, n) => n === 1 ? firstAnswer : { accepted: true });
    fast(server);
    const info = { guildId: 'g1', authorId: 'u1', authorName: 'someone' };
    edit()('chan1', 'm9', 'first', false, info);
    await until(() => sent.length === 1);
    edit()('chan1', 'm9', 'second', false, info);
    await until(() => sent.length === 2);
    answerFirst({ accepted: false, reason: PERSIST });
    await until(() => errors.some((e) => e.includes('not retried')));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 2, 'the superseded edit is not resent');
    assert.ok(errors.includes(`[discord-mcpl] host couldn't keep edit of message m9 in discord:g1:chan1 (${PERSIST}); not retried: a later edit or delete of the message has been sent since`), errors.join('\n'));
  });

  it('an edit that arrives while a retry is waited out goes after the retry, never before it', async () => {
    const { server, sent, edit } = wire((_m, _p, n) => n === 1 ? { accepted: false, reason: PERSIST } : { accepted: true });
    fast(server, 40);
    const info = { guildId: 'g1', authorId: 'u1', authorName: 'someone' };
    edit()('chan1', 'm9', 'first', false, info);
    await until(() => errors.some((e) => e.includes('retrying once')));
    edit()('chan1', 'm9', 'second', false, info);
    await until(() => sent.length === 3);
    assert.equal(sent[1].params.eventId, sent[0].params.eventId, 'the retry is the first edit, again');
    assert.notEqual(sent[2].params.eventId, sent[0].params.eventId, 'the second edit comes after it');
    assert.match(JSON.stringify(sent[2].params.payload), /second/);
  });

  it('a delete the host couldn\'t keep is retried once with the same eventId', async () => {
    const host = scriptedHost((_m, _p, n) => n === 1
      ? { error: { code: -32000, message: PERSIST } }
      : { result: { accepted: true } });
    const { server, sent, del } = wire(() => undefined, { host });
    fast(server);
    del()('chan1', 'm9', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.some((e) => e.startsWith('[discord-mcpl] retried delete')));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].params.eventId, sent[0].params.eventId);
    assert.deepEqual(sent[1].params.coalesce, sent[0].params.coalesce);
  });

  it('the wait is capped at half the retry window the host advertises', () => {
    const { server } = wire(() => undefined);
    (server as any).persistRetryDelayMs = 1000;
    (server as any).hostRetryWindowMs = 10;
    assert.equal((server as any).persistRetryDelay(), 5);
    (server as any).hostRetryWindowMs = 3_600_000;
    assert.equal((server as any).persistRetryDelay(), 1000);
  });

  it('helpers: only the host\'s exact words, with -32000 on an error, count', () => {
    assert.equal(isUnpersistedAnswer(PERSIST), true);
    assert.equal(isUnpersistedAnswer(DURABLE), true);
    assert.equal(isUnpersistedAnswer('host is stopping'), false);
    assert.equal(isUnpersistedAnswer('coalesce_invalid'), false);
    assert.equal(isUnpersistedAnswer(undefined), false);
    // mcpl-core 0.2.1 prefixes the host's words.
    assert.equal(unpersistedError(rpcError(-32000, PERSIST)), PERSIST);
    assert.equal(unpersistedError({ code: -32000, message: DURABLE }), DURABLE);
    // mcpl-core's own timeout is -32000 too, in other words.
    assert.equal(unpersistedError(rpcError(-32000, 'Request timed out after 50ms: push/event')), undefined);
    assert.equal(unpersistedError(rpcError(-32000, 'host is stopping')), undefined);
    assert.equal(unpersistedError({ code: -32602, message: PERSIST }), undefined);
    assert.equal(unpersistedError(new ConnectionClosedError()), undefined);
    assert.equal(advertisedRetryWindowMs({ pushEvents: true, retryWindowMs: 3_600_000 }), 3_600_000);
    assert.equal(advertisedRetryWindowMs(true), undefined);
    assert.equal(advertisedRetryWindowMs({ retryWindowMs: -1 }), undefined);
  });
});
