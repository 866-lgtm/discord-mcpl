import { it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { toDescriptor } from '../src/channels.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = adapter.rawClient;
  t.after(() => client.destroy());
  const server = new DiscordMcplServer(adapter) as any;
  const sent: any[] = [];
  server.conn = { sendRequest: (_method: string, params: unknown) => {
    sent.push(params);
    return Promise.resolve({});
  } };
  server.mcplEnabled = true;
  server.enabledFeatureSets.add('discord.messaging');
  server.subscriptionsLoaded = true;
  server.mutedLoaded = true;
  server.channelManager.register(toDescriptor('g1', 'Guild', {
    id: 'chan1', name: 'general', type: 'text', label: '#general (Guild)',
  }));
  server.channelManager.open('discord:g1:chan1');
  server.setupDiscordForwarding();
  const resolveChannels: Array<(channel: any) => void> = [];
  const fetch = t.mock.method(client.channels, 'fetch', () => new Promise((resolve) => resolveChannels.push(resolve)));
  const emit = client.emit.bind(client) as (event: string, ...args: unknown[]) => boolean;
  function mutation(kind: 'edit' | 'delete') {
    const message = {
      id: kind, channelId: 'chan1', guildId: null, channel: null, partial: true,
      author: { id: 'u1', username: 'someone' }, content: 'edited', editedTimestamp: 1790000000000,
    };
    if (kind === 'edit') emit('messageUpdate', { partial: true }, message);
    else emit('messageDelete', message);
  }
  const resolve = () => resolveChannels.forEach((done) => done({ guildId: 'g1', parentId: null }));
  return { server, sent, fetch, mutation, resolve };
}

for (const kind of ['edit', 'delete'] as const) {
  it('drops a ' + kind + ' received while muted before lookup, even if the channel reopens', async (t) => {
    const f = fixture(t);
    await f.server.executeToolCall('mute_channel', { channelId: 'chan1' });
    f.mutation(kind);
    await settle();
    await f.server.executeToolCall('unmute_channel', { channelId: 'chan1' });
    await f.server.handleChannelOpen({ channelId: 'discord:g1:chan1', type: 'discord' });
    f.resolve();
    await settle();
    assert.deepEqual(f.sent, []);
    assert.equal(f.fetch.mock.callCount(), 0, 'muted ingress requires no channel lookup');
  });

  it('drops a ' + kind + ' when muted after arrival but before its lookup completes', async (t) => {
    const f = fixture(t);
    f.mutation(kind);
    assert.equal(f.fetch.mock.callCount(), 1);
    await f.server.executeToolCall('mute_channel', { channelId: 'chan1' });
    f.resolve();
    await settle();
    assert.deepEqual(f.sent, []);
  });
}
