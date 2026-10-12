/**
 * MCPL channel management — maps Discord channels to MCPL ChannelDescriptors.
 */

import { ERR_UNKNOWN_CHANNEL, type ChannelDescriptor } from '@animalabs/mcpl-core';
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
 *   address, `#name (Guild)`, the string a tool's channelId accepts back,
 *   while that resolves back to it (nameResolves).
 * - A thread: `#parent › thread (Guild)`, display only (formatThreadLabel
 *   says why), or `› thread (Guild)` when its channel's name isn't known.
 *   Threads are addressed by id.
 * - Anything else: its composite id, `discord:<guild>:<channel>`, which
 *   addresses exactly this channel. That is the label when the guild's or
 *   the channel's name isn't known (a bare `#name` would resolve to a
 *   same-named channel in whichever guild has one), for a kind the resolver
 *   doesn't name, for a voice or stage channel whose name has a thread
 *   label's shape (`general › design`), which the resolver refuses as a
 *   name, and for a channel whose name resolves to another channel: a voice
 *   channel beside a same-named text channel, which the resolver prefers,
 *   or two channels of one name and kind.
 * The server re-derives a registered label when what it's made from changes,
 * another channel's name included.
 */
export function channelLabelFor(c: ChannelFacts): string {
  if (c.guildName && c.name) {
    if (c.type === 'thread') return formatThreadLabel(c.parentName, c.name, c.guildName);
    if (isNameAddressableKind(c.type) && !isThreadLabelShape(c.name) && c.nameResolves !== false) {
      return formatChannelLabel(c.name, c.guildName);
    }
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

/** How many candidates an ambiguity refusal lists before summarizing. */
export const OPEN_CHOICES_SHOWN = 10;

/** JSON-RPC's code for invalid params (MCPL's own codes are mcpl-core's ERR_*). */
export const INVALID_PARAMS = -32602;

/** A request refused with the JSON-RPC error code its answer carries, so a
 *  host can tell a stale selector (unknown channel) from bad params, an open
 *  that couldn't go ahead, or a fault. Not a fault itself: the server logs it
 *  as one line, without a stack. */
export class RequestRefusal extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'RequestRefusal';
  }
}

/** A caller's value in a refusal: quoted, and cut short past 100 characters,
 *  so an outsized value can't flood the error or the operator log. */
export function echo(value: string): string {
  return JSON.stringify(value.length > 100 ? `${value.slice(0, 100)}…` : value);
}

/** A caller's type in a refusal: as is when it's a plain word, such as
 *  `discord`, else echoed. */
export function typeName(type: string): string {
  return /^[a-z][\w.-]{0,39}$/i.test(type) ? type : echo(type);
}

/** What a channels/open request names, read against the registry. */
export type OpenTarget =
  | { kind: 'registered'; channel: ChannelDescriptor }
  /** An exact selector naming a well-formed id the registry doesn't hold:
   *  the server looks it up in Discord (see DiscordMcplServer.openTarget). */
  | { kind: 'unregistered'; id: string; via: string }
  /** Refused, with the JSON-RPC error code the answer carries. */
  | { kind: 'refused'; code: number; reason: string };

/**
 * Resolve a channels/open request against the registered channels, by MCPL's
 * precedence. Nothing here opens anything.
 *
 * type is required in MCPL, and every host we know sends it (agent-framework's
 * ChannelsOpenParams makes it a required field, so its exact thread opens
 * carry it too). So it must be a non-empty string, and the channel opened must
 * be of that type; a missing or invalid type is refused, never read as "any".
 *
 * channelId, when given, is the exact selector, and it alone selects: an
 * address beside it isn't read, whatever it says (MCPL prefers channelId, and
 * hosts code against that). Absent or null means no channelId. An empty string
 * or a non-string is refused, since it names nothing.
 *
 * Without a channelId, an address naming a guildId and a channelId (both
 * non-empty strings) is the exact selector. An address that is absent, null or
 * {} names nothing, and anything else is refused.
 *
 * An exact selector that names a registered channel opens it. One that is
 * well-formed but not registered is handed back as `unregistered`, for the
 * server to look up in Discord: it may be a channel this server serves that
 * no traffic has registered yet (a DM after a restart, say). An exact
 * selector never falls back to another channel. With no selector at all, a
 * request opens the one channel of its type, every registered kind counted
 * (DMs among them), and is refused when there are none or several.
 */
export function resolveOpenTarget(
  params: { channelId?: unknown; type?: unknown; address?: unknown },
  channels: readonly ChannelDescriptor[],
): OpenTarget {
  const refuse = (code: number, reason: string): OpenTarget => ({ kind: 'refused', code, reason });
  const { type } = params;
  if (typeof type !== 'string' || type === '') {
    return refuse(INVALID_PARAMS, 'type must be a non-empty string naming a channel type, such as "discord". Nothing was opened.');
  }
  const byId = new Map(channels.map((c) => [c.id, c]));
  const exact = (id: string, via: string): OpenTarget => {
    const channel = byId.get(id);
    if (!channel) {
      return parseMcplChannelId(id)
        ? { kind: 'unregistered', id, via }
        : refuse(ERR_UNKNOWN_CHANNEL, `${via} names no channel: a Discord channel id has the form discord:<guildId>:<channelId> (discord:dm:<channelId> for a DM). Nothing was opened.`);
    }
    if (channel.type !== type) {
      return refuse(INVALID_PARAMS, `${via} is a ${channel.type} channel, not ${typeName(type)}. Nothing was opened.`);
    }
    return { kind: 'registered', channel };
  };

  const { channelId } = params;
  if (channelId !== undefined && channelId !== null) {
    if (typeof channelId !== 'string') {
      return refuse(INVALID_PARAMS, 'channelId must be a string, such as "discord:<guildId>:<channelId>" (send null or omit it for no selector). Nothing was opened.');
    }
    if (channelId === '') {
      return refuse(INVALID_PARAMS, 'channelId is empty: send null or omit it for no selector, or name the channel as discord:<guildId>:<channelId>. Nothing was opened.');
    }
    return exact(channelId, `channelId ${echo(channelId)}`);
  }

  const addr = params.address;
  const isObject = typeof addr === 'object' && addr !== null && !Array.isArray(addr);
  if (addr !== undefined && addr !== null && !(isObject && Object.keys(addr).length === 0)) {
    if (!isObject) {
      return refuse(INVALID_PARAMS, 'address must be absent, null, {}, or an object naming a guildId and a channelId. Nothing was opened.');
    }
    const a = addr as { guildId?: unknown; channelId?: unknown };
    if ((a.guildId !== undefined && typeof a.guildId !== 'string') || (a.channelId !== undefined && typeof a.channelId !== 'string')) {
      return refuse(INVALID_PARAMS, 'address guildId and channelId are strings (a Discord id as a JSON number loses precision). Nothing was opened.');
    }
    if (!a.guildId || !a.channelId) {
      return refuse(INVALID_PARAMS, 'address must name both a guildId and a channelId, or be absent, null or {} for no selector. Nothing was opened.');
    }
    return exact(mcplChannelId(a.guildId as string, a.channelId as string), `address ${echo(a.guildId as string)}/${echo(a.channelId as string)}`);
  }

  const candidates = channels.filter((c) => c.type === type);
  if (candidates.length === 1) return { kind: 'registered', channel: candidates[0] };
  if (candidates.length === 0) {
    return refuse(ERR_UNKNOWN_CHANNEL, `No ${typeName(type)} channel is registered, so there is none to open without a selector. Nothing was opened.`);
  }
  const shown = candidates.slice(0, OPEN_CHOICES_SHOWN).map((c) => `${c.id} (${c.label})`).join(', ');
  const more = candidates.length > OPEN_CHOICES_SHOWN
    ? `, and ${candidates.length - OPEN_CHOICES_SHOWN} more, which channels/list returns`
    : '';
  return refuse(
    INVALID_PARAMS,
    `${candidates.length} ${typeName(type)} channels are registered; name one with channelId. Choices: ${shown}${more}. Nothing was opened.`,
  );
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
