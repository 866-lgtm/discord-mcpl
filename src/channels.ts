/**
 * MCPL channel management — maps Discord channels to MCPL ChannelDescriptors.
 */

import type { ChannelDescriptor } from '@animalabs/mcpl-core';
import type { ChannelFacts } from './discord-adapter.js';
import { formatChannelLabel, formatThreadLabel, isNameAddressableKind, isThreadLabelShape } from './channel-names.js';

export type DiscordChannelDescriptor = ChannelDescriptor & {
  initiallyOpen?: boolean;
  capabilities?: {
    history?: { maxMessages?: number; supportsBeforeMessage?: boolean };
    acknowledgment?: { kind?: string; supportsValue?: boolean };
  };
};

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

/**
 * A guild channel's label, from what is known of it: the one rule for every
 * path that registers a channel (boot, a channel's or guild's events, a
 * message delivered from it, an edit or delete), so a label means the same
 * whichever path made it.
 * - A channel the resolver names (text, announcement, voice, stage): its
 *   address, `#name (Guild)`, the string a tool's channelId accepts back.
 * - A thread: `#parent › thread (Guild)`, display only (formatThreadLabel
 *   says why). Threads are addressed by id.
 * - Anything else: its composite id, `discord:<guild>:<channel>`, which
 *   addresses exactly this channel. That is the label when the guild's or
 *   the channel's name isn't known (a bare `#name` would resolve to a
 *   same-named channel in whichever guild has one), for a kind the resolver
 *   doesn't name, and for a voice or stage channel whose name has a thread
 *   label's shape (`general › design`), which the resolver refuses as a name.
 * The server re-derives a registered label when what it's made from changes.
 */
export function channelLabelFor(c: ChannelFacts): string {
  if (c.guildName && c.name) {
    if (c.type === 'thread') return formatThreadLabel(c.parentName, c.name, c.guildName);
    if (isNameAddressableKind(c.type) && !isThreadLabelShape(c.name)) return formatChannelLabel(c.name, c.guildName);
  }
  return mcplChannelId(c.guildId, c.id);
}

/** A guild channel's MCPL descriptor, from what is known of it. Its metadata
 *  carries the names its label was made from, so a reader never has to parse
 *  them back out of a label. */
export function toDescriptor(
  channel: ChannelFacts,
  initiallyOpen = false,
  maxHistory = 500,
): DiscordChannelDescriptor {
  return {
    id: mcplChannelId(channel.guildId, channel.id),
    type: 'discord',
    label: channelLabelFor(channel),
    direction: 'bidirectional',
    address: { guildId: channel.guildId, channelId: channel.id },
    metadata: {
      channelType: channel.type,
      ...(channel.parentId ? { parentId: channel.parentId } : {}),
      ...(channel.name ? { channelName: channel.name } : {}),
      ...(channel.guildName ? { guildName: channel.guildName } : {}),
      ...(channel.type === 'thread' && channel.parentName ? { parentName: channel.parentName } : {}),
    },
    initiallyOpen,
    capabilities: {
      history: { maxMessages: maxHistory, supportsBeforeMessage: true },
      acknowledgment: { kind: 'reaction', supportsValue: true },
    },
  };
}

/** Convert a DM channel to an MCPL ChannelDescriptor.
 *
 * DMs have no guild — the id uses the `dm` pseudo-guild segment
 * (`discord:dm:<channelId>`), matching the id handleDiscordMessage forwards
 * events under. Without this descriptor DMs were never registered at all
 * (registration only ran off guild events), so `channel_open` on a DM id
 * could never resolve and DM open/subscription state never stuck
 * (observed on Mythos, 2026-07-18). */
export function toDmDescriptor(
  channelId: string,
  recipientName: string,
  initiallyOpen = false,
  maxHistory = 500,
  recipientId?: string,
): DiscordChannelDescriptor {
  return {
    id: mcplChannelId('dm', channelId),
    type: 'discord',
    label: `DM: ${recipientName}`,
    direction: 'bidirectional',
    address: { guildId: 'dm', channelId },
    // recipientName/recipientId make DM addressing people-first: the host
    // resolves `>>@name` and `<@id>` mention tokens against them (explicit
    // prose routing), instead of forcing agents through raw channel ids.
    metadata: { channelType: 'dm', recipientName, ...(recipientId ? { recipientId } : {}) },
    initiallyOpen,
    capabilities: {
      history: { maxMessages: maxHistory, supportsBeforeMessage: true },
      acknowledgment: { kind: 'reaction', supportsValue: true },
    },
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
