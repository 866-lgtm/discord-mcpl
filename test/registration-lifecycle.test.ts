/**
 * The registry follows a channel's life as discord.js tells it, including
 * the removals it makes without an event for each channel: a deleted channel
 * takes its threads with it, a guild the bot leaves takes all of its
 * channels, a channel Discord answers with Unknown Channel is deleted, a sync
 * of a guild's threads drops the live threads it doesn't list, and a
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
 * A fetch that a report on its channel overtakes is made again, and a
 * channel moved out of what the filters admit is forgotten.
 *
 * The cases drive discord.js's own actions and gateway handlers, each
 * gateway report dispatched as the gateway dispatches it (dispatch).
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
const threadListSync = require(resolve(discordJs, 'client/websocket/handlers/THREAD_LIST_SYNC.js'));
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
  /** The guild's channel filter: the channels and categories it admits. */
  guildChannels?: string[];
  /** The guild filter: the guilds it admits. */
  guildIds?: string[];
} = {}) {
  const adapter = new DiscordAdapter({
    token: 'unused',
    ...(opts.guildChannels ? { guildChannels: { [G]: opts.guildChannels } } : {}),
    ...(opts.guildIds ? { guildIds: opts.guildIds } : {}),
  });
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
      dispatch(client, 'GUILD_CREATE', guildCreate, {
        d: {
          id: G, name: 'Guild', unavailable: false, owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
          channels: [parentData(ChannelType.GuildText)], threads,
        },
      });
    },
  };
}

/** Discord's report as the gateway dispatches it: the adapter hears it
 *  first (client.ws), as it does Discord's, and then discord.js applies it
 *  with its handler for the event. */
function dispatch(client: any, event: string, handler: (client: any, packet: unknown, shard: { id: number }) => void, packet: { d: Record<string, unknown> }): void {
  client.ws.emit(event, packet.d, 0);
  handler(client, packet, { id: 0 });
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
    dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: { ...parentData(type), name: 'after' } });
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
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, {
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
  const logged = t.mock.method(console, 'error', () => {});
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
  assert.ok(f.server.deletedChannels.has(TH), 'the lookup reported the thread deleted');
  assert.equal(logged.mock.calls.some((c) => String(c.arguments[0]).includes("Couldn't look up")), false, 'a deletion is no failed lookup');
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
  dispatch(f.client, 'GUILD_CREATE', guildCreate, {
    d: {
      id: G, name: 'Guild', unavailable: false, owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
      channels: [{ ...parentData(ChannelType.GuildText), name: 'after' }, channelData(N, ChannelType.GuildText, 'new')],
      threads: [],
    },
  });
  assert.equal(f.client.guilds.cache.get(G)?.available, true);
  assert.equal(f.label(P), '#after (Guild)');
  assert.equal(f.label(N), '#new (Guild)');
  assert.equal(f.label(V), undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  assert.ok(f.removed(idOf(V)) && f.removed(threadMcplId), 'and the host is told');
  assert.ok(f.client.channels.cache.has(TH), "discord.js's client-wide cache keeps what the guild no longer lists");
  assert.ok(f.adapter.isStale(V) && f.adapter.isStale(TH), 'marked stale');
  // Nothing gone this way is remembered as deleted: the thread may only have
  // been archived, and its next message, which looks it up first, registers
  // it again.
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T + 1000));
  f.gatewayCreate(T + 1000);
  await until(() => f.pushes().length > 0);
  assert.equal(get.mock.callCount(), 1, 'the message looked the thread up');
  assert.equal(f.adapter.isStale(TH), false);
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
  dispatch(f.client, 'GUILD_CREATE', guildCreate, {
    d: {
      id: G, name: 'Guild', owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
      channels: [parentData(ChannelType.GuildText)], threads: [threadData],
    },
  });
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
    dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(true, T + 1000) });
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
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(true, T) });
  assert.equal(f.server.channelManager.get(threadMcplId), undefined, 'the archive forgot it');
  await f.server.handleDiscordMessage(f.posted({ timestamp: new Date(T + 1000) }));
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
  assert.ok(f.server.channelManager.get(threadMcplId));
});

it("a message whose time equals its thread's archive leaves the thread archived", async (t) => {
  const f = fixture(t);
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(true, T) });
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
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(false, T) });
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

/** Discord's replies to the thread's lookups, in turn: the first held
 *  until its release, so a report can arrive while it's out. */
function lookups(t: TestContext, f: ReturnType<typeof fixture>, replies: Array<Record<string, unknown>>) {
  const { held, release } = holder(t);
  let calls = 0;
  t.mock.method(f.client.rest, 'get', async () => {
    const call = calls++;
    if (call === 0) await held;
    return replies[Math.min(call, replies.length - 1)];
  });
  return { release, calls: () => calls };
}

it('a create whose thread lookup was out when the thread was archived looks it up again, and leaves it archived', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  // The first reply is the thread as Discord had it before the archive; the
  // second, after.
  const { release, calls } = lookups(t, f, [threadAt(false, T - 1000), threadAt(true, T + 1000)]);
  f.gatewayCreate(T);
  const lookup = (f.adapter as any).threadLookups.get(TH);
  assert.ok(lookup, 'the create waits for the thread to be looked up');
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(true, T + 1000) });
  release();
  await lookup;
  await until(() => f.pushes().length > 0);
  assert.equal(calls(), 2, 'the archive overtook the first lookup');
  assert.equal(f.adapter.getCachedChannelFacts(TH)?.archived, true, 'the second brought the archive back');
  assert.equal(f.adapter.isStale(TH), false);
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

for (const live of [false, true]) {
  it(`a create whose thread lookup was out when its guild came back without the thread looks it up again, and ${live ? 'registers it, live' : "leaves it archived"}`, { timeout: 5000 }, async (t) => {
    const f = fixture(t, { sparse: true });
    // The first reply says the thread is live, as it was before the return;
    // the second says what it is now.
    const { release, calls } = lookups(t, f, [threadAt(false, T), threadAt(!live, T + 2000)]);
    f.gatewayCreate(T + 1000);
    const lookup = (f.adapter as any).threadLookups.get(TH);
    assert.ok(lookup, 'the create waits for the thread to be looked up');
    f.comesBack();
    assert.ok(f.adapter.isStale(TH));
    release();
    await lookup;
    await until(() => f.pushes().length > 0);
    assert.equal(calls(), 2, "the guild's payload overtook the first lookup");
    assert.equal(f.adapter.isStale(TH), false, 'the second is newer than the return');
    assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, live ? threadMcplId : undefined);
    assert.equal(f.server.channelManager.get(threadMcplId) !== undefined, live);
  });
}

it('a lookup that every report overtakes leaves its thread stale, and the create names it only if registered', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  let out: () => void = () => {};
  const get = t.mock.method(f.client.rest, 'get', async () => {
    await new Promise<void>((done) => { out = done; });
    return threadAt(false, T - 1000);
  });
  f.gatewayCreate(T);
  const lookup = (f.adapter as any).threadLookups.get(TH);
  for (let tries = 1; tries <= 3; tries++) {
    await until(() => get.mock.callCount() === tries);
    dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(false, T + tries) });
    out();
  }
  await until(() => f.pushes().length > 0 || get.mock.callCount() > 3);
  assert.equal(get.mock.callCount(), 3, 'three tries, and no more');
  await lookup;
  await until(() => f.pushes().length > 0);
  assert.equal(get.mock.callCount(), 3);
  assert.equal(f.adapter.isStale(TH), true);
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
  const get = t.mock.method(f.client.rest, 'get', async () => []);
  scans = 0;
  const listing = await f.adapter.listChannels(G);
  assert.equal(listing.length, 41);
  assert.equal(scans, 1, 'and so does list_channels');
  assert.equal(get.mock.callCount(), 0, 'which reads the guild from the cache');
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
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: { ...channelData(A, ChannelType.GuildText, 'general'), topic: 'new topic' } });
  assert.equal(scans, 1, "only the edited channel's own label is read");
  scans = 0;
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: channelData(A, ChannelType.GuildText, 'lobby') });
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
    dispatch(f.client, 'GUILD_CREATE', guildCreate, {
      d: {
        id: G, name: 'Guild', owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
        channels: [parentData(ChannelType.GuildText)], threads: listed ? [threadData] : [],
      },
    });
    assert.ok(f.adapter.isStale(V), 'the rejoin leaves the channel out too');
    assert.equal(f.adapter.isStale(TH), false);
    await f.edit('1');
    assert.equal(f.pushes().at(-1)?.params.origin.mcplChannelId, listed ? threadMcplId : undefined);
    assert.equal(f.server.channelManager.get(threadMcplId) !== undefined, listed);
  });
}

it("a create on its way when the bot leaves the guild doesn't register a thread whose channel the guild had stopped listing, though an update reported it live", async (t) => {
  const Q = '100000000000000017';
  const TQ = '100000000000000018';
  const f = fixture(t, { channels: [channelData(Q, ChannelType.GuildText, 'old-news')] });
  const inQ = { ...threadAt(false, T), id: TQ, name: 'q-topic', parent_id: Q };
  f.client.channels._add(inQ);
  // The guild comes back without Q or its thread; then Discord reports the
  // thread live.
  f.comesBack();
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: inQ });
  assert.equal(f.adapter.isStale(TQ), false);
  const { held, release } = holder(t);
  f.server.buildAttachmentBlocks = async () => { await held; return []; };
  const delivery = f.server.handleDiscordMessage(f.posted({ channelId: TQ, threadId: TQ, threadName: 'q-topic', threadParentName: 'old-news', attachments: [attachment] }));
  f.client.actions.GuildDelete.handle({ id: G });
  // The leave removes the guild's cached channels and their threads; Q, which
  // the guild no longer listed, isn't among them, so its thread stays.
  assert.equal(f.client.channels.cache.has(TH), false);
  assert.ok(f.client.channels.cache.has(TQ));
  release();
  await delivery;
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(idOf(TQ)), undefined);
});

it("a fetch of a channel the cache doesn't hold, out when Discord reports its rename, is made again, so the cache keeps the new name", { timeout: 5000 }, async (t) => {
  const X = '100000000000000013';
  const f = fixture(t);
  const { release, calls } = lookups(t, f, [channelData(X, ChannelType.GuildText, 'old'), channelData(X, ChannelType.GuildText, 'new')]);
  const meta = f.adapter.getChannelMeta(X);
  await until(() => calls() === 1);
  // discord.js emits no channelUpdate for a channel it doesn't hold.
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: channelData(X, ChannelType.GuildText, 'new') });
  release();
  assert.equal((await meta)?.name, 'new');
  assert.equal(calls(), 2, 'the rename overtook the first fetch');
  assert.equal(f.adapter.getCachedChannelFacts(X)?.name, 'new');
  assert.equal(f.adapter.isStale(X), false);
});

it("a fetch of a channel the cache doesn't hold, out when a guild's payload arrives, is made again", { timeout: 5000 }, async (t) => {
  const X = '100000000000000013';
  const f = fixture(t);
  const { release, calls } = lookups(t, f, [channelData(X, ChannelType.GuildText, 'news')]);
  const meta = f.adapter.getChannelMeta(X);
  await until(() => calls() === 1);
  f.comesBack();
  release();
  await meta;
  assert.equal(calls(), 2, "its guild wasn't known while it was out, so the payload overtook it");
  assert.equal(f.adapter.isStale(X), false);
});

it('a channel its guild came back without is current again once an update reports it', (t) => {
  const V = '100000000000000009';
  const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'lounge')] });
  f.comesBack();
  assert.ok(f.adapter.isStale(V));
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: channelData(V, ChannelType.GuildVoice, 'lounge') });
  assert.equal(f.adapter.isStale(V), false);
});

it("a deleted channel's or thread's stale mark goes, and so do the marks of a guild the bot leaves", (t) => {
  const V = '100000000000000009';
  const W = '100000000000000016';
  const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'lounge'), channelData(W, ChannelType.GuildText, 'old-news')] });
  f.comesBack();
  assert.ok(f.adapter.isStale(TH) && f.adapter.isStale(V) && f.adapter.isStale(W));
  f.deleteThread();
  f.client.actions.ChannelDelete.handle({ id: V, guild_id: G, type: ChannelType.GuildVoice });
  assert.equal(f.adapter.isStale(TH), false);
  assert.equal(f.adapter.isStale(V), false);
  assert.ok(f.adapter.isStale(W));
  f.client.actions.GuildDelete.handle({ id: G });
  assert.equal(f.adapter.isStale(W), false);
});

/** A guild whose filter admits the channels of one category, `in` (C1),
 *  holding X, and not those of `out` (C2). */
const C1 = '100000000000000014';
const C2 = '100000000000000015';
const X = '100000000000000013';
const categories = [
  { id: C1, guild_id: G, type: ChannelType.GuildCategory, name: 'in', parent_id: null },
  { id: C2, guild_id: G, type: ChannelType.GuildCategory, name: 'out', parent_id: null },
];
const inCategory = (parent: string) => ({ ...channelData(X, ChannelType.GuildText, 'news'), parent_id: parent });
/** A thread under X, admitted through it. */
const TX = '100000000000000019';
const threadInX = { ...threadAt(false, T), id: TX, name: 'x-topic', parent_id: X };

/** The filtered guild, with X and its thread registered. */
function filtered(t: TestContext) {
  const f = fixture(t, { guildChannels: [C1, P], channels: [...categories, inCategory(C1)] });
  f.client.channels._add(threadInX);
  f.server.registerGuildDelivery(G, X);
  f.server.registerGuildDelivery(G, TX);
  assert.equal(f.label(X), '#news (Guild)');
  assert.equal(f.label(TX), '#news › x-topic (Guild)');
  return f;
}

it('a channel moved out of what the filters admit is forgotten with the threads admitted through it, and the host is told', (t) => {
  const f = filtered(t);
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: inCategory(C2) });
  assert.equal(f.label(X), undefined);
  assert.equal(f.label(TX), undefined);
  assert.ok(f.removed(idOf(X)) && f.removed(idOf(TX)));
});

it('a guild back from an outage forgets a listed channel its filter no longer admits, with the threads admitted through it', (t) => {
  const f = filtered(t);
  f.client.actions.GuildDelete.handle({ id: G, unavailable: true });
  dispatch(f.client, 'GUILD_CREATE', guildCreate, {
    d: {
      id: G, name: 'Guild', unavailable: false, owner_id: BOT, member_count: 1, members: [{ user: bot, roles: [] }],
      channels: [parentData(ChannelType.GuildText), ...categories, inCategory(C2)], threads: [threadInX],
    },
  });
  assert.ok(f.client.guilds.cache.get(G).channels.cache.has(X), 'the guild still has it');
  assert.ok(f.client.guilds.cache.get(G).channels.cache.has(TX), 'and its thread');
  assert.equal(f.label(X), undefined);
  assert.equal(f.label(TX), undefined);
  assert.ok(f.removed(idOf(X)) && f.removed(idOf(TX)));
});

it("a message leaves a thread archived whose archive time isn't known", async (t) => {
  const f = fixture(t);
  const { archive_timestamp: _unknown, ...metadata } = threadAt(true, T).thread_metadata;
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: { ...threadData, thread_metadata: metadata } });
  assert.equal(f.adapter.getCachedChannelFacts(TH)?.archived, true);
  assert.equal(f.adapter.getCachedChannelFacts(TH)?.archivedAt, undefined);
  f.gatewayCreate(T + 1000);
  await until(() => f.pushes().length > 0);
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it("a stale channel's label is re-derived against the names other channels hold now", (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), '#before (Guild)');
  // Its cached facts may fall behind Discord's, as a lookup every report
  // overtook can leave them; another channel then takes its name.
  (f.adapter as any).stale.set(P, { guildId: G });
  f.client.actions.ChannelCreate.handle(channelData(X, ChannelType.GuildText, 'before'));
  assert.equal(f.label(P), idOf(P), "two text channels of one name: neither label is the name");
});

it('create_text_channel labels the channel it creates as listing does, by its id when another channel of its name and kind holds the name', async (t) => {
  const f = fixture(t);
  t.mock.method(f.client.rest, 'post', async () => channelData(X, ChannelType.GuildText, 'before'));
  t.mock.method(f.client.rest, 'get', async () => channelData(X, ChannelType.GuildText, 'before'));
  const created = await f.adapter.createTextChannel(G, 'before');
  assert.equal(created.label, idOf(X));
});

it("create_text_channel keeps what the gateway reported of the new channel while its POST was out", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const { held, release } = holder(t);
  let posted!: () => void;
  const atPost = new Promise<void>((done) => { posted = done; });
  t.mock.method(f.client.rest, 'post', async () => { posted(); await held; return channelData(X, ChannelType.GuildText, 'news'); });
  t.mock.method(f.client.rest, 'get', async () => channelData(X, ChannelType.GuildText, 'renamed'));
  const creating = f.adapter.createTextChannel(G, 'news');
  await atPost;
  // The gateway reports the channel, and then a rename, before the POST's reply lands.
  f.client.actions.ChannelCreate.handle(channelData(X, ChannelType.GuildText, 'news'));
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: channelData(X, ChannelType.GuildText, 'renamed') });
  release();
  const created = await creating;
  assert.equal(created.name, 'renamed');
  assert.equal(f.client.channels.cache.get(X)?.name, 'renamed');
  assert.equal(created.label, '#renamed (Guild)');
});

it("one channel's facts give the answer a whole view gives, beside a same-named voice channel and a same-named channel of another guild", (t) => {
  const V = '100000000000000009';
  const G2 = '100000000000000020';
  const W2 = '100000000000000021';
  const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'before')] });
  f.client.guilds._add({ id: G2, name: 'Other', owner_id: BOT, roles: [], channels: [{ id: W2, guild_id: G2, type: ChannelType.GuildText, name: 'before', parent_id: null }] });
  const whole = f.adapter.getCachedChannelFactsFor([P, V, W2]);
  for (const id of [P, V, W2]) {
    assert.equal(f.adapter.getCachedChannelFacts(id)?.nameResolves, whole.get(id)?.nameResolves, id);
  }
  assert.deepEqual([P, V, W2].map((id) => whole.get(id)?.nameResolves), [true, false, true], 'the text channel holds the name in its guild');
});

it("one channel's facts read only the channels of its own name", (t) => {
  const many = Array.from({ length: 40 }, (_, i) => channelData(String(200000000000000000n + BigInt(i)), ChannelType.GuildText, `room-${i}`));
  const f = fixture(t, { channels: many });
  const allowed = t.mock.method(f.adapter as any, 'channelAllowed');
  assert.equal(f.adapter.getCachedChannelFacts(P)?.nameResolves, true);
  assert.equal(allowed.mock.callCount(), 1, 'the one channel of its name is the only candidate built');
});

it("an edit from a channel that's stale looks it up first, and registers it", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.server.subscribedChannels.add(TH);
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  f.client.emit('messageUpdate', { partial: true }, {
    id: M, channelId: TH, guildId: G, partial: true, channel: f.client.channels.cache.get(TH),
    content: 'edited', editedTimestamp: T + 2000, author: { id: U, username: 'Bob' },
  });
  await until(() => f.pushes().length > 0);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(f.adapter.isStale(TH), false);
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
});

it("a stale channel's meta is fetched again, which clears the mark", async (t) => {
  const f = fixture(t);
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  await f.adapter.getChannelMeta(TH);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(f.adapter.isStale(TH), false);
});

it('the catch-up fetches a stale thread again before it decides, and registers it', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  watermarkFile(t);
  f.server.subscribedChannels.add(TH);
  f.server.forwardedWatermark.set(TH, '100');
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  f.adapter.fetchHistory = async () => [{
    id: '200', content: 'later', cleanContent: 'later', authorId: U, authorName: 'Bob',
    timestamp: new Date(T + 1000), mentionsBot: false, attachments: [],
  }] as any;
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  await f.server.runReconnectSweep();
  assert.equal(get.mock.callCount(), 1);
  assert.equal(f.adapter.isStale(TH), false);
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, threadMcplId);
});

it("a lookup whose later try fails after an overtaken one leaves its thread stale", { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  t.mock.method(console, 'error', () => {});
  const { held, release } = holder(t);
  let calls = 0;
  t.mock.method(f.client.rest, 'get', async () => {
    if (calls++ === 0) { await held; return threadAt(false, T - 1000); }
    throw new Error('Service Unavailable');
  });
  f.gatewayCreate(T);
  const lookup = (f.adapter as any).threadLookups.get(TH);
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(true, T + 1000) });
  release();
  await lookup;
  await until(() => f.pushes().length > 0);
  assert.equal(calls, 2);
  assert.equal(f.adapter.isStale(TH), true, 'the first reply, older than the archive, is in the cache');
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it("a thread Discord answers Unknown Channel for when it's looked up loses its stale mark, being deleted", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  t.mock.method(f.client.rest, 'get', async () => { throw unknownChannel(); });
  f.gatewayCreate(T);
  await until(() => f.pushes().length > 0);
  assert.equal(f.adapter.isStale(TH), false);
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
});

for (const [event, d] of [
  ['THREAD_CREATE', { ...threadAt(false, T), id: X, name: 'current' }],
  ['CHANNEL_CREATE', channelData(X, ChannelType.GuildText, 'news')],
  ['THREAD_DELETE', { id: X, guild_id: G, parent_id: P, type: ChannelType.PublicThread }],
  ['CHANNEL_DELETE', { id: '100000000000000022', guild_id: G, type: ChannelType.GuildText }],
  ['THREAD_LIST_SYNC', { guild_id: G, threads: [], members: [] }],
] as const) {
  it(`a fetch out when the gateway dispatches ${event} is made again`, { timeout: 5000 }, async (t) => {
    const f = fixture(t);
    const { release, calls } = lookups(t, f, [channelData(X, ChannelType.GuildText, 'news')]);
    const meta = f.adapter.getChannelMeta(X);
    await until(() => calls() === 1);
    // The adapter hears the report as the gateway dispatches it; what
    // discord.js then does with it doesn't matter here.
    f.client.ws.emit(event, d, 0);
    release();
    await meta;
    assert.equal(calls(), 2);
  });
}

it("a channel update that changes no name, kind or category re-derives none of its threads", (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  const rederive = t.mock.method(f.server, 'rederiveChannels');
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: { ...parentData(ChannelType.GuildText), topic: 'new topic' } });
  assert.equal(rederive.mock.callCount(), 0);
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: { ...parentData(ChannelType.GuildText), name: 'after' } });
  assert.ok(rederive.mock.callCount() > 0);
  assert.equal(f.label(TH), '#after › topic (Guild)');
});

it("list_channels lists the guild's own channels from the cache, every kind but threads, and refuses a guild in an outage", async (t) => {
  const V = '100000000000000009';
  const A = '100000000000000023';
  const F = '100000000000000024';
  const f = fixture(t, { channels: [
    channelData(V, ChannelType.GuildVoice, 'lounge'), channelData(A, ChannelType.GuildAnnouncement, 'news'),
    channelData(F, ChannelType.GuildForum, 'ideas'), ...categories,
  ] });
  const get = t.mock.method(f.client.rest, 'get', async () => []);
  const listed = await f.adapter.listChannels(G);
  assert.deepEqual(listed.map((c) => c.id).sort(), [P, V, A, F, C1, C2].sort(), 'the thread in the cache is not listed');
  assert.equal(get.mock.callCount(), 0);
  // The guild comes back with P alone: the listing is what it came back with.
  f.comesBack();
  assert.deepEqual((await f.adapter.listChannels(G)).map((c) => c.id), [P]);
  f.client.actions.GuildDelete.handle({ id: G, unavailable: true });
  (f.adapter as any).stale.set(P, { guildId: G });
  await assert.rejects(f.adapter.listChannels(G), /unavailable/);
  assert.equal(get.mock.callCount(), 0, 'nothing is fetched for a guild in an outage');
});

it('a reaction from a stale channel looks it up first', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  const message = {
    id: M, channelId: TH, guildId: G, channel: f.client.channels.cache.get(TH), partial: false,
    author: { id: U, username: 'Bob' }, content: 'hi', cleanContent: 'hi',
  };
  f.client.emit('messageReactionAdd', { partial: false, emoji: { name: '👍', id: null }, message }, { id: U, username: 'Bob', partial: false });
  await until(() => get.mock.callCount() > 0 && !f.adapter.isStale(TH));
  assert.equal(get.mock.callCount(), 1);
  assert.equal(f.adapter.isStale(TH), false);
});

it('a create on its way when its channel moves out of the filters neither registers it again nor names it', async (t) => {
  const f = fixture(t, { guildChannels: [C1, P], channels: [...categories, inCategory(C1)] });
  const post = () => f.posted({ channelId: X, channelName: 'news', threadId: undefined, threadName: undefined, threadParentName: undefined, attachments: [attachment] });
  // Without the move, the same delivery registers the channel and names it.
  const control = fixture(t, { guildChannels: [C1, P], channels: [...categories, inCategory(C1)] });
  control.server.buildAttachmentBlocks = async () => [];
  await control.server.handleDiscordMessage(post());
  assert.equal(control.pushes().length, 1);
  assert.equal(control.pushes()[0]!.params.origin.mcplChannelId, idOf(X));
  assert.equal(control.label(X), '#news (Guild)');
  const { held, release } = holder(t);
  let reached!: () => void;
  const atAttachments = new Promise<void>((done) => { reached = done; });
  f.server.buildAttachmentBlocks = async () => { reached(); await held; return []; };
  const delivery = f.server.handleDiscordMessage(post());
  await atAttachments;
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: inCategory(C2) });
  release();
  await delivery;
  assert.equal(f.pushes().length, 1, 'the message is still delivered');
  assert.equal(f.pushes()[0]!.params.origin.mcplChannelId, undefined);
  assert.equal(f.label(X), undefined);
});

it('a thread the filter lists by its own id stays registered when its channel moves out of the filters', (t) => {
  const f = fixture(t, { guildChannels: [C1, P, TX], channels: [...categories, inCategory(C1)] });
  f.client.channels._add(threadInX);
  f.server.registerGuildDelivery(G, X);
  f.server.registerGuildDelivery(G, TX);
  assert.equal(f.label(X), '#news (Guild)');
  assert.equal(f.label(TX), '#news › x-topic (Guild)');
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: inCategory(C2) });
  assert.equal(f.label(X), undefined);
  assert.equal(f.label(TX), '#news › x-topic (Guild)', 'still admitted by its own id');
});

it("a stale channel's meta that Discord answers Unknown Channel for loses its mark", async (t) => {
  const f = fixture(t);
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  t.mock.method(f.client.rest, 'get', async () => { throw unknownChannel(); });
  await assert.rejects(f.adapter.getChannelMeta(TH));
  assert.equal(f.adapter.isStale(TH), false);
});

it("an edit in a guild the filter leaves out looks nothing up", { timeout: 5000 }, async (t) => {
  const f = fixture(t, { guildIds: ['100000000000000099'] });
  f.comesBack();
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  f.client.emit('messageUpdate', { partial: true }, {
    id: M, channelId: TH, guildId: G, partial: true, channel: f.client.channels.cache.get(TH),
    content: 'edited', editedTimestamp: T + 2000, author: { id: U, username: 'Bob' },
  });
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
  assert.equal(get.mock.callCount(), 0);
  assert.equal(f.pushes().length, 0);
});

it("an overtaken try's reply marks its channel stale as it lands, until a fresh try clears it", { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  const gates: Array<() => void> = [];
  let calls = 0;
  t.mock.method(f.client.rest, 'get', async () => {
    calls++;
    await new Promise<void>((done) => gates.push(done));
    return threadAt(false, T - 1000 + calls);
  });
  f.gatewayCreate(T);
  const lookup = (f.adapter as any).threadLookups.get(TH);
  await until(() => calls === 1);
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(false, T) });
  gates[0]!();
  await until(() => calls === 2);
  assert.equal(f.adapter.isStale(TH), true, 'the older reply is in the cache while the next try is out');
  gates[1]!();
  await lookup;
  assert.equal(f.adapter.isStale(TH), false);
});

it("a reaction or a create in a guild the filter leaves out looks nothing up", { timeout: 5000 }, async (t) => {
  // In a guild the filter admits, the same reaction looks its stale channel up.
  const control = fixture(t, { guildIds: [G] });
  control.comesBack();
  const looked = t.mock.method(control.client.rest, 'get', async () => threadAt(false, T));
  control.client.emit('messageReactionAdd', { partial: false, emoji: { name: '👍', id: null }, message: {
    id: M, channelId: TH, guildId: G, channel: control.client.channels.cache.get(TH), partial: false,
    author: { id: U, username: 'Bob' }, content: 'hi', cleanContent: 'hi',
  } }, { id: U, username: 'Bob', partial: false });
  await until(() => looked.mock.callCount() > 0);
  const f = fixture(t, { guildIds: ['100000000000000099'] });
  f.comesBack();
  assert.ok(f.adapter.isStale(TH));
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  const message = {
    id: M, channelId: TH, guildId: G, channel: f.client.channels.cache.get(TH), partial: false,
    author: { id: U, username: 'Bob' }, content: 'hi', cleanContent: 'hi',
  };
  f.client.emit('messageReactionAdd', { partial: false, emoji: { name: '👍', id: null }, message }, { id: U, username: 'Bob', partial: false });
  f.gatewayCreate(T);
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
  assert.equal(get.mock.callCount(), 0);
  assert.equal(f.pushes().length, 0);
});

it("a stale channel fetched fresh is registered again from what the fetch brought", async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), '#before (Guild)');
  // An overtaken reply left an older name in the cache and marked it stale,
  // and a re-derivation meanwhile registered that name.
  (f.adapter as any).stale.set(P, { guildId: G });
  f.client.channels.cache.get(P).name = 'older';
  f.server.rederiveChannels(f.server.registeredInGuild(G));
  // Its cached facts decide nothing: what's registered stands, labelled by
  // its id, since it answers no name meanwhile.
  assert.equal(f.label(P), idOf(P));
  assert.equal((f.server.channelManager.get(idOf(P))!.metadata as { channelName?: string }).channelName, 'before');
  assert.equal(f.sent.some((x) => x.method === 'channels/changed'
    && x.params.updated?.some((d: { id: string; metadata?: { channelName?: string } }) => d.id === idOf(P) && d.metadata?.channelName === 'older')), false,
  'the older name was never announced');
  t.mock.method(f.client.rest, 'get', async () => ({ ...parentData(ChannelType.GuildText), name: 'current' }));
  await f.adapter.getChannelMeta(P);
  assert.equal(f.adapter.isStale(P), false);
  assert.equal(f.label(P), '#current (Guild)');
});

it("a tool's fetch of a channel the cache doesn't hold is made again when an update overtakes it", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const { release, calls } = lookups(t, f, [channelData(X, ChannelType.GuildText, 'older'), channelData(X, ChannelType.GuildText, 'news')]);
  const refusal = f.adapter.inspectionRefusal(X);
  await until(() => calls() === 1);
  f.client.ws.emit('CHANNEL_UPDATE', channelData(X, ChannelType.GuildText, 'news'), 0);
  release();
  assert.equal(await refusal, null);
  assert.equal(calls(), 2);
  assert.equal(f.client.channels.cache.get(X)?.name, 'news');
  assert.equal(f.adapter.isStale(X), false);
});

it("Unknown Channel takes the channel out of discord.js's cache, so no later read finds it live", async (t) => {
  const f = fixture(t);
  (f.adapter as any).stale.set(TH, { guildId: G });
  assert.ok(f.client.channels.cache.has(TH));
  assert.ok(f.client.guilds.cache.get(G).channels.cache.has(TH), "the guild's cache holds it");
  assert.ok(f.client.channels.cache.get(P).threads.cache.has(TH), "and its channel's threads");
  t.mock.method(f.client.rest, 'get', async () => { throw unknownChannel(); });
  await assert.rejects(f.adapter.getChannelMeta(TH));
  assert.equal(f.client.channels.cache.has(TH), false);
  assert.equal(f.client.guilds.cache.get(G).channels.cache.has(TH), false, "nor the guild's cache");
  assert.equal(f.client.channels.cache.get(P).threads.cache.has(TH), false, "nor its channel's threads");
  assert.equal(f.adapter.isStale(TH), false);
  await assert.rejects(f.adapter.getChannelMeta(TH), 'read again, it is fetched again, and still unknown');
});

it("a fresh fetch of a thread's channel derives the thread's label again", async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  assert.equal(f.label(TH), '#before › topic (Guild)');
  (f.adapter as any).stale.set(P, { guildId: G });
  f.client.channels.cache.get(P).name = 'older';
  f.server.rederiveChannels(f.server.registeredInGuild(G));
  assert.equal(f.label(TH), '#before › topic (Guild)', "a stale channel's cached name doesn't replace the one the thread had");
  t.mock.method(f.client.rest, 'get', async () => ({ ...parentData(ChannelType.GuildText), name: 'current' }));
  await f.adapter.getChannelMeta(P);
  assert.equal(f.label(TH), '#current › topic (Guild)');
});

it('a fresh fetch that shows a registered thread archived forgets it, as an update would', async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  (f.adapter as any).stale.set(TH, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => threadAt(true, T + 1000));
  await f.adapter.getChannelMeta(TH);
  assert.equal(f.label(TH), undefined);
  assert.ok(f.removed(threadMcplId));
});

it('a fresh fetch that shows a registered channel outside the filters forgets it, with the threads admitted through it', async (t) => {
  const f = filtered(t);
  (f.adapter as any).stale.set(X, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => inCategory(C2));
  await f.adapter.getChannelMeta(X);
  assert.equal(f.label(X), undefined);
  assert.equal(f.label(TX), undefined);
  assert.ok(f.removed(idOf(X)) && f.removed(idOf(TX)));
});

it("a tool's read that Discord answers Unknown Channel for takes the channel out of the registry, as a deletion", async (t) => {
  const f = fixture(t);
  watermarkFile(t);
  f.server.registerGuildDelivery(G, TH);
  f.server.forwardedWatermark.set(TH, '100');
  (f.adapter as any).stale.set(TH, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => { throw unknownChannel(); });
  await assert.rejects(f.adapter.inspectionRefusal(TH));
  assert.equal(f.label(TH), undefined);
  assert.equal(f.server.forwardedWatermark.has(TH), false);
  assert.ok(f.server.deletedChannels.has(TH));
});

it("Unknown Channel for a channel takes its own cached threads out too", async (t) => {
  const f = fixture(t);
  assert.ok(f.client.channels.cache.has(TH));
  (f.adapter as any).stale.set(P, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => { throw unknownChannel(); });
  await assert.rejects(f.adapter.getChannelMeta(P));
  assert.equal(f.client.channels.cache.has(P), false);
  assert.equal(f.client.channels.cache.has(TH), false, 'its thread went with it');
});

it("a name a stale channel holds resolves to no channel until it's fetched fresh, and then to the channel that holds it now", async (t) => {
  const Y = '100000000000000025';
  const f = fixture(t, { channels: [channelData(X, ChannelType.GuildText, 'news'), channelData(Y, ChannelType.GuildVoice, 'archive')] });
  const before = f.adapter.resolveChannelRef('#news (Guild)');
  assert.equal(before.ok && before.id, X);
  // Discord renamed them both; X's fetch was overtaken, so its cache keeps 'news'.
  f.client.channels.cache.get(Y).name = 'news';
  (f.adapter as any).stale.set(X, { guildId: G });
  const unsure = f.adapter.resolveChannelRef('#news (Guild)');
  assert.equal(unsure.ok, false, 'X may still be news, or not');
  // Fetched fresh, X has given the name up.
  t.mock.method(f.client.rest, 'get', async () => channelData(X, ChannelType.GuildText, 'archive'));
  await f.adapter.refreshStale();
  const resolved = f.adapter.resolveChannelRef('#news (Guild)');
  assert.equal(resolved.ok && resolved.id, Y);
  // And X is found by the name Discord has for it.
  assert.equal(f.adapter.isStale(X), false);
  const archive = f.adapter.resolveChannelRef('#archive (Guild)');
  assert.equal(archive.ok && archive.id, X);
});

it("a name-addressed send fetches stale channels first, and sends where the name points now", async (t) => {
  const Y = '100000000000000025';
  const f = fixture(t, { channels: [channelData(X, ChannelType.GuildText, 'news'), channelData(Y, ChannelType.GuildVoice, 'news2')] });
  f.client.channels.cache.get(Y).name = 'news';
  (f.adapter as any).stale.set(X, { guildId: G });
  const get = t.mock.method(f.client.rest, 'get', async () => channelData(X, ChannelType.GuildText, 'archive'));
  const sent: string[] = [];
  f.adapter.sendMessage = (async (channelId: string) => { sent.push(channelId); return { messageId: '1' }; }) as any;
  await (f.server as any).handleToolCall('send_message', { channelId: '#news (Guild)', content: 'hi' });
  assert.equal(get.mock.callCount(), 1, 'the stale channel was fetched before the name was resolved');
  assert.deepEqual(sent, [Y]);
});

it("a listing leaves a stale channel out, so its cached facts register nothing", (t) => {
  const f = filtered(t);
  // X moved out of the filters, and an older reply put it back in C1 in the cache.
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: inCategory(C2) });
  assert.equal(f.label(X), undefined);
  f.client.channels.cache.get(X).parentId = C1;
  (f.adapter as any).stale.set(X, { guildId: G });
  assert.equal(f.adapter.getPostingChannels().some((c) => c.id === X), false);
  (f.server as any).refreshChannels();
  assert.equal(f.label(X), undefined);
});

it("refresh_channels fetches stale channels first and registers from what they bring", async (t) => {
  const f = filtered(t);
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: inCategory(C2) });
  f.client.channels.cache.get(X).parentId = C1;
  (f.adapter as any).stale.set(X, { guildId: G });
  const get = t.mock.method(f.client.rest, 'get', async () => inCategory(C2));
  await (f.server as any).handleToolCall('refresh_channels', {});
  assert.equal(get.mock.callCount(), 1);
  assert.equal(f.adapter.isStale(X), false);
  assert.equal(f.label(X), undefined, 'Discord has it outside the filters');
});

it("create_text_channel whose fetch afterwards fails keeps the channel stale and labels it by its id", async (t) => {
  const f = fixture(t);
  t.mock.method(f.client.rest, 'post', async () => channelData(X, ChannelType.GuildText, 'fresh-name'));
  t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  const created = await f.adapter.createTextChannel(G, 'fresh-name');
  assert.equal(created.id, X);
  assert.equal(f.adapter.isStale(X), true);
  assert.equal(created.label, idOf(X));
  assert.equal(created.name, 'fresh-name', 'the name it was made with');
});

it("create_text_channel whose fetch afterwards is overtaken on every try reports the name it made the channel with", async (t) => {
  const f = fixture(t);
  t.mock.method(f.client.rest, 'post', async () => channelData(X, ChannelType.GuildText, 'made'));
  // Each reply is older than a report that arrives while it's out.
  const get = t.mock.method(f.client.rest, 'get', async () => {
    (f.adapter as any).overtake(X);
    return channelData(X, ChannelType.GuildText, 'older-reply');
  });
  const created = await f.adapter.createTextChannel(G, 'made');
  assert.equal(get.mock.callCount(), 3, 'each of its three tries is overtaken');
  assert.equal(f.adapter.isStale(X), true);
  assert.equal(f.client.channels.cache.get(X)?.name, 'older-reply');
  assert.equal(created.name, 'made');
  assert.equal(created.label, idOf(X));
});

it("a thread registered before its channel was known keeps its registration while it's stale, whatever its cache shows", async (t) => {
  // Known only from a message, and registered by its id, with no channel.
  const f = fixture(t, { sparse: true });
  assert.equal(f.server.registerGuildDelivery(G, TH), threadMcplId);
  const meta = () => f.server.channelManager.get(threadMcplId)?.metadata;
  assert.equal(meta()?.parentId, undefined);
  // Every reply of its fetch lands after a report on it: the cache takes in
  // the reply's channel, but the thread is stale, so that decides nothing.
  t.mock.method(f.client.rest, 'get', async () => {
    (f.adapter as any).overtake(TH);
    return threadAt(false, T);
  });
  await (f.adapter as any).refetchChannel(TH);
  assert.equal(f.adapter.isStale(TH), true);
  assert.equal(f.client.channels.cache.get(TH).parentId, P);
  assert.equal(meta()?.parentId, undefined);
  assert.equal(f.label(TH), threadMcplId);
});

it("a fresh fetch that gives a channel a name re-derives the channels that held or hold it", async (t) => {
  const V = '100000000000000009';
  const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'news')] });
  f.server.registerGuildDelivery(G, V);
  assert.equal(f.label(V), '#news (Guild)');
  // Discord renamed P to news; its fetch was overtaken, so the cache keeps 'before'.
  (f.adapter as any).stale.set(P, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => ({ ...parentData(ChannelType.GuildText), name: 'news' }));
  await f.adapter.getChannelMeta(P);
  // A text channel holds the name now, so the voice channel's label is its id.
  assert.equal(f.label(V), idOf(V));
});

it("a name that a stale channel holds resolves to no channel when its fetch fails, rather than to the other channel holding it", async (t) => {
  const Y = '100000000000000025';
  const f = fixture(t, { channels: [channelData(X, ChannelType.GuildText, 'news'), channelData(Y, ChannelType.GuildVoice, 'news')] });
  const before = f.adapter.resolveChannelRef('#news (Guild)');
  assert.equal(before.ok && before.id, X, 'the text channel holds the name');
  (f.adapter as any).stale.set(X, { guildId: G });
  const get = t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  const sent: string[] = [];
  f.adapter.sendMessage = (async (channelId: string) => { sent.push(channelId); return { messageId: '1' }; }) as any;
  const result = await (f.server as any).handleToolCall('send_message', { channelId: '#news (Guild)', content: 'hi' });
  assert.equal(get.mock.callCount(), 1, 'the stale channel was fetched first');
  assert.equal(f.adapter.isStale(X), true);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /by its id instead: meanwhile the registered label of each channel a name addresses there is its id/);
  assert.deepEqual(sent, [], 'nothing was sent');
  // X may have taken any name meanwhile, so no name in its server resolves,
  // nor a name given without a server.
  assert.equal(f.adapter.resolveChannelRef('#before (Guild)').ok, false);
  assert.equal(f.adapter.resolveChannelRef('#before').ok, false);
  assert.equal(f.adapter.resolveChannelRef(idOf(P)).ok, true, 'an id still does');
});

it("a stale channel renamed while its fetch was out keeps every name in its server from resolving, its new one included", async (t) => {
  const Y = '100000000000000025';
  const f = fixture(t, { channels: [channelData(X, ChannelType.GuildText, 'former'), channelData(Y, ChannelType.GuildVoice, 'news')] });
  const fresh = f.adapter.resolveChannelRef('#news (Guild)');
  assert.equal(fresh.ok && fresh.id, Y);
  // Discord renamed X to news, and an older reply left 'former' cached, stale.
  (f.adapter as any).stale.set(X, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  const sent: string[] = [];
  f.adapter.sendMessage = (async (channelId: string) => { sent.push(channelId); return { messageId: '1' }; }) as any;
  const result = await (f.server as any).handleToolCall('send_message', { channelId: '#news (Guild)', content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /current name may be this one/);
  assert.deepEqual(sent, [], "X may be news now, and the text channel would win it");
});

it("a channel addressed by its composite id fetches no stale channel first", async (t) => {
  const f = fixture(t, { channels: [channelData(X, ChannelType.GuildText, 'news')] });
  (f.adapter as any).stale.set(X, { guildId: G });
  const get = t.mock.method(f.client.rest, 'get', async () => channelData(X, ChannelType.GuildText, 'news'));
  const sent: string[] = [];
  f.adapter.sendMessage = (async (channelId: string) => { sent.push(channelId); return { messageId: '1' }; }) as any;
  await (f.server as any).handleToolCall('send_message', { channelId: idOf(P), content: 'hi' });
  assert.equal(get.mock.callCount(), 0);
  assert.deepEqual(sent, [P]);
});

it("a fetch that every report overtakes labels the channel by its id, and the channels sharing its name too", { timeout: 5000 }, async (t) => {
  // P is a voice channel, and text channel W holds the name they share.
  const W = '100000000000000026';
  // (Its thread is the partly known one: a voice channel holds no threads cache.)
  const f = fixture(t, { type: ChannelType.GuildVoice, sparse: true, channels: [channelData(W, ChannelType.GuildText, 'before')] });
  f.server.registerGuildDelivery(G, P);
  f.server.registerGuildDelivery(G, W);
  assert.equal(f.label(W), '#before (Guild)');
  let out: () => void = () => {};
  const get = t.mock.method(f.client.rest, 'get', async () => {
    await new Promise<void>((done) => { out = done; });
    return parentData(ChannelType.GuildVoice);
  });
  // A lookup of P, as a delivery from it makes when it's partly known.
  const lookup = (f.adapter as any).lookUpChannel(G, P);
  for (let tries = 1; tries <= 3; tries++) {
    await until(() => get.mock.callCount() === tries);
    dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: { ...parentData(ChannelType.GuildVoice), topic: 'edit ' + tries } });
    out();
  }
  await lookup;
  assert.equal(f.adapter.isStale(P), true);
  assert.equal(f.label(P), idOf(P));
  // P's name may be W's or not: no channel answers it while P is stale.
  assert.equal(f.label(W), idOf(W));
});

it("a thread's stale channel admits it through no category until it's fetched fresh, and a message in it looks the channel up", { timeout: 5000 }, async (t) => {
  const f = filtered(t);
  // X moved to C2 in Discord; an older reply left it in C1, stale.
  (f.adapter as any).stale.set(X, { guildId: G });
  assert.equal(f.adapter.channelAdmitted(G, TX, X), false, "its channel's category decides nothing while it's stale");
  const get = t.mock.method(f.client.rest, 'get', async (route: string) => (String(route).includes(X) ? inCategory(C2) : threadInX));
  f.client.actions.MessageCreate.handle({
    id: M, guild_id: G, channel_id: TX, type: MessageType.Default, content: `<@${BOT}> hi`, timestamp: new Date().toISOString(),
    author: { id: U, username: 'Bob', discriminator: '0', avatar: null }, mentions: [bot], mention_roles: [], attachments: [], embeds: [], flags: 0,
  });
  await until(() => get.mock.callCount() > 0 && !f.adapter.isStale(X));
  for (let i = 0; i < 10; i++) await new Promise((done) => setImmediate(done));
  assert.equal(f.adapter.isStale(X), false);
  assert.equal(f.pushes().length, 0, 'fetched fresh, its channel is outside the filters');
});

it("create_text_channel whose fetch afterwards finds the channel gone says so", async (t) => {
  const f = fixture(t);
  t.mock.method(f.client.rest, 'post', async () => channelData(X, ChannelType.GuildText, 'brief'));
  t.mock.method(f.client.rest, 'get', async () => { throw unknownChannel(); });
  await assert.rejects(f.adapter.createTextChannel(G, 'brief'), /no longer exists/);
  assert.equal(f.client.channels.cache.has(X), false);
});

it('a thread update for a registered thread the filters no longer admit forgets it', (t) => {
  const f = filtered(t);
  // X is outside the filters now in Discord, its thread still registered.
  f.client.channels.cache.get(X).parentId = C2;
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: { ...threadInX, name: 'renamed' } });
  assert.equal(f.label(TX), undefined);
});

it("a channel its server no longer lists holds no name there, so the server's names still resolve while it's stale", (t) => {
  const V = '100000000000000009';
  const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'lounge')] });
  // The guild comes back without V: a leftover, stale, in the client's cache only.
  f.comesBack();
  assert.ok(f.adapter.isStale(V));
  const before = f.adapter.resolveChannelRef('#before (Guild)');
  assert.equal(before.ok && before.id, P);
});

it("the filters admit no channel of a server the guild filter leaves out", (t) => {
  const f = fixture(t, { guildIds: ['100000000000000099'] });
  assert.equal(f.adapter.channelAdmitted(G, P, null), false);
  const g = fixture(t, { guildIds: [G] });
  assert.equal(g.adapter.channelAdmitted(G, P, null), true);
});

it("create_text_channel whose fetch afterwards fails relabels its server's channels by id", async (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), '#before (Guild)');
  t.mock.method(f.client.rest, 'post', async () => channelData(X, ChannelType.GuildText, 'fresh-name'));
  t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  await f.adapter.createTextChannel(G, 'fresh-name');
  assert.equal(f.adapter.isStale(X), true);
  assert.equal(f.label(P), idOf(P), "the new channel's name isn't known, so no name in the server resolves");
});

it("a batch of facts reads which servers' names are uncertain once, however many channels and stale marks there are", (t) => {
  const f = fixture(t, { channels: Array.from({ length: 30 }, (_, i) => channelData(String(200000000000000000n + BigInt(i)), ChannelType.GuildText, 'c' + i)) });
  for (let i = 0; i < 50; i++) (f.adapter as any).stale.set(String(300000000000000000n + BigInt(i)), { guildId: G });
  const scans = t.mock.method(f.adapter as any, 'uncertainGuildNames');
  const listed = f.adapter.getPostingChannels();
  assert.ok(listed.length >= 30);
  assert.equal(scans.mock.callCount(), 1);
  assert.ok(listed.every((c) => c.nameResolves === true), 'marks for channels the server no longer lists block no name');
});

it("a stale channel in a server whose name isn't known keeps names given without a server from resolving", (t) => {
  const Y = '100000000000000025';
  const G2 = '100000000000000027';
  const X2 = '100000000000000028';
  const f = fixture(t, { channels: [channelData(Y, ChannelType.GuildVoice, 'news')] });
  // discord.js's stub for a guild it knows only by id, with a channel a fetch put in its cache.
  const stub = f.client.guilds._add({ id: G2, unavailable: true });
  f.client.channels._add({ id: X2, guild_id: G2, type: ChannelType.GuildText, name: 'former', parent_id: null }, stub);
  (f.adapter as any).stale.set(X2, { guildId: G2 });
  assert.equal(f.adapter.resolveChannelRef('#news').ok, false, 'X2 may be news now');
  const qualified = f.adapter.resolveChannelRef('#news (Guild)');
  assert.equal(qualified.ok && qualified.id, Y, 'a name in a named server with nothing stale still resolves');
});

it("an update of a stale channel that changes only its topic gives its server's names back", (t) => {
  const f = fixture(t, { channels: [channelData(X, ChannelType.GuildText, 'news')] });
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), '#before (Guild)');
  (f.adapter as any).markStale(X, G);
  assert.equal(f.label(P), idOf(P));
  dispatch(f.client, 'CHANNEL_UPDATE', channelUpdate, { d: { ...channelData(X, ChannelType.GuildText, 'news'), topic: 'new topic' } });
  assert.equal(f.adapter.isStale(X), false);
  assert.equal(f.label(P), '#before (Guild)');
});

it("a thread update while its channel is stale leaves the thread registered, its admission unknown", (t) => {
  const f = filtered(t);
  // X's cached category may be older than Discord's: its filter answer isn't known.
  (f.adapter as any).stale.set(X, { guildId: G });
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: { ...threadInX, name: 'renamed' } });
  assert.notEqual(f.label(TX), undefined);
  assert.equal(f.removed(idOf(TX)), false);
});

it("a reaction or an edit in a thread whose channel is stale looks the channel up first", { timeout: 5000 }, async (t) => {
  for (const event of ['reaction', 'edit'] as const) {
    const f = filtered(t);
    (f.adapter as any).stale.set(X, { guildId: G });
    const get = t.mock.method(f.client.rest, 'get', async () => inCategory(C1));
    const channel = f.client.channels.cache.get(TX);
    if (event === 'reaction') {
      const message = { id: M, channelId: TX, guildId: G, channel, partial: false, author: { id: U, username: 'Bob' }, content: 'hi', cleanContent: 'hi' };
      f.client.emit('messageReactionAdd', { partial: false, emoji: { name: '👍', id: null }, message }, { id: U, username: 'Bob', partial: false });
    } else {
      f.server.subscribedChannels.add(TX);
      f.client.emit('messageUpdate', { partial: true }, {
        id: M, channelId: TX, guildId: G, partial: true, channel, content: 'edited', editedTimestamp: T + 2000, author: { id: U, username: 'Bob' },
      });
    }
    await until(() => get.mock.callCount() > 0 && !f.adapter.isStale(X));
    assert.equal(f.adapter.isStale(X), false, event);
    assert.match(String(get.mock.calls[0]?.arguments[0]), new RegExp(X), event);
  }
});

it("a create in a thread known only partly whose channel turns out stale looks the channel up too", { timeout: 5000 }, async (t) => {
  const f = fixture(t, { sparse: true });
  (f.adapter as any).stale.set(P, { guildId: G });
  const routes: string[] = [];
  t.mock.method(f.client.rest, 'get', async (route: string) => {
    routes.push(String(route));
    return String(route).includes(TH) ? threadAt(false, T) : parentData(ChannelType.GuildText);
  });
  f.gatewayCreate(T);
  await until(() => f.pushes().length > 0);
  assert.ok(routes.some((r) => r.includes(TH)) && routes.some((r) => r.includes(P)), routes.join(' '));
  assert.equal(f.adapter.isStale(P), false);
});

it("a message in a thread whose stale channel is fetched fresh in an admitted category is delivered", { timeout: 5000 }, async (t) => {
  const f = filtered(t);
  (f.adapter as any).stale.set(X, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => inCategory(C1));
  f.client.actions.MessageCreate.handle({
    id: M, guild_id: G, channel_id: TX, type: MessageType.Default, content: `<@${BOT}> hi`, timestamp: new Date().toISOString(),
    author: { id: U, username: 'Bob', discriminator: '0', avatar: null }, mentions: [bot], mention_roles: [], attachments: [], embeds: [], flags: 0,
  });
  await until(() => f.pushes().length > 0);
  assert.equal(f.pushes().length, 1);
});

it("a stale channel in a server the guild filter leaves out, or a stale thread, keeps no name from resolving", (t) => {
  const G2 = '100000000000000027';
  const X2 = '100000000000000028';
  const f = fixture(t, { guildIds: [G] });
  const other = f.client.guilds._add({ id: G2, name: 'Other', unavailable: false });
  f.client.channels._add({ id: X2, guild_id: G2, type: ChannelType.GuildText, name: 'former', parent_id: null }, other);
  (f.adapter as any).stale.set(X2, { guildId: G2 });
  (f.adapter as any).stale.set(TH, { guildId: G });
  const bare = f.adapter.resolveChannelRef('#before');
  assert.equal(bare.ok && bare.id, P);
});

it("a name qualified by a server resolves when a server known only by id holds a channel of that name", (t) => {
  const Y = '100000000000000025';
  const G2 = '100000000000000027';
  const X2 = '100000000000000028';
  const f = fixture(t, { channels: [channelData(Y, ChannelType.GuildText, 'news')] });
  const stub = f.client.guilds._add({ id: G2, unavailable: true });
  f.client.channels._add({ id: X2, guild_id: G2, type: ChannelType.GuildText, name: 'news', parent_id: null }, stub);
  const qualified = f.adapter.resolveChannelRef('#news (Guild)');
  assert.equal(qualified.ok && qualified.id, Y);
});

it("a fresh fetch of a registered thread while its channel is stale leaves the thread registered", async (t) => {
  const f = filtered(t);
  (f.adapter as any).stale.set(X, { guildId: G });
  (f.adapter as any).stale.set(TX, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => ({ ...threadInX, name: 'renamed' }));
  await f.adapter.getChannelMeta(TX);
  assert.equal(f.adapter.isStale(TX), false);
  assert.notEqual(f.label(TX), undefined);
  assert.equal(f.removed(idOf(TX)), false);
});

it("a delivery from a thread whose stale channel can't be looked up leaves that channel's cached name out of the thread's facts", { timeout: 5000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const registered of [true, false]) {
    const f = fixture(t);
    if (registered) f.server.registerGuildDelivery(G, TH);
    // Discord renamed P; an overtaken reply left an older name cached, stale.
    f.client.channels.cache.get(P).name = 'older';
    (f.adapter as any).stale.set(P, { guildId: G });
    t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
    f.gatewayCreate(T + 1000);
    await until(() => f.pushes().length > 0);
    assert.equal(f.pushes().length, 1, 'the message is delivered');
    const known = f.server.channelManager.get(threadMcplId);
    if (registered) {
      assert.equal(known?.label, '#before › topic (Guild)', 'the registered label stands');
      assert.equal((known?.metadata as { parentName?: string } | undefined)?.parentName, 'before');
    } else {
      assert.equal(known?.label, '› topic (Guild)', 'a new registration goes without the name');
      assert.equal((known?.metadata as { parentName?: string } | undefined)?.parentName, undefined);
    }
    assert.ok(!JSON.stringify(f.pushes()[0]?.params).includes('older'), 'the delivery names no older channel name');
  }
});

it("a server the guild filter leaves out registers nothing when it comes back from an outage", (t) => {
  // The same return, in a server the guild filter admits, registers its channel.
  const control = fixture(t, { guildIds: [G] });
  control.comesBack();
  assert.equal(control.label(P), '#before (Guild)');
  const f = fixture(t, { guildIds: ['100000000000000099'] });
  f.comesBack();
  assert.deepEqual(f.server.channelManager.getAll(), []);
  assert.equal(f.sent.some((x) => x.method === 'channels/changed'), false, 'and the host is told of nothing');
});

it("list_channels leaves out the channels the channel filter excludes, categories included", async (t) => {
  const Z = '100000000000000029';
  const f = fixture(t, { guildChannels: [C1, P], channels: [...categories, inCategory(C1), { ...channelData(Z, ChannelType.GuildText, 'elsewhere'), parent_id: C2 }] });
  const listed = await f.adapter.listChannels(G);
  assert.deepEqual(listed.map((c) => c.id).sort(), [P, C1, X].sort());
});

it("a cached stale channel has no known name", (t) => {
  const f = fixture(t);
  assert.equal(f.adapter.getCachedChannelFacts(P)?.name, 'before');

  (f.adapter as any).markStale(P, G);

  assert.equal(f.adapter.getCachedChannelFacts(P)?.name, null);
  assert.equal(f.adapter.getCachedChannelFacts(P)?.guildName, 'Guild');
});

it("an unregistered stale thread's provenance uses its composite id", (t) => {
  const f = fixture(t);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  assert.equal(f.server.channelProvenance(TH).channelLabel, '#before › topic (Guild)');

  (f.adapter as any).markStale(TH, G);

  assert.equal(f.server.channelProvenance(TH).channelLabel, threadMcplId);
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
});

it("a registered thread marked stale is labelled by its id", (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  assert.equal(f.label(TH), '#before › topic (Guild)');
  (f.adapter as any).markStale(TH, G);
  assert.equal(f.label(TH), threadMcplId);
});

/** Another server, `Other` unless named, holding a text channel named like P. */
const G2 = '100000000000000027';
const W2 = '100000000000000028';
const namesake = (name = 'Other') => ({
  id: G2, name, owner_id: BOT, roles: [], channels: [{ id: W2, guild_id: G2, type: ChannelType.GuildText, name: 'before', parent_id: null }],
});

it("a server back from an outage gives a channel in another server of its name its label back", (t) => {
  const Z = '100000000000000029';
  const f = fixture(t);
  f.client.guilds._add({ id: G2, name: 'Guild', owner_id: BOT, roles: [], channels: [{ id: Z, guild_id: G2, type: ChannelType.GuildText, name: 'zed', parent_id: null }] });
  const zLabel = () => f.server.channelManager.get(`discord:${G2}:${Z}`)?.label;
  f.server.registerGuildDelivery(G2, Z);
  assert.equal(zLabel(), '#zed (Guild)');
  // A stale channel in the other server called Guild: any name given with
  // that server's name may mean one of its channels.
  (f.adapter as any).markStale(P, G);
  assert.equal(zLabel(), `discord:${G2}:${Z}`);
  // Its server comes back listing P, which is current again.
  f.comesBack();
  assert.equal(f.adapter.isStale(P), false);
  assert.equal(zLabel(), '#zed (Guild)');
});

it("a tool's read of a stale thread that isn't registered registers nothing", async (t) => {
  const f = fixture(t);
  (f.adapter as any).stale.set(TH, { guildId: G });
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  assert.equal(await f.adapter.inspectionRefusal(TH), null);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(f.adapter.isStale(TH), false, 'fetched fresh');
  assert.equal(f.label(TH), undefined, 'a thread waits for a message');
  assert.equal(f.sent.some((x) => x.method === 'channels/changed'), false);
});

it("a DM channel the cache knows only partly is fetched before its recipient is read", async (t) => {
  const D = '100000000000000030';
  const f = fixture(t);
  f.client.channels._add({ id: D, type: ChannelType.DM });
  assert.equal(f.client.channels.cache.get(D)?.partial, true);
  const get = t.mock.method(f.client.rest, 'get', async () => ({
    id: D, type: ChannelType.DM, last_message_id: null, recipients: [{ id: U, username: 'Bob', discriminator: '0', avatar: null }],
  }));
  assert.deepEqual(await f.adapter.getDmChannelInfo(D), { recipientId: U, recipientName: 'Bob' });
  assert.equal(get.mock.callCount(), 1);
});

it("a server joined under a registered channel's server name labels that channel by its id, since the name means two channels then", (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), '#before (Guild)');
  // GUILD_CREATE reports a guild joined only once the client is ready.
  f.client.ws.status = Status.Ready;
  dispatch(f.client, 'GUILD_CREATE', guildCreate, {
    d: { ...namesake('Guild'), member_count: 1, members: [{ user: bot, roles: [] }], threads: [] },
  });
  assert.equal(f.server.channelManager.get(`discord:${G2}:${W2}`)?.label, `discord:${G2}:${W2}`, "the joined server's channel is registered by its id");
  assert.equal(f.label(P), idOf(P));
});

it("a server the bot leaves gives its name back, to a channel of the same name in a server of the same name", (t) => {
  const f = fixture(t);
  f.client.guilds._add(namesake('Guild'));
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), idOf(P), 'two servers called Guild hold a #before');
  f.client.actions.GuildDelete.handle({ id: G2 });
  assert.equal(f.label(P), '#before (Guild)');
});

it("a server renamed to a registered channel's server name labels that channel by its id", (t) => {
  const f = fixture(t);
  f.client.guilds._add(namesake());
  f.server.registerGuildDelivery(G, P);
  assert.equal(f.label(P), '#before (Guild)');
  f.client.actions.GuildUpdate.handle({ id: G2, name: 'Guild' });
  assert.equal(f.label(P), idOf(P));
});

it("a covered sync drops a thread patched outside its parent's thread cache", (t) => {
  const f = fixture(t, { sparse: true });
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(false, T) });
  assert.equal(f.client.channels.cache.get(P).threads.cache.has(TH), false);
  assert.equal(f.server.registerGuildDelivery(G, TH), threadMcplId);

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });

  assert.equal(f.client.channels.cache.has(TH), false);
  assert.equal(f.client.guilds.cache.get(G).channels.cache.has(TH), false);
  assert.equal(f.label(TH), undefined);
  assert.ok(f.removed(threadMcplId));
  assert.equal(f.server.deletedChannels.has(TH), false, 'a sync does not prove deletion');
});

it("a covered sync leaves an uncached registered thread in an uncovered channel", (t) => {
  const T2 = '100000000000000031';
  const f = fixture(t, { channels: [channelData(C1, ChannelType.GuildText, 'other')] });
  f.client.channels._add({ ...threadAt(false, T), id: T2, parent_id: C1 });
  f.server.registerGuildDelivery(G, T2);
  const before = f.server.channelManager.get(idOf(T2));
  assert.ok(before);
  (f.adapter as any).forgetCached(T2);
  assert.equal(f.client.channels.cache.has(T2), false);

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });

  assert.deepEqual(f.server.channelManager.get(idOf(T2)), before);
  assert.equal(f.removed(idOf(T2)), false);
});

it("a covered sync forgets an uncached registered thread in a covered channel", (t) => {
  const T2 = '100000000000000031';
  const f = fixture(t, { channels: [channelData(C1, ChannelType.GuildText, 'other')] });
  f.client.channels._add({ ...threadAt(false, T), id: T2, parent_id: C1 });
  f.server.registerGuildDelivery(G, T2);
  assert.equal(f.server.channelManager.get(idOf(T2))?.metadata.parentId, C1, 'its registration places it under C1');
  (f.adapter as any).forgetCached(T2);
  assert.equal(f.client.channels.cache.has(T2), false);

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [C1], threads: [], members: [] },
  });

  assert.equal(f.server.channelManager.get(idOf(T2)), undefined);
  assert.ok(f.removed(idOf(T2)));
  assert.equal(f.server.deletedChannels.has(T2), false, 'a sync does not prove deletion');
});

it("a whole-guild thread sync preserves text channels and other guilds' threads", (t) => {
  const foreignThread = '100000000000000032';
  const foreignId = 'discord:' + G2 + ':' + foreignThread;
  const f = fixture(t);
  f.client.guilds._add(namesake());
  f.client.channels._add({ ...threadAt(false, T), id: foreignThread, guild_id: G2, parent_id: W2 });
  f.server.registerGuildDelivery(G, P);
  f.server.registerGuildDelivery(G2, foreignThread);
  assert.ok(f.server.channelManager.get(foreignId));

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, threads: [], members: [] },
  });

  assert.equal(f.client.channels.cache.has(P), true);
  assert.equal(f.label(P), '#before (Guild)');
  assert.equal(f.removed(idOf(P)), false);
  assert.equal(f.client.channels.cache.has(TH), false, 'the whole-guild sync applied');
  assert.equal(f.client.channels.cache.has(foreignThread), true);
  assert.ok(f.server.channelManager.get(foreignId));
  assert.equal(f.removed(foreignId), false);
});

it("a sync clears the stale mark of a thread discord.js dropped", (t) => {
  const f = fixture(t);
  assert.equal(f.client.channels.cache.get(P).threads.cache.has(TH), true);
  (f.adapter as any).markStale(TH, G);
  assert.equal(f.adapter.isStale(TH), true);

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });

  assert.equal(f.client.channels.cache.has(TH), false);
  assert.equal(f.adapter.isStale(TH), false);
});

it("a sync covering channels leaves a thread whose channel isn't known, and a sync of the whole server drops it", (t) => {
  // Known only from a message: no channel, and in no channel's threads cache.
  const f = fixture(t, { sparse: true });
  assert.equal(f.client.channels.cache.get(TH).parentId, null);
  assert.equal(f.server.registerGuildDelivery(G, TH), threadMcplId);

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });
  assert.equal(f.client.channels.cache.has(TH), true, 'a sync of P can\'t tell it is P\'s');
  assert.ok(f.server.channelManager.get(threadMcplId));

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, threads: [], members: [] },
  });
  assert.equal(f.client.channels.cache.has(TH), false, "the adapter drops it: discord.js reaches only channels' threads caches");
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  assert.ok(f.removed(threadMcplId));
});

it("a sync forgets a thread it drops from the cache whose registration doesn't know its channel", async (t) => {
  const f = fixture(t, { sparse: true });
  assert.equal(f.server.registerGuildDelivery(G, TH), threadMcplId);
  assert.equal(f.server.channelManager.get(threadMcplId)?.metadata.parentId, undefined);
  // A tool's fetch teaches the cache the thread's channel, and puts it in P's
  // threads cache, without deriving the registration again.
  t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  await (f.adapter as any).refetchChannel(TH);
  assert.equal(f.client.channels.cache.get(P).threads.cache.has(TH), true);
  assert.equal(f.server.channelManager.get(threadMcplId)?.metadata.parentId, undefined);

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });
  assert.equal(f.client.channels.cache.has(TH), false, 'discord.js dropped it');
  assert.equal(f.server.channelManager.get(threadMcplId), undefined);
  assert.ok(f.removed(threadMcplId));
});

it("a covered sync leaves an archived thread it doesn't list, as discord.js does", (t) => {
  const f = fixture(t, { sparse: true });
  // Patched outside P's threads cache, so only the adapter could drop it.
  dispatch(f.client, 'THREAD_UPDATE', threadUpdate, { d: threadAt(true, T) });
  assert.equal(f.client.channels.cache.get(TH).archived, true);
  assert.equal(f.client.channels.cache.get(P).threads.cache.has(TH), false);

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });
  assert.equal(f.client.channels.cache.has(TH), true);
});

it("a sync's marks cleanup leaves another server's uncached channel stale", (t) => {
  const f = fixture(t);
  f.client.guilds._add(namesake());
  // A mark with nothing cached behind it, in another server.
  (f.adapter as any).forgetCached(W2);
  (f.adapter as any).stale.set(W2, { guildId: G2 });

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });
  assert.equal(f.adapter.isStale(W2), true);
});

it("a sync's marks cleanup leaves an uncached channel of the synced server stale", (t) => {
  const f = fixture(t, { channels: [channelData(C1, ChannelType.GuildText, 'other')] });
  // A mark with nothing cached behind it, in the server the sync is for.
  (f.adapter as any).forgetCached(C1);
  (f.adapter as any).stale.set(C1, { guildId: G });

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [P], threads: [], members: [] },
  });
  assert.equal(f.adapter.isStale(C1), true);
});

it("a sync that lists a registered thread the filters no longer admit forgets it, as an update would", (t) => {
  const f = filtered(t);
  // The filter stops admitting C1, and with it X and its thread; an edit of
  // the filters forgets nothing by itself.
  f.adapter.updateFilters({ guildChannels: { [G]: [P] } });
  assert.equal(f.adapter.channelAdmitted(G, TX, X), false);
  assert.ok(f.server.channelManager.get(idOf(TX)));

  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
    d: { guild_id: G, channel_ids: [X], threads: [threadInX], members: [] },
  });
  assert.equal(f.server.channelManager.get(idOf(TX)), undefined);
  assert.ok(f.removed(idOf(TX)));
  assert.equal(f.server.deletedChannels.has(TX), false);
});

it("queued syncs keep their scopes when a newer equal-list sync runs first", async (t) => {
  const f = fixture(t, { channels: [channelData(C1, ChannelType.GuildText, 'other')] });
  f.server.registerGuildDelivery(G, TH);
  const scopes: Array<string[] | null> = [];
  const reconcile = (f.adapter as any).threadsSyncedHandler;
  f.adapter.onThreadsSynced((guildId, covered, listed, dropped) => {
    scopes.push(covered === null ? null : [...covered]);
    reconcile(guildId, covered, listed, dropped);
  });
  const packet = (parentId: string) => ({
    t: 'THREAD_LIST_SYNC', d: { guild_id: G, channel_ids: [parentId], threads: [], members: [] },
  });
  assert.notEqual(f.client.ws.status, Status.Ready);
  for (const queued of [packet(P), packet(C1)]) {
    f.client.ws.emit(queued.t, queued.d);
    assert.equal(f.client.ws.handlePacket(queued, { id: 0 }), false);
  }
  assert.equal(scopes.length, 0);
  f.client.ws.status = Status.Ready;
  const newer = packet(C1);
  f.client.ws.emit(newer.t, newer.d);
  f.client.ws.handlePacket(newer, { id: 0 });
  assert.deepEqual(scopes, [[C1]]);
  assert.equal(f.client.channels.cache.has(TH), true);
  assert.equal(f.label(TH), '#before › topic (Guild)', "the newer sync did not cover this thread's channel");
  // A delivery can register the still-cached thread between applications.
  f.server.registerGuildDelivery(G, TH);
  await until(() => scopes.length === 3);
  assert.deepEqual(scopes, [[C1], [P], [C1]]);
  assert.equal(f.client.channels.cache.has(TH), false);
  assert.equal(f.label(TH), undefined);
});

it("thread sync scope survives nested actions and clears after completion or error", (t) => {
  const f = fixture(t, { channels: [channelData(C1, ChannelType.GuildText, 'other')] });
  const outer = { guild_id: G, channel_ids: [C1], threads: [], members: [] };
  const inner = { guild_id: G, channel_ids: [P], threads: [], members: [] };
  const scopes: string[][] = [];
  let nested = false;
  f.adapter.onThreadsSynced((_guildId, covered) => {
    assert.ok(covered);
    scopes.push([...covered]);
    if (!nested) {
      nested = true;
      f.client.actions.ThreadListSync.handle(inner);
      assert.equal((f.adapter as any).applyingThreadSync?.data, outer, 'the outer payload is restored');
    }
  });
  f.client.actions.ThreadListSync.handle(outer);
  assert.deepEqual(scopes, [[C1], [P]]);
  assert.equal((f.adapter as any).applyingThreadSync, undefined);

  const failure = new Error('sync listener failure');
  f.adapter.onThreadsSynced(() => { throw failure; });
  assert.throws(() => f.client.actions.ThreadListSync.handle(outer), failure);
  assert.equal((f.adapter as any).applyingThreadSync, undefined);
});

it("a sync that comes outside discord.js's action is logged, forgets nothing it omits, and takes what it lists as reported", (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  const logged = t.mock.method(console, 'error', () => {});
  // A discord.js that emitted the event itself, with no payload to read:
  // which channels the sync covers isn't known.
  assert.doesNotThrow(() => f.client.emit('threadListSync', new Map(), f.client.guilds.cache.get(G)));
  assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes("outside discord.js's ThreadListSync action")));
  assert.ok(f.server.channelManager.get(threadMcplId), 'the thread it omits stays registered');
  assert.equal(f.removed(threadMcplId), false);
  // A thread it lists is taken as reported: its stale mark clears.
  (f.adapter as any).markStale(TH, G);
  f.client.emit('threadListSync', new Map([[TH, f.client.channels.cache.get(TH)]]), f.client.guilds.cache.get(G));
  assert.equal(f.adapter.isStale(TH), false);
  assert.ok(f.server.channelManager.get(threadMcplId));
});

it("construction refuses a discord.js client without the thread sync action", async (t) => {
  const ActionsManager = require(resolve(discordJs, 'client/actions/ActionsManager.js'));
  const load = ActionsManager.prototype.load;
  let client: any;
  t.mock.method(ActionsManager.prototype, 'load', function (this: any, Action: { name: string }) {
    client = this.client;
    return Action.name === 'ThreadListSyncAction' ? undefined : load.call(this, Action);
  });
  let adapter: DiscordAdapter | undefined;
  try {
    assert.throws(() => {
      adapter = new DiscordAdapter({ token: 'unused' });
    }, /discord\.js actions\.ThreadListSync\.handle is missing/);
  } finally {
    await adapter?.disconnect();
    await client?.destroy();
  }
});

for (const covered of ['its channel', 'every channel'] as const) {
  it(`a sync of a server's threads that covers ${covered} forgets a registered thread it drops, and derives the ones it lists again`, (t) => {
    const T2 = '100000000000000031';
    const f = fixture(t);
    const second = { ...threadAt(false, T), id: T2, name: 'second' };
    f.client.channels._add(second);
    f.server.registerGuildDelivery(G, TH);
    f.server.registerGuildDelivery(G, T2);
    assert.equal(f.label(T2), '#before › second (Guild)');
    // An overtaken lookup left the other thread stale, labelled by its id.
    (f.adapter as any).markStale(T2, G);
    assert.equal(f.label(T2), idOf(T2));
    // Discord syncs P's threads when the bot can see P again: TH was
    // archived while it couldn't, and the other thread renamed.
    dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, {
      d: { guild_id: G, ...(covered === 'its channel' ? { channel_ids: [P] } : {}), threads: [{ ...second, name: 'renamed' }], members: [] },
    });
    assert.equal(f.client.channels.cache.has(TH), false, 'discord.js dropped the thread');
    assert.equal(f.label(TH), undefined);
    assert.ok(f.removed(threadMcplId), 'and the host is told');
    assert.equal(f.server.deletedChannels.has(TH), false, 'it may only have been archived');
    assert.equal(f.adapter.isStale(T2), false, 'the sync reports the other as Discord has it now');
    assert.equal(f.label(T2), '#before › renamed (Guild)');
  });
}

it("a thread lookup in flight when a sync of its server's threads drops the thread, answered Unknown Channel, handles the thread as deleted", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  watermarkFile(t);
  f.server.registerGuildDelivery(G, TH);
  f.server.forwardedWatermark.set(TH, '100');
  (f.adapter as any).stale.set(TH, { guildId: G });
  const { held, release } = holder(t);
  const get = t.mock.method(f.client.rest, 'get', async () => { await held; throw unknownChannel(); });
  f.gatewayCreate(T);
  await until(() => get.mock.callCount() === 1);
  assert.equal(get.mock.callCount(), 1, 'the lookup entered before the sync');
  dispatch(f.client, 'THREAD_LIST_SYNC', threadListSync, { d: { guild_id: G, channel_ids: [P], threads: [], members: [] } });
  assert.equal(f.client.channels.cache.has(TH), false, 'discord.js dropped the thread');
  assert.equal(f.label(TH), undefined);
  release();
  await until(() => f.pushes().length > 0);
  assert.equal(f.pushes().length, 1, 'the pending message was delivered');
  assert.equal(f.pushes()[0]?.params.origin.mcplChannelId, undefined);
  assert.ok(f.server.deletedChannels.has(TH), 'remembered as deleted');
  assert.equal(f.server.forwardedWatermark.has(TH), false, 'and its watermark dropped');
});

it("list_channels fetches no stale channel in another server", async (t) => {
  const f = fixture(t);
  f.client.guilds._add(namesake());
  (f.adapter as any).markStale(W2, G2);
  const get = t.mock.method(f.client.rest, 'get', async () => ({
    ...channelData(W2, ChannelType.GuildText, 'before'), guild_id: G2,
  }));

  const listed = await f.adapter.listChannels(G);

  assert.equal(get.mock.callCount(), 0);
  assert.ok(listed.some((channel) => channel.id === P));
  assert.equal(f.adapter.isStale(W2), true, "the other server's mark is unchanged");
  assert.equal(f.server.channelManager.get('discord:' + G2 + ':' + W2), undefined, 'no foreign refresh registered it');
});

it("list_channels fetches a stale channel first, and lists it as Discord has it now", async (t) => {
  const f = filtered(t);
  // Discord moved X out of the filters and renamed it; an older reply left
  // it in C1 with its older name, stale.
  f.client.channels.cache.get(X).name = 'news-older';
  (f.adapter as any).stale.set(X, { guildId: G });
  // And renamed P, which an older reply left with its older name.
  f.client.channels.cache.get(P).name = 'before-older';
  (f.adapter as any).stale.set(P, { guildId: G });
  const get = t.mock.method(f.client.rest, 'get', async (route: string) =>
    route.endsWith(X) ? { ...inCategory(C2), name: 'news-newer' } : { ...parentData(ChannelType.GuildText), name: 'after' });
  const listed = await f.adapter.listChannels(G);
  assert.equal(get.mock.callCount(), 2);
  assert.equal(f.adapter.isStale(X), false);
  assert.equal(f.adapter.isStale(P), false);
  assert.deepEqual(listed.map((c) => c.id).sort(), [P, C1].sort(), 'Discord has X outside the filters');
  assert.equal(listed.find((c) => c.id === P)?.name, 'after');
});

it("list_channels refuses a server whose outage begins while its stale channels are fetched", async (t) => {
  const f = fixture(t);
  (f.adapter as any).markStale(P, G);
  const { held, release } = holder(t);
  const get = t.mock.method(f.client.rest, 'get', async () => {
    await held;
    return parentData(ChannelType.GuildText);
  });
  const listing = f.adapter.listChannels(G);
  await until(() => get.mock.callCount() === 1);
  assert.equal(get.mock.callCount(), 1, "the stale channel's fetch is out");
  f.client.actions.GuildDelete.handle({ id: G, unavailable: true });
  assert.equal(f.client.guilds.cache.get(G).available, false);
  release();
  await assert.rejects(listing, /unavailable/);
});

it("list_channels leaves out a channel still stale when its fetch fails", async (t) => {
  const f = filtered(t);
  (f.adapter as any).stale.set(X, { guildId: G });
  t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  const listed = await f.adapter.listChannels(G);
  assert.equal(f.adapter.isStale(X), true);
  assert.deepEqual(listed.map((c) => c.id).sort(), [P, C1].sort());
});

it("a name-addressed send fetches no stale thread, and no channel its server's return left out, before it resolves", async (t) => {
  const V = '100000000000000009';
  const f = fixture(t, { channels: [channelData(V, ChannelType.GuildVoice, 'lounge')] });
  // The guild comes back with P and the thread: V is left out, stale.
  f.comesBack([threadData]);
  assert.ok(f.adapter.isStale(V));
  (f.adapter as any).stale.set(TH, { guildId: G });
  const get = t.mock.method(f.client.rest, 'get', async () => threadAt(false, T));
  const sent: string[] = [];
  f.adapter.sendMessage = (async (channelId: string) => { sent.push(channelId); return { messageId: '1' }; }) as any;
  await (f.server as any).handleToolCall('send_message', { channelId: '#before (Guild)', content: 'hi' });
  assert.equal(get.mock.callCount(), 0, 'neither holds a name');
  assert.deepEqual(sent, [P]);
});

it("a delivery from a stale channel or thread whose lookup fails leaves out the name the cache has for it", { timeout: 5000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const where of [X, TH]) {
    const f = fixture(t, { channels: [channelData(X, ChannelType.GuildText, 'news')] });
    // Discord renamed it; an overtaken reply left an older name cached, stale.
    f.client.channels.cache.get(where).name = 'older-name';
    (f.adapter as any).stale.set(where, { guildId: G });
    const get = t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
    f.client.actions.MessageCreate.handle({
      id: M, guild_id: G, channel_id: where, type: MessageType.Default, content: `<@${BOT}> hi`, timestamp: new Date(T).toISOString(),
      author: { id: U, username: 'Bob', discriminator: '0', avatar: null }, mentions: [bot], mention_roles: [], attachments: [], embeds: [], flags: 0,
    });
    await until(() => f.pushes().length > 0);
    assert.ok(get.mock.callCount() > 0, `${where}: it was looked up first`);
    assert.equal(f.pushes().length, 1, `${where}: the message is delivered`);
    assert.equal(f.adapter.isStale(where), true, where);
    assert.ok(!JSON.stringify(f.pushes()[0]?.params).includes('older-name'), where);
  }
});

it("the catch-up's block from a stale thread whose fetch fails leaves out the name the cache has for it", { timeout: 5000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(t);
  watermarkFile(t);
  f.server.subscribedChannels.add(TH);
  f.server.forwardedWatermark.set(TH, '100');
  // Discord renamed it; an overtaken reply left an older name cached, stale.
  f.client.channels.cache.get(TH).name = 'older-name';
  (f.adapter as any).stale.set(TH, { guildId: G });
  f.adapter.fetchHistory = async () => [{
    id: '200', content: 'later', cleanContent: 'later', authorId: U, authorName: 'Bob',
    timestamp: new Date(T + 1000), mentionsBot: false, attachments: [],
  }] as any;
  const get = t.mock.method(f.client.rest, 'get', async () => { throw new Error('Service Unavailable'); });
  await f.server.runReconnectSweep();
  assert.equal(get.mock.callCount(), 1, 'the sweep looked it up first');
  assert.equal(f.adapter.isStale(TH), true);
  assert.equal(f.pushes().length, 1, 'the block is delivered');
  assert.ok(!JSON.stringify(f.pushes()[0]?.params).includes('older-name'));
});
