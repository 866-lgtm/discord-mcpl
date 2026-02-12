/**
 * DiscordMcplServer — main MCPL server orchestrator.
 *
 * Handles the JSON-RPC main loop: initialize handshake, method dispatch,
 * and forwarding Discord events to the connected host.
 *
 * Follows the pattern from zero-k/game-manager/src/mcpl_server.rs.
 */

import {
  McplConnection,
  textContent,
  method,
  ERR_FEATURE_SET_NOT_ENABLED,
  ERR_UNKNOWN_FEATURE_SET,
  ERR_UNKNOWN_CHANNEL,
  ERR_CHECKPOINT_NOT_FOUND,
} from '@connectome/mcpl-core';

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  McplCapabilities,
  McplInitializeParams,
  McplInitializeResult,
  InitializeCapabilities,
  FeatureSetsUpdateParams,
  PushEventParams,
  PushEventResult,
  ChannelsRegisterParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelsIncomingParams,
  ChannelsIncomingResult,
  ChannelsListResult,
  StateRollbackParams,
  StateRollbackResult,
  ChannelDescriptor,
  ContentBlock,
} from '@connectome/mcpl-core';

import type { DiscordAdapter, DiscordMessageData } from './discord-adapter.js';
import { toolDefinitions } from './tools.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor } from './channels.js';
import { StateTracker } from './state.js';

export class DiscordMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private enabledFeatureSets = new Set<string>();
  private channelManager = new ChannelManager();
  private stateTracker = new StateTracker();

  constructor(private discord: DiscordAdapter) {}

  /**
   * Serve a single connection. Blocks until the connection closes.
   * The Discord adapter should already be connected before calling this.
   */
  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;

    // Set up Discord event forwarding
    this.setupDiscordForwarding();

    // Handshake
    await this.handleInitialize();

    // If MCPL is enabled, register all visible Discord channels
    if (this.mcplEnabled) {
      await this.registerDiscordChannels();
    }

    // Main loop
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          await this.handleRequest(msg.request);
        } else {
          this.handleNotification(msg.notification);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'ConnectionClosedError') {
        console.log('[discord-mcpl] Client disconnected');
      } else {
        console.error('[discord-mcpl] Connection error:', err);
      }
    }

    this.conn = null;
  }

  // ── Initialize Handshake ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;

    // Wait for initialize request
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      console.error('[discord-mcpl] Expected initialize request, got:', msg);
      conn.close();
      return;
    }

    const params = msg.request.params as McplInitializeParams | undefined;

    // Detect MCPL support
    const clientMcpl = params?.capabilities?.experimental?.mcpl;
    this.mcplEnabled = clientMcpl !== undefined;

    // Build server capabilities
    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      channels: true,
      rollback: true,
      featureSets,
    };

    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled && {
        experimental: { mcpl: serverCaps },
      }),
    };

    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'discord-mcpl', version: '0.1.0' },
    };

    conn.sendResponse(msg.request.id, result);

    // Wait for initialized notification
    const initedMsg = await conn.nextMessage();
    if (initedMsg.type === 'notification' && initedMsg.notification.method === 'notifications/initialized') {
      console.log('[discord-mcpl] Client initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
    }

    // In MCPL mode, default all feature sets to enabled
    if (this.mcplEnabled) {
      for (const fs of featureSets) {
        this.enabledFeatureSets.add(fs.name);
      }
    }
  }

  // ── Request Dispatch ──

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'tools/list': {
          conn.sendResponse(req.id, { tools: toolDefinitions });
          break;
        }

        case 'tools/call': {
          const result = await this.handleToolCall(
            params.name as string,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_LIST: {
          const result: ChannelsListResult = {
            channels: this.channelManager.getAll(),
          };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_OPEN: {
          const openP = params as unknown as ChannelsOpenParams;
          const result = this.handleChannelOpen(openP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_CLOSE: {
          const closeP = params as unknown as ChannelsCloseParams;
          const closed = this.channelManager.close(closeP.channelId);
          const result: ChannelsCloseResult = { closed };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_PUBLISH: {
          const pubP = params as unknown as ChannelsPublishParams;
          const result = await this.handlePublish(pubP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.STATE_ROLLBACK: {
          const rollbackP = params as unknown as StateRollbackParams;
          const result = await this.handleRollback(rollbackP);
          conn.sendResponse(req.id, result);
          break;
        }

        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      conn.sendError(req.id, -32603, (err as Error).message);
    }
  }

  // ── Notification Dispatch ──

  private handleNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case method.FEATURE_SETS_UPDATE: {
        const p = notif.params as FeatureSetsUpdateParams;
        if (p.enabled) {
          for (const name of p.enabled) this.enabledFeatureSets.add(name);
        }
        if (p.disabled) {
          for (const name of p.disabled) this.enabledFeatureSets.delete(name);
        }
        break;
      }

      default:
        // Ignore unknown notifications
        break;
    }
  }

  // ── Tool Call Handling ──

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ContentBlock[]; isError?: boolean; state?: unknown }> {
    // Check feature set permission
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !isEnabled(fs, this.enabledFeatureSets)) {
      return {
        content: [textContent(`Feature set '${fs}' is not enabled`)],
        isError: true,
      };
    }

    try {
      const result = await this.executeToolCall(name, args);

      // Track checkpoints for rollback-enabled tools
      if (fs === 'discord.messaging') {
        const cpId = this.stateTracker.createCheckpoint();
        return {
          content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
          state: { checkpoint: cpId },
        };
      }

      return {
        content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
      };
    } catch (err) {
      return {
        content: [textContent((err as Error).message)],
        isError: true,
      };
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case 'send_message': {
        const result = await this.discord.sendMessage(
          args.channelId as string,
          args.content as string,
        );
        this.stateTracker.recordSent(
          result.messageId,
          args.channelId as string,
          args.content as string,
        );
        return { messageId: result.messageId };
      }

      case 'reply_message': {
        const result = await this.discord.sendMessage(
          args.channelId as string,
          args.content as string,
          { replyTo: args.messageId as string },
        );
        this.stateTracker.recordSent(
          result.messageId,
          args.channelId as string,
          args.content as string,
        );
        return { messageId: result.messageId };
      }

      case 'send_dm': {
        const result = await this.discord.sendDM(
          args.userId as string,
          args.content as string,
        );
        return { messageId: result.messageId };
      }

      case 'add_reaction':
        await this.discord.addReaction(
          args.channelId as string,
          args.messageId as string,
          args.emoji as string,
        );
        return 'Reaction added';

      case 'edit_message':
        await this.discord.editMessage(
          args.channelId as string,
          args.messageId as string,
          args.content as string,
        );
        return 'Message edited';

      case 'delete_message':
        await this.discord.deleteMessage(
          args.channelId as string,
          args.messageId as string,
        );
        return 'Message deleted';

      case 'list_guilds':
        return await this.discord.listGuilds();

      case 'list_channels':
        return await this.discord.listChannels(args.guildId as string);

      case 'fetch_history':
        return await this.discord.fetchHistory(
          args.channelId as string,
          { limit: (args.limit as number) ?? 50 },
        );

      case 'create_text_channel':
        return await this.discord.createTextChannel(
          args.guildId as string,
          args.name as string,
          args.categoryId as string | undefined,
        );

      case 'delete_channel':
        await this.discord.deleteChannel(args.channelId as string);
        return 'Channel deleted';

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── Channel Operations ──

  private async registerDiscordChannels(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) return;

    const textChannels = this.discord.getTextChannels();
    const descriptors = textChannels.map(({ guildId, guildName, channel }) =>
      toDescriptor(guildId, guildName, channel),
    );

    if (descriptors.length === 0) return;

    this.channelManager.registerAll(descriptors);

    const regParams: ChannelsRegisterParams = { channels: descriptors };
    try {
      await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
    } catch (err) {
      console.error('[discord-mcpl] Failed to register channels:', (err as Error).message);
    }
  }

  private handleChannelOpen(params: ChannelsOpenParams): ChannelsOpenResult {
    // Find matching channel by type + address
    const addr = params.address as { guildId?: string; channelId?: string } | undefined;
    if (params.type === 'discord' && addr?.guildId && addr?.channelId) {
      const desc = this.channelManager.openByDiscordId(addr.guildId, addr.channelId);
      if (desc) {
        return { channel: desc };
      }
    }

    // Try to find by iterating registered channels
    for (const desc of this.channelManager.getAll()) {
      if (desc.type === params.type) {
        this.channelManager.open(desc.id);
        return { channel: desc };
      }
    }

    throw new Error('No matching channel found');
  }

  private async handlePublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      throw new Error(`Invalid channel ID: ${params.channelId}`);
    }

    // Extract text from content blocks
    const text = params.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (!text) {
      return { delivered: false, messageId: undefined };
    }

    const result = await this.discord.sendMessage(parsed.channelId, text);
    this.stateTracker.recordSent(result.messageId, parsed.channelId, text);

    return { delivered: true, messageId: result.messageId };
  }

  // ── Rollback ──

  private async handleRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    if (params.featureSet !== 'discord.messaging') {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: `Feature set '${params.featureSet}' does not support rollback`,
      };
    }

    const toDelete = this.stateTracker.rollback(params.checkpoint);
    if (toDelete === null) {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: 'Checkpoint not found',
      };
    }

    // Best-effort delete sent messages
    let deleted = 0;
    for (const msg of toDelete) {
      try {
        await this.discord.deleteMessage(msg.channelId, msg.discordMessageId);
        deleted++;
      } catch {
        // Best-effort — message may have been deleted by someone else
      }
    }

    return {
      checkpoint: params.checkpoint,
      success: true,
      reason: deleted < toDelete.length
        ? `Rolled back (${deleted}/${toDelete.length} messages deleted)`
        : undefined,
    };
  }

  // ── Discord Event Forwarding ──

  private setupDiscordForwarding(): void {
    this.discord.onMessage((msg) => {
      this.handleDiscordMessage(msg).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord message:', err);
      });
    });

    this.discord.onChannelCreate((guildId, channel) => {
      if (!this.conn || !this.mcplEnabled) return;
      const guild = this.discord.isConnected ? guildId : guildId;
      const desc = toDescriptor(guildId, guild, channel);
      this.channelManager.register(desc);
      this.conn.sendNotification(method.CHANNELS_CHANGED, {
        added: [desc],
      });
    });

    this.discord.onChannelDelete((guildId, channelId) => {
      if (!this.conn || !this.mcplEnabled) return;
      const id = mcplChannelId(guildId, channelId);
      this.channelManager.unregister(id);
      this.conn.sendNotification(method.CHANNELS_CHANGED, {
        removed: [id],
      });
    });
  }

  private async handleDiscordMessage(msg: DiscordMessageData): Promise<void> {
    const conn = this.conn;
    if (!conn) return;

    if (!this.mcplEnabled) return; // No push events in MCP-only mode

    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;

    const guildId = msg.guildId ?? 'dm';
    const channelMcplId = mcplChannelId(guildId, msg.channelId);

    // If this channel is open, use channels/incoming
    if (this.channelManager.isOpen(channelMcplId)) {
      const incomingParams: ChannelsIncomingParams = {
        messages: [{
          channelId: channelMcplId,
          messageId: msg.id,
          threadId: msg.threadId,
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: [textContent(msg.content)],
          metadata: { mentions: msg.mentions, replyTo: msg.replyToId },
        }],
      };

      try {
        await conn.sendRequest(method.CHANNELS_INCOMING, incomingParams);
      } catch (err) {
        console.error('[discord-mcpl] channels/incoming failed:', (err as Error).message);
      }
    } else {
      // Otherwise, use push/event
      const pushParams: PushEventParams = {
        featureSet: 'discord.messaging',
        eventId: `discord_msg_${msg.id}`,
        timestamp: msg.timestamp.toISOString(),
        origin: {
          source: 'discord',
          guildId: msg.guildId,
          channelId: msg.channelId,
          authorId: msg.authorId,
        },
        payload: {
          content: [textContent(`${msg.authorName}: ${msg.content}`)],
        },
      };

      try {
        await conn.sendRequest(method.PUSH_EVENT, pushParams);
      } catch (err) {
        console.error('[discord-mcpl] push/event failed:', (err as Error).message);
      }
    }
  }
}
