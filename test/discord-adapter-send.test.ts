import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Client } from 'discord.js';

const { DiscordAdapter } = await import('../src/discord-adapter.js');

describe('sendMessage channel lookup errors', () => {
  const adapter = new DiscordAdapter({ token: 'not-used', guildIds: [] });
  const client = (adapter as unknown as { client: Client }).client;
  const channels = client.channels as unknown as {
    fetch: (id: string) => Promise<unknown>;
  };

  after(() => {
    client.destroy();
  });

  it('rewrites Unknown Channel (10003) into a list_channels hint', async () => {
    channels.fetch = async () => {
      const err = new Error('Unknown Channel') as Error & { code: number };
      err.code = 10003;
      throw err;
    };
    await assert.rejects(
      adapter.sendMessage('1490016589448482859', 'hi'),
      (err: Error) => {
        assert.match(err.message, /list_channels/);
        assert.match(err.message, /1490016589448482859/);
        return true;
      },
    );
  });

  it('passes other fetch errors through unchanged', async () => {
    channels.fetch = async () => {
      const err = new Error('Missing Access') as Error & { code: number };
      err.code = 50001;
      throw err;
    };
    await assert.rejects(adapter.sendMessage('123', 'hi'), /Missing Access/);
  });

  it('points at list_channels for non-text channels too', async () => {
    channels.fetch = async () => null;
    await assert.rejects(adapter.sendMessage('123', 'hi'), /list_channels/);
  });
});
