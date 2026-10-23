/**
 * The DM allowlist holds for a DM's edits and deletes as it does for its
 * creates. A refused sender's message never reaches the agent, so neither
 * does its edit or its deletion. A delete is judged by the DM's other party:
 * its author unless the message is the bot's own, else the DM channel's
 * recipient, since an uncached delete names no author. discord.js caches
 * every DM it receives, so without this a refused DM's deletion carried its
 * sender's id and username to the host.
 *
 * The client's channel fetch here behaves as discord.js's does: unforced, it
 * returns the cached DM channel, which may have recorded only the bot; forced,
 * it asks Discord, which names the recipient.
 *
 * Run: node --import tsx --test test/dm-allowlist-mutations.test.ts
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

/** What Discord says of a DM channel when asked past the cache: its recipient. */
const askDiscord = async (id: string): Promise<unknown> =>
  ({ id, type: ChannelType.DM, recipientIds: [id.replace(/^dm-/, '')], isDMBased: () => true });

function fixture(t: TestContext, dmUsers?: string[], fetchChannel = askDiscord) {
  const adapter = new DiscordAdapter({ token: 'unused', ...(dmUsers ? { dmUsers } : {}) });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  // The bot's own identity, as login would set it.
  (client as unknown as { user: { id: string } }).user = { id: 'the-bot' };
  const fetched: string[] = [];
  const forced: boolean[] = [];
  // Unforced, the cache answers with the DM channel as discord.js holds it,
  // only the bot recorded; forced, Discord names the recipient.
  (client.channels as unknown as { fetch: (id: string, o?: { force?: boolean }) => Promise<unknown> }).fetch =
    async (id: string, o?: { force?: boolean }) => {
      fetched.push(id);
      forced.push(o?.force === true);
      return o?.force ? fetchChannel(id) : { id, type: ChannelType.DM, recipientIds: ['the-bot'], isDMBased: () => true };
    };
  const server = new DiscordMcplServer(adapter) as unknown as Record<string, unknown> & { setupDiscordForwarding(): void };
  const pushes: Array<{ origin?: Record<string, unknown>; payload?: { content?: Array<{ text?: string }> } }> = [];
  server.conn = {
    sendRequest: async (_m: string, params: unknown) => { pushes.push(params as (typeof pushes)[number]); return {}; },
    sendNotification: () => {},
  };
  server.mcplEnabled = true;
  (server.enabledFeatureSets as Set<string>).add('discord.messaging');
  server.subscriptionsLoaded = true;
  server.mutedLoaded = true;
  server.setupDiscordForwarding();
  const emit = client.emit.bind(client) as (event: string, ...args: unknown[]) => boolean;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };
  return { adapter, emit, pushes, fetched, forced, settle };
}

/** A DM as discord.js hands it over: cached (seen live) with its author and
 *  a channel that knows its recipient, or partial, known only by id. */
const dm = (user: string, id: string, cached: boolean) => ({
  id, channelId: `dm-${user}`, guildId: null, partial: !cached,
  channel: cached
    ? { id: `dm-${user}`, type: ChannelType.DM, recipientIds: [user], isDMBased: () => true }
    : { id: `dm-${user}`, type: ChannelType.DM, isDMBased: () => true },
  author: cached ? { id: user, username: `${user}_name`, bot: false } : null,
  content: cached ? 'words' : null,
  editedTimestamp: 1790000000000,
  // A whole message, as discord.js gives one, says whom it mentions.
  ...(cached ? { mentions: { users: [], roles: [], repliedUser: null } } : {}),
});

describe('the DM allowlist on edits and deletes', () => {
  it("never forwards a refused sender's deletion, cached or not", async (t) => {
    const f = fixture(t, ['friend']);
    f.emit('messageDelete', dm('stranger', 'm-cached', true));
    f.emit('messageDelete', dm('stranger', 'm-partial', false));
    await f.settle();
    assert.deepEqual(f.pushes, [], 'no tombstone, so neither the id nor the username leaves');
    assert.deepEqual(f.fetched, ['dm-stranger'], "the uncached DM's channel is fetched once, for its recipient");
  });

  it("forwards an allowed user's deletion, even of a message no longer cached", async (t) => {
    const f = fixture(t, ['friend']);
    f.emit('messageDelete', dm('friend', 'm-partial', false));
    await f.settle();
    assert.equal(f.pushes.length, 1);
    assert.match(f.pushes[0].payload?.content?.[0]?.text ?? '', /^\[message deleted\] m-partial/);
  });

  it("never forwards a refused sender's edit, and forwards an allowed user's", async (t) => {
    const f = fixture(t, ['friend']);
    f.emit('messageUpdate', { partial: true }, { ...dm('stranger', 'm-edit', true), content: 'changed words' });
    f.emit('messageUpdate', { partial: true }, { ...dm('friend', 'f-edit', true), content: 'changed words' });
    await f.settle();
    assert.equal(f.pushes.length, 1, "only the allowed user's edit, through the same path");
    assert.match(JSON.stringify(f.pushes[0]), /f-edit/);
  });

  it("withholds a deletion whose party Discord can't confirm, and says so in the operator log", async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const lines = () => errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
    // The fetched channel names no recipient: withheld, as an unknown party.
    const silent = fixture(t, ['friend'], async (id) => ({ id, type: ChannelType.DM, isDMBased: () => true }));
    silent.emit('messageDelete', dm('friend', 'm-nameless', false));
    await silent.settle();
    assert.deepEqual(silent.pushes, []);
    assert.deepEqual(silent.fetched, ['dm-friend']);
    assert.ok(
      lines().some((l) => /Withheld the deletion of message m-nameless in DM channel dm-friend: Discord names no recipient/.test(l)),
      lines().join('\n'),
    );

    // The lookup fails: withheld too, with its cause.
    const failing = fixture(t, ['friend'], async () => { throw new Error('channel lookup failed: 503'); });
    failing.emit('messageDelete', dm('friend', 'm-unlucky', false));
    await failing.settle();
    assert.deepEqual(failing.pushes, []);
    assert.ok(
      lines().some((l) => /Withheld the deletion of message m-unlucky in DM channel dm-friend: looking up its DM channel failed \(channel lookup failed: 503\)/.test(l)),
      lines().join('\n'),
    );
  });

  it("records a refused party's deletion in the debug log, apart from one that couldn't be confirmed", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-mutations-'));
    t.after(() => { delete process.env.DISCORD_MCPL_DEBUG_LOG; rmSync(dir, { recursive: true, force: true }); });
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    t.mock.method(console, 'error', () => {});
    const f = fixture(t, ['friend'], async (id) => ({ id, type: ChannelType.DM, isDMBased: () => true }));
    f.emit('messageDelete', dm('stranger', 'm-refused', true));
    f.emit('messageDelete', dm('friend', 'm-unconfirmed', false));
    await f.settle();
    const log = readFileSync(join(dir, 'debug.log'), 'utf-8');
    assert.match(log, /messageDelete:drop .*m-refused.*"reason":"dm-not-allowed"/);
    assert.match(log, /messageDelete:drop .*m-unconfirmed.*"reason":"dm-party-unknown"/);
  });

  it('judges a cached deletion by its known author, with no lookup, even when the channel names only the bot', async (t) => {
    const f = fixture(t, ['friend']);
    const byAuthor = (user: string, id: string) => ({
      ...dm(user, id, true),
      channel: { id: `dm-${user}`, type: ChannelType.DM, recipientIds: ['the-bot'], isDMBased: () => true },
    });
    f.emit('messageDelete', byAuthor('stranger', 'a-stranger'));
    f.emit('messageDelete', byAuthor('friend', 'a-friend'));
    await f.settle();
    assert.equal(f.pushes.length, 1, "only the listed author's");
    assert.match(f.pushes[0].payload?.content?.[0]?.text ?? '', /^\[message deleted\] a-friend/);
    assert.deepEqual(f.fetched, [], 'the author decides, so nothing is looked up');
  });

  it('withholds the deletion of a message delivered before its sender was removed from the list', async (t) => {
    const f = fixture(t, ['friend']);
    f.emit('messageUpdate', { partial: true }, { ...dm('friend', 'f-before', true), content: 'changed words' });
    await f.settle();
    assert.equal(f.pushes.length, 1, 'delivered while listed');
    f.adapter.updateFilters({ dmUsers: ['someone-else'] });
    f.emit('messageDelete', dm('friend', 'f-before', true));
    await f.settle();
    assert.equal(f.pushes.length, 1, 'the deletion is judged by the list as it is now, as edits are');
  });

  it("asks Discord for the party when the cached channel can't name it", async (t) => {
    // discord.js counts a cached DM channel as complete once it has seen a
    // message there, whatever recipients it has recorded. With only the bot
    // recorded, its recipientId getter returns the bot's own id; with none,
    // the getter throws.
    const f = fixture(t, ['friend']);
    const cachedWith = (recipientIds?: string[]) => ({
      id: 'dm-friend', type: ChannelType.DM, isDMBased: () => true,
      ...(recipientIds ? { recipientIds } : {}),
      get recipientId(): string {
        if (!recipientIds) throw new TypeError("Cannot read properties of undefined (reading 'find')");
        return recipientIds.find((r) => r !== 'the-bot') ?? recipientIds[0];
      },
    });
    f.emit('messageDelete', { ...dm('friend', 'm-only-bot', false), channel: cachedWith(['the-bot']) });
    f.emit('messageDelete', { ...dm('friend', 'm-none', false), channel: cachedWith() });
    await f.settle();
    assert.equal(f.pushes.length, 2, "both of the allowed user's deletions arrive, which an unforced fetch's cached answer wouldn't give");
    assert.deepEqual(f.fetched, ['dm-friend', 'dm-friend']);
    assert.deepEqual(f.forced, [true, true], 'past the cache, which already holds the channel');
  });

  it('judges a deletion of the bot\'s own DM by the conversation, not by the bot', async (t) => {
    const f = fixture(t, ['friend']);
    const own = (user: string, id: string) => ({
      ...dm(user, id, true),
      author: { id: 'the-bot', username: 'bot_name' },
    });
    f.emit('messageDelete', own('friend', 'b-friend'));
    f.emit('messageDelete', own('stranger', 'b-stranger'));
    await f.settle();
    assert.equal(f.pushes.length, 1, "only the allowed user's DM");
    assert.match(f.pushes[0].payload?.content?.[0]?.text ?? '', /^\[message deleted\] b-friend/);
    assert.deepEqual(f.fetched, [], 'both channels carry their recipient');
  });

  it("never looks up a DM's party for an edit, which is judged by its author", async (t) => {
    const f = fixture(t, ['friend']);
    f.emit('messageUpdate', { partial: true }, { ...dm('friend', 'm-anon', false), content: 'changed words', author: null });
    await f.settle();
    assert.deepEqual(f.pushes, [], 'an edit with no author is refused, as before');
    assert.deepEqual(f.fetched, [], 'and no lookup holds up a later delete of the message');
  });

  it('with no allowlist, forwards every DM deletion and fetches nothing for it', async (t) => {
    const f = fixture(t);
    f.emit('messageDelete', dm('stranger', 'm-partial', false));
    await f.settle();
    assert.equal(f.pushes.length, 1);
    assert.deepEqual(f.fetched, [], 'no list, so no recipient is needed');
  });
});

describe('the DM allowlist and guild channels', () => {
  it("leaves a guild channel's edits and deletes to the guild filters, whoever the author", async (t) => {
    const adapter = new DiscordAdapter({ token: 'unused', dmUsers: ['friend'] });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    (client as unknown as { user: { id: string } }).user = { id: 'the-bot' };
    const got: string[] = [];
    adapter.onMessageEdit((_channelId, messageId) => { got.push(`edit ${messageId}`); });
    adapter.onMessageDelete((_channelId, messageId) => { got.push(`delete ${messageId}`); });
    const emit = client.emit.bind(client) as (event: string, ...args: unknown[]) => boolean;
    const inGuild = (id: string) => ({
      id, channelId: 'g-chan', guildId: 'guild-1', partial: false,
      channel: { id: 'g-chan', type: ChannelType.GuildText, guildId: 'guild-1', parentId: null, isDMBased: () => false },
      author: { id: 'stranger', username: 'stranger_name', bot: false },
      content: 'changed words',
      editedTimestamp: 1790000000000,
      mentions: { users: [], roles: [], repliedUser: null },
    });
    emit('messageUpdate', { partial: true }, inGuild('g-edit'));
    emit('messageDelete', inGuild('g-delete'));
    for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(got.sort(), ['delete g-delete', 'edit g-edit'], 'an unlisted author in a guild is not a DM refusal');
  });
});
