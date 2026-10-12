/**
 * Edit/delete forwarding.
 *
 * Discord emits MESSAGE_UPDATE for more than content edits: link-preview /
 * embed refreshes re-send old messages with `edited_timestamp` still null.
 * Those were forwarded as "[message edited] …" events — weeks-old,
 * never-edited messages reaching the agent as fresh edits — with no author and
 * no guild, so the host placed them at `discord:dm:<guildChannelId>` and the
 * agent attributed them to whoever it had last been talking to.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { DiscordAdapter, editForwardDecision } from '../src/discord-adapter.js';
import { ChannelManager, toDescriptor } from '../src/channels.js';
import { ChannelType, type Client } from 'discord.js';
import { DiscordMcplServer } from '../src/server.js';
import type { MessageEventInfo } from '../src/discord-adapter.js';

const EDITED_AT = 1790000000000;
const guildMsg = (over: Record<string, unknown> = {}) => ({
  content: 'zz new text',
  editedTimestamp: EDITED_AT,
  guildId: 'g1',
  author: { id: 'u1' },
  ...over,
});

describe('editForwardDecision', () => {
  it('forwards a real content edit', () => {
    assert.equal(editForwardDecision({ partial: false, content: 'zz old text' }, guildMsg(), {}), 'forward');
  });

  it('drops an update that is not an edit (embed / link-preview refresh: edited_timestamp null)', () => {
    assert.equal(editForwardDecision(null, guildMsg({ editedTimestamp: null }), {}), 'not-an-edit');
    assert.equal(editForwardDecision(undefined, guildMsg({ editedTimestamp: undefined }), {}), 'not-an-edit');
  });

  it('drops an update whose content did not change when the old message is cached', () => {
    assert.equal(editForwardDecision({ partial: false, content: 'zz new text' }, guildMsg(), {}), 'unchanged');
  });

  it('forwards an edit of an uncached (partial) message — old content unknown', () => {
    assert.equal(editForwardDecision({ partial: true, content: null }, guildMsg(), {}), 'forward');
  });

  it('keeps the existing no-content and self-author drops', () => {
    assert.equal(editForwardDecision(null, guildMsg({ content: '' }), {}), 'no-content');
    assert.equal(editForwardDecision(null, guildMsg({ author: { id: 'bot' } }), { selfId: 'bot' }), 'self');
  });

});

describe('edit/delete push events', () => {
  type EditHandler = (c: string, m: string, t: string, isDM: boolean, info?: MessageEventInfo) => void;
  type DeleteHandler = (c: string, m: string, isDM: boolean, info?: MessageEventInfo) => void;

  function wire(subscribed = true): { server: DiscordMcplServer; edit: EditHandler; del: DeleteHandler; sent: Array<{ method: string; params: any }> } {
    const server = new DiscordMcplServer({} as DiscordAdapter);
    const s = server as unknown as Record<string, unknown>;
    let edit: EditHandler | undefined;
    let del: DeleteHandler | undefined;
    const noop = () => {};
    s.discord = {
      botUserId: 'bot',
      onMessage: noop, onReaction: noop,
      onChannelCreate: noop, onChannelDelete: noop, onGuildCreate: noop, onChannelAvailable: noop,
      onMessageEdit: (h: EditHandler) => { edit = h; },
      onMessageDelete: (h: DeleteHandler) => { del = h; },
    };
    const sent: Array<{ method: string; params: any }> = [];
    s.conn = { sendRequest: (method: string, params: unknown) => { sent.push({ method, params }); return Promise.resolve({}); } };
    s.mcplEnabled = true;
    (s.enabledFeatureSets as Set<string>).add('discord.messaging');
    (s.ensureSubscriptionsLoaded as () => void).call(server);
    if (subscribed) (s.subscribedChannels as Set<string>).add('chan1');
    (s.setupDiscordForwarding as () => void).call(server);
    assert.ok(edit && del, 'edit/delete handlers registered');
    return { server, edit: edit!, del: del!, sent };
  }

  function open(server: DiscordMcplServer): ChannelManager {
    const manager = (server as any).channelManager as ChannelManager;
    manager.register(toDescriptor('g1', 'Guild', { id: 'chan1', name: 'general', type: 'text', label: '#general (Guild)' }));
    manager.open('discord:g1:chan1');
    return manager;
  }

  it('open-but-unsubscribed channels receive edits and deletes exactly once', () => {
    const { server, edit, del, sent } = wire(false);
    open(server);
    edit('chan1', 'm1', 'updated', false, { guildId: 'g1' });
    del('chan1', 'm1', false, { guildId: 'g1' });
    // Occurrence ids are unique per edit/delete (RFC-006 §3.1): a fixed
    // `discord_edit_<id>` collided with itself at the host's dedup.
    assert.deepEqual(sent.map(({ method, params }) => [method, params.eventId.replace(/_[^_]+_\d+$/, ''), params.origin.mcplChannelId]), [
      ['push/event', 'discord_edit_m1', 'discord:g1:chan1'],
      ['push/event', 'discord_delete_m1', 'discord:g1:chan1'],
    ]);
    assert.notEqual(sent[0].params.eventId, sent[1].params.eventId);
  });

  it('muting requires an explicit reopen before ambient creates and mutations resume', async () => {
    const { server, edit, del, sent } = wire();
    const manager = open(server);
    await (server as any).executeToolCall('mute_channel', { channelId: 'chan1' });
    assert.equal(manager.isOpen('discord:g1:chan1'), false);
    assert.equal((server as any).subscribedChannels.has('chan1'), false);
    edit('chan1', 'm1', 'updated', false, { guildId: 'g1' });
    del('chan1', 'm1', false, { guildId: 'g1' });
    assert.equal(sent.length, 0);
    assert.equal((server as any).shouldEnterContext('chan1', { isMention: true, guildId: 'g1' }), false);

    const unmuted = await (server as any).executeToolCall('unmute_channel', { channelId: 'chan1' });
    assert.match(unmuted, /channel_close.*channel_open/);
    assert.match(unmuted, /discord:g1:chan1/);
    edit('chan1', 'm2', 'updated', false, { guildId: 'g1' });
    del('chan1', 'm2', false, { guildId: 'g1' });
    const ambient = {
      id: 'm3', content: 'hello', cleanContent: 'hello', authorId: 'u1', authorName: 'someone',
      isBot: false, channelId: 'chan1', guildId: 'g1', mentions: [], attachments: [], timestamp: new Date(),
    };
    await (server as any).handleDiscordMessage(ambient);
    assert.equal(sent.length, 0);
    assert.equal((server as any).shouldEnterContext('chan1', { isMention: true, guildId: 'g1' }), true);
    await (server as any).handleDiscordMessage({ ...ambient, id: 'invitation', mentionsBotRole: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'push/event');
    sent.length = 0;

    (server as any).handleChannelClose({ channelId: 'discord:g1:chan1' });
    await (server as any).handleChannelOpen({ channelId: 'discord:g1:chan1', type: 'discord' });
    edit('chan1', 'm4', 'updated', false, { guildId: 'g1' });
    del('chan1', 'm4', false, { guildId: 'g1' });
    await (server as any).handleDiscordMessage({ ...ambient, id: 'm5' });
    assert.deepEqual(sent.map((e) => e.method), ['push/event', 'push/event', 'channels/incoming']);
  });

  it('muting also takes precedence over DM delivery', async () => {
    const { server, edit, del, sent } = wire(false);
    await (server as any).executeToolCall('mute_channel', { channelId: 'dmchan' });
    edit('dmchan', 'm1', 'updated', true, { guildId: null });
    del('dmchan', 'm1', true, { guildId: null });
    assert.deepEqual(sent, []);
  });

  it('open-and-subscribed channels receive each mutation only once', () => {
    const { server, edit, del, sent } = wire();
    open(server);
    edit('chan1', 'm1', 'updated', false, { guildId: 'g1' });
    del('chan1', 'm1', false, { guildId: 'g1' });
    assert.equal(sent.length, 2);
  });

  it('closing an unsubscribed channel drops subsequent mutations', () => {
    const { server, edit, del, sent } = wire(false);
    open(server).close('discord:g1:chan1');
    edit('chan1', 'm1', 'updated', false, { guildId: 'g1' });
    del('chan1', 'm1', false, { guildId: 'g1' });
    assert.deepEqual(sent, []);
  });

  it('an unrelated open channel does not admit a closed channel or unknown guild', () => {
    const { server, edit, del, sent } = wire(false);
    open(server);
    edit('other', 'm1', 'updated', false, { guildId: 'g1' });
    del('chan1', 'm2', false, { guildId: 'other' });
    del('chan1', 'm3', false);
    assert.deepEqual(sent, []);
  });

  it('open channels still respect MCPL and messaging feature gates', () => {
    const { server, edit, del, sent } = wire(false);
    open(server);
    (server as any).mcplEnabled = false;
    edit('chan1', 'm1', 'updated', false, { guildId: 'g1' });
    (server as any).mcplEnabled = true;
    (server as any).enabledFeatureSets.clear();
    del('chan1', 'm1', false, { guildId: 'g1' });
    assert.deepEqual(sent, []);
  });

  it('the same open-but-unsubscribed gate admits ambient creates via channels/incoming', async () => {
    const { server, sent } = wire(false);
    open(server);
    await (server as any).handleDiscordMessage({
      id: 'm1', content: 'hello', cleanContent: 'hello', authorId: 'u1', authorName: 'someone',
      isBot: false, channelId: 'chan1', guildId: 'g1', mentions: [], attachments: [], timestamp: new Date(),
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'channels/incoming');
    assert.equal(sent[0].params.messages[0].channelId, 'discord:g1:chan1');
  });

  it('a guild edit names its author and carries the guild + composite channel id', () => {
    const { edit, sent } = wire();
    edit('chan1', 'm1', 'zz fixed typo', false, { guildId: 'g1', authorId: 'u1', authorName: 'niston' });
    assert.equal(sent.length, 1);
    const { origin, payload } = sent[0]!.params;
    assert.equal(payload.content[0].text, '[message edited] niston: zz fixed typo');
    assert.equal(origin.guildId, 'g1');
    assert.equal(origin.mcplChannelId, 'discord:g1:chan1');
    assert.equal(origin.messageId, 'm1');
    assert.equal(origin.authorId, 'u1');
    assert.equal(origin.authorName, 'niston');
  });

  it('a DM edit carries no guild, so the host still composes discord:dm:<id>', () => {
    const { edit, sent } = wire();
    edit('dmchan', 'm2', 'zz hola', true, { guildId: null, authorId: 'u2', authorName: '_reim0n' });
    const { origin, payload } = sent[0]!.params;
    assert.equal(payload.content[0].text, '[message edited] _reim0n: zz hola');
    assert.equal(origin.guildId, undefined);
    assert.equal(origin.mcplChannelId, undefined);
  });

  it('an edit without author info keeps the old text shape', () => {
    const { edit, sent } = wire();
    edit('chan1', 'm3', 'zz text', false);
    assert.equal(sent[0]!.params.payload.content[0].text, '[message edited] zz text');
    assert.equal(sent[0]!.params.origin.guildId, undefined);
  });

  it('a guild delete carries the guild + composite channel id', () => {
    const { del, sent } = wire();
    del('chan1', 'm4', false, { guildId: 'g1' });
    const { origin, payload } = sent[0]!.params;
    assert.equal(payload.content[0].text, '[message deleted] m4');
    assert.equal(origin.mcplChannelId, 'discord:g1:chan1');
  });
});


describe('sparse gateway edit/delete locations', () => {
  function fixture() {
    const adapter = new DiscordAdapter({
      token: 'unused', guildIds: ['g1'], guildChannels: { g1: ['chan1', 'parent'] }, dmUsers: ['u1'],
    });
    const client = (adapter as any).client as Client;
    const sent: Array<{ kind: string; isDM: boolean; info?: MessageEventInfo }> = [];
    adapter.onMessageEdit((_c, _m, _t, isDM, info) => sent.push({ kind: 'edit', isDM, info }));
    adapter.onMessageDelete((_c, _m, isDM, info) => sent.push({ kind: 'delete', isDM, info }));
    const emit = client.emit.bind(client) as (event: string, ...args: unknown[]) => boolean;
    const message = (over: Record<string, unknown> = {}) => ({
      id: 'm1', channelId: 'chan1', guildId: null, partial: true, channel: null,
      content: 'edited', editedTimestamp: EDITED_AT, author: { id: 'u1', username: 'someone' }, ...over,
    });
    const mutations = async (msg: ReturnType<typeof message>) => {
      emit('messageUpdate', { partial: true }, msg);
      emit('messageDelete', msg);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return { adapter, client, sent, message, mutations };
  }

  it('uses a partial message packet guild id without fetching the deleted message', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    const fetch = t.mock.method(f.client.channels, 'fetch', async () => { throw new Error('unexpected fetch'); });
    await f.mutations(f.message({ guildId: 'g1' }));
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(f.sent.map((e) => [e.kind, e.isDM, e.info?.guildId]), [
      ['edit', false, 'g1'], ['delete', false, 'g1'],
    ]);
  });

  it('recovers guild metadata from the channel cache before DM filtering', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    f.client.channels.cache.set('chan1', { guildId: 'g1', parentId: null } as any);
    const fetch = t.mock.method(f.client.channels, 'fetch', async () => { throw new Error('unexpected fetch'); });
    await f.mutations(f.message({ author: { id: 'not-a-dm-contact', username: 'guild-user' } }));
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every((e) => !e.isDM && e.info?.guildId === 'g1'));
  });

  it('fetches an unknown channel and labels guild events correctly', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    const fetch = t.mock.method(f.client.channels, 'fetch', async () => ({ guildId: 'g1', parentId: null }));
    await f.mutations(f.message());
    assert.equal(fetch.mock.callCount(), 2);
    assert.ok(f.sent.every((e) => !e.isDM && e.info?.guildId === 'g1'));
    assert.equal(f.sent.length, 2);
  });

  it('keeps a slow edit before its later deletion without blocking another message', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    let resolveChannel!: (channel: any) => void;
    t.mock.method(f.client.channels, 'fetch', () => new Promise((resolve) => { resolveChannel = resolve; }));
    const edit = (f.adapter as any).handleMessageUpdate({ partial: true }, f.message());
    const del = (f.adapter as any).handleMessageDelete(f.message({ guildId: 'g1' }));
    await (f.adapter as any).handleMessageDelete(f.message({ id: 'm2', guildId: 'g1' }));
    assert.deepEqual(f.sent.map((e) => e.kind), ['delete'], 'another message is independent');
    resolveChannel({ guildId: 'g1', parentId: null });
    await Promise.all([edit, del]);
    assert.deepEqual(f.sent.map((e) => e.kind), ['delete', 'edit', 'delete']);
    assert.equal((f.adapter as any).messageEventDeliveries.size, 0);
  });

  it('a failed edit lookup still lets its following deletion through', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    let rejectChannel!: (error: Error) => void;
    t.mock.method(f.client.channels, 'fetch', () => new Promise((_resolve, reject) => { rejectChannel = reject; }));
    const edit = (f.adapter as any).handleMessageUpdate({ partial: true }, f.message());
    const rejected = assert.rejects(edit, /unavailable/);
    const del = (f.adapter as any).handleMessageDelete(f.message({ guildId: 'g1' }));
    rejectChannel(new Error('unavailable'));
    await Promise.all([rejected, del]);
    assert.deepEqual(f.sent.map((e) => e.kind), ['delete']);
    assert.equal((f.adapter as any).messageEventDeliveries.size, 0);
  });

  it('preserves thread-parent allowlists after resolving a sparse event', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    t.mock.method(f.client.channels, 'fetch', async () => ({ guildId: 'g1', parentId: 'parent' }));
    await f.mutations(f.message({ channelId: 'thread1' }));
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every((e) => !e.isDM));
  });

  it('fetches an uncached thread parent even when the packet already names the guild', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    const fetch = t.mock.method(f.client.channels, 'fetch', async () => ({ guildId: 'g1', parentId: 'parent' }));
    await f.mutations(f.message({ guildId: 'g1', channelId: 'thread1' }));
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every((e) => !e.isDM && e.info?.guildId === 'g1'));
  });

  it('keeps an uncached thread excluded when its resolved parent is not allowlisted', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    const fetch = t.mock.method(f.client.channels, 'fetch', async () => ({ guildId: 'g1', parentId: 'other-parent' }));
    await f.mutations(f.message({ guildId: 'g1', channelId: 'thread1' }));
    assert.equal(fetch.mock.callCount(), 2);
    assert.deepEqual(f.sent, []);
  });

  it('uses known parent metadata to exclude channels without a redundant fetch', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    const fetch = t.mock.method(f.client.channels, 'fetch', async () => { throw new Error('unexpected fetch'); });
    await f.mutations(f.message({
      guildId: 'g1', channelId: 'thread1', channel: { guildId: 'g1', parentId: 'other-parent' },
    }));
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(f.sent, []);
  });

  it('drops resolved guilds and channels outside the configured filters', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    t.mock.method(f.client.channels, 'fetch', async (id: string) => ({
      guildId: id === 'other-guild' ? 'g2' : 'g1', parentId: null,
    }));
    await f.mutations(f.message({ channelId: 'other-guild' }));
    await f.mutations(f.message({ channelId: 'blocked-channel' }));
    assert.deepEqual(f.sent, []);
  });

  it('only classifies a positively identified DM as a DM', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    await f.mutations(f.message({ channel: { type: ChannelType.DM, isDMBased: () => true } }));
    assert.deepEqual(f.sent.map((e) => [e.kind, e.isDM, e.info?.guildId]), [
      ['edit', true, null], ['delete', true, null],
    ]);
  });

  it('still applies the DM contact filter to edits after resolving the channel', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    const msg = f.message({ channel: { isDMBased: () => true }, author: { id: 'stranger' } });
    await (f.adapter as any).handleMessageUpdate({ partial: true }, msg);
    await (f.adapter as any).handleMessageUpdate({ partial: true }, { ...msg, author: null });
    assert.deepEqual(f.sent, []);
  });

  it('drops unresolved locations rather than assigning the DM namespace', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    t.mock.method(f.client.channels, 'fetch', async () => null);
    await f.mutations(f.message());
    assert.deepEqual(f.sent, []);
  });

  it('reports a failed channel lookup without emitting a false DM', async (t) => {
    const f = fixture();
    t.after(() => f.client.destroy());
    t.mock.method(f.client.channels, 'fetch', async () => { throw new Error('channel unavailable'); });
    const errors = t.mock.method(console, 'error', () => {});
    await f.mutations(f.message());
    assert.deepEqual(f.sent, []);
    assert.equal(errors.mock.callCount(), 2);
    assert.ok(errors.mock.calls.every((c) => c.arguments.join(' ').includes('channel unavailable')));
  });
});
