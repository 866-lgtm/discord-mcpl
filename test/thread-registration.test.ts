/**
 * Adapter side of registration: the one label rule (a thread's label is
 * display-only; a channel whose name wouldn't resolve back to it is labelled
 * by its id), what the channel cache reports of a channel, which kinds the
 * listings and channel events register, and the events that change or end a
 * registration (a channel's or thread's update, a thread's deletion, a
 * guild's rename). And the tool chokepoint refusing a pasted thread label.
 * Jerome-1896 and Esther-1897 found that no path registered threads (room-203
 * #58153), and that the sweep pushed DMs and threads unregistered (#58257,
 * #58302).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';
import { DiscordAdapter, type ChannelFacts } from '../src/discord-adapter.js';
import { formatThreadLabel, parseChannelRef, threadLabelRefusal } from '../src/channel-names.js';
import { channelLabelFor, toDescriptor } from '../src/channels.js';
import { DiscordMcplServer } from '../src/server.js';

function adapterFixture(t: { after: (fn: () => void) => void }, config: { guildIds?: string[]; guildChannels?: Record<string, string[]> } = {}) {
  const adapter = new DiscordAdapter({ token: 'unused', ...config });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  const emit = client.emit.bind(client) as (event: string, ...args: unknown[]) => boolean;
  const channels = client.channels.cache as unknown as Map<string, unknown>;
  const guilds = client.guilds.cache as unknown as Map<string, unknown>;
  /** A guild the cache holds, whose channels are the cached ones in it, as
   *  the name resolver reads them. */
  const held = (id: string, name: string, more: Record<string, unknown> = {}) => ({
    id, name, ...more,
    channels: { cache: { values: () => [...channels.values()].filter((c) => (c as { guildId?: string }).guildId === id) } },
  });
  return { adapter, client, emit, channels, guilds, held };
}

const facts = (over: Partial<ChannelFacts> & Pick<ChannelFacts, 'id' | 'type'>): ChannelFacts => ({
  guildId: 'g1', guildName: 'Test Server', name: `chan-${over.id}`, ...over,
});

describe('labels', () => {
  it("name a thread's channel and the thread, in a form that is not a channel address", () => {
    assert.equal(formatThreadLabel('general', 'design-chat', 'Test Server'), '#general › design-chat (Test Server)');
    assert.equal(formatThreadLabel(null, 'design-chat', 'Test Server'), '› design-chat (Test Server)');
    const d = toDescriptor(facts({ id: 'th1', type: 'thread', name: 'design-chat', parentId: 'c1', parentName: 'general' }));
    assert.equal(d.label, '#general › design-chat (Test Server)');
    // Pasted back, it parses as the name `general › design-chat`, a shape the
    // resolver refuses (next test), where `#design-chat (Test Server)` would
    // quietly name a same-named channel.
    assert.deepEqual(parseChannelRef(d.label), { kind: 'name', name: 'general › design-chat', guild: 'Test Server' });
    // A channel's descriptor keeps its address form.
    const c = toDescriptor(facts({ id: 'c1', type: 'text', name: 'general' }));
    assert.equal(c.label, '#general (Test Server)');
    assert.deepEqual(parseChannelRef(c.label), { kind: 'name', name: 'general', guild: 'Test Server' });
  });

  it('are an id where a name is unknown, unaddressable, or would read as a thread label', () => {
    for (const [f, why] of [
      [facts({ id: 'c1', type: 'text', guildName: null, name: 'general' }), 'the guild name unknown'],
      [facts({ id: 'c1', type: 'text', name: null }), 'the channel name unknown'],
      [facts({ id: 'th1', type: 'thread', guildName: null, name: 'design-chat', parentName: 'general' }), "a thread's guild unknown"],
      [facts({ id: 'c1', type: 'unknown', name: 'mystery' }), 'a kind no name resolves to'],
      [facts({ id: 'c1', type: 'voice', name: 'general › design' }), 'a voice room named like a thread label'],
    ] as const) {
      assert.equal(channelLabelFor(f), `discord:g1:${f.id}`, why);
      // Which addresses exactly that channel.
      assert.deepEqual(parseChannelRef(channelLabelFor(f)), { kind: 'id', id: f.id }, why);
    }
    // A voice or stage channel is named as a text channel is.
    assert.equal(channelLabelFor(facts({ id: 'v1', type: 'voice', name: 'Lounge' })), '#Lounge (Test Server)');
    assert.equal(channelLabelFor(facts({ id: 's1', type: 'stage', name: 'town-hall' })), '#town-hall (Test Server)');
  });

  it('pasted into a send, a thread label fails loudly even where a voice room carries its name', (t) => {
    // A voice channel's name may hold spaces and ›, so a voice room can be
    // named `general › design-chat`. The adapter's resolver (parse,
    // candidates, match) refuses the label rather than sending there.
    const { adapter, guilds } = adapterFixture(t);
    guilds.set('g1', {
      id: 'g1', name: 'Test Server', channels: { cache: new Map<string, unknown>([
        ['c1', { id: 'c1', type: ChannelType.GuildText, name: 'general', parentId: null }],
        ['v1', { id: 'v1', type: ChannelType.GuildVoice, name: 'general › design-chat', parentId: null }],
        ['v2', { id: 'v2', type: ChannelType.GuildVoice, name: '› design-chat', parentId: null }],
      ]) },
    });
    for (const label of [
      formatThreadLabel('general', 'design-chat', 'Test Server'),
      formatThreadLabel(null, 'design-chat', 'Test Server'),
      // The same shapes, typed without a server.
      '#general › design-chat',
      '› design-chat',
    ]) {
      // Refused, quoting the label as it was given, where a voice room has its name.
      assert.deepEqual(adapter.resolveChannelRef(label), threadLabelRefusal(label), label);
    }
    // The resolver does see this guild's channels: a channel label resolves.
    const general = adapter.resolveChannelRef('#general (Test Server)');
    assert.ok(general.ok, JSON.stringify(general));
    assert.equal(general.id, 'c1');
  });

  it('a tool given a thread label refuses it at the chokepoint, before anything is sent', async (t) => {
    const { adapter, guilds } = adapterFixture(t);
    guilds.set('g1', {
      id: 'g1', name: 'Test Server', channels: { cache: new Map<string, unknown>([
        ['c1', { id: 'c1', type: ChannelType.GuildText, name: 'general', parentId: null }],
        ['v1', { id: 'v1', type: ChannelType.GuildVoice, name: 'general › design-chat', parentId: null }],
      ]) },
    });
    const sent: string[] = [];
    adapter.sendMessage = (async (channelId: string) => {
      sent.push(channelId);
      return { messageId: 'm1' };
    }) as never;
    const server = new DiscordMcplServer(adapter) as unknown as {
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const r = await server.handleToolCall('send_message', { channelId: '#general › design-chat (Test Server)', content: 'hi' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /thread label's shape/);
    assert.deepEqual(sent, [], 'nothing may be sent to the voice room the label resembles');
    // The same chokepoint sends a channel's label on.
    await server.handleToolCall('send_message', { channelId: '#general (Test Server)', content: 'hi' });
    assert.deepEqual(sent, ['c1']);
  });
});

describe("the channel cache reports a channel's facts", () => {
  it('for a cached thread and channel, and nothing for an uncached id or a DM', (t) => {
    const { adapter, channels, guilds, held } = adapterFixture(t);
    guilds.set('g1', held('g1', 'Test Server'));
    channels.set('c1', { id: 'c1', type: ChannelType.GuildText, name: 'general', guildId: 'g1', parentId: 'cat1' });
    // A thread's parent is looked up by id: discord.js's `parent` getter
    // throws for a thread whose guild it hasn't cached.
    channels.set('th1', {
      id: 'th1', type: ChannelType.PublicThread, name: 'design-chat', guildId: 'g1', parentId: 'c1', archived: false,
      get parent(): never { throw new Error('no guild'); },
    });
    channels.set('th2', { id: 'th2', type: ChannelType.PrivateThread, name: 'old', guildId: 'g1', parentId: 'gone', archived: true });
    channels.set('ann1', { id: 'ann1', type: ChannelType.GuildAnnouncement, name: 'news', guildId: 'g1', parentId: 'cat1' });
    channels.set('st1', { id: 'st1', type: ChannelType.GuildStageVoice, name: 'town-hall', guildId: 'g1', parentId: null });
    channels.set('x1', { id: 'x1', type: ChannelType.GuildText, name: 'lobby', guildId: 'g9', parentId: null });
    channels.set('dm1', { id: 'dm1', type: ChannelType.DM, recipientId: 'u1' });
    assert.deepEqual(adapter.getCachedChannelFacts('th1'), {
      id: 'th1', guildId: 'g1', guildName: 'Test Server', type: 'thread', name: 'design-chat',
      parentId: 'c1', parentName: 'general', archived: false,
    });
    // An archived thread whose channel isn't cached.
    assert.deepEqual(adapter.getCachedChannelFacts('th2'), {
      id: 'th2', guildId: 'g1', guildName: 'Test Server', type: 'thread', name: 'old',
      parentId: 'gone', parentName: null, archived: true,
    });
    // A channel's parent is its category, whose name no label uses. Its
    // name resolves back to it.
    assert.deepEqual(adapter.getCachedChannelFacts('ann1'), {
      id: 'ann1', guildId: 'g1', guildName: 'Test Server', type: 'announcement', name: 'news',
      parentId: 'cat1', parentName: null, archived: false, nameResolves: true,
    });
    assert.equal(adapter.getCachedChannelFacts('st1')?.type, 'stage');
    // A guild the cache doesn't hold: its name isn't known.
    assert.equal(adapter.getCachedChannelFacts('x1')?.guildName, null);
    assert.equal(adapter.getCachedChannelFacts('dm1'), null);
    assert.equal(adapter.getCachedChannelFacts('not-cached'), null);
  });
});

describe('the kinds registered by listing them', () => {
  const kinds: Array<[string, ChannelType]> = [
    ['text1', ChannelType.GuildText], ['news1', ChannelType.GuildAnnouncement],
    ['voice1', ChannelType.GuildVoice], ['stage1', ChannelType.GuildStageVoice],
    ['cat1', ChannelType.GuildCategory], ['forum1', ChannelType.GuildForum],
    ['media1', ChannelType.GuildMedia], ['thread1', ChannelType.PublicThread],
  ];
  const listed = ['text1', 'news1', 'voice1', 'stage1'];

  it("at boot: each one messages are posted in, a voice or stage channel's text chat included, within the filters", (t) => {
    const { adapter, guilds } = adapterFixture(t, { guildIds: ['g1'], guildChannels: { g1: [...listed.filter((id) => id !== 'news1'), 'cat1', 'forum1', 'media1', 'thread1'] } });
    const cache = new Map<string, unknown>(kinds.map(([id, type]) => [id, { id, type, name: `chan-${id}`, guildId: 'g1', parentId: null }]));
    guilds.set('g1', { id: 'g1', name: 'Test Server', channels: { cache } });
    // Another guild, which the guild filter leaves out.
    guilds.set('g2', { id: 'g2', name: 'Other', channels: { cache: new Map([['t2', { id: 't2', type: ChannelType.GuildText, name: 'x', guildId: 'g2', parentId: null }]]) } });
    // A category, forum or media channel holds no messages of its own, and a
    // thread is registered by its messages; news1 is outside the channel list.
    assert.deepEqual(adapter.getPostingChannels().map((c) => [c.id, c.type, c.guildName]), [
      ['text1', 'text', 'Test Server'], ['voice1', 'voice', 'Test Server'], ['stage1', 'stage', 'Test Server'],
    ]);
  });

  it('when one is created, in a guild the guild filter admits', (t) => {
    const { adapter, emit, guilds, held } = adapterFixture(t, { guildIds: ['g1'] });
    guilds.set('g1', held('g1', 'Test Server'));
    const created: Array<[string, string | null]> = [];
    adapter.onChannelCreate((c) => created.push([c.id, c.guildName]));
    for (const [id, type] of kinds) emit('channelCreate', { id, type, name: `chan-${id}`, guildId: 'g1', parentId: null });
    // A guild whose messages are all dropped: none of its channels is listed.
    emit('channelCreate', { id: 'in-g2', type: ChannelType.GuildText, name: 'x', guildId: 'g2', parentId: null });
    assert.deepEqual(created, listed.map((id) => [id, 'Test Server']));
  });

  it('when one changes, whether or not the bot can view it, but not a category', (t) => {
    const { adapter, emit, guilds, held } = adapterFixture(t);
    const guild = held('g1', 'Test Server', { members: { me: { id: 'bot' } } });
    guilds.set('g1', guild);
    const updated: string[] = [];
    adapter.onChannelUpdate((c) => updated.push(`${c.id}:${c.name}`));
    const channel = (id: string, type: ChannelType, name: string, canView = true) => ({
      id, type, name, guildId: 'g1', guild, parentId: null,
      permissionsFor: () => ({ has: () => canView }),
    });
    // Renamed: reported, so the server can re-derive what it registered.
    emit('channelUpdate', channel('v1', ChannelType.GuildVoice, 'lounge'), channel('v1', ChannelType.GuildVoice, 'cafe'));
    emit('channelUpdate', channel('cat1', ChannelType.GuildCategory, 'a'), channel('cat1', ChannelType.GuildCategory, 'b'));
    // Hidden from the bot: listing registers it all the same
    // (getPostingChannels), so its rename is reported too.
    emit('channelUpdate', channel('c9', ChannelType.GuildText, 'x'), channel('c9', ChannelType.GuildText, 'y', false));
    assert.deepEqual(updated, ['v1:cafe', 'c9:y']);
  });
});

describe('the events that change or end a registration', () => {
  it("report a thread's change with its facts, archived included, and its deletion", (t) => {
    const { adapter, emit, channels, guilds, held } = adapterFixture(t);
    guilds.set('g1', held('g1', 'Test Server'));
    channels.set('c1', { id: 'c1', type: ChannelType.GuildText, name: 'general', guildId: 'g1', parentId: null });
    const changes: ChannelFacts[] = [];
    const deleted: Array<[string, string]> = [];
    adapter.onThreadUpdate((thread) => changes.push(thread));
    adapter.onThreadDelete((guildId, threadId) => deleted.push([guildId, threadId]));
    const thread = { id: 'th1', type: ChannelType.PublicThread, name: 'design-chat', guildId: 'g1', parentId: 'c1' };
    emit('threadUpdate', { ...thread, archived: false }, { ...thread, archived: true });
    emit('threadDelete', { id: 'th1', guildId: 'g1' });
    assert.deepEqual(changes, [{
      id: 'th1', guildId: 'g1', guildName: 'Test Server', type: 'thread', name: 'design-chat',
      parentId: 'c1', parentName: 'general', archived: true,
    }]);
    assert.deepEqual(deleted, [['g1', 'th1']]);
  });

  it("report a guild's rename, but not another change, nor a guild the filter excludes", (t) => {
    const { adapter, emit } = adapterFixture(t, { guildIds: ['g1'] });
    const renamed: string[] = [];
    adapter.onGuildRename((guildId) => renamed.push(guildId));
    emit('guildUpdate', { id: 'g1', name: 'Old' }, { id: 'g1', name: 'New' });
    emit('guildUpdate', { id: 'g1', name: 'New' }, { id: 'g1', name: 'New' });
    emit('guildUpdate', { id: 'g2', name: 'A' }, { id: 'g2', name: 'B' });
    assert.deepEqual(renamed, ['g1']);
  });
});
