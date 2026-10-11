/**
 * MCPL channel management — maps Discord channels to MCPL ChannelDescriptors.
 */

import { ERR_UNKNOWN_CHANNEL, type ChannelDescriptor } from '@animalabs/mcpl-core';
import type { DiscordChannelInfo } from './discord-adapter.js';
import { formatChannelLabel } from './channel-names.js';

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

/** Convert a Discord channel to an MCPL ChannelDescriptor. */
export function toDescriptor(
  guildId: string,
  guildName: string,
  channel: DiscordChannelInfo,
  initiallyOpen = false,
  maxHistory = 500,
): DiscordChannelDescriptor {
  return {
    id: mcplChannelId(guildId, channel.id),
    type: 'discord',
    // Same formatter the resolver parses back, so this descriptor's label is
    // by construction a valid channelId argument.
    label: formatChannelLabel(channel.name, guildName),
    direction: 'bidirectional',
    address: { guildId, channelId: channel.id },
    metadata: { channelType: channel.type, parentId: channel.parentId },
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
