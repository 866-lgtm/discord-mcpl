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
 */

import * as net from 'node:net';
import { McplConnection } from '@connectome/mcpl-core';
import { DiscordAdapter } from './discord-adapter.js';
import { DiscordMcplServer } from './server.js';

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

  // DISCORD_GUILD_ID entries are either a bare guild id (all channels) or
  // `guildId:channelId+channelId+…` to whitelist specific channels in that
  // guild (threads under a whitelisted channel are included).
  //   e.g. DISCORD_GUILD_ID=111,222:333+444
  const rawGuilds = process.env.DISCORD_GUILD_ID?.split(',').map((s) => s.trim()).filter(Boolean);
  let guildIds: string[] | undefined;
  let guildChannels: Record<string, string[]> | undefined;
  if (rawGuilds?.length) {
    guildIds = [];
    for (const entry of rawGuilds) {
      const [gid, chans] = entry.split(':', 2);
      guildIds.push(gid);
      if (chans) {
        (guildChannels ??= {})[gid] = chans.split('+').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  const dmUsers = process.env.DISCORD_DM_USERS?.split(',').map((s) => s.trim()).filter(Boolean);

  // Connect Discord first
  const discord = new DiscordAdapter({ token, guildIds, guildChannels, dmUsers });

  const discordReady = new Promise<void>((resolve) => {
    discord.onReady(() => {
      console.error(`[discord-mcpl] Discord connected as bot ${discord.botUserId}`);
      resolve();
    });
  });

  await discord.connect();
  await discordReady;

  const server = new DiscordMcplServer(discord);

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
