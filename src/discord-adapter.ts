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
  TextChannel,
  DMChannel,
  ChannelType,
  type Message,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';

// ── Public Types ──

export interface DiscordAdapterConfig {
  token: string;
  guildIds?: string[];
}

export interface DiscordMessageData {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  channelId: string;
  guildId: string | null;
  threadId?: string;
  replyToId?: string;
  mentions: string[];
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
  content: string;
  timestamp: Date;
}

// ── Adapter ──

export class DiscordAdapter {
  private client: Client;
  private token: string;
  private guildIds?: string[];

  private messageHandler?: (msg: DiscordMessageData) => void;
  private editHandler?: (channelId: string, messageId: string, newContent: string) => void;
  private deleteHandler?: (channelId: string, messageId: string) => void;
  private readyHandler?: () => void;
  private channelCreateHandler?: (guildId: string, channel: DiscordChannelInfo) => void;
  private channelDeleteHandler?: (guildId: string, channelId: string) => void;

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.guildIds = config.guildIds;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupEvents();
  }

  // ── Lifecycle ──

  async connect(): Promise<void> {
    await this.client.login(this.token);
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

  onChannelCreate(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this.channelCreateHandler = handler;
  }

  onChannelDelete(handler: (guildId: string, channelId: string) => void): void {
    this.channelDeleteHandler = handler;
  }

  // ── Operations ──

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string },
  ): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${channelId} not found or not a text channel`);
    }
    const msg = await (channel as TextChannel | DMChannel).send({
      content,
      reply: options?.replyTo ? { messageReference: options.replyTo } : undefined,
    });
    return { messageId: msg.id };
  }

  async sendDM(userId: string, content: string): Promise<{ messageId: string }> {
    const user = await this.client.users.fetch(userId);
    const msg = await user.send(content);
    return { messageId: msg.id };
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.edit(content);
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
    options?: { limit?: number },
  ): Promise<HistoryMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }
    const messages = await (channel as TextChannel).messages.fetch({
      limit: options?.limit ?? 50,
    });
    return messages.map((m: Message) => ({
      id: m.id,
      authorId: m.author.id,
      authorName: m.author.username,
      isBot: m.author.bot,
      content: m.content,
      timestamp: m.createdAt,
    }));
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

  // ── Private ──

  private setupEvents(): void {
    this.client.on('messageCreate', (message: Message) => {
      if (!this.shouldHandle(message)) return;
      this.messageHandler?.(this.convertMessage(message));
    });

    this.client.on('messageUpdate', (_old, newMsg) => {
      if (!newMsg.content) return;
      this.editHandler?.(newMsg.channelId, newMsg.id, newMsg.content);
    });

    this.client.on('messageDelete', (message) => {
      this.deleteHandler?.(message.channelId, message.id);
    });

    this.client.on('channelCreate', (channel) => {
      if ('guildId' in channel && channel.guildId) {
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
    });

    this.client.on('error', (err: Error) => {
      console.error('[discord-mcpl] Client error:', err.message);
    });
  }

  private shouldHandle(message: Message): boolean {
    if (message.author.id === this.client.user?.id) return false;
    if (this.guildIds?.length && message.guildId && !this.guildIds.includes(message.guildId)) {
      return false;
    }
    return true;
  }

  private convertMessage(message: Message): DiscordMessageData {
    return {
      id: message.id,
      content: message.content,
      authorId: message.author.id,
      authorName: message.author.username,
      isBot: message.author.bot,
      channelId: message.channelId,
      guildId: message.guildId ?? null,
      threadId: message.thread?.id,
      replyToId: message.reference?.messageId ?? undefined,
      mentions: message.mentions.users.map((u) => u.id),
      timestamp: message.createdAt,
    };
  }
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
