#!/usr/bin/env node
/**
 * Discord MCPL server — CLI entry point.
 *
 * Usage:
 *   discord-mcpl --stdio           # MCP-compatible stdio transport
 *   discord-mcpl --tcp <port>      # TCP transport for MCPL hosts
 *
 * Environment:
 *   DISCORD_TOKEN     - Required: Discord bot token
 *   DISCORD_GUILD_ID  - Optional: Comma-separated guild ID filter. Each entry
 *                       is `guildId` (all channels) or `guildId:chanId+chanId`
 *                       (whitelist those channels + their threads only)
 *   DISCORD_DM_USERS  - Optional: Comma-separated user ID whitelist for DMs.
 *                       When set, DMs from anyone else are dropped.
 *   DISCORD_ADMIN_USERS - Optional: Comma-separated user IDs allowed to use
 *                       admin slash commands (/undo). Unset = nobody.
 *   DISCORD_FILTERS_FILE - Optional: path to a JSON file holding the guild/
 *                       channel + DM whitelists (see filters.ts for schema).
 *                       When set, the file wins over DISCORD_GUILD_ID /
 *                       DISCORD_DM_USERS (and is seeded from them if absent),
 *                       and edits to it are HOT-RELOADED within ~3s — no
 *                       restart. Also enables the filters_get/filters_update
 *                       agent tools.
 */

import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { DiscordAdapter } from './discord-adapter.js';
import { DiscordMcplServer } from './server.js';
import {
  parseFiltersFromEnv,
  loadFiltersFile,
  saveFiltersFile,
  filtersFileMtime,
} from './filters.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useStdio = args.includes('--stdio');
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? parseInt(args[tcpIdx + 1], 10) : undefined;

  if (!useStdio && !tcpPort) {
    console.error('Usage: discord-mcpl --stdio | --tcp <port>');
    process.exit(1);
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN environment variable is required');
    process.exit(1);
  }

  // Event filters: env vars are the seed; DISCORD_FILTERS_FILE (when set)
  // becomes the live source of truth and is hot-reloaded below.
  const filtersFile = process.env.DISCORD_FILTERS_FILE;
  let filters = parseFiltersFromEnv();
  if (filtersFile) {
    const fromFile = loadFiltersFile(filtersFile);
    if (fromFile) {
      filters = fromFile;
      console.error(`[discord-mcpl] filters loaded from ${filtersFile}`);
    } else {
      try {
        saveFiltersFile(filtersFile, filters);
        console.error(`[discord-mcpl] filters file seeded from env -> ${filtersFile}`);
      } catch (err) {
        console.error(
          `[discord-mcpl] could not seed filters file ${filtersFile}:`,
          (err as Error).message,
        );
      }
    }
  }

  // Connect Discord first
  const discord = new DiscordAdapter({
    token,
    guildIds: filters.guildIds,
    guildChannels: filters.guildChannels,
    dmUsers: filters.dmUsers,
  });

  const discordReady = new Promise<void>((resolve) => {
    discord.onReady(() => {
      console.error(`[discord-mcpl] Discord connected as bot ${discord.botUserId}`);
      resolve();
    });
  });

  await discord.connect();
  await discordReady;

  const server = new DiscordMcplServer(discord);

  // Hot-reload: poll the filters file mtime and apply changes live. Covers
  // edits from any source (human, ops tooling, the filters_update tool —
  // which also applies its change directly; the poller is then an idempotent
  // no-op re-apply). Parse failures keep the previous filters (fail-safe).
  if (filtersFile) {
    let lastMtime = filtersFileMtime(filtersFile);
    const poll = setInterval(() => {
      const m = filtersFileMtime(filtersFile);
      if (m === null || m === lastMtime) return; // missing (mid-rename) or unchanged
      lastMtime = m;
      const next = loadFiltersFile(filtersFile);
      if (!next) {
        console.error(
          `[discord-mcpl] filters file changed but is unparseable — keeping previous filters (${filtersFile})`,
        );
        return;
      }
      const diff = discord.updateFilters(next);
      console.error(
        `[discord-mcpl] filters hot-reloaded from ${filtersFile} ` +
          `(guilds +${diff.addedGuilds.length}/-${diff.removedGuilds.length})`,
      );
      if (diff.addedGuilds.length) {
        // Newly-allowed guilds: make their channels known to the host.
        server.applyFilterChange();
      }
    }, 3000);
    poll.unref();
  }

  // Register slash commands (/undo) and wire the interaction handler.
  // Fail-open: command registration needs the applications.commands scope;
  // a failure shouldn't take down the surface.
  try {
    await server.setupSlashCommands();
    console.error('[discord-mcpl] Slash commands registered');
  } catch (err) {
    console.error('[discord-mcpl] Slash command setup failed:', (err as Error).message);
  }

  if (useStdio) {
    // Stdio transport — single client, MCP-compatible
    // Log to stderr (stdout is the protocol channel)
    console.error('[discord-mcpl] Starting on stdio');
    const conn = McplConnection.fromStreams(process.stdin, process.stdout);
    await server.serve(conn);
  } else if (tcpPort) {
    // TCP transport — single client
    console.error(`[discord-mcpl] Listening on TCP port ${tcpPort}`);
    const tcpServer = net.createServer();
    tcpServer.listen(tcpPort, '127.0.0.1');

    await new Promise<void>((resolve) => tcpServer.once('listening', resolve));

    // Accept and serve one connection at a time
    while (true) {
      const conn = await McplConnection.acceptTcp(tcpServer);
      console.error('[discord-mcpl] Client connected');
      await server.serve(conn);
      console.error('[discord-mcpl] Client disconnected, waiting for next...');
    }
  }
}

main().catch((err) => {
  console.error('[discord-mcpl] Fatal error:', err);
  process.exit(1);
});
