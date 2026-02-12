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
 *   DISCORD_GUILD_ID  - Optional: Comma-separated guild ID filter
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

  const guildIds = process.env.DISCORD_GUILD_ID?.split(',').map((s) => s.trim()).filter(Boolean);

  // Connect Discord first
  const discord = new DiscordAdapter({ token, guildIds });

  const discordReady = new Promise<void>((resolve) => {
    discord.onReady(() => {
      console.error(`[discord-mcpl] Discord connected as bot ${discord.botUserId}`);
      resolve();
    });
  });

  await discord.connect();
  await discordReady;

  const server = new DiscordMcplServer(discord);

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
