import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { toDescriptor } from '../src/channels.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: TestContext) {
  const adapter = new DiscordAdapter({
    token: 'unused', guildIds: ['g1'], guildChannels: { g1: ['chan1', 'parent'] },
  });
  const client = adapter.rawClient;
  t.after(() => client.destroy());
  const server = new DiscordMcplServer(adapter);
  const s = server as any;
  const sent: Array<{ method: string; params: any }> = [];
  s.conn = {
    sendRequest: (method: string, params: unknown) => {
      sent.push({ method, params });
      return Promise.resolve({});
    },
  };
  s.mcplEnabled = true;
  s.enabledFeatureSets.add('discord.messaging');
  s.subscriptionsLoaded = true;
  s.mutedLoaded = true;
  s.setupDiscordForwarding();

  function open(channelId: string) {
    const descriptor = toDescriptor('g1', 'Guild', {
      id: channelId, name: channelId, type: 'text', label: '#' + channelId,
    });
    s.channelManager.register(descriptor);
    s.channelManager.open(descriptor.id);
  }
  open('chan1');
  const emit = client.emit.bind(client) as (event: string, ...args: unknown[]) => boolean;
  const message = (id: string, over: Record<string, unknown> = {}) => ({
    id, channelId: 'chan1', guildId: 'g1', channel: null, author: null, partial: true,
    ...over,
  });
  function bulk(messages: ReturnType<typeof message>[]) {
    emit('messageDeleteBulk', new Collection(messages.map((m) => [m.id, m])));
  }
  return { client, server: s, sent, open, emit, message, bulk };
}

/** Occurrence ids are unique per edit/delete (RFC-006 §3.1, #48):
 *  `discord_delete_<id>_<timestamp>_<n>`. These tests check the message part. */
const occurrence = (eventId: string): string => eventId.replace(/_[^_]+_\d+$/, '');

describe('bulk deletion delivery', () => {
  it('forwards one correctly located tombstone per collection member to an open channel', async (t) => {
    const f = fixture(t);
    f.bulk([f.message('m1'), f.message('m2')]);
    await settle();
    assert.deepEqual(f.sent.map(({ method, params }) => ({
      method, id: occurrence(params.eventId), channel: params.origin.mcplChannelId,
      text: params.payload.content[0].text,
    })), [
      { method: 'push/event', id: 'discord_delete_m1', channel: 'discord:g1:chan1', text: '[message deleted] m1' },
      { method: 'push/event', id: 'discord_delete_m2', channel: 'discord:g1:chan1', text: '[message deleted] m2' },
    ]);
  });

  it('uses the same mute and closed-channel exclusions as individual deletions', async (t) => {
    const f = fixture(t);
    await f.server.executeToolCall('mute_channel', { channelId: 'chan1' });
    f.bulk([f.message('muted1'), f.message('muted2')]);
    await settle();
    assert.deepEqual(f.sent, []);

    await f.server.executeToolCall('unmute_channel', { channelId: 'chan1' });
    f.server.channelManager.close('discord:g1:chan1');
    f.bulk([f.message('closed1'), f.message('closed2')]);
    await settle();
    assert.deepEqual(f.sent, []);
  });

  it('resolves uncached thread parents and retains the thread namespace for each member', async (t) => {
    const f = fixture(t);
    f.open('thread1');
    t.mock.method(f.client.channels, 'fetch', async () => ({ guildId: 'g1', parentId: 'parent' }));
    f.bulk([
      f.message('m1', { channelId: 'thread1' }),
      f.message('m2', { channelId: 'thread1' }),
    ]);
    await settle();
    assert.deepEqual(f.sent.map((e) => [occurrence(e.params.eventId), e.params.origin.mcplChannelId]), [
      ['discord_delete_m1', 'discord:g1:thread1'],
      ['discord_delete_m2', 'discord:g1:thread1'],
    ]);
  });

  it('keeps a bulk tombstone after its earlier slow edit while other members proceed', async (t) => {
    const f = fixture(t);
    let resolveChannel!: (channel: any) => void;
    t.mock.method(f.client.channels, 'fetch', () => new Promise((resolve) => { resolveChannel = resolve; }));
    f.emit('messageUpdate', { partial: true }, f.message('m1', {
      guildId: null, content: 'edited', editedTimestamp: 1790000000000,
      author: { id: 'u1', username: 'someone' },
    }));
    f.bulk([f.message('m1'), f.message('m2')]);
    await settle();
    assert.deepEqual(f.sent.map((e) => occurrence(e.params.eventId)), ['discord_delete_m2']);

    resolveChannel({ guildId: 'g1', parentId: null });
    await settle();
    assert.deepEqual(f.sent.map((e) => occurrence(e.params.eventId)), [
      'discord_delete_m2', 'discord_edit_m1', 'discord_delete_m1',
    ]);
  });

  it('reports a failed member lookup while still forwarding the other tombstones', async (t) => {
    const f = fixture(t);
    t.mock.method(f.client.channels, 'fetch', async () => { throw new Error('unavailable'); });
    const errors = t.mock.method(console, 'error', () => {});
    f.bulk([f.message('m1', { guildId: null }), f.message('m2')]);
    await settle();
    assert.deepEqual(f.sent.map((e) => occurrence(e.params.eventId)), ['discord_delete_m2']);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(' '), /unavailable/);
  });
});
