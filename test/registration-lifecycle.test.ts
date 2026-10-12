/**
 * The registry follows a channel's life as discord.js tells it, including
 * the removals it makes without an event for each channel: a deleted channel
 * takes its threads with it, and a guild the bot leaves takes all of its
 * channels. A delivery that set out before such a removal neither names nor
 * registers what was removed, and a deleted channel's watermark stays
 * dropped. A guild left and joined again is registered again, since its
 * channels still exist, and an outage removes nothing. A forum or media
 * channel's rename reaches its posts' labels.
 *
 * Found in review by Daphne, whose probe these tests are built from. They
 * drive discord.js's own actions and gateway handlers.
 */
import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ChannelType, MessageType } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const discordJs = dirname(require.resolve('discord.js'));
const channelUpdate = require(resolve(discordJs, 'client/websocket/handlers/CHANNEL_UPDATE.js'));
const guildCreate = require(resolve(discordJs, 'client/websocket/handlers/GUILD_CREATE.js'));
const Status = require(resolve(discordJs, 'util/Status.js'));

const G = '100000000000000001';
const P = '100000000000000002';
const TH = '100000000000000003';
const BOT = '100000000000000004';
const U = '100000000000000005';
const M = '100000000000000006';
const threadMcplId = `discord:${G}:${TH}`;
const parentMcplId = `discord:${G}:${P}`;
const bot = { id: BOT, username: 'bot', discriminator: '0', avatar: null };
const parentData = (type: ChannelType) => ({ id: P, guild_id: G, type, name: 'before', parent_id: null });
const threadData = {
  id: TH, guild_id: G, type: ChannelType.PublicThread, name: 'topic', parent_id: P, owner_id: U,
  thread_metadata: { archived: false, auto_archive_duration: 60, archive_timestamp: new Date().toISOString(), locked: false },
};
const attachment = { url: 'https://example.invalid/a.txt', name: 'a.txt', contentType: 'text/plain', size: 1 };

function fixture(t: TestContext, type = ChannelType.GuildText) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = adapter.rawClient as any;
  t.after(() => client.destroy());
  client.user = client.users._add({ ...bot, bot: true });
  const guild = client.guilds._add({ id: G, name: 'Guild', owner_id: BOT, channels: [parentData(type)] });
  guild.members._add({ user: bot, roles: [] });
  const thread = client.channels._add(threadData);
  const server = new DiscordMcplServer(adapter) as any;
  const sent: Array<{ method: string; params: any }> = [];
  server.conn = {
    isClosed: false,
    sendNotification(method: string, params: any) { sent.push({ method, params }); },
    sendRequest(method: string, params: any) { sent.push({ method, params }); return Promise.resolve({}); },
  };
  server.mcplEnabled = true;
  server.enabledFeatureSets.add('discord.messaging');
  server.subscriptionsLoaded = server.mutedLoaded = server.watermarkLoaded = true;
  server.saveWatermark = () => {};
  server.setupDiscordForwarding();
  return {
    adapter, client, server, sent, thread,
    /** A message posted in the thread, mentioning the bot. */
    posted: (over: Record<string, unknown> = {}) => ({
      id: M, content: 'hi', cleanContent: 'hi', authorId: U, authorName: 'Bob', isBot: false,
      channelId: TH, channelName: 'topic', guildId: G, guildName: 'Guild',
      threadId: TH, threadName: 'topic', threadParentName: 'before',
      mentions: [BOT], attachments: [], timestamp: new Date(), ...over,
    }),
    pushes: () => sent.filter((x) => x.method === 'push/event'),
    announced: (key: 'added' | 'updated', id: string) =>
      sent.some((x) => x.method === 'channels/changed' && x.params[key]?.some((d: { id: string }) => d.id === id)),
    removed: (id: string) => sent.some((x) => x.method === 'channels/changed' && x.params.removed?.includes(id)),
    deleteThread: () => client.actions.ThreadDelete.handle({ id: TH, guild_id: G, parent_id: P, type: ChannelType.PublicThread }),
  };
}

/** A promise held until its release, released at the test's end at the latest. */
function holder(t: TestContext): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  return { held, release };
}

for (const type of [ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildMedia]) {
  it(`a ${ChannelType[type]} channel's rename re-derives the labels of its registered threads`, (t) => {
    const f = fixture(t, type);
    f.server.registerGuildDelivery(G, TH);
    assert.equal(f.server.channelManager.get(threadMcplId)?.label, '#before › topic (Guild)');
    f.sent.length = 0;
    channelUpdate(f.client, { d: { ...parentData(type), name: 'after' } });
    assert.equal(f.adapter.getCachedChannelFacts(TH)?.parentName, 'after', "discord.js's cache has the new name");
    assert.equal(f.server.channelManager.get(threadMcplId)?.label, '#after › topic (Guild)');
    assert.ok(f.announced('updated', threadMcplId));
    // A text channel is registered by its update. A forum or media channel
    // holds no messages, so it isn't.
    assert.equal(f.server.channelManager.get(parentMcplId) !== undefined, type === ChannelType.GuildText);
  });
}

it('a create whose thread is deleted while its attachments are fetched neither registers nor names it', async (t) => {
  const f = fixture(t);
  const { held, release } = holder(t);
  let fetching = false;
  f.server.buildAttachmentBlocks = async () => { fetching = true; await held; return []; };
  const delivery = f.server.handleDiscordMessage(f.posted({ attachments: [attachment] }));
  assert.equal(fetching, true);
  f.deleteThread();
  assert.equal(f.client.channels.cache.has(TH), false, 'discord.js dropped the thread');
  release();
  await delivery;
  const push = f.pushes()[0];
  assert.ok(push, 'the message is still delivered');
  assert.equal(push.params.origin.mcplChannelId, undefined, 'naming no channel');
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  assert.equal(f.announced('added', threadMcplId), false, 'and the host never heard of the thread');
});

it('a create in an open thread deleted while its attachments are fetched goes out as a push naming nothing', async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  assert.ok(f.server.channelManager.open(threadMcplId));
  const { held, release } = holder(t);
  f.server.buildAttachmentBlocks = async () => { await held; return []; };
  const delivery = f.server.handleDiscordMessage(f.posted({ attachments: [attachment] }));
  f.deleteThread();
  release();
  await delivery;
  assert.equal(f.sent.some((x) => x.method === 'channels/incoming'), false, 'not into a channel the host was told is gone');
  const push = f.pushes()[0];
  assert.ok(push, 'the message is still delivered');
  assert.equal(push.params.origin.mcplChannelId, undefined);
});

it("a deletion delivered after its thread's channel was deleted doesn't register the thread", async (t) => {
  const f = fixture(t);
  f.server.subscribedChannels.add(TH);
  const message = f.thread.messages._add({
    id: M, guild_id: G, channel_id: TH, type: MessageType.Default, content: 'hello', timestamp: new Date().toISOString(),
    author: { id: U, username: 'Bob', discriminator: '0', avatar: null }, mentions: [], mention_roles: [], attachments: [], embeds: [], flags: 0,
  });
  f.client.actions.MessageDelete.handle({ id: message.id, channel_id: TH, guild_id: G });
  const pending = [...(f.adapter as any).messageEventDeliveries.values()];
  assert.ok(pending.length, 'the deletion is on its way');
  f.client.actions.ChannelDelete.handle({ id: P, guild_id: G, type: ChannelType.GuildText });
  assert.equal(f.client.channels.cache.has(TH), false, "discord.js dropped the channel's thread with it");
  await Promise.allSettled(pending);
  const push = f.pushes()[0];
  assert.ok(push, 'the deletion is delivered');
  assert.equal(push.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it('a create delivered after its thread was deleted leaves the watermark the deletion dropped', async (t) => {
  const f = fixture(t);
  f.server.forwardedWatermark.set(TH, '100');
  f.deleteThread();
  assert.equal(f.server.forwardedWatermark.has(TH), false, 'the deletion dropped it');
  await f.server.handleDiscordMessage(f.posted());
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.forwardedWatermark.has(TH), false);
});

it('a catch-up whose thread is deleted while it is delivered leaves the watermark the deletion dropped', async (t) => {
  const f = fixture(t);
  const before = process.env.DISCORD_WATERMARK_FILE;
  // The sweep runs only with a watermark file; saving is stubbed, so nothing is written.
  process.env.DISCORD_WATERMARK_FILE = join(tmpdir(), `registration-lifecycle-${process.pid}.json`);
  t.after(() => {
    if (before === undefined) delete process.env.DISCORD_WATERMARK_FILE;
    else process.env.DISCORD_WATERMARK_FILE = before;
  });
  f.server.subscribedChannels.add(TH);
  f.server.forwardedWatermark.set(TH, '100');
  f.adapter.fetchHistory = async () => [{
    id: '200', content: 'later', cleanContent: 'later', authorId: U, authorName: 'Bob',
    timestamp: new Date(), mentionsBot: false, attachments: [],
  }] as any;
  const { held, release } = holder(t);
  let delivering!: () => void;
  const delivered = new Promise<void>((done) => { delivering = done; });
  const send = f.server.conn.sendRequest;
  f.server.conn.sendRequest = (method: string, params: unknown) => {
    if (method !== 'push/event') return send(method, params);
    delivering();
    return held.then(() => send(method, params));
  };
  const sweep = f.server.runReconnectSweep();
  await delivered;
  f.deleteThread();
  assert.equal(f.server.forwardedWatermark.has(TH), false, 'the deletion dropped it');
  release();
  await sweep;
  assert.equal(f.server.forwardedWatermark.has(TH), false);
});

it("a channel whose category is deleted is still registered by its messages, and keeps its watermark", async (t) => {
  const f = fixture(t);
  const C = '100000000000000007';
  const X = '100000000000000008';
  f.client.channels._add({ id: C, guild_id: G, type: ChannelType.GuildCategory, name: 'cat', parent_id: null });
  f.client.channels._add({ id: X, guild_id: G, type: ChannelType.GuildText, name: 'child', parent_id: C });
  // discord.js leaves a deleted category's channels filed under it until an
  // update for each moves them out.
  f.client.actions.ChannelDelete.handle({ id: C, guild_id: G, type: ChannelType.GuildCategory });
  assert.equal(f.adapter.getCachedChannelFacts(X)?.parentId, C, 'the cache still files the channel under it');
  await f.server.handleDiscordMessage(f.posted({
    channelId: X, channelName: 'child', threadId: undefined, threadName: undefined, threadParentName: undefined,
  }));
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, `discord:${G}:${X}`);
  assert.equal(f.server.forwardedWatermark.get(X), M);
});

it('a guild the bot leaves takes its registered channels and threads with it, keeping their watermarks', (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, P);
  f.server.registerGuildDelivery(G, TH);
  f.server.forwardedWatermark.set(TH, '100');
  f.sent.length = 0;
  f.client.actions.GuildDelete.handle({ id: G });
  assert.equal(f.client.guilds.cache.has(G), false);
  assert.equal(f.server.channelManager.get(parentMcplId), undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  assert.ok(f.removed(parentMcplId) && f.removed(threadMcplId), 'and the host is told');
  assert.equal(f.server.forwardedWatermark.get(TH), '100', 'the channels still exist');
});

it('a guild unavailable in an outage keeps its registered channels', async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  f.sent.length = 0;
  f.client.actions.GuildDelete.handle({ id: G, unavailable: true });
  assert.equal(f.client.guilds.cache.get(G)?.available, false, 'discord.js keeps it, unavailable');
  assert.ok(f.server.channelManager.get(threadMcplId));
  assert.equal(f.removed(threadMcplId), false);
  await f.server.handleDiscordMessage(f.posted());
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
});

it('a create on its way when the bot leaves the guild neither registers nor names its thread', async (t) => {
  const f = fixture(t);
  const { held, release } = holder(t);
  f.server.buildAttachmentBlocks = async () => { await held; return []; };
  const delivery = f.server.handleDiscordMessage(f.posted({ attachments: [attachment] }));
  f.client.actions.GuildDelete.handle({ id: G });
  release();
  await delivery;
  const push = f.pushes()[0];
  assert.ok(push, 'the message is still delivered');
  assert.equal(push.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it('a guild left and joined again, with the same channels and threads, is registered again', async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  f.client.actions.GuildDelete.handle({ id: G });
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  // GUILD_CREATE reports a guild joined only once the client is ready.
  f.client.ws.status = Status.Ready;
  guildCreate(f.client, {
    d: {
      id: G, name: 'Guild', owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
      channels: [parentData(ChannelType.GuildText)], threads: [threadData],
    },
  }, { id: 0 });
  assert.ok(f.client.guilds.cache.has(G));
  assert.ok(f.server.channelManager.get(parentMcplId), "the guild's channel is registered again");
  await f.server.handleDiscordMessage(f.posted());
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId, 'and its thread, by its next message');
  assert.ok(f.server.channelManager.get(threadMcplId));
});
