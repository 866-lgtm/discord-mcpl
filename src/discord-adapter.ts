/**
 * Discord.js adapter for the Discord MCPL server.
 * Wraps discord.js, provides a clean callback + method interface.
 *
 * Based on patterns from agent-framework/src/modules/discord/discord-js-client.ts
 */

import {
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  TextChannel,
  DMChannel,
  ChannelType,
  MessageType,
  AttachmentBuilder,
  SnowflakeUtil,
  type Message,
  type PartialMessage,
  type Channel,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type User,
  type ChatInputCommandInteraction,
  type ApplicationCommandDataResolvable,
  type GatewayThreadListSyncDispatchData,
} from 'discord.js';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { dbg } from './debug-log.js';

import {
  buildCandidates,
  formatChannelLabel,
  isNameAddressableKind,
  isSnowflake,
  isThreadLabelShape,
  parseChannelRef,
  resolveChannelName,
  threadLabelRefusal,
  type ChannelCandidate,
  type ResolveResult,
} from './channel-names.js';
import { channelLabelFor, mcplChannelId } from './channels.js';
import { INVALID_FORM_BODY, MISSING_ACCESS, UNKNOWN_CHANNEL } from './discord-errors.js';

/** The channels a name resolves among (nameView), with the guilds where
 *  no name resolves while a channel there is stale (uncertainGuildNames),
 *  each computed once per view. */
interface NameView {
  (name: string): ChannelCandidate[];
  /** Where names are uncertain now: the lowercased names of those guilds,
   *  and whether any guild is, a guild whose name isn't known included,
   *  which a name given without a guild could mean. */
  uncertainGuilds(): { readonly named: ReadonlySet<string>; readonly any: boolean };
}

/** How many times refetchChannel fetches a channel whose fetches Discord's
 *  reports keep overtaking, before it marks the channel stale. */
const FETCH_TRIES = 3;

/** The channels whose lowercased name is `key`. */
function* channelsNamed(channels: Iterable<GuildBasedChannel>, key: string): Iterable<GuildBasedChannel> {
  for (const c of channels) if (c.name?.toLowerCase() === key) yield c;
}

/** What a channel update changed (DiscordAdapter.onChannelUpdate). */
export interface ChannelChange {
  /** Whether its name, its kind or its category changed: what decides
   *  which channel a name resolves to (resolveChannelRef), the category
   *  through the channel filters. A topic, position or permission edit
   *  changes none of them. */
  addressChanged: boolean;
  /** Whether the channel filters admit the channel as it is now. One moved
   *  out of an admitted category no longer is. */
  admitted: boolean;
}

/** A sync of a guild's threads (DiscordAdapter.onThreadsSynced): the
 *  channels it covers, or null for the whole guild; the live threads it
 *  lists; and the live threads the client held under those channels that it
 *  dropped from discord.js's caches. */
export type ThreadsSyncedHandler = (
  guildId: string,
  covered: ReadonlySet<string> | null,
  listed: ReadonlySet<string>,
  dropped: ReadonlySet<string>,
) => void;

/** Maximum attachments Discord accepts on a single message. */
const MAX_DISCORD_ATTACHMENTS = 10;

/** Graphemes: what a reader takes as one character, such as an emoji's ZWJ
 *  sequence, a flag's two regional indicators, or a letter and its combining
 *  marks. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Where to cut `text` hard at `limit` UTF-16 units: the last grapheme
 *  boundary at or before it, so this cut parts no character between two
 *  parts. splitForDiscord's line-break and space cuts don't look at
 *  graphemes. When a single grapheme runs past the limit from the start,
 *  there's no such boundary, so the cut falls inside it, moved back one unit
 *  if it would part a surrogate pair. */
function hardCut(text: string, limit: number): number {
  let cut = 0;
  for (const { index } of GRAPHEMES.segment(text)) {
    if (index > limit) break;
    cut = index;
  }
  if (cut > 0) return cut;
  const unit = text.charCodeAt(limit - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? limit - 1 : limit;
}

/** What a sendDM failure carries once its DM channel was resolved. */
export interface DmSendFailure {
  dmChannel?: { id: string; recipientName: string };
}

/** Cap on members returned by listChannelMembers — a large guild's #general
 *  is visible to thousands; the agent gets the first page plus the total. */
const MEMBER_LIST_CAP = 200;

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
 * Turn `OutgoingFile[]` specs into discord.js `AttachmentBuilder`s, checking
 * every file before any part of the message is sent. discord.js reads each
 * path lazily, at send time, so a file it can't read would fail after the
 * parts before it posted. Tool arguments aren't checked against their
 * schema, so `files` may arrive as anything. Paths are read on the machine
 * running discord-mcpl, a relative one against its working directory.
 */
function buildAttachments(files?: unknown): AttachmentBuilder[] {
  // No files: left out, or a value that says none (null, "", false, 0), as before.
  if (!files) return [];
  if (!Array.isArray(files)) {
    throw new Error(
      `Nothing was sent: "files" must be a list of files, each as {"path": "<its path>"}, and this call gave ` +
        `${kindOfValue(files)}.`,
    );
  }
  if (files.length > MAX_DISCORD_ATTACHMENTS) {
    throw new Error(
      `Nothing was sent: this call gave ${files.length} files, and Discord takes at most ${MAX_DISCORD_ATTACHMENTS} ` +
        `in one message. Send ${MAX_DISCORD_ATTACHMENTS} or fewer, and the rest in another message.`,
    );
  }
  return files.map((f: unknown, i) => {
    const file = (f && typeof f === 'object' ? f : {}) as Partial<OutgoingFile>;
    if (typeof file.path !== 'string' || !file.path.trim()) {
      // A bare path, given as the entry itself, is the likely meaning of a
      // string; an entry that isn't an object is named by its kind.
      const hint = typeof f === 'string'
        ? f.trim() ? `: give it as {"path": ${JSON.stringify(f.trim())}}` : ', and this one is blank'
        : f && typeof f === 'object' && !Array.isArray(f) ? '' : `, and this call gave ${kindOfValue(f)}`;
      throw new Error(
        `Nothing was sent: files[${i}] needs "path", the path of a file on the machine running discord-mcpl, as a ` +
          `non-empty string${hint}.`,
      );
    }
    // A name or description that says none (left out, null, "", false, 0)
    // is left out, as before. A description given as a number or as true is
    // sent as its text, such as "42". Any other value that isn't a string is
    // refused rather than turned into text: its text form ("[object Object]"
    // for an object, its items joined by commas for a list) would be a guess
    // at the description the caller meant.
    for (const key of ['name', 'description'] as const) {
      const value: unknown = file[key];
      const asText = key === 'description' && (typeof value === 'number' || value === true);
      if (value && typeof value !== 'string' && !asText) {
        throw new Error(
          `Nothing was sent: files[${i}].${key} must be a string, and this call gave ${kindOfValue(value)}. Give it in quotes, ` +
            `or leave it out${key === 'name' ? ' to use the file\'s own name' : ''}.`,
        );
      }
    }
    const read = resolvePath(file.path);
    const problem = unattachable(read);
    if (problem) {
      throw new Error(
        `Nothing was sent: ${JSON.stringify(file.path)}${read === file.path ? '' : ` (read as ${read})`} ${problem} ` +
          'on the machine running discord-mcpl. Give the path of a file there that it can read.',
      );
    }
    const name = file.name && file.name.trim() ? file.name : basename(file.path);
    const attachment = new AttachmentBuilder(file.path, { name });
    if (file.description) attachment.setDescription(String(file.description));
    return attachment;
  });
}

/** How a refusal names a value of the wrong kind: "a number", "a list", "an
 *  object", "null". Tool arguments aren't checked against their schema, so
 *  a value can be anything. */
export function kindOfValue(value: unknown): string {
  return Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** Why a path can't be attached, or null when it can: it must be a regular
 *  file this process can read. */
function unattachable(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return "isn't a file";
    accessSync(path, fsConstants.R_OK);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? "doesn't exist" : `can't be read (${code ?? (err as Error).message})`;
  }
}

// ── Public Types ──

export interface DiscordAdapterConfig {
  token: string;
  /** Guild filter: only these guilds' channels are registered with the host,
   *  resolvable by name, and delivered. It doesn't restrict a deliberate read
   *  by channel id; reads follow guildChannels. */
  guildIds?: string[];
  /** Per-guild channel whitelist. When a guild id has an entry here, only
   *  the listed channel ids (and threads under them) are visible/handled in
   *  that guild. It also bounds deliberate inspection: list_channels leaves
   *  channels outside it out of its listing, list_channel_members refuses
   *  them with its own check, and fetch_history, fetch_around and a
   *  channels/open asking for backscroll refuse them through
   *  inspectionRefusal. Guilds without an entry are unrestricted. An entry
   *  applies only to a guild that guildIds lists too (normalizeFilters
   *  drops the rest). */
  guildChannels?: Record<string, string[]>;
  /** DM user whitelist. When set, incoming DMs are only handled from these
   *  user ids; DMs from anyone else are dropped. Unset = all DMs allowed.
   *  It filters incoming DMs only; it doesn't restrict reads or sends. */
  dmUsers?: string[];
}

/** How many refusals the adapter holds while no handler is registered. */
export const DM_REFUSALS_HELD = 100;

/** A DM the DM allowlist refused: its identity only, never its body. */
export interface DmRefusal {
  messageId: string;
  channelId: string;
  authorId: string;
  /** Which door refused it: the live gateway or the reconnect catch-up. */
  origin: 'live' | 'sweep';
}

/** A file attached to a Discord message (image, text file, etc.). */
export interface DiscordAttachment {
  id: string;
  /** Filename, e.g. "message.txt" or "screenshot.png". */
  name: string;
  /** Discord CDN URL (signed; expires after a while). */
  url: string;
  /** When `url` stops working, as ISO 8601 UTC, read from its signed `ex`
   *  parameter. Absent when the URL carries no readable one. Fetching the
   *  message again gives a freshly signed URL. */
  expiresAt?: string;
  /** MIME type Discord reports, e.g. "image/png", "text/plain; charset=utf-8".
   *  Null when Discord doesn't classify it. */
  contentType: string | null;
  /** Size in bytes. */
  size: number;
  /** Set when the attachment rode in on a forwarded snapshot rather than on
   *  the message itself: 1-based index of the carrying snapshot. Lets
   *  delivery markers name the source forward explicitly instead of relying
   *  on array-order inference when a message carries several forwards. */
  forwardedSnapshotIndex?: number;
}

/** Where a message sits when its channel is a thread. Discord threads are
 *  channels, so a message posted in one has the thread as its channel. These
 *  fields name that thread, never one a message started: that is discord.js
 *  `message.thread`, a different conversation. All are absent when the
 *  channel isn't a thread. The adapter reads them in one place
 *  (`threadPlace`), for creates, edits, deletes and reactions, and channel
 *  lookups. */
export interface ThreadPlace {
  /** The thread the message was posted in, which is its channel, so this
   *  equals the channel id. */
  threadId?: string;
  /** The thread's name, when it's known. */
  threadName?: string;
  /** Name of the channel the thread hangs off: null when it isn't known. */
  threadParentName?: string | null;
}

/** A channel's display metadata, for the reconnect sweep's `<missed>` blocks
 *  (getChannelMeta, getCachedChannelMeta): its name, guild, whether it is a
 *  DM (null when its kind isn't known), and its thread fields when it is a
 *  thread. */
export interface ChannelMeta extends ThreadPlace {
  name: string | null;
  guildId: string | null;
  guildName: string | null;
  isDM: boolean | null;
}

export interface DiscordMessageData extends ThreadPlace {
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
  replyToId?: string;
  /** User id of the author of the message this message is in reply to.
   *  Populated for reply messages regardless of whether the sender left
   *  the reply-ping toggle on — Discord includes `referenced_message`
   *  inline in the gateway payload, so this is intent-free and sync.
   *  Used by the gate to treat reply-to-bot as direct address even when
   *  the bot isn't explicitly @-mentioned. */
  replyToUserId?: string | null;
  /** Username of the replied-to author when Discord includes the referenced user. */
  replyToUserName?: string | null;
  mentions: string[];
  /** True when the message mentions the bot's own managed role (@BotName the
   *  ROLE — Discord renders it identically to a user ping and most humans
   *  can't tell which they picked from autocomplete). Found live 2026-07-29:
   *  a role-ping at a resident fell through as ambient and never woke her. */
  mentionsBotRole?: boolean;
  /** Files attached to the message (images, text files, etc.). Empty when none. */
  attachments: DiscordAttachment[];
  /** Emoji reactions on this message at serialization time. Usually empty for a
   *  freshly-created message; populated on fetch. */
  reactions?: ReactionSummary[];
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
  type: 'text' | 'announcement' | 'voice' | 'stage' | 'category' | 'thread' | 'forum' | 'unknown';
  parentId?: string;
  /** The channel's label, made as a registered channel's is
   *  (channelLabelFor): `#name (GuildName)` where that name resolves back to
   *  it, otherwise its id, `discord:<guild>:<channel>`. Either form is a
   *  string the channelId argument accepts. Returned so listings hand back
   *  something PASTEABLE. Both forms are present on purpose — label to
   *  compose a send now, id to store. */
  label: string;
}

/** What registering a guild channel needs to know of it (toDescriptor),
 *  as the client's cache has it. A name the cache doesn't have is null. */
export interface ChannelFacts {
  id: string;
  guildId: string;
  /** Null when the client doesn't have the guild cached. */
  guildName: string | null;
  type: DiscordChannelInfo['type'];
  name: string | null;
  /** A channel's category, or the channel a thread hangs off. */
  parentId?: string | null;
  /** For a thread, the name of the channel it hangs off, which its label
   *  names. */
  parentName?: string | null;
  /** For a thread, whether it's archived. */
  archived?: boolean;
  /** For an archived thread, when Discord archived it (its
   *  `archive_timestamp`, in ms), when the cache knows: a message posted
   *  after it unarchived the thread, and one posted before it didn't. */
  archivedAt?: number;
  /** For a kind a name can address, whether its `#name (Guild)` resolves
   *  back to it through the resolver tools use (resolveChannelRef). It
   *  doesn't when another channel holds the name: a same-named text channel,
   *  which the resolver prefers to a voice or stage channel, or another of
   *  its kind. Then its label is its id (channelLabelFor). */
  nameResolves?: boolean;
}

/** One member of a channel, as the agent should see them. */
export interface DiscordMemberInfo {
  id: string;
  /** The stable @handle (Discord username). */
  username: string;
  /** Name shown in this channel: server nickname > global display name. */
  displayName: string;
  isBot: boolean;
}

/** How far latestFrom looks: the newest messages fetched at invocation. */
export const LATEST_FROM_WINDOW = 100;
/** How long latestFrom remembers a guild whose member-cache warm-up failed,
 *  refusing names there at once rather than waiting out another download. */
const LATEST_FROM_WARMUP_RETRY_MS = 10 * 60_000;
/** One page of List Thread Members, should Discord page a listing without
 *  with_member (see listChannelMembers). */
const THREAD_MEMBER_PAGE = 100;

export type LatestFromResult =
  | { ok: true; message: HistoryMessage; authorId: string; authorLabel: string }
  | { ok: false; message: string };

export interface DiscordChannelMembers {
  channelId: string;
  channelName: string | null;
  /** How membership was resolved: everyone who can view a guild channel
   *  (computed permissions over a fully warmed member cache), the JOINED
   *  members of a thread (Discord's own thread-membership notion — a public
   *  thread may be readable by non-joined users with parent access), or the
   *  two parties of a DM. */
  scope: 'guild-channel' | 'thread-joined' | 'dm';
  /** Full member count before the cap was applied. */
  total: number;
  /** Humans first, then bots; alphabetical by display name within each. */
  members: DiscordMemberInfo[];
  /** True when `members` was capped (see MEMBER_LIST_CAP). */
  truncated: boolean;
  /** Scope caveat the agent should see (set for threads). */
  note?: string;
  /** Members listed by id only because their names couldn't be resolved
   *  (thread members after a failed member-cache warm-up); absent when 0. */
  unresolved?: number;
  /** Set when Discord returned exactly one page of a thread's joined members,
   *  so there may be more than listed. */
  possiblyIncomplete?: true;
}

export interface HistoryMessage {
  id: string;
  authorId: string;
  /** The author's username. */
  authorName: string;
  /** The author's display name: their server nickname or global display
   *  name as discord.js resolves it (the member's, else the account's global
   *  name), else the username. */
  authorDisplayName?: string;
  isBot: boolean;
  /** Set on a system notice (a pin, a join, a thread start…): a message
   *  discord.js counts as system, which nobody wrote as a message. */
  system?: true;
  /** Raw content (mentions encoded as `<@id>`). */
  content: string;
  /** Content with mentions resolved (@username, #channel, @role). Falls back
   *  to raw content for channel types where discord.js doesn't populate it. */
  cleanContent: string;
  /** Files attached to the message. Empty when none. */
  attachments: DiscordAttachment[];
  /** True if this message @mentions the bot or is a reply to the bot. Used by
   *  the reconnect catch-up sweep to pick out missed mentions. Reply-to-bot is
   *  best-effort for historical fetches: `mentions.repliedUser` is only present
   *  when the reference resolves, so explicit @mentions are the reliable
   *  signal here. */
  mentionsBot: boolean;
  /** Emoji reactions currently on this message. Empty when none. Populated on
   *  fetch (history/around); reactions ride along with the message so they are
   *  visible passively, without ever waking the agent. */
  reactions?: ReactionSummary[];
  timestamp: Date;
}

/** One emoji reaction bucket on a message. */
export interface ReactionSummary {
  /** Human-readable form: the unicode char, or ':name:' for a custom emoji. */
  emoji: string;
  /** Custom-emoji snowflake id, or null for a unicode emoji. */
  emojiId: string | null;
  /** Token to reuse this emoji in message content ('<:name:id>' / '<a:name:id>'),
   *  or the unicode char itself. */
  token: string;
  /** Number of users who added this reaction. */
  count: number;
  /** True if the bot itself is one of the reactors. */
  me: boolean;
}

/** A custom (server) emoji the bot can see and use. */
export interface DiscordEmojiInfo {
  id: string;
  name: string;
  animated: boolean;
  /** Paste into message content to render it ('<:name:id>' / '<a:name:id>'). */
  token: string;
  /** Pass to add_reaction to react with it (':name:'). */
  reactionArg: string;
  guildId: string;
  guildName: string | null;
}

/** An incoming Discord reaction (add or remove) surfaced to the server, with
 *  the thread of the reacted-to message when its channel is one
 *  (ThreadPlace), as that message's create carries it. */
export interface ReactionEvent extends ThreadPlace {
  action: 'add' | 'remove';
  channelId: string;
  messageId: string;
  guildId: string | null;
  /** Human-readable emoji: the unicode char, or ':name:' for a custom emoji. */
  emoji: string;
  emojiId: string | null;
  /** Token to reuse the emoji ('<:name:id>' / '<a:name:id>'), or the unicode char. */
  token: string;
  /** Who added/removed the reaction. */
  userId: string;
  userName: string;
  /** True if the reacted-to message was authored by the bot (a reaction to us). */
  onOwnMessage: boolean;
  /** Author id of the reacted-to message, if resolvable. */
  messageAuthorId: string | null;
  /** One-line snippet of the reacted-to message's text, or null when it has
   *  none (attachment/embed-only, or the message couldn't be resolved). */
  messageSnippet: string | null;
  timestamp: Date;
}

/** Render custom-emoji tokens ('<:name:id>' / '<a:name:id>') down to ':name:'
 *  so message text reads legibly for the model. Unicode emoji are untouched. */
/** A guild thread the client knows only partly: built from an event that
 *  carried its type but not its channel, so discord.js keeps its parentId
 *  null until a thread event or a fetch fills it in. The channel allowlist
 *  can't place it until then, since a thread counts as its channel. */
function threadChannelUnknown(channel: unknown): boolean {
  const c = channel as { isThread?: () => boolean; parentId?: string | null } | null | undefined;
  return !!c && typeof c.isThread === 'function' && c.isThread() && c.parentId == null;
}

function renderCustomEmojis(text: string): string {
  return text.replace(/<a?:(\w+):\d+>/g, (_full, name: string) => `:${name}:`);
}

/** Cap for the reacted-to-message snippet carried on reaction events. */
const REACTION_SNIPPET_MAX = 80;

/** One-line snippet of a message body for reaction events: custom-emoji
 *  tokens rendered down, whitespace collapsed, capped at REACTION_SNIPPET_MAX.
 *  Null when there is no text to show (attachment/embed-only messages) — the
 *  caller falls back to the id-only rendering in that case. */
export function buildReactionSnippet(text: string | null | undefined): string | null {
  if (!text) return null;
  const collapsed = renderCustomEmojis(text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > REACTION_SNIPPET_MAX
    ? `${collapsed.slice(0, REACTION_SNIPPET_MAX - 1)}…`
    : collapsed;
}

/** The slice of a discord.js MessageSnapshot that forward rendering reads.
 *  `attachments` is a discord.js Collection at runtime; `values()` is optional
 *  here so tests and older gateway shapes can pass a bare `{ size }`. */
interface ForwardSnapshot {
  content?: string | null;
  attachments?: { size: number; values?(): IterableIterator<unknown> } | null;
  embeds?: { length: number } | null;
}

/** Render a forwarded message's snapshots into visible text. Discord forwards
 *  carry their body in `messageSnapshots` (discord.js ≥14.16), not `content`,
 *  so without this a bare forward reaches the agent as an empty message.
 *  Attachment/embed-only snapshots get a bracketed note instead of silence.
 *  Snapshots have no `cleanContent`, so mention ids stay raw, but custom-emoji
 *  tokens are rendered down to ':name:' like everywhere else. */
export function buildForwardedContent(
  baseContent: string,
  snapshots: Iterable<ForwardSnapshot>,
): string {
  const parts: string[] = [];
  for (const snap of snapshots) {
    const text =
      typeof snap.content === 'string' && snap.content.trim().length > 0
        ? renderCustomEmojis(snap.content)
        : null;
    const attachmentCount = snap.attachments?.size ?? 0;
    const notes: string[] = [];
    if (attachmentCount > 0) {
      notes.push(`[${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}]`);
    }
    if (!text && (snap.embeds?.length ?? 0) > 0) notes.push('[embed]');
    const body = [text, ...notes].filter(Boolean).join(' ');
    parts.push(`[forwarded message] ${body || '[no text content]'}`);
  }
  if (parts.length === 0) return baseContent;
  const forwarded = parts.join('\n');
  return baseContent.trim().length > 0 ? `${baseContent}\n${forwarded}` : forwarded;
}

/** Resolve a message's visible body: `cleanContent` when populated (raw
 *  content otherwise — DMs and partial channels can leave it empty), with any
 *  forwarded snapshots rendered in, and Discord SYSTEM messages (member
 *  joins, boosts, pins…) synthesized from `message.type` the way the human
 *  client renders them — they carry no content, so forwarding them raw gave
 *  the agent literally empty messages ("Bob: "). Shared by the live
 *  convertMessage path and both history paths (fetchHistory / fetchAround),
 *  so neither forwards nor system messages can regress to empty on
 *  backscroll or the reconnect catch-up sweep — history replays missed
 *  messages through fetchHistory, not the live path. */
/** Author/location context forwarded with an edit or delete event, the
 *  thread included when the message's channel is one (ThreadPlace). */
export interface MessageEventInfo extends ThreadPlace {
  /** Guild id, or null for a DM. */
  guildId: string | null;
  authorId?: string;
  /** For a DM delete: the conversation's other party, its author unless the
   *  message is the bot's own, else the channel's recipient. A delete may
   *  name no author, so the DM allowlist judges it by this. */
  dmRecipientId?: string;
  /** For a DM delete whose other party couldn't be confirmed: why, for the
   *  operator log line that withholding it leaves. */
  dmPartyUnknown?: string;
  /** Discord username — the same handle the create path renders. */
  authorName?: string;
  /** Edit time (ISO) when Discord supplies it: distinguishes one edit of a
   *  message from the next (RFC-006 occurrence identity). */
  editedAt?: string;
  /** The edited body with mentions resolved, as a create renders it. */
  cleanContent?: string;
}

/** Why an incoming `messageUpdate` is (not) forwarded as an edit. */
export type EditForwardDecision =
  | 'forward'
  | 'no-content'
  | 'self'
  | 'not-an-edit'
  | 'unchanged';

/**
 * Decide whether a discord.js `messageUpdate` is a real content edit worth
 * forwarding. Discord emits MESSAGE_UPDATE for more than edits: link-preview /
 * embed refreshes re-send old messages with `edited_timestamp` still null, and
 * forwarding those surfaced weeks-old, never-edited messages to the agent as
 * fresh "[message edited]" events. The DM allowlist is applied where the
 * edit is forwarded, by the adapter's one rule for it (dmUserRefused).
 */
export function editForwardDecision(
  oldMsg: { partial?: boolean; content?: string | null } | null | undefined,
  newMsg: {
    content?: string | null;
    editedTimestamp?: number | null;
    guildId?: string | null;
    author?: { id: string } | null;
  },
  opts: { selfId?: string | null },
): EditForwardDecision {
  if (!newMsg.content) return 'no-content';
  // Our own edits (e.g. deferred slash-command replies arrive as edits).
  if (opts.selfId && newMsg.author?.id === opts.selfId) return 'self';
  if (!newMsg.editedTimestamp) return 'not-an-edit';
  if (oldMsg && !oldMsg.partial && typeof oldMsg.content === 'string' && oldMsg.content === newMsg.content) {
    return 'unchanged';
  }
  return 'forward';
}

export function resolveVisibleContent(m: {
  content: string;
  cleanContent?: string | null;
  messageSnapshots?: { size: number; values(): Iterable<ForwardSnapshot> } | null;
  type?: MessageType;
}): string {
  let base =
    typeof m.cleanContent === 'string' && m.cleanContent.length > 0
      ? m.cleanContent
      : m.content;
  if (base.length === 0 && m.type !== undefined && m.type !== MessageType.Default) {
    base = systemMessageText(m.type);
  }
  return m.messageSnapshots && m.messageSnapshots.size > 0
    ? buildForwardedContent(base, m.messageSnapshots.values())
    : base;
}

/** Summarise the reactions on a discord.js message. Custom emoji become ':name:'
 *  (full token preserved on `token`); unicode emoji pass through. */
function extractReactions(m: Message): ReactionSummary[] {
  const cache = m.reactions?.cache;
  if (!cache || cache.size === 0) return [];
  return [...cache.values()].map((r) => {
    const e = r.emoji;
    const custom = Boolean(e.id);
    return {
      emoji: custom ? `:${e.name}:` : e.name ?? '?',
      emojiId: e.id ?? null,
      token: custom ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name ?? '',
      count: r.count,
      me: r.me,
    };
  });
}

/** A possible mention target gathered from the guild/DM: a user or a role,
 *  with the case-insensitive names it can be addressed by. */
export interface MentionCandidate {
  id: string;
  aliases: string[];
  kind: 'user' | 'role';
}

/** Rewrite human-readable `@handle` tokens in `content` to Discord ping syntax
 *  — `<@id>` for users, `<@&id>` for roles — using the supplied candidates.
 *
 *  Pure (no Discord I/O) so it can be unit-tested. Rules:
 *    - `@everyone` / `@here` are left as-is (Discord handles them natively).
 *    - Users take priority on a name collision; a role is only used when no
 *      user matches that handle.
 *    - Only an unambiguous single match resolves; zero or multiple matches
 *      leave the original text untouched (fail to ping over mis-ping).
 *    - Single-token handles only ([A-Za-z0-9_.-]); multi-word names won't
 *      resolve, matching the original behaviour. */
export function applyMentionCandidates(
  content: string,
  candidates: MentionCandidate[],
): string {
  if (candidates.length === 0) return content;
  return content.replace(/@([A-Za-z0-9_.][A-Za-z0-9_.-]*)/g, (whole, handle) => {
    const lower = String(handle).toLowerCase();
    if (lower === 'everyone' || lower === 'here') return whole;
    const matches = (kind: 'user' | 'role') =>
      candidates.filter(
        (c) => c.kind === kind && c.aliases.some((a) => a.toLowerCase() === lower),
      );
    const users = matches('user');
    if (users.length === 1) return `<@${users[0].id}>`;
    if (users.length === 0) {
      const roles = matches('role');
      if (roles.length === 1) return `<@&${roles[0].id}>`;
    }
    return whole;
  });
}

// ── Adapter ──

export class DiscordAdapter {
  private client: Client;

  /** The underlying discord.js client, for subsystems needing gateway-adjacent
   *  state this facade doesn't wrap (voice adapters). */
  get rawClient(): Client {
    return this.client;
  }
  private token: string;
  private guildIds?: string[];
  private guildChannels?: Map<string, Set<string>>;
  private dmUsers?: Set<string>;
  /** Guilds whose member-cache warm-up failed during a latestFrom name lookup,
   *  with when: names there are refused at once for LATEST_FROM_WARMUP_RETRY_MS. */
  private latestFromWarmupFailures = new Map<string, number>();
  /** In-flight mutation deliveries, ordered per Discord message. */
  private messageEventDeliveries = new Map<string, Promise<void>>();
  /** Creates waiting for their thread to be fetched, per channel, so later
   *  ones in the same thread are delivered after it, in order. */
  private threadLookups = new Map<string, Promise<void>>();
  /** The guild channels and threads whose cached facts may be older than
   *  what Discord has reported since (isStale), by id, with their guild. */
  private stale = new Map<string, { guildId: string }>();
  /** The channel fetches out now (refetchChannel), by channel id, each
   *  marked once Discord reports on its channel while it's out. */
  private fetchesOut = new Map<string, Set<{ overtaken: boolean }>>();
  private slashCommandHandler?: (interaction: ChatInputCommandInteraction) => void;
  private guildCommandDefs?: ApplicationCommandDataResolvable[];

  private messageHandler?: (msg: DiscordMessageData) => void;
  private editHandler?: (
    channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo,
  ) => void;
  private deleteHandler?: (channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo) => void;
  private editAccept?: (channelId: string) => boolean;
  private deleteAccept?: (channelId: string) => boolean;
  private reactionHandler?: (ev: ReactionEvent) => void;
  private dmRefusedHandler?: (ev: DmRefusal) => void;
  /** Refusals heard before onDmRefused registered a handler (Discord
   *  connects before the server exists), handed over when it does. */
  private heldDmRefusals: DmRefusal[] = [];
  private readyHandler?: () => void;
  private channelCreateHandler?: (channel: ChannelFacts) => void;
  private channelUpdateHandler?: (channel: ChannelFacts, change: ChannelChange) => void;
  private channelDeleteHandler?: (guildId: string, channelId: string, threadIds: string[]) => void;
  private threadUpdateHandler?: (thread: ChannelFacts) => void;
  private threadDeleteHandler?: (guildId: string, threadId: string) => void;
  private channelRefreshedHandler?: (channelId: string) => void;
  private channelStaleHandler?: (channelId: string) => void;
  private guildCreateHandler?: (guildId: string, channels: ChannelFacts[]) => void;
  private guildDeleteHandler?: (guildId: string) => void;
  private guildAvailableHandler?: (guildId: string, channels: ChannelFacts[], present: ReadonlySet<string>) => void;
  private guildRenameHandler?: (guildId: string) => void;
  private threadsSyncedHandler?: ThreadsSyncedHandler;
  /** The thread sync discord.js is applying now, and the live threads of its
   *  guild the client held, with their channels, as it began
   *  (installThreadSyncScope). */
  private applyingThreadSync?: { data: GatewayThreadListSyncDispatchData; held: Map<string, string | null> };

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
        // Non-privileged. Populates guild.emojis for list_emojis and keeps the
        // custom-emoji cache fresh (emojiCreate/Update/Delete).
        GatewayIntentBits.GuildEmojisAndStickers,
        // Non-privileged. Required for voice output (src/voice.ts):
        // joinVoiceChannel's handshake needs the voice-state cache. Harmless
        // when voice is unconfigured.
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });

    this.installThreadSyncScope();
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

  /** Optional acceptance predicates run synchronously at gateway receipt,
   *  before mutation lookup/ordering. The server owns the policy; omitting
   *  a predicate preserves the adapter's usual delivery behavior. */
  onMessageEdit(
    handler: (channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo) => void,
    accept?: (channelId: string) => boolean,
  ): void {
    this.editHandler = handler;
    this.editAccept = accept;
  }

  onMessageDelete(
    handler: (channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo) => void,
    accept?: (channelId: string) => boolean,
  ): void {
    this.deleteHandler = handler;
    this.deleteAccept = accept;
  }

  /** Register a handler for incoming Discord reactions (add/remove). The server
   *  decides per-channel whether to surface these; the adapter always emits. */
  onReaction(handler: (ev: ReactionEvent) => void): void {
    this.reactionHandler = handler;
  }

  /** Register a handler for DMs the DM allowlist refused at the gateway.
   *  It receives the refusal's identity only, never the message body. The
   *  refusals heard before it was registered are handed to it first, in
   *  order (see refuseDm). */
  onDmRefused(handler: (ev: DmRefusal) => void): void {
    this.dmRefusedHandler = handler;
    for (const ev of this.heldDmRefusals.splice(0)) handler(ev);
  }

  /** Hand a refusal to the handler, or hold it until one is registered, up
   *  to DM_REFUSALS_HELD. Past that, a refusal still leaves its operator log
   *  line, without a notice decision. */
  private refuseDm(ev: DmRefusal): void {
    if (this.dmRefusedHandler) {
      this.dmRefusedHandler(ev);
    } else if (this.heldDmRefusals.length < DM_REFUSALS_HELD) {
      this.heldDmRefusals.push(ev);
    } else {
      console.error(
        `[discord-mcpl] DM refused by the DM allowlist (${ev.origin}) before refusals were handled, past the ` +
          `${DM_REFUSALS_HELD} held until then: sender ${ev.authorId}, message ${ev.messageId}; no notice`,
      );
    }
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

  /** Snapshot of the active event filters (for filters_get and diffing).
   *  `undefined` fields mean unrestricted. */
  getFilters(): { guildIds?: string[]; guildChannels?: Record<string, string[]>; dmUsers?: string[] } {
    return {
      guildIds: this.guildIds ? [...this.guildIds] : undefined,
      guildChannels: this.guildChannels
        ? Object.fromEntries([...this.guildChannels].map(([g, s]) => [g, [...s]]))
        : undefined,
      dmUsers: this.dmUsers ? [...this.dmUsers] : undefined,
    };
  }

  /** Hot-swap the event filters (guild/channel whitelist + DM whitelist) at
   *  runtime — the fix for "whitelist changes need a full restart". All
   *  filter checks read the instance fields on every event, so the swap takes
   *  effect immediately. Returns the guild-level diff relative to the bot's
   *  actual guild membership so the caller can re-register channels and log.
   *
   *  Newly-allowed guilds the bot is already a member of also get their slash
   *  commands registered here (startup-time registration skipped them while
   *  they were filtered out). */
  updateFilters(filters: {
    guildIds?: string[];
    guildChannels?: Record<string, string[]>;
    dmUsers?: string[];
  }): { addedGuilds: string[]; removedGuilds: string[] } {
    const before = this.guildIds;
    this.guildIds = filters.guildIds?.length ? [...filters.guildIds] : undefined;
    this.guildChannels =
      filters.guildChannels && Object.keys(filters.guildChannels).length
        ? new Map(Object.entries(filters.guildChannels).map(([g, chans]) => [g, new Set(chans)]))
        : undefined;
    this.dmUsers = filters.dmUsers?.length ? new Set(filters.dmUsers) : undefined;

    const allowed = (ids: string[] | undefined, gid: string): boolean =>
      !ids?.length || ids.includes(gid);
    const addedGuilds: string[] = [];
    const removedGuilds: string[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      const was = allowed(before, guild.id);
      const now = allowed(this.guildIds, guild.id);
      if (!was && now) addedGuilds.push(guild.id);
      else if (was && !now) removedGuilds.push(guild.id);
    }

    if (this.guildCommandDefs) {
      for (const gid of addedGuilds) {
        this.client.guilds.cache
          .get(gid)
          ?.commands.set(this.guildCommandDefs)
          .catch((err: Error) => {
            console.error(
              `[discord-mcpl] Failed to register commands in newly-allowed guild ${gid}:`,
              err.message,
            );
          });
      }
    }
    return { addedGuilds, removedGuilds };
  }

  /** Fired when a channel of a listed kind (isListedKind) is created in a
   *  guild the filters admit. */
  onChannelCreate(handler: (channel: ChannelFacts) => void): void {
    this.channelCreateHandler = handler;
  }

  /** Fired when a channel of a listed kind changes (its name, its category,
   *  its permissions), in a guild the filters admit, whether or not the bot
   *  can view it: listing registers such a channel either way
   *  (getPostingChannels), so a rename re-derives what's registered, and one
   *  not yet registered is. Also fired for a forum or media channel
   *  (holdsPosts), which isn't registered, since it holds no messages, but
   *  whose posts are threads whose labels name it. `change` says whether
   *  the update can move a name from one channel to another, and whether
   *  the channel filters still admit the channel: one moved out of an
   *  admitted category is reported too, so it's forgotten. */
  onChannelUpdate(handler: (channel: ChannelFacts, change: ChannelChange) => void): void {
    this.channelUpdateHandler = handler;
  }

  /** Fired when a guild channel is deleted, with the threads the client's
   *  cache held under it: Discord sends no threadDelete for those, and
   *  discord.js drops them from its caches along with their channel. */
  onChannelDelete(handler: (guildId: string, channelId: string, threadIds: string[]) => void): void {
    this.channelDeleteHandler = handler;
  }

  /** Fired when a thread changes: renamed, archived or unarchived, locked. */
  onThreadUpdate(handler: (thread: ChannelFacts) => void): void {
    this.threadUpdateHandler = handler;
  }

  /** Fired when a thread is deleted (discord.js `threadDelete`; threads never
   *  reach `channelDelete`). discord.js reports it only for a thread it has
   *  cached: with the default caches, a live thread the bot can see is, and
   *  an archived one is swept from the cache four hours after archiving. */
  onThreadDelete(handler: (guildId: string, threadId: string) => void): void {
    this.threadDeleteHandler = handler;
  }

  /** Fired when Discord syncs a guild's threads (discord.js
   *  `threadListSync`, sent when the bot gains access to a channel), with
   *  the channels the sync covers (its `channel_ids`, or null for the whole
   *  guild), the live threads it lists, and the live threads the client held
   *  under those channels that it dropped from discord.js's caches, without
   *  a threadDelete for each: discord.js drops those their channels' threads
   *  caches hold, and the adapter the ones held outside them, such as a
   *  thread first cached as a partial. A thread is placed by the channel the
   *  client knew for it as the sync began; one whose channel wasn't known is
   *  under no covered channel, so only a sync of the whole guild drops it.
   *  An omitted thread may only have been archived, so a sync reports no
   *  deletion. The listed threads' stale marks are cleared before the
   *  handler runs, since the sync reports them as Discord has them. */
  onThreadsSynced(handler: ThreadsSyncedHandler): void {
    this.threadsSyncedHandler = handler;
  }

  /** A stale channel was fetched fresh (refetchChannel): what's registered
   *  of it may have been derived from the older facts it replaced. */
  onChannelRefreshed(handler: (channelId: string) => void): void {
    this.channelRefreshedHandler = handler;
  }

  /** A fetch left a channel stale (refetchChannel): what's registered of it
   *  may carry a name that no longer resolves to it (resolveAmong). */
  onChannelStale(handler: (channelId: string) => void): void {
    this.channelStaleHandler = handler;
  }

  /** Fired when the bot joins a new guild after startup. The handler receives
   *  the guild's channels of a listed kind that the filters admit, so the
   *  server can register them the same way it does at boot. */
  onGuildCreate(handler: (guildId: string, channels: ChannelFacts[]) => void): void {
    this.guildCreateHandler = handler;
  }

  /** Fired when the bot leaves a guild or is removed from it (discord.js
   *  `guildDelete`). discord.js drops the guild's channels from its caches
   *  without a channelDelete for each. They still exist, and the guild's
   *  guildCreate brings them back if the bot rejoins. An outage is
   *  `guildUnavailable` instead, and keeps the guild cached. */
  onGuildDelete(handler: (guildId: string) => void): void {
    this.guildDeleteHandler = handler;
  }

  /** Fired when a guild the filters admit is available again (discord.js
   *  `guildAvailable`): after an outage, after a new gateway session (READY
   *  marks every held guild unavailable first), and for each guild at login.
   *  Discord doesn't replay what happened while it was away, so this hands
   *  over what the guild has now: its channels of a listed kind the filters
   *  admit, and the ids of every channel and live thread it holds
   *  (`guild.channels.cache`, which discord.js refills from the guild's
   *  payload). The channels and threads the payload no longer lists stay in
   *  the client-wide cache, marked stale (markUnlisted). */
  onGuildAvailable(handler: (guildId: string, channels: ChannelFacts[], present: ReadonlySet<string>) => void): void {
    this.guildAvailableHandler = handler;
  }

  /** Fired when a guild the filters admit is renamed: its name is in every
   *  label of its channels. */
  onGuildRename(handler: (guildId: string) => void): void {
    this.guildRenameHandler = handler;
  }

  /** A thread's channel, when it's stale: the channel's category, which
   *  the filters can admit the thread through, may be older than Discord's,
   *  so a delivery looks the channel up too before the filters decide
   *  (channelAllowed). */
  private staleParentOf(channel: unknown): string | null {
    const thread = channel as { isThread?: () => boolean; parentId?: string | null } | null | undefined;
    if (!thread?.isThread?.() || !thread.parentId) return null;
    return this.isStale(thread.parentId) ? thread.parentId : null;
  }

  /** The catch-up's lookup of a thread's channel when it's stale, before
   *  the filters decide on the thread's missed messages, as a live event's
   *  is (staleParentOf), in a guild the filters admit. A lookup Discord
   *  answers with Unknown Channel reports the channel deleted; one that
   *  fails otherwise is logged and leaves the channel stale (lookUpChannel). */
  async lookUpStaleParent(channelId: string): Promise<void> {
    const thread = this.client.channels.cache.get(channelId) as { guildId?: string | null } | undefined;
    const guildId = thread?.guildId ?? null;
    const staleParent = guildId && this.guildAdmitted(guildId) ? this.staleParentOf(thread) : null;
    if (guildId && staleParent) await this.lookUpChannel(guildId, staleParent);
  }

  /** What the channel filters' answer for a channel rests on that the cache
   *  doesn't know or hold current (channelAllowed), in words for the
   *  catch-up's held line, or null when the answer rests on current facts.
   *  For a thread, that's its channel, whose category can admit it: not
   *  known by id, or stale. The thread's own stale mark doesn't count, since
   *  Discord doesn't move a thread to another channel. The server's
   *  threadAdmissionKnown reads a thread's channel's mark the same way, but
   *  counts a thread without a channel id as known, where the catch-up's
   *  answer for one rests on no channel at all. A thread's channel the cache
   *  doesn't hold counts as known: channelAllowed excludes through it, as
   *  the live paths do, and holding the thread back would hold it at every
   *  start for as long as the cache lacks it. For any other channel, it's
   *  the channel itself, while it's stale, since a stale channel's category
   *  may no longer be its own. That includes a channel the cache no longer
   *  holds, which something removed during the catch-up, such as a deletion,
   *  which also drops its watermark. */
  ingressFactsNotCurrent(channelId: string): string | null {
    const channel = this.client.channels.cache.get(channelId) as
      | { isThread?: () => boolean; parentId?: string | null }
      | undefined;
    if (channel?.isThread?.()) {
      if (channel.parentId == null) return "its channel isn't known";
      return this.isStale(channel.parentId) ? `its channel ${channel.parentId} is still stale after its lookup` : null;
    }
    return this.isStale(channelId) ? "it's still stale after its lookup" : null;
  }

  /** Whether the guild filter (guildIds) admits a guild. */
  private guildAdmitted(guildId: string): boolean {
    return !this.guildIds?.length || this.guildIds.includes(guildId);
  }

  /** Fetch the stale channels again (refetchChannel) whose facts a decision
   *  across channels reads, before it: resolving a channel by name, or
   *  listing channels. Those are the channels a server lists now, threads
   *  aside. A thread's facts give no name and list nothing, and a channel
   *  or thread its server no longer lists, such as one a return left out,
   *  holds no name there (uncertainGuildNames); a message from one of
   *  those, or a tool's read of it, fetches it first. A fresh fetch clears
   *  a mark and registers the channel again (onChannelRefreshed); while one
   *  stays stale, its guild's names don't resolve and it's left out of
   *  listing. A failed fetch, or one overtaken on every try, leaves its
   *  mark. Given a guild, only that guild's stale channels are fetched, as a
   *  listing of it needs; a name given without a guild reads every guild's. */
  async refreshStale(guildId?: string): Promise<void> {
    const listed = [...this.stale].filter(([id, mark]) => {
      if (guildId !== undefined && mark.guildId !== guildId) return false;
      const channel = this.client.guilds.cache.get(mark.guildId)?.channels.cache.get(id);
      return channel !== undefined && !channel.isThread();
    });
    await Promise.all(listed.map(([id]) => this.refetchChannel(id).catch((err: unknown) => {
      dbg('stale:refresh-failed', { channelId: id, error: (err as Error).message });
    })));
  }

  /** Whether the channel filters admit a guild channel or thread, a thread
   *  through its channel (or its channel's category) or its own id, as
   *  ingress and listing decide. */
  channelAdmitted(guildId: string, channelId: string, parentId: string | null): boolean {
    return this.guildAdmitted(guildId) && this.channelAllowed(guildId, channelId, parentId);
  }

  /** Whether the bot is in a guild: the client's cache holds every guild
   *  it's in, one that's unavailable in an outage included. A guild the bot
   *  leaves takes the channels its own cache holds, with their threads, out
   *  of the client's, but not a channel it had stopped listing, or that
   *  channel's threads (markUnlisted). */
  hasGuild(guildId: string): boolean {
    return this.client.guilds.cache.has(guildId);
  }

  // ── Operations ──

  /** Split text into Discord-safe chunks (<=1900 UTF-16 units), preferring
   *  newline then space boundaries; hard-splits over-long runs at a character
   *  boundary, unless one character is itself longer than the limit
   *  (hardCut). Discord rejects content over the per-message limit
   *  (DiscordAPIError 50035). */
  private splitForDiscord(text: string, limit = 1900): string[] {
    if (!text) return [];
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
      if (cut < limit * 0.5) cut = hardCut(rest, limit);
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  /** Post the automatic delivery notice in a DM channel: plain text, no
   *  mention resolution, and no mentions allowed to ping. `nonce` is
   *  enforced, so the REST layer's own retries after a lost response can't
   *  post a second copy (Discord returns the first instead). An error that
   *  carries `notPosted: true` was raised before anything was sent: the
   *  channel lookup failed, gave no channel, or gave one that holds no
   *  messages. */
  async sendDmNotice(channelId: string, content: string, nonce: string): Promise<{ messageId: string }> {
    const channel = await this.channelById(channelId).catch((err: unknown) => {
      throw Object.assign(
        new Error(`could not look up channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`),
        { notPosted: true },
      );
    });
    // A DM has no server, so discord.js returns null for one only when it
    // can't build its kind: that one cause, and nothing retries the notice.
    if (!channel) throw Object.assign(unhandledKind(channelId, 'nothing was sent'), { notPosted: true });
    if (!('send' in channel)) {
      throw Object.assign(noMessagesHere(channel, channelId, 'nothing was sent'), { notPosted: true });
    }
    const sent = await (channel as DMChannel).send({
      content,
      allowedMentions: { parse: [] },
      nonce,
      enforceNonce: true,
    });
    return { messageId: sent.id };
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string; files?: OutgoingFile[]; requireReplyTarget?: boolean },
  ): Promise<{ messageId: string }> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was sent');
    if (!('send' in channel)) throw noMessagesHere(channel, channelId, 'nothing was sent');
    const resolved = await this.resolveOutgoingMentions(channel, content);
    const attachments = buildAttachments(options?.files);
    const chunks = this.splitForDiscord(resolved);
    // Files-only message (no text): still send one message carrying the files.
    if (chunks.length === 0 && attachments.length > 0) chunks.push('');
    let lastId = '';
    const posted: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      // Attach files to the LAST chunk so they render after the full text.
      const isLast = i === chunks.length - 1;
      const sent = await (channel as TextChannel | DMChannel).send({
        content: chunks[i] || undefined,
        // A reply to a message that's gone fails rather than posting
        // unthreaded: discord.js sends fail_if_not_exists from the client's
        // failIfNotExists option, true by default. requireReplyTarget states
        // it for a reply whose target the server chose (a latestFrom
        // selection), so that one keeps failing whatever the default for
        // other replies becomes (#58 makes them post unthreaded instead).
        reply: i === 0 && options?.replyTo
          ? { messageReference: options.replyTo, ...(options.requireReplyTarget ? { failIfNotExists: true } : {}) }
          : undefined,
        files: isLast && attachments.length > 0 ? attachments : undefined,
        // Each part carries a nonce of its own that Discord enforces: the REST
        // client sends a part again after a 5xx, a timeout or a reset
        // connection, and if the first attempt posted, Discord answers a
        // repeat sent within a few minutes with that message instead of
        // posting another.
        nonce: SnowflakeUtil.generate().toString(),
        enforceNonce: true,
      }).catch((err: unknown) => {
        throw withPostedParts(err, posted, chunks, attachments.length > 0, Boolean(options?.replyTo));
      });
      posted.push(sent.id);
      lastId = sent.id;
    }
    return { messageId: lastId };
  }

  /** Resolve a DM recipient that may be a numeric user ID **or** a
   *  username / handle. A snowflake (17–20 digits) passes through unchanged.
   *  Otherwise the bot's cached guild members across all shared servers — plus
   *  the recipients of any open DM channels (so a reply to someone who DMed the
   *  bot resolves even with no shared server) — are searched case-insensitively
   *  against nickname / global name / display name / username for a UNIQUE
   *  match. The member cache is warmed at startup and kept current by gateway
   *  events — the same source `resolveOutgoingMentions` uses for @handle pings.
   *  Throws a clear error on no match or ambiguity so the caller knows to pass a
   *  numeric ID. */
  private async resolveRecipientId(recipient: string): Promise<string> {
    const raw = recipient.trim().replace(/^@/, '');
    if (/^\d{17,20}$/.test(raw)) return raw; // already a Discord user ID
    const target = raw.toLowerCase();
    const selfId = this.client.user?.id;
    const matches = new Map<string, string>(); // id -> username (dedup across guilds)
    for (const guild of this.client.guilds.cache.values()) {
      for (const member of guild.members.cache.values() as IterableIterator<GuildMember>) {
        if (member.user.id === selfId || member.user.bot) continue;
        const aliases = [
          member.nickname,
          (member.user as User & { globalName?: string | null }).globalName,
          member.user.displayName,
          member.user.username,
        ];
        if (aliases.some((a) => typeof a === 'string' && a.toLowerCase() === target)) {
          matches.set(member.user.id, member.user.username);
        }
      }
    }
    // Also match the recipients of open DM channels. Someone who DMed the bot
    // can share no guild with it, so the guild-member scan above can't see them —
    // but we hold an open DM channel whose recipient we CAN resolve by name. This
    // makes a name-based reply to a DM sender work without a shared server.
    for (const channel of this.client.channels.cache.values()) {
      const recipient = (channel as { recipient?: User }).recipient;
      if (!recipient || recipient.id === selfId || recipient.bot) continue;
      const aliases = [
        (recipient as User & { globalName?: string | null }).globalName,
        recipient.displayName,
        recipient.username,
      ];
      if (aliases.some((a) => typeof a === 'string' && a.toLowerCase() === target)) {
        matches.set(recipient.id, recipient.username);
      }
    }
    if (matches.size === 1) return [...matches.keys()][0]!;
    if (matches.size === 0) {
      throw new Error(
        `No Discord member matches "${recipient}". Pass a numeric user ID, or the exact ` +
          `@username / display name of someone in a shared server.`,
      );
    }
    throw new Error(
      `"${recipient}" is ambiguous — ${matches.size} members match ` +
        `(${[...matches.values()].slice(0, 5).join(', ')}). Use the numeric user ID.`,
    );
  }

  async sendDM(
    userId: string,
    content: string,
    options?: { files?: OutgoingFile[] },
  ): Promise<{ messageId: string; channelId: string; recipientName: string }> {
    const resolvedId = await this.resolveRecipientId(userId);
    const user = await this.client.users.fetch(resolvedId);
    // For DMs, the only resolvable user is the recipient. We resolve against
    // the DM channel we're about to send to. Return the DM channel ID too so
    // the caller can update sticky-reply state.
    const dm = await user.createDM();
    // The username, as the registry's DM descriptor names the DM.
    const recipientName = user.username;
    try {
      const resolved = await this.resolveOutgoingMentions(dm, content);
      const attachments = buildAttachments(options?.files);
      const chunks = this.splitForDiscord(resolved);
      if (chunks.length === 0 && attachments.length > 0) chunks.push('');
      let lastId = '';
      const posted: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const sent = await user.send({
          content: chunks[i] || undefined,
          files: isLast && attachments.length > 0 ? attachments : undefined,
          // An enforced nonce for each part, as sendMessage gives.
          nonce: SnowflakeUtil.generate().toString(),
          enforceNonce: true,
        }).catch((err: unknown) => {
          throw withPostedParts(err, posted, chunks, attachments.length > 0, false);
        });
        posted.push(sent.id);
        lastId = sent.id;
      }
      return { messageId: lastId, channelId: dm.id, recipientName };
    } catch (err) {
      // The DM channel was resolved before this failure: carry it on the
      // error (DmSendFailure) so the caller can name the attempted destination.
      if (err && typeof err === 'object') Object.assign(err, { dmChannel: { id: dm.id, recipientName } });
      throw err;
    }
  }

  /** The recipient's username for a cached DM channel, or null when the channel
   *  isn't cached, isn't a DM, or its recipient can't be read. Labels a DM
   *  the channel registry hasn't seen. */
  getCachedDmRecipientName(channelId: string): string | null {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.DM) return null;
    try {
      const recipient = (channel as DMChannel).recipient;
      return recipient ? recipient.username : null; // as the registry's DM descriptor names it
    } catch {
      return null; // reading the recipient needs the logged-in user
    }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was edited');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'nothing was edited');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const resolved = await this.resolveOutgoingMentions(channel, content);
    await msg.edit(resolved);
  }

  /** Resolve human-readable @handle mentions in outgoing content to Discord's
   *  ping syntax — `<@USER_ID>` for users, `<@&ROLE_ID>` for roles. Lena learns
   *  the @handle form from incoming cleanContent and tends to imitate it, but
   *  Discord only treats the bracket syntax as an actual ping.
   *
   *  User resolution checks (case-insensitive) the channel's guild members
   *  against server nickname, global display name, and username. Role
   *  resolution checks guild role names.
   *
   *  Priority: when a name matches both a user and a role, the USER wins
   *  (people are pinged more often than roles, and a wrong role ping is
   *  noisier). Roles are only used when no user matches that handle.
   *
   *  Skips `@everyone` / `@here` (Discord handles those natively, and so is the
   *  default @everyone role) and the bot's own identity (don't self-ping when
   *  Lena writes about herself in third person). Leaves the original text
   *  untouched when there are zero matches or multiple ambiguous matches —
   *  better to fail to ping than to ping the wrong person/role.
   *
   *  Note: emitting `<@&id>` only produces an actual ping if the role is
   *  mentionable or the bot has the Mention Everyone permission; otherwise it
   *  renders as a styled role link without notifying. That's a Discord-side
   *  permission concern, not a parsing one. */
  private async resolveOutgoingMentions(
    channel: unknown,
    content: string,
  ): Promise<string> {
    const selfId = this.client.user?.id;
    const candidates: MentionCandidate[] = [];

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
        candidates.push({ id: member.user.id, aliases, kind: 'user' });
      }
      // Roles. The role cache is gateway-maintained (Guilds intent) like
      // members. Skip the default @everyone role (its id equals the guild id) —
      // Discord pings @everyone natively and that handle is short-circuited.
      for (const role of ch.guild.roles.cache.values() as IterableIterator<Role>) {
        if (role.id === ch.guild.id) continue;
        if (typeof role.name === 'string' && role.name.length > 0) {
          candidates.push({ id: role.id, aliases: [role.name], kind: 'role' });
        }
      }
    } else if (ch.recipient) {
      if (ch.recipient.id !== selfId) {
        const aliases = [
          (ch.recipient as User & { globalName?: string | null }).globalName,
          ch.recipient.displayName,
          ch.recipient.username,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        candidates.push({ id: ch.recipient.id, aliases, kind: 'user' });
      }
    }

    return applyMentionCandidates(content, candidates);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was deleted');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'nothing was deleted');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.delete();
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'no reaction was added');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'no reaction was added');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    await msg.react(this.resolveReactionEmoji(emoji, msg.guild));
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'no reaction was removed');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'no reaction was removed');
    const msg = await (channel as TextChannel).messages.fetch(messageId);
    const selfId = this.client.user?.id;
    if (!selfId) throw new Error('Discord bot user is not ready');

    const resolved = this.resolveReactionEmoji(emoji, msg.guild);
    const customId = resolved.match(/(?:<a?:\w+:|^\w+:)(\d+)>?$/)?.[1];
    const bare = emoji.trim().replace(/^:+|:+$/g, '');
    const reaction = msg.reactions.cache.find((candidate) =>
      candidate.emoji.id === customId
      || candidate.emoji.name === emoji.trim()
      || candidate.emoji.name === bare
      || candidate.emoji.toString() === emoji.trim());
    if (!reaction) return; // Idempotent: the bot's marker is already absent.
    await reaction.users.remove(selfId);
  }

  /** Turn a caller-supplied emoji into something discord.js `.react()` accepts.
   *  Unicode chars and the full custom forms ('<:name:id>', 'name:id') pass
   *  through untouched; a bare ':name:' or 'name' is resolved to a cached custom
   *  emoji's 'name:id' identifier so custom reactions actually land (a bare name
   *  is not resolvable by discord.js). Falls back to the input unchanged
   *  (treated as unicode) when nothing matches. */
  private resolveReactionEmoji(emoji: string, guild: Guild | null): string {
    const trimmed = emoji.trim();
    if (/^<a?:\w+:\d+>$/.test(trimmed) || /^\w+:\d+$/.test(trimmed)) return trimmed;
    const bare = trimmed.replace(/^:+|:+$/g, '');
    if (/^\w{2,}$/.test(bare)) {
      const found =
        guild?.emojis.cache.find((e) => e.name === bare) ??
        this.client.emojis.cache.find((e) => e.name === bare);
      if (found) return found.identifier;
    }
    return trimmed;
  }

  /** Resolve a (possibly partial) reaction event and hand it to the registered
   *  reaction handler. Skips the bot's own reactions and channels it can't see.
   *  Best-effort: a reaction we can't resolve is dropped, not surfaced as noise. */
  private async handleReactionEvent(
    action: 'add' | 'remove',
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (!this.reactionHandler) return;
    try {
      if (user.id === this.client.user?.id) return; // ignore our own reactions
      const full = reaction.partial ? await reaction.fetch() : reaction;
      const msg = full.message;
      const guildId = msg.guildId ?? null;
      // A create still waiting for its thread's lookup goes first, so a
      // reaction never arrives before the message it's on.
      await this.threadLookups.get(msg.channelId);
      if (guildId && !this.guildAdmitted(guildId)) return;
      if (guildId && (threadChannelUnknown(msg.channel) || this.isStale(msg.channelId))) {
        await this.lookUpChannel(guildId, msg.channelId);
      }
      const staleParent = guildId ? this.staleParentOf(msg.channel) : null;
      if (guildId && staleParent) await this.lookUpChannel(guildId, staleParent);
      // msg.channel resolves through the client cache, so it's what the
      // lookup left there.
      const parentId =
        msg.channel && 'parentId' in msg.channel
          ? ((msg.channel as { parentId?: string | null }).parentId ?? null)
          : null;
      if (!this.channelAllowed(guildId, msg.channelId, parentId)) return;
      const reactor = user.partial ? await user.fetch().catch(() => user) : user;
      const e = full.emoji;
      const custom = Boolean(e.id);
      const authorId = msg.author?.id ?? null;
      // The reacted-to message can itself be partial (uncached history);
      // fetch it so the event can carry a content snippet — an id alone is
      // meaningless to the agent. Best-effort: unresolvable → null snippet.
      const resolvedMsg = msg.partial ? await msg.fetch().catch(() => null) : msg;
      const snippetSource = resolvedMsg
        ? ((resolvedMsg as { cleanContent?: string | null }).cleanContent ?? resolvedMsg.content)
        : null;
      this.reactionHandler({
        action,
        channelId: msg.channelId,
        messageId: msg.id,
        guildId,
        ...this.threadPlace(msg.channel, msg.channelId),
        emoji: custom ? `:${e.name}:` : e.name ?? '?',
        emojiId: e.id ?? null,
        token: custom ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name ?? '',
        userId: reactor.id,
        userName: reactor.username ?? reactor.id,
        onOwnMessage: authorId != null && authorId === this.client.user?.id,
        messageAuthorId: authorId,
        messageSnippet: buildReactionSnippet(snippetSource),
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('[discord-mcpl] reaction event failed:', (err as Error).message);
    }
  }

  /** A channel's messages, newest first. When the channel can't be read,
   *  its error says what didn't happen in the caller's words (`nothing`),
   *  'nothing was read' by default. */
  async fetchHistory(
    channelId: string,
    options?: { limit?: number; before?: string; after?: string; nothing?: string },
  ): Promise<HistoryMessage[]> {
    const nothing = options?.nothing ?? 'nothing was read';
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, nothing);
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, nothing);
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
        const cleanContent = renderCustomEmojis(resolveVisibleContent(m));
        collected.push({
          id: m.id,
          authorId: m.author.id,
          authorName: m.author.username,
          authorDisplayName: m.member?.displayName ?? m.author.displayName,
          isBot: m.author.bot,
          ...(m.system ? { system: true as const } : {}),
          content: cleanContent,
          cleanContent,
          attachments: mapAllAttachments(m),
          reactions: extractReactions(m),
          mentionsBot: this.messageMentionsBot(m),
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

  /** Fetch a window of messages centred on `messageId` — the "scroll to a
   *  message" primitive. Uses Discord's `around` parameter, which returns the
   *  target message plus roughly half the window on either side of it. This is
   *  a SINGLE REST fetch (no pagination) and is therefore capped at 100 by the
   *  Discord API; values above 100 are clamped. The target message itself is
   *  included in the result. Messages are returned oldest → newest so the
   *  window reads naturally as a transcript. */
  async fetchAround(
    channelId: string,
    messageId: string,
    limit = 50,
  ): Promise<HistoryMessage[]> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was read');
    if (!('messages' in channel)) throw noMessagesHere(channel, channelId, 'nothing was read');
    const pageLimit = Math.min(100, Math.max(1, limit));
    const page = await (channel as TextChannel).messages.fetch({
      around: messageId,
      limit: pageLimit,
    });
    const collected: HistoryMessage[] = [...page.values()].map((m) => {
      const cleanContent = renderCustomEmojis(resolveVisibleContent(m));
      return {
        id: m.id,
        authorId: m.author.id,
        authorName: m.author.username,
        authorDisplayName: m.member?.displayName ?? m.author.displayName,
        isBot: m.author.bot,
        ...(m.system ? { system: true as const } : {}),
        content: cleanContent,
        cleanContent,
        attachments: mapAllAttachments(m),
        reactions: extractReactions(m),
        mentionsBot: this.messageMentionsBot(m),
        timestamp: m.createdAt,
      };
    });
    // discord.js returns the `around` window unsorted; present oldest → newest.
    collected.sort((a, b) => a.id.localeCompare(b.id, 'en-US-u-kn-true'));
    return collected;
  }

  /**
   * The channel an exact channels/open selector names, when this server
   * serves it, for one the registry doesn't hold yet (a DM or thread after a
   * restart, say). `guildSegment` is the MCPL id's middle part: a guild id,
   * or `dm`.
   *
   * Served means a channel the registry's own paths would register: in that
   * guild, a channel messages are posted in (isListedKind: text,
   * announcement, voice, stage) or a thread, which the guild filter and the
   * channel list admit (a thread through its channel); or a DM whose
   * recipient the DM list admits. Anything else is null: a category or
   * forum, which hold no messages, a kind this server doesn't know, another
   * guild, a channel the filters refuse, an id Discord refuses, and a lookup
   * that finds nothing. A guild channel comes back as the facts its
   * descriptor is made from. A DM's recipient is its other party as the DM
   * list reads it (dmOtherParty): when the cache can't name one, Discord is
   * asked again, past the cache, by the freshness rule, and a DM whose other
   * party that answer doesn't name either is null.
   *
   * The channel is read as the tools read one (channelById): from the cache
   * when it holds the channel whole and current, else from Discord by the
   * freshness rule, so Unknown Channel there is a deletion (channelGone). A
   * thread's stale channel is looked up first, as a delivery's is, since its
   * category may be what admits the thread. A channel that is still stale
   * then, or a thread whose channel is, comes back as `uncertain`, and so
   * does a lookup Discord gives no answer to: its facts decide no
   * registration until a fresh fetch.
   */
  async lookUpServedChannel(guildSegment: string, channelId: string): Promise<
    | { kind: 'guild'; facts: ChannelFacts }
    | { kind: 'dm'; recipientId: string; recipientName: string }
    | { kind: 'uncertain' }
    | null
  > {
    let channel: Channel | null;
    try {
      channel = await this.channelById(channelId);
    } catch (err) {
      return lookUpFailure(channelId, err);
    }
    if (!channel) return null;
    if (guildSegment === 'dm') {
      if (channel.type !== ChannelType.DM) return null;
      // discord.js holds a DM it has seen a message in as whole, whatever
      // recipients it recorded, and when the bot's own message was the first
      // it saw there, it recorded only the bot. Its recipientId getter then
      // gives the bot's id, so the other party is read as the DM list reads
      // it.
      let recipientId = this.dmOtherParty(channel);
      if (!recipientId) {
        try {
          recipientId = this.dmOtherParty(await this.refetchChannel(channelId));
        } catch (err) {
          return lookUpFailure(channelId, err);
        }
      }
      if (!recipientId || (this.dmUsers && !this.dmUsers.has(recipientId))) return null;
      // The username, as an inbound DM's descriptor is labelled.
      const recipient = this.client.users.resolve(recipientId) ?? (await this.client.users.fetch(recipientId).catch(() => null));
      // The DM list may have changed while the name was fetched.
      if (this.dmUsers && !this.dmUsers.has(recipientId)) return null;
      return { kind: 'dm', recipientId, recipientName: recipient?.username ?? recipientId };
    }
    if (!('guildId' in channel) || channel.guildId !== guildSegment) return null;
    const staleParent = this.staleParentOf(channel);
    if (staleParent) await this.lookUpChannel(channel.guildId, staleParent);
    if (this.isStale(channelId) || (staleParent !== null && this.isStale(staleParent))) return { kind: 'uncertain' };
    const facts = this.channelFacts(channel);
    if (!facts) return null;
    if (!isListedKind(facts.type) && facts.type !== 'thread') return null;
    if (!this.channelAdmitted(facts.guildId, facts.id, facts.parentId ?? null)) return null;
    return { kind: 'guild', facts };
  }

  /** Resolve display metadata for a channel by ID — used by the reconnect
   *  catch-up sweep to label `<missed>` blocks. Rejects when the lookup
   *  fails (the sweep catches it); for a channel found, fields it can't name
   *  are null, and `isDM` is null when the channel's kind isn't known. A
   *  thread the client knows only partly is fetched past the cache, which
   *  would hand back that same partial. */
  async getChannelMeta(channelId: string): Promise<ChannelMeta> {
    return this.extractChannelMeta(await this.channelById(channelId), channelId);
  }

  /** A channel as the tools and reads use it. One the cache holds whole,
   *  and current, is read from it, as discord.js's fetch would; anything
   *  else is fetched from Discord through refetchChannel, so the fill
   *  follows the freshness rule and clears a stale mark when nothing
   *  overtakes it. */
  private async channelById(channelId: string): Promise<Channel | null> {
    const cached = this.client.channels.cache.get(channelId);
    if (cached && !cached.partial && !threadChannelUnknown(cached) && !this.isStale(channelId)) return cached;
    // One the cache doesn't hold, discord.js's own fetch asks Discord for.
    return this.refetchChannel(channelId, { force: cached !== undefined });
  }

  /** Cache-only variant of getChannelMeta: gateway-cache lookup, no REST,
   *  synchronous. Null when the channel isn't cached (as opposed to cached
   *  but metadata-sparse) — callers decide whether to fall back to REST. */
  getCachedChannelMeta(channelId: string): ChannelMeta | null {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel) return null;
    return this.extractChannelMeta(channel, channelId);
  }

  /** A cached channel's name is known only while its facts are fresh. */
  private knownName(channelId: string, name: unknown): string | null {
    return typeof name === 'string' && name.length > 0 && !this.isStale(channelId) ? name : null;
  }

  private extractChannelMeta(channel: unknown, channelId: string): ChannelMeta {
    if (!channel) return { name: null, guildId: null, guildName: null, isDM: null };
    const c = channel as {
      name?: string;
      guildId?: string | null;
      guild?: { name?: string };
      isDMBased?: () => boolean;
    };
    const guildId = c.guildId ?? null;
    // DM-ness comes from the channel's own kind, never from a missing guild
    // id: a sparse or partial object leaves it unknown, so no caller can
    // mistake an unresolved channel for a DM.
    const isDM = typeof c.isDMBased === 'function' ? c.isDMBased() : guildId ? false : null;
    return {
      // A stale channel's name may no longer be Discord's, so it's unknown.
      name: this.knownName(channelId, c.name),
      guildId,
      guildName: c.guild?.name ?? null,
      isDM,
      ...this.threadPlace(channel, channelId),
    };
  }

  /** The thread a message in this channel was posted in, when the channel is
   *  a thread (ThreadPlace); nothing otherwise. The parent is looked up in
   *  the client's channel cache by parentId, as channelAllowed does, rather
   *  than through discord.js `ThreadChannel.parent`: that getter goes through
   *  the thread's guild and throws when it has none, and a throw while
   *  converting a message drops the whole message, where an unknown parent
   *  should cost only its name. */
  private threadPlace(channel: unknown, channelId: string): ThreadPlace {
    const c = channel as { isThread?: () => boolean; name?: string | null; parentId?: string | null } | null | undefined;
    if (!c || typeof c.isThread !== 'function' || !c.isThread()) return {};
    // A stale channel's name may no longer be Discord's, so it's unknown,
    // the thread's own as well as its channel's.
    const parent = c.parentId
      ? (this.client.channels.cache.get(c.parentId) as { name?: string } | undefined)
      : undefined;
    const threadName = this.knownName(channelId, c.name);
    return {
      threadId: channelId,
      ...(threadName !== null ? { threadName } : {}),
      threadParentName: c.parentId ? this.knownName(c.parentId, parent?.name) : null,
    };
  }

  /** A guild channel's facts as the client's cache has them now, or null when
   *  the cache doesn't hold it (or it's a DM). getChannelMeta's REST fetch
   *  caches what it fetches, so after it this answers for an uncached channel
   *  too. What the server registers a channel by, whichever path registers
   *  it (toDescriptor). */
  getCachedChannelFacts(channelId: string): ChannelFacts | null {
    return this.channelFacts(this.client.channels.cache.get(channelId));
  }

  /** getCachedChannelFacts for each of several channels, those the cache
   *  holds, read against one view of the channels names resolve among
   *  (nameView), as a re-derivation of many registered channels needs. */
  getCachedChannelFactsFor(channelIds: Iterable<string>): Map<string, ChannelFacts> {
    const names = this.nameView();
    const result = new Map<string, ChannelFacts>();
    for (const channelId of channelIds) {
      const facts = this.channelFacts(this.client.channels.cache.get(channelId), names);
      if (facts) result.set(channelId, facts);
    }
    return result;
  }

  /** A guild channel's facts, read from the channel and the client's caches.
   *  The guild and a thread's parent are looked up by id, as threadPlace
   *  looks up a parent: discord.js's `ThreadChannel.parent` getter goes
   *  through the thread's guild and throws when it has none. `names` is the
   *  view nameResolves is read against; a batch of facts shares one, and
   *  one channel's reads only the channels of its own name. */
  private channelFacts(channel: unknown, names?: NameView): ChannelFacts | null {
    const c = channel as {
      id?: string; guildId?: string | null; type?: number; name?: string | null;
      parentId?: string | null; archived?: boolean | null; archiveTimestamp?: number | null;
    } | null | undefined;
    if (!c?.id || !c.guildId) return null;
    const type = mapChannelType(c.type);
    const named = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    const parent = type === 'thread' && c.parentId
      ? (this.client.channels.cache.get(c.parentId) as { name?: string } | undefined)
      : undefined;
    const facts: ChannelFacts = {
      id: c.id,
      guildId: c.guildId,
      guildName: named(this.client.guilds.cache.get(c.guildId)?.name),
      type,
      name: this.knownName(c.id, c.name),
      parentId: c.parentId ?? null,
      // A stale channel's name may no longer be Discord's: a thread's facts
      // leave it unknown, so a registration keeps the name it knew
      // (knowsLessThan) and a new one goes without.
      parentName: c.parentId ? this.knownName(c.parentId, parent?.name) : null,
      archived: type === 'thread' && c.archived === true,
    };
    if (facts.archived && typeof c.archiveTimestamp === 'number' && Number.isFinite(c.archiveTimestamp)) {
      facts.archivedAt = c.archiveTimestamp;
    }
    if (isNameAddressableKind(type) && facts.name && facts.guildName) {
      const resolved = this.resolveAmong(formatChannelLabel(facts.name, facts.guildName), names ?? this.nameView(facts.name));
      facts.nameResolves = resolved.ok && resolved.id === facts.id;
    }
    return facts;
  }

  /** Compare two Discord snowflake IDs numerically without BigInt parsing.
   *  Snowflakes are 64-bit so we use locale numeric collation. */
  private snowflakeLte(a: string, b: string): boolean {
    return a.localeCompare(b, 'en-US-u-kn-true') <= 0;
  }

  /** Whether a fetched message addresses the bot — explicit @mention or a
   *  reply targeting it. Mirrors the live-path logic in convertMessage
   *  (`mentions.users` + `mentions.repliedUser`). Returns false when the bot
   *  user isn't known yet. */
  private messageMentionsBot(m: Message): boolean {
    const botId = this.client.user?.id;
    if (!botId) return false;
    return (
      m.mentions.users.has(botId) ||
      m.mentions.repliedUser?.id === botId ||
      m.mentions.roles.some((r) => (r as { tags?: { botId?: string } }).tags?.botId === botId)
    );
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  }

  getGuildName(guildId: string): string {
    return this.client.guilds.cache.get(guildId)?.name ?? guildId;
  }

  /** Resolve a DM channel's recipient for descriptor labels. Returns null if
   *  the id isn't a DM channel or the fetch fails (deleted account etc.). */
  async getDmChannelInfo(
    channelId: string,
  ): Promise<{ recipientId: string; recipientName: string } | null> {
    try {
      const channel = await this.channelById(channelId);
      if (!channel || channel.type !== ChannelType.DM) return null;
      const dm = channel as DMChannel;
      const recipient =
        dm.recipient ?? (dm.recipientId ? await this.client.users.fetch(dm.recipientId) : null);
      if (!recipient) return null;
      return { recipientId: recipient.id, recipientName: recipient.username };
    } catch {
      return null;
    }
  }

  /** Timeout for the bulk guild-member fetch. Instance-scoped so tests can
   *  shrink it; 30s in production. */
  private memberFetchTimeoutMs = 30_000;

  /** Bulk-fetch all members of a guild into the local cache. Idempotent
   *  (safe to call multiple times). Wrapped in a timeout so that
   *  misconfigured intents — portal-disabled but client-requested, for
   *  instance — fail fast with a clear error instead of hanging the
   *  whole client. Returns whether the warm-up succeeded; callers whose
   *  correctness depends on a FULL cache (permission-computed member lists)
   *  must check it — a partial cache silently narrows their answer. */
  private async warmGuildMemberCache(guild: Guild): Promise<boolean> {
    // The cache already holds every member: nothing to download.
    if (guild.memberCount > 0 && guild.members.cache.size >= guild.memberCount) return true;
    const TIMEOUT_MS = this.memberFetchTimeoutMs;
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
      return true;
    } catch (err) {
      console.error(
        `[discord-mcpl] member cache warm-up failed for "${guild.name}": ${(err as Error).message}`,
      );
      return false;
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
      const channel = await this.channelById(channelId);
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

  /** A guild's channels as the gateway keeps them: GUILD_CREATE lists every
   *  channel and updates follow, so the guild's own cache is whole while the
   *  guild is available, and reading it writes nothing to the cache that a
   *  REST reply could make older (refetchChannel). Threads aren't listed, as
   *  the REST list never had them; categories and forums are. A guild in an
   *  outage is refused rather than listed from what it held before, before
   *  anything is fetched for it, and again after, since an outage can begin
   *  meanwhile. A stale channel of the guild is fetched first (refreshStale),
   *  through the freshness rule, as for a name, so it's listed as Discord
   *  has it now; one still stale is left out, as the registration listings
   *  leave it out (guildPostingChannels), since its category and name may be
   *  older than Discord's. */
  async listChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild?.channels) {
      throw new Error(`Guild ${guildId} not found`);
    }
    const unavailable = () => new Error(
      `Nothing was listed: server ${guildId} is unavailable in a Discord outage, so its channels can't be listed until ` +
        "it's back. The same call can list them then.",
    );
    if (!guild.available) throw unavailable();
    await this.refreshStale(guildId);
    // An outage can begin while those fetches are out.
    if (!guild.available) throw unavailable();
    const names = this.nameView();
    const result: DiscordChannelInfo[] = [];
    guild.channels.cache.forEach((c: GuildBasedChannel) => {
      if (!c.isThread()) {
        if (this.isStale(c.id)) return;
        if (!this.channelAllowed(guildId, c.id, c.parentId)) return;
        const facts = this.channelFacts(c, names);
        result.push({
          id: c.id,
          name: c.name,
          type: mapChannelType(c.type),
          parentId: c.parentId ?? undefined,
          label: facts ? channelLabelFor(facts) : mcplChannelId(guildId, c.id),
        });
      }
    });
    return result;
  }


  /**
   * Resolve a channel reference that may be a name instead of a snowflake.
   *
   * Accepts a raw id or the MCPL composite unchanged; otherwise resolves
   * `#name` / `#name (GuildName)` against the channels the bot can currently
   * see. See `channel-names.ts` for why, and for the no-fuzzy-matching rule.
   *
   * Inverse of `resolveChannelMeta` in server.ts (id -> label); this is
   * label -> id. The two are siblings and should stay consistent about which
   * channels are addressable.
   *
   * THREE THINGS THIS DELIBERATELY DOES:
   *
   * 1. Reads the LIVE cache every call, never a startup snapshot. discord.js
   *    keeps `guild.channels.cache` current from gateway events. A cached
   *    name->id map would go stale on rename, and if a freed name were later
   *    reused by a different channel it would deliver silently to the wrong
   *    room — reintroducing the exact failure this feature removes.
   * 2. Applies `channelAllowed` BEFORE matching, so a name can never address a
   *    channel the allowlist excludes, and an excluded `#general` cannot
   *    manufacture a spurious collision with a permitted one.
   * 3. Matches only the sendable kinds: text, announcement, voice and
   *    stage channels (SENDABLE in channel-names.ts). Categories, forums,
   *    media and directory channels, and threads, are given by id. Thread
   *    names are not unique — not even within one channel — so including them
   *    would make the ambiguity error fire constantly and render the feature
   *    unusable.
   */
  resolveChannelRef(ref: string): ResolveResult {
    return this.resolveAmong(ref, this.nameView());
  }

  /** resolveChannelRef, against a given view of the candidates. A name is
   *  matched only among candidates of that name (resolveChannelName compares
   *  lowercased names), so its group is all the matcher needs. */
  private resolveAmong(ref: string, names: NameView): ResolveResult {
    const parsed = parseChannelRef(ref);
    if (!parsed) {
      return { ok: false, reason: 'not-found', message: `Unusable channel reference: "${ref}"` };
    }
    if (parsed.kind === 'id') return { ok: true, id: parsed.id };
    // A pasted thread label is refused by its shape, which no fact about a
    // server changes, so before what follows: as a name it could reach a
    // voice or stage room whose name has the same shape (formatThreadLabel).
    if (isThreadLabelShape(parsed.name)) return threadLabelRefusal(ref);
    // A stale channel's current name isn't known: Discord may have renamed
    // it to any name, this one included, so no name in its guild resolves
    // while it's stale, whichever channel holds the name in the cache, and
    // no name given without a guild resolves while any guild has one. So
    // the label of every channel a name addresses there is its id meanwhile
    // (channelFacts). A name-addressed tool fetches stale channels first
    // (refreshStale), so this holds while no fetch of the channel is fresh.
    const uncertain = names.uncertainGuilds();
    if (parsed.guild === undefined ? uncertain.any : uncertain.named.has(parsed.guild.toLowerCase())) {
      const where = parsed.guild === undefined ? 'a server this name could mean' : 'that server';
      return {
        ok: false, reason: 'ambiguous',
        message: `Nothing was done: ${ref} can't be resolved by name right now, since Discord's current facts for a channel in ${where} aren't known (its latest fetch failed or was overtaken by a change), so its current name may be this one. Address the channel by its id instead: until that fetch succeeds, each channel the name could mean there is shown by its id wherever its label would be, and list_channels lists the others with their ids.`,
      };
    }
    return resolveChannelName(parsed, names(parsed.name));
  }

  /** The guilds where a stale channel may hold a name, by lowercased name,
   *  and whether there's any, a guild without a known name included:
   *  its guild lists it now, the guild filter admits that guild, and it's of
   *  a kind a name addresses. Its category may be stale too, so the channel
   *  filters aren't applied. A channel its guild no longer lists, such as
   *  one a return left out, holds no name there. Read once per name view. */
  private uncertainGuildNames(): { named: Set<string>; any: boolean } {
    const named = new Set<string>();
    let any = false;
    for (const [id, { guildId }] of this.stale) {
      if (!this.guildAdmitted(guildId)) continue;
      const guild = this.client.guilds.cache.get(guildId);
      const channel = guild?.channels.cache.get(id);
      if (!guild || !channel || !isNameAddressableKind(mapChannelType(channel.type))) continue;
      // A guild whose name isn't known can't be named, but a name given
      // without a guild could mean one of its channels.
      any = true;
      if (guild.name) named.add(guild.name.toLowerCase());
    }
    return { named, any };
  }

  /** The channels a name resolves among, read from the live cache (see
   *  resolveChannelRef) when first asked and grouped by lowercased name. A
   *  view is fresh for one call or one batch: a listing, or the facts of
   *  many channels at once, reads every channel's name against the same
   *  view instead of building the candidates again for each. Given a name,
   *  the view holds only the channels of that name, which is all one
   *  channel's facts read. */
  private nameView(only?: string): NameView {
    const key = only?.toLowerCase();
    const channelsOf = (g: Guild): Iterable<GuildBasedChannel> =>
      key === undefined ? g.channels.cache.values() : channelsNamed(g.channels.cache.values(), key);
    let byName: Map<string, ChannelCandidate[]> | undefined;
    let uncertain: { named: Set<string>; any: boolean } | undefined;
    const view = ((name: string) => {
      if (!byName) {
        byName = new Map();
        const candidates = buildCandidates(
          // A guild known only by id has no name yet (discord.js's stub).
          [...this.client.guilds.cache.values()].map((g) => ({
            id: g.id, name: g.name ?? '', channels: channelsOf(g),
          })),
          {
            ...(this.guildIds?.length ? { guildIds: this.guildIds } : {}),
            mapType: mapChannelType,
            allowed: (gid, cid, pid) => this.channelAllowed(gid, cid, pid),
          },
        );
        for (const c of candidates) {
          const key = c.name.toLowerCase();
          const group = byName.get(key);
          if (group) group.push(c);
          else byName.set(key, [c]);
        }
      }
      return byName.get(name.toLowerCase()) ?? [];
    }) as NameView;
    view.uncertainGuilds = () => (uncertain ??= this.uncertainGuildNames());
    return view;
  }

  /** Channel membership, by scope. Guild channels resolve to everyone whose
   *  computed permissions include VIEW_CHANNEL — which is only true over a
   *  FULL member cache, so the guarded warm-up must succeed or this throws
   *  rather than return a silently narrowed list. Threads resolve to their
   *  JOINED members (Discord's own thread-membership notion; a public thread
   *  may be readable by non-joined users with parent access — the result
   *  carries that caveat in `note`). DMs resolve to the two parties.
   *
   *  Configured channel filters bound what a residence may INSPECT, not just
   *  what gets delivered: a channel outside them throws, matching
   *  listChannels' enforcement. Threads count as their parent channel, same
   *  as event routing.
   *
   *  `cap: false` returns every member (for author resolution); the listing
   *  tool keeps the MEMBER_LIST_CAP cut. `warmups` lets one operation that
   *  lists twice in a guild (a thread, then its parent) warm the member cache
   *  once: each guild's first outcome is recorded there and reused, so a
   *  success isn't downloaded again and a failure isn't waited out again. */
  async listChannelMembers(
    channelId: string,
    opts: { cap?: boolean; withPermission?: bigint; warmups?: Map<string, boolean> } = {},
  ): Promise<DiscordChannelMembers> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'no members were listed');
    const warm = async (guild: Guild): Promise<boolean> => {
      let warmed = opts.warmups?.get(guild.id);
      if (warmed === undefined) {
        warmed = await this.warmGuildMemberCache(guild);
        opts.warmups?.set(guild.id, warmed);
      }
      return warmed;
    };

    const toInfo = (m: GuildMember): DiscordMemberInfo => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName,
      isBot: m.user.bot,
    });
    const finish = (
      channelName: string | null,
      scope: DiscordChannelMembers['scope'],
      members: DiscordMemberInfo[],
      note?: string,
    ): DiscordChannelMembers => {
      // Humans first, then bots; alphabetical within each — the agent usually
      // wants "who's here", not a wall of infrastructure accounts up top.
      members.sort(
        (a, b) =>
          Number(a.isBot) - Number(b.isBot) ||
          a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }),
      );
      return {
        channelId,
        channelName,
        scope,
        total: members.length,
        members: opts.cap === false ? members : members.slice(0, MEMBER_LIST_CAP),
        truncated: opts.cap !== false && members.length > MEMBER_LIST_CAP,
        ...(note ? { note } : {}),
      };
    };
    const filterDenied = () =>
      new Error(
        `Channel ${channelId} is outside this residence's configured channel filters — ` +
        'filters bound inspection as well as delivery.',
      );

    if (channel.type === ChannelType.DM) {
      const dm = channel as DMChannel;
      const recipient = dm.recipient ?? (dm.recipientId ? await this.client.users.fetch(dm.recipientId) : null);
      const me = this.client.user;
      const members: DiscordMemberInfo[] = [];
      for (const u of [recipient, me]) {
        if (!u) continue;
        members.push({ id: u.id, username: u.username, displayName: u.displayName ?? u.username, isBot: u.bot });
      }
      return finish(null, 'dm', members);
    }

    if (channel.isThread()) {
      const guild = channel.guild;
      if (!this.channelAllowed(guild?.id ?? channel.guildId, channelId, channel.parentId)) {
        throw filterDenied();
      }
      // Discord documents List Thread Members as paged only with with_member,
      // which this call doesn't pass, so it should return every joined
      // member. Its limit has a default of 100 all the same, and nothing here
      // shows which holds, so a listing of exactly one page may be cut short.
      const threadMembers = await channel.members.fetch();
      const pageFull = threadMembers.size === THREAD_MEMBER_PAGE;
      // Bulk resolution: one guarded cache warm, then cache reads — never a
      // serial per-member REST fetch. Warm failure only degrades DISPLAY here
      // (the membership list itself comes from the thread, not the guild
      // cache), so unknown members fall back to id-only rather than aborting.
      await warm(guild);
      let unresolved = 0;
      const members = [...threadMembers.values()].map((tm) => {
        const gm = guild.members.cache.get(tm.id);
        if (!gm) unresolved++;
        return gm ? toInfo(gm) : { id: tm.id, username: tm.id, displayName: tm.id, isBot: false };
      });
      const listed = finish(
        this.knownName(channelId, channel.name),
        'thread-joined',
        members,
        'Joined members only. Users with access to the parent channel may be able to read a public thread without joining it.' +
          (pageFull ? ` Discord returned exactly one page (${THREAD_MEMBER_PAGE}) of joined members, so there may be more.` : ''),
      );
      return {
        ...listed,
        ...(unresolved > 0 ? { unresolved } : {}),
        ...(pageFull ? { possiblyIncomplete: true as const } : {}),
      };
    }

    if ('members' in channel && 'guild' in channel) {
      const guildChannel = channel as GuildBasedChannel & { members: Map<string, GuildMember> };
      const parentId = (guildChannel as { parentId?: string | null }).parentId;
      if (!this.channelAllowed(guildChannel.guild.id, channelId, parentId)) {
        throw filterDenied();
      }
      // The members getter computes VIEW_CHANNEL against the member cache;
      // warm it first (timeout-guarded) so the answer covers everyone, not
      // just recent speakers. A failed warm-up must throw: a list computed
      // over a partial cache would be silently incomplete.
      const warmed = await warm(guildChannel.guild);
      if (!warmed) {
        throw new Error(
          'Guild member cache warm-up failed or timed out — a member list computed now ' +
          'would be silently incomplete. Check the GuildMembers privileged intent ' +
          '(Developer Portal → Bot → Privileged Gateway Intents).',
        );
      }
      // withPermission narrows a guild channel's viewers to those holding a
      // permission there (computed per member: overwrites, roles, admin).
      const members = [...guildChannel.members.values()]
        .filter((m) => opts.withPermission === undefined
          || (guildChannel as GuildBasedChannel & { permissionsFor(m: GuildMember): Readonly<PermissionsBitField> | null })
            .permissionsFor(m)?.has(opts.withPermission) === true)
        .map(toInfo);
      return finish(this.knownName(channelId, guildChannel.name), 'guild-channel', members);
    }

    throw new Error(`Channel ${channelId} has no queryable membership (type ${channel.type})`);
  }

  /**
   * Resolve a reply/reaction target by its author: the newest message from
   * that author among the LATEST_FROM_WINDOW most recent messages in the
   * channel, fetched now. Only a message someone wrote counts: a system
   * notice (a pin, a join, a thread start) is never their latest message. A
   * numeric id (or <@id>, or @id) names the author directly. A name resolves
   * within the channel's identity context (everyone who can read it, bots
   * included: a guild channel's viewers, a public thread's joined members
   * plus its parent's viewers, a private thread's members plus the parent's
   * viewers who can manage threads, a DM's two parties; plus the authors in
   * that window), by username or display name, and must match one person: a
   * collision is refused with choices, never guessed. When that context
   * can't be read whole (the member list fails, lists members it couldn't
   * name, or may be cut short), a name can't be checked for collisions and
   * is refused; a numeric id still works. No match in the window is refused;
   * nothing older or by anyone else is ever chosen. A channel outside the
   * configured filters (guildIds, guildChannels with a thread by its parent,
   * and for a DM the other party against dmUsers) is refused before its
   * history or members are read, and again after them, since those filters
   * bound inspection as well as delivery, as in listChannels and
   * listChannelMembers.
   */
  async resolveLatestFrom(channelId: string, ref: string): Promise<LatestFromResult> {
    const raw = ref.trim();
    // '@' (or '@' and spaces) names no one: refused before anything is read.
    const bare = raw.replace(/^@/, '').trim();
    if (!bare) return { ok: false, message: 'latestFrom names no one; nothing was done.' };
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was done');
    const refused = await this.latestFromFilterRefusal(channel, channelId);
    if (refused) return { ok: false, message: refused };
    const guildId = 'guildId' in channel && channel.guildId ? channel.guildId : null;
    // A channel without messages is refused there, saying, as this call's
    // other refusals do, that nothing was done.
    const window = await this.fetchHistory(channelId, { limit: LATEST_FROM_WINDOW, nothing: 'nothing was done' });
    if (window.length === 0) {
      return { ok: false, message: 'This channel has no messages, so latestFrom has nothing to choose from; nothing was done.' };
    }
    const newestFirst = [...window].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0));
    const span = `the ${newestFirst.length} most recent messages here (${newestFirst[newestFirst.length - 1].timestamp.toISOString()} to ${newestFirst[0].timestamp.toISOString()})`;
    const displayOf = (m: HistoryMessage): string => m.authorDisplayName ?? m.authorName;
    const mention = /^<@!?(\d{17,20})>$/.exec(raw);
    let authorId: string;
    let authorLabel: string;
    if (mention || isSnowflake(bare)) {
      authorId = mention ? mention[1] : bare;
      const seen = newestFirst.find((m) => m.authorId === authorId);
      authorLabel = seen ? displayOf(seen) : authorId;
    } else {
      const name = bare.toLowerCase();
      const matches = new Map<string, { label: string; username?: string; isBot: boolean }>();
      let identities: DiscordMemberInfo[];
      let unresolved = 0;
      let incomplete = false;
      // Both listings below share one guild member-cache warm-up. A guild
      // whose warm-up failed lately is taken as failed again, at once.
      const warmups = new Map<string, boolean>();
      const failedAt = guildId ? this.latestFromWarmupFailures.get(guildId) : undefined;
      const rememberedFailure = failedAt !== undefined && Date.now() - failedAt < LATEST_FROM_WARMUP_RETRY_MS;
      if (guildId && rememberedFailure) warmups.set(guildId, false);
      try {
        const lists = [await this.listChannelMembers(channelId, { cap: false, warmups })];
        if (lists[0].scope === 'thread-joined') {
          // A thread is readable beyond its joined members, so a name must be
          // unique among those readers as well: for a public thread, everyone
          // who can view its parent; for a private one, the parent's viewers
          // who can manage threads there (administrators included).
          if (!channel.isThread()) throw new Error(`channel ${channelId} was listed as a thread but isn't one`);
          if (!channel.parentId) throw new Error(`thread ${channelId} has no parent channel`);
          lists.push(await this.listChannelMembers(channel.parentId, {
            cap: false,
            warmups,
            ...(channel.type === ChannelType.PrivateThread
              ? { withPermission: PermissionsBitField.Flags.ManageThreads }
              : {}),
          }));
        }
        identities = lists.flatMap((l) => l.members);
        // A member a list couldn't name appears id-only (username and display
        // name both the id); count those too, whether or not the list says so.
        for (const l of lists) {
          unresolved += Math.max(
            l.unresolved ?? 0,
            l.members.filter((m) => m.username === m.id && m.displayName === m.id).length,
          );
          if (l.possiblyIncomplete) incomplete = true;
        }
      } catch (err) {
        return {
          ok: false,
          message: `"${raw}" can't be checked for people sharing that name: this channel's member list is unavailable (${(err as Error).message}). Use their numeric user id; nothing was done.`,
        };
      } finally {
        // Remember a warm-up that ran and failed; forget one that succeeded.
        const outcome = guildId ? warmups.get(guildId) : undefined;
        if (guildId && outcome === true) this.latestFromWarmupFailures.delete(guildId);
        else if (guildId && outcome === false && !rememberedFailure) this.latestFromWarmupFailures.set(guildId, Date.now());
      }
      if (unresolved > 0) {
        return {
          ok: false,
          message: `"${raw}" can't be checked for people sharing that name: ${unresolved} member(s) here couldn't be resolved to names. Use their numeric user id; nothing was done.`,
        };
      }
      if (incomplete) {
        return {
          ok: false,
          message: `"${raw}" can't be checked for people sharing that name: Discord returned exactly one page (${THREAD_MEMBER_PAGE}) of this thread's members, so there may be more. Use their numeric user id; nothing was done.`,
        };
      }
      for (const m of identities) {
        if (m.username.toLowerCase() === name || m.displayName.toLowerCase() === name) {
          matches.set(m.id, { label: m.displayName, username: m.username, isBot: m.isBot });
        }
      }
      // The window's authors, by username or display name, as members are
      // matched: someone no longer in the channel can still have written here.
      for (const m of newestFirst) {
        if (matches.has(m.authorId)) continue;
        if (m.authorName.toLowerCase() === name || displayOf(m).toLowerCase() === name) {
          matches.set(m.authorId, { label: displayOf(m), username: m.authorName, isBot: m.isBot });
        }
      }
      if (matches.size === 0) {
        return { ok: false, message: `No one named "${raw}" is in this channel or among ${span}. Use their numeric user id; nothing was done.` };
      }
      if (matches.size > 1) {
        const choices = [...matches].slice(0, 10)
          .map(([id, m]) => `${m.label}${m.username ? ` (@${m.username})` : ''}${m.isBot ? ' [bot]' : ''} = ${id}`)
          .join('; ');
        return { ok: false, message: `"${raw}" matches ${matches.size} people here: ${choices}. Use the numeric user id; nothing was done.` };
      }
      const [[id, only]] = [...matches];
      authorId = id;
      authorLabel = only.label;
    }
    // A system notice is nobody's message: never their latest.
    const target = newestFirst.find((m) => m.authorId === authorId && !m.system);
    if (!target) {
      return {
        ok: false,
        message: `No message from ${authorLabel} among ${span}; nothing was done. latestFrom never reaches further back or picks another author.`,
      };
    }
    // The filters may have changed during the reads (a slow member download):
    // the action is refused if they no longer admit this channel.
    const refusedNow = await this.latestFromFilterRefusal(channel, channelId);
    if (refusedNow) return { ok: false, message: refusedNow };
    return { ok: true, message: target, authorId, authorLabel };
  }

  /**
   * Why latestFrom may not read this channel, or null: every configured
   * filter that bounds inspection. guildIds and guildChannels (a thread by its
   * parent) for a guild channel; for a DM, the other party against dmUsers.
   * The cache can't always name a DM's other party (dmOtherParty), so then
   * Discord is asked once, past the cache; the fetch patches the cached
   * channel, so a later check finds the party there. A party still unknown
   * is refused (fail closed).
   */
  private async latestFromFilterRefusal(channel: Channel, channelId: string): Promise<string | null> {
    const guildId = 'guildId' in channel && channel.guildId ? channel.guildId : null;
    if (guildId && this.guildIds?.length && !this.guildIds.includes(guildId)) {
      return `Channel ${channelId} is in a server outside this residence's configured guild filter, which bounds reading as well as delivery, so latestFrom can't choose a message there; nothing was done.`;
    }
    if (!this.channelAllowed(guildId, channelId, 'parentId' in channel ? channel.parentId : null)) {
      return `Channel ${channelId} is outside this residence's configured channel filters, which bound reading as well as delivery, so latestFrom can't choose a message there; nothing was done.`;
    }
    if (channel.type === ChannelType.DM && this.dmUsers) {
      let other = this.dmOtherParty(channel);
      if (!other) {
        const unconfirmed = (why: string) =>
          `This DM's other party couldn't be confirmed (${why}), so latestFrom can't check it against this residence's configured DM users and can't choose a message there; nothing was done.`;
        try {
          other = this.dmOtherParty(await this.client.channels.fetch(channelId, { force: true }));
        } catch (err) {
          return unconfirmed(`looking up its DM channel failed: ${(err as Error).message}`);
        }
        if (!other) return unconfirmed('Discord names no recipient for its DM channel');
      }
      if (!this.dmUsers.has(other)) {
        return `This DM is with someone outside this residence's configured DM users, which bound reading as well as delivery, so latestFrom can't choose a message there; nothing was done.`;
      }
    }
    return null;
  }

  /** List the custom (server) emojis the bot can see — the shared palette for
   *  both message content and reactions. Omit `guildId` to span all guilds. */
  async listEmojis(guildId?: string): Promise<DiscordEmojiInfo[]> {
    const guilds: Guild[] = [];
    if (guildId) {
      // Discord's own error (Unknown Guild, Missing Access) propagates, as
      // listChannels' does, so the tool error can say what it means.
      // guilds.fetch(id) resolves to the Guild or rejects.
      guilds.push(await this.client.guilds.fetch(guildId));
    } else {
      guilds.push(...this.client.guilds.cache.values());
    }
    const out: DiscordEmojiInfo[] = [];
    for (const g of guilds) {
      let emojis = g.emojis.cache;
      if (emojis.size === 0) {
        emojis = await g.emojis.fetch().catch(() => emojis);
      }
      emojis.forEach((e) => {
        if (!e.name) return;
        out.push({
          id: e.id,
          name: e.name,
          animated: e.animated ?? false,
          token: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`,
          reactionArg: `:${e.name}:`,
          guildId: g.id,
          guildName: g.name,
        });
      });
    }
    return out;
  }

  async createTextChannel(
    guildId: string,
    name: string,
    categoryId?: string,
  ): Promise<DiscordChannelInfo> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) throw new Error(`Guild ${guildId} not found`);
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    // The name Discord made the channel with, the POST's reply's.
    const madeAs = created.name;
    // discord.js puts the POST's reply in the cache whenever it lands, over
    // anything the gateway reported of the new channel meanwhile, such as a
    // rename, and its id isn't known to be overtaken until then. So the
    // channel is fetched again through the freshness rule, and that fill is
    // what the cache keeps.
    const channel = ((await this.refetchChannel(created.id).catch((err: unknown) => {
      // Discord says the new channel is gone already: deleted since, which
      // refetchChannel reported (channelGone).
      if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
        throw new Error(
          `Channel ${created.id} was created, but Discord says it no longer exists: it was deleted since, so there's ` +
            'no channel to use. create_text_channel can make it again.',
        );
      }
      // The channel was made, but its facts aren't verified: it's marked
      // stale, labelled by its id, until a fresh fetch.
      dbg('create-channel:refetch-failed', { channelId: created.id, error: (err as Error).message });
      this.markStale(created.id, guildId);
      return null;
    })) ?? created) as typeof created;
    // Labelled as listing labels it: by its id when its name is taken, or
    // while its facts are stale.
    const facts = this.channelFacts(channel);
    // Its name as Discord has it now, or, while that isn't known (the fetch
    // failed, or was overtaken on every try), the name it was made with.
    return {
      id: channel.id,
      name: this.knownName(channel.id, channel.name) ?? madeAs,
      type: 'text',
      parentId: channel.parentId ?? undefined,
      label: facts ? channelLabelFor(facts) : mcplChannelId(guildId, channel.id),
    };
  }

  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.channelById(channelId);
    if (!channel) throw channelUnusable(channelId, 'nothing was deleted');
    if ('delete' in channel) {
      await (channel as TextChannel).delete();
    } else {
      throw new Error(`Channel ${channelId} cannot be deleted`);
    }
  }

  /** The channels registered by listing them (boot, refresh_channels): every
   *  channel of a listed kind (isListedKind) in the guilds the guild filter
   *  admits, that the channel filter admits. */
  getPostingChannels(): ChannelFacts[] {
    const names = this.nameView();
    const result: ChannelFacts[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) continue;
      result.push(...this.guildPostingChannels(guild, names));
    }
    return result;
  }

  /** One guild's channels of a listed kind that the channel filter admits,
   *  from the channel cache (the gateway fills it): getPostingChannels for a
   *  guild the bot joins after startup. Their names are read against one
   *  view (nameView), or `names` when a larger listing shares its own. */
  private guildPostingChannels(guild: Guild, names: NameView = this.nameView()): ChannelFacts[] {
    const result: ChannelFacts[] = [];
    for (const channel of guild.channels.cache.values()) {
      if (!isListedKind(mapChannelType(channel.type))) continue;
      // A stale channel's facts decide nothing until a fresh fetch, which
      // registers it again (onChannelRefreshed); what's registered of it
      // stands meanwhile.
      if (this.isStale(channel.id)) continue;
      if (!this.channelAllowed(guild.id, channel.id, channel.parentId)) continue;
      const facts = this.channelFacts(channel, names);
      if (facts) result.push(facts);
    }
    return result;
  }

  // ── Private ──

  /** Resolve sparse gateway events before applying guild/channel/DM policy.
   *  A missing guild id is not evidence of a DM: uncached guild messages can
   *  lack it too. Fetch the channel (never the deleted message) only when the
   *  message and cache cannot establish its location or a parent needed by
   *  the channel allowlist. With `dmParty`, also resolve a DM's other party
   *  (dmRecipientId), fetching the channel if need be. Only a delete asks: an
   *  edit is judged by its author. */
  private async messageEventInfo(
    message: Message | PartialMessage,
    opts: { dmParty?: boolean } = {},
  ): Promise<MessageEventInfo | null> {
    // A create still waiting for its thread's lookup goes first, so an edit
    // or delete never overtakes the message it changes, and is placed from
    // what that lookup found (the promise never rejects).
    const created = this.threadLookups.get(message.channelId);
    if (created) await created;
    const authorId = message.author?.id;
    const authorName = message.author?.username;
    let channel: Channel | null | undefined = message.channel ?? this.client.channels.cache.get(message.channelId);
    let guildId = message.guildId ?? (channel && 'guildId' in channel ? channel.guildId : null);
    // A thread the client knows only partly, or a channel whose cached facts
    // may be older than Discord's (isStale), is looked up whatever the
    // channel filters say, as its creates are, so the edit or delete is
    // placed and named as its create is. If the lookup fails, the channel
    // stays as it was, and the filters decide on what's known, as they do
    // for its creates. A guild the filters leave out needs no lookup.
    // The channel is read from the cache again after the lookup: while it
    // was pending, the cached entry can have been replaced (the guild
    // removed and joined again builds a new thread object), and then only
    // the cache holds what the lookup found.
    if (guildId && !this.guildAdmitted(guildId)) return null;
    if (guildId && (threadChannelUnknown(channel) || this.isStale(message.channelId))) {
      await this.lookUpChannel(guildId, message.channelId);
      channel = this.client.channels.cache.get(message.channelId) ?? channel;
    }
    // A stale thread's channel is looked up too: its category can admit it.
    const staleParent = guildId ? this.staleParentOf(channel) : null;
    if (guildId && staleParent) await this.lookUpChannel(guildId, staleParent);
    // Packet guild identity alone does not establish whether an uncached
    // channel is a thread under an allowlisted parent. Fetch only when that
    // missing parent could affect the decision; a directly allowed channel
    // or a channel with known parent metadata needs no lookup, and a partly
    // known thread (whose parentId key is there, null) has had its lookup
    // above. The fetch is forced, since discord.js would otherwise hand back
    // a cached partial.
    const needsParent = guildId
      && !(channel && 'parentId' in channel)
      && !this.channelAllowed(guildId, message.channelId);
    if ((!guildId && !channel?.isDMBased()) || needsParent) {
      channel = await this.refetchChannel(message.channelId);
      guildId ??= channel && 'guildId' in channel ? channel.guildId : null;
    }
    if (!guildId && !channel?.isDMBased()) {
      dbg('messageEvent:drop', { msgId: message.id, channelId: message.channelId, reason: 'unknown-channel' });
      return null;
    }
    if (guildId && this.guildIds?.length && !this.guildIds.includes(guildId)) return null;
    const parentId = channel && 'parentId' in channel ? channel.parentId : null;
    if (!this.channelAllowed(guildId, message.channelId, parentId)) return null;
    // A DM's other party, for the allowlist (dmUserRefused): the author,
    // unless the message is the bot's own, else the channel's recipient that
    // isn't the bot (dmOtherParty). The cache can't always say: a deletion
    // of an uncached message names no author, a channel known only by its id
    // carries no recipient, and discord.js counts a cached DM channel as
    // complete once it has seen a message there, whatever recipients it has
    // recorded, which may be only the bot. So then this lookup asks Discord
    // (force: true, past the cache), once, and only when a list needs it.
    // (The location lookup above is separate.) When this lookup fails, or
    // names no one, the party stays unknown and the delete is withheld
    // (fail closed, as a create from an unknown user is), with the reason
    // for the operator log.
    let dmRecipientId: string | undefined;
    let dmPartyUnknown: string | undefined;
    if (opts.dmParty && !guildId && channel?.isDMBased()) {
      dmRecipientId = authorId && authorId !== this.client.user?.id ? authorId : this.dmOtherParty(channel);
      if (!dmRecipientId && this.dmUsers) {
        try {
          const fetched = await this.client.channels.fetch(message.channelId, { force: true });
          dmRecipientId = this.dmOtherParty(fetched);
          if (!dmRecipientId) dmPartyUnknown = 'Discord names no recipient for its DM channel';
        } catch (err) {
          dmPartyUnknown = `looking up its DM channel failed (${(err as Error).message})`;
        }
      }
    }
    return {
      guildId: guildId ?? null,
      ...this.threadPlace(channel, message.channelId),
      authorId,
      authorName,
      ...(dmRecipientId ? { dmRecipientId } : {}),
      ...(dmPartyUnknown ? { dmPartyUnknown } : {}),
    };
  }

  /** A DM channel's recipient other than the bot, read from discord.js's
   *  `recipientIds`. Its `recipientId` getter won't do here: it throws when
   *  no recipient was ever recorded, and returns the bot's own id when the
   *  bot is the only one recorded. */
  private dmOtherParty(channel: unknown): string | undefined {
    const ids = (channel as { recipientIds?: Array<string | undefined> } | null)?.recipientIds;
    return ids?.find((id) => !!id && id !== this.client.user?.id);
  }

  /** Resolve locations concurrently, but let earlier mutations finish before
   *  delivering later ones for the same message. A slow edit lookup must not
   *  arrive after its deletion. Failure releases the next delivery as well. */
  private forwardMessageEvent(
    message: Message | PartialMessage,
    forward: (info: MessageEventInfo) => void,
    opts: { dmParty?: boolean } = {},
  ): Promise<void> {
    const messageId = message.id;
    const previous = this.messageEventDeliveries.get(messageId) ?? Promise.resolve();
    const pending = Promise.allSettled([previous, this.messageEventInfo(message, opts)]).then(([, result]) => {
      if (result.status === 'rejected') throw result.reason;
      if (result.value) forward(result.value);
    });
    const settled = pending.catch(() => {});
    this.messageEventDeliveries.set(messageId, settled);
    void settled.then(() => {
      if (this.messageEventDeliveries.get(messageId) === settled) this.messageEventDeliveries.delete(messageId);
    });
    return pending;
  }

  private async handleMessageUpdate(oldMsg: Message | PartialMessage, newMsg: Message | PartialMessage): Promise<void> {
    // Reject non-edits before potentially fetching a sparse event's channel.
    const decision = editForwardDecision(oldMsg, newMsg, { selfId: this.client.user?.id });
    if (decision !== 'forward') {
      if (decision !== 'no-content' && decision !== 'self') {
        dbg('messageUpdate:drop', { msgId: newMsg.id, channelId: newMsg.channelId, reason: decision });
      }
      return;
    }
    if (this.editAccept && !this.editAccept(newMsg.channelId)) {
      dbg('messageUpdate:drop', { msgId: newMsg.id, channelId: newMsg.channelId, reason: 'ingress-filtered' });
      return;
    }
    const content = newMsg.content!;
    const { channelId, id: messageId } = newMsg;
    // RFC-006 occurrence identity and the create-equivalent rendering of a
    // replacing edit need the edit time and the mention-resolved body.
    const editedAt = newMsg.editedTimestamp ? new Date(newMsg.editedTimestamp).toISOString() : undefined;
    const cleanContent = newMsg.cleanContent ?? undefined;
    await this.forwardMessageEvent(newMsg, (info) => {
      if (!info.guildId && this.dmUserRefused(info.authorId)) {
        dbg('messageUpdate:drop', { msgId: messageId, channelId, reason: info.authorId ? 'dm-not-allowed' : 'dm-party-unknown' });
        return;
      }
      this.editHandler?.(channelId, messageId, content, !info.guildId, { ...info, editedAt, cleanContent });
    });
  }

  private async handleMessageDelete(message: Message | PartialMessage): Promise<void> {
    if (this.deleteAccept && !this.deleteAccept(message.channelId)) {
      dbg('messageDelete:drop', { msgId: message.id, channelId: message.channelId, reason: 'ingress-filtered' });
      return;
    }
    const { channelId, id: messageId } = message;
    await this.forwardMessageEvent(message, (info) => {
      if (!info.guildId && this.dmUserRefused(info.dmRecipientId)) {
        if (info.dmRecipientId) {
          dbg('messageDelete:drop', { msgId: messageId, channelId, reason: 'dm-not-allowed' });
          return;
        }
        // A party that couldn't be confirmed is refused too. That can withhold
        // an allowed user's deletion, so the operator log says so.
        dbg('messageDelete:drop', { msgId: messageId, channelId, reason: 'dm-party-unknown' });
        console.error(
          `[discord-mcpl] Withheld the deletion of message ${messageId} in DM channel ${channelId}: ` +
            `${info.dmPartyUnknown ?? 'its other party is unknown'}, and the DM allowlist refuses what it can't attribute.`,
        );
        return;
      }
      this.deleteHandler?.(channelId, messageId, !info.guildId, info);
    }, { dmParty: true });
  }

  /** Keep the payload of the thread sync discord.js is applying, for the
   *  threadListSync listener: the event carries the threads a sync lists,
   *  but not the channels it covers (`channel_ids`). discord.js's
   *  ThreadListSync action applies a sync and emits the event before it
   *  returns, so the action is wrapped, once, as the client is made. The raw
   *  packet can't stand in for it: a packet queued before the client is ready
   *  is applied after newer ones, and two syncs can list the same threads,
   *  none at all included. A nested application restores the outer one's
   *  payload as it ends, a throw included. A discord.js without the action
   *  fails construction, naming what's missing; the lockfile pins one that
   *  has it. */
  private installThreadSyncScope(): void {
    const action = (this.client as unknown as {
      actions?: { ThreadListSync?: { handle(data: GatewayThreadListSyncDispatchData): unknown } };
    }).actions?.ThreadListSync;
    if (!action || typeof action.handle !== 'function') {
      throw new Error('discord.js actions.ThreadListSync.handle is missing; thread sync reconciliation requires its payload');
    }
    const handle = action.handle;
    action.handle = (data) => {
      const previous = this.applyingThreadSync;
      // discord.js drops threads as it applies the sync, so what the client
      // held, and under which channels, is read first.
      const held = new Map<string, string | null>();
      for (const channel of this.client.channels.cache.values()) {
        if (!channel.isThread() || channel.guildId !== data.guild_id || channel.archived) continue;
        held.set(channel.id, channel.parentId);
      }
      this.applyingThreadSync = { data, held };
      try {
        return handle.call(action, data);
      } finally {
        this.applyingThreadSync = previous;
      }
    };
  }

  private setupEvents(): void {
    this.watchReports();
    this.client.on('messageCreate', (message: Message) => {
      const base = {
        msgId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        messageType: message.type,
        attachmentCount: message.attachments.size,
        mentionCount: message.mentions.users.size,
      };
      dbg('gateway:message-create', base);

      // A thread the client knows only partly, or a channel whose cached
      // facts may be older than Discord's (isStale), is fetched before the
      // filters decide, and this channel's later creates wait behind that
      // fetch, so they're delivered in order.
      const waiting = this.threadLookups.get(message.channelId);
      const admittedGuild = message.guildId !== null && this.guildAdmitted(message.guildId);
      const lookUp = admittedGuild && (threadChannelUnknown(message.channel) || this.isStale(message.channelId));
      const parentLookUp = admittedGuild ? this.staleParentOf(message.channel) : null;
      if (waiting || lookUp || parentLookUp) {
        const next = (waiting ?? (lookUp ? this.lookUpChannel(message.guildId!, message.channelId) : Promise.resolve()))
          .then(async () => {
            // After its own lookup, the thread's channel may show as stale.
            const parentId = this.staleParentOf(this.client.channels.cache.get(message.channelId));
            if (parentId && admittedGuild) await this.lookUpChannel(message.guildId!, parentId);
          })
          .then(() => this.acceptMessage(message, base))
          .catch((err) => console.error('[discord-mcpl] Failed to deliver a thread message:', (err as Error).message));
        this.threadLookups.set(message.channelId, next);
        void next.finally(() => {
          if (this.threadLookups.get(message.channelId) === next) this.threadLookups.delete(message.channelId);
        });
        return;
      }
      this.acceptMessage(message, base);
    });

    this.client.on('messageUpdate', (oldMsg, newMsg) => {
      void this.handleMessageUpdate(oldMsg, newMsg).catch((err) => {
        console.error(
          `[discord-mcpl] Failed to forward the edit of message ${newMsg.id} in channel ${newMsg.channelId}:`,
          (err as Error).message,
        );
      });
    });

    const forwardDelete = (message: Message | PartialMessage): void => {
      void this.handleMessageDelete(message).catch((err) => {
        console.error(
          `[discord-mcpl] Failed to forward the deletion of message ${message.id} in channel ${message.channelId}:`,
          (err as Error).message,
        );
      });
    };
    this.client.on('messageDelete', forwardDelete);
    // Discord emits a separate event for moderator bulk purges. Each member
    // needs the same tombstone, location/filter checks, and per-message
    // ordering as an individual deletion; one failed lookup leaves the
    // remaining members free to proceed.
    this.client.on('messageDeleteBulk', (messages) => {
      for (const message of messages.values()) forwardDelete(message);
    });

    this.client.on('messageReactionAdd', (reaction, user) => {
      void this.handleReactionEvent('add', reaction, user);
    });

    this.client.on('messageReactionRemove', (reaction, user) => {
      void this.handleReactionEvent('remove', reaction, user);
    });

    this.client.on('channelCreate', (channel) => {
      // Only a listed kind (isListedKind): a category or forum holds no
      // messages itself. Threads never reach channelCreate: they're
      // registered by their messages. The guild filter applies too, as at
      // boot: a channel in a guild it excludes would be listed to the host
      // while every message from it is dropped. (The server labels it, by the
      // one rule every registration uses: toDescriptor.)
      if (!isListedKind(mapChannelType(channel.type))) return;
      const facts = this.channelFacts(channel);
      if (!facts) return;
      if (this.guildIds?.length && !this.guildIds.includes(facts.guildId)) return;
      if (!this.channelAllowed(facts.guildId, facts.id, facts.parentId)) return;
      this.channelCreateHandler?.(facts);
    });

    // A deleted channel's threads go with it. discord.js drops them from its
    // caches without a threadDelete for each, but the deleted channel still
    // lists the ones it held.
    this.client.on('channelDelete', (channel) => {
      if ('guildId' in channel && channel.guildId) {
        const threadIds = 'threads' in channel ? [...channel.threads.cache.keys()] : [];
        for (const id of [channel.id, ...threadIds]) this.stale.delete(id);
        this.channelDeleteHandler?.(channel.guildId, channel.id, threadIds);
      }
    });

    this.client.on('threadUpdate', (_oldThread, newThread) => {
      // Discord reported the thread as it is now, and discord.js patched the
      // cache with it: what the cache holds is current. A fetch of it that's
      // out now was overtaken as the report arrived (watchReports).
      this.stale.delete(newThread.id);
      const facts = this.channelFacts(newThread);
      if (facts) this.threadUpdateHandler?.(facts);
    });

    this.client.on('threadDelete', (thread) => {
      this.stale.delete(thread.id);
      if (thread.guildId) this.threadDeleteHandler?.(thread.guildId, thread.id);
    });

    // Discord synced a guild's threads (onThreadsSynced): the threads it
    // lists are as Discord has them now, as a threadUpdate's thread is.
    this.client.on('threadListSync', (threads, guild) => {
      const applying = this.applyingThreadSync;
      const scope = applying?.data.guild_id === guild.id ? applying : undefined;
      // Only discord.js's ThreadListSync action gives the sync's payload
      // (installThreadSyncScope). A discord.js that emitted the event
      // elsewhere would leave the channels it covers unknown, so it covers
      // none here: the threads it lists are taken as reported, and nothing
      // it omits is forgotten. That's logged rather than thrown: a throw
      // would end the process from inside the gateway's packet handling.
      if (!scope) {
        console.error(`[discord-mcpl] A sync of server ${guild.id}'s threads came outside discord.js's ThreadListSync action, so the channels it covers aren't known; nothing it omits is forgotten.`);
      }
      const covered = scope ? (scope.data.channel_ids ? new Set(scope.data.channel_ids) : null) : new Set<string>();
      const listed = new Set(threads.keys());
      // The sync drops each live thread the client held under a covered
      // channel that it doesn't list. discord.js dropped those its channels'
      // threads caches held; one held outside its channel's, such as a
      // partial a threadUpdate patched since, is the adapter's to drop.
      // forgetCached also clears each one's stale mark, cached or not.
      const dropped = new Set<string>();
      for (const [id, parentId] of scope?.held ?? []) {
        if (listed.has(id) || !(covered === null || (parentId !== null && covered.has(parentId)))) continue;
        dropped.add(id);
        this.forgetCached(id);
      }
      for (const id of listed) this.stale.delete(id);
      this.threadsSyncedHandler?.(guild.id, covered, listed, dropped);
    });

    this.client.on('guildUpdate', (oldGuild, newGuild) => {
      if (oldGuild.name === newGuild.name) return;
      if (this.guildIds?.length && !this.guildIds.includes(newGuild.id)) return;
      this.guildRenameHandler?.(newGuild.id);
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
    // guild's existing channels of a listed kind so the host can register
    // them. Without this, channels in a server the bot is added to *after*
    // startup never appear in the host's channel list (channelCreate only
    // fires for channels created later, not the ones that already existed on
    // join).
    this.client.on('guildCreate', (guild) => {
      // A guild left and joined again can leave its old channels in the
      // client-wide cache, as a return does.
      this.markUnlisted(guild);
      void this.warmGuildMemberCache(guild);
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      // Register slash commands in guilds joined after startup.
      if (this.guildCommandDefs) {
        guild.commands.set(this.guildCommandDefs).catch((err: Error) => {
          console.error(`[discord-mcpl] Failed to register commands in new guild ${guild.id}:`, err.message);
        });
      }
      this.guildCreateHandler?.(guild.id, this.guildPostingChannels(guild));
    });

    // The bot left a guild or was removed from it (onGuildDelete). Reported
    // whatever the guild filter says: forgetting what was never registered
    // costs nothing.
    this.client.on('guildDelete', (guild) => {
      for (const [id, mark] of this.stale) if (mark.guildId === guild.id) this.stale.delete(id);
      this.guildDeleteHandler?.(guild.id);
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

    // A listed channel changed: renamed, moved, or its permission overwrites
    // let the bot in (it was added to a private channel). The server
    // re-derives what it registered (a rename changes the label, and its
    // threads' labels) and registers a channel it hadn't; an update that
    // changes neither (a topic, slowmode) announces nothing. A forum or
    // media channel is reported too (holdsPosts): the server doesn't
    // register it, but its posts are threads whose labels name it. Whether
    // the bot can view the channel doesn't decide it: listing registers every
    // channel the filters admit (getPostingChannels), so a hidden channel's
    // rename re-derives its label too. A channel moved out of what the
    // filters admit is reported as no longer admitted, and forgotten.
    this.client.on('channelUpdate', (oldChannel, newChannel) => {
      // Discord reported the channel as it is now (see threadUpdate). One
      // that was stale gives its guild's names back (resolveAmong), as a new
      // name would, so it counts as a change of address.
      const wasStale = this.stale.delete(newChannel.id);
      if (!('guild' in newChannel)) return;
      if (!isListedKind(mapChannelType(newChannel.type)) && !holdsPosts(newChannel.type)) return;
      const guild = newChannel.guild;
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      const admitted = this.channelAllowed(guild.id, newChannel.id, newChannel.parentId);
      const facts = this.channelFacts(newChannel);
      const old = oldChannel as { name?: string | null; type?: number; parentId?: string | null };
      const addressChanged = wasStale || old.name !== newChannel.name || old.type !== newChannel.type || old.parentId !== newChannel.parentId;
      if (facts) this.channelUpdateHandler?.(facts, { addressChanged, admitted });
    });

    // A guild back from an outage or a gateway gap (onGuildAvailable).
    this.client.on('guildAvailable', (guild) => {
      this.markUnlisted(guild);
      if (this.guildIds?.length && !this.guildIds.includes(guild.id)) return;
      this.guildAvailableHandler?.(guild.id, this.guildPostingChannels(guild), new Set(guild.channels.cache.keys()));
    });

    this.client.on('error', (err: Error) => {
      dbg('gateway:client-error', { error: err.message });
      console.error('[discord-mcpl] Client error:', err.message);
    });

    this.client.on('warn', (message: string) => {
      dbg('gateway:warn', { message });
    });

    this.client.on('shardReady', (shardId, unavailableGuilds) => {
      dbg('gateway:shard-ready', {
        shardId,
        unavailableGuilds: unavailableGuilds?.size ?? 0,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardDisconnect', (event, shardId) => {
      dbg('gateway:shard-disconnect', {
        shardId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardReconnecting', (shardId) => {
      dbg('gateway:shard-reconnecting', {
        shardId,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardResume', (shardId, replayedEvents) => {
      dbg('gateway:shard-resume', {
        shardId,
        replayedEvents,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
    });

    this.client.on('shardError', (err, shardId) => {
      dbg('gateway:shard-error', {
        shardId,
        error: err.message,
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
      console.error(`[discord-mcpl] Gateway shard ${shardId} error:`, err.message);
    });

    this.client.on('invalidated', () => {
      dbg('gateway:invalidated', {
        status: this.client.ws.status,
        pingMs: this.client.ws.ping,
      });
      console.error('[discord-mcpl] Gateway session invalidated');
    });
  }

  /** Per-guild channel whitelist check. A guild with no entry in
   *  `guildChannels` is unrestricted. A listed id admits that channel or
   *  thread. A listed channel also admits its threads, and a listed category
   *  admits the channels under it and, through them, their threads (a
   *  forum's posts included). So a thread is allowed whenever its channel
   *  is, and also when it's listed itself.
   *
   *  `parentId` is the channel's own parent: a category for a channel, the
   *  channel for a thread. A thread's channel may itself be admitted only
   *  through its category, one level further up, so that level is read from
   *  the client's channel cache (guild channels are always cached under the
   *  GUILDS intent). An uncached parent stays excluded. */
  private channelAllowed(
    guildId: string | null | undefined,
    channelId: string,
    parentId?: string | null,
  ): boolean {
    if (!guildId || !this.guildChannels) return true;
    const allowed = this.guildChannels.get(guildId);
    if (!allowed) return true;
    if (parentId != null && !allowed.has(channelId) && !allowed.has(parentId)) {
      // A stale channel's category may no longer be its own, so it admits
      // none of its threads until a fresh fetch (staleParentOf); one listed
      // by its own id, or by its channel's, still passes.
      const parent = this.client.channels.cache.get(parentId) as { parentId?: string | null } | undefined;
      if (parent?.parentId != null && !this.isStale(parentId) && allowed.has(parent.parentId)) return true;
    }
    return allowed.has(channelId) || (parentId != null && allowed.has(parentId));
  }

  /** Apply the ingress filters to a created message, and deliver it if they pass. */
  private acceptMessage(message: Message, base: Record<string, unknown>): void {
    const dropReason = this.messageFilterReason(message);
    if (dropReason) {
      dbg('gateway:message-create-drop', { ...base, reason: dropReason });
      if (dropReason === 'dm-user-not-allowed') {
        // The body stays here; only the refusal's identity leaves.
        this.refuseDm({
          messageId: message.id,
          channelId: message.channelId,
          authorId: message.author.id,
          origin: 'live',
        });
      }
      return;
    }
    try {
      this.messageHandler?.(this.convertMessage(message));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      dbg('gateway:message-create-error', { ...base, error });
      console.error('[discord-mcpl] Failed to convert Discord message:', error);
    }
  }

  /** Fetch a channel an event comes from past the cache, so the cache holds
   *  what Discord has now: a thread known only partly (threadChannelUnknown),
   *  whose parent channel the cache lacks, or a channel whose cached facts
   *  may be older than Discord's (isStale). Forced, since discord.js would
   *  otherwise return the cached object. The REST client's own timeout and
   *  retries bound each attempt (15 s a try, three retries, by default),
   *  though a rate limit's Retry-After waits can hold events waiting behind
   *  it longer. A fetch Discord answers with Unknown Channel reports the
   *  channel deleted. If the fetch fails otherwise, the channel stays as it
   *  was, and the filters decide on what's known: where a guild's channel
   *  list applies, a thread whose parent channel is unknown is admitted only
   *  if it's listed itself, and a stale channel's events go unnamed unless
   *  it's registered. That failure is logged. */
  private async lookUpChannel(guildId: string, channelId: string): Promise<void> {
    try {
      await this.refetchChannel(channelId);
    } catch (err) {
      // Unknown Channel: the channel is gone, a thread perhaps deleted with
      // the channel it hung off while its event waited, and nothing else will
      // say so (a thread known only partly isn't in its channel's
      // threads.cache). It's reported as deleted, so what waits on it
      // registers and names nothing.
      if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
        dbg('gateway:channel-lookup-gone', { channelId });
        this.threadDeleteHandler?.(guildId, channelId);
        return;
      }
      const error = (err as Error).message;
      dbg('gateway:channel-lookup-failed', { channelId, error });
      console.error(
        `[discord-mcpl] Couldn't look up channel ${channelId} past the cache (${error}). ` +
          "Its events are decided on what the cache holds: where its guild has a channel list, a thread whose parent channel isn't known passes only if it's listed itself, and they go unnamed unless it's registered.",
      );
    }
  }

  /** Fetch a channel past the cache, as Discord has it now. This is the
   *  freshness rule every fill of the cache from Discord that can later
   *  supply registration facts follows. discord.js patches the cached
   *  channel with the reply, so a reply that's older than something Discord
   *  reported while the fetch was out (watchReports) can overwrite newer
   *  facts. Such a reply marks the channel stale (isStale) as it lands, and
   *  the channel is fetched again, up to FETCH_TRIES in all; a fetch nothing
   *  overtook clears the mark. So the mark stays whenever no fresh fetch
   *  follows an overtaken one, every try overtaken or a later try failing.
   *  A fresh try that clears a mark tells the server (onChannelRefreshed),
   *  so what it derived from the older facts is derived again. Unknown
   *  Channel means the channel is gone: its mark goes, and so does what
   *  discord.js still holds of it (forgetCached), so no later read finds it
   *  live. */
  private async refetchChannel(channelId: string, { force = true }: { force?: boolean } = {}): Promise<Channel | null> {
    for (let tries = 1; ; tries++) {
      const fetch = { overtaken: false };
      let out = this.fetchesOut.get(channelId);
      if (!out) this.fetchesOut.set(channelId, (out = new Set()));
      out.add(fetch);
      let channel: Channel | null;
      try {
        // A later try must ask Discord past what the earlier reply left cached.
        channel = await this.client.channels.fetch(channelId, { force: force || tries > 1 });
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) this.channelGone(channelId);
        throw err;
      } finally {
        out.delete(fetch);
        if (out.size === 0) this.fetchesOut.delete(channelId);
      }
      if (!fetch.overtaken) {
        if (this.stale.delete(channelId)) this.channelRefreshedHandler?.(channelId);
        return channel;
      }
      const guildId = channel && 'guildId' in channel ? channel.guildId : null;
      if (guildId) this.markStale(channelId, guildId);
      dbg('gateway:fetch-overtaken', { channelId, tries, last: tries === FETCH_TRIES });
      if (tries === FETCH_TRIES) return channel;
    }
  }

  /** Mark a channel stale, after a fetch whose facts can't be trusted, and
   *  tell the server when it wasn't already: its labels, and those of its
   *  guild's other channels, no longer resolve (onChannelStale). */
  private markStale(channelId: string, guildId: string): void {
    if (this.stale.has(channelId)) return;
    this.stale.set(channelId, { guildId });
    this.channelStaleHandler?.(channelId);
  }

  /** Discord reported on a channel: a fetch of it that's out now may land
   *  with older facts (refetchChannel). */
  private overtake(channelId: string): void {
    for (const fetch of this.fetchesOut.get(channelId) ?? []) fetch.overtaken = true;
  }

  /** Discord says a channel doesn't exist, to any fetch of it: a deletion,
   *  as the gateway reports one. The server forgets it, and the threads
   *  discord.js holds under it, when the cache placed it in a guild, and
   *  discord.js's caches drop them (forgetCached). A lookup reports the
   *  channel it looked up as deleted too (lookUpChannel), whether or not the
   *  cache placed it: the server forgets a deleted channel the same way
   *  however often it's told. */
  private channelGone(channelId: string): void {
    const held = this.client.channels.cache.get(channelId) as
      | { guildId?: string | null; threads?: { cache: Map<string, unknown> } }
      | undefined;
    const guildId = held?.guildId ?? null;
    const threadIds = [...(held?.threads?.cache.keys() ?? [])];
    this.forgetCached(channelId);
    if (guildId) this.channelDeleteHandler?.(guildId, channelId, threadIds);
  }

  /** Drop what discord.js holds of a channel Discord says doesn't exist: the
   *  client's cache, its guild's, its channel's threads for a thread, and
   *  its own threads, which went with it, as discord.js's own removal of a
   *  deleted channel drops them. discord.js leaves all of it as it was when
   *  a fetch fails. Read by ids, since a thread's parent getter throws when
   *  it has no guild. */
  private forgetCached(channelId: string): void {
    type Held = { guildId?: string | null; parentId?: string | null; threads?: { cache: Map<string, unknown> } };
    const held = this.client.channels.cache.get(channelId) as Held | undefined;
    const ids = [channelId, ...(held?.threads?.cache.keys() ?? [])];
    const guild = held?.guildId ? this.client.guilds.cache.get(held.guildId) : undefined;
    const parent = held?.parentId ? (this.client.channels.cache.get(held.parentId) as Held | undefined) : undefined;
    for (const id of ids) {
      this.stale.delete(id);
      this.client.channels.cache.delete(id);
      guild?.channels.cache.delete(id);
    }
    parent?.threads?.cache.delete(channelId);
  }

  /** Discord's reports on guild channels, as the gateway dispatches them,
   *  before discord.js applies them: discord.js emits threadUpdate and
   *  channelUpdate only for a channel it holds, and a fetch can be out for
   *  one it doesn't. A report on a channel overtakes the fetches of it,
   *  its creation included: Discord sends a thread's when the bot learns of
   *  it, not only when it's made, and a channel's while a fetch of the new
   *  channel can be out (createTextChannel). A
   *  guild's payload, on a join or a return, and a sync of a guild's
   *  threads report on every channel they cover, and a channel's deletion
   *  takes its threads with it, without a report for each. A channel the
   *  cache doesn't hold has no guild or parent known until its fetch
   *  lands, so these overtake every fetch out. */
  private watchReports(): void {
    for (const event of [
      GatewayDispatchEvents.ChannelCreate, GatewayDispatchEvents.ChannelUpdate,
      GatewayDispatchEvents.ThreadCreate, GatewayDispatchEvents.ThreadUpdate, GatewayDispatchEvents.ThreadDelete,
    ]) {
      this.client.ws.on(event, (data: { id?: unknown }) => {
        if (typeof data?.id === 'string') this.overtake(data.id);
      });
    }
    for (const event of [GatewayDispatchEvents.GuildCreate, GatewayDispatchEvents.ThreadListSync, GatewayDispatchEvents.ChannelDelete]) {
      this.client.ws.on(event, () => {
        for (const fetches of this.fetchesOut.values()) for (const fetch of fetches) fetch.overtaken = true;
      });
    }
  }

  /** Mark stale the channels and threads that a guild, back from an outage
   *  or a gateway gap (onGuildAvailable) or joined again, no longer lists.
   *  discord.js refills the guild's own cache from its payload
   *  (Guild._patch), and keeps the rest in the client-wide cache with the
   *  facts they had: a thread archived, or a channel deleted, meanwhile
   *  reads as it did. A later threadUpdate only patches such a thread
   *  (ChannelUpdateAction) and a fetch adds it with no guild
   *  (ChannelManager.fetch), so neither puts it back in its guild's cache.
   *  Marks from the guild's last payload go first, and what's still
   *  unlisted is marked again. */
  private markUnlisted(guild: Guild): void {
    for (const [id, mark] of this.stale) if (mark.guildId === guild.id) this.stale.delete(id);
    let marked = 0;
    for (const channel of this.client.channels.cache.values()) {
      const c = channel as { id: string; guildId?: string | null };
      if (c.guildId !== guild.id || guild.channels.cache.has(c.id)) continue;
      this.stale.set(c.id, { guildId: guild.id });
      marked++;
    }
    if (marked > 0) dbg('gateway:guild-unlisted', { guildId: guild.id, marked });
  }

  /** Whether what the client's cache holds of a guild channel or thread may
   *  be older than what Discord has reported since: its guild came back, or
   *  was joined again, without listing it (markUnlisted), or its fetch kept
   *  landing after newer reports (refetchChannel). A message, edit or
   *  deletion from it, and a read of its meta, fetch it again first
   *  (lookUpChannel, getChannelMeta). It stays stale until an update of it
   *  or a fetch nothing overtook. Its deletion, or its guild being left,
   *  drops the mark. */
  isStale(channelId: string): boolean {
    return this.stale.has(channelId);
  }

  /** Why a deliberate read of this channel is refused by the channel filters,
   *  or null when it isn't. It is the boundary list_channels and
   *  list_channel_members already apply: guildChannels, with a channel's
   *  parent (a thread's channel, a channel's category) admitting it too.
   *  DMs and guilds without a guildChannels entry pass; guildIds and dmUsers
   *  bound delivery, not reads. */
  async inspectionRefusal(channelId: string): Promise<string | null> {
    const channel = await this.channelById(channelId);
    // A channel discord.js returns nothing for can't be placed, so it fails
    // closed, with the error the read itself would give.
    if (!channel) throw channelUnusable(channelId, 'nothing was read');
    // A DM passes: the DM list filters incoming DMs only.
    if (channel.isDMBased()) return null;
    const guildId = 'guildId' in channel ? channel.guildId : null;
    const parentId = 'parentId' in channel ? channel.parentId : null;
    if (this.channelAllowed(guildId, channelId, parentId)) return null;
    return (
      `Channel ${channelId} is outside this residence's configured channel filters — ` +
      'filters bound inspection as well as delivery. Nothing was read.'
    );
  }

  /** Whether Discord would show this bot a channel's messages: a DM's
   *  always, and a server channel's, a thread's included, when discord.js's
   *  cached permissions give this bot Read Message History there (a
   *  thread's are its parent's). Without it Discord answers a read of the
   *  channel's messages with none, not a refusal. A channel discord.js
   *  returns nothing for, or a bot member the cache doesn't hold, counts as
   *  not shown. */
  async readsMessageHistory(channelId: string): Promise<boolean> {
    const channel = await this.channelById(channelId);
    if (!channel) return false;
    if (channel.isDMBased()) return true;
    const me = channel.guild.members.me;
    return me !== null && (channel as GuildBasedChannel & { permissionsFor(m: GuildMember): Readonly<PermissionsBitField> | null })
      .permissionsFor(me)?.has(PermissionsBitField.Flags.ReadMessageHistory) === true;
  }

  private messageFilterReason(message: Message): string | null {
    const parentId =
      message.channel && 'parentId' in message.channel
        ? ((message.channel as { parentId?: string | null }).parentId ?? null)
        : null;
    return this.ingressReason({
      authorId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
      parentId,
    });
  }

  /** The one ingress decision, shared by live delivery and the reconnect
   *  catch-up sweep, so a message the live path refuses is never delivered
   *  by the other door. */
  private ingressReason(m: {
    authorId: string;
    guildId: string | null | undefined;
    channelId: string;
    parentId?: string | null;
  }): string | null {
    if (m.authorId === this.client.user?.id) return 'self-authored';
    if (this.guildIds?.length && m.guildId && !this.guildIds.includes(m.guildId)) {
      return 'guild-not-allowed';
    }
    // DMs: when a DM user whitelist is configured, drop DMs from anyone else.
    if (!m.guildId && this.dmUserRefused(m.authorId)) {
      return 'dm-user-not-allowed';
    }
    if (m.guildId && !this.channelAllowed(m.guildId, m.channelId, m.parentId)) {
      return 'channel-not-allowed';
    }
    return null;
  }

  /**
   * The DM allowlist's one rule, for every DM event delivered to the agent
   * (creates, live and swept, edits and deletes): with a list configured, a
   * DM counts only from a listed user, and one whose user isn't known is
   * refused (fail closed). The agent's own reads, such as fetch_history, are
   * outside it, as they always were. Creates and edits are judged by their
   * author: a create always names one, an edit normally does, and an edit
   * that doesn't is refused. A delete is judged by the DM's other party
   * (messageEventInfo's dmRecipientId): its author unless the message is the
   * bot's own, else the channel's recipient, since an uncached delete names
   * no author. A sender removed from the list is out for every one of these,
   * deletes of messages delivered before the removal included.
   */
  private dmUserRefused(userId: string | undefined): boolean {
    return !!this.dmUsers && (!userId || !this.dmUsers.has(userId));
  }

  /** Whether the DM list admits this user as a DM's other party, as it
   *  stands now: a channels/open that looked a DM up checks again at its
   *  commit, since the filters file can be reloaded during the open. */
  dmUserAdmitted(userId: string): boolean {
    return !this.dmUserRefused(userId);
  }

  /** Ingress decision for a message fetched from history (the catch-up
   *  sweep), resolving a thread's parent from the channel cache. */
  historyIngressReason(channelId: string, guildId: string | null, authorId: string): string | null {
    const channel = this.client.channels.cache.get(channelId) as { parentId?: string | null } | undefined;
    return this.ingressReason({ authorId, guildId, channelId, parentId: channel?.parentId ?? null });
  }

  private convertMessage(message: Message): DiscordMessageData {
    // discord.js exposes channel/guild names directly on the Message object
    // (`message.channel.name`, `message.guild?.name`); they're only undefined
    // for unusual channel kinds (e.g. uncached partials). Fall back to null
    // so downstream rendering can distinguish "unknown" from "DM". A stale
    // channel's name may no longer be Discord's, so it's unknown too.
    const channel = message.channel as { name?: string } | null;
    const channelName = this.knownName(message.channelId, channel?.name);
    const guildName = message.guild?.name ?? null;
    // `cleanContent` resolves <@id>, <@&roleId>, <#channelId> to
    // @username / @role / #channel (with raw-content fallback), forwarded
    // messages carry their body in messageSnapshots, not content, and Discord
    // SYSTEM messages synthesize their client affordance from message.type —
    // all handled in resolveVisibleContent, shared with the history paths.
    const content = resolveVisibleContent(message);
    // A forward's reference points at its ORIGIN message (reference.type =
    // Forward); only a real reply (type Default = 0) should read as reply-to,
    // else a forwarded bot message looks like a reply to the bot.
    const refType = (message.reference as { type?: number } | null)?.type ?? 0;
    return {
      id: message.id,
      content,
      cleanContent: content,
      authorId: message.author.id,
      authorName: message.author.username,
      isBot: message.author.bot,
      channelId: message.channelId,
      channelName,
      guildId: message.guildId ?? null,
      guildName,
      // A message posted IN a thread names that thread, which is its channel.
      // (`message.thread` is the thread a message STARTED, not where it was
      // posted, so it never stands in for this.)
      ...this.threadPlace(message.channel, message.channelId),
      replyToId: refType === 0 ? (message.reference?.messageId ?? undefined) : undefined,
      // mentions.repliedUser is the User the reply targets — distinct
      // from mentions.users (which only includes them if the sender
      // explicitly enabled the reply-ping). We capture it so reply-to-bot
      // can be treated as direct address regardless of the ping toggle.
      replyToUserId: message.mentions.repliedUser?.id ?? null,
      replyToUserName: message.mentions.repliedUser?.username ?? null,
      mentions: message.mentions.users.map((u) => u.id),
      mentionsBotRole: message.mentions.roles.some(
        (r) => (r as { tags?: { botId?: string } }).tags?.botId === this.client.user?.id,
      ),
      attachments: mapAllAttachments(message),
      timestamp: message.createdAt,
    };
  }
}

/** Render a content-less Discord system message the way the human client
 *  does — from its type. The author of a system message is its subject
 *  (e.g. the joining member authors the UserJoin message), so downstream
 *  "Author: <text>" rendering reads naturally. Unknown/new types degrade to
 *  a generic marker with the numeric type rather than an empty string. */
function systemMessageText(type: MessageType): string {
  switch (type) {
    case MessageType.UserJoin:
      return '[joined the server]';
    case MessageType.GuildBoost:
      return '[boosted the server]';
    case MessageType.GuildBoostTier1:
    case MessageType.GuildBoostTier2:
    case MessageType.GuildBoostTier3:
      return '[boosted the server to a new tier]';
    case MessageType.ChannelPinnedMessage:
      return '[pinned a message to this channel]';
    case MessageType.ChannelFollowAdd:
      return '[followed a channel into this one]';
    case MessageType.RecipientAdd:
      return '[added someone to the group]';
    case MessageType.RecipientRemove:
      return '[removed someone from the group]';
    case MessageType.ChannelNameChange:
      return '[changed the channel name]';
    case MessageType.ThreadCreated:
      return '[started a thread]';
    case MessageType.AutoModerationAction:
      return '[automod action]';
    default:
      return `[system message: type ${type}]`;
  }
}

/** Map a discord.js message's attachments collection to DiscordAttachment[]. */
function mapAttachments(message: { attachments?: { values?(): IterableIterator<unknown> } }): DiscordAttachment[] {
  const coll = message.attachments;
  if (!coll || typeof coll.values !== 'function') return [];
  const out: DiscordAttachment[] = [];
  for (const a of coll.values() as IterableIterator<{
    id: string; name: string | null; url: string; contentType: string | null; size: number;
  }>) {
    const expiry = attachmentUrlExpiry(a.url);
    out.push({
      id: a.id,
      name: a.name ?? a.id,
      url: a.url,
      ...(expiry ? { expiresAt: expiry.toISOString() } : {}),
      contentType: a.contentType ?? null,
      size: typeof a.size === 'number' ? a.size : 0,
    });
  }
  return out;
}

/** When a Discord CDN URL stops working: its signed `ex` parameter, Unix
 *  seconds in hex. Null for a URL without a readable one, so nothing is
 *  guessed. */
export function attachmentUrlExpiry(url: string): Date | null {
  let ex: string | null;
  try {
    ex = new URL(url).searchParams.get('ex');
  } catch {
    return null;
  }
  // Whole hex only: parseInt would read a valid prefix of anything else.
  if (!ex || !/^[0-9a-f]+$/i.test(ex)) return null;
  const expiry = new Date(Number.parseInt(ex, 16) * 1000);
  return Number.isFinite(expiry.getTime()) ? expiry : null;
}

/** Where a message stood when the send of one of its parts failed, a
 *  message sent in one part included, carried on the error so the send
 *  tools can say so: the agent would otherwise read the failure as nothing
 *  sent, and sending the whole message again could post parts twice. The
 *  parts' texts are as sent, after mentions are rewritten, so the agent
 *  finds where the rest begins by its words, not by a position it would
 *  have to count to. */
export interface PostedParts {
  /** The ids of the parts that posted, in order: none when the first failed. */
  ids: string[];
  /** How many parts the message was split into. */
  of: number;
  /** The text of the part that failed: '' for a message of files alone. */
  failed: string;
  /** The text of the part after it, unless it was the last. */
  next?: string;
  /** Whether the message carried files, which go with its last part. */
  files: boolean;
  /** Whether the message replied to one, which its first part carries. */
  reply: boolean;
}

/** Carries what a failed send posted, on any send's error, a message sent
 *  in one part included: whether that part posted is as unknown as a later
 *  part's when Discord didn't refuse it. Attached only here, where
 *  sendMessage or sendDM's post of a part throws, so it also says that post
 *  was the request that failed. The DM notice's post (sendDmNotice) attaches
 *  none: its errors stay with the notice's own outcome. */
function withPostedParts(err: unknown, posted: string[], chunks: string[], files: boolean, reply: boolean): unknown {
  if (err && typeof err === 'object') {
    const k = posted.length;
    Object.assign(err, {
      postedParts: {
        ids: [...posted],
        of: chunks.length,
        failed: chunks[k],
        ...(k + 1 < chunks.length ? { next: chunks[k + 1] } : {}),
        files,
        reply,
      } satisfies PostedParts,
    });
  }
  return err;
}

/** A message's own attachments plus any carried by forwarded snapshots.
 *  Snapshot attachments keep their original CDN URLs (signed like any other),
 *  so merging them here gives a forward's media the same handling as a native
 *  upload. On the live path, images are inlined as blocks, text files are
 *  inlined, and everything else is a name+URL note. The history paths inline
 *  nothing: the backscroll block before a live message and the catch-up list
 *  attachments by name, and fetch_history, fetch_around and channels/open
 *  history carry each one with its URL, and its expiresAt when the URL has
 *  one. The forwarded line's "[N attachments]" count note stays: it tells
 *  the agent which message the media rode in on. */
export function mapAllAttachments(m: {
  attachments?: { values?(): IterableIterator<unknown> };
  messageSnapshots?: { size: number; values(): Iterable<ForwardSnapshot> } | null;
}): DiscordAttachment[] {
  const out = mapAttachments(m);
  if (m.messageSnapshots && m.messageSnapshots.size > 0) {
    // Dedup by attachment id: a re-forwarded forward can surface the same
    // attachment in more than one snapshot (or in both the outer message and
    // a snapshot). First occurrence wins — outer-most is least surprising.
    const seen = new Set(out.map((a) => a.id));
    let snapshotIndex = 0;
    for (const snap of m.messageSnapshots.values()) {
      snapshotIndex++;
      for (const att of mapAttachments({ attachments: snap.attachments ?? undefined })) {
        if (seen.has(att.id)) continue;
        seen.add(att.id);
        out.push({ ...att, forwardedSnapshotIndex: snapshotIndex });
      }
    }
  }
  return out;
}

/** What an exact open's lookup makes of a fetch that failed. Discord refusing
 *  the id means this server doesn't serve it: Unknown Channel, Missing
 *  Access, a malformed id's Invalid Form Body, or any other 403 or 404.
 *  Anything else leaves its facts unknown, and another open fetches it
 *  again: no answer (a 5xx, a timeout, a dropped connection, or a rejection
 *  that isn't Discord's), and a refusal that isn't about the id, such as a
 *  401 after the bot's token changed. */
function lookUpFailure(channelId: string, err: unknown): null | { kind: 'uncertain' } {
  const status = (err as { status?: unknown } | null)?.status;
  const code = (err as { code?: unknown } | null)?.code;
  const refused = code === UNKNOWN_CHANNEL || code === MISSING_ACCESS || code === INVALID_FORM_BODY
    || status === 403 || status === 404;
  dbg('lookUpServedChannel:failed', { channelId, refused, error: err instanceof Error ? err.message : String(err) });
  return refused ? null : { kind: 'uncertain' };
}

/** The kinds of guild channel registered by listing them (at boot, when one
 *  is created, changed or the bot joins its guild, and by refresh_channels):
 *  those messages are posted in, a voice or stage channel's text chat
 *  included. A thread is posted in too, but is registered by its messages:
 *  a guild's live threads come and go, and its archived ones are unbounded. */
export function isListedKind(type: DiscordChannelInfo['type']): boolean {
  return type === 'text' || type === 'announcement' || type === 'voice' || type === 'stage';
}

/** The kinds that hold no messages themselves: a category holds channels,
 *  and a forum its posts, which are threads. */
export function holdsNoMessages(type: DiscordChannelInfo['type']): boolean {
  return type === 'category' || type === 'forum';
}

/** The Discord channel types whose posts are threads: a forum, and a media
 *  channel, which mapChannelType leaves `unknown` since nothing addresses
 *  it. Its name is in each post's label. */
export function holdsPosts(type: ChannelType | undefined): boolean {
  return type === ChannelType.GuildForum || type === ChannelType.GuildMedia;
}

/** The errors a call gets when discord.js returns no channel for an id, with
 *  what didn't happen (`nothing`, from the call). Discord answered for the id
 *  (an id it doesn't know throws Unknown Channel, which explainDiscordError
 *  explains), but discord.js couldn't build a channel from the answer: a type
 *  it has no class for, which only an update of the adapter changes, or a
 *  server channel whose server isn't in its cache. In discord.js 14.26.5,
 *  READY puts every server the bot is in into that cache, unavailable ones
 *  included, and GUILD_CREATE adds one it joins later, so a server is
 *  missing only until the gateway delivers it, and the same call may work a
 *  moment later. Telling the two causes apart would take a second lookup,
 *  whose channel would need every check a normal lookup gets, for a rare
 *  case, so channelUnusable names both, with the retry hint on the second.
 *  A DM has no server, so only the first cause applies to one, but at a null
 *  the adapter can't tell a DM's id from a server channel's: every call gets
 *  both causes except sendDmNotice, which knows its channel is a DM and uses
 *  unhandledKind, naming the first alone. */
function channelUnusable(channelId: string, nothing: string): Error {
  return new Error(
    `Channel ${channelId} exists, but this adapter can't use it, so ${nothing}. Either it's a kind of channel ` +
      "this version of the adapter can't handle, which only an operator updating the adapter can change, or its " +
      'server is still loading on this connection, in which case the same call may work in a moment.',
  );
}

function unhandledKind(channelId: string, nothing: string): Error {
  return new Error(
    `Channel ${channelId} exists, but it's a kind of channel this version of the adapter can't handle, so ${nothing}. ` +
      'Only an operator updating the adapter can change that.',
  );
}

/** What the kinds of channel that hold no messages of their own are called,
 *  by Discord type number, in the errors that name them (noMessagesHere).
 *  holdsNoMessages answers another question, for registration: which of
 *  mapChannelType's kinds no delivery is registered from. It takes the
 *  mapped kind, so it can't name a directory or a media channel, which
 *  both map to unknown. */
const HOLDS_NO_MESSAGES: Record<number, string> = {
  4: 'a category',
  14: 'a directory channel',
  15: 'a forum',
  16: 'a media channel',
};

/** The error for a channel this adapter can't read or send to, naming what
 *  it is and what didn't happen (`nothing`, from the call), then where its
 *  messages are or plainly that nothing here can use it. A category's
 *  channels are the ones list_channels shows for its server with it as their
 *  parent, as far as the channel filters allow. A forum's or media channel's
 *  posts are threads, which no tool here lists, so a post's id comes only
 *  from a message posted in it or a link to it. Its messages are written
 *  through that id, and read through it as far as the channel filters
 *  allow, since the filters bound reads but not sends. A directory channel
 *  lists servers. A kind this table doesn't name, such as one a later
 *  discord.js builds, is named by its type number, without a claim that it
 *  holds no messages, and only an operator updating the adapter can change
 *  that this adapter can't use it. */
function noMessagesHere(channel: { type: number; guildId?: string | null }, channelId: string, nothing: string): Error {
  const kind = HOLDS_NO_MESSAGES[channel.type];
  if (!kind) {
    return new Error(
      `Channel ${channelId} is a kind of channel (type ${channel.type}) that this adapter can't read or send to, so ${nothing}. ` +
        'Only an operator updating the adapter can change that.',
    );
  }
  const after = holdsPosts(channel.type)
    ? " Its posts are threads, and no tool here lists them, so a post's id comes only from a message posted in it or a link to it. " +
      "A post's messages are written through that id, and read through it where the configured channel filters allow."
    : channel.type === 4
      ? ` The channels in it that the configured channel filters allow are the ones list_channels for server ${channel.guildId} shows with ${channelId} as their parent.`
      : ' It lists servers, and nothing here can read it or send to it.';
  return new Error(`Channel ${channelId} is ${kind}, which holds no messages, so ${nothing}.${after}`);
}

/**
 * Discord channel type number -> the kind we expose.
 *
 * Name resolution keys off this (see SENDABLE in channel-names.ts), so an
 * unclassified type is not cosmetic: it silently drops out of name addressing.
 * GuildAnnouncement (5) did exactly that — an ordinary sendable text channel
 * that fell to 'unknown' and so could not be reached as `#announcements`, while
 * `list_channels` happily printed a pasteable label for it.
 */
export function mapChannelType(type: number | undefined): DiscordChannelInfo['type'] {
  switch (type) {
    case 0: return 'text';
    case 2: return 'voice';
    case 4: return 'category';
    // 5 = GuildAnnouncement ("news"). A normal message channel that can also
    // crosspost — sendable, and commonly named #announcements / #updates.
    case 5: return 'announcement';
    case 10: // AnnouncementThread — a thread, whatever its parent is.
    case 11:
    case 12: return 'thread';
    // 13 = GuildStageVoice. Its text chat takes messages, as a voice
    // channel's does (discord.js's StageChannel can send).
    case 13: return 'stage';
    case 15: return 'forum';
    // 16 (media) lands here on purpose: like a forum, it holds its posts as
    // threads, never a message of its own, so no name resolves to it and no
    // listing registers it; its posts are threads like any other.
    default: return 'unknown';
  }
}
