/**
 * An event in a thread the client knows only partly waits for the thread's
 * lookup. While that lookup is pending, discord.js can replace the thread's
 * cache entry: the guild is removed and joined again, which builds a new
 * thread object. Each lane, the create, the deletion and the reaction, then
 * names and filters its event by what the cache holds after the lookup, not
 * by the object it held before.
 *
 * Found in review by Daphne, whose probe this test is built from. It drives
 * discord.js's own actions and gateway handler, with the REST reply held.
 * The create and reaction lanes read `message.channel`, a getter that
 * resolves the cache each time; the deletion lane holds the channel across
 * its lookup and reads the cache again after it.
 */
import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ChannelType, MessageType } from 'discord.js';
import { DiscordAdapter, type DiscordMessageData, type MessageEventInfo, type ReactionEvent, type ThreadPlace } from '../src/discord-adapter.js';

const require = createRequire(import.meta.url);
const discordJs = dirname(require.resolve('discord.js'));
const guildCreate = require(resolve(discordJs, 'client/websocket/handlers/GUILD_CREATE.js'));
const Status = require(resolve(discordJs, 'util/Status.js'));

const guildId = '100000000000000001';
const threadId = '100000000000000002';
const parentId = '100000000000000005';
const author = { id: '100000000000000003', username: 'Bob', discriminator: '0', avatar: null };
const parent = { id: parentId, guild_id: guildId, type: ChannelType.GuildText, name: 'general', parent_id: null };
const fullThread = { id: threadId, guild_id: guildId, type: ChannelType.PublicThread, name: 'late-thread', parent_id: parentId };
const messageData = {
  id: '100000000000000004', guild_id: guildId, channel_id: threadId, type: MessageType.Default, content: 'hello',
  timestamp: new Date().toISOString(), author,
  mentions: [], mention_roles: [], attachments: [], embeds: [], flags: 0,
};

/** Where the guild's channel list admits the thread from: no list, the
 *  thread's parent channel, or the thread's own id. */
const admissions = [
  { name: 'no channel list', guildChannels: undefined },
  { name: 'admitted through its parent channel', guildChannels: { [guildId]: [parentId] } },
  { name: 'admitted by its own listing', guildChannels: { [guildId]: [threadId] } },
];

/** An adapter on a client that hasn't logged in, with the guild and the
 *  thread's parent cached and the thread lookup's REST reply held until
 *  `release`. `replaceGuild` removes the guild and joins it again while the
 *  lookup waits, which leaves a new thread object in the cache. */
function setUp(t: TestContext, guildChannels: Record<string, string[]> | undefined) {
  const adapter = new DiscordAdapter({ token: 'unused', ...(guildChannels ? { guildChannels } : {}) });
  const client = adapter.rawClient as any;
  t.after(() => client.destroy());
  client.ws.status = Status.Ready;
  // The bot's own user, as READY would set it: discord.js's reaction action
  // reads its id.
  client.user = { id: '100000000000000099' };
  client.guilds._add({ id: guildId, name: 'Guild', channels: [parent] });
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  const lookups = { count: 0 };
  t.mock.method(client.rest, 'get', async () => { lookups.count++; await held; return fullThread; });
  const replaceGuild = (before: unknown): void => {
    client.actions.GuildDelete.handle({ id: guildId });
    guildCreate(client, { d: { id: guildId, name: 'Guild', channels: [parent], threads: [fullThread] } }, { id: 0 });
    assert.notEqual(client.channels.cache.get(threadId), before, 'the cache holds a new thread object');
  };
  const internals = adapter as unknown as {
    threadLookups: Map<string, Promise<void>>;
    messageEventDeliveries: Map<string, Promise<void>>;
  };
  return { adapter, client, lookups, release, replaceGuild, internals };
}

function assertNamed(place: ThreadPlace): void {
  assert.equal(place.threadId, threadId);
  assert.equal(place.threadName, 'late-thread');
  assert.equal(place.threadParentName, 'general');
}

for (const { name, guildChannels } of admissions) {
  it(`names and filters a create by the thread the cache holds after its lookup (${name})`, { timeout: 5000 }, async (t) => {
    const { adapter, client, lookups, release, replaceGuild, internals } = setUp(t, guildChannels);
    const created: DiscordMessageData[] = [];
    adapter.onMessage((msg) => created.push(msg));

    // The message event carries the thread's type alone, so discord.js
    // builds a thread with no parent.
    client.actions.MessageCreate.handle({ ...messageData, channel_type: ChannelType.PublicThread });
    const before = client.channels.cache.get(threadId);
    assert.equal(before?.parentId, null, 'the create built a partly known thread');
    assert.equal(lookups.count, 1, 'the create waits for its lookup');
    replaceGuild(before);
    release();
    await Promise.allSettled([...internals.threadLookups.values()]);

    assert.equal(created.length, 1, 'the create is admitted');
    assertNamed(created[0]);
  });

  it(`names and filters a deletion by the thread the cache holds after its lookup (${name})`, { timeout: 5000 }, async (t) => {
    const { adapter, client, lookups, release, replaceGuild, internals } = setUp(t, guildChannels);
    const deletes: MessageEventInfo[] = [];
    adapter.onMessageDelete((_channelId, _messageId, _isDM, info) => { if (info) deletes.push(info); });
    // A thread built, as from a message event, with its type only.
    const before = client.channels._add({ id: threadId, guild_id: guildId, type: ChannelType.PublicThread });
    const message = before.messages._add(messageData);

    client.actions.MessageDelete.handle({ id: message.id, channel_id: threadId, guild_id: guildId });
    assert.equal(lookups.count, 1, 'the deletion waits for its lookup');
    replaceGuild(before);
    release();
    await Promise.allSettled([...internals.messageEventDeliveries.values()]);

    assert.equal(deletes.length, 1, 'the deletion is admitted');
    assertNamed(deletes[0]);
  });

  it(`names and filters a reaction by the thread the cache holds after its lookup (${name})`, { timeout: 5000 }, async (t) => {
    const { adapter, client, lookups, release, replaceGuild } = setUp(t, guildChannels);
    let delivered!: (ev: ReactionEvent) => void;
    const reaction = new Promise<ReactionEvent>((done) => { delivered = done; });
    adapter.onReaction((ev) => delivered(ev));
    const before = client.channels._add({ id: threadId, guild_id: guildId, type: ChannelType.PublicThread });
    const message = before.messages._add(messageData);

    client.actions.MessageReactionAdd.handle({
      user_id: author.id, message_id: message.id, channel_id: threadId, guild_id: guildId,
      emoji: { name: '👍', id: null }, member: { user: author, roles: [] },
    });
    // The handler's lookup starts once the reaction has resolved itself.
    while (lookups.count === 0) await new Promise((r) => setImmediate(r));
    assert.equal(lookups.count, 1, 'the reaction waits for its lookup');
    replaceGuild(before);
    release();

    const ev = await reaction;
    assert.equal(ev.messageId, message.id);
    assertNamed(ev);
  });
}
