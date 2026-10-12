/**
 * Issue #26: empty env values must allow DMs, and contacts can change through
 * the existing filters file/tool without replacing the running adapter.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Collection, MessageType, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { loadFiltersFile, parseFiltersFromEnv, resolveStartupFilters } from '../src/filters.js';

function fixture(t: TestContext, dmUsers?: string[]) {
  const adapter = new DiscordAdapter({ token: 'unused', dmUsers });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  const delivered: string[] = [];
  adapter.onMessage((message) => delivered.push(message.authorId));
  function send(userId: string, guildId: string | null = null) {
    const message = {
      id: 'message-1', channelId: 'channel-1', guildId, channel: null,
      author: { id: userId, username: userId, bot: false },
      content: 'hello', cleanContent: 'hello', type: MessageType.Default,
      attachments: new Collection(), createdAt: new Date(),
      mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
    };
    (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', message);
  }
  return { adapter, delivered, send };
}

describe('DM whitelist environment and live adapter', () => {
  for (const raw of [undefined, '', '  \t\n', ' , , ']) {
    it('treats ' + JSON.stringify(raw) + ' as unrestricted through the gateway callback', (t) => {
      const filters = parseFiltersFromEnv(raw === undefined ? {} : { DISCORD_DM_USERS: raw });
      assert.equal(filters.dmUsers, undefined);
      const f = fixture(t, filters.dmUsers);
      f.send('new-correspondent');
      assert.deepEqual(f.delivered, ['new-correspondent']);
    });
  }

  it('trims and deduplicates a nonempty env whitelist and drops other DM senders', (t) => {
    const filters = parseFiltersFromEnv({ DISCORD_DM_USERS: ' user-1, user-2, user-1, ' });
    assert.deepEqual(filters.dmUsers, ['user-1', 'user-2']);
    const f = fixture(t, filters.dmUsers);
    f.send('user-1');
    f.send('stranger');
    f.send('user-2');
    assert.deepEqual(f.delivered, ['user-1', 'user-2']);
  });

  it('an explicit empty adapter list also permits DMs', (t) => {
    const f = fixture(t, []);
    f.send('anyone');
    assert.equal(f.adapter.getFilters().dmUsers, undefined);
    assert.deepEqual(f.delivered, ['anyone']);
  });

  it('changes the next DM decision on the same adapter, including clearing the list', (t) => {
    const f = fixture(t, ['user-1']);
    f.send('user-2');
    f.adapter.updateFilters({ dmUsers: ['user-2'] });
    f.send('user-1');
    f.send('user-2');
    f.adapter.updateFilters({ dmUsers: [] });
    f.send('stranger');
    assert.deepEqual(f.delivered, ['user-2', 'stranger']);
  });

  it('applies the DM whitelist only to DMs', (t) => {
    const f = fixture(t, ['user-1']);
    f.send('guild-author', 'guild-1');
    assert.deepEqual(f.delivered, ['guild-author']);
  });
});

describe('DM contacts through the existing filters file and tool', () => {
  function fileFixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), 'discord-dm-filters-'));
    const path = join(dir, 'filters.json');
    const previous = process.env.DISCORD_FILTERS_FILE;
    process.env.DISCORD_FILTERS_FILE = path;
    t.after(() => {
      if (previous === undefined) delete process.env.DISCORD_FILTERS_FILE;
      else process.env.DISCORD_FILTERS_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    });
    return path;
  }

  it('seeds an empty env as unrestricted and reads later file contacts', (t) => {
    const path = fileFixture(t);
    const startup = resolveStartupFilters(path, { DISCORD_DM_USERS: '  , ' });
    assert.equal(startup.filters.dmUsers, undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
    const f = fixture(t, startup.filters.dmUsers);
    f.send('user-1');

    writeFileSync(path, JSON.stringify({ dmUsers: ['user-2'] }));
    // Exercise the poller's load/apply components directly, rather than
    // the index.ts interval timer. The adapter stays live throughout.
    const next = loadFiltersFile(path);
    assert.ok(next);
    f.adapter.updateFilters(next);
    f.send('user-1');
    f.send('user-2');
    assert.deepEqual(f.delivered, ['user-1', 'user-2']);
  });

  it('filters_update persists and immediately applies contacts without disturbing other file keys', async (t) => {
    const path = fileFixture(t);
    const current = { guildIds: ['guild-1'], dmUsers: ['user-1'], suppressedReactionEmojis: ['marker'] };
    writeFileSync(path, JSON.stringify(current));
    const f = fixture(t, current.dmUsers);
    f.adapter.updateFilters(current);
    const server = new DiscordMcplServer(f.adapter);
    server.filtersState.applyParsed(current);
    const call = (server as unknown as {
      executeToolCall(name: string, args: Record<string, unknown>): Promise<any>;
    }).executeToolCall.bind(server);

    f.send('user-2');
    const result = await call('filters_update', { setDmUsers: ['user-1', 'user-2'] });
    assert.deepEqual(result.applied.dmUsers, ['user-1', 'user-2']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...current, dmUsers: ['user-1', 'user-2'] });
    f.send('user-2');
    const status = await call('filters_get', {});
    assert.equal(status.hotAdjustable, true);
    assert.deepEqual(status.dmUsers, ['user-1', 'user-2']);

    await call('filters_update', { setDmUsers: [] });
    f.send('stranger');
    assert.equal((await call('filters_get', {})).dmUsers, null);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      guildIds: ['guild-1'], suppressedReactionEmojis: ['marker'],
    });
    assert.deepEqual(f.delivered, ['user-2', 'stranger']);
  });

  it('an unreadable contacts file refuses tool updates and retains the last live whitelist', async (t) => {
    const path = fileFixture(t);
    writeFileSync(path, '{unfinished');
    const f = fixture(t, ['user-1']);
    const server = new DiscordMcplServer(f.adapter);
    const call = (server as unknown as {
      executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    }).executeToolCall.bind(server);

    await assert.rejects(call('filters_update', { setDmUsers: ['user-2'] }), /cannot be parsed/);
    assert.equal(readFileSync(path, 'utf8'), '{unfinished');
    f.send('user-1');
    f.send('user-2');
    assert.deepEqual(f.delivered, ['user-1']);
  });
});
