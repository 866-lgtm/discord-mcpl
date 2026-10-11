/**
 * Slash commands are dispatched without being awaited, so a handler's
 * rejection must be caught at the dispatch: on Node >= 15 an unhandled
 * rejection ends the process. Discord refuses a late reply ("Unknown
 * interaction" once its 3-second acknowledgment window has passed).
 *
 * Run: node --import tsx --test test/slash-dispatch.test.ts
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';

test('a slash command whose handler rejects never becomes an unhandled rejection', async () => {
  let dispatch: ((interaction: unknown) => void) | undefined;
  const adapter = {
    onSlashCommand: (cb: (interaction: unknown) => void) => { dispatch = cb; },
    registerGuildCommands: async () => {},
  };
  const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter);
  await server.setupSlashCommands();
  assert.ok(dispatch);

  // Discord refuses a reply once its acknowledgment window has passed.
  const late = () => Promise.reject(new Error('Unknown interaction'));
  const interaction = {
    commandName: 'nudge',
    user: { id: 'admin-1', username: 'Admin' },
    channelId: 'c1',
    options: { getInteger: () => null, getString: () => null },
    reply: late,
    deferReply: late,
    editReply: late,
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const previous = process.env.DISCORD_ADMIN_USERS;
  process.env.DISCORD_ADMIN_USERS = 'admin-1';
  try {
    dispatch!(interaction);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (previous === undefined) delete process.env.DISCORD_ADMIN_USERS;
    else process.env.DISCORD_ADMIN_USERS = previous;
  }
});
