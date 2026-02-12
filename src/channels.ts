/**
 * MCPL channel management — maps Discord channels to MCPL ChannelDescriptors.
 */

import type { ChannelDescriptor } from '@connectome/mcpl-core';
import type { DiscordChannelInfo } from './discord-adapter.js';

/** MCPL channel ID format: discord:<guildId>:<channelId> */
export function mcplChannelId(guildId: string, channelId: string): string {
  return `discord:${guildId}:${channelId}`;
}

/** Parse an MCPL channel ID back to guildId + channelId. Returns null if not a discord channel. */
export function parseMcplChannelId(id: string): { guildId: string; channelId: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'discord') return null;
  return { guildId: parts[1], channelId: parts[2] };
}

/** Convert a Discord channel to an MCPL ChannelDescriptor. */
export function toDescriptor(
  guildId: string,
  guildName: string,
  channel: DiscordChannelInfo,
): ChannelDescriptor {
  return {
    id: mcplChannelId(guildId, channel.id),
    type: 'discord',
    label: `#${channel.name} (${guildName})`,
    direction: 'bidirectional',
    address: { guildId, channelId: channel.id },
    metadata: { channelType: channel.type, parentId: channel.parentId },
  };
}

/**
 * Tracks which channels are registered (known to host) and which are open
 * (host has explicitly opened them for bidirectional message flow).
 */
export class ChannelManager {
  /** All registered channel descriptors, keyed by MCPL channel ID. */
  private registered = new Map<string, ChannelDescriptor>();

  /** Set of open channel IDs (subset of registered). */
  private openChannels = new Set<string>();

  registerAll(descriptors: ChannelDescriptor[]): void {
    for (const d of descriptors) {
      this.registered.set(d.id, d);
    }
  }

  register(descriptor: ChannelDescriptor): void {
    this.registered.set(descriptor.id, descriptor);
  }

  unregister(id: string): boolean {
    this.openChannels.delete(id);
    return this.registered.delete(id);
  }

  open(id: string): ChannelDescriptor | undefined {
    const desc = this.registered.get(id);
    if (desc) {
      this.openChannels.add(id);
    }
    return desc;
  }

  /** Open a channel by Discord guildId + channelId. Returns the descriptor if found. */
  openByDiscordId(guildId: string, channelId: string): ChannelDescriptor | undefined {
    const id = mcplChannelId(guildId, channelId);
    return this.open(id);
  }

  close(id: string): boolean {
    return this.openChannels.delete(id);
  }

  isOpen(id: string): boolean {
    return this.openChannels.has(id);
  }

  /** Check if a Discord channel (by guildId:channelId) has an open MCPL channel. */
  isDiscordChannelOpen(guildId: string, channelId: string): boolean {
    return this.openChannels.has(mcplChannelId(guildId, channelId));
  }

  get(id: string): ChannelDescriptor | undefined {
    return this.registered.get(id);
  }

  getAll(): ChannelDescriptor[] {
    return [...this.registered.values()];
  }

  getOpen(): ChannelDescriptor[] {
    return [...this.openChannels]
      .map((id) => this.registered.get(id))
      .filter((d): d is ChannelDescriptor => d !== undefined);
  }
}
