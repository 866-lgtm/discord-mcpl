/**
 * The registry follows a channel's life as discord.js tells it, including
 * the removals it makes without an event for each channel: a deleted channel
 * takes its threads with it, a guild the bot leaves takes all of its
 * channels, a channel Discord answers with Unknown Channel is deleted, and a
 * guild back from an outage is reconciled with what it has now, what it no
 * longer lists held as stale until Discord reports it again. A delivery
 * that set out before such a removal, or before an
 * archive, neither names nor registers what was removed or archived, and a
 * deleted channel's watermark stays dropped; a message posted after an
 * archive registers the thread it unarchived. A guild left and joined again
 * is registered again, as at boot, since its channels still exist, and an
 * outage removes nothing while it lasts. A forum or media channel's rename
 * reaches its posts' labels, and a hidden channel's rename its own. A
 * `#name (Guild)` label is kept only while it resolves back to its channel,
 * and a batch of labels reads one view of the channels names resolve among.
 *
 * The cases drive discord.js's own actions and gateway handlers.
 */
import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ChannelType, MessageType, PermissionFlagsBits } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const discordJs = dirname(require.resolve('discord.js'));
const channelUpdate = require(resolve(discordJs, 'client/websocket/handlers/CHANNEL_UPDATE.js'));
const guildCreate = require(resolve(discordJs, 'client/websocket/handlers/GUILD_CREATE.js'));
const threadUpdate = require(resolve(discordJs, 'client/websocket/handlers/THREAD_UPDATE.js'));
const Status = require(resolve(discordJs, 'util/Status.js'));

const G = '100000000000000001';
const P = '100000000000000002';
const TH = '100000000000000003';
const BOT = '100000000000000004';
const U = '100000000000000005';
const M = '100000000000000006';
const threadMcplId = `discord:${G}:${TH}`;
const parentMcplId = `discord:${G}:${P}`;
const idOf = (channelId: string) => `discord:${G}:${channelId}`;
const bot = { id: BOT, username: 'bot', discriminator: '0', avatar: null };
const parentData = (type: ChannelType) => ({ id: P, guild_id: G, type, name: 'before', parent_id: null });
const channelData = (id: string, type: ChannelType, name: string) => ({ id, guild_id: G, type, name, parent_id: null });
const threadData = {
  id: TH, guild_id: G, type: ChannelType.PublicThread, name: 'topic', parent_id: P, owner_id: U,
  thread_metadata: { archived: false, auto_archive_duration: 60, archive_timestamp: new Date().toISOString(), locked: false },
};
const attachment = { url: 'https://example.invalid/a.txt', name: 'a.txt', contentType: 'text/plain', size: 1 };
/** A time to set Discord's clocks by, with others a second either side. */
const T = Date.UTC(2026, 9, 12, 8, 0, 0);
/** The thread as Discord sends it, archived or not, its archive status last
 *  changed at `at`. */
const threadAt = (archived: boolean, at: number) => ({
  ...threadData,
  thread_metadata: { archived, auto_archive_duration: 60, archive_timestamp: new Date(at).toISOString(), locked: false },
});
/** The id of a message created at `at`: a snowflake carries its time. */
const snowflakeAt = (at: number) => ((BigInt(at) - 1420070400000n) << 22n).toString();

function fixture(t: TestContext, opts: {
  /** The type of the thread's channel, P. */
  type?: ChannelType;
  /** More channels in the guild. */
  channels?: Array<Record<string, unknown>>;
  /** The guild's owner (the bot, which can view everything, unless given). */
  owner?: string;
  roles?: Array<Record<string, unknown>>;
  /** The thread as a message event leaves it, with its type only. */
  sparse?: boolean;
} = {}) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = adapter.rawClient as any;
  t.after(() => client.destroy());
  client.user = client.users._add({ ...bot, bot: true });
  const guild = client.guilds._add({
    id: G, name: 'Guild', owner_id: opts.owner ?? BOT, roles: opts.roles ?? [],
    channels: [parentData(opts.type ?? ChannelType.GuildText), ...(opts.channels ?? [])],
  });
  guild.members._add({ user: bot, roles: [] });
  const thread = client.channels._add(opts.sparse ? { id: TH, guild_id: G, type: ChannelType.PublicThread } : threadData);
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
    label: (channelId: string): string | undefined => server.channelManager.get(idOf(channelId))?.label,
    pushes: () => sent.filter((x) => x.method === 'push/event'),
    announced: (key: 'added' | 'updated', id: string) =>
      sent.some((x) => x.method === 'channels/changed' && x.params[key]?.some((d: { id: string }) => d.id === id)),
    removed: (id: string) => sent.some((x) => x.method === 'channels/changed' && x.params.removed?.includes(id)),
    deleteThread: () => client.actions.ThreadDelete.handle({ id: TH, guild_id: G, parent_id: P, type: ChannelType.PublicThread }),
    /** A message posted in the thread at `at`, mentioning the bot, as the
     *  gateway delivers it. */
    gatewayCreate: (at: number) => client.actions.MessageCreate.handle({
      id: snowflakeAt(at), guild_id: G, channel_id: TH, channel_type: ChannelType.PublicThread, type: MessageType.Default,
      content: `<@${BOT}> hi`, timestamp: new Date(at).toISOString(),
      author: { id: U, username: 'Bob', discriminator: '0', avatar: null }, mentions: [bot], mention_roles: [], attachments: [], embeds: [], flags: 0,
    }),
    /** An edit of a message in the thread, as the adapter reports one. */
    edit: (messageId: string) => server.forwardMessageEdit(TH, messageId, 'edited', false, {
      guildId: G, authorName: 'Bob', threadId: TH, threadName: 'topic', threadParentName: 'before',
    }),
    /** The guild goes unavailable and comes back with its channel P and
     *  these threads. */
    comesBack: (threads: unknown[] = []) => {
      client.actions.GuildDelete.handle({ id: G, unavailable: true });
      guildCreate(client, {
        d: {
          id: G, name: 'Guild', unavailable: false, owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
          channels: [parentData(ChannelType.GuildText)], threads,
        },
      }, { id: 0 });
    },
  };
}

/** A promise held until its release, released at the test's end at the latest. */
function holder(t: TestContext): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  return { held, release };
}

/** The sweep runs, and the watermark file is read, only with a file named. */
function watermarkFile(t: TestContext, contents?: unknown): string {
  const path = join(tmpdir(), `registration-lifecycle-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  if (contents !== undefined) writeFileSync(path, JSON.stringify(contents));
  const before = process.env.DISCORD_WATERMARK_FILE;
  process.env.DISCORD_WATERMARK_FILE = path;
  t.after(() => {
    if (before === undefined) delete process.env.DISCORD_WATERMARK_FILE;
    else process.env.DISCORD_WATERMARK_FILE = before;
    if (existsSync(path)) unlinkSync(path);
  });
  return path;
}

/** Wait, a turn at a time, for what a test can't await directly. */
async function until(what: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !what(); i++) await new Promise((done) => setImmediate(done));
}

const unknownChannel = () => Object.assign(new Error('Unknown Channel'), { code: 10003 });

for (const type of [ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildMedia]) {
  it(`a ${ChannelType[type]} channel's rename re-derives the labels of its registered threads`, (t) => {
    const f = fixture(t, { type });
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

it("a hidden channel's rename re-derives its label, since listing registers it all the same", (t) => {
  const f = fixture(t, {
    owner: U,
    roles: [{ id: G, name: '@everyone', permissions: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages), position: 0 }],
  });
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), '#before (Guild)');
  channelUpdate(f.client, {
    d: { ...parentData(ChannelType.GuildText), name: 'after', permission_overwrites: [{ id: G, type: 0, allow: '0', deny: String(PermissionFlagsBits.ViewChannel) }] },
  });
  assert.equal(f.client.channels.cache.get(P).permissionsFor(BOT)?.has(PermissionFlagsBits.ViewChannel), false, 'the bot can no longer view it');
  assert.equal(f.label(P), '#after (Guild)');
});

it('a voice channel whose name a same-named text channel holds is labelled by its id, until the name is free', (t) => {
  const A = '100000000000000011';
  const B = '100000000000000012';
  const f = fixture(t, { channels: [channelData(A, ChannelType.GuildText, 'general'), channelData(B, ChannelType.GuildVoice, 'General')] });
  f.server.registerGuildDelivery(G, A);
  f.server.registerGuildDelivery(G, B);
  assert.equal(f.label(A), '#general (Guild)');
  // `#General (Guild)` resolves to the text channel, which the resolver prefers.
  const resolved = f.adapter.resolveChannelRef('#General (Guild)');
  assert.ok(resolved.ok && resolved.id === A);
  assert.equal(f.label(B), idOf(B));
  f.sent.length = 0;
  f.client.actions.ChannelDelete.handle({ id: A, guild_id: G, type: ChannelType.GuildText });
  assert.equal(f.label(B), '#General (Guild)');
  assert.ok(f.announced('updated', idOf(B)));
});

it("list_channels labels each channel as a registered channel's label is made", async (t) => {
  const A = '100000000000000011';
  const B = '100000000000000012';
  const CAT = '100000000000000014';
  const raw = [
    channelData(A, ChannelType.GuildText, 'general'), channelData(B, ChannelType.GuildVoice, 'General'),
    channelData(CAT, ChannelType.GuildCategory, 'help'),
  ];
  const f = fixture(t, { channels: raw });
  t.mock.method(f.client.rest, 'get', async () => [parentData(ChannelType.GuildText), ...raw]);
  const listed = await f.adapter.listChannels(G);
  const label = (id: string) => listed.find((c) => c.id === id)?.label;
  assert.equal(label(A), '#general (Guild)');
  assert.equal(label(B), idOf(B), "the voice channel's name reaches the text channel");
  assert.equal(label(CAT), idOf(CAT), 'a category has no name route');
});

it("a channel created with a registered channel's name takes it, and two of one kind both go by id", (t) => {
  const B = '100000000000000012';
  const C = '100000000000000013';
  const f = fixture(t, { channels: [channelData(B, ChannelType.GuildVoice, 'lounge')] });
  f.server.registerGuildDelivery(G, B);
  assert.equal(f.label(B), '#lounge (Guild)');
  f.client.actions.ChannelCreate.handle(channelData(C, ChannelType.GuildVoice, 'lounge'));
  assert.equal(f.label(C), idOf(C), 'the new one is registered by its id');
  assert.equal(f.label(B), idOf(B), 'and the name no longer reaches the old one alone');
});

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
  f.server.forwardedWatermark.set(TH, '100');
  f.client.actions.ChannelDelete.handle({ id: P, guild_id: G, type: ChannelType.GuildText });
  assert.equal(f.client.channels.cache.has(TH), false, "discord.js dropped the channel's thread with it");
  assert.equal(f.server.forwardedWatermark.has(TH), false, "the thread's watermark goes with its channel");
  await Promise.allSettled(pending);
  const push = f.pushes()[0];
  assert.ok(push, 'the deletion is delivered');
  assert.equal(push.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it('a create in a thread known only partly, which Discord answers Unknown Channel when looked up, registers and names nothing', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  const { held, release } = holder(t);
  t.mock.method(f.client.rest, 'get', async () => { await held; throw unknownChannel(); });
  f.client.actions.MessageCreate.handle({
    id: M, guild_id: G, channel_id: TH, type: MessageType.Default, content: `<@${BOT}> hi`, timestamp: new Date().toISOString(),
    author: { id: U, username: 'Bob', discriminator: '0', avatar: null }, mentions: [bot], mention_roles: [], attachments: [], embeds: [], flags: 0,
  });
  const lookup = (f.adapter as any).threadLookups.get(TH);
  assert.ok(lookup, 'the create waits for the thread to be looked up');
  // Its channel is deleted meanwhile. The thread, known only partly, isn't
  // in the channel's threads.cache, so the deletion can't name it.
  f.client.actions.ChannelDelete.handle({ id: P, guild_id: G, type: ChannelType.GuildText });
  release();
  await lookup;
  await until(() => f.pushes().length > 0);
  const push = f.pushes()[0];
  assert.ok(push, 'the message is still delivered');
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

it("a channel deleted before the watermark file is read loses the watermark the file holds", (t) => {
  const f = fixture(t);
  const path = watermarkFile(t, { watermarks: { [TH]: '100' }, dmChannels: [] });
  f.server.watermarkLoaded = false;
  delete f.server.saveWatermark;
  f.deleteThread();
  assert.equal(f.server.forwardedWatermark.has(TH), false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).watermarks?.[TH], undefined, 'nor does the file');
});

it('a catch-up whose thread is deleted while it is delivered leaves the watermark the deletion dropped', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  watermarkFile(t);
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

it("a registered channel the catch-up finds Discord doesn't know is handled as deleted", async (t) => {
  const f = fixture(t);
  watermarkFile(t);
  f.server.registerGuildDelivery(G, P);
  f.server.forwardedWatermark.set(P, '100');
  f.sent.length = 0;
  f.adapter.fetchHistory = async () => { throw unknownChannel(); };
  await f.server.runReconnectSweep();
  assert.equal(f.server.channelManager.get(parentMcplId), undefined);
  assert.ok(f.removed(parentMcplId), 'and the host is told');
  assert.equal(f.server.forwardedWatermark.has(P), false);
  // Remembered as deleted: a delivery from it that set out before registers nothing.
  await f.server.handleDiscordMessage(f.posted({
    channelId: P, channelName: 'before', threadId: undefined, threadName: undefined, threadParentName: undefined,
  }));
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
});

it('a channel whose category is deleted is still registered by its messages, and keeps its watermark', async (t) => {
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
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, idOf(X));
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

it('a guild back from an outage is reconciled with what it has now', async (t) => {
  const V = '100000000000000009';
  const N = '100000000000000010';
  const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'lounge')] });
  f.server.registerGuildDelivery(G, P);
  f.server.registerGuildDelivery(G, V);
  f.server.registerGuildDelivery(G, TH);
  f.client.actions.GuildDelete.handle({ id: G, unavailable: true });
  f.sent.length = 0;
  // While it was away, its channel was renamed, its voice channel deleted
  // and its thread archived, and a channel was created. None of that was
  // heard: the guild's return carries what it has now.
  guildCreate(f.client, {
    d: {
      id: G, name: 'Guild', unavailable: false, owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
      channels: [{ ...parentData(ChannelType.GuildText), name: 'after' }, channelData(N, ChannelType.GuildText, 'new')],
      threads: [],
    },
  }, { id: 0 });
  assert.equal(f.client.guilds.cache.get(G)?.available, true);
  assert.equal(f.label(P), '#after (Guild)');
  assert.equal(f.label(N), '#new (Guild)');
  assert.equal(f.label(V), undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  assert.ok(f.removed(idOf(V)) && f.removed(threadMcplId), 'and the host is told');
  assert.ok(f.client.channels.cache.has(TH), "discord.js's client-wide cache keeps what the guild no longer lists");
  assert.ok(f.adapter.isStale(V) && f.adapter.isStale(TH), 'marked stale');
  // Nothing gone this way is remembered as deleted: the thread may only have
  // been archived, and its next message registers it again.
  f.gatewayCreate(T + 1000);
  assert.equal(f.adapter.isStale(TH), false, 'a message posted there shows it is live');
  await until(() => f.pushes().length > 0);
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
  assert.equal(f.label(TH), '#after › topic (Guild)');
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

it("a guild left and joined again registers its channels again, as at boot, and its threads by their messages", async (t) => {
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
  assert.equal(f.server.channelManager.get(threadMcplId), undefined, 'a thread waits for a message, as at boot');
  await f.server.handleDiscordMessage(f.posted());
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId, 'and its message registers it');
  assert.ok(f.server.channelManager.get(threadMcplId));
});

for (const registered of [true, false]) {
  it(`an archive that arrives while a create's attachments are fetched isn't undone by that create${registered ? '' : ', the thread\'s first'}`, async (t) => {
    const f = fixture(t);
    if (registered) f.server.registerGuildDelivery(G, TH);
    const { held, release } = holder(t);
    let fetching = false;
    f.server.buildAttachmentBlocks = async () => { fetching = true; await held; return []; };
    f.sent.length = 0;
    const delivery = f.server.handleDiscordMessage(f.posted({ attachments: [attachment], timestamp: new Date(T) }));
    assert.equal(fetching, true);
    threadUpdate(f.client, { d: threadAt(true, T + 1000) });
    assert.equal(f.adapter.getCachedChannelFacts(TH)?.archivedAt, T + 1000);
    release();
    await delivery;
    const push = f.pushes()[0];
    assert.ok(push, 'the message is still delivered');
    assert.equal(push.params.origin.mcplChannelId, undefined);
    assert.equal(f.server.channelManager.get(threadMcplId), undefined);
    assert.equal(f.announced('added', threadMcplId), false, 'the archive stands');
  });
}

it('a message posted after an archive registers the thread it unarchived, though the cache still says archived', async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  threadUpdate(f.client, { d: threadAt(true, T) });
  assert.equal(f.server.channelManager.get(threadMcplId), undefined, 'the archive forgot it');
  await f.server.handleDiscordMessage(f.posted({ timestamp: new Date(T + 1000) }));
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
  assert.ok(f.server.channelManager.get(threadMcplId));
});

it("a message whose time equals its thread's archive leaves the thread archived", async (t) => {
  const f = fixture(t);
  threadUpdate(f.client, { d: threadAt(true, T) });
  await f.server.handleDiscordMessage(f.posted({ timestamp: new Date(T) }));
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

for (const [when, archivedAt, registers] of [['after', T + 1000, false], ['before', T - 1000, true]] as const) {
  it(`a create whose thread the lookup finds archived ${when} it was posted ${registers ? 'registers the thread it unarchived' : 'leaves the thread archived'}`, { timeout: 5000 }, async (t) => {
    const f = fixture(t, { sparse: true });
    const { held, release } = holder(t);
    t.mock.method(f.client.rest, 'get', async () => { await held; return threadAt(true, archivedAt); });
    f.gatewayCreate(T);
    const lookup = (f.adapter as any).threadLookups.get(TH);
    assert.ok(lookup, 'the create waits for the thread to be looked up');
    release();
    await lookup;
    await until(() => f.pushes().length > 0);
    assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, registers ? threadMcplId : undefined);
    assert.equal(f.server.channelManager.get(threadMcplId) !== undefined, registers);
  });
}

it("a create that set out before its guild came back without the thread doesn't register it again", async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  const { held, release } = holder(t);
  f.server.buildAttachmentBlocks = async () => { await held; return []; };
  const delivery = f.server.handleDiscordMessage(f.posted({ attachments: [attachment] }));
  f.comesBack();
  assert.ok(f.adapter.isStale(TH), 'the guild came back without the thread');
  assert.equal(f.server.channelManager.get(threadMcplId), undefined, 'and the registry forgot it');
  release();
  await delivery;
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it('a create that set out before its guild came back registers a thread the guild still has', async (t) => {
  const f = fixture(t);
  const { held, release } = holder(t);
  f.server.buildAttachmentBlocks = async () => { await held; return []; };
  const delivery = f.server.handleDiscordMessage(f.posted({ attachments: [attachment] }));
  f.comesBack([threadData]);
  release();
  await delivery;
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
});

it('a thread its guild came back without is registered by an edit once a threadUpdate reports it again', async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  f.server.subscribedChannels.add(TH);
  f.comesBack();
  await f.edit('1');
  assert.equal(f.pushes().at(-1)?.params.origin.mcplChannelId, undefined, 'nothing has reported the thread since');
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  threadUpdate(f.client, { d: threadAt(false, T) });
  assert.equal(f.adapter.isStale(TH), false, 'Discord reported it again');
  await f.edit('2');
  assert.equal(f.pushes().at(-1)?.params.origin.mcplChannelId, threadMcplId);
});

it('a thread known only partly that its guild came back without is registered by an edit whose lookup began after the return', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  f.server.subscribedChannels.add(TH);
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  // An edit as the gateway delivers it: its thread is a partial, so the
  // adapter looks it up before placing the edit.
  f.client.emit('messageUpdate', { partial: true }, {
    id: M, channelId: TH, guildId: G, partial: true, channel: f.client.channels.cache.get(TH),
    content: 'edited', editedTimestamp: T + 2000, author: { id: U, username: 'Bob' },
  });
  await until(() => f.pushes().length > 0);
  assert.equal(f.adapter.isStale(TH), false, 'the lookup reported it again');
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
});

it('a create whose thread lookup was out when the thread was archived stays unregistered, though the reply predates the archive', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  const { held, release } = holder(t);
  // The reply is the thread as Discord had it before the archive.
  const before = threadAt(false, T - 1000);
  t.mock.method(f.client.rest, 'get', async () => { await held; return before; });
  f.gatewayCreate(T);
  const lookup = (f.adapter as any).threadLookups.get(TH);
  assert.ok(lookup, 'the create waits for the thread to be looked up');
  threadUpdate(f.client, { d: threadAt(true, T + 1000) });
  release();
  await lookup;
  await until(() => f.pushes().length > 0);
  assert.equal(f.adapter.getCachedChannelFacts(TH)?.archived, false, 'the older reply overwrote the archive');
  assert.equal(f.adapter.isStale(TH), true, 'so the cache is held as stale');
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it("a create whose thread lookup was out when its guild came back without the thread doesn't register it, whatever the reply says", { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  const { held, release } = holder(t);
  // The reply says the thread is live, as it was before the return.
  t.mock.method(f.client.rest, 'get', async () => { await held; return threadAt(false, T); });
  f.gatewayCreate(T + 1000);
  const lookup = (f.adapter as any).threadLookups.get(TH);
  assert.ok(lookup, 'the create waits for the thread to be looked up');
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  release();
  await lookup;
  await until(() => f.pushes().length > 0);
  assert.equal(f.adapter.isStale(TH), true, 'the return stands over a reply that may be older');
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it("a batch of facts reads every channel's name against one view of the candidates", async (t) => {
  const many = Array.from({ length: 40 }, (_, i) => channelData(String(200000000000000000n + BigInt(i)), ChannelType.GuildText, `room-${i}`));
  const f = fixture(t, { channels: many });
  const cache = f.client.guilds.cache.get(G).channels.cache;
  const values = cache.values.bind(cache);
  let scans = 0;
  cache.values = () => { scans++; return values(); };
  const listed = f.adapter.getPostingChannels();
  assert.equal(listed.length, 41);
  assert.ok(listed.every((c) => c.nameResolves === true));
  assert.equal(scans, 2, 'one pass lists the channels, and one builds the view');
  scans = 0;
  const facts = f.adapter.getCachedChannelFactsFor(many.map((c) => c.id));
  assert.equal(facts.size, 40);
  assert.equal(scans, 1);
  for (const c of many) f.server.registerGuildDelivery(G, c.id);
  scans = 0;
  f.server.rederiveNamed('every');
  assert.equal(scans, 1, 'a re-derivation of every registered channel builds one view');
  t.mock.method(f.client.rest, 'get', async () => [parentData(ChannelType.GuildText), ...many]);
  scans = 0;
  const listing = await f.adapter.listChannels(G);
  assert.equal(listing.length, 41);
  assert.equal(scans, 1, 'and so does list_channels');
});

it("an edit that leaves a channel's name, kind and category as they were re-derives no other channel", (t) => {
  const A = '100000000000000011';
  const B = '100000000000000012';
  const f = fixture(t, { channels: [channelData(A, ChannelType.GuildText, 'general'), channelData(B, ChannelType.GuildVoice, 'General')] });
  f.server.registerGuildDelivery(G, A);
  f.server.registerGuildDelivery(G, B);
  assert.equal(f.label(B), idOf(B), 'the voice channel is labelled by its id');
  const cache = f.client.guilds.cache.get(G).channels.cache;
  const values = cache.values.bind(cache);
  let scans = 0;
  cache.values = () => { scans++; return values(); };
  channelUpdate(f.client, { d: { ...channelData(A, ChannelType.GuildText, 'general'), topic: 'new topic' } });
  assert.equal(scans, 1, "only the edited channel's own label is read");
  scans = 0;
  channelUpdate(f.client, { d: channelData(A, ChannelType.GuildText, 'lobby') });
  assert.equal(scans, 2, 'a rename re-derives the channels its old name kept from theirs');
  assert.equal(f.label(B), '#General (Guild)');
});

it('a guild that comes back again with a thread it came back without no longer holds it as stale', async (t) => {
  const f = fixture(t);
  f.server.subscribedChannels.add(TH);
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  f.comesBack([threadData]);
  assert.equal(f.adapter.isStale(TH), false);
  await f.edit('1');
  assert.equal(f.pushes().at(-1)?.params.origin.mcplChannelId, threadMcplId);
});

for (const listed of [true, false]) {
  it(`a guild left and joined again ${listed ? 'with' : 'without'} a thread it came back without registers ${listed ? 'it by an edit' : 'nothing for it'}, and holds a channel the rejoin leaves out as stale`, async (t) => {
    const V = '100000000000000009';
    const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'lounge')] });
    f.server.subscribedChannels.add(TH);
    f.comesBack();
    assert.ok(f.adapter.isStale(TH) && f.adapter.isStale(V));
    f.client.actions.GuildDelete.handle({ id: G });
    // The leave removes the guild's cached channels, and with each the
    // threads its threads.cache holds, the stale thread included. A channel
    // the guild had stopped listing isn't among them, and stays.
    assert.equal(f.client.channels.cache.has(TH), false);
    assert.ok(f.client.channels.cache.has(V));
    f.client.ws.status = Status.Ready;
    guildCreate(f.client, {
      d: {
        id: G, name: 'Guild', owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
        channels: [parentData(ChannelType.GuildText)], threads: listed ? [threadData] : [],
      },
    }, { id: 0 });
    assert.ok(f.adapter.isStale(V), 'the rejoin leaves the channel out too');
    assert.equal(f.adapter.isStale(TH), false);
    await f.edit('1');
    assert.equal(f.pushes().at(-1)?.params.origin.mcplChannelId, listed ? threadMcplId : undefined);
    assert.equal(f.server.channelManager.get(threadMcplId) !== undefined, listed);
  });
}
