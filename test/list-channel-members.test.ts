/**
 * Adapter-level tests for listChannelMembers: filter enforcement, the
 * timeout-guarded member-cache warm, thread joined-vs-view semantics with
 * bulk (cache) resolution, and truncation — against adapter-like fixtures,
 * no Discord connection.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { DiscordAdapter } from '../src/discord-adapter.js';

// ── Fixtures ──

function member(id: string, displayName: string, opts: { bot?: boolean } = {}) {
  return { id, displayName, user: { username: displayName.toLowerCase(), bot: opts.bot ?? false } };
}

interface FakeGuild {
  id: string;
  name: string;
  members: {
    fetch: () => Promise<unknown>;
    cache: Map<string, ReturnType<typeof member>>;
  };
}

function fakeGuild(members: ReturnType<typeof member>[], opts: {
  fetchImpl?: () => Promise<unknown>;
} = {}): FakeGuild {
  const cache = new Map(members.map((m) => [m.id, m]));
  return {
    id: 'g1',
    name: 'Test Guild',
    members: {
      fetch: opts.fetchImpl ?? (async () => cache),
      cache,
    },
  };
}

function guildChannel(id: string, guild: FakeGuild, viewers: ReturnType<typeof member>[], parentId: string | null = null) {
  return {
    id,
    type: 0, // GuildText
    name: `chan-${id}`,
    guild,
    guildId: guild.id,
    parentId,
    isThread: () => false,
    // discord.js's members getter (permission-computed); fixtures hand us the
    // post-permission answer directly.
    members: new Map(viewers.map((m) => [m.id, m])),
  };
}

function thread(id: string, guild: FakeGuild, joinedIds: string[], parentId: string) {
  return {
    id,
    type: 11, // PublicThread
    name: `thread-${id}`,
    guild,
    guildId: guild.id,
    parentId,
    isThread: () => true,
    members: {
      fetch: async () => new Map(joinedIds.map((mid) => [mid, { id: mid }])),
    },
  };
}

/** A DiscordAdapter with its real (never-logged-in) client swapped for a
 *  fixture client, and a short member-fetch timeout for the guard tests. */
function makeAdapter(
  channels: Record<string, unknown>,
  opts: { guildChannels?: Record<string, string[]>; timeoutMs?: number } = {},
) {
  const adapter = new DiscordAdapter({ token: 'not-used', guildChannels: opts.guildChannels });
  const internals = adapter as unknown as {
    client: { destroy(): void };
    memberFetchTimeoutMs: number;
  };
  internals.client.destroy();
  internals.client = {
    destroy() {},
    // As discord.js's client does: guild channels are in the cache too
    // (the channel allowlist reads a thread's channel from it).
    channels: { fetch: async (id: string) => channels[id] ?? null, cache: new Map(Object.entries(channels)) },
    users: { fetch: async () => null },
    user: { id: 'bot_1', username: 'bot', displayName: 'Bot', bot: true },
  } as never;
  internals.memberFetchTimeoutMs = opts.timeoutMs ?? 200;
  return adapter;
}

// ── Tests ──

describe('listChannelMembers: guild channels', () => {
  it('returns the permission-computed viewer list after a successful cache warm', async () => {
    const alice = member('u1', 'Alice');
    const zed = member('u2', 'Zed');
    const bot = member('u3', 'Helper', { bot: true });
    const g = fakeGuild([alice, zed, bot]);
    const adapter = makeAdapter({ c1: guildChannel('c1', g, [zed, bot, alice]) });

    const result = await adapter.listChannelMembers('c1');
    assert.equal(result.scope, 'guild-channel');
    assert.equal(result.total, 3);
    assert.equal(result.truncated, false);
    // Humans first, alphabetical; bots after.
    assert.deepEqual(result.members.map((m) => m.displayName), ['Alice', 'Zed', 'Helper']);
  });

  it('throws (not a silently partial list) when the guarded warm times out', async () => {
    const g = fakeGuild([], { fetchImpl: () => new Promise(() => {}) }); // hangs
    const adapter = makeAdapter({ c1: guildChannel('c1', g, []) }, { timeoutMs: 50 });
    const started = Date.now();
    await assert.rejects(
      adapter.listChannelMembers('c1'),
      /warm-up failed or timed out/,
    );
    // The 30s production hang this guards against must not survive: the
    // shrunk timeout should bound the wait.
    assert.ok(Date.now() - started < 1000);
  });

  it('caps large channels with a truthful total', async () => {
    const many = Array.from({ length: 250 }, (_, i) => member(`u${i}`, `User${String(i).padStart(3, '0')}`));
    const g = fakeGuild(many);
    const adapter = makeAdapter({ c1: guildChannel('c1', g, many) });
    const result = await adapter.listChannelMembers('c1');
    assert.equal(result.total, 250);
    assert.equal(result.members.length, 200);
    assert.equal(result.truncated, true);
  });
});

describe('listChannelMembers: channel filters bound inspection', () => {
  it('rejects a channel outside the configured allowlist', async () => {
    const g = fakeGuild([member('u1', 'Alice')]);
    const adapter = makeAdapter(
      { c_denied: guildChannel('c_denied', g, []) },
      { guildChannels: { g1: ['c_allowed'] } },
    );
    await assert.rejects(adapter.listChannelMembers('c_denied'), /channel filters/);
  });

  it('allows a thread under an allowed parent; rejects one under a denied parent', async () => {
    const g = fakeGuild([member('u1', 'Alice')]);
    const adapter = makeAdapter(
      {
        t_ok: thread('t_ok', g, ['u1'], 'c_allowed'),
        t_no: thread('t_no', g, ['u1'], 'c_other'),
      },
      { guildChannels: { g1: ['c_allowed'] } },
    );
    const ok = await adapter.listChannelMembers('t_ok');
    assert.equal(ok.scope, 'thread-joined');
    await assert.rejects(adapter.listChannelMembers('t_no'), /channel filters/);
  });

  it('allows a thread whose channel is admitted only through its listed category; rejects one whose category is not listed', async () => {
    const alice = member('u1', 'Alice');
    const g = fakeGuild([alice]);
    // Only a category is listed. Neither thread's channel is, nor is either
    // thread, so admission has to come from the channel's own category, read
    // from the client's channel cache (makeAdapter caches every fixture
    // channel).
    const adapter = makeAdapter(
      {
        c_in_cat: guildChannel('c_in_cat', g, [alice], 'cat_allowed'),
        t_in_cat: thread('t_in_cat', g, ['u1'], 'c_in_cat'),
        c_other_cat: guildChannel('c_other_cat', g, [alice], 'cat_other'),
        t_other_cat: thread('t_other_cat', g, ['u1'], 'c_other_cat'),
      },
      { guildChannels: { g1: ['cat_allowed'] } },
    );
    const ok = await adapter.listChannelMembers('t_in_cat');
    assert.equal(ok.scope, 'thread-joined');
    assert.deepEqual(ok.members.map((m) => m.displayName), ['Alice']);
    await assert.rejects(adapter.listChannelMembers('t_other_cat'), /channel filters/);
  });
});

describe('listChannelMembers: threads', () => {
  it('resolves joined members via one bulk warm — no per-member fetches — and says so', async () => {
    let fetchCalls = 0;
    const alice = member('u1', 'Alice');
    const g = fakeGuild([alice], {
      fetchImpl: async () => { fetchCalls++; return g.members.cache; },
    });
    // 'ghost' joined the thread but left the guild: cache miss → id-only.
    const adapter = makeAdapter({ t1: thread('t1', g, ['u1', 'ghost'], 'c_parent') });

    const result = await adapter.listChannelMembers('t1');
    assert.equal(result.scope, 'thread-joined');
    assert.ok(result.note && /joined members only/i.test(result.note));
    assert.equal(fetchCalls, 1); // one warm, zero per-member REST
    assert.deepEqual(
      result.members.map((m) => [m.id, m.displayName]),
      [['u1', 'Alice'], ['ghost', 'ghost']],
    );
  });

  it('degrades to id-only display (not an error) when the warm fails for a thread', async () => {
    const g = fakeGuild([], { fetchImpl: async () => { throw new Error('no intent'); } });
    const adapter = makeAdapter({ t1: thread('t1', g, ['u1'], 'c_parent') });
    const result = await adapter.listChannelMembers('t1');
    // Membership comes from the thread itself, so the list is still honest —
    // only the display names are degraded.
    assert.deepEqual(result.members.map((m) => m.displayName), ['u1']);
  });
});

describe('listChannelMembers: DMs', () => {
  it('returns the two parties', async () => {
    const dm = {
      id: 'd1',
      type: 1, // DM
      isThread: () => false,
      recipient: { id: 'u9', username: 'ra', displayName: 'Ra', bot: false },
    };
    const adapter = makeAdapter({ d1: dm });
    const result = await adapter.listChannelMembers('d1');
    assert.equal(result.scope, 'dm');
    assert.deepEqual(result.members.map((m) => m.id).sort(), ['bot_1', 'u9']);
  });
});
