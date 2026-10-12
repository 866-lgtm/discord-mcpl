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
} = {}) {
  const adapter = new DiscordAdapter({ token: 'unused', ...(opts.guildChannels ? { guildChannels: { [G]: opts.guildChannels } } : {}) });
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

it("a re-derivation keeps what's registered of a stale channel", (t) => {
  const f = fixture(t);
  f.server.registerGuildDelivery(G, TH);
  assert.equal(f.label(TH), '#before › topic (Guild)');
  // Its cached facts fall behind what's registered, as a lookup every
  // report overtook can leave them.
  (f.adapter as any).stale.set(TH, { guildId: G });
  f.thread.name = 'older';
  f.server.rederiveChannels(f.server.registeredInGuild(G));
  assert.equal(f.label(TH), '#before › topic (Guild)');
});

it('create_text_channel labels the channel it creates as listing does, by its id when another channel of its name and kind holds the name', async (t) => {
  const f = fixture(t);
  t.mock.method(f.client.rest, 'post', async () => channelData(X, ChannelType.GuildText, 'before'));
  const created = await f.adapter.createTextChannel(G, 'before');
  assert.equal(created.label, idOf(X));
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
