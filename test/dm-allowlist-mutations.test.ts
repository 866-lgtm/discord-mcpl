/**
 * The DM allowlist holds for a DM's edits and deletes as it does for its
 * creates. A refused sender's message never reaches the agent, so neither
 * does its edit or its deletion. A delete is judged by the DM's other party:
 * its author unless the message is the bot's own, else the DM channel's
 * recipient, since an uncached delete names no author. discord.js caches
 * every DM it receives, so without this a refused DM's deletion carried its
 * sender's id and username to the host.
 *
 * Run: node --import tsx --test test/dm-allowlist-mutations.test.ts
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

function fixture(
  t: TestContext,
  dmUsers?: string[],
  fetchChannel = async (id: string): Promise<unknown> =>
    ({ id, type: ChannelType.DM, recipientId: id.replace(/^dm-/, ''), isDMBased: () => true }),
) {
  const adapter = new DiscordAdapter({ token: 'unused', ...(dmUsers ? { dmUsers } : {}) });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  // The bot's own identity, as login would set it.
  (client as unknown as { user: { id: string } }).user = { id: 'the-bot' };
  const fetched: string[] = [];
  // A DM channel known only by its id: fetching it names its recipient.
  (client.channels as unknown as { fetch: (id: string) => Promise<unknown> }).fetch = async (id: string) => {
    fetched.push(id);
    return fetchChannel(id);
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
  return { emit, pushes, fetched, settle };
}

/** A DM as discord.js hands it over: cached (seen live) with its author and
 *  a channel that knows its recipient, or partial, known only by id. */
const dm = (user: string, id: string, cached: boolean) => ({
  id, channelId: `dm-${user}`, guildId: null, partial: !cached,
  channel: cached
    ? { id: `dm-${user}`, type: ChannelType.DM, recipientId: user, isDMBased: () => true }
    : { id: `dm-${user}`, type: ChannelType.DM, isDMBased: () => true },
  author: cached ? { id: user, username: `${user}_name` } : null,
  content: cached ? 'words' : null,
  editedTimestamp: 1790000000000,
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

  it('refuses a deletion whose party a channel lookup cannot name, and says why when the lookup fails', async (t) => {
    // The fetched channel names no recipient: refused, as an unknown party.
    const silent = fixture(t, ['friend'], async (id) => ({ id, type: ChannelType.DM, isDMBased: () => true }));
    silent.emit('messageDelete', dm('friend', 'm-nameless', false));
    await silent.settle();
    assert.deepEqual(silent.pushes, []);
    assert.deepEqual(silent.fetched, ['dm-friend']);

    // The lookup fails: refused too, and the cause reaches the operator log.
    const errors = t.mock.method(console, 'error', () => {});
    const failing = fixture(t, ['friend'], async () => { throw new Error('channel lookup failed: 503'); });
    failing.emit('messageDelete', dm('friend', 'm-unlucky', false));
    await failing.settle();
    assert.deepEqual(failing.pushes, []);
    assert.ok(
      errors.mock.calls.some((c) => c.arguments.some((a) => String(a).includes('channel lookup failed: 503'))),
      'the failed fetch is logged with its cause',
    );
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

  it('never fetches a channel for an edit, which is judged by its author', async (t) => {
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
