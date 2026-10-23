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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConnectionClosedError, McplConnection, RpcError, textContent } from '@animalabs/mcpl-core';
import type { ContentBlock } from '@animalabs/mcpl-core';
import type { DiscordAdapter, MessageEventInfo } from '../src/discord-adapter.js';
import { ChannelManager, toDescriptor } from '../src/channels.js';
import { DiscordMcplServer } from '../src/server.js';
import {
  advertisedRetryWindowMs,
  answerClass,
  errorRejection,
  incomingOutcome,
  isContentRejection,
  pushOutcome,
  summarizeAttachments,
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

function wire(respond: Responder, opts: { open?: boolean; host?: ReturnType<typeof scriptedHost>; coalescing?: boolean } = {}) {
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
  // The connection's start-up has settled, as serve() marks it.
  s.readyConn = s.conn;
  // Resends a few milliseconds apart, so the tests don't wait out the real ones.
  s.retryDelaysMs = [5, 5, 5, 5, 5];
  s.mcplEnabled = true;
  // A coalescing host, as the fleet's are: every create carries `coalesce`.
  // `coalescing: false` stands for a host that advertises none.
  s.hostCoalescing = opts.coalescing === false
    ? undefined
    : { pushEvents: true, channelsIncoming: true, channelScopedPush: false };
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

  it('a refusal the spec gives no meaning (empty_content) is sent once more as the same occurrence, then logged, and never without its media', async () => {
    const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false, reason: 'empty_content' }] }), { open: true });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 2);
    assert.equal(eventIdOf(sent[1]), 'discord_msg_m1');
    assert.deepEqual(contentOf(sent[1]), contentOf(sent[0]));
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

  it('a channels/incoming request mcpl-core times out is a send failure, not a refusal: sent again as the same occurrence, then logged as failed', async () => {
    const host = scriptedHost(() => 'no answer');
    const { server, sent } = wire(() => undefined, { open: true, host });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 6, 'the first send and five resends');
    assert.equal(new Set(sent.map(eventIdOf)).size, 1);
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

  it('an {accepted:false} result for a non-content reason is sent once more as the same occurrence, then logged', async () => {
    const { server, sent } = wire(() => ({ accepted: false, reason: 'duplicate' }));
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 2);
    assert.equal(eventIdOf(sent[1]), eventIdOf(sent[0]));
    assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: duplicate'), errors.join('\n'));
  });

  it('a push/event request mcpl-core times out is a send failure, not a refusal: sent again as the same occurrence, then logged as failed', async () => {
    const host = scriptedHost(() => 'no answer');
    const { server, sent } = wire(() => undefined, { host });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 6, 'the first send and five resends');
    assert.equal(new Set(sent.map(eventIdOf)).size, 1);
    assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] push/event failed:')), errors.join('\n'));
    assert.equal(errors.some((e) => e.includes('host rejected') || e.includes("didn't take")), false);
  });

  it('a resend mcpl-core times out is logged as a failed resend, not as sent', async () => {
    const host = scriptedHost((_m, _p, n) => n === 1
      ? { error: { code: -32602, message: 'content exceeds host byte limit' } }
      : 'no answer');
    const { server, sent } = wire(() => undefined, { host });
    await deliver(server, BIG_IMAGE);
    assert.equal(sent.length, 7, 'the create, then the resend without media and its own five');
    assert.ok(sent.slice(1).every((r) => eventIdOf(r) === 'discord_msg_m1_media_omitted'));
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
    const { sent, edit } = wire(() => { throw rpcError(-32001, 'Feature set not enabled: discord.messaging'); });
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.some((e) => e.startsWith('[discord-mcpl] host rejected')));
    assert.equal(sent.length, 1);
    assert.ok(errors.includes('[discord-mcpl] host rejected edit of message m9 in discord:g1:chan1: Feature set not enabled: discord.messaging'), errors.join('\n'));
  });

  it('logs an edit refused for an unknown channel, after announcing the channel and sending the edit once more', async () => {
    const { sent, edit } = wire(() => { throw rpcError(-32023, 'channel not declared'); });
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.some((e) => e.startsWith('[discord-mcpl] host rejected')));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].params.eventId, sent[0].params.eventId);
    assert.ok(errors.includes('[discord-mcpl] host rejected edit of message m9 in discord:g1:chan1: channel not declared'), errors.join('\n'));
  });

  it('logs the refusal of a delete, after sending it once more (a refusal the spec gives no meaning)', async () => {
    const { sent, del } = wire(() => ({ accepted: false, reason: 'duplicate' }));
    del()('chan1', 'm9', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.some((e) => e.startsWith('[discord-mcpl] host rejected')));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].params.eventId, sent[0].params.eventId);
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
    // The spec's own codes in the server-error range are refusals too.
    assert.deepEqual(errorRejection(rpcError(-32023, 'Unknown channel')), { reason: 'Unknown channel', code: -32023 });
    assert.deepEqual(errorRejection(rpcError(-32017, 'no')), { reason: 'no', code: -32017 });
    // A code outside JSON-RPC's reserved ranges is a refusal the spec gives no meaning.
    assert.deepEqual(errorRejection(rpcError(4001, 'nope')), { reason: 'nope', code: 4001 });
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
    // Any implementation-defined server error: the spec defines no -32050.
    assert.equal(errorRejection(rpcError(-32050, 'busy')), undefined);
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
 * Sending the same occurrence again, by what the MCPL spec defines and never
 * by one host's words: answerClass reads an answer as done, final, an
 * unknown channel, a refusal the spec gives no meaning, or no verdict. A
 * coalescing host's retry window (RFC-006 §3.1) is what makes the same
 * eventId safe to send again, so only a host that advertises one gets resends
 * of a refusal or of an uncertain answer.
 */
describe('sending the same occurrence again, by what the spec defines', () => {
  const info = { guildId: 'g1', authorId: 'u1', authorName: 'someone' };
  const delays = (server: DiscordMcplServer, ms: number, n = 5) => { (server as any).retryDelaysMs = Array(n).fill(ms); };

  describe('creates', () => {
    it('a refusal the spec gives no meaning (a free-text item reason) is sent once more, the same occurrence, and its acceptance logged', async () => {
      const reason = 'host could not persist the acceptance; retry';
      const { server, sent } = wire((_m, _p, n) => n === 1
        ? { results: [{ messageId: 'm1', accepted: false, reason }] }
        : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 2, 'one resend');
      assert.equal(eventIdOf(sent[1]), 'discord_msg_m1');
      assert.deepEqual(coalesceOf(sent[1]), coalesceOf(sent[0]));
      // The same occurrence: the image is still inline.
      assert.deepEqual(contentOf(sent[1]), contentOf(sent[0]));
      assert.ok(errors.includes(`[discord-mcpl] message m1 in discord:g1:chan1: host didn't take it: ${reason}; sending the same occurrence again (same event id) in 5ms`), errors.join('\n'));
      assert.ok(errors.includes('[discord-mcpl] sent message m1 in discord:g1:chan1 again (same event id): accepted'), errors.join('\n'));
      assert.equal(errors.some((e) => e.startsWith('[discord-mcpl] host')), false, 'nothing reported as refused');
    });

    it('a refusal the spec gives no meaning, refused again, is logged and not sent a third time', async () => {
      const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false }] }), { open: true });
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 2);
      assert.ok(errors.includes("[discord-mcpl] host didn't take message m1 in discord:g1:chan1: unspecified"), errors.join('\n'));
    });

    it('no answer, or an implementation-defined server error, is sent again as the same occurrence until one comes', async () => {
      const host = scriptedHost((_m, _p, n) => n === 1 ? 'no answer'
        : n === 2 ? { error: { code: -32000, message: 'host is stopping' } }
          : n === 3 ? { error: { code: -32603, message: 'Internal error' } }
            : { result: { accepted: true } });
      const { server, sent } = wire(() => undefined, { host });
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 4);
      assert.equal(new Set(sent.map(eventIdOf)).size, 1);
      assert.ok(sent.every((r) => JSON.stringify(contentOf(r)) === JSON.stringify(contentOf(sent[0]))));
      assert.ok(errors.includes('[discord-mcpl] sent message m1 in discord:g1:chan1 again (same event id): accepted'), errors.join('\n'));
      assert.equal(errors.some((e) => e.startsWith('[discord-mcpl] push/event failed')), false);
    });

    it('no answer after every resend: logged as sent that many times, then as a failed send', async () => {
      const host = scriptedHost(() => ({ error: { code: -32000, message: 'host could not make the acceptance durable; retry' } }));
      const { server, sent } = wire(() => undefined, { host });
      delays(server, 2, 3);
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 4, 'the first send and three resends');
      assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] message m1 in discord:g1:chan1: send failed:') && e.endsWith('not sent again: sent 4 times')), errors.join('\n'));
      assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] push/event failed:')), errors.join('\n'));
    });

    it('a resend the host refuses as malformed is handled as that refusal: the media-omitted resend follows', async () => {
      const { server, sent } = wire((_m, _p, n) => n === 1
        ? { results: [{ messageId: 'm1', accepted: false, reason: 'storage busy' }] }
        : n === 2
          ? { results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }
          : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
      await deliver(server, BIG_IMAGE);
      assert.equal(sent.length, 3);
      assert.equal(eventIdOf(sent[1]), 'discord_msg_m1');
      assert.equal(eventIdOf(sent[2]), 'discord_msg_m1_media_omitted');
      assert.ok(errors.includes("[discord-mcpl] sent message m1 in discord:g1:chan1 again (same event id): host didn't take it: coalesce_invalid"), errors.join('\n'));
    });

    it('the media-omitted resend is sent again as itself, never with the media', async () => {
      const { server, sent } = wire((_m, _p, n) => n === 1
        ? { results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }
        : n === 2
          ? { results: [{ messageId: 'm1', accepted: false, reason: 'storage busy' }] }
          : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
      await deliver(server, BIG_IMAGE);
      assert.equal(sent.length, 3, 'the create, the resend, the same resend again');
      assert.equal(eventIdOf(sent[2]), 'discord_msg_m1_media_omitted');
      assert.deepEqual(coalesceOf(sent[2]), { key: 'message:m1', initial: true });
      assert.deepEqual(contentOf(sent[2]), contentOf(sent[1]));
      assert.equal(contentOf(sent[2]).some((b: any) => b.type === 'image'), false);
      assert.ok(errors.includes('[discord-mcpl] sent message m1 in discord:g1:chan1 (resent without inline media) again (same event id): accepted'), errors.join('\n'));
      assert.ok(errors.some((e) => e.startsWith('[discord-mcpl] resent message m1 in discord:g1:chan1 with 1 inline attachment(s) replaced by a note: accepted')), errors.join('\n'));
    });

    for (const [code, message] of [[-32001, 'Feature set not enabled: discord.messaging'], [-32017, 'Channel not permitted'], [-32024, 'Channel open failed'], [-32601, 'Method not found']] as const) {
      it(`a refusal the spec defines (${code}) is final: logged, never sent again`, async () => {
        const host = scriptedHost(() => ({ error: { code, message } }));
        const { server, sent } = wire(() => undefined, { host });
        await deliver(server, SMALL_IMAGE);
        assert.equal(sent.length, 1);
        assert.ok(errors.includes(`[discord-mcpl] host rejected message m1 in discord:g1:chan1: ${message}`), errors.join('\n'));
      });
    }

    it('an unknown channel (-32023): the channel is announced to the host again, and the same occurrence sent once more', async () => {
      const host = scriptedHost((_m, _p, n) => n === 1
        ? { error: { code: -32023, message: 'Unknown channel' } }
        : { result: { accepted: true } });
      const { server, sent } = wire(() => undefined, { host });
      const notified: any[] = [];
      (host.conn as any).sendNotification = (method: string, params: unknown) => { notified.push({ method, params }); };
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 2);
      assert.equal(eventIdOf(sent[1]), eventIdOf(sent[0]));
      const announced = notified.filter((n) => n.method === 'channels/changed').flatMap((n) => n.params.added ?? []);
      assert.ok(announced.some((d: any) => d.id === 'discord:g1:chan1'), JSON.stringify(notified));
      assert.ok(errors.includes('[discord-mcpl] sent message m1 in discord:g1:chan1 again (same event id): accepted'), errors.join('\n'));
    });

    it('an unknown channel refused again is final', async () => {
      const host = scriptedHost(() => ({ error: { code: -32023, message: 'Unknown channel' } }));
      const { server, sent } = wire(() => undefined, { host });
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 2);
      assert.ok(errors.includes('[discord-mcpl] host rejected message m1 in discord:g1:chan1: Unknown channel'), errors.join('\n'));
    });

    it('a host that advertises no event coalescing gets each occurrence once: no resend of a refusal or of no answer', async () => {
      const refusing = wire(() => ({ accepted: false }), { coalescing: false });
      await deliver(refusing.server, SMALL_IMAGE);
      assert.equal(refusing.sent.length, 1);
      const host = scriptedHost(() => 'no answer');
      const silent = wire(() => undefined, { host, coalescing: false });
      await deliver(silent.server, SMALL_IMAGE);
      assert.equal(host.sent.length, 1);
      assert.equal(errors.some((e) => e.includes('same occurrence again') || e.includes('(same event id')), false, errors.join('\n'));
    });

    it('…but an unknown channel is announced and the occurrence sent once more, on any host: it was not admitted', async () => {
      const host = scriptedHost((_m, _p, n) => n === 1
        ? { error: { code: -32023, message: 'Unknown channel' } }
        : { result: { accepted: true } });
      const { server, sent } = wire(() => undefined, { host, coalescing: false });
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 2);
      assert.equal(eventIdOf(sent[1]), eventIdOf(sent[0]));
    });

    it("no resend whose wait would end after half the host's retry window, counted from the first send", async () => {
      const host = scriptedHost(() => ({ error: { code: -32000, message: 'busy' } }));
      const { server, sent } = wire(() => undefined, { host });
      (server as any).hostRetryWindowMs = 400;
      (server as any).retryDelaysMs = [50, 300, 5, 5, 5];
      const started = Date.now();
      await deliver(server, SMALL_IMAGE);
      // The deadline is 200 ms after the first send: the 50 ms wait fits, the
      // 300 ms one doesn't, and nothing is sent in a burst before it.
      assert.equal(sent.length, 2);
      assert.ok(Date.now() - started < 1000);
      assert.ok(errors.some((e) => e.endsWith("not sent again: the host's retry window is closing")), errors.join('\n'));
    });

    it("a permission refusal before the connection's start-up settled is \"not yet\": sent once more when it has", async () => {
      const host = scriptedHost((_m, _p, n) => n === 1
        ? { error: { code: -32002, message: 'Capability denied: no policy yet' } }
        : { result: { accepted: true } });
      const { server, sent } = wire(() => undefined, { host });
      (server as any).readyConn = null;
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => sent.length === 1);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sent.length, 1, 'not before the start-up settles');
      (server as any).markReady(host.conn);
      await delivered;
      assert.equal(sent.length, 2);
      assert.equal(eventIdOf(sent[1]), eventIdOf(sent[0]));
      assert.ok(errors.includes("[discord-mcpl] message m1 in discord:g1:chan1: host rejected it: Capability denied: no policy yet, before the host's start-up had settled; sending the same occurrence again now that it has"), errors.join('\n'));
      assert.ok(errors.includes('[discord-mcpl] sent message m1 in discord:g1:chan1 again (same event id): accepted'), errors.join('\n'));
    });

    it('…and final once it has', async () => {
      const host = scriptedHost(() => ({ error: { code: -32002, message: 'Capability denied' } }));
      const { server, sent } = wire(() => undefined, { host });
      await deliver(server, SMALL_IMAGE);
      assert.equal(sent.length, 1);
    });

    it("no resend to a ready host that doesn't take Discord messages", async () => {
      const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false }] }), { open: true });
      delays(server, 20);
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      ((server as any).enabledFeatureSets as Set<string>).delete('discord.messaging');
      await delivered;
      assert.equal(sent.length, 1);
      assert.ok(errors.some((e) => e.endsWith("not sent again: the host connected now doesn't take Discord messages")), errors.join('\n'));
    });

    it('a resend waits at most reconnectWaitMs for a host, however long the retry window', async () => {
      const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false }] }), { open: true });
      (server as any).reconnectWaitMs = 50;
      delays(server, 5);
      const started = Date.now();
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      (server as any).conn = null;
      await delivered;
      assert.ok(Date.now() - started < 1000);
      assert.equal(sent.length, 1);
      assert.ok(errors.some((e) => e.endsWith('not sent again: no host connection was ready in time')), errors.join('\n'));
    });

    it('a create still being sent is never pushed out of the memory its edits wait on', () => {
      const { server } = wire(() => ({ accepted: true }));
      const pending = (server as any).rememberCreate('pending');
      for (let i = 0; i < 600; i++) (server as any).rememberCreate(`m${i}`).resolve();
      const memory = (server as any).recentCreates as Map<string, unknown>;
      assert.equal(memory.get('pending'), pending);
      assert.equal(memory.size, 512);
      pending.resolve();
      (server as any).rememberCreate('one-more').resolve();
      assert.equal(memory.has('pending'), false, 'once settled, it goes as the oldest');
    });

    it('after a reconnect, the resends are counted against the shortest retry window advertised meanwhile', async () => {
      const { server, sent } = wire(() => { throw rpcError(-32603, 'Internal error'); });
      (server as any).retryDelaysMs = [20, 300, 5];
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      const next: unknown[] = [];
      const conn2 = { sendRequest: () => { next.push(1); return Promise.reject(rpcError(-32603, 'Internal error')); }, sendNotification: () => {} };
      (server as any).conn = conn2;
      (server as any).hostRetryWindowMs = 200; // this host's: a 100 ms deadline from the first send
      (server as any).markReady(conn2);
      await delivered;
      assert.equal(sent.length, 1);
      assert.equal(next.length, 1, 'one resend to the host connected since, then none: the 300 ms wait passes its deadline');
      assert.ok(errors.some((e) => e.endsWith("not sent again: the host's retry window is closing")), errors.join('\n'));
    });

    it("a resend to the host connected since is skipped when the message's channel isn't open with it", async () => {
      const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false }] }), { open: true });
      delays(server, 20);
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      const next: unknown[] = [];
      const conn2 = { sendRequest: () => { next.push(1); return Promise.resolve({}); }, sendNotification: () => {} };
      (server as any).conn = conn2;
      ((server as any).channelManager as ChannelManager).close('discord:g1:chan1');
      (server as any).markReady(conn2);
      await delivered;
      assert.equal(sent.length, 1);
      assert.deepEqual(next, []);
      assert.ok(errors.some((e) => e.endsWith("not sent again: its channel isn't open with the host connected now")), errors.join('\n'));
    });

    it("a channel-scoped push isn't sent again to a host connected since that doesn't take them", async () => {
      const { server, sent, edit } = wire(() => ({ accepted: false, reason: 'busy' }));
      (server as any).hostCoalescing = { pushEvents: true, channelsIncoming: true, channelScopedPush: true };
      delays(server, 20);
      edit()('chan1', 'm9', 'fixed', false, info);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      assert.equal(sent[0].params.coalesce.channelId, 'discord:g1:chan1', 'scoped to its channel');
      const next: unknown[] = [];
      const conn2 = { sendRequest: () => { next.push(1); return Promise.resolve({ accepted: true }); }, sendNotification: () => {} };
      (server as any).conn = conn2;
      (server as any).hostCoalescing = { pushEvents: true, channelsIncoming: true, channelScopedPush: false };
      (server as any).markReady(conn2);
      await until(() => errors.some((e) => e.includes("doesn't take channel-scoped pushes")));
      assert.deepEqual(next, []);
    });

    it('a resend goes to the host connected since, once its start-up has settled, still the same occurrence', async () => {
      const { server, sent } = wire((_m, _p, n) => n === 1
        ? { results: [{ messageId: 'm1', accepted: false, reason: 'host is stopping' }] }
        : { results: [{ messageId: 'm1', accepted: true }] }, { open: true });
      delays(server, 20);
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      // The host goes; another connects, and isn't ready yet.
      const next: Array<{ method: string; params: any }> = [];
      const conn2 = {
        sendRequest: (m: string, p: unknown) => { next.push({ method: m, params: p }); return Promise.resolve({ results: [{ messageId: 'm1', accepted: true }] }); },
        sendNotification: () => {},
      };
      (server as any).conn = conn2;
      (server as any).readyConn = null;
      await new Promise((r) => setTimeout(r, 60));
      assert.deepEqual(next, [], 'nothing before its start-up settles');
      (server as any).markReady(conn2);
      await delivered;
      assert.equal(sent.length, 1, 'nothing more on the old connection');
      assert.equal(next.length, 1);
      assert.equal(eventIdOf(next[0]), 'discord_msg_m1');
      assert.deepEqual(contentOf(next[0]), contentOf(sent[0]));
      assert.ok(errors.includes('[discord-mcpl] sent message m1 in discord:g1:chan1 again (same event id, to the host connected since): accepted'), errors.join('\n'));
    });

    it('no resend to a host connected since that advertises no event coalescing', async () => {
      const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false }] }), { open: true });
      delays(server, 20);
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      const next: unknown[] = [];
      const conn2 = { sendRequest: (m: string) => { next.push(m); return Promise.resolve({}); }, sendNotification: () => {} };
      (server as any).conn = conn2;
      (server as any).hostCoalescing = undefined;
      (server as any).markReady(conn2);
      await delivered;
      assert.equal(sent.length, 1);
      assert.deepEqual(next, []);
      assert.ok(errors.some((e) => e.endsWith("not sent again: the host now connected doesn't coalesce events, so the same occurrence sent again could be a duplicate")), errors.join('\n'));
    });

    it("no resend when no host connection is ready before the retry window's deadline", async () => {
      const { server, sent } = wire(() => ({ results: [{ messageId: 'm1', accepted: false }] }), { open: true });
      // A 300 ms deadline: the 10 ms wait fits even on a slow machine.
      (server as any).hostRetryWindowMs = 600;
      delays(server, 10);
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      (server as any).conn = null;
      await delivered;
      assert.equal(sent.length, 1);
      assert.ok(errors.some((e) => e.endsWith('not sent again: no host connection was ready in time')), errors.join('\n'));
      assert.ok(errors.includes("[discord-mcpl] host didn't take message m1 in discord:g1:chan1: unspecified"), errors.join('\n'));
    });
  });

  describe('edits and deletes', () => {
    it('an edit with no verdict is sent again with the same eventId', async () => {
      const { sent, edit } = wire((_m, _p, n) => { if (n === 1) throw rpcError(-32000, 'host could not persist the acceptance; retry'); return { accepted: true }; });
      edit()('chan1', 'm9', 'fixed', false, info);
      await until(() => errors.some((e) => e.startsWith('[discord-mcpl] sent edit')));
      assert.equal(sent.length, 2);
      assert.equal(sent[1].params.eventId, sent[0].params.eventId);
      assert.ok(errors.includes('[discord-mcpl] sent edit of message m9 in discord:g1:chan1 again (same event id): accepted'), errors.join('\n'));
    });

    for (const words of ['host could not persist the acceptance; retry', 'host could not make the acceptance durable; retry']) {
      it(`a delete with no verdict ("${words}", -32000) is sent again with the same eventId and coalesce member`, async () => {
        const host = scriptedHost((_m, _p, n) => n === 1 ? { error: { code: -32000, message: words } } : { result: { accepted: true } });
        const { sent, del } = wire(() => undefined, { host });
        del()('chan1', 'm9', false, info);
        await until(() => errors.some((e) => e.startsWith('[discord-mcpl] sent delete')));
        assert.equal(sent.length, 2);
        assert.equal(sent[1].params.eventId, sent[0].params.eventId);
        assert.deepEqual(sent[1].params.coalesce, sent[0].params.coalesce);
      });
    }

    for (const later of ['edit', 'delete'] as const) {
      it(`an edit is not sent again once a later ${later} of the message has gone out`, async () => {
        let answerFirst!: (v: unknown) => void;
        const firstAnswer = new Promise((r) => { answerFirst = r; });
        const { sent, edit, del } = wire((_m, _p, n) => n === 1 ? firstAnswer : { accepted: true });
        edit()('chan1', 'm9', 'first', false, info);
        await until(() => sent.length === 1);
        if (later === 'edit') edit()('chan1', 'm9', 'second', false, info);
        else del()('chan1', 'm9', false, info);
        await until(() => sent.length === 2);
        answerFirst({ accepted: false, reason: 'storage busy' });
        await until(() => errors.some((e) => e.includes('not sent again')));
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(sent.length, 2, 'the earlier edit is not sent again after the later one');
        assert.ok(errors.includes('[discord-mcpl] edit of message m9 in discord:g1:chan1: host rejected it: storage busy; not sent again: a later edit or delete of the message has been sent since'), errors.join('\n'));
      });
    }

    it('an edit that arrives while an earlier one waits to be sent again goes at once, and supersedes it', async () => {
      const { server, sent, edit } = wire((_m, _p, n) => n === 1 ? { accepted: false, reason: 'storage busy' } : { accepted: true });
      delays(server, 60);
      edit()('chan1', 'm9', 'first', false, info);
      await until(() => errors.some((e) => e.includes('sending the same occurrence again')));
      edit()('chan1', 'm9', 'second', false, info);
      await until(() => sent.length === 2);
      assert.match(JSON.stringify(sent[1].params.payload), /second/, "the later edit doesn't wait");
      await until(() => errors.some((e) => e.includes('not sent again')));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sent.length, 2, 'the earlier edit is never sent again');
    });

    it('an edit refused for permission before start-up settled is "not yet": sent once more when it has', async () => {
      const { server, sent, edit } = wire((_m, _p, n) => { if (n === 1) throw rpcError(-32002, 'no policy yet'); return { accepted: true }; });
      (server as any).readyConn = null;
      edit()('chan1', 'm9', 'fixed', false, info);
      await until(() => sent.length === 1);
      await new Promise((r) => setTimeout(r, 20));
      (server as any).markReady((server as any).conn);
      await until(() => sent.length === 2);
      assert.equal(sent[1].params.eventId, sent[0].params.eventId);
    });

    it('…but not once a later edit has gone out while it waited', async () => {
      const { server, sent, edit } = wire((_m, _p, n) => { if (n === 1) throw rpcError(-32002, 'no policy yet'); return { accepted: true }; });
      (server as any).readyConn = null;
      edit()('chan1', 'm9', 'first', false, info);
      await until(() => sent.length === 1);
      await new Promise((r) => setTimeout(r, 10));
      edit()('chan1', 'm9', 'second', false, info); // same connection: goes at once
      await until(() => sent.length === 2);
      (server as any).markReady((server as any).conn);
      await until(() => errors.some((e) => e.includes('not sent again: a later edit or delete')));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sent.length, 2, 'the first edit is not sent after the second');
    });

    it("an edit's record lasts while it is unanswered: edits of 600 other messages can't make it look like the latest again", async () => {
      let answerFirst!: (v: unknown) => void;
      const firstAnswer = new Promise((r) => { answerFirst = r; });
      const { server, sent, edit } = wire((_m, _p, n) => n === 1 ? firstAnswer : { accepted: true });
      edit()('chan1', 'm9', 'first', false, info);
      await until(() => sent.length === 1);
      for (let i = 0; i < 600; i++) edit()('chan1', `other${i}`, 'x', false, info);
      await until(() => sent.length === 601);
      edit()('chan1', 'm9', 'second', false, info);
      await until(() => sent.length === 602);
      answerFirst({ accepted: false, reason: 'storage busy' });
      await until(() => errors.some((e) => e.includes('not sent again')));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sent.length, 602, 'the first edit is not sent again after the second');
      assert.equal((server as any).mutationsInFlight.size, 0, 'every edit has settled, and no record is left');
    });

    it('an edit queued behind a create goes to a host connected since only once its start-up has settled', async () => {
      let answerCreate!: (v: unknown) => void;
      const createAnswer = new Promise((r) => { answerCreate = r; });
      const { server, sent, edit } = wire((m) => m === 'channels/incoming' ? createAnswer : { accepted: true }, { open: true });
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => sent.length === 1);
      edit()('chan1', 'm1', 'look at this one', false, info); // waits for the create
      // The host goes, and another connects: not ready yet.
      const next: Array<{ method: string; params: any }> = [];
      const conn2 = {
        sendRequest: (m: string, p: unknown) => { next.push({ method: m, params: p }); return Promise.resolve({ accepted: true }); },
        sendNotification: () => {},
      };
      (server as any).conn = conn2;
      (server as any).readyConn = null;
      answerCreate({ results: [{ messageId: 'm1', accepted: true }] });
      await delivered;
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(next, [], 'not to a connection whose start-up has not settled');
      assert.equal(sent.length, 1);
    });

    it('…and to the host connected since when it is ready', async () => {
      let answerCreate!: (v: unknown) => void;
      const createAnswer = new Promise((r) => { answerCreate = r; });
      const { server, sent, edit } = wire((m) => m === 'channels/incoming' ? createAnswer : { accepted: true }, { open: true });
      const delivered = deliver(server, SMALL_IMAGE);
      await until(() => sent.length === 1);
      edit()('chan1', 'm1', 'look at this one', false, info);
      const next: Array<{ method: string; params: any }> = [];
      const conn2 = {
        sendRequest: (m: string, p: unknown) => { next.push({ method: m, params: p }); return Promise.resolve({ accepted: true }); },
        sendNotification: () => {},
      };
      (server as any).conn = conn2;
      (server as any).markReady(conn2);
      answerCreate({ results: [{ messageId: 'm1', accepted: true }] });
      await delivered;
      await until(() => next.length === 1);
      assert.equal(next[0].method, 'push/event');
      assert.match(JSON.stringify(next[0].params.payload), /look at this one/);
    });
  });

  it('answerClass reads only what the spec defines', () => {
    assert.equal(answerClass({ kind: 'accepted' }), 'done');
    assert.equal(answerClass({ kind: 'no-result' }), 'done');
    assert.equal(answerClass({ kind: 'failed' }), 'uncertain');
    assert.equal(answerClass({ kind: 'rejected', reason: 'coalesce_invalid' }), 'final');
    assert.equal(answerClass({ kind: 'rejected', reason: 'anything', code: -32602 }), 'final');
    for (const code of [-32001, -32002, -32003, -32017, -32600, -32601, -32700]) {
      assert.equal(answerClass({ kind: 'rejected', reason: 'x', code }), 'final', String(code));
    }
    assert.equal(answerClass({ kind: 'rejected', reason: 'x', code: -32023 }), 'unknown-channel');
    // Words decide nothing: the same sentence is `refused` as a reason.
    assert.equal(answerClass({ kind: 'rejected', reason: 'host could not persist the acceptance; retry' }), 'refused');
    assert.equal(answerClass({ kind: 'rejected', reason: 'unspecified' }), 'refused');
    assert.equal(answerClass({ kind: 'rejected', reason: 'x', code: 4001 }), 'refused');
    assert.equal(advertisedRetryWindowMs({ pushEvents: true, retryWindowMs: 3_600_000 }), 3_600_000);
    assert.equal(advertisedRetryWindowMs(true), undefined);
    assert.equal(advertisedRetryWindowMs({ retryWindowMs: -1 }), undefined);
  });
});

/**
 * A message the host didn't take, after every resend, is owed: the watermark
 * has moved past it, so nothing else would bring it. It's delivered, as
 * Discord has it then, in a `<missed reason="undelivered">` block when a
 * connection becomes ready, or when the host takes a message in its channel
 * again. A refusal the spec gives a meaning isn't owed.
 */
describe('owed messages', () => {
  let dir: string;
  let file: string;
  let savedEnv: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owed-'));
    file = join(dir, 'watermarks.json');
    savedEnv = process.env.DISCORD_WATERMARK_FILE;
    process.env.DISCORD_WATERMARK_FILE = file;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.DISCORD_WATERMARK_FILE;
    else process.env.DISCORD_WATERMARK_FILE = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  const saved = (): any => JSON.parse(readFileSync(file, 'utf8'));
  const history = (id: string, text: string, over: Record<string, unknown> = {}) => ({
    id, authorId: 'u1', authorName: 'someone', isBot: false, content: text, cleanContent: text,
    attachments: [], mentionsBot: false, timestamp: new Date('2026-10-22T10:00:00Z'), reactions: [], ...over,
  });
  /** Discord as the stubs read it: these messages exist in chan1. A read
   *  around an id gives the message and, for numeric ids, those within half
   *  the limit of it on either side, as Discord's `around` does. */
  const onDiscord = (server: DiscordMcplServer, messages: Array<ReturnType<typeof history>>) => {
    const d = (server as any).discord;
    const reads: string[] = [];
    d.fetchAround = async (_channel: string, id: string, limit = 50) => {
      reads.push(id);
      if (!/^\d+$/.test(id)) return messages.filter((m) => m.id === id);
      const sorted = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const at = sorted.findIndex((m) => BigInt(m.id) >= BigInt(id));
      const from = Math.max(0, (at === -1 ? sorted.length : at) - Math.floor(limit / 2));
      return sorted.slice(from, from + limit);
    };
    d.getCachedChannelMeta = () => ({ name: 'general', guildId: 'g1', guildName: 'Guild', isDM: false });
    d.getChannelMeta = async () => null;
    d.isStale = () => false;
    d.lookUpStaleParent = async () => {};
    d.historyIngressReason = () => null;
    d.ingressFactsNotCurrent = () => null;
    return reads;
  };
  /** A host connected since, answering as `respond`; the server is moved to
   *  it, ready. */
  const reconnect = (server: DiscordMcplServer, sent: Array<{ method: string; params: any }>, respond: () => unknown) => {
    const conn = {
      sendRequest: (method: string, params: unknown) => {
        sent.push({ method, params });
        try { return Promise.resolve(respond()); } catch (err) { return Promise.reject(err); }
      },
      sendNotification: () => {},
    };
    (server as any).conn = conn;
    (server as any).readyConn = conn;
    return conn;
  };
  const owedPushes = (sent: Array<{ method: string; params: any }>) =>
    sent.filter((r) => r.method === 'push/event' && String(r.params.eventId).startsWith('discord_owed_'));
  const blockOf = (req: { params: any }): string => req.params.payload.content.map((b: any) => b.text ?? '').join('\n');

  it('a create with no verdict after every resend is owed, as one that may have arrived, and saved with the watermarks', async () => {
    const host = scriptedHost(() => ({ error: { code: -32603, message: 'Internal error' } }));
    const { server } = wire(() => undefined, { host });
    (server as any).retryDelaysMs = [2];
    await deliver(server, SMALL_IMAGE);
    assert.deepEqual(saved().owed, { chan1: [{ id: 'm1', uncertain: true }] });
    assert.ok(errors.includes('[discord-mcpl] Message m1 in channel chan1 is owed: it is delivered when the host takes messages there again.'), errors.join('\n'));
  });

  it('a create refused for a reason the spec gives no meaning, after its resend, is owed', async () => {
    const { server } = wire(() => ({ results: [{ messageId: 'm1', accepted: false, reason: 'host is stopping' }] }), { open: true });
    await deliver(server, SMALL_IMAGE);
    assert.deepEqual(saved().owed, { chan1: [{ id: 'm1' }] });
  });

  for (const [what, respond] of [
    ['a feature-set refusal (-32001)', () => { throw rpcError(-32001, 'Feature set not enabled'); }],
    ['coalesce_invalid without inline media', () => ({ accepted: false, reason: 'coalesce_invalid' })],
    ['an accepted create', () => ({ accepted: true })],
  ] as const) {
    it(`${what} isn't owed`, async () => {
      const { server } = wire(respond as Responder);
      await deliver(server, null);
      let owed: unknown;
      try { owed = saved().owed; } catch { owed = undefined; }
      assert.equal(owed, undefined);
      assert.equal((server as any).owed.size, 0);
    });
  }

  it('an edit not taken owes its message, marked as an edit', async () => {
    const { server, edit } = wire(() => { throw rpcError(-32603, 'Internal error'); });
    (server as any).retryDelaysMs = [2];
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => (server as any).owed.size > 0);
    assert.deepEqual((server as any).owed.get('chan1'), [{ id: 'm9', uncertain: true, edit: true }]);
  });

  it('owed messages are delivered as Discord has them, in one undelivered block, then forgotten', async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m1', 'first'), history('m2', 'second, edited since', { mentionsBot: true })]);
    (server as any).owe('chan1', 'm1', { uncertain: false });
    (server as any).owe('chan1', 'm2', { uncertain: true, edit: true });
    await (server as any).deliverOwed((server as any).conn);
    const pushes = owedPushes(sent);
    assert.equal(pushes.length, 1);
    assert.match(pushes[0].params.eventId, /^discord_owed_chan1_[0-9a-f]{16}$/);
    assert.equal(pushes[0].params.origin.mcplChannelId, 'discord:g1:chan1');
    assert.equal(pushes[0].params.origin.isMention, true);
    const block = blockOf(pushes[0]);
    assert.match(block, /^<missed channel="#general" channelId="chan1" guild="Guild" count="2" reason="undelivered">/m);
    assert.match(block, /\[The host didn't take these messages when they were sent; this is how Discord has them now\.\]/);
    assert.match(block, /id=m1\] someone: first$/m);
    assert.match(block, /id=m2\] someone \(mention\) \(edited\) \(may have arrived already\): second, edited since$/m);
    assert.equal((server as any).owed.size, 0);
    assert.equal(saved().owed, undefined, 'the file holds nothing owed once delivered');
    assert.ok(errors.includes('[discord-mcpl] Delivered 2 owed message(s) in channel chan1.'), errors.join('\n'));
  });

  it("a message Discord no longer has is forgotten, and nothing is pushed for it", async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, []);
    (server as any).owe('chan1', 'm1', { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    assert.equal(owedPushes(sent).length, 0);
    assert.equal((server as any).owed.size, 0);
  });

  it(`a block the host doesn't take is tried again, one counted try per connection, ${3} in all, then given up`, async () => {
    const { server, sent } = wire(() => ({ accepted: false, reason: 'busy' }));
    onDiscord(server, [history('m1', 'first')]);
    (server as any).owe('chan1', 'm1', { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    // The same connection again: tried, but not counted again.
    await (server as any).deliverOwed((server as any).conn);
    assert.equal(owedPushes(sent).length, 2);
    assert.equal((server as any).owed.get('chan1')[0].tries, 1);
    for (let i = 2; i <= 3; i++) {
      const conn = reconnect(server, sent, () => ({ accepted: false, reason: 'busy' }));
      await (server as any).deliverOwed(conn);
    }
    assert.equal((server as any).owed.size, 0);
    assert.ok(errors.some((e) => e.startsWith("[discord-mcpl] Couldn't deliver 1 owed message(s) in channel chan1: host rejected it: busy; tried again later.")), errors.join('\n'));
    assert.ok(errors.some((e) => e.endsWith('; given up.')), errors.join('\n'));
  });

  it('a block refused with a code the spec defines is given up at once', async () => {
    const { server, sent } = wire(() => { throw rpcError(-32017, 'Channel not permitted'); });
    onDiscord(server, [history('m1', 'first')]);
    (server as any).owe('chan1', 'm1', { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    assert.equal(owedPushes(sent).length, 1);
    assert.equal((server as any).owed.size, 0);
  });

  it('when the host takes a message in the channel again, what it owes there follows', async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m0', 'earlier')]);
    (server as any).owe('chan1', 'm0', { uncertain: false });
    await deliver(server, null);
    await until(() => owedPushes(sent).length === 1);
    assert.match(blockOf(owedPushes(sent)[0]), /id=m0\] someone: earlier/);
    assert.equal((server as any).owed.size, 0);
  });

  it('what is owed survives a restart: a new server loads it and delivers it when its connection is ready', async () => {
    writeFileSync(file, JSON.stringify({ watermarks: { chan1: 'm5' }, dmChannels: [], missed: {}, owed: { chan1: [{ id: 'm1', uncertain: true }] } }));
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m1', 'first')]);
    await (server as any).deliverOwed((server as any).conn);
    assert.equal(owedPushes(sent).length, 1);
    assert.match(blockOf(owedPushes(sent)[0]), /\(may have arrived already\): first/);
    assert.equal(saved().watermarks.chan1, 'm5', 'the watermark is left as it was');
  });

  it("a message the filters would refuse today isn't delivered, and is forgotten", async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m1', 'first'), history('m2', 'second', { authorId: 'u2' })]);
    (server as any).discord.historyIngressReason = (_c: string, _g: string | null, author: string) => author === 'u2' ? 'user-not-allowed' : null;
    (server as any).owe('chan1', 'm1', { uncertain: false });
    (server as any).owe('chan1', 'm2', { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    const block = blockOf(owedPushes(sent)[0]);
    assert.match(block, /count="1"/);
    assert.match(block, /id=m1\]/);
    assert.equal(block.includes('id=m2'), false);
    assert.equal((server as any).owed.size, 0);
  });

  it('a muted channel gives up what it owes', async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m1', 'first')]);
    (server as any).owe('chan1', 'm1', { uncertain: false });
    (server as any).isChannelMuted = (id: string) => id === 'chan1';
    await (server as any).deliverOwed((server as any).conn);
    assert.equal(owedPushes(sent).length, 0);
    assert.equal((server as any).owed.size, 0);
  });

  it('owing again: only a certain answer about the create clears "may have arrived"', () => {
    const { server } = wire(() => ({ accepted: true }));
    (server as any).owe('chan1', 'm1', { uncertain: true });
    (server as any).owe('chan1', 'm1', { uncertain: false, edit: true });
    assert.deepEqual((server as any).owed.get('chan1'), [{ id: 'm1', uncertain: true }], 'a refused edit says nothing about the create');
    (server as any).owe('chan1', 'm1', { uncertain: false });
    assert.deepEqual((server as any).owed.get('chan1'), [{ id: 'm1' }]);
  });

  it('an edit refused for a reason the spec gives no meaning owes its message; a delete is never owed', async () => {
    const { server, edit, del } = wire(() => ({ accepted: false, reason: 'busy' }));
    edit()('chan1', 'm9', 'fixed', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => (server as any).owed.size > 0);
    assert.deepEqual((server as any).owed.get('chan1'), [{ id: 'm9', edit: true }]);
    del()('chan1', 'm8', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => errors.some((e) => e.includes('delete of message m8') && e.startsWith('[discord-mcpl] host rejected')));
    assert.equal((server as any).owed.get('chan1').some((o: { id: string }) => o.id === 'm8'), false);
  });

  it('the resend without inline media, refused or unanswered, owes the message', async () => {
    const refused = wire((_m, _p, n) => n === 1
      ? { results: [{ messageId: 'm1', accepted: false, reason: 'coalesce_invalid' }] }
      : { results: [{ messageId: 'm1', accepted: false, reason: 'busy' }] }, { open: true });
    await deliver(refused.server, BIG_IMAGE);
    assert.deepEqual((refused.server as any).owed.get('chan1'), [{ id: 'm1' }]);
    rmSync(file, { force: true }); // a server of its own, with a file of its own
    const host = scriptedHost((_m, _p, n) => n === 1 ? { error: { code: -32602, message: 'too big' } } : 'no answer');
    const silent = wire(() => undefined, { host });
    (silent.server as any).retryDelaysMs = [2];
    await deliver(silent.server, BIG_IMAGE);
    assert.deepEqual((silent.server as any).owed.get('chan1'), [{ id: 'm1', uncertain: true }]);
  });

  it('a later edit or delete the host takes leaves nothing owed for the message', async () => {
    const { server, edit } = wire(() => ({ accepted: true }));
    (server as any).owe('chan1', 'm9', { uncertain: false, edit: true });
    edit()('chan1', 'm9', 'fixed again', false, { guildId: 'g1', authorId: 'u1', authorName: 'someone' });
    await until(() => (server as any).owed.size === 0);
  });

  it("one read serves every owed message inside its window, and one inside it that Discord doesn't return is gone", async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    const reads = onDiscord(server, [history('1001', 'a'), history('1002', 'b'), history('1004', 'd')]);
    for (const id of ['1001', '1003', '1004']) (server as any).owe('chan1', id, { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    assert.deepEqual(reads, ['1001'], 'one read for the three');
    const block = blockOf(owedPushes(sent)[0]);
    assert.match(block, /count="2"/);
    assert.equal(block.includes('id=1003'), false, 'deleted since');
    assert.equal((server as any).owed.size, 0);
  });

  it("a channel Discord doesn't know gives up what it owes; another failed read counts a try and keeps them", async () => {
    const gone = wire(() => ({ accepted: true }));
    onDiscord(gone.server, []);
    (gone.server as any).discord.fetchAround = async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); };
    (gone.server as any).owe('chan1', 'm1', { uncertain: false });
    await (gone.server as any).deliverOwed((gone.server as any).conn);
    assert.equal((gone.server as any).owed.size, 0);
    const flaky = wire(() => ({ accepted: true }));
    onDiscord(flaky.server, []);
    (flaky.server as any).discord.fetchAround = async () => { throw new Error('socket hang up'); };
    (flaky.server as any).owe('chan1', 'm1', { uncertain: false });
    await (flaky.server as any).deliverOwed((flaky.server as any).conn);
    assert.deepEqual((flaky.server as any).owed.get('chan1'), [{ id: 'm1', tries: 1 }]);
    assert.ok(errors.some((e) => e.startsWith("[discord-mcpl] Couldn't deliver 1 owed message(s) in channel chan1: couldn't read them from Discord (socket hang up); tried again later.")), errors.join('\n'));
  });

  it('a channel whose identity can\'t be resolved counts a try, logged, and gives them up after the last', async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m1', 'first')]);
    (server as any).discord.getCachedChannelMeta = () => null;
    (server as any).owe('chan1', 'm1', { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    assert.ok(errors.some((e) => e.includes('neither its guild nor DM identity could be resolved; tried again later.')), errors.join('\n'));
    for (let i = 2; i <= 3; i++) await (server as any).deliverOwed(reconnect(server, sent, () => ({ accepted: true })));
    assert.equal((server as any).owed.size, 0);
    assert.equal(owedPushes(sent).length, 0);
  });

  it("a channel filter's refusal that rests on facts that aren't current holds the channel back, as the sweep does", async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m1', 'first')]);
    (server as any).discord.historyIngressReason = () => 'channel-not-allowed';
    (server as any).discord.ingressFactsNotCurrent = () => 'its parent is stale';
    (server as any).owe('chan1', 'm1', { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    assert.equal(owedPushes(sent).length, 0);
    assert.deepEqual((server as any).owed.get('chan1'), [{ id: 'm1', tries: 1 }]);
    // Current facts: the refusal stands, and the message is given up.
    (server as any).discord.ingressFactsNotCurrent = () => null;
    await (server as any).deliverOwed(reconnect(server, sent, () => ({ accepted: true })));
    assert.equal((server as any).owed.size, 0);
    assert.ok(errors.some((e) => e === '[discord-mcpl] Gave up 1 owed message(s) in channel chan1: the filters refuse them now.'), errors.join('\n'));
  });

  it('a DM is delivered as one, and every message in it addresses the agent', async () => {
    const { server, sent } = wire(() => ({ accepted: true }));
    onDiscord(server, [history('m1', 'hi')]);
    (server as any).discord.getCachedChannelMeta = () => ({ name: null, guildId: null, guildName: null, isDM: true });
    ((server as any).dmChannelIds as Set<string>).add('chan1');
    (server as any).owe('chan1', 'm1', { uncertain: false });
    await (server as any).deliverOwed((server as any).conn);
    const push = owedPushes(sent)[0];
    assert.match(blockOf(push), /<missed channelId="chan1" dm="true" count="1" reason="undelivered">/);
    assert.equal(push.params.origin.isDM, true);
    assert.equal(push.params.origin.isMention, true);
  });

  it('the same block gives the same event id; other messages, marks or text give another', async () => {
    const ids: string[] = [];
    for (const [text, uncertain] of [['first', false], ['first', false], ['first, edited', false], ['first', true]] as const) {
      const { server, sent } = wire(() => ({ accepted: true }));
      onDiscord(server, [history('m1', text)]);
      (server as any).owe('chan1', 'm1', { uncertain });
      await (server as any).deliverOwed((server as any).conn);
      ids.push(owedPushes(sent)[0].params.eventId);
    }
    assert.equal(ids[0], ids[1]);
    assert.equal(new Set(ids).size, 3);
  });

  it('after a failed try, the live trigger waits before trying again on the same connection', async () => {
    let answer: unknown = { accepted: false, reason: 'busy' };
    const { server, sent } = wire(() => answer);
    onDiscord(server, [history('m0', 'earlier')]);
    (server as any).owe('chan1', 'm0', { uncertain: false });
    await (server as any).deliverOwedIn((server as any).conn, 'chan1', 'live');
    answer = { accepted: true };
    await (server as any).deliverOwedIn((server as any).conn, 'chan1', 'live');
    await (server as any).deliverOwedIn((server as any).conn, 'chan1', 'live');
    assert.equal(owedPushes(sent).length, 1, 'no new try within the cool-down');
    await (server as any).deliverOwedIn((server as any).conn, 'chan1', 'ready');
    assert.equal(owedPushes(sent).length, 2, 'a connection becoming ready tries regardless');
    assert.equal((server as any).owed.size, 0);
  });

  it('a deleted channel forgets what it owes', () => {
    const { server } = wire(() => ({ accepted: true }));
    (server as any).owe('chan1', 'm1', { uncertain: false });
    (server as any).channelDeleted('g1', 'chan1');
    assert.equal((server as any).owed.size, 0);
    assert.equal(saved().owed, undefined);
  });

  it(`at most ${50} messages are owed per channel; the oldest go first`, () => {
    const { server } = wire(() => ({ accepted: true }));
    for (let i = 0; i < 52; i++) (server as any).owe('chan1', `m${i}`, { uncertain: false });
    const ids = (server as any).owed.get('chan1').map((o: { id: string }) => o.id);
    assert.equal(ids.length, 50);
    assert.equal(ids[0], 'm2');
  });
});
