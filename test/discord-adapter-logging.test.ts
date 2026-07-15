import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Client } from 'discord.js';

const tempDir = mkdtempSync(join(tmpdir(), 'discord-mcpl-gateway-log-'));
const debugLog = join(tempDir, 'debug.log');
process.env.DISCORD_MCPL_DEBUG_LOG = debugLog;

const { DiscordAdapter } = await import('../src/discord-adapter.js');

interface LogEntry {
  tag: string;
  info: Record<string, unknown>;
}

function entries(): LogEntry[] {
  return readFileSync(debugLog, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\S+ (\S+) (.*)$/);
      assert.ok(match, `unexpected debug line: ${line}`);
      return { tag: match[1], info: JSON.parse(match[2]) as Record<string, unknown> };
    });
}

describe('Discord gateway diagnostics', () => {
  let adapter: InstanceType<typeof DiscordAdapter>;
  let client: Client;
  let emit: (event: string, ...args: unknown[]) => boolean;

  before(() => {
    adapter = new DiscordAdapter({ token: 'not-used', guildIds: ['allowed-guild'] });
    client = (adapter as unknown as { client: Client }).client;
    emit = client.emit.bind(client) as unknown as (event: string, ...args: unknown[]) => boolean;
  });

  after(() => {
    client.destroy();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('logs shard disconnect, reconnect, resume, and invalidation metadata', () => {
    emit('shardDisconnect', {
      code: 1006,
      reason: 'connection reset',
      wasClean: false,
    }, 0);
    emit('shardReconnecting', 0);
    emit('shardResume', 0, 17);
    emit('invalidated');

    const log = entries();
    assert.deepEqual(
      log.map(entry => entry.tag),
      [
        'gateway:shard-disconnect',
        'gateway:shard-reconnecting',
        'gateway:shard-resume',
        'gateway:invalidated',
      ],
    );
    assert.deepEqual(
      { code: log[0].info.code, reason: log[0].info.reason, wasClean: log[0].info.wasClean },
      { code: 1006, reason: 'connection reset', wasClean: false },
    );
    assert.equal(log[2].info.replayedEvents, 17);
  });

  it('logs message receipt and the pre-conversion filter outcome without content', () => {
    let delivered = false;
    adapter.onMessage(() => { delivered = true; });
    emit('messageCreate', {
      id: 'message-1',
      guildId: 'blocked-guild',
      channelId: 'channel-1',
      channel: { parentId: null },
      author: { id: 'user-1', bot: false },
      type: 0,
      attachments: new Map([['attachment-1', {}]]),
      mentions: { users: new Map([['bot-1', {}]]) },
      content: 'must not appear in diagnostics',
    });

    assert.equal(delivered, false);
    const log = entries().slice(-2);
    assert.deepEqual(log.map(entry => entry.tag), [
      'gateway:message-create',
      'gateway:message-create-drop',
    ]);
    assert.equal(log[0].info.attachmentCount, 1);
    assert.equal(log[1].info.reason, 'guild-not-allowed');
    assert.equal(JSON.stringify(log).includes('must not appear'), false);
  });
});
