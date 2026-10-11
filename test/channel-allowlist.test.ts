/**
 * The per-guild channel whitelist (`guildChannels`) and threads. A thread
 * counts as its parent channel, so it is admitted whenever its channel is,
 * including when the channel is admitted only through a listed category, and
 * also when it's listed itself. Before, only one parent level was checked: a
 * thread's parent is its channel, so threads in a category-admitted channel
 * were dropped, and a category-admitted forum lost every post.
 *
 * A thread the client knows only partly (built from an event that carried
 * its type but not its channel, so its parentId is null) is fetched before
 * the filters decide, on creates, reactions, edits and deletes alike.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';

const G1 = '500000000000000001';
const G2 = '500000000000000002';
const CATEGORY = '510000000000000001';
const OTHER_CATEGORY = '510000000000000002';
const LISTED = '520000000000000001';
const IN_CATEGORY = '520000000000000002';
const FORUM_IN_CATEGORY = '520000000000000003';
const UNLISTED = '520000000000000004';
const UNCACHED_CHANNEL = '520000000000000005';
const THREAD_OF_LISTED = '530000000000000001';
const THREAD_IN_CATEGORY = '530000000000000002';
const FORUM_POST = '530000000000000003';
const THREAD_OF_UNLISTED = '530000000000000004';
const THREAD_OF_UNCACHED = '530000000000000005';
const LISTED_THREAD = '530000000000000006';
const PARTLY_KNOWN_THREAD = '540000000000000001';
const PARTLY_KNOWN_UNLISTED = '540000000000000002';

/** Each channel's own parent: a category for a channel, the channel for a thread. */
const PARENT: Record<string, string | null> = {
  [CATEGORY]: null,
  [OTHER_CATEGORY]: null,
  [LISTED]: OTHER_CATEGORY,
  [IN_CATEGORY]: CATEGORY,
  [FORUM_IN_CATEGORY]: CATEGORY,
  [UNLISTED]: OTHER_CATEGORY,
  [THREAD_OF_LISTED]: LISTED,
  [THREAD_IN_CATEGORY]: IN_CATEGORY,
  [FORUM_POST]: FORUM_IN_CATEGORY,
  [THREAD_OF_UNLISTED]: UNLISTED,
  [THREAD_OF_UNCACHED]: UNCACHED_CHANNEL,
  [LISTED_THREAD]: UNLISTED,
};

/** The channel a partly known thread turns out to be in, once fetched. */
const FETCHED_PARENT: Record<string, string> = {
  [PARTLY_KNOWN_THREAD]: IN_CATEGORY,
  [PARTLY_KNOWN_UNLISTED]: UNLISTED,
};

type FixtureChannel = { id: string; guildId: string; parentId: string | null; isThread(): boolean };

function fixture(t: { after: (fn: () => void) => void }, fetchFails = false) {
  const adapter = new DiscordAdapter({ token: 'unused', guildChannels: { [G1]: [LISTED, CATEGORY, LISTED_THREAD] } });
  const internals = adapter as unknown as {
    client: Client;
    channelAllowed(guildId: string | null, channelId: string, parentId?: string | null): boolean;
    messageFilterReason(message: unknown): string | null;
    convertMessage(message: unknown): unknown;
    messageEventInfo(message: unknown): Promise<unknown>;
    handleReactionEvent(action: 'add' | 'remove', reaction: unknown, user: unknown): Promise<void>;
    threadLookups: Map<string, Promise<void>>;
    messageEventDeliveries: Map<string, Promise<void>>;
  };
  t.after(() => internals.client.destroy());
  // The guild's channels as the GUILDS intent caches them; UNCACHED_CHANNEL
  // is deliberately missing. The partly known threads are cached as
  // discord.js caches a thread built from a message event: a thread type,
  // and a null parentId.
  const cache = internals.client.channels.cache as unknown as Map<string, FixtureChannel>;
  const isThread = (id: string) => id.startsWith('53') || id.startsWith('54');
  for (const [id, parentId] of Object.entries(PARENT)) {
    cache.set(id, { id, guildId: G1, parentId, isThread: () => isThread(id) });
  }
  for (const id of Object.keys(FETCHED_PARENT)) {
    cache.set(id, { id, guildId: G1, parentId: null, isThread: () => true });
  }
  // As discord.js's fetch with force: ask Discord, and patch the cached
  // channel with the parent it reports.
  const fetches: Array<{ id: string; force?: boolean }> = [];
  (internals.client.channels as unknown as { fetch: unknown }).fetch = async (id: string, opts?: { force?: boolean }) => {
    fetches.push({ id, force: opts?.force });
    await new Promise((resolve) => setImmediate(resolve));
    if (fetchFails) throw new Error('Unknown Channel');
    const channel = cache.get(id);
    if (channel && FETCHED_PARENT[id]) channel.parentId = FETCHED_PARENT[id];
    return channel ?? null;
  };
  const allowed = (id: string) => internals.channelAllowed(G1, id, PARENT[id] ?? null);
  /** A message as discord.js makes one: its channel is read from the cache. */
  const message = (channelId: string, id = '600000000000000001') => ({
    id,
    author: { id: '610000000000000001', bot: false },
    guildId: G1,
    channelId,
    type: 0,
    partial: false,
    content: 'hello',
    attachments: new Map(),
    mentions: { users: new Map() },
    get channel() { return cache.get(channelId); },
  });
  const delivered: string[] = [];
  adapter.onMessage((m) => delivered.push((m as unknown as { id: string }).id));
  internals.convertMessage = (m) => ({ id: (m as { id: string }).id });
  const emit = (m: unknown) => internals.client.emit('messageCreate', m as never);
  /** Wait until every create waiting on a thread lookup, and every edit or
   *  delete being placed, has been decided. */
  const settle = async () => {
    for (;;) {
      const pending = [...internals.threadLookups.values(), ...internals.messageEventDeliveries.values()];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { adapter, internals, allowed, message, delivered, emit, fetches, settle };
}

describe('guildChannels admits threads with their channel, through a category too', () => {
  it('admits listed channels, channels under a listed category, and their threads', (t) => {
    const { allowed } = fixture(t);
    for (const id of [LISTED, IN_CATEGORY, FORUM_IN_CATEGORY, THREAD_OF_LISTED, THREAD_IN_CATEGORY, FORUM_POST]) {
      assert.equal(allowed(id), true, `${id} is admitted`);
    }
  });

  it('still excludes unlisted channels and their threads, and a thread whose channel it cannot see', (t) => {
    const { allowed } = fixture(t);
    for (const id of [UNLISTED, THREAD_OF_UNLISTED, OTHER_CATEGORY, THREAD_OF_UNCACHED]) {
      assert.equal(allowed(id), false, `${id} is excluded`);
    }
  });

  it('admits a thread listed itself, though its channel is not', (t) => {
    const { allowed } = fixture(t);
    assert.equal(allowed(LISTED_THREAD), true);
    assert.equal(allowed(UNLISTED), false);
  });

  it('leaves a guild without an entry unrestricted', (t) => {
    const { internals } = fixture(t);
    assert.equal(internals.channelAllowed(G2, '590000000000000001', '590000000000000002'), true);
  });

  it('delivers a post in a forum admitted only through its category, at ingress', (t) => {
    const { internals } = fixture(t);
    const message = (channelId: string) => ({
      id: '600000000000000001',
      author: { id: '610000000000000001' },
      guildId: G1,
      channelId,
      channel: { id: channelId, parentId: PARENT[channelId] },
    });
    assert.equal(internals.messageFilterReason(message(FORUM_POST)), null);
    assert.equal(internals.messageFilterReason(message(THREAD_IN_CATEGORY)), null);
    assert.equal(internals.messageFilterReason(message(THREAD_OF_UNLISTED)), 'channel-not-allowed');
  });
});

describe('a thread the client knows only partly is fetched before the filters decide', () => {
  it('delivers creates in it after one forced fetch, in order, and later ones at once', async (t) => {
    const { message, delivered, emit, fetches, settle } = fixture(t);
    emit(message(PARTLY_KNOWN_THREAD, 'm1'));
    emit(message(PARTLY_KNOWN_THREAD, 'm2'));
    assert.deepEqual(delivered, [], 'they wait for the fetch');
    await settle();
    assert.deepEqual(delivered, ['m1', 'm2']);
    assert.deepEqual(fetches, [{ id: PARTLY_KNOWN_THREAD, force: true }]);
    emit(message(PARTLY_KNOWN_THREAD, 'm3'));
    assert.deepEqual(delivered, ['m1', 'm2', 'm3'], 'once known, a create is delivered at once');
    assert.equal(fetches.length, 1);
  });

  it("still drops creates in one whose channel isn't admitted, and in one it can't fetch", async (t) => {
    const unlisted = fixture(t);
    unlisted.emit(unlisted.message(PARTLY_KNOWN_UNLISTED));
    await unlisted.settle();
    assert.deepEqual(unlisted.delivered, []);
    assert.equal(unlisted.fetches.length, 1);
    const failing = fixture(t, true);
    failing.emit(failing.message(PARTLY_KNOWN_THREAD));
    await failing.settle();
    assert.deepEqual(failing.delivered, [], 'its channel stays unknown, so it is excluded');
  });

  it('decides edits and deletes in it after fetching it, and in a category-admitted thread without fetching', async (t) => {
    const { internals, message, fetches } = fixture(t);
    assert.notEqual(await internals.messageEventInfo(message(PARTLY_KNOWN_THREAD)), null);
    assert.deepEqual(fetches, [{ id: PARTLY_KNOWN_THREAD, force: true }]);
    assert.equal(await internals.messageEventInfo(message(PARTLY_KNOWN_UNLISTED)), null);
    assert.notEqual(await internals.messageEventInfo(message(THREAD_IN_CATEGORY)), null);
    assert.notEqual(await internals.messageEventInfo(message(FORUM_POST)), null);
    assert.equal(await internals.messageEventInfo(message(THREAD_OF_UNLISTED)), null);
    assert.equal(fetches.length, 2, 'a cached thread with a known channel needs no fetch');
  });

  it('forwards a delete in a category-admitted thread to the handler', async (t) => {
    const { adapter, internals, message, settle } = fixture(t);
    const deleted: string[] = [];
    adapter.onMessageDelete((channelId) => deleted.push(channelId));
    for (const id of [THREAD_IN_CATEGORY, PARTLY_KNOWN_THREAD, THREAD_OF_UNLISTED]) {
      internals.client.emit('messageDelete', message(id) as never);
    }
    await settle();
    assert.deepEqual(deleted.sort(), [PARTLY_KNOWN_THREAD, THREAD_IN_CATEGORY].sort());
  });

  it('passes reactions in a category-admitted thread, and in a partly known one after fetching it', async (t) => {
    const { adapter, internals, message, fetches } = fixture(t);
    const reacted: string[] = [];
    adapter.onReaction((ev) => reacted.push(ev.channelId));
    const reaction = (channelId: string) => ({
      partial: false,
      emoji: { id: null, name: '👍', animated: false },
      message: message(channelId),
    });
    const user = { id: '620000000000000001', partial: false, username: 'someone' };
    for (const id of [THREAD_IN_CATEGORY, PARTLY_KNOWN_THREAD, THREAD_OF_UNLISTED, PARTLY_KNOWN_UNLISTED]) {
      await internals.handleReactionEvent('add', reaction(id), user);
    }
    assert.deepEqual(reacted, [THREAD_IN_CATEGORY, PARTLY_KNOWN_THREAD]);
    assert.deepEqual(fetches.map((f) => f.id), [PARTLY_KNOWN_THREAD, PARTLY_KNOWN_UNLISTED]);
  });
});
