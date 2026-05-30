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

import type { DiscordAdapter, DiscordMessageData } from './discord-adapter.js';
import { toolDefinitions } from './tools.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor } from './channels.js';
import { StateTracker } from './state.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
      // Sticky-reply: we hook afterInference to auto-post the agent's
      // text-only responses to the last-active channel. Blocking so the
      // host awaits the Discord round-trip before proceeding to the next
      // turn (10s timeout — plenty for a REST send). `beforeInference:
      // false` because we don't inject context that way (mcpl-core-ts
      // types ContextHooksCap with both fields required).
      contextHooks: {
        beforeInference: false,
        afterInference: { blocking: true },
      },
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

      case 'notifications/typing': {
        const p = notif.params as { channelId?: string };
        if (p.channelId) {
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
        const result = await this.discord.sendMessage(
          channelId,
          args.content as string,
        );
        this.stateTracker.recordSent(
          result.messageId,
          channelId,
          args.content as string,
        );
        const shifted = this.markOutboundSend(channelId);
        return this.augmentSendResult(result.messageId, channelId, shifted);
      }

      case 'reply_message': {
        const channelId = args.channelId as string;
        const result = await this.discord.sendMessage(
          channelId,
          args.content as string,
          { replyTo: args.messageId as string },
        );
        this.stateTracker.recordSent(
          result.messageId,
          channelId,
          args.content as string,
        );
        const shifted = this.markOutboundSend(channelId);
        return this.augmentSendResult(result.messageId, channelId, shifted);
      }

      case 'send_dm': {
        const result = await this.discord.sendDM(
          args.userId as string,
          args.content as string,
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

  /** Build the tool-result object for a successful send_*. Always includes
   *  the messageId; when the sticky channel just shifted as a side effect
   *  of this send, also includes a human-readable note + the new sticky
   *  channelId so the agent gets a clear signal that her text-only
   *  replies will route to the new place from now on. */
  private async augmentSendResult(
    messageId: string,
    channelId: string,
    shifted: boolean,
  ): Promise<{ messageId: string; stickyChannel?: string; note?: string }> {
    if (!shifted) {
      return { messageId };
    }
    // Best-effort channel describe — falls back to the raw id if anything
    // goes wrong, never throws.
    let label = channelId;
    try {
      const desc = await this.discord.describeChannel(channelId);
      label = desc.label;
    } catch {
      // keep the id
    }
    return {
      messageId,
      stickyChannel: channelId,
      note:
        `Sticky channel is now ${label}. Plain-text responses in your next ` +
        `turn will auto-route here until a new inbound from elsewhere ` +
        `(or another explicit send) moves it.`,
    };
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

  /** Handle the host's context/afterInference request. If the agent's
   *  response was text-only (no send_* tool call) and there's a sticky
   *  channel from a recent interaction, post the text there as if she'd
   *  called send_message. Empty text and chx-noop strings are skipped. */
  private async handleAfterInference(params: unknown): Promise<void> {
    const p = (params ?? {}) as { assistantMessage?: string };
    const text = (typeof p.assistantMessage === 'string' ? p.assistantMessage : '').trim();
    const channelId = this.lastChannelId;
    const replyTo = this.lastInboundMessageId;
    const wasSent = this.sentInCurrentTurn;
    // Reset turn state immediately — regardless of what we do below, the
    // next inference is a fresh turn.
    this.sentInCurrentTurn = false;

    if (!this.stickyReplyEnabled) {
      dbg('afterInference:skip', { reason: 'disabled-by-env' });
      return;
    }
    if (wasSent) {
      dbg('afterInference:skip', { reason: 'agent-sent-via-tool' });
      return;
    }
    if (!text) {
      dbg('afterInference:skip', { reason: 'empty-text' });
      return;
    }
    if (!channelId) {
      dbg('afterInference:skip', { reason: 'no-sticky-channel', textPreview: text.slice(0, 80) });
      return;
    }
    if (text.startsWith(CHX_NOOP_PREFIX)) {
      dbg('afterInference:skip', { reason: 'chx-noop' });
      return;
    }
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) {
      dbg('afterInference:skip', { reason: 'discord.messaging-not-enabled' });
      return;
    }

    try {
      const result = await this.discord.sendMessage(
        channelId,
        text,
        replyTo ? { replyTo } : undefined,
      );
      dbg('afterInference:sent', {
        channelId,
        messageId: result.messageId,
        hadReplyTo: !!replyTo,
        textLen: text.length,
      });
      // Clear replyTo after using it so subsequent auto-sends post as
      // standalone messages rather than chaining replies to the same
      // inbound. (Sticky channel stays.)
      this.lastInboundMessageId = null;
    } catch (err) {
      const e = err as Error;
      console.error('[discord-mcpl] sticky-reply auto-send failed:', e.message);
      dbg('afterInference:send-failed', {
        channelId,
        error: e.message,
        errorName: e.name,
      });

      // Surface the failure back into the agent's chronicle so it is visible
      // rather than a silent divergence between her memory and the world. The
      // event uses a "[discord-send-failed]" prefix so recipes can add a wake
      // policy with a `filter` matching that prefix to enter-without-triggering
      // (avoiding a retry loop on persistent failures). Without such a policy,
      // the agent will simply wake on it and may respond.
      if (this.conn && this.mcplEnabled && isEnabled('discord.messaging', this.enabledFeatureSets)) {
        const errPreview = (e.message || String(e)).slice(0, 240);
        this.conn.sendRequest(method.PUSH_EVENT, {
          featureSet: 'discord.messaging',
          eventId: `discord_send_failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          origin: { source: 'discord', channelId, kind: 'send-failed', errorName: e.name },
          payload: { content: [textContent(
            `[discord-send-failed] Your auto-reply to channel ${channelId} was not delivered: ${errPreview}. ` +
            `The text remains in your chronicle.`,
          )] },
        } satisfies PushEventParams).catch(() => {});
      }
    }
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
    // Direct @-mention OR a reply to one of the bot's own messages.
    // Discord's "ping replied user" toggle controls only whether the
    // bot appears in msg.mentions; the reply itself is addressed to the
    // bot either way, so we treat both as the same flavor of "direct
    // address" for wake + subscription-bypass purposes.
    const isReplyToBot = botId !== null && msg.replyToUserId === botId;
    const isMention =
      (botId !== null && msg.mentions.includes(botId)) || isReplyToBot;
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
          return `[${ts}] ${m.authorName}: ${m.cleanContent}`;
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

    // If this channel is open, use channels/incoming
    if (channelIsOpen) {
      const incomingParams: ChannelsIncomingParams = {
        messages: [{
          channelId: channelMcplId,
          messageId: msg.id,
          threadId: msg.threadId,
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: [textContent(renderedContent)],
          metadata: {
            mentions: msg.mentions,
            replyTo: msg.replyToId,
            channelName: msg.channelName,
            guildName: msg.guildName,
            threadName: msg.threadName,
            rawContent: msg.content,
            isMention,
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
          isDM,
        } as Record<string, unknown>,
        payload: {
          content: [textContent(renderedContent)],
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
