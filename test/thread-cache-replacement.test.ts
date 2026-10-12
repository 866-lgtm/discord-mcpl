/**
 * A deletion in a thread the client knows only partly waits for the thread's
 * lookup. While that lookup is pending, discord.js can replace the thread's
 * cache entry: the guild is removed and joined again, which builds a new
 * thread object. The deletion is then named and filtered from what the cache
 * holds after the lookup, not from the object it held before.
 *
 * Found in review by Daphne, whose probe this test is built from. It drives
 * discord.js's own actions and gateway handler, with the REST reply held.
 */
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ChannelType, MessageType } from 'discord.js';
import { DiscordAdapter, type MessageEventInfo } from '../src/discord-adapter.js';

const require = createRequire(import.meta.url);
const discordJs = dirname(require.resolve('discord.js'));
const guildCreate = require(resolve(discordJs, 'client/websocket/handlers/GUILD_CREATE.js'));
const Status = require(resolve(discordJs, 'util/Status.js'));

const guildId = '100000000000000001';
const threadId = '100000000000000002';
const parentId = '100000000000000005';
const parent = { id: parentId, guild_id: guildId, type: ChannelType.GuildText, name: 'general', parent_id: null };
const fullThread = { id: threadId, guild_id: guildId, type: ChannelType.PublicThread, name: 'late-thread', parent_id: parentId };
const messageData = {
  id: '100000000000000004', guild_id: guildId, channel_id: threadId, type: MessageType.Default, content: 'hello',
  timestamp: new Date().toISOString(), author: { id: '100000000000000003', username: 'Bob', discriminator: '0', avatar: null },
  mentions: [], mention_roles: [], attachments: [], embeds: [], flags: 0,
};

for (const listed of [false, true]) {
  it(`names and filters a deletion by the thread the cache holds after its lookup (${listed ? "the thread's channel listed" : 'no channel list'})`, { timeout: 5000 }, async (t) => {
    const adapter = new DiscordAdapter({ token: 'unused', ...(listed ? { guildChannels: { [guildId]: [parentId] } } : {}) });
    const client = adapter.rawClient as any;
    t.after(() => client.destroy());
    client.ws.status = Status.Ready;
    client.guilds._add({ id: guildId, name: 'Guild', channels: [parent] });
    // A thread built, as from a message event, with its type only.
    const before = client.channels._add({ id: threadId, guild_id: guildId, type: ChannelType.PublicThread });
    const message = before.messages._add(messageData);
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    t.after(() => release());
    let lookups = 0;
    t.mock.method(client.rest, 'get', async () => { lookups++; await held; return fullThread; });
    const deletes: MessageEventInfo[] = [];
    adapter.onMessageDelete((_channelId, _messageId, _isDM, info) => { if (info) deletes.push(info); });

    client.actions.MessageDelete.handle({ id: message.id, channel_id: threadId, guild_id: guildId });
    assert.equal(lookups, 1, 'the deletion waits for its lookup');
    // While it waits, the guild is removed and joined again.
    client.actions.GuildDelete.handle({ id: guildId });
    guildCreate(client, { d: { id: guildId, name: 'Guild', channels: [parent], threads: [fullThread] } }, { id: 0 });
    assert.notEqual(client.channels.cache.get(threadId), before, 'the cache holds a new thread object');
    release();
    await Promise.allSettled([...(adapter as unknown as { messageEventDeliveries: Map<string, Promise<void>> }).messageEventDeliveries.values()]);

    assert.equal(deletes.length, 1, "the thread's channel admits the deletion");
    assert.equal(deletes[0].threadId, threadId);
    assert.equal(deletes[0].threadName, 'late-thread');
    assert.equal(deletes[0].threadParentName, 'general');
  });
}
