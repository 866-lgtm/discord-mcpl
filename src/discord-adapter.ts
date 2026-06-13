/**
 * Discord.js adapter for the Discord MCPL server.
 * Wraps discord.js, provides a clean callback + method interface.
 *
 * Based on patterns from agent-framework/src/modules/discord/discord-js-client.ts
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  TextChannel,
  DMChannel,
  ChannelType,
  AttachmentBuilder,
  type Message,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type User,
  type ChatInputCommandInteraction,
  type ApplicationCommandDataResolvable,
} from 'discord.js';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** Maximum attachments Discord accepts on a single message. */
const MAX_DISCORD_ATTACHMENTS = 10;

/** A file the agent wants to upload, read from a local path on the host. */
export interface OutgoingFile {
  /** Absolute local filesystem path to the file to upload. */
  path: string;
  /** Optional display filename (defaults to the basename of `path`). */
  name?: string;
  /** Optional alt-text / description shown for accessibility. */
  description?: string;
}

/**
 * Turn `OutgoingFile[]` specs into discord.js `AttachmentBuilder`s, validating
 * each path up front so a bad path yields a clear error rather than an opaque
 * discord.js failure mid-send. discord.js reads the path lazily at send time.
 */
function buildAttachments(files?: OutgoingFile[]): AttachmentBuilder[] {
  if (!files || files.length === 0) return [];
  if (files.length > MAX_DISCORD_ATTACHMENTS) {
    throw new Error(
      `Too many files: ${files.length} (Discord allows up to ${MAX_DISCORD_ATTACHMENTS} per message)`,
    );
  }
  return files.map((f) => {
    if (!f || typeof f.path !== 'string' || !f.path.trim()) {
      throw new Error('Each file must have a non-empty string "path"');
    }
    if (!existsSync(f.path) || !statSync(f.path).isFile()) {
      throw new Error(`File not found (or not a regular file): ${f.path}`);
    }
    const name = f.name && f.name.trim() ? f.name : basename(f.path);
    const attachment = new AttachmentBuilder(f.path, { name });
    if (f.description) attachment.setDescription(f.description);
    return attachment;
  });
}

// ── Public Types ──

export interface DiscordAdapterConfig {
  token: string;
  guildIds?: string[];
  /** Per-guild channel whitelist. When a guild id has an entry here, only
   *  the listed channel ids (and threads under them) are visible/handled in
   *  that guild. Guilds without an entry are unrestricted. */
  guildChannels?: Record<string, string[]>;
  /** DM user whitelist. When set, incoming DMs are only handled from these
   *  user ids; DMs from anyone else are dropped. Unset = all DMs allowed. */
  dmUsers?: string[];
}

/** A file attached to a Discord message (image, text file, etc.). */
export interface DiscordAttachment {
  id: string;
  /** Filename, e.g. "message.txt" or "screenshot.png". */
  name: string;
  /** Discord CDN URL (signed; expires after a while). */
  url: string;
  /** MIME type Discord reports, e.g. "image/png", "text/plain; charset=utf-8".
   *  Null when Discord doesn't classify it. */
  contentType: string | null;
  /** Size in bytes. */
  size: number;
}

export interface DiscordMessageData {
  id: string;
  /** Raw content, mentions encoded as `<@USER_ID>` etc. */
  content: string;
  /** Content with user / role / channel mentions resolved to human-readable
   *  forms (`@username`, `@role-name`, `#channel-name`). Falls back to raw
   *  content for channel types where discord.js doesn't populate cleanContent. */
  cleanContent: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  channelId: string;
  /** Channel name (e.g. "general"). `null` for DMs and unnamed channels. */
  channelName: string | null;
  guildId: string | null;
  /** Guild name (e.g. "My Server"). `null` for DMs. */
  guildName: string | null;
  threadId?: string;
  /** Thread name when the message is in a thread. */
  threadName?: string;
  replyToId?: string;
  /** User id of the author of the message this message is in reply to.
   *  Populated for reply messages regardless of whether the sender left
   *  the reply-ping toggle on — Discord includes `referenced_message`
   *  inline in the gateway payload, so this is intent-free and sync.
   *  Used by the gate to treat reply-to-bot as direct address even when
   *  the bot isn't explicitly @-mentioned. */
  replyToUserId?: string | null;
  mentions: string[];
  /** Files attached to the message (images, text files, etc.). Empty when none. */
  attachments: DiscordAttachment[];
  timestamp: Date;
}

export interface DiscordGuildInfo {
  id: string;
  name: string;
  memberCount: number;
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'category' | 'thread' | 'forum' | 'unknown';
  parentId?: string;
}

export interface HistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  /** Raw content (mentions encoded as `<@id>`). */
  content: string;
  /** Content with mentions resolved (@username, #channel, @role). Falls back
   *  to raw content for channel types where discord.js doesn't populate it. */
  cleanContent: string;
  /** Files attached to the message. Empty when none. */
  attachments: DiscordAttachment[];
  timestamp: Date;
}

// ── Adapter ──

export class DiscordAdapter {
  private client: Client;
  private token: string;
  private guildIds?: string[];
  private guildChannels?: Map<string, Set<string>>;
  private dmUsers?: Set<string>;
  private slashCommandHandler?: (interaction: ChatInputCommandInteraction) => void;
  private guildCommandDefs?: ApplicationCommandDataResolvable[];

  private messageHandler?: (msg: DiscordMessageData) => void;
  private editHandler?: (channelId: string, messageId: string, newContent: string) => void;
  private deleteHandler?: (channelId: string, messageId: string) => void;
  private readyHandler?: () => void;
  private channelCreateHandler?: (guildId: string, channel: DiscordChannelInfo) => void;
  private channelDeleteHandler?: (guildId: string, channelId: string) => void;
  private guildCreateHandler?: (
    guildId: string,
    guildName: string,
    channels: DiscordChannelInfo[],
  ) => void;
  private channelAvailableHandler?: (guildId: string, channel: DiscordChannelInfo) => void;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.guildIds = config.guildIds;
    if (config.guildChannels) {
      this.guildChannels = new Map(
        Object.entries(config.guildChannels).map(([g, chans]) => [g, new Set(chans)]),
      );
    }
    if (config.dmUsers?.length) {
      this.dmUsers = new Set(config.dmUsers);
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        // Privileged. Must also be enabled in the Discord Developer Portal
        // under Bot → Privileged Gateway Intents. Required for:
        //  - guild.members.fetch() to receive member chunks (otherwise
        //    the no-arg fetch promise hangs forever, since Discord never
        //    sends GUILD_MEMBERS_CHUNK to a client that didn't subscribe)
        //  - GUILD_MEMBER_ADD/UPDATE/REMOVE gateway events to keep the
        //    cache fresh as people join, change nicknames, or leave.
        // Without it, `@name` → `<@id>` resolution only works for members
        // who've recently messaged (cached opportunistically via
        // messageCreate); inactive members can't be pinged by name.
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupEvents();
  }

  // ── Lifecycle ──

  async connect(): Promise<void> {
    // Resolve only once the gateway READY has populated guilds.cache, so
    // callers (e.g. registerDiscordChannels) don't enumerate an empty cache.
    await new Promise<void>((resolve, reject) => {
      if (this.client.isReady()) { resolve(); return; }
      this.client.once('ready', () => resolve());
      this.client.login(this.token).catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  get isConnected(): boolean {
    return this.client.isReady();
  }

  get botUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  // ── Callback Registration ──

  onMessage(handler: (msg: DiscordMessageData) => void): void {
    this.messageHandler = handler;
  }

  onMessageEdit(handler: (channelId: string, messageId: string, newContent: string) => void): void {
    this.editHandler = handler;
  }

  onMessageDelete(handler: (channelId: string, messageId: string) => void): void {
    this.deleteHandler = handler;
  }

  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }

  /** Handler for slash-command (chat input) interactions. */
  onSlashCommand(handler: (interaction: ChatInputCommandInteraction) => void): void {
    this.slashCommandHandler = handler;
  }

  /**
   * Register guild application (slash) commands on every visible guild
   * (respecting the guild filter). The defs are remembered so newly-joined
   * guilds (guildCreate) get them too. Guild commands update instantly,
   * unlike global commands.
   */
  async registerGuildCommands(commands: ApplicationCommandDataResolvable[]): Promise<void> {
    this.guildCommandDefs = commands;
    for (const guild of this.client.guilds.cache.values()) {
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) continue;
      try {
        await guild.commands.set(commands);
      } catch (err) {
        console.error(
          `[discord-mcpl] Failed to register commands in guild ${guild.id}:`,
          (err as Error).message,
        );
      }
    }
  }

  onChannelCreate(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this.channelCreateHandler = handler;
  }

  onChannelDelete(handler: (guildId: string, channelId: string) => void): void {
    this.channelDeleteHandler = handler;
  }

  /** Fired when the bot joins a new guild after startup. The handler receives
   *  every text channel currently visible to the bot in that guild, so the
   *  server can register them with the host the same way it does at boot. */
  onGuildCreate(
    handler: (guildId: string, guildName: string, channels: DiscordChannelInfo[]) => void,
  ): void {
    this.guildCreateHandler = handler;
  }

  /** Fired when the bot gains visibility into a *pre-existing* channel — e.g.
   *  a permission overwrite grants View Channel on a private channel the bot
   *  was just added to. (channelCreate doesn't fire for channels that already
   *  existed; this fills that gap.) */
  onChannelAvailable(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this.channelAvailableHandler = handler;
  }

  // ── Operations ──

  /** Split text into Discord-safe chunks (<=1900 chars), preferring newline then
   *  space boundaries; hard-splits over-long runs. Discord rejects content over
   *  the per-message limit (DiscordAPIError 50035). */
  private splitForDiscord(text: string, limit = 1900): string[] {
    if (!text) return [];
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
      if (cut < limit * 0.5) cut = limit;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string; files?: OutgoingFile[] },
  ): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${channelId} not found or not a text channel`);
    }
    const resolved = await this.resolveOutgoingMentions(channel, content);
    const attachments = buildAttachments(options?.files);
    const chunks = this.splitForDiscord(resolved);
    // Files-only message (no text): still send one message carrying the files.
    if (chunks.length === 0 && attachments.length > 0) chunks.push('');
    let lastId = '';
    for (let i = 0; i < chunks.length; i++) {
      // Attach files to the LAST chunk so they render after the full text.
      const isLast = i === chunks.length - 1;
      const sent = await (channel as TextChannel | DMChannel).send({
        content: chunks[i] || undefined,
        reply: i === 0 && options?.replyTo ? { messageReference: options.replyTo } : undefined,
        files: isLast && attachments.length > 0 ? attachments : undefined,
      });
      lastId = sent.id;
    }
    return { messageId: lastId };
  }

  async sendDM(
    userId: string,
    content: string,
    options?: { files?: OutgoingFile[] },
  ): Promise<{ messageId: string; channelId: string }> {
    const user = await this.client.users.fetch(userId);
    // For DMs, the only resolvable user is the recipient. We resolve against
    // the DM channel we're about to send to. Return the DM channel ID too so
    // the caller can update sticky-reply state.
    const dm = await user.createDM();
    const resolved = await this.resolveOutgoingMentions(dm, content);
    const attachments = buildAttachments(options?.files);
    const chunks = this.splitForDiscord(resolved);
    if (chunks.length === 0 && attachments.length > 0) chunks.push('');
    let lastId = '';
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sent = await user.send({
        content: chunks[i] || undefined,
        files: isLast && attachments.length > 0 ? attachments : undefined,
      });
      lastId = sent.id;
    }
    return { messageId: lastId, channelId: dm.id };
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const resolved = await this.resolveOutgoingMentions(channel, content);
    await msg.edit(resolved);
  }

  /** Resolve human-readable @handle mentions in outgoing content to Discord's
   *  `<@USER_ID>` syntax. Lena learns the @handle form from incoming
   *  cleanContent and tends to imitate it, but Discord only treats `<@id>`
   *  as an actual ping. Resolution checks (case-insensitive) the channel's
   *  guild members against:
   *    - server nickname
   *    - user's global display name
   *    - user's username (handle)
   *  Skips `@everyone` / `@here` (Discord handles those natively) and the
   *  bot's own identity (don't self-ping when Lena writes about herself in
   *  third person). Leaves the original text untouched when there are zero
   *  matches or multiple ambiguous matches — better to fail to ping than
   *  to ping the wrong person. */
  private async resolveOutgoingMentions(
    channel: unknown,
    content: string,
  ): Promise<string> {
    const selfId = this.client.user?.id;
    type Candidate = { id: string; aliases: string[] };
    const candidates: Candidate[] = [];

    const ch = channel as { guild?: Guild; recipient?: User };
    if (ch.guild) {
      // The member cache was warmed eagerly at startup (see warmGuildMemberCache).
      // discord.js keeps it current via GUILD_MEMBER_ADD/UPDATE/REMOVE events,
      // so reading the cache here is fast and covers all members of the guild.
      // We deliberately don't call guild.members.fetch() on the hot path —
      // even with the intent, a fresh bulk fetch can be slow and the cache
      // is sufficient.
      for (const member of ch.guild.members.cache.values() as IterableIterator<GuildMember>) {
        if (member.user.id === selfId) continue;
        const aliases = [
          member.nickname,
          (member.user as User & { globalName?: string | null }).globalName,
          member.user.displayName,
          member.user.username,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        candidates.push({ id: member.user.id, aliases });
      }
    } else if (ch.recipient) {
      if (ch.recipient.id !== selfId) {
        const aliases = [
          (ch.recipient as User & { globalName?: string | null }).globalName,
          ch.recipient.displayName,
          ch.recipient.username,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        candidates.push({ id: ch.recipient.id, aliases });
      }
    }

    if (candidates.length === 0) return content;

    // Discord usernames allow [a-z0-9._]; we match anything in that charset
    // following `@`. Display names can contain spaces / unicode but allowing
    // multi-word matches has too high a false-positive rate. Single-token
    // handles only.
    return content.replace(/@([A-Za-z0-9_.][A-Za-z0-9_.-]*)/g, (whole, handle) => {
      const lower = String(handle).toLowerCase();
      if (lower === 'everyone' || lower === 'here') return whole;
      const matches = candidates.filter((c) =>
        c.aliases.some((a) => a.toLowerCase() === lower),
      );
      return matches.length === 1 ? `<@${matches[0].id}>` : whole;
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.delete();
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.react(emoji);
  }

  async fetchHistory(
    channelId: string,
    options?: { limit?: number; before?: string; after?: string },
  ): Promise<HistoryMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    // Discord's REST endpoint caps a single fetch at 100 messages and
    // discord.js does not auto-paginate. To support backscroll requests
    // larger than 100 (we want up to 300), walk backwards page-by-page
    // using `before: <oldest seen so far>` until we have enough or the
    // channel runs out of history. `after` (the watermark) is checked
    // per-message rather than passed to Discord — combining `before`
    // and `after` in the same request narrows to a slice in time but
    // doesn't paginate it, which would let us miss messages.
    const requested = options?.limit ?? 50;
    const after = options?.after;
    const collected: HistoryMessage[] = [];
    let before = options?.before;

    while (collected.length < requested) {
      const pageLimit = Math.min(100, requested - collected.length);
      const fetchOpts: { limit: number; before?: string } = { limit: pageLimit };
      if (before) fetchOpts.before = before;
      const page = await (channel as TextChannel).messages.fetch(fetchOpts);
      if (page.size === 0) break;

      // Sort the page newest → oldest so we can break cleanly when we
      // cross the watermark, and so `before` for the next page is the
      // oldest snowflake in this page.
      const pageArr = [...page.values()].sort((a, b) =>
        b.id.localeCompare(a.id, 'en-US-u-kn-true'),
      );

      let hitWatermark = false;
      for (const m of pageArr) {
        if (after && this.snowflakeLte(m.id, after)) {
          hitWatermark = true;
          break;
        }
        const rawClean = (m as { cleanContent?: string }).cleanContent;
        const cleanContent =
          typeof rawClean === 'string' && rawClean.length > 0 ? rawClean : m.content;
        collected.push({
          id: m.id,
          authorId: m.author.id,
          authorName: m.author.username,
          isBot: m.author.bot,
          content: m.content,
          cleanContent,
          attachments: mapAttachments(m),
          timestamp: m.createdAt,
        });
        if (collected.length >= requested) break;
      }

      if (hitWatermark) break;
      // Page returned fewer than the asked-for window: out of history.
      if (page.size < pageLimit) break;
      // Next iteration walks further back from the oldest message we got.
      const oldest = pageArr[pageArr.length - 1];
      if (!oldest) break;
      before = oldest.id;
    }

    return collected;
  }

  /** Compare two Discord snowflake IDs numerically without BigInt parsing.
   *  Snowflakes are 64-bit so we use locale numeric collation. */
  private snowflakeLte(a: string, b: string): boolean {
    return a.localeCompare(b, 'en-US-u-kn-true') <= 0;
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  }

  getGuildName(guildId: string): string {
    return this.client.guilds.cache.get(guildId)?.name ?? guildId;
  }

  /** Bulk-fetch all members of a guild into the local cache. Idempotent
   *  (safe to call multiple times). Wrapped in a timeout so that
   *  misconfigured intents — portal-disabled but client-requested, for
   *  instance — fail fast with a clear error instead of hanging the
   *  whole client. */
  private async warmGuildMemberCache(guild: Guild): Promise<void> {
    const TIMEOUT_MS = 30_000;
    const fetchP = guild.members.fetch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `guild.members.fetch() timed out after ${TIMEOUT_MS}ms for "${guild.name}". ` +
                'GuildMembers intent must be enabled in BOTH the Discord Developer ' +
                "Portal (Bot → Privileged Gateway Intents) AND the discord.js client's " +
                'intents array. The client side is set; check the portal side.',
            ),
          ),
        TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([fetchP, timeoutP]);
      console.error(
        `[discord-mcpl] member cache warmed for "${guild.name}" (${guild.members.cache.size} members)`,
      );
    } catch (err) {
      console.error(
        `[discord-mcpl] member cache warm-up failed for "${guild.name}": ${(err as Error).message}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Produce a human-readable label for a channel id, for use in
   *  sticky-shift notices to the agent. Tries cache then a single
   *  REST fetch; falls back to the raw id if either fails. */
  async describeChannel(
    channelId: string,
  ): Promise<{ label: string; channelName?: string; guildName?: string; isDM: boolean }> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return { label: channelId, isDM: false };
      const ch = channel as { guild?: Guild; recipient?: User; name?: string };
      if (ch.guild) {
        const channelName = typeof ch.name === 'string' ? ch.name : undefined;
        const guildName = ch.guild.name;
        return {
          label: channelName
            ? `#${channelName} in ${guildName}`
            : `channel ${channelId} in ${guildName}`,
          channelName,
          guildName,
          isDM: false,
        };
      }
      if (ch.recipient) {
        const u = ch.recipient as User & { globalName?: string | null };
        const name = u.globalName ?? u.displayName ?? u.username ?? u.id;
        return { label: `DM with @${name}`, isDM: true };
      }
      return { label: channelId, isDM: false };
    } catch {
      return { label: channelId, isDM: false };
    }
  }

  async listGuilds(): Promise<DiscordGuildInfo[]> {
    return this.client.guilds.cache.map((g: Guild) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
    }));
  }

  async listChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild?.channels) {
      throw new Error(`Guild ${guildId} not found`);
    }
    const channels = await guild.channels.fetch();
    const result: DiscordChannelInfo[] = [];
    channels.forEach((c: GuildBasedChannel | null) => {
      if (c) {
        if (!this.channelAllowed(guildId, c.id, c.parentId)) return;
        result.push({
          id: c.id,
          name: c.name,
          type: mapChannelType(c.type),
          parentId: c.parentId ?? undefined,
        });
      }
    });
    return result;
  }

  async createTextChannel(
    guildId: string,
    name: string,
    categoryId?: string,
  ): Promise<DiscordChannelInfo> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) throw new Error(`Guild ${guildId} not found`);
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    return {
      id: channel.id,
      name: channel.name,
      type: 'text',
      parentId: channel.parentId ?? undefined,
    };
  }

  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    if ('delete' in channel) {
      await (channel as TextChannel).delete();
    } else {
      throw new Error(`Channel ${channelId} cannot be deleted`);
    }
  }

  /** Get all text channels across filtered guilds. */
  getTextChannels(): Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> {
    const result: Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> = [];
    for (const guild of this.client.guilds.cache.values()) {
      if (this.guildIds && !this.guildIds.includes(guild.id)) continue;
      for (const channel of guild.channels.cache.values()) {
        if (channel.type === ChannelType.GuildText) {
          if (!this.channelAllowed(guild.id, channel.id, channel.parentId)) continue;
          result.push({
            guildId: guild.id,
            guildName: guild.name,
            channel: {
              id: channel.id,
              name: channel.name,
              type: 'text',
              parentId: channel.parentId ?? undefined,
            },
          });
        }
      }
    }
    return result;
  }

  /** All text channels in a single guild, as DiscordChannelInfo. Reads the
   *  channel cache (populated by the gateway), mirroring getTextChannels but
   *  scoped to one guild — used when the bot joins a guild after startup. */
  private guildTextChannels(guild: Guild): DiscordChannelInfo[] {
    const result: DiscordChannelInfo[] = [];
    for (const channel of guild.channels.cache.values()) {
      if (!this.channelAllowed(guild.id, channel.id, channel.parentId)) continue;
      if (channel.type === ChannelType.GuildText) {
        result.push({
          id: channel.id,
          name: channel.name,
          type: 'text',
          parentId: channel.parentId ?? undefined,
        });
      }
    }
    return result;
  }

  // ── Private ──

  private setupEvents(): void {
    this.client.on('messageCreate', (message: Message) => {
      if (!this.shouldHandle(message)) return;
      this.messageHandler?.(this.convertMessage(message));
    });

    this.client.on('messageUpdate', (_old, newMsg) => {
      if (!newMsg.content) return;
      // Skip our own edits (e.g. deferred slash-command replies arrive as
      // edits) — mirrors the self-author check in shouldHandle.
      if (newMsg.author?.id === this.client.user?.id) return;
      const editParent =
        newMsg.channel && 'parentId' in newMsg.channel
          ? ((newMsg.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(newMsg.guildId, newMsg.channelId, editParent)) return;
      if (!newMsg.guildId && this.dmUsers && newMsg.author && !this.dmUsers.has(newMsg.author.id)) {
        return;
      }
      this.editHandler?.(newMsg.channelId, newMsg.id, newMsg.content);
    });

    this.client.on('messageDelete', (message) => {
      const delParent =
        message.channel && 'parentId' in message.channel
          ? ((message.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(message.guildId, message.channelId, delParent)) return;
      this.deleteHandler?.(message.channelId, message.id);
    });

    this.client.on('channelCreate', (channel) => {
      if ('guildId' in channel && channel.guildId) {
        const parentId = 'parentId' in channel ? (channel.parentId ?? null) : null;
        if (!this.channelAllowed(channel.guildId, channel.id, parentId)) return;
        this.channelCreateHandler?.(channel.guildId, {
          id: channel.id,
          name: channel.name,
          type: mapChannelType(channel.type),
          parentId: 'parentId' in channel ? (channel.parentId ?? undefined) : undefined,
        });
      }
    });

    this.client.on('channelDelete', (channel) => {
      if ('guildId' in channel && channel.guildId) {
        this.channelDeleteHandler?.(channel.guildId, channel.id);
      }
    });

    this.client.on('ready', () => {
      this.readyHandler?.();
      // Eagerly warm the member cache for every guild we're in so
      // @name → <@id> resolution in outbound sends works for inactive
      // members too (not just those who've recently spoken). One bulk
      // fetch per guild; discord.js keeps it fresh thereafter via
      // GUILD_MEMBER_ADD/UPDATE/REMOVE events (which need the
      // GuildMembers intent we declared above).
      for (const guild of this.client.guilds.cache.values()) {
        void this.warmGuildMemberCache(guild);
      }
    });

    // Newly-joined guilds: warm their member cache too, and surface the
    // guild's existing text channels so the host can register them. Without
    // this, channels in a server the bot is added to *after* startup never
    // appear in the host's channel list (channelCreate only fires for
    // channels created later, not the ones that already existed on join).
    this.client.on('guildCreate', (guild) => {
      void this.warmGuildMemberCache(guild);
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      // Register slash commands in guilds joined after startup.
      if (this.guildCommandDefs) {
        guild.commands.set(this.guildCommandDefs).catch((err: Error) => {
          console.error(`[discord-mcpl] Failed to register commands in new guild ${guild.id}:`, err.message);
        });
      }
      this.guildCreateHandler?.(guild.id, guild.name, this.guildTextChannels(guild));
    });

    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (
        this.guildIds?.length &&
        interaction.guildId &&
        !this.guildIds.includes(interaction.guildId)
      ) {
        return;
      }
      this.slashCommandHandler?.(interaction);
    });

    // Permission overwrites changing on an existing channel: when they flip
    // the bot from "can't see" to "can see" (i.e. the bot was added to a
    // private channel), treat it like a newly-available channel. We compare
    // the bot's View Channel permission before vs after so ordinary edits
    // (topic, name, slowmode) don't spuriously re-register.
    this.client.on('channelUpdate', (oldChannel, newChannel) => {
      if (!('guild' in newChannel) || newChannel.type !== ChannelType.GuildText) return;
      const guild = newChannel.guild;
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      const me = guild.members.me;
      if (!me) return;
      if (!this.channelAllowed(guild.id, newChannel.id, newChannel.parentId)) return;
      const VIEW = PermissionsBitField.Flags.ViewChannel;
      const canViewNow = newChannel.permissionsFor(me)?.has(VIEW) ?? false;
      if (!canViewNow) return;
      const couldViewBefore =
        'permissionsFor' in oldChannel
          ? (oldChannel.permissionsFor(me)?.has(VIEW) ?? false)
          : false;
      if (couldViewBefore) return; // no visibility transition — ignore
      this.channelAvailableHandler?.(guild.id, {
        id: newChannel.id,
        name: newChannel.name,
        type: 'text',
        parentId: newChannel.parentId ?? undefined,
      });
    });

    this.client.on('error', (err: Error) => {
      console.error('[discord-mcpl] Client error:', err.message);
    });
  }

  /** Per-guild channel whitelist check. A guild with no entry in
   *  `guildChannels` is unrestricted. Threads count as their parent channel
   *  (a thread under a whitelisted channel is allowed). */
  private channelAllowed(
    guildId: string | null | undefined,
    channelId: string,
    parentId?: string | null,
  ): boolean {
    if (!guildId || !this.guildChannels) return true;
    const allowed = this.guildChannels.get(guildId);
    if (!allowed) return true;
    return allowed.has(channelId) || (parentId != null && allowed.has(parentId));
  }

  private shouldHandle(message: Message): boolean {
    if (message.author.id === this.client.user?.id) return false;
    if (this.guildIds?.length && message.guildId && !this.guildIds.includes(message.guildId)) {
      return false;
    }
    // DMs: when a DM user whitelist is configured, drop DMs from anyone else.
    if (!message.guildId && this.dmUsers && !this.dmUsers.has(message.author.id)) {
      return false;
    }
    if (message.guildId) {
      const parentId =
        message.channel && 'parentId' in message.channel
          ? ((message.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(message.guildId, message.channelId, parentId)) return false;
    }
    return true;
  }

  private convertMessage(message: Message): DiscordMessageData {
    // discord.js exposes channel/guild names directly on the Message object
    // (`message.channel.name`, `message.guild?.name`); they're only undefined
    // for unusual channel kinds (e.g. uncached partials). Fall back to null
    // so downstream rendering can distinguish "unknown" from "DM".
    const channel = message.channel as { name?: string } | null;
    const channelName = channel && typeof channel.name === 'string' && channel.name.length > 0
      ? channel.name
      : null;
    const guildName = message.guild?.name ?? null;
    // `cleanContent` resolves <@id>, <@&roleId>, <#channelId> to
    // @username / @role / #channel. For DMs and partial channels it can be
    // undefined or empty — fall back to raw content so we never lose the
    // message body.
    const rawClean = (message as { cleanContent?: string }).cleanContent;
    const cleanContent = typeof rawClean === 'string' && rawClean.length > 0
      ? rawClean
      : message.content;
    const threadName = (message.thread as { name?: string } | null)?.name;
    return {
      id: message.id,
      content: message.content,
      cleanContent,
      authorId: message.author.id,
      authorName: message.author.username,
      isBot: message.author.bot,
      channelId: message.channelId,
      channelName,
      guildId: message.guildId ?? null,
      guildName,
      threadId: message.thread?.id,
      threadName,
      replyToId: message.reference?.messageId ?? undefined,
      // mentions.repliedUser is the User the reply targets — distinct
      // from mentions.users (which only includes them if the sender
      // explicitly enabled the reply-ping). We capture it so reply-to-bot
      // can be treated as direct address regardless of the ping toggle.
      replyToUserId: message.mentions.repliedUser?.id ?? null,
      mentions: message.mentions.users.map((u) => u.id),
      attachments: mapAttachments(message),
      timestamp: message.createdAt,
    };
  }
}

/** Map a discord.js message's attachments collection to DiscordAttachment[]. */
function mapAttachments(message: { attachments?: { values(): IterableIterator<unknown> } }): DiscordAttachment[] {
  const coll = message.attachments;
  if (!coll || typeof coll.values !== 'function') return [];
  const out: DiscordAttachment[] = [];
  for (const a of coll.values() as IterableIterator<{
    id: string; name: string | null; url: string; contentType: string | null; size: number;
  }>) {
    out.push({
      id: a.id,
      name: a.name ?? a.id,
      url: a.url,
      contentType: a.contentType ?? null,
      size: typeof a.size === 'number' ? a.size : 0,
    });
  }
  return out;
}

function mapChannelType(type: number | undefined): DiscordChannelInfo['type'] {
  switch (type) {
    case 0: return 'text';
    case 2: return 'voice';
    case 4: return 'category';
    case 11:
    case 12: return 'thread';
    case 15: return 'forum';
    default: return 'unknown';
  }
}
