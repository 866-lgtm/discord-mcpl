/**
 * What a call says when its channel lookup gives it no channel it can use.
 * discord.js returns null for a channel Discord answered for but that it
 * can't build (an id Discord doesn't know throws Unknown Channel instead):
 * a kind it has no class for, or a server channel whose server it hasn't
 * cached yet. The error names both causes, what didn't happen, and what can
 * change each; the DM notice, whose channel is a DM with no server, names
 * the first alone. A channel that holds no messages of its own (a category,
 * a forum, a media or a directory channel), given by id, is named for what
 * it is, with what didn't happen and where its messages are, or that nothing
 * here can use it. A #name reaches only text, announcement, voice and
 * stage channels: one that none of those has is refused with what a #name
 * reaches, and how a channel of any other kind is given instead.
 *
 * Run: node --import tsx --test test/channel-lookup-errors.test.ts
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

const UNBUILT = '410000000000000001'; // a channel discord.js returns no object for
const CATEGORY = '410000000000000002';
const FORUM = '410000000000000003';
const MEDIA = '410000000000000004';
const DIRECTORY = '410000000000000005';
const LATER_KIND = '410000000000000006';
const DM = '410000000000000007'; // a DM discord.js returns no object for
const GUILD = '400000000000000001';

const unusable = (id: string, nothing: string) =>
  `Channel ${id} exists, but this adapter can't use it, so ${nothing}. Either it's a kind of channel this version ` +
  "of the adapter can't handle, which only an operator updating the adapter can change, or its server is still " +
  'loading on this connection, in which case the same call may work in a moment.';
const unhandled = (id: string, nothing: string) =>
  `Channel ${id} exists, but it's a kind of channel this version of the adapter can't handle, so ${nothing}. ` +
  'Only an operator updating the adapter can change that.';
const posts =
  " Its posts are threads, and no tool here lists them, so a post's id comes only from a message posted in it or a " +
  "link to it. A post's messages are written through that id, and read through it where the configured channel filters allow.";
const inCategory = (id: string) =>
  ` The channels in it that the configured channel filters allow are the ones list_channels for server ${GUILD} ` +
  `shows with ${id} as their parent.`;
const servers = ' It lists servers, and nothing here can read it or send to it.';

/** The real adapter, its channel lookups answered as discord.js would answer
 *  them: a channel for the kinds without messages, null for the rest. */
function adapterWith(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  const types: Record<string, number> = { [CATEGORY]: 4, [FORUM]: 15, [MEDIA]: 16, [DIRECTORY]: 14, [LATER_KIND]: 99 };
  (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) =>
    (id in types ? { id, type: types[id], guildId: GUILD, isDMBased: () => false } : null);
  return { adapter };
}

type ToolServer = {
  handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

describe('a channel discord.js returns nothing for', () => {
  it("is a kind this version can't handle or in a server still loading, by each of the eleven calls besides the DM notice", async (t) => {
    const { adapter } = adapterWith(t);
    const calls: Array<[string, () => Promise<unknown>, string]> = [
      ['sendMessage', () => adapter.sendMessage(UNBUILT, 'x'), 'nothing was sent'],
      ['editMessage', () => adapter.editMessage(UNBUILT, '1', 'x'), 'nothing was edited'],
      ['deleteMessage', () => adapter.deleteMessage(UNBUILT, '1'), 'nothing was deleted'],
      ['addReaction', () => adapter.addReaction(UNBUILT, '1', 'x'), 'no reaction was added'],
      ['removeReaction', () => adapter.removeReaction(UNBUILT, '1', 'x'), 'no reaction was removed'],
      ['fetchHistory', () => adapter.fetchHistory(UNBUILT), 'nothing was read'],
      ['fetchAround', () => adapter.fetchAround(UNBUILT, '1'), 'nothing was read'],
      ['listChannelMembers', () => adapter.listChannelMembers(UNBUILT), 'no members were listed'],
      ['resolveLatestFrom', () => adapter.resolveLatestFrom(UNBUILT, 'someone'), 'nothing was done'],
      ['deleteChannel', () => adapter.deleteChannel(UNBUILT), 'nothing was deleted'],
      ['inspectionRefusal', () => adapter.inspectionRefusal(UNBUILT), 'nothing was read'],
    ];
    for (const [name, call, nothing] of calls) {
      await assert.rejects(call, { message: unusable(UNBUILT, nothing) }, name);
    }
  });

  it("is a kind this version can't handle for the DM notice, since a DM has no server, and is never posted", async (t) => {
    const { adapter } = adapterWith(t);
    await assert.rejects(adapter.sendDmNotice(DM, 'x', 'n1'), (err: Error & { notPosted?: unknown }) => {
      assert.equal(err.message, unhandled(DM, 'nothing was sent'));
      assert.equal(err.notPosted, true);
      return true;
    });
  });

  it("gives latestFrom's own words when the history read's lookup gives nothing", async (t) => {
    const { adapter } = adapterWith(t);
    const client = (adapter as unknown as { client: Client }).client;
    // The channel is there for latestFrom's own lookup, and gone by the history read's.
    let first = true;
    (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => {
      if (!first) return null;
      first = false;
      return { id, type: 0, guildId: GUILD, parentId: null, isDMBased: () => false, isThread: () => false, messages: {} };
    };
    await assert.rejects(adapter.resolveLatestFrom(UNBUILT, 'someone'), { message: unusable(UNBUILT, 'nothing was done') });
  });

  it('reaches the agent as it is, not explained as an id Discord doesn\'t know', async (t) => {
    const server = new DiscordMcplServer(adapterWith(t).adapter) as unknown as ToolServer;
    const res = await server.handleToolCall('delete_message', { channelId: UNBUILT, messageId: '1' });
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, unusable(UNBUILT, 'nothing was deleted'));
  });
});

describe('a channel that holds no messages', () => {
  it('is named for what it is, with what did not happen, by each of the nine calls that need its messages', async (t) => {
    const { adapter } = adapterWith(t);
    const paths: Array<[string, (id: string) => Promise<unknown>, string]> = [
      ['sendMessage', (id) => adapter.sendMessage(id, 'x'), 'nothing was sent'],
      ['sendDmNotice', (id) => adapter.sendDmNotice(id, 'x', 'n1'), 'nothing was sent'],
      ['editMessage', (id) => adapter.editMessage(id, '1', 'x'), 'nothing was edited'],
      ['deleteMessage', (id) => adapter.deleteMessage(id, '1'), 'nothing was deleted'],
      ['addReaction', (id) => adapter.addReaction(id, '1', 'x'), 'no reaction was added'],
      ['removeReaction', (id) => adapter.removeReaction(id, '1', 'x'), 'no reaction was removed'],
      ['fetchHistory', (id) => adapter.fetchHistory(id), 'nothing was read'],
      ['fetchAround', (id) => adapter.fetchAround(id, '1'), 'nothing was read'],
      // A reply's or a reaction's latestFrom did nothing, not just read nothing.
      ['resolveLatestFrom', (id) => adapter.resolveLatestFrom(id, 'someone'), 'nothing was done'],
    ];
    for (const [name, call, nothing] of paths) {
      const says: Array<[string, string]> = [
        [CATEGORY, `Channel ${CATEGORY} is a category, which holds no messages, so ${nothing}.${inCategory(CATEGORY)}`],
        [FORUM, `Channel ${FORUM} is a forum, which holds no messages, so ${nothing}.${posts}`],
        [MEDIA, `Channel ${MEDIA} is a media channel, which holds no messages, so ${nothing}.${posts}`],
        [DIRECTORY, `Channel ${DIRECTORY} is a directory channel, which holds no messages, so ${nothing}.${servers}`],
        // A kind the table doesn't name, such as one a later discord.js builds, is named by its number.
        [LATER_KIND, `Channel ${LATER_KIND} is a kind of channel (type 99) that this adapter can't read or send to, so ${nothing}. ` +
          'Only an operator updating the adapter can change that.'],
      ];
      for (const [id, message] of says) {
        await assert.rejects(() => call(id), { message }, `${name} on ${id}`);
      }
    }
  });

  it('reaches the agent as it is, not explained as an id Discord doesn\'t know', async (t) => {
    const server = new DiscordMcplServer(adapterWith(t).adapter) as unknown as ToolServer;
    const read = await server.handleToolCall('fetch_history', { channelId: FORUM });
    assert.equal(read.isError, true);
    assert.equal(read.content[0].text, `Channel ${FORUM} is a forum, which holds no messages, so nothing was read.${posts}`);

    // A send names where it was aimed after the error's own words, and adds nothing else.
    const sent = await server.handleToolCall('send_message', { channelId: CATEGORY, content: 'hello' });
    assert.equal(sent.isError, true);
    const [own, destination, ...rest] = sent.content[0].text.split('\n\n');
    assert.equal(own, `Channel ${CATEGORY} is a category, which holds no messages, so nothing was sent.${inCategory(CATEGORY)}`);
    assert.match(destination, new RegExp(`^Attempted destination: [^\\n]*${CATEGORY}\\)?\\.$`));
    assert.deepEqual(rest, []);
  });
});

describe('a #name that no text, announcement, voice or stage channel has', () => {
  const TEXT = '420000000000000001';
  const HIDDEN = '420000000000000005';
  const channels: Array<[string, string, number]> = [
    [TEXT, 'general', 0],
    ['420000000000000002', 'general', 4], // a category that shares the text channel's name
    ['420000000000000003', 'plans', 4],
    ['420000000000000004', 'ideas', 15],
    [HIDDEN, 'hidden', 0], // left out of the channel filters
  ];

  /** The real adapter over one cached server, with the filters leaving HIDDEN out. */
  function adapterOverServer(t: TestContext) {
    const allowed = channels.map(([id]) => id).filter((id) => id !== HIDDEN);
    const adapter = new DiscordAdapter({ token: 'unused', guildChannels: { [GUILD]: allowed } });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    const cache = new Map(channels.map(([id, name, type]) => [id, { id, name, type, parentId: null }]));
    (client.guilds.cache as unknown as Map<string, unknown>).set(GUILD, { id: GUILD, name: 'Separatrix', channels: { cache } });
    const lookups: string[] = [];
    (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => { lookups.push(id); return null; };
    return { adapter, lookups };
  }
  const notFound = (named: string) =>
    `No text, announcement, voice or stage channel that the configured channel filters allow is named ${named}, and a #name ` +
    "reaches only those. list_channels shows a server's channels with their ids, and a channel of any other kind, such as " +
    'a category or a forum, is given by its id instead.';

  it("is refused for a category's or a forum's name, by a send, a history read and a delete tool alike, with no tool run", async (t) => {
    const { adapter, lookups } = adapterOverServer(t);
    const server = new DiscordMcplServer(adapter) as unknown as ToolServer;
    for (const [tool, args, text] of [
      ['send_message', { channelId: '#plans', content: 'hi' }, notFound('#plans')],
      ['fetch_history', { channelId: '#ideas' }, notFound('#ideas')],
      // A tool that acts on any channel isn't handed the category by its name.
      ['delete_channel', { channelId: '#plans' }, notFound('#plans')],
    ] as const) {
      const res = await server.handleToolCall(tool, args);
      assert.equal(res.isError, true, tool);
      assert.equal(res.content[0].text, text, tool);
    }
    assert.deepEqual(lookups, [], 'no tool ran');
  });

  it('keeps resolving to the text channel beside a same-named category, and refuses a typo, a name qualified by its server, and one the filters leave out', (t) => {
    const { adapter } = adapterOverServer(t);
    const general = adapter.resolveChannelRef('#general');
    assert.ok(general.ok && general.id === TEXT, JSON.stringify(general));
    for (const [ref, named] of [
      ['#genral', '#genral'],
      ['#plans (Separatrix)', '#plans in "Separatrix"'],
      ['#hidden', '#hidden'],
    ]) {
      assert.deepEqual(adapter.resolveChannelRef(ref), { ok: false, reason: 'not-found', message: notFound(named) }, ref);
    }
  });
});
