/**
 * A message's thread fields name the thread it was posted IN (Discord threads
 * are channels, so threadId equals channelId), never the thread it started:
 * discord.js `message.thread` is "the thread started by this message", a
 * different conversation. The channel a thread hangs off is read from the
 * client's channel cache by parentId, as the channel filters read it.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType, Collection, MessageType, type Client } from 'discord.js';
import { DiscordAdapter, type DiscordMessageData, type MessageEventInfo } from '../src/discord-adapter.js';

type Cached = {
  id: string; name?: string; type?: number; parentId?: string | null; isThread?: () => boolean;
  guildId?: string | null; guild?: { name?: string }; isDMBased?: () => boolean;
};

function fixture(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const internals = adapter as unknown as {
    client: Client;
    threadLookups: Map<string, Promise<void>>;
    messageEventDeliveries: Map<string, Promise<void>>;
  };
  const client = internals.client;
  t.after(() => client.destroy());
  const cache = client.channels.cache as unknown as Map<string, Cached>;
  // The guild's channels as the GUILDS intent caches them.
  cache.set('chan-1', { id: 'chan-1', name: 'general', type: ChannelType.GuildText, parentId: 'category-1', isThread: () => false });
  cache.set('category-1', { id: 'category-1', name: 'Text Channels', type: ChannelType.GuildCategory, parentId: null, isThread: () => false });
  cache.set('forum-1', { id: 'forum-1', name: 'help', type: ChannelType.GuildForum, parentId: null, isThread: () => false });
  const delivered: DiscordMessageData[] = [];
  adapter.onMessage((message) => delivered.push(message));
  const edits: MessageEventInfo[] = [];
  const deletes: MessageEventInfo[] = [];
  adapter.onMessageEdit((_channelId, _messageId, _content, _isDM, info) => { if (info) edits.push(info); });
  adapter.onMessageDelete((_channelId, _messageId, _isDM, info) => { if (info) deletes.push(info); });
  function message(extra: Record<string, unknown>) {
    return {
      id: 'message-1', guildId: 'g1', guild: { name: 'Test Server' },
      author: { id: 'u1', username: 'bob', bot: false },
      content: 'hello', cleanContent: 'hello', type: MessageType.Default,
      attachments: new Collection(), createdAt: new Date(),
      mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
      thread: null,
      ...extra,
    };
  }
  const emit = (event: string, ...args: unknown[]) => (client.emit as (event: string, ...args: unknown[]) => boolean)(event, ...args);
  /** Wait until every create waiting on a thread lookup, and every edit or
   *  delete being placed, has been decided. */
  async function settle() {
    for (;;) {
      const pending = [...internals.threadLookups.values(), ...internals.messageEventDeliveries.values()];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { adapter, client, cache, delivered, edits, deletes, message, emit, settle };
}

const thread = (extra: Partial<Cached> = {}): Cached => ({
  id: 'thread-1', name: 'design-chat', type: ChannelType.PublicThread, parentId: 'chan-1', isThread: () => true, ...extra,
});

describe('thread fields', () => {
  it('name the thread a message was posted in, and the channel it hangs off', (t) => {
    const f = fixture(t);
    f.emit('messageCreate', f.message({ channelId: 'thread-1', channel: thread() }));
    assert.equal(f.delivered.length, 1);
    const m = f.delivered[0];
    assert.equal(m.channelId, 'thread-1');
    assert.equal(m.threadId, 'thread-1');
    assert.equal(m.threadName, 'design-chat');
    assert.equal(m.threadParentName, 'general');
  });

  it('stay empty for a channel message that started a thread', (t) => {
    const f = fixture(t);
    f.emit('messageCreate', f.message({
      channelId: 'chan-1',
      channel: f.cache.get('chan-1'),
      thread: { id: 'spawned-1', name: 'spawned discussion' },
    }));
    const m = f.delivered[0];
    assert.equal(m.channelId, 'chan-1');
    assert.equal(m.threadId, undefined, 'the started thread is not where this message was posted');
    assert.equal(m.threadName, undefined);
    assert.equal(m.threadParentName, undefined);
  });

  it('stay empty for a text channel under a category, which has a parent but is no thread', (t) => {
    const f = fixture(t);
    // chan-1's parentId is its category; only isThread() makes a thread.
    f.emit('messageCreate', f.message({ channelId: 'chan-1', channel: f.cache.get('chan-1') }));
    const m = f.delivered[0];
    assert.equal(m.channelName, 'general');
    assert.equal(m.threadId, undefined);
    assert.equal(m.threadName, undefined);
    assert.equal(m.threadParentName, undefined);
  });

  it('stay empty for a DM', (t) => {
    const f = fixture(t);
    f.emit('messageCreate', f.message({ channelId: 'dm-1', guildId: null, guild: null, channel: { isThread: () => false } }));
    assert.equal(f.delivered[0].threadId, undefined);
  });

  it("name no parent when the thread's channel isn't known", (t) => {
    const f = fixture(t);
    f.emit('messageCreate', f.message({ channelId: 'thread-1', channel: thread({ parentId: 'chan-uncached' }) }));
    const m = f.delivered[0];
    assert.equal(m.threadId, 'thread-1');
    assert.equal(m.threadName, 'design-chat');
    assert.equal(m.threadParentName, null);
  });

  it('leave the name out when the thread has none', (t) => {
    const f = fixture(t);
    f.emit('messageCreate', f.message({ channelId: 'thread-1', channel: thread({ name: undefined }) }));
    const m = f.delivered[0];
    assert.equal(m.threadId, 'thread-1');
    assert.equal('threadName' in m, false);
    assert.equal(m.threadParentName, 'general');
  });

  it("name a forum post's first message as posted in its post", (t) => {
    const f = fixture(t);
    // A forum post is a thread in the forum, and its first message has the
    // post's own id: it is in the thread, not a message that started one.
    f.emit('messageCreate', f.message({
      id: 'post-1',
      channelId: 'post-1',
      channel: thread({ id: 'post-1', name: 'how do I deploy?', parentId: 'forum-1' }),
    }));
    const m = f.delivered[0];
    assert.equal(m.threadId, 'post-1');
    assert.equal(m.threadName, 'how do I deploy?');
    assert.equal(m.threadParentName, 'help');
  });

  it('read the parent from the channel cache, so a thread without its guild keeps its message', (t) => {
    const f = fixture(t);
    // discord.js's ThreadChannel.parent goes through the thread's guild, and
    // throws when it has none.
    const guildless = {
      ...thread(),
      get parent(): never {
        throw new TypeError("Cannot read properties of null (reading 'channels')");
      },
    };
    f.emit('messageCreate', f.message({ channelId: 'thread-1', channel: guildless }));
    assert.equal(f.delivered.length, 1, 'the message is delivered');
    assert.equal(f.delivered[0].threadParentName, 'general');
  });

  it('name a thread the client knew only partly, once it has been looked up', async (t) => {
    const f = fixture(t);
    // As discord.js builds a thread from a message event: its type, but not
    // its name or its channel.
    const partly: Cached = { id: 'thread-2', type: ChannelType.PublicThread, parentId: null, isThread: () => true };
    f.cache.set('thread-2', partly);
    // As discord.js's fetch with force: ask Discord, and patch the cached thread.
    (f.client.channels as unknown as { fetch: unknown }).fetch = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(partly, { name: 'late-thread', parentId: 'chan-1' });
      return partly;
    };
    f.emit('messageCreate', f.message({ channelId: 'thread-2', channel: partly }));
    assert.equal(f.delivered.length, 0, 'it waits for the lookup');
    await f.settle();
    const m = f.delivered[0];
    assert.equal(m.threadId, 'thread-2');
    assert.equal(m.threadName, 'late-thread');
    assert.equal(m.threadParentName, 'general');
  });

  it('come with an edit and a delete of a message in a thread', async (t) => {
    const f = fixture(t);
    const posted = f.message({ channelId: 'thread-1', channel: thread() });
    f.emit('messageUpdate', { ...posted, partial: false, content: 'hello' }, { ...posted, content: 'hello again', cleanContent: 'hello again', editedTimestamp: Date.now() });
    f.emit('messageDelete', posted);
    await f.settle();
    for (const [what, infos] of [['edit', f.edits], ['delete', f.deletes]] as const) {
      assert.equal(infos.length, 1, `the ${what} is forwarded`);
      assert.equal(infos[0].threadId, 'thread-1', what);
      assert.equal(infos[0].threadName, 'design-chat', what);
      assert.equal(infos[0].threadParentName, 'general', what);
    }
    const plain = f.message({ id: 'message-2', channelId: 'chan-1', channel: f.cache.get('chan-1') });
    f.emit('messageDelete', plain);
    await f.settle();
    assert.equal(f.deletes[1].threadId, undefined, 'a channel message has none');
  });

  it("come with a channel's lookup, from the cache or from Discord, which the reconnect sweep names it by", async (t) => {
    const f = fixture(t);
    f.cache.set('thread-1', thread({ guildId: 'g1', guild: { name: 'Test Server' }, isDMBased: () => false }));
    const expected = {
      name: 'design-chat', guildId: 'g1', guildName: 'Test Server', isDM: false,
      threadId: 'thread-1', threadName: 'design-chat', threadParentName: 'general',
    };
    assert.deepEqual(f.adapter.getCachedChannelMeta('thread-1'), expected, 'from the cache');
    t.mock.method(f.client.channels, 'fetch', async () => f.cache.get('thread-1'));
    assert.deepEqual(await f.adapter.getChannelMeta('thread-1'), expected, 'from Discord');
    const channel = f.adapter.getCachedChannelMeta('chan-1');
    assert.ok(channel, 'the channel is cached');
    assert.equal('threadId' in channel, false, 'a channel is no thread');
  });
});
