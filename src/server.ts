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
  ChannelsOutgoingChunkParams,
  ChannelsOutgoingCompleteParams,
} from '@connectome/mcpl-core';

import type { DiscordAdapter, DiscordMessageData, DiscordAttachment, OutgoingFile } from './discord-adapter.js';
import { toolDefinitions } from './tools.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor } from './channels.js';
import { StateTracker } from './state.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A Discord message must carry text and/or attachments — reject empty sends. */
function requireContentOrFiles(content: string, files: OutgoingFile[] | undefined): void {
  if ((!content || !content.trim()) && (!files || files.length === 0)) {
    throw new Error('Provide "content", "files", or both — a message cannot be empty.');
  }
}

/** chx-compat ignore prefix. ChapterX-style Discord bots send `m continue`
 *  as a no-op trigger to wake their model and immediately delete the message
 *  afterward, but messageCreate fires before the delete propagates, so the
 *  message would otherwise leak into Lena's chronicle as ambient noise.
 *  Match by prefix (`startsWith`) so trailing whitespace or auto-appended
 *  text doesn't slip through. Case-sensitive: a literal `m continue` only. */
const CHX_NOOP_PREFIX = 'm continue';

// Diagnostic file logger — bypasses the host's stderr capture (which has been
// observed to silently drop lines on some host builds). Set DISCORD_MCPL_DEBUG_LOG
// in the spawn env to a writable absolute path to enable; leave unset for no-op.
const _DEBUG_LOG_PATH = process.env.DISCORD_MCPL_DEBUG_LOG;
function dbg(tag: string, info: Record<string, unknown> = {}): void {
  if (!_DEBUG_LOG_PATH) return;
  try {
    appendFileSync(
      _DEBUG_LOG_PATH,
      `${new Date().toISOString()} ${tag} ${JSON.stringify(info)}\n`,
    );
  } catch {
    // Logging is best-effort; never break the server because of it.
  }
}

export class DiscordMcplServer {
  private conn: McplConnection | null = null;
  // Note: the location-header transition tracker and the sticky-reply
  // channel are the same thing — both want to know "where did
  // communication last happen, in either direction." Tracked in
  // `lastChannelId` below.

  /** Channels the agent has opted into for ambient (non-mention, non-DM)
   *  message delivery. Mentions and DMs always come through regardless of
   *  this set — it only gates passive awareness of channel chatter.
   *  Persisted to `DISCORD_SUBSCRIPTIONS_FILE` (a JSON file of channel IDs)
   *  so the subscription list survives restarts. Loaded eagerly at the
   *  first subscription-related call below. */
  private subscribedChannels = new Set<string>();
  private subscriptionsLoaded = false;

  /** Per-channel watermark of the highest Discord message id forwarded to
   *  the host. Used by the auto-subscribe-on-mention flow to fetch only
   *  the backscroll Lena hasn't already seen. In-memory only — resets on
   *  restart (acceptable: after restart, autobio context already has the
   *  prior conversation, and a fresh first-mention legitimately deserves
   *  fresh backscroll). */
  private forwardedWatermark = new Map<string, string>();

  /** How many backscroll messages to fetch on first interaction in a
   *  channel. Tunable via DISCORD_BACKSCROLL_LIMIT env var; clamped to
   *  [1, 300] (Discord's REST limit per fetch call is 100, but discord.js
   *  paginates above that — see messages.fetch). */
  private get backscrollLimit(): number {
    const raw = process.env.DISCORD_BACKSCROLL_LIMIT;
    if (!raw) return 80;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 300 ? n : 80;
  }

  // ── Sticky-channel auto-reply ──
  //
  // When the agent emits a text-only response (no send_* tool call), there's
  // nowhere for that text to go — it sits in chronicle as private narration
  // and the Discord user sees silence. To fix that, we hook MCPL's
  // `context/afterInference`: if the turn had no outgoing send, we treat the
  // assistant's text as a reply to whoever the agent last interacted with
  // and post it to that channel automatically. Direction-agnostic stickiness:
  // updated on every inbound message AND every outbound tool send.
  /** Most recently active Discord channel (in either direction). */
  private lastChannelId: string | null = null;
  /** The inbound messageId we should `replyTo` on the next auto-send.
   *  Set on inbound, cleared after first auto-send so subsequent text
   *  posts as top-level rather than chaining replies to the same message. */
  private lastInboundMessageId: string | null = null;
  /** True if the agent invoked any send_* tool during the current turn.
   *  Reset to false at the end of each `context/afterInference` call. */
  private sentInCurrentTurn = false;

  /** Whether the sticky-reply feature is enabled. Defaults on; set
   *  DISCORD_STICKY_REPLY=0 to disable (e.g. while debugging behavior). */
  private get stickyReplyEnabled(): boolean {
    const raw = process.env.DISCORD_STICKY_REPLY;
    if (raw === undefined) return true;
    return raw !== '0' && raw.toLowerCase() !== 'false';
  }
  private mcplEnabled = false;
  private enabledFeatureSets = new Set<string>();
  private channelManager = new ChannelManager();
  private stateTracker = new StateTracker();
  /** Buffers for channels/outgoing/chunk streams, keyed by inferenceId */
  private outgoingBuffers = new Map<string, { channelId: string; chunks: string[] }>();

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
    dbg('handleInitialize', {
      mcplEnabled: this.mcplEnabled,
      clientName: params?.clientInfo?.name,
      clientMcpl: clientMcpl ? 'present' : 'absent',
    });

    // Build server capabilities
    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      channels: true,
      rollback: true,
      featureSets,
      // NOTE: we intentionally no longer declare `contextHooks.afterInference`.
      // Output routing ("where does a plain-text reply go") is a HOST concern,
      // not a per-surface one — only the host sees the merged cross-surface
      // event stream and can pick the true conversational locus. The host
      // (agent-framework) now publishes text-only turns to the locus via
      // channels/publish; this server is a pure publish executor. The old
      // sticky auto-post that lived here would double-post against the host
      // router and races the moment a second surface (e.g. Telegram) exists.
      // See forking-knowledge-miner/docs/LOCUS-ROUTING-DESIGN.md.
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

        case method.CONTEXT_AFTER_INFERENCE: {
          // Sticky-reply hook: post text-only responses to the last-active
          // channel as if the agent had called send_message herself. Side
          // effect; no `modifiedResponse` returned (we don't rewrite her text).
          await this.handleAfterInference(params);
          conn.sendResponse(req.id, { featureSet: 'discord.messaging' });
          break;
        }

        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      // Capture the full error before reporting it. The previous version
      // dropped stack + tool/input context, which made transient failures
      // (Discord 5xx, rate-limit, missing permissions, etc.) untraceable
      // from the host side — we'd see "internal system error" without any
      // hint of which call failed.
      const e = err as Error;
      const isToolsCall = req.method === 'tools/call';
      const toolName = isToolsCall
        ? ((req.params as Record<string, unknown>)?.name as string | undefined)
        : undefined;
      const toolArgs = isToolsCall
        ? ((req.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined)
        : undefined;
      // Mirror to stderr so it shows up in any host-side stderr capture.
      console.error(
        `[discord-mcpl] handleRequest error: method=${req.method}`,
        toolName ? `tool=${toolName}` : '',
        e.stack ?? e.message,
      );
      dbg('handleRequest:error', {
        method: req.method,
        tool: toolName,
        // Truncate any long arg values so we don't dump full message bodies
        args: toolArgs
          ? Object.fromEntries(
              Object.entries(toolArgs).map(([k, v]) => [
                k,
                typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v,
              ]),
            )
          : undefined,
        error: e.message,
        errorName: e.name,
        // Stack is the most useful bit for diagnosing transient bugs.
        stack: e.stack?.split('\n').slice(0, 8).join('\n'),
      });
      conn.sendError(req.id, -32603, e.message);
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

      case method.CHANNELS_OUTGOING_CHUNK: {
        const p = notif.params as ChannelsOutgoingChunkParams;
        const buf = this.outgoingBuffers.get(p.inferenceId);
        if (buf) {
          buf.chunks[p.index] = p.delta;
        } else {
          const chunks: string[] = [];
          chunks[p.index] = p.delta;
          this.outgoingBuffers.set(p.inferenceId, { channelId: p.channelId, chunks });
        }
        break;
      }

      case method.CHANNELS_OUTGOING_COMPLETE: {
        const p = notif.params as ChannelsOutgoingCompleteParams;
        this.outgoingBuffers.delete(p.inferenceId);

        // Extract text and send to Discord
        const text = p.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

        if (text) {
          const parsed = parseMcplChannelId(p.channelId);
          if (parsed) {
            this.discord.sendMessage(parsed.channelId, text).catch((err) => {
              console.error('[discord-mcpl] outgoing/complete send failed:', (err as Error).message);
            });
          }
        }
        break;
      }

      // The host emits this as `channels/typing` (McplMethod.ChannelsTyping).
      // We also accept the legacy `notifications/typing` spelling for safety.
      case 'channels/typing':
      case 'notifications/typing': {
        const p = notif.params as { channelId?: string; op?: 'start' | 'stop' };
        // Discord has no explicit "stop typing" — the indicator auto-expires a
        // few seconds after the last trigger. So we act only on 'start' (and a
        // missing op counts as start); 'stop' is a no-op.
        if (p.channelId && p.op !== 'stop') {
          const parsed = parseMcplChannelId(p.channelId);
          if (parsed) {
            this.discord.sendTyping(parsed.channelId).catch(() => {});
          }
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
      // For all send_* tools below: update sticky-reply state so the
      // afterInference hook knows the agent explicitly chose a channel
      // this turn (don't double-post via auto-reply) and so the next
      // text-only turn auto-routes here.

      case 'send_message': {
        const channelId = args.channelId as string;
        const content = (args.content as string | undefined) ?? '';
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const result = await this.discord.sendMessage(channelId, content, { files });
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        return this.augmentSendResult(result.messageId, channelId, shifted);
      }

      case 'reply_message': {
        const channelId = args.channelId as string;
        const content = (args.content as string | undefined) ?? '';
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const result = await this.discord.sendMessage(
          channelId,
          content,
          { replyTo: args.messageId as string, files },
        );
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        return this.augmentSendResult(result.messageId, channelId, shifted);
      }

      case 'send_dm': {
        const content = (args.content as string | undefined) ?? '';
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const result = await this.discord.sendDM(
          args.userId as string,
          content,
          { files },
        );
        const shifted = this.markOutboundSend(result.channelId);
        return this.augmentSendResult(result.messageId, result.channelId, shifted);
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

      case 'refresh_channels':
        return this.refreshChannels();

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

      case 'subscribe_channel': {
        this.ensureSubscriptionsLoaded();
        const channelId = args.channelId as string;
        if (typeof channelId !== 'string' || channelId.length === 0) {
          throw new Error('channelId is required');
        }
        const wasNew = !this.subscribedChannels.has(channelId);
        this.subscribedChannels.add(channelId);
        if (wasNew) this.saveSubscriptions();
        return wasNew
          ? `Subscribed to ambient messages from channel ${channelId}.`
          : `Already subscribed to channel ${channelId}.`;
      }

      case 'unsubscribe_channel': {
        this.ensureSubscriptionsLoaded();
        const channelId = args.channelId as string;
        if (typeof channelId !== 'string' || channelId.length === 0) {
          throw new Error('channelId is required');
        }
        const removed = this.subscribedChannels.delete(channelId);
        if (removed) this.saveSubscriptions();
        return removed
          ? `Unsubscribed from ambient messages in channel ${channelId}. Mentions and DMs from there will still arrive.`
          : `Channel ${channelId} was not subscribed.`;
      }

      case 'list_subscriptions': {
        this.ensureSubscriptionsLoaded();
        return {
          channels: [...this.subscribedChannels].sort(),
          count: this.subscribedChannels.size,
          note:
            this.subscribedChannels.size === 0
              ? 'No ambient subscriptions. Mentions and DMs are always delivered.'
              : 'Ambient messages from these channels are delivered. Mentions and DMs always come through regardless.',
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── Sticky-reply state mutators ──

  /** Build the tool-result object for a successful send_*. Just the messageId
   *  now — the old "sticky channel is now X / your text-only replies route
   *  here" note was tied to the retired per-surface sticky and would be
   *  misleading under host-owned routing (the host routes plain-text turns to
   *  the conversational locus, i.e. the most recent *incoming* channel, not
   *  the last channel this bot sent to). `_shifted` is kept in the signature
   *  for call-site compatibility but no longer used. */
  private async augmentSendResult(
    messageId: string,
    _channelId: string,
    _shifted: boolean,
  ): Promise<{ messageId: string }> {
    return { messageId };
  }


  /** Called from every successful send_* tool dispatch. Updates the sticky
   *  channel to the just-sent destination, clears the replyTo target
   *  (we're now ahead of any inbound), and flags that the agent already
   *  spoke via tool this turn so the afterInference hook doesn't
   *  double-post the same text.
   *
   *  Returns true iff the sticky channel actually shifted to somewhere new
   *  — i.e., the agent sent to a different channel than the last
   *  communication context. Caller uses this to decide whether to announce
   *  the shift in the tool result (so Lena knows her text-only replies
   *  will now route to the new place). Returns false on first-ever send
   *  (no prior context to shift from) and on resends to the same channel. */
  private markOutboundSend(channelId: string): boolean {
    const prev = this.lastChannelId;
    const shifted = prev !== null && prev !== channelId;
    this.lastChannelId = channelId;
    this.lastInboundMessageId = null;
    this.sentInCurrentTurn = true;
    return shifted;
  }

  /** RETIRED: sticky auto-reply.
   *
   *  Output routing is now host-owned (the framework publishes text-only turns
   *  to the conversational locus via channels/publish — see
   *  LOCUS-ROUTING-DESIGN.md). This server no longer declares the
   *  `contextHooks.afterInference` capability, so the host won't call this. The
   *  stub is retained only so a stray afterInference request (e.g. from an
   *  older host that still calls it) is a harmless no-op rather than a
   *  double-post against the host router. */
  private async handleAfterInference(_params: unknown): Promise<void> {
    this.sentInCurrentTurn = false;
    dbg('afterInference:noop', { reason: 'sticky-retired-host-owns-routing' });
  }

  // ── Subscription persistence ──

  /** Path to the JSON file backing ambient-channel subscriptions.
   *  When unset, subscriptions are in-memory only (lost on restart). */
  private subscriptionsFile(): string | undefined {
    const p = process.env.DISCORD_SUBSCRIPTIONS_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  /** Lazy-load subscriptions from disk on first access. Idempotent. */
  private ensureSubscriptionsLoaded(): void {
    if (this.subscriptionsLoaded) return;
    this.subscriptionsLoaded = true;
    const path = this.subscriptionsFile();
    if (!path || !existsSync(path)) return;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id.length > 0) this.subscribedChannels.add(id);
        }
      }
      dbg('subscriptions:loaded', { count: this.subscribedChannels.size, path });
    } catch (err) {
      // Corrupt or unreadable file: start with empty set; don't fail boot.
      console.error('[discord-mcpl] Failed to load subscriptions:', (err as Error).message);
      dbg('subscriptions:load-failed', { error: (err as Error).message, path });
    }
  }

  private saveSubscriptions(): void {
    const path = this.subscriptionsFile();
    if (!path) return; // in-memory mode
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([...this.subscribedChannels].sort(), null, 2) + '\n');
    } catch (err) {
      console.error('[discord-mcpl] Failed to save subscriptions:', (err as Error).message);
      dbg('subscriptions:save-failed', { error: (err as Error).message, path });
    }
  }

  private isChannelSubscribed(channelId: string): boolean {
    this.ensureSubscriptionsLoaded();
    return this.subscribedChannels.has(channelId);
  }

  // ── Channel Operations ──

  private async registerDiscordChannels(): Promise<void> {
    const conn = this.conn;
    dbg('registerDiscordChannels:enter', { hasConn: !!conn, mcplEnabled: this.mcplEnabled });
    if (!conn || !this.mcplEnabled) {
      dbg('registerDiscordChannels:skip', { reason: !conn ? 'no-conn' : 'mcpl-disabled' });
      return;
    }

    const textChannels = this.discord.getTextChannels();
    const descriptors = textChannels.map(({ guildId, guildName, channel }) =>
      toDescriptor(guildId, guildName, channel),
    );
    dbg('registerDiscordChannels:enumerated', {
      count: descriptors.length,
      ids: descriptors.map(d => d.id),
    });

    if (descriptors.length === 0) {
      dbg('registerDiscordChannels:skip', { reason: 'no-channels' });
      return;
    }

    this.channelManager.registerAll(descriptors);

    const regParams: ChannelsRegisterParams = { channels: descriptors };
    try {
      await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
      dbg('registerDiscordChannels:sent', { count: descriptors.length });
    } catch (err) {
      console.error('[discord-mcpl] Failed to register channels:', (err as Error).message);
      dbg('registerDiscordChannels:send-failed', { error: (err as Error).message });
    }
  }

  /** Register the given descriptors and emit a single `channels/changed`
   *  notification for the ones that weren't already known. Idempotent:
   *  re-registering a known channel refreshes its descriptor (e.g. a renamed
   *  label) but does NOT re-announce it, so repeat calls (channelUpdate
   *  firing on every edit, or a manual refresh) don't spam the host. Returns
   *  the descriptors that were newly added. */
  private registerAndNotifyNew(descriptors: ChannelDescriptor[]): ChannelDescriptor[] {
    const added: ChannelDescriptor[] = [];
    for (const d of descriptors) {
      if (!this.channelManager.get(d.id)) added.push(d);
      this.channelManager.register(d);
    }
    if (added.length > 0 && this.conn && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { added });
    }
    return added;
  }

  /** Re-enumerate every channel currently visible to the bot and register any
   *  that the host doesn't yet know about. This is the agent-facing catch-all
   *  for "I was added to a channel/server but don't see it" — it doesn't rely
   *  on any specific gateway event having fired, so it covers cases the
   *  event handlers miss (missed events, eventual-consistency gaps, etc.). */
  private refreshChannels(): {
    visible: number;
    added: Array<{ id: string; label: string }>;
    note: string;
  } {
    const textChannels = this.discord.getTextChannels();
    const descriptors = textChannels.map(({ guildId, guildName, channel }) =>
      toDescriptor(guildId, guildName, channel),
    );
    const added = this.registerAndNotifyNew(descriptors);
    dbg('refreshChannels', { visible: descriptors.length, added: added.length });
    return {
      visible: descriptors.length,
      added: added.map((d) => ({ id: d.id, label: d.label })),
      note:
        added.length > 0
          ? `Registered ${added.length} newly-visible channel(s).`
          : 'No new channels — the host already knows about every visible channel.',
    };
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
      dbg('handlePublish:skip', { channelId: params.channelId, reason: 'empty-text' });
      return { delivered: false, messageId: undefined };
    }

    dbg('handlePublish', { channelId: params.channelId, textLen: text.length, preview: text.slice(0, 80) });
    const result = await this.discord.sendMessage(parsed.channelId, text);
    this.stateTracker.recordSent(result.messageId, parsed.channelId, text);
    dbg('handlePublish:sent', { channelId: params.channelId, messageId: result.messageId });

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

    this.discord.onMessageEdit((channelId, messageId, newContent) => {
      if (!this.conn || !this.mcplEnabled) return;
      if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      this.conn.sendRequest(method.PUSH_EVENT, {
        featureSet: 'discord.messaging',
        eventId: `discord_edit_${messageId}`,
        timestamp: new Date().toISOString(),
        origin: { source: 'discord', channelId },
        payload: { content: [textContent(`[message edited] ${newContent}`)] },
      } satisfies PushEventParams).catch(() => {});
    });

    this.discord.onMessageDelete((channelId, messageId) => {
      if (!this.conn || !this.mcplEnabled) return;
      if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      this.conn.sendRequest(method.PUSH_EVENT, {
        featureSet: 'discord.messaging',
        eventId: `discord_delete_${messageId}`,
        timestamp: new Date().toISOString(),
        origin: { source: 'discord', channelId },
        payload: { content: [textContent(`[message deleted] ${messageId}`)] },
      } satisfies PushEventParams).catch(() => {});
    });

    this.discord.onChannelCreate((guildId, channel) => {
      if (!this.conn || !this.mcplEnabled) return;
      const guildName = this.discord.getGuildName(guildId);
      this.registerAndNotifyNew([toDescriptor(guildId, guildName, channel)]);
    });

    // Bot joined a new guild after startup: register all of its existing
    // text channels so they show up in the host's channel list (channelCreate
    // only covers channels created *after* the join).
    this.discord.onGuildCreate((guildId, guildName, channels) => {
      if (!this.conn || !this.mcplEnabled) return;
      const descriptors = channels.map((c) => toDescriptor(guildId, guildName, c));
      const added = this.registerAndNotifyNew(descriptors);
      dbg('onGuildCreate', { guildId, guildName, total: channels.length, added: added.length });
    });

    // Bot was granted access to a pre-existing channel (permission overwrite).
    this.discord.onChannelAvailable((guildId, channel) => {
      if (!this.conn || !this.mcplEnabled) return;
      const guildName = this.discord.getGuildName(guildId);
      const added = this.registerAndNotifyNew([toDescriptor(guildId, guildName, channel)]);
      dbg('onChannelAvailable', { guildId, channelId: channel.id, added: added.length });
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

  /** Fetch + convert a message's attachments into MCPL content blocks so the
   *  agent actually sees them. Images are downloaded and inlined as base64
   *  image blocks (robust against Discord's expiring CDN URLs); text files are
   *  inlined as text; anything else degrades to a short note with name + URL.
   *  Best-effort: a failed fetch becomes a note rather than dropping the message. */
  private async buildAttachmentBlocks(attachments: DiscordAttachment[]): Promise<ContentBlock[]> {
    const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // ~4MB (Anthropic caps ~5MB/image)
    const MAX_TEXT_BYTES = 256 * 1024; // inline cap for text files
    const TEXT_EXT =
      /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|bash|zsh|toml|ini|cfg|conf|sql|diff|patch|env)$/i;
    const fmt = (n: number) =>
      n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
    const fetchWithTimeout = async (url: string, ms = 15000): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        return await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    };

    const blocks: ContentBlock[] = [];
    for (const att of attachments) {
      const ct = (att.contentType || '').toLowerCase();
      const isImage = ct.startsWith('image/');
      const isText =
        ct.startsWith('text/') ||
        TEXT_EXT.test(att.name) ||
        (att.contentType === null && att.size > 0 && att.size <= MAX_TEXT_BYTES);
      try {
        if (isImage) {
          if (att.size > MAX_IMAGE_BYTES) {
            blocks.push(textContent(`[image attachment "${att.name}" (${fmt(att.size)}) too large to inline — ${att.url}]`));
          } else {
            const res = await fetchWithTimeout(att.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
            blocks.push({ type: 'image', data: b64, mimeType: att.contentType || 'image/png' } as ContentBlock);
            blocks.push(textContent(`[image attachment: ${att.name}]`));
          }
        } else if (isText) {
          const res = await fetchWithTimeout(att.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          let txt = await res.text();
          let truncated = false;
          if (txt.length > MAX_TEXT_BYTES) {
            txt = txt.slice(0, MAX_TEXT_BYTES);
            truncated = true;
          }
          blocks.push(
            textContent(`[attachment: ${att.name} (${fmt(att.size)})]\n${txt}${truncated ? '\n…[truncated]' : ''}`),
          );
        } else {
          blocks.push(textContent(`[attachment: ${att.name} (${ct || 'unknown type'}, ${fmt(att.size)}) — not inlined: ${att.url}]`));
        }
        dbg('attachment', {
          name: att.name,
          contentType: att.contentType,
          size: att.size,
          kind: isImage ? 'image' : isText ? 'text' : 'other',
        });
      } catch (err) {
        blocks.push(textContent(`[attachment: ${att.name} — could not fetch (${(err as Error).message}); ${att.url}]`));
        dbg('attachment:failed', { name: att.name, error: (err as Error).message });
      }
    }
    return blocks;
  }

  private async handleDiscordMessage(msg: DiscordMessageData): Promise<void> {
    const conn = this.conn;
    dbg('handleDiscordMessage:enter', {
      msgId: msg.id,
      guildId: msg.guildId,
      channelId: msg.channelId,
      channelName: msg.channelName,
      authorId: msg.authorId,
      isBot: msg.isBot,
      mentions: msg.mentions,
      contentPreview: msg.content.slice(0, 80),
      hasConn: !!conn,
      mcplEnabled: this.mcplEnabled,
      enabledSets: [...this.enabledFeatureSets],
      botUserId: this.discord.botUserId,
    });
    // Drop chx-style `m continue` no-op triggers before any other processing.
    // These leak through messageCreate before they're deleted; if we forwarded
    // them they'd pollute chronicle and (worse) advance the watermark, which
    // could suppress legitimate auto-subscribe + backscroll for the channel.
    if (msg.content.startsWith(CHX_NOOP_PREFIX)) {
      dbg('handleDiscordMessage:drop', { reason: 'chx-noop', msgId: msg.id });
      return;
    }
    if (!conn) { dbg('handleDiscordMessage:drop', { reason: 'no-conn' }); return; }

    if (!this.mcplEnabled) { dbg('handleDiscordMessage:drop', { reason: 'mcpl-disabled' }); return; } // No push events in MCP-only mode

    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) {
      dbg('handleDiscordMessage:drop', { reason: 'discord.messaging-disabled', enabled: [...this.enabledFeatureSets] });
      return;
    }

    // Direct address (mention or DM) always reaches Lena. For ambient
    // (non-direct) messages, only forward when the channel is in her
    // subscription set — otherwise she'd get unbounded context noise
    // from every channel the bot can see. The wake decision is then
    // left to the host's gate policy via the `isMention`/`isDM` flags
    // we attach below; ambient deliveries enter chronicle with
    // `behavior: skip` (context yes, wake no).
    const botId = this.discord.botUserId;
    const isDM = msg.guildId === null;
    // Granular address signals. We expose these separately in the event
    // metadata so the host's wake gate can compose intentional policies —
    // notably: let a *bot* activate this bot only by an explicit @mention,
    // never by a mere reply. That breaks auto-reply loops between two bots
    // (a reply is structural; an @mention is deliberate) while humans keep
    // waking the bot via reply or mention as before.
    const isExplicitMention = botId !== null && msg.mentions.includes(botId);
    // Discord's "ping replied user" toggle controls only whether the bot
    // appears in msg.mentions; the reply itself is addressed to the bot
    // either way.
    const isReplyToBot = botId !== null && msg.replyToUserId === botId;
    const isBot = msg.isBot;
    // `isMention` (explicit OR reply) is retained for subscription-bypass /
    // backward compatibility only — the wake decision uses the granular
    // flags above via the gate.
    const isMention = isExplicitMention || isReplyToBot;
    if (!isMention && !isDM && !this.isChannelSubscribed(msg.channelId)) {
      dbg('handleDiscordMessage:drop', {
        reason: 'ambient-not-subscribed',
        channelId: msg.channelId,
        channelName: msg.channelName,
      });
      return;
    }

    // First-interaction handling: when we're about to forward our very first
    // message from this channel (this process), pull a chunk of backscroll
    // so Lena has context. For guild channels reached via mention, also
    // auto-subscribe and emit a system note so she knows she's now receiving
    // ambient messages (and how to opt out). DMs always come through, so no
    // subscription note for them — just the backscroll.
    this.ensureSubscriptionsLoaded();
    const isFirstInteraction = !this.forwardedWatermark.has(msg.channelId);
    let prefixBlock = '';
    if (isFirstInteraction && (isMention || isDM)) {
      const watermark = this.forwardedWatermark.get(msg.channelId);
      let backscrollMsgs: Awaited<ReturnType<typeof this.discord.fetchHistory>> = [];
      try {
        backscrollMsgs = await this.discord.fetchHistory(msg.channelId, {
          limit: this.backscrollLimit,
          before: msg.id, // never include the triggering message itself
          ...(watermark ? { after: watermark } : {}),
        });
        // discord.js returns newest-first; backscroll reads more naturally
        // oldest-first when Lena scans it as a transcript.
        backscrollMsgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        // Filter out:
        //  - the bot's own past messages — already in Lena's chronicle as
        //    assistant turns, no need to re-echo as user
        //  - chx-noop `m continue` triggers — same reason we drop them inbound
        backscrollMsgs = backscrollMsgs.filter(
          (m) => m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX),
        );
      } catch (err) {
        dbg('backscroll:fetch-failed', {
          channelId: msg.channelId,
          error: (err as Error).message,
        });
      }

      const blocks: string[] = [];
      // System note: only for guild channels (DMs don't have subscription
      // semantics — they always come through whether Lena likes it or not).
      if (!isDM) {
        const where = msg.channelName
          ? `#${msg.channelName}${msg.guildName ? ` in ${msg.guildName}` : ''}`
          : `channel ${msg.channelId}`;
        const wasSubscribed = this.subscribedChannels.has(msg.channelId);
        if (!wasSubscribed) {
          this.subscribedChannels.add(msg.channelId);
          this.saveSubscriptions();
        }
        blocks.push(
          `<system>Auto-subscribed to ${where} because you were mentioned. ` +
            `Ambient (non-mention) messages from this channel will now arrive in your context. ` +
            `Mentions and DMs always come through regardless of subscriptions. ` +
            `To stop ambient delivery from here: unsubscribe_channel("${msg.channelId}").</system>`,
        );
      }
      if (backscrollMsgs.length > 0) {
        const attrs: string[] = [];
        if (msg.channelName) attrs.push(`channel="#${msg.channelName}"`);
        if (msg.guildName) attrs.push(`guild=${JSON.stringify(msg.guildName)}`);
        else if (isDM) attrs.push('dm="true"');
        attrs.push(`count="${backscrollMsgs.length}"`);
        const open = `<backscroll ${attrs.join(' ')}>`;
        const lines = backscrollMsgs.map((m) => {
          const ts = m.timestamp.toISOString();
          const att = m.attachments && m.attachments.length > 0
            ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]`
            : '';
          return `[${ts}] ${m.authorName}: ${m.cleanContent}${att}`;
        });
        blocks.push([open, ...lines, '</backscroll>'].join('\n'));
      }
      if (blocks.length > 0) {
        prefixBlock = blocks.join('\n') + '\n';
        dbg('backscroll:emitted', {
          channelId: msg.channelId,
          backscrollCount: backscrollMsgs.length,
          autoSubscribed: !isDM,
        });
      }
    }

    const guildId = msg.guildId ?? 'dm';
    const channelMcplId = mcplChannelId(guildId, msg.channelId);
    const channelIsOpen = this.channelManager.isOpen(channelMcplId);
    dbg('handleDiscordMessage:forwarding', {
      channelMcplId,
      channelIsOpen,
      path: channelIsOpen ? 'channels/incoming' : 'push/event',
    });

    // discord.js's `cleanContent` resolves <@id> / <@&role> / <#channel>
    // mentions to @username / @role / #channel — always use that in the
    // rendered body so Lena never sees raw <@123456789> blobs.
    //
    // For the location header (which channel/guild we're in), only prepend
    // it when the message's channel differs from the last communication
    // channel (compare BEFORE updating the tracker). Outbound sends also
    // advance lastChannelId via markOutboundSend, so an inbound after Lena
    // sent elsewhere correctly gets a fresh header back to her original
    // conversation.
    const contextChanged = this.lastChannelId !== msg.channelId;
    let location = '';
    if (contextChanged) {
      const locationParts: string[] = [];
      if (msg.channelName) locationParts.push(`#${msg.channelName}`);
      if (msg.threadName) locationParts.push(`thread "${msg.threadName}"`);
      if (msg.guildName) locationParts.push(`in ${msg.guildName}`);
      else if (msg.guildId === null) locationParts.push('DM');
      if (locationParts.length > 0) location = `[${locationParts.join(' ')}] `;
    }
    const renderedContent = `${prefixBlock}${location}${msg.authorName}: ${msg.cleanContent}`;
    // Advance the watermark so future backscroll on this channel doesn't
    // re-include this message. Set regardless of which forwarding path we
    // take below (channels/incoming vs push/event) — what matters is that
    // we forwarded it.
    this.forwardedWatermark.set(msg.channelId, msg.id);
    // Update sticky-reply state: this inbound is now the "last
    // communication" for auto-reply routing, and the message we'd
    // replyTo on the next auto-send.
    this.lastChannelId = msg.channelId;
    this.lastInboundMessageId = msg.id;

    // Fetch + inline any attachments (images, text files) so the agent sees
    // them. Built once and appended to whichever forwarding path we take.
    const attachmentBlocks =
      msg.attachments.length > 0 ? await this.buildAttachmentBlocks(msg.attachments) : [];

    // If this channel is open, use channels/incoming
    if (channelIsOpen) {
      const incomingParams: ChannelsIncomingParams = {
        messages: [{
          channelId: channelMcplId,
          messageId: msg.id,
          threadId: msg.threadId,
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: [textContent(renderedContent), ...attachmentBlocks],
          metadata: {
            mentions: msg.mentions,
            replyTo: msg.replyToId,
            channelName: msg.channelName,
            guildName: msg.guildName,
            threadName: msg.threadName,
            rawContent: msg.content,
            isMention,
            isExplicitMention,
            isReplyToBot,
            isBot,
            isDM,
          },
        }],
      };

      try {
        await conn.sendRequest(method.CHANNELS_INCOMING, incomingParams);
        dbg('handleDiscordMessage:sent', { method: 'channels/incoming', channelMcplId });
      } catch (err) {
        console.error('[discord-mcpl] channels/incoming failed:', (err as Error).message);
        dbg('handleDiscordMessage:send-failed', { method: 'channels/incoming', error: (err as Error).message });
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
          guildName: msg.guildName,
          channelId: msg.channelId,
          channelName: msg.channelName,
          threadId: msg.threadId,
          threadName: msg.threadName,
          authorId: msg.authorId,
          authorName: msg.authorName,
          isMention,
          isExplicitMention,
          isReplyToBot,
          isBot,
          isDM,
        } as Record<string, unknown>,
        payload: {
          content: [textContent(renderedContent), ...attachmentBlocks],
        },
      };

      try {
        await conn.sendRequest(method.PUSH_EVENT, pushParams);
        dbg('handleDiscordMessage:sent', { method: 'push/event', channelMcplId });
      } catch (err) {
        console.error('[discord-mcpl] push/event failed:', (err as Error).message);
        dbg('handleDiscordMessage:send-failed', { method: 'push/event', error: (err as Error).message });
      }
    }
  }
}
