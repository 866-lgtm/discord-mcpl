/**
 * DiscordMcplServer — main MCPL server orchestrator.
 *
 * Handles the JSON-RPC main loop: initialize handshake, method dispatch,
 * and forwarding Discord events to the connected host.
 *
 * Follows the pattern from zero-k/game-manager/src/mcpl_server.rs.
 */

import type * as net from 'node:net';
import { createHash } from 'node:crypto';
import {
  McplConnection,
  textContent,
  method,
  ERR_FEATURE_SET_NOT_ENABLED,
  ERR_UNKNOWN_FEATURE_SET,
  ERR_UNKNOWN_CHANNEL,
  ERR_CHANNEL_OPEN_FAILED,
  ERR_CHECKPOINT_NOT_FOUND,
} from '@animalabs/mcpl-core';
import { formatAgentDateTime, resolveAgentTimeZone, resolveTimestampStyle } from './timezone.js';

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
} from '@animalabs/mcpl-core';

import type { ChannelFacts, DiscordAdapter, DiscordMessageData, DiscordAttachment, HistoryMessage, OutgoingFile, ReactionSummary, MessageEventInfo, DmRefusal, DmSendFailure, PostedParts, ThreadPlace } from './discord-adapter.js';
import { LATEST_FROM_WINDOW, attachmentUrlExpiry, holdsNoMessages, isListedKind, kindOfValue } from './discord-adapter.js';
import { DM_NOTICE_TEXT, DmNoticeState, resolveDmNoticesPath, type DmNoticeDecision } from './dm-notices.js';

/** How much of a latestFrom target's text its receipt echoes. */
const LATEST_FROM_EXCERPT = 80;
import type { ChatInputCommandInteraction } from 'discord.js';
import { headerValue, labelValue, quotedValue, renderSourceHeader } from './source-header.js';
import { MessageFlags } from 'discord.js';
import {
  boundedReply,
  controlOutcomeUnknown,
  describeCancel,
  describeMarkers,
  describeRetract,
  hostCount,
  describeHideMarks,
  HIDE_MARKS_NOT_ADDED,
  HIDE_MARKS_OPTION,
  hideMarksAt,
  hostRefusal,
  isCancelReceipt,
  isRetractReceipt,
  isView,
  MARKS_OPTION,
  PROBE_AGAIN,
  readHiddenRefs,
  readMarksChoice,
  renderEntry,
  renderListPage,
  summarizeControl,
  summarizeMarkers,
  surgeryOutcomeUnknown,
  unreadable,
  unreadableControl,
  unreadableSurgery,
  type BoundedReply,
  type HiddenRef,
} from './awareness-marks.js';
import { toolDefinitions } from './tools.js';
import { withToolClasses } from './tool-classes.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import {
  ChannelManager,
  INVALID_PARAMS,
  RequestRefusal,
  channelLabelFor,
  typeName,
  mcplChannelId,
  parseMcplChannelId,
  resolveOpenTarget,
  toDescriptor,
  toDmDescriptor,
} from './channels.js';
import {
  channelLabel,
  isNameAddressableKind,
  isSnowflake,
  looksLikeExplicitName,
  parseChannelRef,
  type AddressingPath,
} from './channel-names.js';
import { UNKNOWN_CHANNEL, explainDiscordError, type ExplainContext } from './discord-errors.js';
import { saveFiltersFile, loadFiltersFile, DiscordFiltersState, type DiscordFilters } from './filters.js';
import { StateTracker } from './state.js';
import { existsSync, readFileSync } from 'node:fs';
import { isId, isJsonObject, readJsonFile, usableIds, writeJsonFile, type Usable } from './persisted-json.js';
import sharp from 'sharp';
import { dbg } from './debug-log.js';
import {
  advertisedRetryWindowMs,
  answerClass,
  errorRejection,
  isAuthorityRefusal,
  incomingOutcome,
  isContentRejection,
  pushOutcome,
  summarizeAttachments,
  withoutInlineMedia,
  type ForwardOutcome,
} from './incoming-results.js';

// TypeScript copies the manifest into dist. The module-relative path works
// in both source and built layouts, independently of the working directory.
const packageJson: typeof import('../package.json') = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/** Tools that read a channel's messages by channelId, held to the channel
 *  filters' inspection boundary (DiscordAdapter.inspectionRefusal). */
const INSPECTION_TOOLS: ReadonlySet<string> = new Set(['fetch_history', 'fetch_around']);

type ChannelOpenRequest = ChannelsOpenParams & {
  channelId?: string;
  history?: { limit: number; beforeMessageId?: string; sinceLastSeen?: boolean };
};

type ChannelOpenResponse = ChannelsOpenResult & {
  history?: ChannelsIncomingParams['messages'];
  historyTruncated?: boolean;
};

/** What registering the channels the filters newly let be seen brought. */
interface ChannelRefresh {
  visible: number;
  added: Array<{ id: string; label: string }>;
  note: string;
}

interface ChannelAcknowledgeRequest {
  channelId: string;
  messageId: string;
  intent: string;
  value?: string;
}

/** A thrown value's text. Anything can be thrown or rejected: a value that
 *  isn't an Error (undefined, a string) may have no message to read, and one
 *  with no prototype can't even be turned into a string. An empty message
 *  says nothing, so the value itself is used then: an Error without one
 *  reads "Error". This never throws. */
function errorText(err: unknown): string {
  try {
    const carried = (err as { message?: unknown } | null | undefined)?.message;
    return typeof carried === 'string' && carried !== '' ? carried : String(err);
  } catch {
    return `[an unprintable ${typeof err}]`;
  }
}

/**
 * An applied /undo's or /hide's `lastVisible`, the message the agent now
 * sees last, read field by field: a field that isn't text is left out rather
 * than read as text. `ifAbsent` stands in when the host sent none.
 */
function lastVisibleLines(lastVisible: unknown, ifAbsent?: string): string[] {
  if (!isJsonObject(lastVisible)) return ifAbsent ? [ifAbsent] : [];
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const who = text(lastVisible.participant) ?? text(lastVisible.role) ?? '?';
  const preview = lastVisible.preview;
  if (typeof preview === 'string' && preview !== '') {
    return [`Last message now visible to the agent — **${who}**:`, `> ${preview.replace(/\n/g, '\n> ')}`];
  }
  return [
    `Last message now visible to the agent — **${who}**: ` +
      (preview === undefined || preview === null || preview === '' ? '*(empty message)*' : "*(a preview this server can't read)*"),
  ];
}

/** Where a message sits, as the location prefix and the reconnect sweep's
 *  `<missed>` header name it. Posted in a thread, that is the channel the
 *  thread hangs off and the thread itself, named by its id when it has no
 *  name; otherwise it is the message's channel. A part that isn't known is
 *  null. */
function messagePlace(channelName: string | null | undefined, thread: ThreadPlace): { channel: string | null; thread: string | null } {
  return thread.threadId
    ? { channel: thread.threadParentName ?? null, thread: thread.threadName ?? thread.threadId }
    : { channel: channelName ?? null, thread: null };
}

/** A thread message's identity, as every lane that delivers it carries it
 *  (channels/incoming metadata, a push's origin, the sweep's): the thread's
 *  name and the channel it hangs off, each left out when it isn't known.
 *  No MCPL threadId: that names a thread within a channel, and a Discord
 *  thread is its own channel, already named by the channel id. Empty for a
 *  message that isn't in a thread. */
function threadFields(thread: ThreadPlace): { threadName?: string; threadParentName?: string } {
  if (!thread.threadId) return {};
  return {
    ...(thread.threadName ? { threadName: thread.threadName } : {}),
    ...(thread.threadParentName ? { threadParentName: thread.threadParentName } : {}),
  };
}

/** The place tag every lane gives a message posted in a thread: `chat:thread`
 *  (the host documents it as "Occurred in a thread"). */
function threadTags(thread: ThreadPlace): string[] {
  return thread.threadId ? ['chat:thread'] : [];
}

/** Whether descriptor `d` lacks a name that `known`, the same channel's
 *  registered descriptor, has (toDescriptor's metadata names): what the cache
 *  knows of a channel now can be less than what it knew. */
function knowsLessThan(d: ChannelDescriptor, known: ChannelDescriptor): boolean {
  const names = (x: ChannelDescriptor) => (x.metadata ?? {}) as { channelName?: string; guildName?: string; parentName?: string };
  const now = names(d);
  const then = names(known);
  return (['channelName', 'guildName', 'parentName'] as const).some((k) => then[k] !== undefined && now[k] === undefined);
}

/** What registerGuildDelivery did with a delivery's channel: its MCPL id
 *  when it's registered (`id`), and whether this delivery registered it
 *  (`registered`), finding it live, admitted and unarchived, with its facts
 *  current. A channel it withheld isn't `registered`, and is named only when
 *  it was registered before. */
type GuildDelivery = { id: string; registered: true } | { id: string | undefined; registered: false };

interface SavedTally {
  anchorId: string;
  talliedThrough?: string;
  messages: number;
  characters: number;
}

interface SavedWatermarks {
  watermarks?: Record<string, string>;
  dmChannels?: string[];
  missed?: Record<string, SavedTally>;
  owed?: Record<string, OwedMessage[]>;
}

/** A message forwarded live that the host didn't take (owe): its id, and
 *  whether it may have arrived after all (no verdict came), whether what
 *  wasn't taken was an edit of it, and how many deliveries of it have been
 *  tried (deliverOwed). */
interface OwedMessage {
  id: string;
  uncertain?: true;
  edit?: true;
  tries?: number;
}
/** How many messages are owed per channel at most; the oldest go first. */
const OWED_PER_CHANNEL_MAX = 50;
/** How many delivery tries an owed message gets, at most one counted per
 *  connection, before it is given up. */
const OWED_DELIVERY_TRIES = 3;
/** How long the live trigger waits after a failed delivery try on the same
 *  connection before trying again (the try isn't counted again). */
const OWED_RETRY_COOLDOWN_MS = 5 * 60_000;

/** What the watermark store can use of its file. saveWatermark writes an
 *  object with up to four keys, any of which a file from an earlier version
 *  may lack: `watermarks`, channel ids to message ids; `dmChannels`, a list of
 *  ids; `missed`, channel ids to tallies; and `owed`, written only while
 *  something is owed, channel ids to lists of owed messages (OwedMessage). A tally has a string anchorId,
 *  finite messages and characters, and talliedThrough a string or absent, as
 *  every version since the tally began (9884f70) has written it. Anything
 *  else can't be used, so readJsonFile keeps it in the copy it makes, and
 *  loads the rest. */
function usableWatermarks(value: unknown): Usable<SavedWatermarks> {
  if (!isJsonObject(value)) return { value: null, unusable: 'not an object' };
  let others = 0;
  const out: SavedWatermarks = {};
  for (const [key, entries] of Object.entries(value)) {
    if (key === 'watermarks' && isJsonObject(entries)) {
      out.watermarks = {};
      for (const [channel, id] of Object.entries(entries)) {
        if (isId(channel) && isId(id)) out.watermarks[channel] = id;
        else others++;
      }
    } else if (key === 'dmChannels' && Array.isArray(entries)) {
      out.dmChannels = entries.filter(isId);
      others += entries.length - out.dmChannels.length;
    } else if (key === 'missed' && isJsonObject(entries)) {
      out.missed = {};
      for (const [channel, tally] of Object.entries(entries)) {
        if (
          isId(channel) &&
          isJsonObject(tally) &&
          typeof tally.anchorId === 'string' &&
          (tally.talliedThrough === undefined || typeof tally.talliedThrough === 'string') &&
          Number.isFinite(tally.messages) &&
          Number.isFinite(tally.characters)
        ) {
          const { anchorId, talliedThrough, messages, characters, ...extra } = tally;
          out.missed[channel] = {
            anchorId,
            ...(talliedThrough === undefined ? {} : { talliedThrough }),
            messages,
            characters,
          } as SavedTally;
          others += Object.keys(extra).length;
        } else {
          others++;
        }
      }
    } else if (key === 'owed' && isJsonObject(entries)) {
      out.owed = {};
      for (const [channel, list] of Object.entries(entries)) {
        if (!isId(channel) || !Array.isArray(list)) { others++; continue; }
        const usable: OwedMessage[] = [];
        for (const item of list) {
          if (isJsonObject(item) && isId(item.id)
            && (item.uncertain === undefined || item.uncertain === true)
            && (item.edit === undefined || item.edit === true)
            && (item.tries === undefined || (Number.isInteger(item.tries) && (item.tries as number) >= 0))) {
            usable.push({
              id: item.id as string,
              ...(item.uncertain ? { uncertain: true as const } : {}),
              ...(item.edit ? { edit: true as const } : {}),
              ...(item.tries ? { tries: item.tries as number } : {}),
            });
          } else {
            others++;
          }
        }
        if (usable.length > 0) out.owed[channel] = usable;
      }
    } else {
      others++;
    }
  }
  return { value: out, unusable: others ? `${others} ${others === 1 ? 'entry' : 'entries'} the store doesn't write` : null };
}

/** What a tool's reply adds when its store's configured file couldn't be
 *  saved. True whatever the failure: the store as it is now isn't on disk. */
const unsavedNote = (store: string, failure: string | null): string =>
  failure ? ` The ${store} couldn't be saved (${failure}), so as it stands now it wouldn't survive a restart.` : '';

/** How a required string argument's value fell short, for its refusal:
 *  given none (left out, or null), blank, or not a string. Tool arguments aren't
 *  checked against their schema, so the value can be anything. */
function fellShort(value: unknown): string {
  return value === undefined || value === null
    ? ', and this call gave none'
    : typeof value === 'string'
      ? ', and this call gave it blank'
      : ` as a string, and this call gave ${kindOfValue(value)}`;
}

/** The refusal for a tool called without a usable channelId, before it did
 *  anything (`nothing` says what didn't happen): it names what was wrong
 *  with the value given, and how to give one. A #name reaches only the kinds
 *  handleToolCall's resolver admits (see resolveChannelRef). */
function channelIdRequired(tool: string, value: unknown, nothing = 'Nothing was done'): Error {
  return new Error(
    `${nothing}: ${tool} needs channelId${fellShort(value)}. Give the channel's id in quotes, such as ` +
      '"123456789012345678", or, for a text, announcement, voice or stage channel, its #name. list_channels with ' +
      "guildId, a server's id from list_guilds, lists the channels there that the configured filters allow, with " +
      'their ids.',
  );
}

/** A channel tool's channelId, trimmed, or its refusal: a missing, blank or
 *  non-string value never reaches the tool. handleToolCall trims an id only
 *  to tell it from a #name, and passes an id on as it was given. */
function requiredChannelId(tool: string, value: unknown, nothing?: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw channelIdRequired(tool, value, nothing);
}

/** send_dm's userId, or its refusal, before anything is looked up or sent. */
function requiredUserId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(
    `Nothing was sent: send_dm needs userId${fellShort(value)}. Give the recipient's id in quotes, such as ` +
      '"123456789012345678", or their name: @username or display name.',
  );
}

/** A send tool's content: its text, or none when it's left out, null or
 *  false, so that with files the files post alone. Anything else is refused
 *  before anything is sent, 0 included: it may have been meant as "0". */
function messageContent(tool: string, value: unknown): string {
  if (value === undefined || value === null || value === false) return '';
  if (typeof value === 'string') return value;
  throw new Error(
    `Nothing was sent: ${tool} takes content as a string, and this call gave ${kindOfValue(value)}. Give the message's ` +
      'text in quotes, or, to send only files, leave content out and give files.',
  );
}

/** A Discord message must carry text and/or attachments — reject empty sends. */
function requireContentOrFiles(content: string, files: OutgoingFile[] | undefined): void {
  if ((!content || !content.trim()) && (!files || files.length === 0)) {
    throw new Error('Nothing was sent: the message is empty. Give it "content", "files", or both.');
  }
}

/** Whether a request's error is Discord refusing it: a 4xx, an answer
 *  Discord gave after evaluating the request. Anything else leaves open
 *  whether the request took effect: a 5xx, a timeout or a lost connection
 *  doesn't show whether Discord acted on it, and the REST client sends it
 *  again after a 5xx, a timeout or a reset connection, up to three times.
 *  No 429 reaches here: the REST client waits one out and sends again. */
function refusedByDiscord(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/** Where the unposted rest of a split message begins: its first words, up
 *  to REST_QUOTED characters, for the agent to find in its own message. A
 *  longer rest is cut at the last whitespace in the second half of those,
 *  or else at REST_QUOTED; all counted in characters (code points). */
const REST_QUOTED = 40;
function restBegins(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= REST_QUOTED) return text;
  const head = chars.slice(0, REST_QUOTED);
  let cut = REST_QUOTED;
  for (let i = REST_QUOTED - 1; i >= REST_QUOTED / 2; i--) {
    if (/\s/.test(head[i])) {
      cut = i;
      break;
    }
  }
  return head.slice(0, cut).join('');
}

/** The send tools' note on a message whose send failed, from the adapter's
 *  postedParts: which parts posted, whether the one that failed was refused,
 *  so nothing more posted, or may have posted, where the rest begins, by its
 *  first words, in each case, then that the quoted words are from the text
 *  as sent (where a mention reads <@id>, or <@&id> for a role, not as the
 *  agent wrote it), and that sending the whole message again could post
 *  parts a second time. A message sent in one part that Discord refused gets
 *  no note: Discord's refusal (a 4xx) means it didn't make the message, and
 *  the tool's error is that refusal. One whose outcome is unknown gets one,
 *  since its error doesn't say whether it posted. Where Discord refused a
 *  later part, the note says that when the agent sends again, it should send
 *  only the rest (the error's own explanation, such as 50013's, may say that
 *  sending it will be refused until a permission is granted), unless that
 *  part carried the message's files: Discord may have refused the files
 *  rather than the text, so that explanation says what may go through, and
 *  the note gives no remedy of its own. `history` says whether fetch_history
 *  would show this channel's messages here, the way to check what posted:
 *  the note names it only then, and otherwise says that can't be checked
 *  here, what each choice risks, and who can tell, with no choice made for
 *  the agent. */
function postedPartsNote(p: PostedParts, refused: boolean, history: boolean): string {
  const k = p.ids.length;
  const tell = 'someone who can see the channel can tell';
  if (p.of === 1) {
    if (refused) return '';
    return "Whether this message posted is unknown, since Discord didn't answer it with a refusal. " + (history
      ? "Calling again could post it a second time, so check the channel's latest messages (fetch_history) before " +
        'sending again.'
      : `That can't be checked from here: sending it again risks a second copy, and not sending it risks it missing; ${tell}.`);
  }
  const parts = (n: number) => `first${n === 1 ? '' : ` ${n}`} of the ${p.of} parts this message was split into`;
  if (k === 0 && refused) return `Discord refused the ${parts(1)}, so none of it posted.`;
  const rest = (part: string) => `rest${p.files ? ', files included,' : ''} begins with ${quotedValue(restBegins(part))}`;
  const after = p.next ? `the ${rest(p.next)}` : 'the whole message posted';
  const again = `Calling again with the whole message could post ${k <= 1 ? 'the first part' : `those ${k} parts`} a second time`;
  const asSent = 'Quoted words are from the text as sent, where a mention reads <@id>, or <@&id> for a role.';
  const nothingAfter = p.next ? '; nothing after it posted' : '';
  if (refused) {
    // The files go with the last part, so the part refused carried them when
    // it was the last.
    const carriedFiles = p.files && k === p.of - 1;
    return `The ${parts(k)} posted before this failure: ${p.ids.join(', ')}. Discord refused the next part, so the rest ` +
      `didn't post. The ${rest(p.failed)}. ${asSent} ${again}${carriedFiles ? '.' : ', so when you send again, send only the rest.'}`;
  }
  if (k === 0) {
    return `Whether the ${parts(1)} posted is unknown, since Discord didn't answer it with a refusal${nothingAfter}. ` +
      `If it didn't post, nothing did; if it did, ${after}. ${asSent} ` + (history
        ? `${again}, so check the channel's latest messages (fetch_history) before sending again.`
        : "Whether the first part posted can't be checked from here: sending the whole message again could post it " +
          `twice, and sending from the part after it could leave it out; ${tell}.`);
  }
  return `The ${parts(k)} posted before this failure: ${p.ids.join(', ')}. Whether the next part posted is unknown, since ` +
    `Discord didn't answer it with a refusal${nothingAfter}. If it didn't post, the ${rest(p.failed)}; if it ` +
    `did, ${after}. ${asSent} ${again}` +
    (history
      ? ", so send only the rest, once the channel's latest messages (fetch_history) show whether the next part posted."
      : ". Whether the next part posted can't be checked from here: " + (p.next
        ? 'sending the rest from that part could post it twice, and sending from the one after it could leave it out'
        : 'sending it again could post it twice, and not sending it could leave it out') + `; ${tell}.`);
}

/** chx-compat ignore prefix. ChapterX-style Discord bots send `m continue`
 *  as a no-op trigger to wake their model and immediately delete the message
 *  afterward, but messageCreate fires before the delete propagates, so the
 *  message would otherwise leak into Lena's chronicle as ambient noise.
 *  Match by prefix (`startsWith`) so trailing whitespace or auto-appended
 *  text doesn't slip through. Case-sensitive: a literal `m continue` only. */
const CHX_NOOP_PREFIX = 'm continue';

/** discord-mcpl's note on a push from a guild channel or thread where the
 *  gate (shouldEnterContext) admits a message as it's posted only when it
 *  addresses the agent: neither open, subscribed nor muted. It says what the
 *  gate does there, and what opening adds, which only this server knows; the
 *  host's invitation gives the call. It claims no more, so its words are
 *  true on any push from such a channel: a message admitted while the
 *  channel was open or subscribed can still be pushed after it was closed or
 *  unsubscribed, and the catch-up after a restart delivers each missed
 *  mention with the messages around it. closedChannelNote says which pushes
 *  are given it. A message addresses the agent when it mentions the bot or
 *  the role Discord created for it (convertMessage's mentionsBotRole), or
 *  replies to one of its messages. */
const CLOSED_CHANNEL_NOTE =
  "<system>While this channel isn't open, a message from it reaches you as it's posted when it mentions you or the " +
  'role Discord created for you, or replies to one of your messages. Opening it brings its other messages as they ' +
  'arrive.</system>\n';

const AGENT_TIME_ZONE = resolveAgentTimeZone();
const AGENT_TIMESTAMP_STYLE = resolveTimestampStyle();

// ============================================================================
// Image normalization (downsample-on-ingest)
// ============================================================================

/** Longest edge (px) we keep for inlined images. Matches the ~1568px ceiling
 *  every major vision model downscales to server-side, so resizing to this is
 *  perceptually lossless — the model discards anything finer regardless. */
const IMAGE_LONG_EDGE_MAX = 1568;
/** JPEG quality when re-encoding opaque images. */
const IMAGE_JPEG_QUALITY = 85;
/** Cap on the *encoded* bytes we inline (raw, pre-base64). Anthropic accepts
 *  ~5MB/image of base64; staying under ~3.5MB raw keeps us comfortably inside. */
const IMAGE_OUTPUT_RAW_CAP = 3.5 * 1024 * 1024;
/** Refuse to even download sources larger than this (OOM guard). sharp's own
 *  pixel limit guards the decoded bitmap against decompression bombs. */
const IMAGE_FETCH_CEILING = 25 * 1024 * 1024;

/** Absolute ceiling on inlined text-attachment bytes. The configurable
 *  inline cap (DISCORD_ATTACHMENT_INLINE_MAX_BYTES) clamps to this — however
 *  high the knob is set, a text attachment can never put more than 256KiB
 *  into context. */
const MAX_TEXT_BYTES = 256 * 1024;
/** Default inline cap for text attachments (issue #30): 5KiB. */
const DEFAULT_ATTACHMENT_INLINE_MAX_BYTES = 5120;

interface NormalizedImage {
  data: string; // base64
  mimeType: string;
}

/** Downsample an image to model-max on ingest: resize so the longest edge is
 *  <= IMAGE_LONG_EDGE_MAX (never upscales), re-encoding to stay under the inline
 *  byte cap. Opaque images become JPEG; images with alpha stay PNG (flattened to
 *  JPEG only as a last resort to fit the cap). Already-small images pass through
 *  untouched. Animated GIFs are left as-is (frame resizing is out of scope) and
 *  inlined only when already under cap. Returns null when nothing inlinable can
 *  be produced, letting the caller degrade to a text note. */
async function normalizeImageForInference(
  buf: Buffer,
  declaredCt: string | null,
): Promise<NormalizedImage | null> {
  try {
    const meta = await sharp(buf, { animated: true }).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const isAnimated = (meta.pages ?? 1) > 1;
    // The pass-through fast paths below may ONLY emit formats the model API
    // accepts. sharp happily reads svg/tiff/avif/heif too — an SVG small
    // enough to skip re-encoding used to sail through as `image/svg` and
    // poison the agent's history with a permanently-400ing block (LabClaude,
    // 2026-07-11). Non-API formats now fall through to the re-encode
    // pipeline, which rasterizes them to PNG/JPEG.
    const API_SAFE_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);
    const apiSafe = API_SAFE_FORMATS.has(meta.format ?? '');

    // Animated: don't resize frames here. Inline as-is if small enough.
    // (Animated non-gif/webp can't be inlined at all — degrade to the
    // caller's text note rather than emit an unacceptable media type.)
    if (isAnimated) {
      return apiSafe && buf.length <= IMAGE_OUTPUT_RAW_CAP
        ? { data: buf.toString('base64'), mimeType: `image/${meta.format}` }
        : null;
    }

    // Already within bounds and under cap → inline original bytes unchanged.
    if (apiSafe && longest > 0 && longest <= IMAGE_LONG_EDGE_MAX && buf.length <= IMAGE_OUTPUT_RAW_CAP) {
      return { data: buf.toString('base64'), mimeType: `image/${meta.format}` };
    }

    // Fresh pipeline per encode (sharp instances aren't safely reusable across
    // multiple toBuffer() calls). resize() with withoutEnlargement is a no-op
    // when the image is already within bounds but over the byte cap.
    const resizeOpts = { width: IMAGE_LONG_EDGE_MAX, height: IMAGE_LONG_EDGE_MAX, fit: 'inside' as const, withoutEnlargement: true };
    const base = () => sharp(buf).resize(resizeOpts);

    let out: Buffer;
    let mimeType: string;
    if (meta.hasAlpha) {
      out = await base().png({ compressionLevel: 9 }).toBuffer();
      mimeType = 'image/png';
    } else {
      out = await base().jpeg({ quality: IMAGE_JPEG_QUALITY }).toBuffer();
      mimeType = 'image/jpeg';
    }

    // Still over cap (large PNG / high-detail photo) → flatten + shrink harder.
    if (out.length > IMAGE_OUTPUT_RAW_CAP) {
      out = await sharp(buf)
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 70 })
        .toBuffer();
      mimeType = 'image/jpeg';
      if (out.length > IMAGE_OUTPUT_RAW_CAP) return null;
    }

    return { data: out.toString('base64'), mimeType };
  } catch {
    return null;
  }
}

/** Per-message memory kept from a create for its later edits/deletes. */
interface CreateMemory {
  /** Resolves when the create has been forwarded (or dropped). */
  settled: Promise<void>;
  resolve: () => void;
  /** True once `settled` has resolved (lets callers skip the await). */
  done: boolean;
  /** Coalescing scope the create used: a channel id, or null for feature-set scope. */
  scope?: string | null;
  /** The create's rendering context, for a replacement that keeps it. */
  render?: { prefix: string; replyMarker: string; location: string; authorName: string; attachments: ContentBlock[] };
  edits: number;
}
const RECENT_CREATES_MAX = 512;
/** RFC-006 §3.1's retry window for a host that advertises event coalescing
 *  without one: an hour. */
const DEFAULT_RETRY_WINDOW_MS = 3_600_000;
/** How many deleted channel ids the server remembers (deletedChannels). A
 *  delivery is on its way for seconds, not for a thousand deletions. */
const DELETED_CHANNELS_KEPT = 1000;
/** Attachment blocks above this size, all of them together, are not kept for
 *  edits (inline images, inline text files). */
const RECENT_CREATE_ATTACHMENT_BYTES = 64 * 1024;

/** What a create remembers of its attachment blocks for an edit that replaces
 *  it: the blocks while they fit RECENT_CREATE_ATTACHMENT_BYTES, and above it
 *  a note that stands for them. */
function rememberedAttachments(blocks: ContentBlock[]): ContentBlock[] {
  if (Buffer.byteLength(JSON.stringify(blocks)) <= RECENT_CREATE_ATTACHMENT_BYTES) return blocks;
  return [textContent('[attachments as in the original message]')];
}

/** RFC-006 `coalesce` member (mcpl-core 0.2.x predates it). */
interface CoalesceMember {
  key: string;
  channelId?: string;
  retract?: boolean;
  initial?: boolean;
}
type CoalescedPushEventParams = PushEventParams & { coalesce?: CoalesceMember };
type CoalescedIncomingMessage = ChannelsIncomingParams['messages'][number] & { eventId?: string; coalesce?: CoalesceMember };

/** Normalize the host's `eventCoalescing` advertisement (RFC-006 §10). */
export function parseHostCoalescing(
  advertised: unknown,
): { pushEvents: boolean; channelsIncoming: boolean; channelScopedPush: boolean } | null {
  if (advertised === true) return { pushEvents: true, channelsIncoming: true, channelScopedPush: true };
  if (!advertised || typeof advertised !== 'object') return null;
  const o = advertised as Record<string, unknown>;
  return {
    pushEvents: o.pushEvents === true,
    channelsIncoming: o.channelsIncoming === true,
    channelScopedPush: o.channelScopedPush === true,
  };
}

export class DiscordMcplServer {
  private conn: McplConnection | null = null;
  // Note: the location-header transition tracker and the sticky-reply
  // channel are the same thing — both want to know "where did
  // communication last happen, in either direction." Tracked in
  // `lastChannelId` below.

  /** Actual runtime subscriptions. Desired state is host-owned and durable in
   *  Chronicle. `DISCORD_SUBSCRIPTIONS_FILE` is read only as a one-time legacy
   *  bootstrap hint; channels/open and channels/close reconcile this set. */
  private subscribedChannels = new Set<string>();
  private subscriptionsLoaded = false;

  /** Channels opted into live reaction visibility (per-channel, default off).
   *  Reactions from these channels surface in context but NEVER wake the agent
   *  (tagged `chat:reaction`, which matches no wake policy). Persisted to
   *  DISCORD_REACTION_CHANNELS_FILE, or a `.reactions.json` sibling of the
   *  subscriptions file. */
  private reactionChannels = new Set<string>();
  private reactionChannelsLoaded = false;
  /** The file may not hold reactionChannels as it is now: a change wasn't
   *  saved, or the file couldn't be read, copied aside or rewritten. */
  private reactionChannelsUnsaved = false;

  /** Resolved when the current connection's first featureSets/update
   *  (either form) has been processed — the signal that §5.3 policy is
   *  settled and pushes will land inside the granted window. Gates channel
   *  registration and the reconnect sweep. One per connection (serve()), so
   *  a host that connects later waits for its own policy too. */
  private policyAnswered: Promise<void>;
  private resolvePolicyAnswered!: () => void;
  /** Whether a connection has used the policy gate the constructor made. */
  private policyGateUsed = false;
  /** How long start-up waits for a host's policy before going on without
   *  it (hosts before MCPL 0.5 send none). A field so tests can shorten it. */
  private policyGraceMs = 20_000;

  /** The Discord filters plane's desired/effective/status state, shared by
   *  the whitelists and reaction suppression (issue #21) — which reactions
   *  may be shown to the model at all, across every surface. The entry
   *  point drives this instance through the startup/poller lifecycle;
   *  filtersUpdate() re-applies after its own saves. Public: index.ts
   *  feeds it. The deprecated DISCORD_SUPPRESS_REACTION_EMOJIS emergency
   *  env is the process-static compat source while a filters file lacks
   *  the key (snapshotted at construction; env changes need a restart). */
  readonly filtersState = new DiscordFiltersState();

  /** Channels the agent has explicitly MUTED: no ambient, no mention/reply wake,
   *  and no auto-subscribe-on-mention. Dropped at the top of
   *  handleDiscordMessage. Persisted to a sibling of DISCORD_SUBSCRIPTIONS_FILE
   *  (…​.muted.json), or DISCORD_MUTED_CHANNELS_FILE if set. */
  private mutedChannels = new Set<string>();
  private mutedLoaded = false;
  /** The file may not hold mutedChannels as it is now, as reactionChannelsUnsaved. */
  private mutedUnsaved = false;

  /** Per-channel watermark of the highest Discord message id forwarded to
   *  the host. Used by the auto-subscribe-on-mention flow to fetch only
   *  the backscroll Lena hasn't already seen, and by the reconnect catch-up
   *  sweep to find what arrived while the bot was offline.
   *
   *  Persisted to `DISCORD_WATERMARK_FILE` when set (alongside the set of DM
   *  channel IDs, so DMs can be swept too). When unset, it's in-memory only —
   *  resets on restart, and the catch-up sweep is effectively disabled
   *  (there's no "since when" anchor to scan from). */
  private forwardedWatermark = new Map<string, string>();
  /**
   * Messages forwarded live that the host didn't take, per Discord channel,
   * oldest first (owe). The watermark has already moved past them, so the
   * catch-up sweep never sees them again; they are delivered as a `<missed
   * reason="undelivered">` block when a connection becomes ready
   * (deliverOwed). Persisted with the watermarks.
   */
  private readonly owed = new Map<string, OwedMessage[]>();
  /** DM channel IDs we've forwarded from. Tracked (and persisted with the
   *  watermark) because discord.js can't enumerate past DM channels, so the
   *  reconnect sweep needs a remembered list of which DMs to re-scan. */
  private dmChannelIds = new Set<string>();
  /** Per-channel tally of ambient messages MISSED since the channel was last
   *  unsubscribed — answers the agent's "how much have I missed in #x since I
   *  dropped it?" via the `channel_missed` tool. Only channels with an entry
   *  here (created on unsubscribe, cleared on resubscribe) are tracked.
   *
   *  `anchorId` = the watermark at unsubscribe (the "since when" line).
   *  `talliedThrough` = message id up to which the counts are accurate (the
   *  cursor); advances on each online ambient drop and on reconnect backfill,
   *  so the tally stays exact across downtime with no double-counting.
   *  Persisted with the watermark file. */
  private missedTally = new Map<
    string,
    { anchorId: string; talliedThrough: string; messages: number; characters: number }
  >();
  private watermarkLoaded = false;
  /** Why the last watermark save failed, or null when it succeeded, so a
   *  failure is logged when it starts or changes rather than per message. */
  private watermarkSaveFailure: string | null = null;
  /** Set once the reconnect catch-up sweep has run for the current process,
   *  so it doesn't re-run if a host reconnects mid-session. */
  private sweepDone = false;

  /** Max messages to scan per channel during the reconnect catch-up sweep.
   *  Tunable via DISCORD_CATCHUP_LIMIT; clamped to [1, 10000], default 3000.
   *  discord.js paginates the REST 100/call limit transparently. A long
   *  offline gap in an active channel needs thousands scanned to surface all
   *  missed mentions — 300 was far too low (a busy 2-week gap can be >1900). */
  private get catchupLimit(): number {
    const raw = process.env.DISCORD_CATCHUP_LIMIT;
    if (!raw) return 3000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 3000;
  }

  /** How many backscroll messages to fetch on first interaction / via the
   *  history tools. Tunable via DISCORD_BACKSCROLL_LIMIT; clamped to
   *  [1, 10000], default 80 (Discord's REST limit per fetch is 100, but
   *  discord.js paginates above that — see messages.fetch). Raise it to let
   *  the agent browse deep back to old mentions. */
  private get backscrollLimit(): number {
    const raw = process.env.DISCORD_BACKSCROLL_LIMIT;
    if (!raw) return 80;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 80;
  }

  /** Inline cap for text attachments on live delivery, in bytes. A text
   *  attachment over this size is not inlined into context — the agent gets
   *  a name+size+URL note instead of a surprise multi-KB paste (issue #30).
   *  The bound is enforced on ACTUAL bytes, not just Discord's declared
   *  attachment.size (metadata can be absent or wrong — see
   *  buildAttachmentBlocks). Tunable via DISCORD_ATTACHMENT_INLINE_MAX_BYTES:
   *  0 explicitly disables text auto-inlining; any value clamps to the
   *  MAX_TEXT_BYTES (256KiB) absolute ceiling; malformed or negative values
   *  are rejected loudly and fall back to the default. Images are governed
   *  by their own path (native image blocks), not this cap. Read per call so
   *  env edits + restart apply. Default 5KiB. */
  private inlineCapWarnedFor?: string;
  private get attachmentInlineMaxBytes(): number {
    const raw = process.env.DISCORD_ATTACHMENT_INLINE_MAX_BYTES;
    if (!raw) return DEFAULT_ATTACHMENT_INLINE_MAX_BYTES;
    // Number(), not parseInt(): "5kb" should be a loud misconfiguration,
    // not a silent 5-byte cap.
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      if (this.inlineCapWarnedFor !== raw) {
        this.inlineCapWarnedFor = raw;
        console.error(
          `[discord-mcpl] DISCORD_ATTACHMENT_INLINE_MAX_BYTES=${JSON.stringify(raw)} is not a non-negative integer — using default ${DEFAULT_ATTACHMENT_INLINE_MAX_BYTES}`,
        );
      }
      return DEFAULT_ATTACHMENT_INLINE_MAX_BYTES;
    }
    return Math.min(n, MAX_TEXT_BYTES);
  }

  /** Per-channel backscroll limits: DISCORD_BACKSCROLL_CHANNELS=
   *  "<channelId>:<n>,<channelId>:<n>". For a listed channel the value
   *  overrides DISCORD_BACKSCROLL_LIMIT for first-interaction backscroll AND
   *  hard-caps agent-requested history (fetch_history / fetch_around) in that
   *  channel. Use for channels whose history the agent should only ever see a
   *  sliver of (e.g. sensitive or classifier-tripping backlogs). Unlisted
   *  channels behave as before. Parsed per call so env edits + restart apply;
   *  malformed entries are ignored. */
  private get backscrollChannelLimits(): Map<string, number> {
    const out = new Map<string, number>();
    const raw = process.env.DISCORD_BACKSCROLL_CHANNELS;
    if (!raw) return out;
    for (const part of raw.split(',')) {
      const [id, nStr] = part.trim().split(':');
      const n = parseInt(nStr ?? '', 10);
      if (id && Number.isFinite(n) && n >= 0 && n <= 10000) out.set(id, n);
    }
    return out;
  }

  /** Effective first-interaction backscroll for a channel: per-channel
   *  override when configured, else the global backscrollLimit. */
  private backscrollLimitFor(channelId: string): number {
    return this.backscrollChannelLimits.get(channelId) ?? this.backscrollLimit;
  }

  /** Cap an agent-requested history limit by the channel's configured
   *  per-channel backscroll limit. Channels without a per-channel entry are
   *  NOT capped (agent may browse freely, as before). */
  private capHistoryLimit(channelId: string, requested: number): number {
    const cap = this.backscrollChannelLimits.get(channelId);
    return cap === undefined ? requested : Math.min(requested, cap);
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
  /**
   * RFC-006 event coalescing, as advertised by THIS host at initialize
   * (`eventCoalescing: true | { pushEvents, channelsIncoming, channelScopedPush }`).
   * Null when the host does not advertise it: creates, edits and deletes then
   * go out exactly as before. Reset per connection.
   */
  private hostCoalescing: { pushEvents: boolean; channelsIncoming: boolean; channelScopedPush: boolean } | null = null;
  /**
   * What this process remembers about recent creates, so an edit or delete of
   * the same message (RFC-006: same subject) can (a) wait for an in-flight
   * create instead of overtaking it, (b) use the create's exact coalescing
   * scope rather than recomputing it after registration changed, and (c)
   * re-render with the create's context (backscroll, reply marker, location,
   * attachments) when it replaces the unread original. Bounded; a message
   * that is not remembered falls back to recomputing scope and a bare edit.
   */
  private readonly recentCreates = new Map<string, CreateMemory>();
  private editSeq = 0;
  /**
   * The waits before each resend of an occurrence whose answer leaves it
   * worth sending again (answerClass: `uncertain`, or `refused` once), as
   * the same occurrence. A resend whose wait wouldn't end by the retry
   * deadline, half the host's retry window after the first send, isn't sent.
   * A field so tests can shorten it.
   */
  private retryDelaysMs: readonly number[] = [1_000, 5_000, 30_000];
  /** The longest a resend waits for a host connection to become ready. Past
   *  it the occurrence isn't sent again: a create held longer would reach
   *  the agent long after the messages that came after it. A field so tests
   *  can shorten it. */
  private reconnectWaitMs = 60_000;
  /** The host's advertised `eventCoalescing.retryWindowMs`, if any. */
  private hostRetryWindowMs: number | undefined;
  /**
   * The connection whose start-up has settled: it initialized, its policy was
   * answered (or the grace for hosts that send none ran out), and the
   * channels were registered with it. A resend, or an edit or delete that
   * waited, goes to a connection other than the one it was first meant for
   * only once that one is ready (readyConnection).
   */
  private readyConn: McplConnection | null = null;
  /** Woken when a connection becomes ready. */
  private readonly readyWaiters = new Set<() => void>();
  /** Occurrences waiting for a host to become ready (waitForHost), and the
   *  most allowed at once: each holds its content, inline media included,
   *  while it waits. A field so tests can lower it. */
  private waitingForHost = 0;
  private maxWaitingForHost = 64;
  /** Numbers every edit and delete sent, process-wide, so no two share one. */
  private mutationSeq = 0;
  /**
   * Per message with an edit or delete still unsettled: the number of the
   * latest one sent for it, and how many are unsettled. A resend of one is
   * skipped once a later one has gone out: the later occurrence replaces or
   * withdraws the subject, and resending the earlier one after it would put
   * the older version back. An entry lives exactly as long as one of its
   * message's mutations is unsettled, so the one being judged always finds
   * it; that bounds the map by the mutations in flight or being retried.
   */
  private readonly mutationsInFlight = new Map<string, { latest: number; unsettled: number }>();
  private enabledFeatureSets = new Set<string>();
  /** Every channel registered in this process, whether or not a host is
   *  connected: each connection is given all of it (syncChannelsWithHost). */
  private channelManager = new ChannelManager();
  /** Channels forgotten while no host was connected, which the next
   *  connection's sync announces as removed. */
  private unannouncedRemovals = new Set<string>();
  /** Discord channels and threads deleted lately, oldest first, at most
   *  DELETED_CHANNELS_KEPT: a message, an edit or the reconnect sweep can
   *  still be on its way from one when it goes, and must not register it
   *  again (registerGuildDelivery). Snowflakes aren't reused, so an id here
   *  stays true. */
  private deletedChannels = new Set<string>();
  private stateTracker = new StateTracker();
  /** Buffers for channels/outgoing/chunk streams, keyed by inferenceId */

  constructor(
    private discord: DiscordAdapter,
    /** Voice output (Spec 14.3 consumer). Null = voice not configured; the
     *  handshake then declares no channels.streaming and the host streams
     *  nothing here. */
    private voice: import('./voice.js').VoiceOutput | null = null,
  ) {
    this.policyAnswered = new Promise((resolve) => {
      this.resolvePolicyAnswered = resolve;
    });
    // Physics accounting → the model. An utterance that was cut off (human
    // barge-in, bot collision yield) or truncated (TTS died mid-stream) left
    // the model believing it said things the room never heard. Push the
    // voiced/unvoiced split so its beliefs match the channel's reality.
    // Fully-voiced utterances are silence — no news is good news.
    this.voice?.onReport((r) => this.handleVoiceReport(r));
  }

  private handleVoiceReport(r: import('./voice.js').UtteranceReport): void {
    if (!this.conn || !this.mcplEnabled) return;
    if (r.status === 'spoken' && r.unvoicedText.length === 0) return;
    const interrupted = r.status === 'interrupted';
    const expired = r.status === 'expired';
    const failed = r.status === 'failed';
    const secs = (r.playedMs / 1000).toFixed(1);
    const who = r.interruptedBy
      ? `@${r.interruptedBy.username ?? r.interruptedBy.userId}${r.interruptedBy.bot ? ' (bot)' : ''}`
      : null;
    // The model has its full text; what it needs is the BOUNDARY. Short
    // voiced tail for orientation, capped unvoiced head for the loss.
    const tail = r.voicedText.length > 120 ? `…${r.voicedText.slice(-120)}` : r.voicedText;
    const head = r.unvoicedText.length > 400 ? `${r.unvoicedText.slice(0, 400)}…` : r.unvoicedText;
    const approx = r.estimated ? ' (boundary approximate)' : '';
    // A reply still streaming when its utterance ended short isn't voiced
    // past that point either: say so, so the model re-decides all of it.
    const rest = r.restUnvoiced ? '\nWhat you went on to say in that reply wasn\'t voiced either.' : '';
    const line = expired
      ? `[voice] Your spoken message waited ${(r.queuedMs / 1000).toFixed(0)}s for the channel to clear and was dropped UNSPOKEN — nothing was heard (and nothing was billed).\n` +
        `Not said: "${head}"\n(The text was still delivered in the text channel as usual. Say it again — possibly shorter — only if it still needs saying.)`
      : interrupted
        ? `[voice] Your spoken message was interrupted by ${who} after ${secs}s${approx}.\n` +
          `Heard up to: "${tail}"\nNOT heard: "${head}"` + rest
        : failed
          ? // Part of it played: it was stopped, for the reason given (the
            // limit on one reply, say). Nothing played: it couldn't be.
            (r.playedMs > 0
              ? `[voice] Your spoken message was stopped after ${secs}s${approx} (${r.failure ?? 'playback failed'}).\n`
              : `[voice] Your spoken message couldn't be played (${r.failure ?? 'playback failed'}) — nothing was heard.\n`) +
            // A line whose text is empty is left out rather than quoted empty.
            (r.playedMs > 0 && tail ? `Heard up to: "${tail}"\n` : '') +
            (head ? `NOT heard: "${head}"\n` : '') +
            (rest ? `${rest.slice(1)}\n` : '') +
            '(The text was still delivered in the text channel as usual.)'
        : `[voice] Your spoken message was cut short by a synthesis error after ${secs}s${approx}.\n` +
          `Heard up to: "${tail}"\nNOT heard: "${head}"\n(The text was still delivered in the text channel as usual.)`;
    this.conn.sendRequest(method.PUSH_EVENT, {
      featureSet: 'discord.messaging',
      eventId: `discord_voice_${r.status}_${r.inferenceId}`,
      timestamp: new Date().toISOString(),
      origin: {
        source: 'discord',
        mcplChannelId: r.channelId,
        inferenceId: r.inferenceId,
        playedMs: r.playedMs,
        queuedMs: r.queuedMs,
        billedChars: r.billedChars,
        estimated: r.estimated,
        ...(r.interruptedBy ? {
          interruptedById: r.interruptedBy.userId,
          interruptedByName: r.interruptedBy.username,
          interruptedByBot: r.interruptedBy.bot,
        } : {}),
      } as Record<string, unknown>,
      // RFC-001 tags: hosts route/gate on these. The wake rule is
      // ball-in-your-court: 'voice:interrupted' and 'voice:expired' both
      // leave the model with a decision only it can make (someone grabbed
      // the floor mid-sentence / your words were never said — re-decide),
      // so hosts should gate them WAKING, like a reply. 'voice:truncated'
      // is context: the text landed in the text channel, nothing to decide.
      // Third-party speech while recently-engaged (the engagement-window
      // rule) is the floor/gate layer's job, not this transport's.
      // 'voice:failed' is context too, like 'voice:truncated': the text
      // landed in the text channel. The model sees it on its next turn (the
      // next person to speak wakes it), and can say the line again then if it
      // still needs saying. Some causes pass (a slow start, the limit on one
      // reply), so it isn't an operator's fault to fix each time.
      tags: [expired ? 'voice:expired' : interrupted ? 'voice:interrupted' : failed ? 'voice:failed' : 'voice:truncated'],
      payload: { content: [textContent(line)] },
    } satisfies PushEventParams).catch(() => {});
  }

  /**
   * Register slash commands with Discord and wire the interaction handler.
   * Call once after the Discord client is ready (before or after serve()).
   *
   * `/undo [turns]` — admin-gated (DISCORD_ADMIN_USERS): asks the host to
   * revert the agent's last N turns via the `host/command` MCPL method, then
   * posts what the agent now sees as its latest context message.
   *
   * `/nudge` — admin-gated: asks the host to run inference on the agent's
   * current context with no new events (ephemeral reply — see
   * handleNudgeCommand).
   */
  async setupSlashCommands(): Promise<void> {
    this.discord.onSlashCommand((interaction) => {
      // Dispatched without awaiting, so a handler's rejection would be
      // unhandled — and on Node ≥ 15 an unhandled rejection ends the
      // process. Discord rejects a late reply ("Unknown interaction" once
      // its 3-second acknowledgment window has passed), so this must never
      // take the server down with it.
      void this.handleSlashCommand(interaction).catch((err) => {
        console.error(
          `[discord-mcpl] /${interaction.commandName} failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    });
    await this.discord.registerGuildCommands([
      {
        name: 'undo',
        description: "Undo the agent's last turn(s) — admin only",
        options: [
          {
            type: 4, // INTEGER
            name: 'messages',
            description: 'Number of context messages to remove (any participant; default 1)',
            required: false,
            min_value: 1,
            max_value: 50,
          },
          MARKS_OPTION,
        ],
      },
      {
        name: 'hide',
        description: 'Remove a message (or range) from the agent context by link — admin only',
        options: [
          {
            type: 3, // STRING
            name: 'message',
            description: 'Message link (or ID) to remove',
            required: true,
          },
          {
            type: 3, // STRING
            name: 'to',
            description: 'End of range: a second message link/ID (inclusive)',
            required: false,
          },
          HIDE_MARKS_OPTION,
        ],
      },
      {
        name: 'marks',
        description: "The host's 💤 awareness marks: list, cancel or retract — admin only",
        options: [
          {
            type: 3, // STRING
            name: 'action',
            description: 'What to do',
            required: true,
            choices: [
              { name: 'list', value: 'list' },
              { name: 'cancel', value: 'cancel' },
              { name: 'retract', value: 'retract' },
            ],
          },
          {
            type: 3, // STRING
            name: 'target',
            description: 'A batch or retract id (list: show it in full); retract also takes "all"',
            required: false,
          },
          {
            type: 4, // INTEGER
            name: 'page',
            description: 'list: which page of the ledger (newest first; default 1)',
            required: false,
            min_value: 1,
          },
        ],
      },
      {
        name: 'nudge',
        description: 'Run the agent on its current context — no new events — admin only',
      },
      {
        name: 'unstick',
        description: 'Rewind blocked turns and re-run until the model stops refusing — admin only',
        options: [
          {
            type: 4, // INTEGER
            name: 'max',
            description: 'Max rewind/retry attempts (default 3)',
            required: false,
            min_value: 1,
            max_value: 10,
          },
        ],
      },
    ]);
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.commandName !== 'undo' &&
      interaction.commandName !== 'hide' &&
      interaction.commandName !== 'unstick' &&
      interaction.commandName !== 'nudge' &&
      interaction.commandName !== 'marks'
    ) {
      await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const admins = (process.env.DISCORD_ADMIN_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!admins.includes(interaction.user.id)) {
      dbg('slash:unauthorized', { command: interaction.commandName, userId: interaction.user.id });
      await interaction.reply({ content: `Not authorized to use /${interaction.commandName}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === 'hide') {
      await this.handleHideCommand(interaction);
      return;
    }

    if (interaction.commandName === 'unstick') {
      await this.handleUnstickCommand(interaction);
      return;
    }

    if (interaction.commandName === 'nudge') {
      await this.handleNudgeCommand(interaction);
      return;
    }

    if (interaction.commandName === 'marks') {
      await this.handleMarksCommand(interaction);
      return;
    }

    const messages = interaction.options.getInteger('messages') ?? 1;
    const marks = readMarksChoice(interaction);
    const marksChosen = marks === 'addressed' || marks === 'all';
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot undo.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:undo', { messages, marks, userId: interaction.user.id, channelId: interaction.channelId });
    // Public reply: the channel should see that history was rewound.
    await interaction.deferReply();

    // A host whose undo can't take a marks choice places 💤 marks that follow
    // branches — re-applied on every switch, with no frozen audience and no
    // cancel. No option here can authorize that as the one-shot act it names,
    // so such a host is refused outright.
    const support = await this.hostMarksSupport(conn);
    if (support !== true) {
      await this.acknowledge(interaction, boundedReply(support === false
        ? "⚠️ Undo refused: this host can't make awareness marks a choice — its undo places 💤 marks that " +
          'follow branches. Upgrade the host (an agent framework with the `marks` host command) to undo from Discord.'
        : `⚠️ Undo not sent: couldn't learn whether this host makes awareness marks a choice (${support.reason}). ` +
          `Nothing was changed. ${PROBE_AGAIN}`));
      return;
    }

    let result: unknown;
    try {
      result = await conn.sendRequest(
        'host/command',
        {
          command: 'undo',
          messages,
          ...(marks ? { marks } : {}),
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      );
    } catch (err) {
      // The request may have reached the host before this failed: what it
      // did is unknown, not undone.
      dbg('slash:undo-failed', { error: errorText(err) });
      await this.acknowledge(
        interaction,
        boundedReply(surgeryOutcomeUnknown('Undo', marksChosen, errorText(err))),
        surgeryOutcomeUnknown('Undo', marksChosen),
      );
      return;
    }

    // Only `ok: false` is the host's refusal. An answer without a boolean
    // `ok` may still have been applied, so it's shown as sent, never as a failure.
    const answer: Record<string, unknown> = isJsonObject(result) ? result : {};
    if (answer.ok === false) {
      await this.acknowledge(interaction, boundedReply(hostRefusal('Undo', answer), answer));
      return;
    }
    if (answer.ok !== true) {
      await this.acknowledge(
        interaction,
        boundedReply(unreadableSurgery('undo', result, marksChosen), result),
        surgeryOutcomeUnknown('Undo', marksChosen),
      );
      return;
    }

    // The undo is applied, so a reply always goes out: each field is read
    // only once its type is checked, and a reply that can't be shown never
    // reads as the undo's failure.
    const removed = hostCount(answer.messagesRemoved);
    const lines = [
      removed === undefined
        ? '🗑️ Undo applied (branched; old branch preserved); the number of context messages removed was not given.'
        : `🗑️ Removed the last **${removed}** context message${removed === 1 ? '' : 's'} (branched; old branch preserved).`,
      describeMarkers(answer.markers),
      ...lastVisibleLines(answer.lastVisible, '(Could not render the post-undo context preview.)'),
    ];
    await this.acknowledge(
      interaction,
      boundedReply(lines.join('\n'), result),
      `🗑️ Undo applied: ${removed === undefined ? 'the number of context messages removed was not given' : `removed ${removed} context message${removed === 1 ? '' : 's'}`}. ` +
        summarizeMarkers(answer.markers),
    );
  }

  /**
   * Show a command's reply. If Discord refuses it, say so, leading with
   * `outcome`: the short account of an operation that did happen, or whose
   * outcome is unknown. Either makes a blind retry wrong, so neither is lost
   * with its reply, and an applied operation is never misreported as a
   * failure to show its acknowledgment. Refusals, failures and reads, which
   * a retry can't repeat unawares, pass none.
   */
  private async acknowledge(
    interaction: ChatInputCommandInteraction,
    reply: BoundedReply,
    outcome?: string,
  ): Promise<void> {
    try {
      await interaction.editReply(reply);
    } catch (err) {
      dbg('slash:reply-failed', { error: errorText(err) });
      try {
        await interaction.editReply(boundedReply(
          `${outcome ? `${outcome} ` : ''}(The full reply couldn't be shown: ${errorText(err)}.)`,
        ));
      } catch (again) {
        // Nothing reached the operator. What the command did, or may have
        // done, still mustn't vanish: stderr keeps it.
        console.error(
          `[discord-mcpl] /${interaction.commandName}: Discord refused its reply twice (${errorText(again)})` +
            (outcome ? `, so the operator wasn't told: ${outcome}` : '.'),
        );
      }
    }
  }

  /**
   * Does the connected host make 💤 awareness marks a choice? Asked for each
   * command that depends on the answer, with a `marks` request that names no
   * action, so the host reads nothing to answer it. agent-framework answers
   * a verb it lacks with "Unknown host command" (at every revision checked,
   * from 2ea26ffea, where host/command arrived, to #250's 915ad4be); a host
   * with the verb answers anything else (agent-framework#250 refuses the
   * missing action). A request that fails (a timeout, a host that
   * refuses host commands outright) settles nothing, and the command stops
   * with nothing changed.
   */
  private async hostMarksSupport(conn: McplConnection): Promise<boolean | { reason: string }> {
    let answer: unknown;
    try {
      answer = await conn.sendRequest('host/command', { command: 'marks' }, 15000);
    } catch (err) {
      return { reason: errorText(err) };
    }
    const error = isJsonObject(answer) && typeof answer.error === 'string' ? answer.error : '';
    const supported = !/unknown host command/i.test(error);
    dbg('slash:marks-support', { supported });
    return supported;
  }

  /**
   * `/marks action:list [target] [page]` and `/marks action:cancel|retract target` — the
   * awareness ledger's operator controls (agent-framework `host/command`
   * `marks`). list shows the ledger newest first, a page at a time, or one
   * entry in full by its id; cancel and retract each answer with what the
   * host's receipt says. Every reply fits one Discord
   * message: a longer one is cut visibly with the full answer attached.
   * Ephemeral: the marks themselves are the public part.
   */
  private async handleMarksCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const action = interaction.options.getString('action', true);
    const target = interaction.options.getString('target')?.trim() || undefined;
    const page = interaction.options.getInteger('page') ?? 1;
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action !== 'list' && !target) {
      await interaction.reply({
        content: action === 'retract'
          ? '`/marks action:retract` needs a target: a batch id, or `all`.'
          : '`/marks action:cancel` needs a target: a batch id or a retract request id.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    dbg('slash:marks', { action, target, userId: interaction.user.id });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const support = await this.hostMarksSupport(conn);
    if (support !== true) {
      await this.acknowledge(interaction, boundedReply(support === false
        ? "This host doesn't have awareness-mark controls (no `marks` host command). Upgrade the host to use `/marks`."
        : `Couldn't learn whether this host has awareness-mark controls (${support.reason}). Nothing was sent. ${PROBE_AGAIN}`));
      return;
    }
    let result: unknown;
    try {
      result = await conn.sendRequest(
        'host/command',
        {
          command: 'marks',
          action,
          // list's target picks an entry here; the host lists everything.
          ...(target && action !== 'list' ? { target } : {}),
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      );
    } catch (err) {
      dbg('slash:marks-failed', { action, error: errorText(err) });
      // A read that failed changed nothing. A control may have reached the
      // host first: its outcome is unknown, never "failed".
      if (action === 'list') {
        await this.acknowledge(interaction, boundedReply(`⚠️ /marks action:list failed: ${errorText(err)}`));
      } else {
        await this.acknowledge(
          interaction,
          boundedReply(controlOutcomeUnknown(action, target, errorText(err))),
          controlOutcomeUnknown(action, target),
        );
      }
      return;
    }
    // Only `ok: false` is the host's refusal. Any other answer without a
    // boolean `ok` is shown as sent: a control may have been applied.
    const response: Record<string, unknown> = isJsonObject(result) ? result : {};
    if (response.ok === false) {
      await this.acknowledge(interaction, boundedReply(hostRefusal(`/marks action:${action}`, response), response));
      return;
    }
    if (response.ok !== true) {
      if (action === 'list') {
        await this.acknowledge(interaction, boundedReply(unreadable('/marks action:list', result), result));
      } else {
        await this.acknowledge(
          interaction,
          boundedReply(unreadableControl(action, target, result), result),
          controlOutcomeUnknown(action, target),
        );
      }
      return;
    }
    // An accepted answer that left out its ledger or receipt is shown whole,
    // never as "undefined".
    const whole = response.awareness === undefined;
    const answer = whole ? result : response.awareness;
    if (action === 'list') {
      const views = Array.isArray(answer) && answer.every(isView) ? answer : null;
      if (!views) {
        await this.acknowledge(interaction, boundedReply(unreadable(whole ? '/marks action:list' : 'the ledger', answer), answer));
        return;
      }
      if (target) {
        const shown = views.filter((v) => v.id === target);
        await this.acknowledge(interaction, boundedReply(renderEntry(views, target), shown.length ? shown : undefined));
        return;
      }
      await this.acknowledge(interaction, renderListPage(views, page));
      return;
    }
    const text = action === 'cancel' && isCancelReceipt(answer)
      ? describeCancel(answer)
      : action === 'retract' && isRetractReceipt(answer)
        ? describeRetract(answer)
        : unreadable(`/marks action:${action}`, answer);
    // The control is accepted: a reply that can't be shown still says what was requested.
    await this.acknowledge(interaction, boundedReply(text, answer), summarizeControl(action, target, answer));
  }

  /**
   * Parse a Discord message link or raw ID into a message id.
   * Accepts:
   *   https://discord.com/channels/<guild>/<channel>/<messageId>
   *   <channel>-<messageId>  (the "Copy ID" with shift on some clients)
   *   a bare 17–20 digit snowflake
   */
  private parseMessageRef(input: string): string | null {
    const s = input.trim();
    const link = s.match(/channels\/\d+\/\d+\/(\d+)/);
    if (link) return link[1];
    const dashed = s.match(/^\d+-(\d+)$/);
    if (dashed) return dashed[1];
    if (/^\d{17,20}$/.test(s)) return s;
    return null;
  }

  private async handleHideCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const fromRaw = interaction.options.getString('message', true);
    const toRaw = interaction.options.getString('to');
    const fromMessageId = this.parseMessageRef(fromRaw);
    if (!fromMessageId) {
      await interaction.reply({
        content: `Could not parse a message link/ID from \`${fromRaw}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    let toMessageId: string | undefined;
    if (toRaw) {
      const parsed = this.parseMessageRef(toRaw);
      if (!parsed) {
        await interaction.reply({ content: `Could not parse \`${toRaw}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }
      toMessageId = parsed;
    }

    // A hide's 💤 is this server's own: the host places none for a hide and
    // refuses a choice there, so the request carries none, on any host.
    const marking = readMarksChoice(interaction) === 'all';
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot hide.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:hide', { fromMessageId, toMessageId, marking, userId: interaction.user.id });
    await interaction.deferReply();

    let result: unknown;
    try {
      result = await conn.sendRequest(
        'host/command',
        {
          command: 'hide',
          fromMessageId,
          toMessageId,
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      );
    } catch (err) {
      dbg('slash:hide-failed', { error: errorText(err) });
      await this.acknowledge(
        interaction,
        boundedReply(surgeryOutcomeUnknown('Hide', false, errorText(err)) + (marking ? `\n${HIDE_MARKS_NOT_ADDED}` : '')),
        surgeryOutcomeUnknown('Hide', false) + (marking ? ` ${HIDE_MARKS_NOT_ADDED}` : ''),
      );
      return;
    }

    // Only `ok: false` is the host's refusal. An answer without a boolean
    // `ok` may still have been applied, so it's shown as sent, never as a failure.
    const answer: Record<string, unknown> = isJsonObject(result) ? result : {};
    if (answer.ok === false) {
      await this.acknowledge(interaction, boundedReply(hostRefusal('Hide', answer), answer));
      return;
    }
    if (answer.ok !== true) {
      await this.acknowledge(
        interaction,
        boundedReply(unreadableSurgery('hide', result, false, marking ? HIDE_MARKS_NOT_ADDED : undefined), result),
        surgeryOutcomeUnknown('Hide', false) + (marking ? ` ${HIDE_MARKS_NOT_ADDED}` : ''),
      );
      return;
    }

    // The hide is applied, so a reply always goes out, and at once: the 💤
    // follow, and the reply is edited with what Discord confirmed. Each field
    // is read only once its type is checked, and a reply that can't be shown
    // never reads as the hide's failure.
    const n = hostCount(answer.hidden);
    const reply = (marks: string | undefined): string => [
      n === undefined
        ? "🙈 Hide applied (redacted in place); the number of messages removed from the agent's context was not given."
        : `🙈 Removed **${n}** message${n === 1 ? '' : 's'} from the agent's context (redacted in place).`,
      ...(marks ? [marks] : []),
      ...lastVisibleLines(answer.lastVisible),
    ].join('\n');
    const short = (marks: string | undefined): string =>
      `🙈 Hide applied: ${n === undefined ? 'the number of messages removed was not given' : `removed ${n} message${n === 1 ? '' : 's'} from the agent's context`}.` +
        (marks ? ` ${marks}` : '');
    const refs = marking ? readHiddenRefs(answer.hiddenRefs) : undefined;
    const first = refs === undefined ? undefined : hideMarksAt(refs);
    await this.acknowledge(interaction, boundedReply(reply(first), result), short(first));
    if (!Array.isArray(refs) || refs.length === 0) return;
    const marks = await this.markHidden(refs);
    await this.acknowledge(interaction, boundedReply(reply(marks), result), short(marks));
  }

  /**
   * A chosen /hide's 💤, added by this server to each message the host says
   * it hid, as every /hide did before the choice. Best-effort and in
   * parallel: discord.js's REST queue sends one channel's reaction requests
   * one at a time, within Discord's limits. Only what Discord confirmed is
   * counted, since a request that failed may still have landed. The marks
   * are outside the host's awareness ledger, which the line says.
   */
  private async markHidden(refs: HiddenRef[]): Promise<string> {
    let confirmed = 0;
    let firstError: string | undefined;
    await Promise.all(refs.map(async (ref) => {
      // channelId may be raw or the "discord:guild:channel" composite.
      const parsed = parseMcplChannelId(ref.channelId);
      try {
        await this.discord.addReaction(parsed ? parsed.channelId : ref.channelId, ref.messageId, '💤');
        confirmed++;
      } catch (err) {
        firstError ??= errorText(err);
        dbg('slash:hide-react-failed', { messageId: ref.messageId, error: errorText(err) });
      }
    }));
    return describeHideMarks(confirmed, refs.length, firstError);
  }

  /**
   * `/unstick [max]` — admin-gated. Asks the host to force the refusal-rewind
   * loop: redact the turn that fed the refusal and re-run the model, up to
   * `max` times, until it stops refusing. Commits to real inference runs, so
   * the host only ACKs here (started) and posts the outcome — what was shed and
   * whether it cleared — to this channel when the chain resolves.
   */
  private async handleUnstickCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const max = interaction.options.getInteger('max') ?? undefined;
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot unstick.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:unstick', { max, userId: interaction.user.id, channelId: interaction.channelId });
    await interaction.deferReply();

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'unstick',
          maxRewinds: max,
          channelId: interaction.channelId,
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as { ok?: boolean; error?: string; started?: boolean; cap?: number };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Unstick failed: ${result?.error ?? 'unknown error'}`);
        return;
      }
      await interaction.editReply(
        `🔧 Unsticking the agent — rewinding blocked turn(s) and re-running ` +
          `(up to **${result.cap ?? max ?? 3}**). I'll post the result here.`,
      );
    } catch (err) {
      dbg('slash:unstick-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Unstick failed: ${(err as Error).message}`);
    }
  }

  /**
   * `/nudge` — ask the host to run an inference turn on the agent's CURRENT
   * context with no new events. The reply is EPHEMERAL by design: a visible
   * channel message would itself be a new event, defeating the command's
   * whole point (and the wake would then be "about" the confirmation).
   */
  private async handleNudgeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const conn = this.conn;
    if (!conn) {
      await interaction.reply({ content: 'Host is not connected — cannot nudge.', flags: MessageFlags.Ephemeral });
      return;
    }

    dbg('slash:nudge', { userId: interaction.user.id, channelId: interaction.channelId });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = (await conn.sendRequest(
        'host/command',
        {
          command: 'nudge',
          requesterId: interaction.user.id,
          requesterName: interaction.user.username,
        },
        30000,
      )) as { ok?: boolean; error?: string; agentStatus?: string };

      if (!result?.ok) {
        await interaction.editReply(`⚠️ Nudge failed: ${result?.error ?? 'unknown error'}`);
        return;
      }
      const when = result.agentStatus === 'idle'
        ? 'running now'
        : `queued behind the current turn (agent is ${result.agentStatus ?? 'busy'})`;
      await interaction.editReply(
        `👉 Nudged — the agent takes a turn on its current context, no new events (${when}).`,
      );
    } catch (err) {
      dbg('slash:nudge-failed', { error: (err as Error).message });
      await interaction.editReply(`⚠️ Nudge failed: ${(err as Error).message}`);
    }
  }

  /**
   * Serve a single connection. Blocks until the connection closes.
   * The Discord adapter should already be connected before calling this.
   */
  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    this.readyConn = null;
    // This connection's own policy gate (the first connection's is the one
    // the constructor made).
    if (this.policyGateUsed) {
      this.policyAnswered = new Promise((resolve) => { this.resolvePolicyAnswered = resolve; });
    }
    this.policyGateUsed = true;

    // The connection emits 'error' for a line that isn't JSON, and for an
    // error on either stream. With no listener, EventEmitter throws it from
    // the stream's own callback, where nothing here can catch it, and the
    // process exits. Logged instead, so a bad line costs only itself and the
    // loop reads on. The listener stays for the connection's whole life,
    // after serve() returns too: mcpl-core 0.2 and 0.3 forward its streams'
    // errors to it for as long as they exist. (mcpl-core-ts #11 stops at the
    // close, so there the late listener costs nothing.) A read error, on a
    // TCP socket or on stdin, also reaches mcpl-core's own readline
    // interface, which listens for none, so it still ends the process. That
    // is mcpl-core's to handle.
    const onConnectionError = (err: unknown) => {
      console.error('[discord-mcpl] Connection error:', errorText(err));
      dbg('connection:error', { error: errorText(err) });
    };
    conn.on('error', onConnectionError);

    // Reaction suppression is opt-in; say plainly when it isn't on rather
    // than letting an unset config read as safety. "Configured but empty"
    // gets the same plain-speaking: the mechanism being wired is not the
    // same thing as a reaction being suppressed. A legacy-env source works
    // but is deprecated — one line, counts and digests only, never glyphs.
    const rs = this.filtersState.suppressionStatus();
    if (rs.status === 'not-configured') {
      console.error(
        '[discord-mcpl] reaction-suppression: not configured (no suppressedReactionEmojis in the filters file, ' +
          'no DISCORD_SUPPRESS_REACTION_EMOJIS) — reaction suppression NOT active',
      );
    } else if (rs.status === 'configured-empty') {
      console.error(
        '[discord-mcpl] reaction-suppression: suppressedReactionEmojis is present but EMPTY — mechanism wired, NO reactions suppressed',
      );
    } else if (rs.source === 'legacy-env') {
      console.error(
        `[discord-mcpl] reaction-suppression: running on DEPRECATED DISCORD_SUPPRESS_REACTION_EMOJIS (${rs.effectiveCount} entries, ` +
          'process-static — changing it needs a restart) — move the entries into the filters file suppressedReactionEmojis key ' +
          'and unset the env (alias retires per issue #16)',
      );
    } else if (rs.source === 'baseline-default') {
      console.error(
        `[discord-mcpl] reaction-suppression: host-injected protective baseline in force (${rs.effectiveCount} entries, ` +
          'no operator configuration present) — an explicit suppressedReactionEmojis key in the filters file overrides it',
      );
    } else if (rs.status === 'unavailable') {
      console.error(
        '[discord-mcpl] reaction-suppression: filters file is configured but unreadable and no usable set was ever loaded — ' +
          'ALL model-visible reactions are withheld until the file is repaired',
      );
    }

    // Set up Discord event forwarding
    this.setupDiscordForwarding();

    try {
      // Handshake. A client that leaves before initialize ends this
      // connection and not the process: the TCP transport goes on to serve
      // the next client. The start-up work below starts only once initialize
      // is answered.
      await this.handleInitialize();

      // ORDERING (Mythos 0.5-canary find, two rounds): NOTHING may run between
      // initialize and the main loop. A 0.5 host sends its §5.3 initial policy
      // as a featureSets/update REQUEST right after initialize with a 15s
      // timeout; until the loop reads, that request sits unanswered. Round 1:
      // the reconnect sweep blocked the loop → timeout → deny-until-policy.
      // Round 2: channel registration still ran pre-loop, and its own
      // server→host Request is itself REJECTED by the host until policy is
      // established (-32002 after ~15s) — a clean cross-request deadlock; the
      // policy answer landed ~600ms after the host gave up. So channel
      // registration AND the sweep both run concurrently with the loop, gated
      // on the policy being answered (20s grace covers pre-0.5 hosts that
      // never send the Request form), registration strictly before the sweep
      // so pushes land on registered channels inside the granted window.
      void (async () => {
        await Promise.race([
          this.policyAnswered,
          // unref: a pending grace timer must never hold the process open
          // (it made the test runner appear to hang for 20s per server).
          new Promise((r) => {
            const t = setTimeout(r, this.policyGraceMs);
            (t as { unref?: () => void }).unref?.();
          }),
        ]);
        // A connection that has been replaced meanwhile has nothing left to
        // start: the one that replaced it has its own gate and start-up, and
        // this one must not register channels with it before its policy.
        if (this.conn !== conn) return;
        if (this.mcplEnabled) {
          try {
            await this.syncChannelsWithHost();
          } catch (err) {
            console.error('[discord-mcpl] Channel registration failed:', errorText(err));
          }
        }
        this.markReady(conn);
        // What the last host didn't take (owe), now that this one is ready,
        // alongside the sweep rather than ahead of it.
        void this.deliverOwed(conn).catch((err) => {
          console.error('[discord-mcpl] Delivering owed messages failed:', errorText(err));
        });
        // Deliver anything that arrived while the bot was offline (mentions +
        // DMs everywhere, full missed backscroll for subscribed channels).
        // Best-effort and one-shot; failures must not block serving.
        try {
          await this.runReconnectSweep();
        } catch (err) {
          console.error('[discord-mcpl] Reconnect catch-up sweep failed:', errorText(err));
        }
      })().catch((err) => {
        // Nothing above should reach here; if anything does, an unhandled
        // rejection would end the process.
        console.error('[discord-mcpl] Background start-up work failed:', errorText(err));
      });

      // Main loop
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          // handleRequest answers its own errors. A failure in answering must
          // not end this loop either, or every later request goes unread.
          try {
            await this.handleRequest(msg.request);
          } catch (err) {
            console.error(`[discord-mcpl] request ${msg.request.method} was not answered:`, err);
            dbg('handleRequest:unanswered', { method: msg.request.method, error: errorText(err) });
          }
        } else {
          // A notification has no reply to carry an error, and one whose
          // handler throws synchronously must not end this loop: every later
          // request would go unread, and the host would wait each one out as
          // unconfirmed. This catches synchronous throws only: a promise a
          // handler starts has to settle its own errors.
          try {
            this.handleNotification(msg.notification);
          } catch (err) {
            console.error(
              `[discord-mcpl] notification ${msg.notification.method} failed:`,
              err,
            );
            dbg('handleNotification:error', {
              method: msg.notification.method,
              error: errorText(err),
              stack: err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined,
            });
          }
        }
      }
    } catch (err) {
      // stderr, like every log line here: on the stdio transport, stdout is
      // the protocol channel, and a line there that isn't JSON is an error
      // to the host.
      if ((err as { name?: unknown } | null | undefined)?.name === 'ConnectionClosedError') {
        console.error('[discord-mcpl] Client disconnected');
      } else {
        console.error('[discord-mcpl] Connection error:', err);
      }
    } finally {
      // serve() owns the connection, so whatever ended it, it ends the
      // connection too: an unexpected throw releases the client rather than
      // leave its socket open. Closing an already closed connection is a
      // no-op.
      this.conn = null;
      this.readyConn = null;
      conn.close();
    }
  }

  // ── Initialize Handshake ──

  /** Answer the initialize request. Until it comes, nothing a client sends
   *  ends the session: a ping is answered (MCP lets a client ping before
   *  initialize), any other request is answered with an error, and a
   *  notification is dropped with a log line. Rejects with
   *  ConnectionClosedError when the client leaves first. Nothing after
   *  initialize is read here: notifications/initialized, and anything a host
   *  sends before it, go through the main loop like every message. */
  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;

    let msg = await conn.nextMessage();
    while (msg.type !== 'request' || msg.request.method !== 'initialize') {
      if (msg.type === 'notification') {
        console.error(`[discord-mcpl] ${msg.notification.method} before initialize: dropped`);
      } else if (msg.request.method === 'ping') {
        conn.sendResponse(msg.request.id, {});
      } else {
        console.error(`[discord-mcpl] ${msg.request.method} before initialize: refused`);
        conn.sendError(msg.request.id, -32002, `Server not initialized: send initialize before ${msg.request.method}`);
      }
      msg = await conn.nextMessage();
    }

    const params = msg.request.params as McplInitializeParams | undefined;

    // Detect MCPL support
    const clientMcpl = params?.capabilities?.experimental?.mcpl;
    this.mcplEnabled = clientMcpl !== undefined;
    this.hostCoalescing = parseHostCoalescing((clientMcpl as { eventCoalescing?: unknown } | undefined)?.eventCoalescing);
    this.hostRetryWindowMs = advertisedRetryWindowMs((clientMcpl as { eventCoalescing?: unknown } | undefined)?.eventCoalescing);
    dbg('handleInitialize', {
      mcplEnabled: this.mcplEnabled,
      clientName: params?.clientInfo?.name,
      clientMcpl: clientMcpl ? 'present' : 'absent',
    });

    // Build server capabilities
    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      // Object form (MCPL spec McplChannelCapabilities) when voice is enabled:
      // `streaming: true` opts this server into the host's routed outgoing
      // deltas (channels/outgoing/chunk, Spec 14.3) — the input to voice
      // synthesis. Without voice we keep the legacy boolean: the host then
      // streams nothing here, which is exactly right. (mcpl-core's type lags
      // the spec's object form, hence the cast.)
      channels: (this.voice ? { register: true, publish: true, streaming: true } : true) as unknown as boolean,
      rollback: true,
      // Legacy array form on the wire, unchanged (see NamedFeatureSetDeclaration
      // in feature-sets.ts — digest-stable, host-normalized).
      featureSets: featureSets as unknown as McplCapabilities['featureSets'],
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
      serverInfo: { name: 'discord-mcpl', version: packageJson.version },
    };

    // In MCPL mode, default all feature sets to enabled, before the host can
    // send anything that reads or changes them.
    if (this.mcplEnabled) {
      for (const fs of featureSets) {
        this.enabledFeatureSets.add(fs.name);
      }
    }

    conn.sendResponse(msg.request.id, result);
  }

  // ── Request Dispatch ──

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'ping': {
          // MCP: the receiver answers a ping promptly, with an empty result.
          conn.sendResponse(req.id, {});
          break;
        }

        case 'tools/list': {
          // Each tool carries its MCPL RFC-008 classes in _meta["mcpl/class"].
          conn.sendResponse(req.id, { tools: toolDefinitions.map(withToolClasses) });
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
          const openP = params as unknown as ChannelOpenRequest;
          const result = await this.handleChannelOpen(openP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_CLOSE: {
          const closeP = params as unknown as ChannelsCloseParams;
          const result = this.handleChannelClose(closeP);
          conn.sendResponse(req.id, result);
          break;
        }

        case 'channels/acknowledge': {
          const ack = params as unknown as ChannelAcknowledgeRequest;
          const result = await this.handleChannelAcknowledge(ack);
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

        case method.FEATURE_SETS_UPDATE: {
          // §5.3/§6.7 Request form — the host's policy update, awaiting a
          // degradation receipt. Pre-0.5 this method was notification-only
          // here; a 0.5 host's initial policy Request then timed out and the
          // whole MCPL surface stayed deny-until-policy (Mythos canary).
          // Everything this server declares runs on plain tool/channel
          // machinery, so there is nothing to degrade: accept plainly.
          this.applyFeatureSetsUpdate(params as unknown as FeatureSetsUpdateParams);
          conn.sendResponse(req.id, { accepted: true });
          break;
        }

        case 'context/afterInference': {
          // RETIRED no-op (see handleAfterInference). The capability is not
          // advertised; this case survives only so a stray call from an older
          // host is answered instead of erroring. It does NOT post anything —
          // an earlier comment here described the retired sticky-reply as if
          // live, and misled a reviewer into believing the capability was
          // still advertised. Issue #14.
          // Literal wire string: mcpl-core 0.5 removed method.CONTEXT_AFTER_
          // INFERENCE from the method map (the 0.2.1 constant equaled this
          // string); a back-compat shim for old hosts is exactly where the
          // removed name must not be load-bearing.
          await this.handleAfterInference(params);
          conn.sendResponse(req.id, { featureSet: 'discord.messaging' });
          break;
        }

        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      if (err instanceof RequestRefusal) {
        // An answer to the request, not a fault: its own code, one log line.
        console.error(`[discord-mcpl] ${req.method} refused (${err.code}): ${err.message}`);
        dbg('handleRequest:refused', { method: req.method, code: err.code, error: err.message });
        conn.sendError(req.id, err.code, err.message);
        return;
      }
      // Capture the full error before reporting it. The previous version
      // dropped stack + tool/input context, which made transient failures
      // (Discord 5xx, rate-limit, missing permissions, etc.) untraceable
      // from the host side — we'd see "internal system error" without any
      // hint of which call failed.
      // Anything can be thrown, undefined included, and reading .stack or
      // .message off that would throw here, leaving the request unanswered.
      const e = err instanceof Error ? err : undefined;
      const message = errorText(err);
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
        e?.stack ?? message,
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
        error: message,
        errorName: e?.name,
        // Stack is the most useful bit for diagnosing transient bugs.
        stack: e?.stack?.split('\n').slice(0, 8).join('\n'),
      });
      conn.sendError(req.id, -32603, message);
    }
  }

  /** Shared body of featureSets/update, both forms (§6.7). Also resolves
   *  the policy gate that releases the reconnect sweep (see serve()).
   *  An update applies whole or not at all: its lists are checked before
   *  anything changes, so a malformed one throws and leaves the grants as
   *  they were (the notification form has no reply to say it failed). */
  private applyFeatureSetsUpdate(p: FeatureSetsUpdateParams): void {
    if (typeof p !== 'object' || p === null) {
      throw new Error('featureSets/update: params must be an object');
    }
    const names = (field: 'enabled' | 'disabled'): string[] => {
      const list: unknown = p[field];
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list) || !list.every((name) => typeof name === 'string')) {
        throw new Error(`featureSets/update: ${field} must be a list of feature-set names`);
      }
      return list;
    };
    const enabled = names('enabled');
    const disabled = names('disabled');
    for (const name of enabled) this.enabledFeatureSets.add(name);
    for (const name of disabled) this.enabledFeatureSets.delete(name);
    this.resolvePolicyAnswered();
  }

  // ── Notification Dispatch ──

  private handleNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case method.FEATURE_SETS_UPDATE: {
        // §6.7 Notification form. A 0.5 host sends grant-bearing updates
        // (including the §5.3 initial policy) as a Request (see the
        // handleRequest case), but hosts before 0.5 send every update this
        // way, so it gets the same body and changes the grants too: whole, or
        // not at all when it's malformed.
        this.applyFeatureSetsUpdate(notif.params as FeatureSetsUpdateParams);
        break;
      }

      // Spec 14.3: outgoing streaming is ADVISORY — the authoritative delivery
      // is channels/publish. The previous handler here posted complete's text
      // to Discord; that was a never-exercised alternative delivery path
      // (no host emitted these until agent-framework wired Spec 14.3,
      // 2026-07-26) and would double-post against the host's publish the
      // moment streaming turned on. Now: chunks feed voice synthesis, and
      // complete finalizes the utterance. Nothing here ever sends text.
      case method.CHANNELS_OUTGOING_CHUNK: {
        const p = notif.params as ChannelsOutgoingChunkParams;
        this.voice?.handleChunk(p.inferenceId, p.channelId, p.delta);
        break;
      }

      case method.CHANNELS_OUTGOING_COMPLETE: {
        // SPEC §14.5: delivery is NEVER a side effect of a lifecycle event —
        // delivery happens only via `channels/publish` (handlePublish, which
        // also records the send in the state tracker so it is recognized as
        // self-authored). This terminator only finalizes the chunk stream:
        // release the buffer, nothing else. The previous body called
        // discord.sendMessage() here, which would double-post against
        // handlePublish the moment a host grants `channels.streaming` — the
        // same bug class as the retired afterInference sticky-reply (see the
        // NOTE at the capability declaration), reintroduced on a different
        // signal. It was dormant only because the 0.4 boolean `channels`
        // capability made `channels.streaming` undeclarable. Issue #14.
        const p = notif.params as ChannelsOutgoingCompleteParams;
        dbg('outgoing/complete:finalized', { inferenceId: p.inferenceId, channelId: p.channelId });
        this.voice?.handleComplete(p.inferenceId);
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

      case 'notifications/initialized':
        console.error('[discord-mcpl] Client initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
        break;

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
        content: [textContent(
          `${name} is turned off here: this host has disabled the "${fs}" feature set it belongs to, ` +
            "so the call didn't run, and calling it again won't change that. " +
            'If you need it, ask whoever runs this host.',
        )],
        isError: true,
      };
    }

    // Name-based channel addressing. Resolved HERE, once, rather than in each
    // of the dozen-odd tools that take a channelId — one chokepoint means no
    // tool can be added later that silently misses it.
    //
    // A snowflake passes through untouched, so this is backwards compatible.
    // A name, or the `discord:<guild>:<channel>` composite, is resolved to the
    // bare channel id: a name against the live channel cache (see
    // channel-names.ts for how it answers several matches), the composite by
    // the id it carries.
    let explain: ExplainContext = {};
    if (typeof args.channelId === 'string' && args.channelId.trim()) {
      const given = args.channelId;
      const path: AddressingPath = isSnowflake(given.trim()) ? 'explicit-id' : 'name-resolved';
      // An adapter predating this feature has no resolver. Do NOT pass the
      // unresolved name downstream hoping Discord rejects it: "probably bounces"
      // is not the guarantee this feature is for. The whole point is that a send
      // either reaches the channel the agent named or fails audibly, never
      // anything in between -- so refuse here, explicitly, where we can still say
      // why. (Review: Sol, 2026-08-04.)
      const noResolver = typeof this.discord.resolveChannelRef !== 'function';
      if (path === 'name-resolved' && noResolver && looksLikeExplicitName(given)) {
        dbg('channel:resolver-unavailable', { tool: name, given });
        return {
          content: [textContent(
            `Cannot address a channel by name here: this adapter has no channel ` +
            `resolver, so "${given}" cannot be turned into a channel id. Pass the ` +
            `numeric channel id instead.`,
          )],
          isError: true,
        };
      }
      if (path === 'name-resolved' && !noResolver) {
        // A name a stale channel holds resolves to no channel
        // (DiscordAdapter.resolveChannelRef), so stale channels are fetched
        // first, and one whose fetch is fresh now is found by the name
        // Discord has. An id needs no name.
        if (parseChannelRef(given)?.kind === 'name') await this.discord.refreshStale();
        const resolved = this.discord.resolveChannelRef(given);
        if (!resolved.ok) {
          // Telemetry: log the failure with what was ASKED FOR, so drift is
          // reconstructable from receipts rather than from memory afterwards.
          dbg('channel:resolve-failed', { tool: name, given, reason: resolved.reason });
          return { content: [textContent(resolved.message)], isError: true };
        }
        dbg('channel:resolved', {
          tool: name,
          given,
          channelId: resolved.id,
          label: resolved.matched ? channelLabel(resolved.matched) : undefined,
        });
        args = { ...args, channelId: resolved.id };
        // An error is explained against what the model sent, not this id.
        explain = { channelGiven: given };
      } else {
        dbg('channel:addressing', { tool: name, path, channelId: given });
      }
    }

    // Deliberate reads respect the channel filters' inspection boundary
    // before any message is read. Names above resolve only among allowed
    // channels; this holds a numeric id to the same rule. Tool arguments
    // aren't checked against their schema, so a channelId that isn't a
    // string is refused here, rather than let past the check to be
    // stringified into Discord's route.
    if (INSPECTION_TOOLS.has(name)) {
      if (typeof args.channelId !== 'string' || args.channelId.trim().length === 0) {
        return { content: [textContent(channelIdRequired(name, args.channelId, 'Nothing was read').message)], isError: true };
      }
      let refusal: string | null;
      try {
        refusal = await this.discord.inspectionRefusal(args.channelId);
      } catch (err) {
        // A lookup Discord refuses is explained as any tool's error is below.
        return { content: [textContent(explainDiscordError(err, args, explain))], isError: true };
      }
      if (refusal) {
        dbg('channel:inspection-refused', { tool: name, channelId: args.channelId });
        return { content: [textContent(refusal)], isError: true };
      }
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
        content: [textContent(explainDiscordError(err, args, explain))],
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
        const content = messageContent(name, args.content);
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        let result: { messageId: string };
        try {
          result = await this.discord.sendMessage(channelId, content, { files });
        } catch (err) {
          throw await this.withAttemptedDestination(err, channelId);
        }
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        return this.augmentSendResult(result.messageId, channelId, shifted);
      }

      case 'reply_message': {
        const channelId = args.channelId as string;
        const content = messageContent(name, args.content);
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        const { messageId: replyTo, target } = await this.resolveTargetMessage(channelId, args);
        let result: { messageId: string };
        try {
          result = await this.discord.sendMessage(
            channelId,
            content,
            { replyTo, files, ...(target ? { requireReplyTarget: true } : {}) },
          );
        } catch (err) {
          throw await this.withAttemptedDestination(err, channelId);
        }
        this.stateTracker.recordSent(result.messageId, channelId, content);
        const shifted = this.markOutboundSend(channelId);
        const receipt = await this.augmentSendResult(result.messageId, channelId, shifted);
        return target ? { ...receipt, target } : receipt;
      }

      case 'send_dm': {
        const userId = requiredUserId(args.userId);
        const content = messageContent(name, args.content);
        const files = args.files as OutgoingFile[] | undefined;
        requireContentOrFiles(content, files);
        let result: { messageId: string; channelId: string; recipientName: string };
        try {
          result = await this.discord.sendDM(
            userId,
            content,
            { files },
          );
        } catch (err) {
          const resolved = (err as DmSendFailure | null)?.dmChannel;
          if (resolved) throw await this.withAttemptedDestination(err, resolved.id, { recipientName: resolved.recipientName });
          if (err instanceof Error) {
            err.message += `\n\nAttempted destination: a DM with ${quotedValue(String(args.userId))}; no DM channel was resolved, so no message was sent.`;
          }
          throw err;
        }
        const shifted = this.markOutboundSend(result.channelId);
        return this.augmentSendResult(result.messageId, result.channelId, shifted, { recipientName: result.recipientName });
      }

      case 'add_reaction': {
        const channelId = args.channelId as string;
        const { messageId, target } = await this.resolveTargetMessage(channelId, args);
        await this.discord.addReaction(channelId, messageId, args.emoji as string);
        return target ? { result: 'Reaction added', target } : 'Reaction added';
      }

      case 'remove_reaction': {
        const channelId = args.channelId as string;
        const { messageId, target } = await this.resolveTargetMessage(channelId, args);
        await this.discord.removeReaction(channelId, messageId, args.emoji as string);
        return target ? { result: 'Reaction removed', target } : 'Reaction removed';
      }

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

      case 'list_channel_members':
        return await this.discord.listChannelMembers(args.channelId as string);

      case 'list_emojis':
        return await this.discord.listEmojis(args.guildId as string | undefined);

      case 'set_reaction_visibility': {
        const channelId = requiredChannelId('set_reaction_visibility', args.channelId);
        this.ensureReactionChannelsLoaded();
        const visible = args.visible as boolean;
        const changed = visible !== this.reactionChannels.has(channelId);
        if (visible) this.reactionChannels.add(channelId);
        else this.reactionChannels.delete(channelId);
        // Saved when the call changes the list or the file may not hold it,
        // so the reply says whenever a configured file doesn't hold the list
        // as it stands.
        const unsaved = changed || this.reactionChannelsUnsaved ? this.saveReactionChannels() : null;
        const note = unsavedNote('reaction channel list', unsaved);
        if (!visible) return `Reaction visibility OFF for channel ${channelId}.` + note;
        // A muted channel delivers nothing: the opt-in is kept, and takes effect once the mute is lifted.
        return (
          (this.isChannelMuted(channelId)
            ? `Reaction visibility ON for channel ${channelId}, but the channel is muted: its reactions reach you once unmute_channel lifts the mute (they never wake you).`
            : `Reaction visibility ON for channel ${channelId}. Reactions there now appear in your context as they happen (they never wake you).`) + note
        );
      }

      case 'refresh_channels':
        // What's stale is fetched first, so its fresh facts are listed.
        await this.discord.refreshStale();
        return this.refreshChannels();

      case 'fetch_history':
        return this.withProvenance(args.channelId as string, this.projectHistoryReactions(await this.discord.fetchHistory(
          args.channelId as string,
          {
            // Per-channel backscroll cap (DISCORD_BACKSCROLL_CHANNELS) also
            // bounds agent-requested history in that channel.
            limit: this.capHistoryLimit(args.channelId as string, (args.limit as number) ?? 50),
            ...(args.before ? { before: args.before as string } : {}),
            ...(args.after ? { after: args.after as string } : {}),
          },
        )));

      case 'fetch_around':
        return this.withProvenance(args.channelId as string, this.projectHistoryReactions(await this.discord.fetchAround(
          args.channelId as string,
          args.messageId as string,
          this.capHistoryLimit(args.channelId as string, (args.limit as number) ?? 50),
        )));

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
        throw new Error(
          "Nothing was done: subscribe_channel is retired. Use the host's channel_open tool with the channel's id: " +
            'discord:<server id>:<channel id>, or discord:dm:<channel id> for a DM.',
        );
      }

      case 'unsubscribe_channel': {
        throw new Error(
          "Nothing was done: unsubscribe_channel is retired. Use the host's channel_close tool with the channel's id: " +
            'discord:<server id>:<channel id>, or discord:dm:<channel id> for a DM.',
        );
      }

      case 'mute_channel': {
        const channelId = requiredChannelId('mute_channel', args.channelId);
        this.ensureMutedLoaded();
        const wasNew = !this.mutedChannels.has(channelId);
        this.mutedChannels.add(channelId);
        // Saved as in set_reaction_visibility: when the call changes the list
        // or the file may not hold it.
        const unsaved = wasNew || this.mutedUnsaved ? this.saveMuted() : null;
        // Muting implies leaving: drop any ambient subscription so the channel
        // stops delivering; it also won't auto-subscribe back in while muted.
        // Its reaction visibility goes too, as a close drops it
        // (unsubscribeRawChannel), saved so a restart can't bring it back:
        // unmuting leaves reactions off until channel_open turns them back on
        // with the rest of ambient traffic, or set_reaction_visibility does.
        this.ensureSubscriptionsLoaded();
        this.subscribedChannels.delete(channelId);
        this.ensureReactionChannelsLoaded();
        const reactionsUnsaved = this.reactionChannels.delete(channelId) ? this.saveReactionChannels() : null;
        for (const channel of this.channelManager.getOpen()) {
          if (parseMcplChannelId(channel.id)?.channelId === channelId) this.channelManager.close(channel.id);
        }
        return (
          (wasNew
            ? `Muted channel ${channelId}: no ambient, no wake on mention/reply, and it will not auto-subscribe you back in. Reverse with unmute_channel("${channelId}").`
            : `Channel ${channelId} was already muted.`) +
          unsavedNote('muted channel list', unsaved) +
          unsavedNote('reaction channel list', reactionsUnsaved)
        );
      }

      case 'unmute_channel': {
        const channelId = requiredChannelId('unmute_channel', args.channelId);
        this.ensureMutedLoaded();
        const removed = this.mutedChannels.delete(channelId);
        const unsaved = removed || this.mutedUnsaved ? this.saveMuted() : null; // as in mute_channel
        const compositeId = this.channelManager.getAll()
          .find((channel) => parseMcplChannelId(channel.id)?.channelId === channelId)?.id;
        const target = compositeId ? `channelId "${compositeId}"` : 'its MCPL channel id';
        return (
          (removed
            ? `Unmuted channel ${channelId}. Direct addresses will reach you again. Ordinary traffic requires channel_open with ${target}. If the host still shows it as open, use channel_close then channel_open with the same id to reconcile.`
            : `Channel ${channelId} was not muted.`) + unsavedNote('muted channel list', unsaved)
        );
      }

      case 'list_subscriptions': {
        this.ensureSubscriptionsLoaded();
        this.ensureWatermarkLoaded();
        const missed = [...this.missedTally.entries()]
          .filter(([, t]) => t.messages > 0)
          .map(([channelId, t]) => ({
            // Raw ID first (load-bearing for fetch_* and the tally key),
            // then resolved labels + composite MCPL id from local caches —
            // no REST per row (issue #28).
            ...this.resolveChannelMeta(channelId),
            missedMessages: t.messages,
            missedCharacters: t.characters,
          }))
          .sort((a, b) => b.missedCharacters - a.missedCharacters);
        return {
          channels: [...this.subscribedChannels].sort(),
          count: this.subscribedChannels.size,
          unsubscribedWithBacklog: missed,
          note:
            this.subscribedChannels.size === 0
              ? 'No ambient subscriptions. Mentions and DMs are always delivered.'
              : 'Ambient messages from these channels are delivered. Mentions and DMs always come through regardless.',
        };
      }

      case 'channel_missed': {
        // Checked before the loads, which can set aside and rewrite an
        // unusable watermarks file, so a refusal has done nothing.
        const channelId = requiredChannelId('channel_missed', args.channelId, 'Nothing was read');
        this.ensureSubscriptionsLoaded();
        this.ensureWatermarkLoaded();
        if (this.subscribedChannels.has(channelId)) {
          return {
            ...this.resolveChannelMeta(channelId),
            subscribed: true,
            missedMessages: 0,
            missedCharacters: 0,
            note: 'Currently subscribed — ambient messages are being delivered, nothing is being missed.',
          };
        }
        const tally = this.missedTally.get(channelId);
        if (!tally) {
          return {
            ...this.resolveChannelMeta(channelId),
            subscribed: false,
            tracked: false,
            note: 'Not tracking this channel. A missed-ambient tally starts only after you unsubscribe from a channel you were subscribed to.',
          };
        }
        return {
          ...this.resolveChannelMeta(channelId),
          subscribed: false,
          tracked: true,
          missedMessages: tally.messages,
          missedCharacters: tally.characters,
          sinceMessageId: tally.anchorId || null,
          note:
            'Ambient messages (non-mention, non-DM) you have missed in this channel since you unsubscribed. ' +
            'Mentions and DMs were still delivered and are not counted. Counts cover the bot\'s online time plus ' +
            'an on-reconnect backfill of downtime gaps. Reopen with channel_open to start receiving these again.',
        };
      }

      case 'filters_get': {
        const f = this.discord.getFilters();
        const path = process.env.DISCORD_FILTERS_FILE;
        return {
          hotAdjustable: !!path,
          filtersFile: path ?? null,
          guildIds: f.guildIds ?? null,
          guildChannels: f.guildChannels ?? null,
          dmUsers: f.dmUsers ?? null,
          // Whether refused DM senders get the automatic notice, and whether
          // its per-sender limit is durable right now (when it isn't, notices
          // are suspended; refusals are unaffected).
          dmNotice: this.dmNoticeState().status(),
          plane: this.filtersState.planeStatus(),
          reactionSuppression: {
            ...this.filtersState.suppressionStatus(),
            writable: false,
            whyNotWritable:
              'Suppression entries are operator-maintained in the filters file until a host-level ' +
              'semantic-key facility lands; a referential update surface (suppress-by-key, no literal ' +
              'markers) arrives with it. The entries are never echoed here by design.',
            note:
              'Some reactions on your account are placed by the host, not by you — "me": true on a ' +
              'reaction is not evidence you authored it. A "stale" status means the last-known-good ' +
              'set is still enforced but only for this process lifetime; it does not survive a restart.',
          },
          note:
            'null = unrestricted. These filters gate which Discord events reach you; ' +
            'they are not Discord-side permissions — the bot must also be a member of a guild to see it.' +
            (path
              ? ''
              : ' Hot whitelist updates are disabled: set DISCORD_FILTERS_FILE in the environment (one restart) to enable ' +
                'them. filters_update setDmNotice works without it.'),
        };
      }

      case 'filters_update':
        return await this.filtersUpdate(args);

      default:
        throw new Error(`There's no Discord tool "${name}", so nothing ran. Call one of the Discord tools listed for you.`);
    }
  }

  /** The target of a reply or reaction: exactly one of messageId or
   *  latestFrom, each a string or null. Only omission and null mean absent:
   *  a string, blank included, is a selector given, so a blank one beside
   *  another is two, and a blank one alone names nothing. A latestFrom
   *  selection is resolved once, its message id frozen for the action, and
   *  echoed back so the resident can recognize what was chosen. */
  private async resolveTargetMessage(
    channelId: string,
    args: Record<string, unknown>,
  ): Promise<{ messageId: string; target?: Record<string, unknown> }> {
    const selector = (value: unknown, name: string): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string') throw new Error(`${name} must be a string or null; nothing was done.`);
      return value;
    };
    const messageId = selector(args.messageId, 'messageId');
    const latestFrom = selector(args.latestFrom, 'latestFrom');
    if (messageId !== undefined && latestFrom !== undefined) {
      throw new Error('Give messageId or latestFrom, not both; nothing was done.');
    }
    if (messageId === undefined && latestFrom === undefined) {
      throw new Error('Give exactly one of messageId or latestFrom; nothing was done.');
    }
    if (messageId !== undefined) {
      if (!messageId.trim()) throw new Error('messageId is blank, so it names no message; nothing was done.');
      return { messageId: messageId.trim() };
    }
    if (!latestFrom!.trim()) throw new Error('latestFrom is blank, so it names no one; nothing was done.');
    const r = await this.discord.resolveLatestFrom(channelId, latestFrom!);
    if (!r.ok) throw new Error(r.message);
    // Cut by code points, never inside a surrogate pair: at most
    // LATEST_FROM_EXCERPT characters, its ellipsis included.
    const text = Array.from(r.message.cleanContent.replace(/\s+/g, ' ').trim());
    return {
      messageId: r.message.id,
      target: {
        messageId: r.message.id,
        author: { id: r.authorId, name: r.authorLabel },
        // The raw Discord id, named as such: in receipts `channelId` is the
        // canonical discord:<guild|dm>:<channel> form.
        discordChannelId: channelId,
        timestamp: r.message.timestamp.toISOString(),
        excerpt: text.length > LATEST_FROM_EXCERPT ? `${text.slice(0, LATEST_FROM_EXCERPT - 1).join('')}…` : text.join(''),
        selectedBy:
          `latestFrom "${latestFrom}": their newest message among the ${LATEST_FROM_WINDOW} most recent ` +
          'in this channel when this call ran (not a claim about what you have seen)',
      },
    };
  }

  /** Hot-apply a whitelist change: mutate the filters file (source of truth),
   *  swap the adapter's in-memory filters, and register any newly-visible
   *  channels with the host. See tools.ts for the argument semantics. */
  private async filtersUpdate(args: Record<string, unknown>): Promise<unknown> {
    // The notice setting lives in the DM notice state, not the filters file,
    // so it works (and survives restarts) whether or not a filters file is
    // configured. Alone, it needs nothing else; alongside whitelist changes
    // it's applied after them, so a refused filter change applies nothing.
    if (args.setDmNotice !== undefined && typeof args.setDmNotice !== 'boolean') {
      throw new Error('setDmNotice must be true or false. Nothing was changed.');
    }
    const setDmNotice = args.setDmNotice as boolean | undefined;
    const applyNotice = async (notes: string[]): Promise<void> => {
      if (setDmNotice === undefined) return;
      const unconfirmed = await this.dmNoticeState().setEnabled(setDmNotice);
      notes.push(
        setDmNotice
          ? 'Senders whose DMs the whitelist refuses will get the automatic delivery notice (at most once per 24 hours each).'
          : 'Refused DMs are now dropped without any notice to their senders. A notice already reserved and being sent still goes out.',
      );
      if (unconfirmed) notes.push(`The notice setting is in effect but not confirmed durable: ${unconfirmed}`);
    };
    const filterChange = ['addGuilds', 'removeGuilds', 'setDmUsers'].some((k) => args[k] !== undefined);
    if (setDmNotice !== undefined && !filterChange) {
      const notes: string[] = [];
      await applyNotice(notes);
      return { applied: { dmNotice: this.dmNoticeState().status().enabled }, notes };
    }
    const path = process.env.DISCORD_FILTERS_FILE;
    if (!path) {
      throw new Error(
        'Hot filter updates are disabled: DISCORD_FILTERS_FILE is not set. ' +
          'Set it in the environment and restart once to enable.',
      );
    }
    // The desired state on disk must be readable before any write. A
    // missing or malformed operator file is never reconstructed from
    // process memory — that would overwrite whatever the operator had
    // (including suppression entries the in-memory state may not carry),
    // bypassing the same protection the startup path gives it. Refusing
    // loudly is the plane working: repair is hot (the poller picks it up
    // within seconds), so nothing here needs a restart.
    if (!existsSync(path)) {
      throw new Error(
        `The filters file is MISSING on disk (${path}). Refusing to recreate it from process memory — ` +
          'an operator should restore the file (or restart to re-seed it); hot reload then applies it within seconds.',
      );
    }
    const current = loadFiltersFile(path);
    if (!current) {
      throw new Error(
        'The filters file exists but cannot be parsed. Refusing to overwrite it — ' +
          'an operator should repair the JSON (it hot-reloads, no restart needed), then retry this update.',
      );
    }
    // Rebuild from the fresh desired state, so an operator edit made
    // within the poller's 3s window survives this rewrite — including the
    // operator-owned suppression key, which rides through untouched (the
    // tool schema has no parameter that can carry it).
    const next: DiscordFilters = {
      guildIds: current.guildIds ? [...current.guildIds] : undefined,
      guildChannels: current.guildChannels
        ? Object.fromEntries(Object.entries(current.guildChannels).map(([g, c]) => [g, [...c]]))
        : undefined,
      dmUsers: current.dmUsers ? [...current.dmUsers] : undefined,
      suppressedReactionEmojis: current.suppressedReactionEmojis,
    };
    const notes: string[] = [];

    const addGuilds = (args.addGuilds as string[] | undefined) ?? [];
    const removeGuilds = (args.removeGuilds as string[] | undefined) ?? [];
    if ((addGuilds.length || removeGuilds.length) && !next.guildIds?.length) {
      // Currently unrestricted: materialize the implicit allow-list (every
      // guild the bot is in) so an add doesn't silently become "ONLY this
      // guild" and a remove has something to remove from.
      next.guildIds = (await this.discord.listGuilds()).map((g) => g.id);
      notes.push(
        'Guild filter was unrestricted; materialized it as the list of all current guilds before applying your change.',
      );
    }
    for (const entry of addGuilds) {
      const [gid, chans] = entry.split(':', 2);
      if (!gid) continue;
      if (!next.guildIds!.includes(gid)) next.guildIds!.push(gid);
      if (chans) {
        const wanted = chans.split('+').map((s) => s.trim()).filter(Boolean);
        const existing = next.guildChannels?.[gid];
        if (existing) {
          (next.guildChannels ??= {})[gid] = [...new Set([...existing, ...wanted])];
        } else if (!current.guildIds?.includes(gid)) {
          // New guild with an explicit channel list -> restrict to it.
          (next.guildChannels ??= {})[gid] = wanted;
        } else {
          notes.push(
            `Guild ${gid} already allows all channels; the channel list on "${entry}" is a no-op.`,
          );
        }
      } else if (next.guildChannels?.[gid]) {
        // Bare guild id = whole guild -> drop the channel restriction.
        delete next.guildChannels[gid];
        notes.push(`Guild ${gid}: channel restriction removed — all channels now allowed.`);
      }
    }
    for (const gid of removeGuilds) {
      next.guildIds = next.guildIds!.filter((g) => g !== gid);
      if (next.guildChannels) delete next.guildChannels[gid];
    }

    if (args.setDmUsers !== undefined) {
      const list = (args.setDmUsers as string[]).map(String).filter(Boolean);
      next.dmUsers = list.length ? list : undefined;
      if (!list.length) notes.push('DM whitelist cleared — DMs from ANYONE are now delivered.');
    }

    saveFiltersFile(path, next);
    const diff = this.discord.updateFilters(next);
    // Re-apply the plane from what was just written — the file is
    // known-good again (we just wrote it atomically), and this keeps the
    // effective state and digest in sync with disk without waiting a poll.
    this.filtersState.applyParsed(next);
    const refreshed = this.applyFilterChange(diff);
    console.error(
      `[discord-mcpl] filters updated via tool (guilds +${diff.addedGuilds.length}/-${diff.removedGuilds.length})`,
    );

    try {
      await applyNotice(notes);
    } catch (err) {
      notes.push(`The whitelist change was applied, but the notice setting was not: ${(err as Error).message}`);
    }

    const applied = this.discord.getFilters();
    if (diff.removedGuilds.length) {
      notes.push(
        'Removed guilds stop delivering events immediately, but their channels stay listed on the host until restart, under their ids.',
      );
    }
    return {
      applied: {
        guildIds: applied.guildIds ?? null,
        guildChannels: applied.guildChannels ?? null,
        dmUsers: applied.dmUsers ?? null,
        dmNotice: this.dmNoticeState().status().enabled,
      },
      guildsNowDelivering: diff.addedGuilds,
      guildsStoppedDelivering: diff.removedGuilds,
      newChannelsRegistered: refreshed?.added ?? [],
      notes,
    };
  }

  /** A changed filters file, as index.ts's poller reads it: applied as
   *  filters_update applies the file it writes (applyFilterChange). */
  applyReloadedFilters(next: DiscordFilters): ReturnType<DiscordAdapter['updateFilters']> {
    const diff = this.discord.updateFilters(next);
    this.filtersState.applyParsed(next);
    this.applyFilterChange(diff);
    return diff;
  }

  /**
   * After any change of the filters, by filters_update or a reload of the
   * file (applyReloadedFilters). When the change admits a new guild, every
   * channel of a listed kind that the filters admit and that isn't
   * registered yet is registered, in any admitted guild (refreshChannels).
   * Then every registered channel is re-derived. Names resolve only among
   * the channels the filters admit (nameView), so any change can give a
   * registered label's name to another channel, give a channel back the
   * name its label lacked (channelLabelFor), or, by removing its guild,
   * leave a channel labelled by its id.
   */
  private applyFilterChange(diff: { addedGuilds: string[] }): ChannelRefresh | null {
    const refreshed = diff.addedGuilds.length ? this.refreshChannels() : null;
    this.rederiveChannels(this.channelManager.getAll());
    return refreshed;
  }

  // ── Sticky-reply state mutators ──

  /** A send receipt names the destination actually sent to: the canonical
   *  `discord:<guild|dm>:<channel>` id (what the host's registry uses), the
   *  raw Discord id, and the channel's label. It says nothing about where
   *  later plain speech will go; the host owns that routing. `_shifted` is
   *  kept in the signature for call-site compatibility but no longer used. */
  private async augmentSendResult(
    messageId: string,
    channelId: string,
    _shifted: boolean,
    dm?: { recipientName: string },
  ): Promise<{ messageId: string; channelId: string | null; discordChannelId: string; channelLabel: string | null }> {
    const p = this.channelProvenance(channelId, dm);
    return { messageId, channelId: p.channelId, discordChannelId: channelId, channelLabel: p.channelLabel };
  }

  /** A failed or uncertain send keeps whatever text its error carries
   *  (Discord's rejection, a timeout) and gains the destination it was aimed
   *  at, so an unknown outcome still says where. The label is rendered by the
   *  header rule, as in a [source: …] header, so a Discord-chosen name can't
   *  forge a second destination here either. */
  private async withAttemptedDestination(err: unknown, discordChannelId: string, dm?: { recipientName: string }): Promise<unknown> {
    if (!(err instanceof Error)) return err;
    const p = this.channelProvenance(discordChannelId, dm);
    const where = p.channelId
      ? `${p.channelId}${p.channelLabel ? ` · ${labelValue(p.channelLabel)}` : ''} (Discord channel ${discordChannelId})`
      : `Discord channel ${discordChannelId}`;
    // A send can fail on a later part, after the earlier ones posted, or
    // leave unknown whether a part posted (the adapter's postedParts). Only
    // an unknown outcome's note can point at fetch_history, so only then is
    // the channel looked up to ask whether it would read it.
    const posted = (err as { postedParts?: PostedParts }).postedParts;
    const refused = refusedByDiscord(err);
    const note = posted
      ? postedPartsNote(posted, refused, !refused && await this.historyReadable(discordChannelId))
      : '';
    const partly = note ? `\n\n${note}` : '';
    err.message = `${err.message}\n\nAttempted destination: ${where}.${partly}`;
    return err;
  }

  /** Whether fetch_history would show this channel's messages here: by the
   *  two checks handleToolCall gives it, its feature set is enabled, or no
   *  host gates tools by feature set, and the channel filters' inspection
   *  boundary admits the channel (DiscordAdapter.inspectionRefusal), which a
   *  send doesn't meet; by its own cap, the channel's history cap
   *  (DISCORD_BACKSCROLL_CHANNELS, capHistoryLimit) isn't 0; and by
   *  Discord's, this bot holds Read Message History there
   *  (DiscordAdapter.readsMessageHistory). Under a cap of 0, or without that
   *  permission, fetch_history answers with no messages, which would read as
   *  nothing posted. A lookup that fails counts as not readable, as
   *  fetch_history would fail with it, so the note doesn't point at a check
   *  that may refuse. */
  private async historyReadable(channelId: string): Promise<boolean> {
    // fetch_history always belongs to a feature set (featureSetForTool).
    if (this.mcplEnabled && !isEnabled(featureSetForTool('fetch_history')!, this.enabledFeatureSets)) return false;
    if (this.capHistoryLimit(channelId, 1) === 0) return false;
    try {
      return (await this.discord.inspectionRefusal(channelId)) === null && await this.discord.readsMessageHistory(channelId);
    } catch {
      return false;
    }
  }

  /** Where a Discord channel sits, for self-contained renderings: its
   *  canonical id, the registry's label (else one built from cached names),
   *  and the visible header `[source: <canonical id> · <label>]`, the same
   *  grammar the host stamps on inbound messages minus the host-only server
   *  segment, with values that could read as structure quoted as the host
   *  quotes them (source-header.ts). An unknown label is left out; the
   *  canonical id is authoritative when a label differs. A channel the server
   *  can't place has no canonical id (null) and the header says
   *  discord:?:<channel>. channelLabel is the raw label, a field: a host that
   *  renders it into its own header quotes it by the same rule
   *  (agent-framework's labelValue), as channels/open's history items rely on. */
  private channelProvenance(
    discordChannelId: string,
    dm?: { recipientName: string },
  ): { channelId: string | null; channelLabel: string | null; source: string } {
    let canonical: string | null;
    let fallbackLabel: string | null = null;
    const dmId = mcplChannelId('dm', discordChannelId);
    // A DM is known from a send's own resolution, the registry, inbound DM
    // state, or the channel cache: an outgoing DM is often only in the last.
    const isDM = dm !== undefined
      || this.channelManager.get(dmId) !== undefined
      || this.dmChannelIds.has(discordChannelId)
      || this.discord.getCachedChannelMeta?.(discordChannelId)?.isDM === true;
    if (isDM) {
      canonical = dmId;
      const recipient = dm?.recipientName
        ?? this.discord.getCachedDmRecipientName?.(discordChannelId)
        ?? ((this.channelManager.get(dmId)?.metadata as { recipientName?: string } | undefined)?.recipientName ?? null);
      if (recipient) fallbackLabel = `DM: ${recipient}`;
    } else {
      const meta = this.resolveChannelMeta(discordChannelId);
      canonical = meta.mcplChannelId;
      // An unregistered channel is labelled as it would be registered
      // (channelLabelFor): a thread's label is its display form, never a
      // `#name (Guild)` that pastes back as a same-named channel.
      const facts = this.discord.getCachedChannelFacts?.(discordChannelId);
      if (facts) fallbackLabel = channelLabelFor(facts);
    }
    const label = (canonical ? this.channelManager.get(canonical)?.label : undefined) ?? fallbackLabel;
    const id = canonical ?? `discord:?:${discordChannelId}`;
    return {
      channelId: canonical,
      channelLabel: label ?? null,
      source: renderSourceHeader(id, label),
    };
  }

  /** Stamp fetched history with its channel, item by item, so each message
   *  identifies its channel when read alone. */
  private withProvenance<T extends object>(discordChannelId: string, items: T[]): Array<
    { source: string; channelId: string | null; channelLabel: string | null } & T
  > {
    const p = this.channelProvenance(discordChannelId);
    return items.map((item) => ({ source: p.source, channelId: p.channelId, channelLabel: p.channelLabel, ...item }));
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

  /** Path to the retired subscription file. Read as a bootstrap hint for a
   *  host whose Chronicle has not yet recorded desired state. */
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

  private isChannelSubscribed(channelId: string): boolean {
    this.ensureSubscriptionsLoaded();
    return this.subscribedChannels.has(channelId);
  }

  /** Reaction-visibility file: explicit env override, else a `.reactions.json`
   *  sibling of the subscriptions file. */
  private reactionChannelsFile(): string | undefined {
    const p = process.env.DISCORD_REACTION_CHANNELS_FILE;
    if (p && p.length > 0) return p;
    const sub = this.subscriptionsFile();
    return sub ? sub.replace(/(\.json)?$/i, '.reactions.json') : undefined;
  }

  /** Lazy-load reaction-visibility channels from disk on first access. Idempotent. */
  private ensureReactionChannelsLoaded(): void {
    if (this.reactionChannelsLoaded) return;
    this.reactionChannelsLoaded = true;
    const path = this.reactionChannelsFile();
    if (!path) return;
    const read = readJsonFile(path, 'reaction channels', usableIds, []);
    for (const id of read.value) this.reactionChannels.add(id);
    this.reactionChannelsUnsaved = !read.held;
    dbg('reaction-channels:loaded', { count: this.reactionChannels.size, path });
  }

  /** Save the reaction channels. Returns why the save failed, or null, as
   *  with no file configured, when the list is in memory by choice. */
  private saveReactionChannels(): string | null {
    const path = this.reactionChannelsFile();
    if (!path) return null; // in-memory mode
    try {
      writeJsonFile(path, [...this.reactionChannels].sort());
      this.reactionChannelsUnsaved = false;
      return null;
    } catch (err) {
      this.reactionChannelsUnsaved = true;
      console.error('[discord-mcpl] Failed to save reaction channels:', (err as Error).message);
      dbg('reaction-channels:save-failed', { error: (err as Error).message, path });
      return (err as Error).message;
    }
  }

  /**
   * The SINGLE ingestion decision: does a Discord event in this channel enter
   * the agent's context? Every event type — message create, edit, delete —
   * must route through here so the filtering rule lives in exactly one place
   * and can't drift. (It drifted before: edits/deletes bypassed the
   * subscription check that creates go through, leaking cross-channel edit/
   * delete markers into agents scoped to the whole guild.)
   *
   * Forward iff the channel is open or subscribed (ambient), OR the event
   * addresses the bot (mention/reply), OR it's a DM. Muting takes precedence
   * over every admission path. Open channels must also receive edits/deletes
   * when their subscription state differs, unless muted.
   */
  private shouldEnterContext(
    channelId: string,
    opts: { isMention?: boolean; isDM?: boolean; guildId?: string | null } = {},
  ): boolean {
    if (this.isChannelMuted(channelId)) return false;
    return Boolean(opts.isMention)
      || Boolean(opts.isDM)
      || (opts.guildId != null && this.channelManager.isDiscordChannelOpen(opts.guildId, channelId))
      || this.isChannelSubscribed(channelId);
  }

  // Mute persistence: DISCORD_MUTED_CHANNELS_FILE, else a sibling of the
  // subscriptions file (…​.muted.json). In-memory when neither is available.
  private mutedFile(): string | undefined {
    const explicit = process.env.DISCORD_MUTED_CHANNELS_FILE;
    if (explicit && explicit.length > 0) return explicit;
    const sub = this.subscriptionsFile();
    if (!sub) return undefined;
    return sub.replace(/\.json$/i, '') + '.muted.json';
  }

  private ensureMutedLoaded(): void {
    if (this.mutedLoaded) return;
    this.mutedLoaded = true;
    const path = this.mutedFile();
    if (!path) return;
    const read = readJsonFile(path, 'muted channels', usableIds, []);
    for (const id of read.value) this.mutedChannels.add(id);
    this.mutedUnsaved = !read.held;
    dbg('muted:loaded', { count: this.mutedChannels.size, path });
  }

  /** Save the muted channels. Returns why the save failed, or null, as
   *  saveReactionChannels. */
  private saveMuted(): string | null {
    const path = this.mutedFile();
    if (!path) return null;
    try {
      writeJsonFile(path, [...this.mutedChannels].sort());
      this.mutedUnsaved = false;
      return null;
    } catch (err) {
      this.mutedUnsaved = true;
      console.error('[discord-mcpl] Failed to save muted channels:', (err as Error).message);
      dbg('muted:save-failed', { error: (err as Error).message, path });
      return (err as Error).message;
    }
  }

  private isChannelMuted(channelId: string): boolean {
    this.ensureMutedLoaded();
    return this.mutedChannels.has(channelId);
  }

  // ── Watermark persistence (for offline catch-up) ──

  /** Path to the JSON file backing per-channel watermarks + DM channel IDs.
   *  When unset, watermarks are in-memory only and the catch-up sweep is a
   *  no-op (no persisted anchor survives a restart). */
  private watermarkFile(): string | undefined {
    const p = process.env.DISCORD_WATERMARK_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  /** Lazy-load watermarks + DM channel IDs from disk. Idempotent. */
  private ensureWatermarkLoaded(): void {
    if (this.watermarkLoaded) return;
    this.watermarkLoaded = true;
    const path = this.watermarkFile();
    if (!path) return;
    const { value: saved } = readJsonFile(path, 'watermarks', usableWatermarks, {});
    for (const [chan, id] of Object.entries(saved.watermarks ?? {})) this.forwardedWatermark.set(chan, id);
    for (const id of saved.dmChannels ?? []) this.dmChannelIds.add(id);
    for (const [chan, list] of Object.entries(saved.owed ?? {})) {
      // As owe() keeps it: one entry per message (certain if either was, an
      // edit only if both were, the most tries), the newest 50.
      const byId = new Map<string, OwedMessage>();
      for (const item of list) {
        const known = byId.get(item.id);
        if (!known) { byId.set(item.id, { ...item }); continue; }
        if (!item.uncertain) delete known.uncertain;
        if (!item.edit) delete known.edit;
        const tries = Math.max(known.tries ?? 0, item.tries ?? 0);
        if (tries > 0) known.tries = tries;
      }
      const kept = [...byId.values()].slice(-OWED_PER_CHANNEL_MAX);
      if (kept.length > 0) this.owed.set(chan, kept);
    }
    for (const [chan, tally] of Object.entries(saved.missed ?? {})) {
      this.missedTally.set(chan, {
        anchorId: tally.anchorId,
        talliedThrough: tally.talliedThrough ?? tally.anchorId,
        messages: tally.messages,
        characters: tally.characters,
      });
    }
    dbg('watermark:loaded', {
      channels: this.forwardedWatermark.size,
      dms: this.dmChannelIds.size,
      missed: this.missedTally.size,
      path,
    });
  }

  /** Persist the watermark map + DM channel set. Best-effort; called after
   *  each forward so the anchor is current if the process dies. */
  private saveWatermark(): void {
    const path = this.watermarkFile();
    if (!path) return; // in-memory mode
    try {
      const out = {
        watermarks: Object.fromEntries(
          [...this.forwardedWatermark.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        ),
        dmChannels: [...this.dmChannelIds].sort(),
        missed: Object.fromEntries(
          [...this.missedTally.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        ),
        // Only while something is owed, so the file is as it was otherwise.
        ...(this.owed.size > 0
          ? { owed: Object.fromEntries([...this.owed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) }
          : {}),
      };
      writeJsonFile(path, out);
      if (this.watermarkSaveFailure !== null) console.error('[discord-mcpl] Saved watermarks again.');
      this.watermarkSaveFailure = null;
    } catch (err) {
      const failure = (err as Error).message;
      // Saved after every forward, so a lasting failure is logged when it
      // starts or its reason changes, not once per message.
      if (failure !== this.watermarkSaveFailure) {
        console.error(
          '[discord-mcpl] Failed to save watermarks:',
          failure,
          '(logged again only if the reason changes; a later success is logged too)',
        );
      }
      this.watermarkSaveFailure = failure;
      dbg('watermark:save-failed', { error: failure, path });
    }
  }

  // ── Reconnect catch-up sweep ──

  /** Channel display metadata for tool results, resolved WITHOUT a REST
   *  round-trip: gateway cache first, then the registered MCPL descriptor.
   *  Raw IDs stay load-bearing (fetch_around/fetch_history take them);
   *  labels are best-effort with an explicit `metadataResolved` flag so a
   *  failed lookup is distinguishable from an unnamed field (issue #28). */
  private resolveChannelMeta(channelId: string): {
    channelId: string;
    mcplChannelId: string | null;
    channelName: string | null;
    guildId: string | null;
    guildName: string | null;
    metadataResolved: boolean;
  } {
    if (this.dmChannelIds.has(channelId)) {
      const desc = this.channelManager.get(mcplChannelId('dm', channelId));
      const recipient =
        (desc?.metadata as { recipientName?: string } | undefined)?.recipientName ?? null;
      return {
        channelId,
        mcplChannelId: mcplChannelId('dm', channelId),
        channelName: recipient,
        guildId: null,
        guildName: null,
        metadataResolved: recipient !== null,
      };
    }
    const cached = this.discord.getCachedChannelMeta(channelId);
    if (cached?.guildId) {
      return {
        channelId,
        mcplChannelId: mcplChannelId(cached.guildId, channelId),
        channelName: cached.name,
        guildId: cached.guildId,
        guildName: cached.guildName,
        metadataResolved: cached.name !== null,
      };
    }
    // Descriptor fallback: registration keeps the address and the names the
    // label was made from (toDescriptor's metadata) even when the gateway
    // cache doesn't hold the channel (evicted, or a filtered late join). The
    // names are read from those fields, never parsed back out of the label,
    // whose shape depends on the kind (a thread's names its parent too).
    for (const desc of this.channelManager.getAll()) {
      const addr = desc.address as { guildId?: string; channelId?: string } | undefined;
      if (addr?.channelId === channelId && addr.guildId && addr.guildId !== 'dm') {
        const names = desc.metadata as { channelName?: string; guildName?: string } | undefined;
        return {
          channelId,
          mcplChannelId: desc.id,
          channelName: names?.channelName ?? null,
          guildId: addr.guildId,
          guildName: names?.guildName ?? null,
          metadataResolved: names?.channelName !== undefined,
        };
      }
    }
    dbg('channel-meta:unresolved', { channelId });
    return {
      channelId,
      mcplChannelId: null,
      channelName: null,
      guildId: null,
      guildName: null,
      metadataResolved: false,
    };
  }

  /** Project suppressed reactions out of history messages before they
   *  become model-visible (fetch_history / fetch_around tool results,
   *  channel-open backscroll metadata). When suppression is due to a broken
   *  filters plane the message carries `reactionsUnavailable: true` — an
   *  empty list that actually means "couldn't project" must not read as
   *  "none" (Sol's #31 ruling, truthfulness on partial state).
   *
   *  Line-formatted transcripts (the reconnect `<missed>` sweep, the
   *  first-interaction backscroll) get the same projection through
   *  renderReactionState below — one filter, every surface. */
  private projectHistoryReactions<T extends { reactions?: ReactionSummary[] }>(
    msgs: T[],
  ): Array<T & { reactionsUnavailable?: true }> {
    return msgs.map((m) => {
      const proj = this.filtersState.project(m.reactions);
      return {
        ...m,
        reactions: proj.reactions,
        ...(proj.unavailable ? { reactionsUnavailable: true as const } : {}),
      };
    });
  }

  /** Render current NET reaction state as a line suffix for text transcripts
   *  — the reconnect `<missed>` sweep and the first-interaction backscroll
   *  (issue #31). One shared renderer so every historical path shows the same
   *  message the same way: the current aggregate after the suppression
   *  projection, independent of the live set_reaction_visibility toggle
   *  (that opt-in governs ambient add/remove events; historical rendering is
   *  a current-state snapshot, never a replay of the event sequence).
   *
   *  Truthfulness on partial state: no suffix means "no visible reactions".
   *  State we don't actually have — the resolver gave us nothing, or a
   *  failed-closed policy forbids showing what we do have — renders as an
   *  explicit unavailable marker instead, with no hint of which case it was. */
  private renderReactionState(reactions: ReactionSummary[] | undefined): string {
    const proj = this.filtersState.project(reactions);
    if (reactions === undefined || proj.unavailable) return ' [reactions: unavailable]';
    if (proj.reactions.length === 0) return '';
    const parts = proj.reactions.map(
      (r) => `${r.emoji} x${r.count}${r.me ? ' (incl. me)' : ''}`,
    );
    return ` [reactions: ${parts.join(', ')}]`;
  }

  /** The place attributes of a `<missed>` block's header: channel, thread,
   *  channelId, and guild or dm. Each name is an attribute's value, so it is
   *  always quoted, with quotedValue's escaping, which the live location
   *  uses too: a bidi control or line separator in one can't reorder or
   *  split the header. (The live location writes a channel or guild name
   *  bare where the header rule allows, and always quotes a thread's.) */
  private missedPlaceAttrs(
    meta: { name?: string | null; guildName?: string | null } & ThreadPlace | null | undefined,
    channelId: string,
    isDM: boolean,
  ): string[] {
    const place = messagePlace(meta?.name ?? undefined, meta ?? {});
    const attrs: string[] = [];
    if (place.channel) attrs.push(`channel=${quotedValue(`#${place.channel}`)}`);
    if (place.thread) attrs.push(`thread=${quotedValue(place.thread)}`);
    // channelId is load-bearing: it's what fetch_around/fetch_history need to
    // let the agent jump to any of these messages and read the full context.
    // For a thread it is the thread's own id.
    attrs.push(`channelId="${channelId}"`);
    if (meta?.guildName) attrs.push(`guild=${quotedValue(meta.guildName)}`);
    else if (isDM) attrs.push('dm="true"');
    return attrs;
  }

  /** One message's line in a `<missed>` block, with `mark` after the
   *  author. Led by the message id so the agent can fetch_around(channelId,
   *  id) to read the surrounding conversation. (The time is empty under
   *  AGENT_TIMESTAMP_STYLE=none; the id stays.) */
  private missedLine(m: HistoryMessage, mark: string): string {
    const ts = formatAgentDateTime(m.timestamp, AGENT_TIME_ZONE, AGENT_TIMESTAMP_STYLE);
    const att =
      m.attachments && m.attachments.length > 0
        ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]`
        : '';
    return `[${ts ? `${ts} ` : ''}id=${m.id}] ${m.authorName}${mark}: ${m.cleanContent}${att}${this.renderReactionState(m.reactions)}`;
  }

  // ── Owed messages ──

  /**
   * Remember a message forwarded live that the host didn't take, after every
   * resend sendWithRetries allows: no verdict came (`uncertain`: it may have
   * arrived after all), or a refusal the spec gives no meaning. A refusal the
   * spec does give one (malformed, not permitted, unknown channel) is the
   * host's decision or this server's bug, and isn't owed. The watermark has
   * moved past the message already, so nothing else would deliver it;
   * deliverOwed does, later. `edit`: what wasn't taken was an edit of it.
   */
  private owe(channelId: string, messageId: string, how: { uncertain: boolean; edit?: boolean }): void {
    this.ensureWatermarkLoaded();
    const list = this.owed.get(channelId) ?? [];
    const known = list.find((o) => o.id === messageId);
    if (known) {
      this.owedRevs.set(known, (this.owedRevs.get(known) ?? 0) + 1);
      // Owed already. Only a certain answer about the create itself says it
      // didn't arrive; a refused edit says nothing about the create. With
      // the create owed, the edit mark is moot: the message goes as it is now.
      if (!how.uncertain && !how.edit) delete known.uncertain;
      if (!how.edit) delete known.edit;
    } else {
      list.push({ id: messageId, ...(how.uncertain ? { uncertain: true as const } : {}), ...(how.edit ? { edit: true as const } : {}) });
    }
    while (list.length > OWED_PER_CHANNEL_MAX) {
      const dropped = list.shift()!;
      console.error(`[discord-mcpl] Gave up message ${dropped.id} in channel ${channelId}: more than ${OWED_PER_CHANNEL_MAX} messages there are owed.`);
    }
    this.owed.set(channelId, list);
    this.saveWatermark();
    console.error(`[discord-mcpl] ${how.edit ? 'The edit of message' : 'Message'} ${messageId} in channel ${channelId} is owed: it is delivered when the host takes messages there again.`);
    dbg('owed:added', { channelId, messageId, ...how, owed: list.length });
  }

  /** Forget owed messages of a channel. */
  private forgetOwed(channelId: string, ids: readonly string[]): void {
    const list = this.owed.get(channelId);
    if (!list) return;
    const left = list.filter((o) => !ids.includes(o.id));
    if (left.length === list.length) return;
    if (left.length > 0) {
      this.owed.set(channelId, left);
    } else {
      this.owed.delete(channelId);
      this.owedTried.delete(channelId);
    }
    this.saveWatermark();
  }

  /** Each owed entry's revision, bumped when it is owed again (owe): a
   *  delivery forgets only the entries it delivered as they were. */
  private readonly owedRevs = new WeakMap<OwedMessage, number>();

  /** Channels whose owed messages are being delivered (deliverOwedIn). */
  private readonly owedDelivering = new Set<string>();
  /** Per channel, the connection its last delivery try counted on, and when
   *  that try failed: a try counts once per connection, and a live trigger
   *  waits OWED_RETRY_COOLDOWN_MS after a failure before trying again. */
  private readonly owedTried = new Map<string, { conn: McplConnection; failedAt: number }>();

  /** Deliver everything owed to `conn`, whose start-up has settled
   *  (serve()), a channel at a time. */
  private async deliverOwed(conn: McplConnection): Promise<void> {
    this.ensureWatermarkLoaded();
    for (const channelId of [...this.owed.keys()]) {
      if (this.conn !== conn || conn.isClosed) return;
      await this.deliverOwedIn(conn, channelId, 'ready');
    }
  }

  /**
   * Deliver a channel's owed messages (owe), as Discord has them now, in one
   * `<missed reason="undelivered">` block, pushed as the catch-up sweep pushes
   * its blocks: when a connection becomes ready (`ready`), and when the host
   * takes a message in that channel again (`live`; not within
   * OWED_RETRY_COOLDOWN_MS of a failed try on the same connection).
   *
   * Given up: a message Discord no longer has, one the live filters refuse
   * now, everything owed in a muted channel or one Discord doesn't know, and
   * a block refused with a code the spec gives a meaning. Not delivered this
   * time (a read that failed, a channel whose identity can't be resolved, a
   * filter answer that rests on facts that aren't current, as the sweep holds
   * such a channel back; a block not taken): a try is counted, once per
   * connection, and after OWED_DELIVERY_TRIES they are given up.
   */
  private async deliverOwedIn(conn: McplConnection, channelId: string, trigger: 'ready' | 'live'): Promise<void> {
    if (this.owedDelivering.has(channelId)) return;
    const tried = this.owedTried.get(channelId);
    if (trigger === 'live' && tried?.conn === conn && Date.now() - tried.failedAt < OWED_RETRY_COOLDOWN_MS) return;
    this.owedDelivering.add(channelId);
    try {
      const list = [...(this.owed.get(channelId) ?? [])];
      if (list.length === 0) return;
      if (!this.mcplEnabled || !isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      const giveUp = (entries: readonly OwedMessage[], why: string): void => {
        if (entries.length === 0) return;
        console.error(`[discord-mcpl] Gave up ${entries.length} owed message(s) in channel ${channelId}: ${why}.`);
        dbg('owed:given-up', { channelId, ids: entries.map((o) => o.id), why });
        this.forgetOwed(channelId, entries.map((o) => o.id));
      };
      const notThisTime = (entries: readonly OwedMessage[], why: string, final = false): void => {
        const counts = this.owedTried.get(channelId)?.conn !== conn;
        this.owedTried.set(channelId, { conn, failedAt: Date.now() });
        const givenUp: OwedMessage[] = [];
        for (const owed of entries) {
          if (counts) owed.tries = (owed.tries ?? 0) + 1;
          if (final || (owed.tries ?? 0) >= OWED_DELIVERY_TRIES) givenUp.push(owed);
        }
        this.saveWatermark();
        if (givenUp.length > 0) this.forgetOwed(channelId, givenUp.map((o) => o.id));
        console.error(
          `[discord-mcpl] Couldn't deliver ${entries.length} owed message(s) in channel ${channelId}: ${why}` +
            (givenUp.length === entries.length ? '; given up.' : givenUp.length > 0
              ? `; ${givenUp.length} given up, the rest tried again later.` : '; tried again later.'),
        );
        dbg('owed:not-delivered', { channelId, ids: entries.map((o) => o.id), why, givenUp: givenUp.map((o) => o.id) });
      };
      if (this.isChannelMuted(channelId)) {
        giveUp(list, 'the channel is muted');
        return;
      }

      // Read from Discord, a window of up to 100 messages at a time: one read
      // around an owed message also answers for the owed messages inside its
      // window, present or deleted since.
      const have = new Map<string, HistoryMessage>();
      const windows: Array<[bigint, bigint]> = [];
      const covered = (id: string): boolean => {
        const n = snowflake(id);
        return n !== null && windows.some(([lo, hi]) => n >= lo && n <= hi);
      };
      for (const owed of [...list].sort((a, b) => compareSnowflakes(a.id, b.id))) {
        if (have.has(owed.id) || covered(owed.id)) continue;
        let page: HistoryMessage[];
        try {
          page = await this.discord.fetchAround(channelId, owed.id, 100);
        } catch (err) {
          if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
            giveUp(list, "Discord doesn't know the channel");
          } else {
            notThisTime(list, `couldn't read them from Discord (${errorText(err)})`);
          }
          return;
        }
        for (const m of page) have.set(m.id, m);
        const ns = page.map((m) => snowflake(m.id)).filter((n): n is bigint => n !== null);
        if (ns.length > 0) windows.push([ns.reduce((a, b) => (b < a ? b : a)), ns.reduce((a, b) => (b > a ? b : a))]);
      }
      const gone = list.filter((o) => !have.has(o.id));
      if (gone.length > 0) {
        dbg('owed:gone', { channelId, gone: gone.map((o) => o.id) });
        this.forgetOwed(channelId, gone.map((o) => o.id));
      }
      let found = list.filter((o) => have.has(o.id)).map((owed) => ({ owed, m: have.get(owed.id)! }));
      if (found.length === 0) return;

      // The channel as the sweep resolves it: the cache, looked up when it
      // doesn't hold the channel whole and current.
      let meta = this.discord.getCachedChannelMeta(channelId);
      let lookupFailure: string | null = null;
      if (!meta || (meta.threadId && meta.threadParentName === null) || this.discord.isStale(channelId)) {
        const cached = meta;
        meta = (await this.discord.getChannelMeta(channelId).catch((err) => {
          lookupFailure = errorText(err);
          return null;
        })) ?? cached;
      }
      const isDM = this.dmChannelIds.has(channelId) || meta?.isDM === true;
      const guildId = isDM ? null : (meta?.guildId ?? null);
      if (!isDM && !guildId) {
        notThisTime(found.map(({ owed }) => owed),
          `neither its guild nor DM identity could be resolved${lookupFailure ? ` (its lookup failed: ${lookupFailure})` : ''}`);
        return;
      }
      if (guildId) await this.discord.lookUpStaleParent(channelId);
      // The live ingress decision, evaluated now, as the sweep evaluates it.
      // A channel filter's refusal that rests on facts that aren't current
      // may be wrong, so the channel is held back, as the sweep holds it.
      const reasons = new Map(found.map(({ m }) => [m.id, this.discord.historyIngressReason(channelId, guildId, m.authorId)]));
      const refused = found.filter(({ m }) => reasons.get(m.id) !== null);
      if (refused.some(({ m }) => reasons.get(m.id) === 'channel-not-allowed')) {
        const notCurrent = this.discord.ingressFactsNotCurrent(channelId);
        if (notCurrent) {
          notThisTime(found.map(({ owed }) => owed),
            `the channel filters would withhold them, but that answer rests on facts that aren't current (${notCurrent})`);
          return;
        }
      }
      giveUp(refused.map(({ owed }) => owed), 'the filters refuse them now');
      found = found.filter((f) => !refused.includes(f));
      // And the single ingestion gate (shouldEnterContext), as the live path
      // admits an event now: a message that doesn't address the agent goes
      // only while its channel is open or subscribed.
      const shut = found.filter(({ m }) => !this.shouldEnterContext(channelId, { isDM, guildId, isMention: m.mentionsBot }));
      giveUp(shut.map(({ owed }) => owed), "their channel doesn't take them now (closed or unsubscribed since, and they don't address the agent)");
      found = found.filter((f) => !shut.includes(f));
      if (found.length === 0) return;
      found.sort((a, b) => a.m.timestamp.getTime() - b.m.timestamp.getTime());

      // Registered before it's named, as the sweep and the live path do.
      const guildDelivery = !isDM && guildId ? this.registerGuildDelivery(guildId, channelId) : undefined;
      const mcplId = isDM
        ? this.registerDmDelivery(channelId, { id: found[0].m.authorId, name: found[0].m.authorName })
        : guildDelivery?.id;
      const closedNote = guildDelivery && guildId ? this.closedChannelNote(guildId, channelId, guildDelivery) : '';
      const thread: ThreadPlace = meta ?? {};
      const hadMention = isDM || found.some(({ m }) => m.mentionsBot);
      const attrs = this.missedPlaceAttrs(meta, channelId, isDM);
      attrs.push(`count="${found.length}"`, 'reason="undelivered"');
      const lines = found.map(({ m, owed }) => this.missedLine(m,
        `${m.mentionsBot ? ' (mention)' : ''}${owed.edit ? ' (edited)' : ''}${owed.uncertain ? ' (may have arrived already)' : ''}`));
      const block = [
        `<missed ${attrs.join(' ')}>`,
        "[The host didn't take these messages when they were sent; this is how Discord has them now.]",
        ...lines,
        '</missed>',
      ].join('\n');
      // The occurrence is this block: the same messages, marks and text give
      // the same id (a block sent again is the same occurrence), and anything
      // else a new one.
      const digest = createHash('sha256')
        .update(JSON.stringify(found.map(({ m, owed }) => [m.id, owed.edit === true, owed.uncertain === true, m.cleanContent])))
        .digest('hex')
        .slice(0, 16);
      const revs = new Map(found.map(({ owed }) => [owed, this.owedRevs.get(owed) ?? 0]));
      let outcome: SendOutcome;
      try {
        outcome = pushOutcome(await conn.sendRequest(method.PUSH_EVENT, {
          featureSet: 'discord.messaging',
          eventId: `discord_owed_${channelId}_${digest}`,
          timestamp: new Date().toISOString(),
          origin: {
            source: 'discord',
            channelId,
            guildId: meta?.guildId ?? null,
            guildName: meta?.guildName ?? undefined,
            ...(mcplId ? { mcplChannelId: mcplId } : {}),
            channelName: meta?.name ?? undefined,
            ...threadFields(thread),
            isMention: hadMention,
            isDM,
          } as Record<string, unknown>,
          ...(threadTags(thread).length > 0 ? { tags: threadTags(thread) } : {}),
          payload: { content: [textContent(`${closedNote}${block}`)] },
        } satisfies PushEventParams));
      } catch (err) {
        outcome = sendErrorOutcome(err);
      }
      if (outcome.kind === 'accepted' || outcome.kind === 'no-result') {
        this.owedTried.delete(channelId);
        // Owed again while this was on its way (a later edit not taken, say):
        // that owing stays, for the next delivery.
        this.forgetOwed(channelId, found.filter(({ owed }) => (this.owedRevs.get(owed) ?? 0) === revs.get(owed)).map(({ owed }) => owed.id));
        console.error(`[discord-mcpl] Delivered ${found.length} owed message(s) in channel ${channelId}.`);
        dbg('owed:delivered', { channelId, ids: found.map(({ owed }) => owed.id), result: outcome.kind });
        return;
      }
      // A refusal the spec gives a meaning, unknown channel included (the
      // channel was registered just now), won't change with another try.
      const answer = answerClass(outcome);
      notThisTime(found.map(({ owed }) => owed), describeOutcome(outcome, 'push/event'), answer === 'final' || answer === 'unknown-channel');
    } finally {
      this.owedDelivering.delete(channelId);
    }
  }

  /** On (re)connect, deliver what arrived while the bot was offline:
   *  mentions + DMs from any known channel, plus the full missed backscroll
   *  for subscribed channels (which already receive ambient delivery). Each
   *  channel is scanned from its persisted watermark, bounded by catchupLimit.
   *
   *  No-op unless a watermark file is configured (without a persisted anchor
   *  there's no "since when" to scan from) and messaging is enabled. Runs at
   *  most once per process. */
  private async runReconnectSweep(): Promise<void> {
    if (this.sweepDone) return;
    this.sweepDone = true;
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) return;
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
    if (!this.watermarkFile()) {
      dbg('sweep:skip', { reason: 'no-watermark-file' });
      return;
    }
    this.ensureSubscriptionsLoaded();
    this.ensureWatermarkLoaded();
    const botId = this.discord.botUserId;

    // Scan anything we have an anchor for, plus subscribed channels and known
    // DMs. A channel with no persisted watermark is skipped — there's no
    // "since" point and we don't want to pull unbounded history; the inline
    // first-interaction backscroll covers it when it's next touched.
    const candidates = new Set<string>([
      ...this.forwardedWatermark.keys(),
      ...this.subscribedChannels,
      ...this.dmChannelIds,
    ]);

    let delivered = 0;
    for (const channelId of candidates) {
      // A muted channel delivers nothing, its missed mentions included.
      if (this.isChannelMuted(channelId)) {
        dbg('sweep:skip', { channelId, reason: 'muted' });
        continue;
      }
      const watermark = this.forwardedWatermark.get(channelId);
      if (!watermark) continue;
      const isSubscribed = this.subscribedChannels.has(channelId);

      let msgs: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        msgs = await this.discord.fetchHistory(channelId, {
          limit: this.catchupLimit,
          after: watermark,
        });
      } catch (err) {
        dbg('sweep:fetch-failed', { channelId, error: errorText(err) });
        // Discord doesn't know the channel: it was deleted, perhaps while
        // discord-mcpl was down, or with a deleted channel it hung off, so no
        // deletion event reached it. Where its guild is known, that is its
        // deletion (channelDeleted): it's forgotten, remembered as deleted,
        // and loses its watermark and missed tally. Otherwise those two go,
        // so later starts stop fetching it. Any other failure keeps them, to
        // try again at the next start.
        if ((err as { code?: unknown } | null)?.code === UNKNOWN_CHANNEL) {
          const guildId = this.guildOfChannel(channelId);
          if (guildId) {
            this.channelDeleted(guildId, channelId);
          } else {
            const tallied = this.missedTally.delete(channelId);
            if (this.forwardedWatermark.delete(channelId) || tallied) this.saveWatermark();
          }
        }
        continue;
      }
      msgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      // Drop the bot's own past messages and chx no-op triggers, mirroring the
      // inline backscroll filter.
      msgs = msgs.filter((m) => m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX));
      if (msgs.length === 0) continue;

      const newestId = msgs[msgs.length - 1].id;

      // Cache first. The channel is looked up when the cache doesn't hold it
      // (the sweep starts from the channels it saved, not from an event, so
      // the cache may not have seen one, such as a DM), when it holds a
      // thread whose parent channel it can't name, or when its facts may be
      // older than Discord's (isStale). The lookup fetches from Discord what
      // the cache doesn't hold whole and current, as the live path does; for
      // a thread whose parent just isn't cached, it reads the cache again. A
      // failed lookup is logged (issue #28), and what the cache knew stands.
      // Resolved before anything is delivered, because the ingress decision
      // below needs the channel's identity.
      let meta = this.discord.getCachedChannelMeta(channelId);
      let lookupFailure = null as string | null;
      if (!meta || (meta.threadId && meta.threadParentName === null) || this.discord.isStale(channelId)) {
        const cached = meta;
        meta = (await this.discord.getChannelMeta(channelId).catch((err) => {
          lookupFailure = errorText(err);
          dbg('sweep:channel-meta-failed', { channelId, error: lookupFailure });
          return null;
        })) ?? cached;
      }
      // A channel is a DM only when that's known: recorded as one when a DM
      // was forwarded, or reported so by Discord. A failed lookup is never
      // read as "no guild, so a DM"; the channel is held back, its watermark
      // untouched. The sweep runs once per process, so it's tried again at
      // the next start, unless a message forwarded live in it first moves
      // its watermark past what was held. A failed lookup reaches stderr in
      // whichever line says what became of the channel.
      const isDM = this.dmChannelIds.has(channelId) || meta?.isDM === true;
      const guildId = isDM ? null : (meta?.guildId ?? null);
      if (!isDM && !guildId) {
        dbg('sweep:identity-unresolved', { channelId });
        console.error(
          `[discord-mcpl] Catch-up held back channel ${channelId}: neither its guild nor DM identity could be ` +
            `resolved${lookupFailure ? ` (its lookup failed: ${lookupFailure})` : ''}, so its missed messages ` +
            'were not delivered. It is tried again at the next start, unless a message forwarded live in it ' +
            'before then moves its watermark past them.',
        );
        continue;
      }
      // A thread's channel whose facts may be older than Discord's is looked
      // up too, as a live create's is: its category can admit the thread.
      if (guildId) await this.discord.lookUpStaleParent(channelId);

      // The live ingress decision (guild, channel and thread parent, DM
      // author), evaluated now, after the fetch, so a filter change made
      // while it was pending applies. What the live path would refuse is
      // never rendered here; a refused DM goes through the same notice rule.
      const refusedDms: typeof msgs = [];
      const withheld = new Map<string, number>();
      msgs = msgs.filter((m) => {
        const reason = this.discord.historyIngressReason(channelId, guildId, m.authorId);
        if (reason === 'dm-user-not-allowed') refusedDms.push(m);
        else if (reason) withheld.set(reason, (withheld.get(reason) ?? 0) + 1);
        return reason === null;
      });
      // The channel filters' answer rests on what the cache knows of the
      // channel, and of a thread's channel (ingressFactsNotCurrent). When the
      // answer is to withhold and a fact it rests on isn't known or current
      // after the lookups, it may be wrong, and moving past the messages
      // would lose them for good: the channel is held back, its watermark
      // untouched, as one whose identity can't be resolved is, and only the
      // held line is printed for it. An answer that admits stands, as what
      // the cache knew does (issue #28).
      const filtered = withheld.get('channel-not-allowed');
      const notCurrent = filtered ? this.discord.ingressFactsNotCurrent(channelId) : null;
      if (notCurrent) {
        dbg('sweep:held-facts-not-current', { channelId, filtered, notCurrent });
        console.error(
          `[discord-mcpl] Catch-up held back channel ${channelId}: the channel filters would withhold its ` +
            `${filtered} missed message(s), but that answer rests on facts that aren't current ` +
            `(${notCurrent}${lookupFailure ? `; channel ${channelId}'s own lookup failed: ${lookupFailure}` : ''}), so they were not ` +
            'delivered. It is tried again at the next start, unless a message forwarded live in it before then ' +
            'moves its watermark past them.',
        );
        continue;
      }
      if (lookupFailure) {
        console.error(
          `[discord-mcpl] Catch-up couldn't look up channel ${channelId} (${lookupFailure}). Its missed messages ` +
            'are placed and filtered by what the cache knew of it, and any that are delivered may go out without its names.',
        );
      }
      // Refused DMs are decided alongside delivery, which doesn't wait for
      // them; the watermark only moves past this batch once all of them are
      // decided, or the wait for them runs out (advance). Their notices go
      // out without holding up the sweep. Moving past a refusal means the
      // sweep never sees it again, so one decided while the notice state
      // can't be read or written gets no notice, now or later.
      const refusalsDecided = refusedDms.map(
        (m) => this.handleDmRefusal({ messageId: m.id, channelId, authorId: m.authorId, origin: 'sweep' }).decided,
      );
      const advance = async () => {
        if (refusalsDecided.length) await this.awaitSweepDecisions(channelId, refusalsDecided);
        // Not for a channel deleted while the sweep worked on it: the
        // deletion dropped its watermark, and there's nothing to catch up on.
        if (guildId && this.deletedLately(guildId, channelId)) return;
        // Only forward: the live path may have moved it past this batch
        // while the sweep waited.
        const current = this.forwardedWatermark.get(channelId);
        if (!current || newestId.localeCompare(current, 'en-US-u-kn-true') > 0) {
          this.forwardedWatermark.set(channelId, newestId);
          // Saved at once, as live forwarding saves each message: the process
          // can end before the sweep does (the stdio transport exits when its
          // host goes), and a later start would deliver this block again.
          this.saveWatermark();
        }
      };
      for (const [reason, count] of withheld) {
        if (reason === 'self-authored') continue;
        console.error(
          `[discord-mcpl] Catch-up withheld ${count} missed message(s) in channel ${channelId}: ${reason} ` +
            '(the live filters refuse them)',
        );
      }
      if (msgs.length === 0) {
        // Everything was withheld: advance past it, as the live path never
        // revisits what it refused.
        await advance();
        continue;
      }

      // Delivery rule: DMs and subscribed channels get the full missed
      // backscroll; every other known channel gets each mention plus its
      // immediate vicinity (the ±VICINITY messages around each ping), so the
      // agent sees the surrounding exchange, not a bare ping line. A
      // count-window is robust to channel pace (a time window collapses to
      // nothing in a quiet channel). Vicinity comes from the already-fetched
      // `msgs` — no extra REST calls.
      const VICINITY = 7;
      const keepAll = isDM || isSubscribed;
      const mentionCount = msgs.filter((m) => m.mentionsBot).length;
      let kept: typeof msgs;
      if (keepAll) {
        kept = msgs;
      } else {
        const keepIdx = new Set<number>();
        for (let i = 0; i < msgs.length; i++) {
          if (!msgs[i].mentionsBot) continue;
          for (let j = Math.max(0, i - VICINITY); j <= Math.min(msgs.length - 1, i + VICINITY); j++) {
            keepIdx.add(j);
          }
        }
        kept = [...keepIdx].sort((a, b) => a - b).map((i) => msgs[i]);
      }
      if (kept.length === 0) {
        // Nothing to deliver, but advance the anchor so we don't re-scan these
        // messages on the next reconnect.
        await advance();
        continue;
      }
      const hadMention = isDM || mentionCount > 0;

      // The channel is named as the live location names it: a thread by the
      // channel it hangs off and the thread itself.
      const thread: ThreadPlace = meta ?? {};
      const attrs = this.missedPlaceAttrs(meta, channelId, isDM);
      // count = number of actual mentions; lines = total delivered (the
      // mentions and the messages kept around each) so the agent knows how
      // much is context vs ping.
      attrs.push(`count="${keepAll ? kept.length : mentionCount}"`);
      if (!keepAll) attrs.push(`lines="${kept.length}"`);
      attrs.push(`reason="${isDM ? 'dm' : hadMention ? 'mention' : 'backscroll'}"`);
      // Flag the actual ping lines so they stand out from vicinity context.
      const lines = kept.map((m) => this.missedLine(m, m.mentionsBot ? ' (mention)' : ''));
      const block = [
        `<missed ${attrs.join(' ')}>`,
        ...lines,
        '</missed>',
      ].join('\n');

      // Register the channel this push delivers from before naming it (MCPL
      // RFC-011 §3), as the live path does, or re-derive what's registered:
      // a missed DM or thread is otherwise unknown to a freshly started host,
      // which can then neither open it nor tell where a reply would land.
      // The bot's own messages are filtered out above, so every kept message
      // in a DM is from the other party.
      const guildDelivery = !isDM && guildId ? this.registerGuildDelivery(guildId, channelId) : undefined;
      const sweptMcplId = isDM
        ? this.registerDmDelivery(channelId, { id: kept[0].authorId, name: kept[0].authorName })
        : guildDelivery?.id;
      // A closed channel's block of mentions gets the note a live mention
      // from there does, under the same rule.
      const closedNote = guildDelivery && guildId ? this.closedChannelNote(guildId, channelId, guildDelivery) : '';

      try {
        await conn.sendRequest(method.PUSH_EVENT, {
          featureSet: 'discord.messaging',
          eventId: `discord_missed_${channelId}_${newestId}`,
          timestamp: new Date().toISOString(),
          origin: {
            source: 'discord',
            channelId,
            guildId: meta?.guildId ?? null,
            guildName: meta?.guildName ?? undefined,
            // The composite id the host registers and routes by, as a live
            // push's origin carries it, named when the channel is registered
            // (registerGuildDelivery says when it isn't).
            ...(sweptMcplId ? { mcplChannelId: sweptMcplId } : {}),
            channelName: meta?.name ?? undefined,
            ...threadFields(thread),
            isMention: hadMention,
            isDM,
          } as Record<string, unknown>,
          // The place tag only: the block's messages share their channel, but
          // not whether each mentions the bot or who wrote it.
          ...(threadTags(thread).length > 0 ? { tags: threadTags(thread) } : {}),
          payload: { content: [textContent(`${closedNote}${block}`)] },
        } satisfies PushEventParams);
      } catch (err) {
        dbg('sweep:send-failed', { channelId, error: errorText(err) });
        continue;
      }
      // Advance past everything we scanned (not just what we delivered) so a
      // mention-only channel doesn't re-surface its non-mention tail later.
      await advance();
      delivered++;
    }

    // Fill the downtime gap in any missed-ambient tallies (unsubscribed
    // channels the agent is tracking) so `channel_missed` stays exact across
    // outages, not just while online.
    await this.backfillMissedTallies();

    this.saveWatermark();
    dbg('sweep:done', { channelsDelivered: delivered, scanned: candidates.size });
    if (delivered > 0) {
      console.error(
        `[discord-mcpl] Reconnect catch-up: delivered missed messages from ${delivered} channel(s)`,
      );
    }
  }

  /** For each tracked unsubscribed channel, count the ambient that arrived
   *  while we were offline (between `talliedThrough` and now) into its missed
   *  tally, so the count survives downtime. Uses a dedicated fetch from the
   *  tally cursor (independent of the sweep's watermark) to avoid any
   *  double-counting. Bounded by catchupLimit; if a gap exceeds it the count
   *  is a floor (flagged in `channel_missed`). */
  private async backfillMissedTallies(): Promise<void> {
    if (this.missedTally.size === 0) return;
    const botId = this.discord.botUserId;
    for (const [channelId, tally] of this.missedTally) {
      // No cursor (channel unsubscribed before it ever forwarded a message):
      // nothing to anchor a fetch on — online drops alone carry the count.
      if (!tally.talliedThrough) continue;
      let msgs: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        msgs = await this.discord.fetchHistory(channelId, {
          limit: this.catchupLimit,
          after: tally.talliedThrough,
        });
      } catch (err) {
        dbg('missed-backfill:fetch-failed', { channelId, error: errorText(err) });
        continue;
      }
      // Only ambient counts as "missed": mentions/DMs are (re)delivered by the
      // sweep, so they were seen. Drop our own messages and chx no-ops too.
      const ambient = msgs.filter(
        (m) => !m.mentionsBot && m.authorId !== botId && !m.content.startsWith(CHX_NOOP_PREFIX),
      );
      if (ambient.length > 0) {
        tally.messages += ambient.length;
        tally.characters += ambient.reduce((n, m) => n + m.cleanContent.length, 0);
      }
      // Advance the cursor past everything we fetched (mentions included) so we
      // don't re-scan it next reconnect.
      if (msgs.length > 0) {
        const newest = msgs.reduce((a, b) =>
          a.id.localeCompare(b.id, 'en-US-u-kn-true') >= 0 ? a : b,
        );
        tally.talliedThrough = newest.id;
      }
      dbg('missed-backfill:channel', {
        channelId,
        added: ambient.length,
        messages: tally.messages,
        characters: tally.characters,
      });
    }
  }

  // ── Channel Operations ──

  /** Give a host connection the whole registry: every listed channel the bot
   *  can see now (getPostingChannels, refreshed without announcing, since
   *  the register request carries it), and everything registered earlier in
   *  this process, whichever connection was there then: threads, DMs and
   *  other channels messages came from. The delivery paths announce a
   *  channel only when it's new to the registry, so they rely on this: a
   *  connection that wasn't given the registry would never hear of what was
   *  registered before it. Channels forgotten while no host was connected
   *  are announced as removed after it, since a host may keep a server's
   *  channels across a reconnect (agent-framework keeps them until it drops
   *  the server). */
  private async syncChannelsWithHost(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) {
      dbg('syncChannelsWithHost:skip', { reason: !conn ? 'no-conn' : 'mcpl-disabled' });
      return;
    }
    for (const facts of this.discord.getPostingChannels()) {
      this.channelManager.register(this.guildDescriptor(facts));
    }
    const channels = this.channelManager.getAll();
    dbg('syncChannelsWithHost', { count: channels.length, ids: channels.map((d) => d.id) });
    if (channels.length > 0) {
      const regParams: ChannelsRegisterParams = { channels };
      try {
        await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
        dbg('syncChannelsWithHost:sent', { count: channels.length });
      } catch (err) {
        console.error('[discord-mcpl] Failed to register channels:', errorText(err));
        dbg('syncChannelsWithHost:send-failed', { error: errorText(err) });
      }
    }
    // Read after the register is answered: a channel registered again
    // meanwhile was announced as added, and isn't removed now.
    if (conn.isClosed) return;
    const removed = [...this.unannouncedRemovals].filter((id) => !this.channelManager.get(id));
    this.unannouncedRemovals.clear();
    if (removed.length > 0) {
      dbg('syncChannelsWithHost:removed', { removed });
      conn.sendNotification(method.CHANNELS_CHANGED, { removed });
    }
  }

  /** A guild channel's descriptor, by the one rule every path registers by
   *  (toDescriptor), with its subscription and history settings. */
  private guildDescriptor(facts: ChannelFacts): ChannelDescriptor {
    return toDescriptor(facts, this.isChannelSubscribed(facts.id), this.backscrollLimitFor(facts.id));
  }

  /** Register descriptors, and tell a connected host of each one that's new
   *  (added) or whose label or metadata changed (updated): a rename, a name
   *  learned since. One that's unchanged is stored again (its subscription
   *  and history settings refreshed) without a word, so repeat calls
   *  (channelUpdate firing on a topic edit, a manual refresh, each message in
   *  a channel) don't spam the host. What's known of a channel now can be
   *  less than what was (its guild or its name not cached), so a descriptor
   *  that lacks a name the registered one has doesn't replace it; one that
   *  knows every name replaces it, whatever its label (a voice channel
   *  renamed into a thread label's shape is labelled by its id). With no
   *  host connected, the next connection's sync carries them. */
  private registerChannels(descriptors: ChannelDescriptor[]): { added: ChannelDescriptor[]; updated: ChannelDescriptor[] } {
    const added: ChannelDescriptor[] = [];
    const updated: ChannelDescriptor[] = [];
    for (const d of descriptors) {
      const known = this.channelManager.get(d.id);
      if (known && knowsLessThan(d, known)) continue;
      if (!known) added.push(d);
      else if (known.label !== d.label || JSON.stringify(known.metadata) !== JSON.stringify(d.metadata)) updated.push(d);
      this.channelManager.register(d);
      this.unannouncedRemovals.delete(d.id);
    }
    if ((added.length > 0 || updated.length > 0) && this.conn && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, {
        ...(added.length > 0 ? { added } : {}),
        ...(updated.length > 0 ? { updated } : {}),
      });
    }
    return { added, updated };
  }

  /** Forget registered channels, and tell the host: at once when one is
   *  connected, else through the next connection's sync. An id that isn't
   *  registered is left out. */
  private forgetChannels(ids: string[]): void {
    const removed = ids.filter((id) => this.channelManager.unregister(id));
    if (removed.length === 0) return;
    if (this.conn && !this.conn.isClosed && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { removed });
    } else {
      for (const id of removed) this.unannouncedRemovals.add(id);
    }
  }

  /** Re-derive registered guild channels from what the cache knows of them
   *  now (a rename of the channel, its parent or its guild), announcing each
   *  whose label or metadata changed, as derivedNow derives them. */
  private rederiveChannels(descriptors: ChannelDescriptor[]): void {
    this.registerChannels(this.derivedNow(descriptors));
  }

  /** Guild channels' descriptors as what the cache knows of them now
   *  derives them. A stale one is labelled by its id, whether or not the
   *  cache still holds it, and of the rest, one the cache no longer holds is
   *  left out, its descriptor standing as it is, as is a stale one already
   *  labelled by its id. Their facts are read together, so their labels are
   *  checked against one view of the channels names resolve among. */
  private derivedNow(descriptors: ChannelDescriptor[]): ChannelDescriptor[] {
    const channelIdOf = (d: ChannelDescriptor) => (d.address as { channelId?: string } | undefined)?.channelId;
    // A stale channel's cached facts decide nothing: what's registered of it
    // stands, labelled by its id, since it answers no name until a fresh
    // fetch derives it again (onChannelRefreshed).
    const staleNamed = descriptors.filter((d) => {
      const channelId = channelIdOf(d);
      return channelId !== undefined && this.discord.isStale(channelId) && d.label !== d.id;
    });
    const channelIds = descriptors
      .map(channelIdOf)
      .filter((id): id is string => id !== undefined && !this.discord.isStale(id));
    const facts = this.discord.getCachedChannelFactsFor(channelIds);
    return [
      ...[...facts.values()].map((f) => this.guildDescriptor(f)),
      ...staleNamed.map((d) => ({ ...d, label: d.id })),
    ];
  }

  /** Whether the filters' answer for a thread rests on facts that are
   *  known: a thread whose channel is stale may be admitted through a
   *  category that's no longer the channel's, or not admitted through one
   *  that is now (channelAllowed), so its registration stays as it is
   *  until that channel's fresh fetch or update decides it. */
  private threadAdmissionKnown(thread: { parentId?: string | null }): boolean {
    return !thread.parentId || !this.discord.isStale(thread.parentId);
  }

  /** A thread Discord reported on, by an update, a fresh fetch, or a sync
   *  that lists it, when it's registered: forgotten when it's archived, and
   *  otherwise registered again or forgotten as the filters decide, once
   *  their answer is known (threadAdmissionKnown). One that isn't registered
   *  is left to its next message. */
  private threadReported(thread: ChannelFacts): void {
    const id = mcplChannelId(thread.guildId, thread.id);
    if (!this.channelManager.get(id)) return;
    if (thread.archived) this.forgetChannels([id]);
    else if (this.threadAdmissionKnown(thread)) this.registerOrForgetThread(thread);
  }

  /** A registered thread's facts, as an update brings them: registered
   *  again while the filters admit it, forgotten when they don't. */
  private registerOrForgetThread(thread: ChannelFacts): void {
    const id = mcplChannelId(thread.guildId, thread.id);
    if (this.discord.channelAdmitted(thread.guildId, thread.id, thread.parentId ?? null)) {
      this.registerChannels([this.guildDescriptor(thread)]);
    } else {
      this.forgetChannels([id]);
    }
  }

  /**
   * Re-derive the registered channels whose label can have changed because
   * another channel took or gave up their name. A `#name (Guild)` label is
   * kept only while it resolves back to its channel (channelLabelFor): a
   * voice channel's name goes to a same-named text channel, and two channels
   * of one name and kind lose it to each other. So a channel's creation,
   * rename or deletion re-derives those labelled by id although they have a
   * name (another channel held it) and those named like the channel
   * (`name`); a guild joined, left, renamed or back re-derives every one,
   * since a label names its guild.
   */
  private rederiveNamed(which: { name: string | null } | 'every'): void {
    const named = which === 'every' ? undefined : which.name?.toLowerCase();
    this.rederiveChannels(this.channelManager.getAll().filter((d) => {
      const m = d.metadata as { channelType?: string; channelName?: string } | undefined;
      if (!m?.channelType || !isNameAddressableKind(m.channelType) || !m.channelName) return false;
      return which === 'every' || d.label === d.id || m.channelName.toLowerCase() === named;
    }));
  }

  /**
   * A guild is back (from an outage, or in a new gateway session) with what
   * it has now: its listed channels, and the ids of every channel and live
   * thread it holds. Discord doesn't replay what happened while it was away,
   * so a registered channel or thread it no longer has is forgotten (deleted,
   * or a thread archived, meanwhile), and so is a listed channel, or a
   * thread, the filters no longer admit; its listed channels are registered
   * or re-derived, and
   * the threads that remain with them. Nothing is remembered as deleted
   * (deletedChannels): what's gone may only have been archived.
   */
  private guildReturned(guildId: string, channels: ChannelFacts[], present: ReadonlySet<string>): void {
    const listed = new Set(channels.map((c) => c.id));
    this.forgetChannels(this.registeredInGuild(guildId).filter((d) => {
      const channelId = (d.address as { channelId: string }).channelId;
      const type = (d.metadata as { channelType?: string } | undefined)?.channelType;
      return !present.has(channelId)
        || (type !== undefined && isListedKind(type as ChannelFacts['type']) && !listed.has(channelId))
        || (type === 'thread' && !this.admitted(d));
    }).map((d) => d.id));
    this.registerChannels(channels.map((c) => this.guildDescriptor(c)));
    this.rederiveChannels(this.registeredInGuild(guildId));
    this.rederiveNamed('every');
  }

  /** Registered threads whose channel is `channelId`. */
  private registeredThreadsOf(channelId: string): ChannelDescriptor[] {
    return this.channelManager.getAll().filter((d) => {
      const m = d.metadata as { channelType?: string; parentId?: string } | undefined;
      return m?.channelType === 'thread' && m.parentId === channelId;
    });
  }

  /** Registered channels and threads of a guild. */
  private registeredInGuild(guildId: string): ChannelDescriptor[] {
    return this.channelManager.getAll().filter((d) => (d.address as { guildId?: string } | undefined)?.guildId === guildId);
  }

  /** Whether the channel filters still admit a registered guild channel or
   *  thread, a thread through the channel its metadata names. */
  private admitted(d: ChannelDescriptor): boolean {
    const address = d.address as { guildId?: string; channelId?: string } | undefined;
    if (!address?.guildId || !address.channelId || address.guildId === 'dm') return true;
    const parentId = (d.metadata as { parentId?: string | null } | undefined)?.parentId ?? null;
    return this.discord.channelAdmitted(address.guildId, address.channelId, parentId);
  }

  /** The guild a channel is in, as the client's cache or the registry knows
   *  it; undefined for a DM, or a channel neither knows. */
  private guildOfChannel(channelId: string): string | undefined {
    const cached = this.discord.getCachedChannelFacts(channelId)?.guildId;
    if (cached) return cached;
    const address = this.channelManager.getAll()
      .map((d) => d.address as { guildId?: string; channelId?: string } | undefined)
      .find((a) => a?.channelId === channelId);
    return address?.guildId && address.guildId !== 'dm' ? address.guildId : undefined;
  }

  /** Whether a guild channel was deleted lately, or the channel a thread is
   *  under was (deletedChannels): a delivery from it set out before the
   *  deletion. A channel's own parent is its category, whose channels
   *  outlive it, so only a thread's counts. */
  private deletedLately(guildId: string, channelId: string): boolean {
    if (this.deletedChannels.has(channelId)) return true;
    const facts = this.discord.getCachedChannelFacts(channelId);
    const known = this.channelManager.get(mcplChannelId(guildId, channelId))?.metadata as
      { channelType?: string; parentId?: string } | undefined;
    const parentId = facts
      ? (facts.type === 'thread' ? facts.parentId : null)
      : (known?.channelType === 'thread' ? known.parentId : null);
    return !!parentId && this.deletedChannels.has(parentId);
  }

  /**
   * Register the guild channel a message is delivered from (created live or
   * swept, edited or deleted), before the delivery names it, or re-derive
   * what's registered from what's known now (a rename, or a parent's or the
   * guild's name learned since). Returns the channel's MCPL id when it is
   * registered, which is when the delivery names it (origin.mcplChannelId),
   * and whether this delivery registered it (`registered`), having found it
   * live, admitted and unarchived, with its facts current. A channel it
   * withholds isn't registered by it: one registered before keeps its
   * registration, and is named, except where "Neither registered nor named"
   * below says otherwise.
   *
   * The channel is described as the client's cache has it now: a thread the
   * client knows only partly by the partial it holds, labelled by its id
   * (channelLabelFor); one registered already keeps its name
   * (registerChannels). Not registered, and named only if registered:
   * - a channel the cache doesn't hold: a message's channel is always there,
   *   as a partial at least, until it's removed;
   * - a channel whose cached facts may be older than what Discord has
   *   reported since (DiscordAdapter.isStale): its guild came back, from an
   *   outage or a gap in the gateway connection, without it, or its fetch
   *   kept landing after newer reports. It may have been archived or
   *   deleted meanwhile, whatever the cache still says of it. A delivery
   *   from it fetches it again first, so it's stale here when the delivery
   *   decided on facts from before the mark, or that fetch failed or was
   *   overtaken;
   * - a channel the channel filters no longer admit (channelAdmitted), a
   *   thread through its channel: an update moved it out while the delivery
   *   was on its way;
   * - an archived thread, unless the message was posted in it after the
   *   archive (`postedAt` later than `archivedAt`, by Discord's clocks),
   *   which unarchived it, whatever the cache has heard yet. A message
   *   posted before the archive, whose thread was archived while it was on
   *   its way, leaves it archived, and so does one whose time equals the
   *   archive's, or one whose thread's archive time isn't known: the next
   *   message registers a thread wrongly left out, and nothing would remove
   *   one wrongly registered. A thread is registered
   *   while it's live and forgotten when it's archived, so the registry
   *   holds the live threads, and a swept message from a thread archived
   *   since is delivered without one.
   * Neither registered nor named:
   * - a channel of a guild the bot isn't in (hasGuild): it left, or was
   *   removed, while the delivery was on its way. Leaving takes the
   *   channels the guild's cache holds, with their threads, out of the
   *   client's cache, but not a channel the guild had stopped listing, or
   *   that channel's threads;
   * - a channel deleted lately, or a thread whose channel was
   *   (deletedLately): the delivery set out before the deletion;
   * - a category or forum, which hold no messages.
   * A withheld registration is written to the debug log with its reason.
   */
  private registerGuildDelivery(
    guildId: string,
    channelId: string,
    opts: { postedAt?: number } = {},
  ): GuildDelivery {
    const withheld = (reason: string, named?: string): GuildDelivery => {
      dbg('registry:withheld', { guildId, channelId, reason, named: named !== undefined });
      return { id: named, registered: false };
    };
    if (!this.discord.hasGuild(guildId)) return withheld('guild-left');
    if (this.deletedLately(guildId, channelId)) return withheld('deleted');
    const id = mcplChannelId(guildId, channelId);
    const facts = this.discord.getCachedChannelFacts(channelId);
    if (facts && holdsNoMessages(facts.type)) return { id: undefined, registered: false };
    const named = this.channelManager.get(id) ? id : undefined;
    if (!facts) return withheld('uncached', named);
    if (this.discord.isStale(channelId)) return withheld('stale', named);
    if (!this.discord.channelAdmitted(guildId, channelId, facts.parentId ?? null)) return withheld('not-admitted', named);
    const unarchived = opts.postedAt !== undefined && facts.archivedAt !== undefined && opts.postedAt > facts.archivedAt;
    if (facts.archived && !unarchived) return withheld('archived', named);
    this.registerChannels([this.guildDescriptor(facts)]);
    return { id, registered: true };
  }

  /**
   * The closed channel's note (CLOSED_CHANNEL_NOTE) for a push from a guild
   * channel or thread, or '' when it gets none. It goes on a push when this
   * delivery registered the channel (registerGuildDelivery's `registered`),
   * and the gate (shouldEnterContext) now admits a message from there only
   * when it addresses the agent: neither in an open or subscribed channel,
   * where ordinary messages enter too, nor in a muted one, where none do. A
   * live push from there carries a message that addressed the agent, except
   * in a race: a message that doesn't address it, admitted while the channel
   * was open or subscribed, and pushed after it was closed or unsubscribed
   * while its attachments were fetched. A catch-up block carries the
   * channel's missed mentions with up to VICINITY messages on each side of
   * each, or, from a channel subscribed when the block's fetch began, its
   * backscroll. The note holds on all of them. Where the delivery withheld
   * the channel, named or not, this server can't say that opening it brings
   * anything: it's gone, archived, no longer admitted, not in the client's
   * cache, or its facts may be older than Discord's.
   */
  private closedChannelNote(guildId: string, channelId: string, delivery: GuildDelivery): string {
    return delivery.registered
      && this.shouldEnterContext(channelId, { isMention: true, isDM: false, guildId })
      && !this.shouldEnterContext(channelId, { isDM: false, guildId })
      ? CLOSED_CHANNEL_NOTE : '';
  }

  /** Register the DM a message is delivered from, labelled with its other
   *  party's name, or refresh it (a renamed party). Returns its MCPL id when
   *  it's registered: a DM whose other party isn't known by name keeps the
   *  registration it had, or has none. */
  private registerDmDelivery(channelId: string, peer: { id?: string; name?: string }): string | undefined {
    const id = mcplChannelId('dm', channelId);
    if (peer.name) {
      this.registerChannels([toDmDescriptor(channelId, peer.name, false, this.backscrollLimitFor(channelId), peer.id)]);
      return id;
    }
    return this.channelManager.get(id) ? id : undefined;
  }

  /** A Discord channel or thread was deleted: forget it, and the threads
   *  under a deleted channel, those registered and those the client's cache
   *  held (`threadIds`; Discord sends no threadDelete for them); drop their
   *  watermarks and missed tallies, since there is nothing left to catch up
   *  on; and remember the ids a while (deletedChannels), so a delivery from
   *  one that set out before the deletion registers nothing. An archived
   *  thread keeps its watermark (it isn't deleted, and can come back). */
  private channelDeleted(guildId: string, channelId: string, threadIds: string[] = []): void {
    const ids = [...new Set([
      channelId,
      ...threadIds,
      ...this.registeredThreadsOf(channelId).map((d) => (d.address as { channelId: string }).channelId),
    ])];
    for (const id of ids) {
      this.deletedChannels.delete(id);
      this.deletedChannels.add(id);
    }
    while (this.deletedChannels.size > DELETED_CHANNELS_KEPT) {
      this.deletedChannels.delete(this.deletedChannels.values().next().value as string);
    }
    this.ensureWatermarkLoaded();
    let pruned = false;
    for (const id of ids) {
      if (this.forwardedWatermark.delete(id)) pruned = true;
      if (this.missedTally.delete(id)) pruned = true;
      if (this.owed.delete(id)) pruned = true;
      this.owedTried.delete(id);
    }
    if (pruned) this.saveWatermark();
    this.forgetChannels(ids.map((id) => mcplChannelId(guildId, id)));
    // A name the deleted channel held can go back to a channel labelled by id.
    this.rederiveNamed({ name: null });
  }

  /** Re-enumerate every channel currently visible to the bot and register any
   *  that the host doesn't yet know about. This is the agent-facing catch-all
   *  for "I was added to a channel/server but don't see it" — it doesn't rely
   *  on any specific gateway event having fired, so it covers cases the
   *  event handlers miss (missed events, eventual-consistency gaps, etc.). */
  private refreshChannels(): ChannelRefresh {
    const descriptors = this.discord.getPostingChannels().map((facts) => this.guildDescriptor(facts));
    const { added } = this.registerChannels(descriptors);
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

  private async handleChannelOpen(params: ChannelOpenRequest): Promise<ChannelOpenResponse> {
    // One channel this server serves, by its channelId, address or type in
    // that order (resolveOpenTarget), or a refusal with its code; nothing is
    // fetched, opened or subscribed before this.
    const target = resolveOpenTarget(params, this.channelManager.getAll());
    if (target.kind === 'refused') throw new RequestRefusal(target.code, target.reason);
    const parsed = parseMcplChannelId(target.kind === 'registered' ? target.channel.id : target.id);
    if (!parsed) throw new Error(`Invalid Discord channel ID: ${target.kind === 'registered' ? target.channel.id : target.id}`);
    const lookedUp = target.kind === 'registered' ? null : await this.lookUpServedTarget(target, params.type);
    const desc = target.kind === 'registered' ? target.channel : lookedUp!.desc;
    // What arrived during the lookup or the history fetch that takes the
    // channel out of service: one looked up that's deleted, or of a guild the
    // bot left, or a DM whose recipient the DM list stopped admitting; or a
    // registered one unregistered.
    const unregistered = () => new RequestRefusal(
      ERR_UNKNOWN_CHANNEL,
      `${desc.id} was unregistered while this open was in progress (deleted, archived, in a server the bot left, ` +
        'or no longer admitted by the filters). Nothing was opened. A thread archived meanwhile opens again when ' +
        'it is opened by its id.',
    );
    const goneMeanwhile = (): RequestRefusal | null => {
      if (!lookedUp) return this.channelManager.get(desc.id) ? null : unregistered();
      if (this.notServed(parsed.channelId, lookedUp.facts)) {
        return new RequestRefusal(
          ERR_UNKNOWN_CHANNEL,
          `${desc.id} was deleted, or the bot left its server, while this open was in progress. Nothing was opened.`,
        );
      }
      if (lookedUp.dmRecipientId !== undefined && !this.discord.dmUserAdmitted(lookedUp.dmRecipientId)) {
        return new RequestRefusal(
          ERR_UNKNOWN_CHANNEL,
          `The DM list stopped admitting ${desc.id}'s recipient while this open was in progress. Nothing was opened. ` +
            'Opening it is refused while the DM list leaves its recipient out.',
        );
      }
      return null;
    };
    const requested = params.history?.limit ?? 0;
    let backscroll: { messages: Awaited<ReturnType<DiscordAdapter['fetchHistory']>>; truncated: boolean } | null = null;
    if (requested > 0) {
      // Backscroll is a deliberate read, so it respects the channel filters'
      // inspection boundary as fetch_history does. A channel registered
      // before the filters narrowed stays registered until restart, so the
      // registry alone doesn't keep it out. A refusal fails the open before
      // anything is read or subscribed, and again after the fetch: the
      // filters file is reloaded on a timer, so the filters can narrow while
      // the history is fetched, and nothing they no longer admit is returned
      // (as resolveLatestFrom checks again after its reads).
      // Both answers say the open couldn't go ahead (MCPL's open failed),
      // as a failed history fetch does. A channel gone meanwhile fails its
      // check too, since it can't be found, or may be refused by it on
      // another ground, so whenever the check refuses, one gone meanwhile is
      // refused as gone, as everywhere in the open (goneMeanwhile).
      const filtersRefusal = async (): Promise<string | null> => {
        let refusal: string | null;
        try {
          refusal = await this.discord.inspectionRefusal(parsed.channelId);
        } catch (err) {
          const gone = goneMeanwhile();
          if (gone) throw gone;
          throw new RequestRefusal(
            ERR_CHANNEL_OPEN_FAILED,
            `${desc.id} couldn't be checked against the channel filters, so nothing was opened: ${errorText(err)}`,
          );
        }
        if (refusal) {
          const gone = goneMeanwhile();
          if (gone) throw gone;
        }
        return refusal;
      };
      const refusal = await filtersRefusal();
      if (refusal) {
        dbg('channel-open:inspection-refused', { channelId: desc.id });
        throw new RequestRefusal(ERR_CHANNEL_OPEN_FAILED, `${refusal} Nothing was opened.`);
      }
      const limit = this.capHistoryLimit(parsed.channelId, Math.min(500, Math.max(0, requested)));
      if (params.history?.sinceLastSeen) this.ensureWatermarkLoaded();
      let messages: Awaited<ReturnType<typeof this.discord.fetchHistory>>;
      try {
        messages = await this.discord.fetchHistory(parsed.channelId, {
          limit,
          ...(params.history?.beforeMessageId ? { before: params.history.beforeMessageId } : {}),
          ...(params.history?.sinceLastSeen
            ? { after: this.forwardedWatermark.get(parsed.channelId) }
            : {}),
        });
      } catch (err) {
        // A deletion or a guild leave can be what failed the fetch. One this
        // server has heard of is refused as gone; until it hears, as when
        // Discord answers the fetch before the gateway's delete arrives, the
        // fetch's own error is what's known.
        const gone = goneMeanwhile();
        if (gone) throw gone;
        throw new RequestRefusal(
          ERR_CHANNEL_OPEN_FAILED,
          `${desc.id}'s history couldn't be fetched, so nothing was opened: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (await filtersRefusal()) {
        dbg('channel-open:inspection-refused-after-fetch', { channelId: desc.id });
        throw new RequestRefusal(
          ERR_CHANNEL_OPEN_FAILED,
          `The channel filters stopped admitting ${desc.id} while its history was fetched, so none of it is returned. ` +
            'Nothing was opened. Asking again with history is refused while the filters leave it out.',
        );
      }
      messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      backscroll = { messages, truncated: requested > limit };
    }

    // Commit only now, after the lookup and any history fetch. Requests are
    // handled one at a time (serve awaits each before reading the next), so
    // no channels/close or mute_channel arrives during this open: one sent
    // meanwhile is handled after it, and closes what it opened. What can
    // arrive meanwhile is Discord's: a channel gone meanwhile isn't opened,
    // as wherever the open notices it (one looked up that's deleted, or of a
    // guild the bot left, a DM looked up whose recipient the DM list stopped
    // admitting, or a registered one unregistered). So a failed open leaves
    // nothing subscribed.
    const gone = goneMeanwhile();
    if (gone) throw gone;
    // The open registers a looked-up channel, and announces it, only here,
    // so an open refused before this registers nothing itself. The lookup
    // fetches a stale channel fresh, the stale channel of a looked-up thread
    // included, and that fetch registers the channel it fetched when that's
    // a text, announcement, voice or stage channel the filters admit, as any
    // fresh fetch of a stale channel does (onChannelRefreshed), whether or
    // not the open goes on to succeed. One registered meanwhile, by that or
    // by traffic, keeps its registration.
    // The open's own is derived from what the cache knows now (derivedNow),
    // as a registered channel's label is re-derived: a name another channel
    // took or gave up during the history fetch changes it, and re-derivation
    // by name (rederiveNamed) only reaches registered channels. A DM, which
    // the cache's guild facts don't cover, keeps the lookup's descriptor.
    // Then the registered channels of its name are re-derived, as a
    // channel's creation does (onChannelCreate): the lookup's fetch can be
    // what brought it into the cache, and one of them may hold a label that
    // now reaches it.
    if (lookedUp && !this.channelManager.get(desc.id)) {
      const now = this.derivedNow([desc])[0] ?? desc;
      this.registerChannels([now]);
      const name = (now.metadata as { channelName?: string } | undefined)?.channelName;
      if (name) this.rederiveNamed({ name });
    }
    const opened = this.channelManager.open(desc.id);
    if (!opened) throw unregistered();
    const result: ChannelOpenResponse = { channel: opened };
    if (backscroll) {
      result.history = this.projectHistoryReactions(backscroll.messages).map((message) => ({
        channelId: opened.id,
        // The label the open commits to, for the host's header when its
        // registry lacks one.
        channelLabel: opened.label,
        messageId: message.id,
        author: { id: message.authorId, name: message.authorName },
        timestamp: message.timestamp.toISOString(),
        content: [textContent(`${message.authorName}: ${message.cleanContent}`)],
        metadata: {
          isBot: message.isBot,
          attachments: message.attachments,
          reactions: message.reactions ?? [],
          backscroll: true,
          ...(message.reactionsUnavailable ? { reactionsUnavailable: true } : {}),
        },
      }));
      result.historyTruncated = backscroll.truncated;
    }
    this.subscribeRawChannel(parsed.channelId);
    return result;
  }

  /** An exact id or address the registry doesn't hold (resolveOpenTarget's
   *  `unregistered`), looked up in Discord. A channel this server serves
   *  comes back as the descriptor every path registers by (guildDescriptor),
   *  so a DM, thread or channel no traffic has registered since a restart
   *  still opens; the open registers it when it commits. Anything else is
   *  refused as unknown, lately deleted channels and their threads included,
   *  and channels of a guild the bot has left, and a channel of another type
   *  as bad params. A channel whose current facts aren't known (`uncertain`:
   *  a stale channel, a thread of one, or a lookup Discord gave no answer to)
   *  is refused as an open that failed, since its facts decide no
   *  registration and another open fetches it again. An archived thread
   *  opens too, since the host named it, though the registry otherwise holds
   *  only live threads (registerGuildDelivery). It is forgotten as any
   *  archived thread is: when it's reported archived again, as a thread
   *  update or a fetch after it went stale can, or when a sync of its
   *  channel's threads doesn't list it. */
  private async lookUpServedTarget(
    target: { id: string; via: string },
    type: unknown,
  ): Promise<{ desc: ChannelDescriptor; facts: ChannelFacts | null; dmRecipientId?: string }> {
    const parsed = parseMcplChannelId(target.id)!; // resolveOpenTarget hands back only ids that parse
    const found = await this.discord.lookUpServedChannel(parsed.guildId, parsed.channelId);
    // Read after the lookup's waits, as a delivery's registration reads it
    // (registerGuildDelivery).
    if (!found || this.notServed(parsed.channelId, found.kind === 'guild' ? found.facts : null)) {
      // Each kind's causes, as lookUpServedChannel finds them, and for a
      // channel in a server the next step: a DM belongs to no server.
      throw new RequestRefusal(
        ERR_UNKNOWN_CHANNEL,
        parsed.guildId === 'dm'
          ? `No DM this server serves matches ${target.via}: Discord doesn't know it or won't show it to this bot, ` +
            'it isn\'t a DM, or the DM list doesn\'t admit its recipient. Nothing was opened.'
          : `No channel this server serves matches ${target.via}: Discord doesn't know it or won't show it to this bot, ` +
            'it\'s in another server than the id names, it was deleted lately or is in a server the bot left, or it ' +
            'isn\'t a channel messages are posted in or a thread that the filters admit. Nothing was opened. ' +
            'list_channels with a server\'s id lists the channels this server serves there.',
      );
    }
    if (found.kind === 'uncertain') {
      throw new RequestRefusal(
        ERR_CHANNEL_OPEN_FAILED,
        `${target.via} can't be opened right now: Discord's current facts for it, or for the channel it's a thread of, ` +
          "aren't known (the latest fetch failed or was overtaken by a change). Nothing was opened; another open fetches it again.",
      );
    }
    const desc = found.kind === 'dm'
      ? toDmDescriptor(parsed.channelId, found.recipientName, false, this.backscrollLimitFor(parsed.channelId), found.recipientId)
      : this.guildDescriptor(found.facts);
    // The channel opened is the one named, whatever the lookup handed back.
    if (desc.id !== target.id) {
      throw new RequestRefusal(
        ERR_UNKNOWN_CHANNEL,
        `No channel this server serves matches ${target.via}: looking it up found another channel, ${desc.id}. Nothing was opened.`,
      );
    }
    if (desc.type !== type) {
      throw new RequestRefusal(INVALID_PARAMS, `${target.via} is a ${desc.type} channel, not ${typeName(String(type))}. Nothing was opened.`);
    }
    return found.kind === 'guild' ? { desc, facts: found.facts } : { desc, facts: null, dmRecipientId: found.recipientId };
  }

  /** Whether a channel found by an exact open's lookup isn't one this server
   *  serves now: deleted lately, a thread of a channel deleted lately, or in
   *  a guild the bot has left. The bot may leave a guild during the lookup,
   *  and discord.js keeps a channel the guild had stopped listing past the
   *  leave. A channel outlives its deleted category (deletedLately). */
  private notServed(channelId: string, facts: ChannelFacts | null): boolean {
    if (this.deletedChannels.has(channelId)) return true;
    if (!facts) return false;
    return !this.discord.hasGuild(facts.guildId)
      || (facts.type === 'thread' && !!facts.parentId && this.deletedChannels.has(facts.parentId));
  }

  private handleChannelClose(params: ChannelsCloseParams): ChannelsCloseResult {
    const desc = this.channelManager.get(params.channelId);
    const parsed = parseMcplChannelId(params.channelId);
    const wasOpen = this.channelManager.close(params.channelId);
    if (parsed) {
      this.unsubscribeRawChannel(parsed.channelId);
    }
    return { closed: wasOpen || desc !== undefined };
  }

  private async handleChannelAcknowledge(params: ChannelAcknowledgeRequest): Promise<{
    acknowledged: boolean;
    representation?: string;
    reason?: string;
  }> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      return { acknowledged: false, reason: `Invalid Discord channel ID: ${params.channelId}` };
    }
    const representation = params.value?.trim() || '👀';
    try {
      await this.discord.addReaction(parsed.channelId, params.messageId, representation);
      return { acknowledged: true, representation };
    } catch (error) {
      return { acknowledged: false, reason: (error as Error).message };
    }
  }

  private subscribeRawChannel(channelId: string): void {
    this.ensureSubscriptionsLoaded();
    if (!this.subscribedChannels.has(channelId)) {
      this.subscribedChannels.add(channelId);
    }
    this.ensureReactionChannelsLoaded();
    if (!this.reactionChannels.has(channelId)) {
      this.reactionChannels.add(channelId);
      // Not saved here, so the next set_reaction_visibility saves it.
      this.reactionChannelsUnsaved = true;
    }
    this.ensureWatermarkLoaded();
    if (this.missedTally.delete(channelId)) this.saveWatermark();
    this.ensureMutedLoaded();
    if (this.mutedChannels.delete(channelId)) this.saveMuted();
  }

  private unsubscribeRawChannel(channelId: string): void {
    this.ensureSubscriptionsLoaded();
    const removed = this.subscribedChannels.delete(channelId);
    this.ensureReactionChannelsLoaded();
    // Saved, so a restart doesn't bring back the reactions a close turned
    // off. A failed save sets reactionChannelsUnsaved, so the next
    // set_reaction_visibility saves again and says so if it fails.
    if (this.reactionChannels.delete(channelId)) this.saveReactionChannels();
    if (removed) {
      this.ensureWatermarkLoaded();
      const anchor = this.forwardedWatermark.get(channelId) ?? '';
      this.missedTally.set(channelId, {
        anchorId: anchor,
        talliedThrough: anchor,
        messages: 0,
        characters: 0,
      });
      this.saveWatermark();
    }
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

  /** Push-event origin for an edit/delete. Carries the guild and the
   *  composite channel id, when the channel is registered, so the host places
   *  the event in the right channel — without them a guild channel's edit
   *  was reconstructed as `discord:dm:<channelId>` — the thread's fields when
   *  the message is in one, as its create carried them, plus the message and
   *  author ids when the adapter knows them. */
  private messageEventOrigin(
    channelId: string,
    messageId: string,
    info: MessageEventInfo | undefined,
    registeredId: string | undefined,
  ): Record<string, unknown> {
    const guildId = info?.guildId ?? null;
    return {
      source: 'discord',
      channelId,
      ...(guildId ? { guildId } : {}),
      ...(registeredId ? { mcplChannelId: registeredId } : {}),
      ...threadFields(info ?? {}),
      messageId,
      ...(info?.authorId ? { authorId: info.authorId } : {}),
      ...(info?.authorName ? { authorName: info.authorName } : {}),
    };
  }

  /** Register the channel an edit or delete is delivered from, as a create's
   *  is, before the push names it, so one that arrives first (a subscribed
   *  thread's edit after a restart, say) doesn't name a channel the host was
   *  never told of. A DM's other party is the author, unless the message is
   *  the bot's own (a delete), when only its id is known. Returns the MCPL
   *  id when the channel is registered. */
  private registerEventChannel(channelId: string, isDM: boolean, info: MessageEventInfo | undefined): string | undefined {
    if (isDM) {
      const peer = info?.authorId !== undefined && info.authorId !== this.discord.botUserId ? info : undefined;
      return this.registerDmDelivery(
        channelId,
        peer ? { id: peer.authorId, name: peer.authorName } : { id: info?.dmRecipientId },
      );
    }
    return info?.guildId
      ? this.registerGuildDelivery(info.guildId, channelId).id
      : undefined;
  }

  /**
   * RFC-006 §3.2: the channel scope for a message's subject — the registered
   * MCPL channel id — when the host accepts channel-scoped pushes and we have
   * declared that channel to it (guild channels at registration, DMs when
   * first seen). Otherwise undefined: the subject stays in feature-set scope,
   * which still coalesces as long as every occurrence uses the same scope.
   */
  private coalesceChannelScope(guildId: string | null, channelId: string): string | undefined {
    if (!this.hostCoalescing?.channelScopedPush) return undefined;
    const id = mcplChannelId(guildId ?? 'dm', channelId);
    return this.channelManager.get(id) ? id : undefined;
  }

  /** The coalescing scope for an edit/delete: the create's, when remembered
   *  (registration may have changed since), else recomputed now. */
  private subjectScope(messageId: string, guildId: string | null, channelId: string): string | undefined {
    const mem = this.recentCreates.get(messageId);
    if (mem?.scope !== undefined) return mem.scope ?? undefined;
    return this.coalesceChannelScope(guildId, channelId);
  }

  /** Never overtake an in-flight create of the same message (its resends
   *  included). Synchronous (no await, same tick) when there is none, so an
   *  edit or delete of a settled message is sent exactly as promptly as
   *  before. An edit or delete doesn't wait for an earlier one being resent:
   *  it supersedes it (sendWithRetries' `superseded`). */
  private afterCreate(messageId: string, then: () => void): Promise<void> | void {
    const mem = this.recentCreates.get(messageId);
    if (mem && !mem.done) return mem.settled.then(then);
    then();
  }

  private async forwardMessageEdit(channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo): Promise<void> {
    if (!this.conn || !this.mcplEnabled) return;
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
    // Same ingestion gate as a create: an edit in a channel we don't ingest
    // from must not leak in. (Mentions inside an edit are an accepted edge —
    // the open/subscription/DM threshold closes the cross-channel leak.)
    if (!this.shouldEnterContext(channelId, { isDM, guildId: info?.guildId })) {
      dbg('handleMessageEdit:drop', { channelId, messageId, reason: this.isChannelMuted(channelId) ? 'muted' : 'not-open-or-subscribed' });
      return;
    }
    const admitted = this.conn;
    await this.afterCreate(messageId, () => this.sendMessageEdit(admitted, channelId, messageId, newContent, isDM, info));
  }

  /** The connection an edit or delete admitted on `admitted` goes out on
   *  once it has waited (afterCreate): that one while it is current, else the
   *  current one once its start-up has settled (readyNow), else none. One
   *  that connected meanwhile may not have initialized, or may not take
   *  Discord messages at all, until then. */
  private mutationConn(admitted: McplConnection): McplConnection | null {
    if (this.conn === admitted && !admitted.isClosed) return admitted;
    return this.readyNow();
  }

  /** An edit or delete that waited for its create while its host went:
   *  held until a host is ready, for reconnectWaitMs at most, as a resend
   *  waits (waitForHost), then sent there; dropped when none is. */
  private holdForHost(kind: 'edit' | 'delete', channelId: string, messageId: string, send: (conn: McplConnection) => void): void {
    void this.waitForHost(Date.now() + this.reconnectWaitMs).then((ready) => {
      if (typeof ready === 'string') {
        dbg(kind === 'edit' ? 'handleMessageEdit:drop' : 'handleMessageDelete:drop', { channelId, messageId, reason: 'no-ready-connection', why: ready });
        return;
      }
      send(ready);
    });
  }

  private sendMessageEdit(admitted: McplConnection, channelId: string, messageId: string, newContent: string, isDM: boolean, info?: MessageEventInfo): void {
    const conn = this.mutationConn(admitted);
    if (!conn) {
      this.holdForHost('edit', channelId, messageId, (ready) => this.sendMessageEdit(ready, channelId, messageId, newContent, isDM, info));
      return;
    }
    const registeredId = this.registerEventChannel(channelId, isDM, info);
    const scope = this.subjectScope(messageId, info?.guildId ?? null, channelId);
    const mem = this.recentCreates.get(messageId);
    const timestamp = info?.editedAt ?? new Date().toISOString();
    // Name the author the way a create does (`username: text`) so the agent
    // doesn't attribute the edit to whoever it was last talking to.
    const who = info?.authorName ? `${info.authorName}: ` : '';
    // When the edit may REPLACE the unread create (RFC-006 §4.1), it must be
    // as self-contained as the create was: same backscroll/guidance prefix,
    // reply marker, location header and attachments, with the new body and
    // an [edited] mark. Without a remembered create, or for a host that only
    // appends, a bare edit line.
    const render = this.hostCoalescing?.pushEvents ? mem?.render : undefined;
    const content: ContentBlock[] = render
      ? [textContent(`${render.prefix}${render.replyMarker}${render.location}${render.authorName}: ${info?.cleanContent ?? newContent} [edited]`), ...render.attachments]
      : [textContent(`[message edited] ${who}${newContent}`)];
    const params: CoalescedPushEventParams = {
      featureSet: 'discord.messaging',
      // The OCCURRENCE id (RFC-006 §3.1): a second edit of one message is a
      // new occurrence, not a duplicate of the first — `discord_edit_<id>`
      // alone made every later edit of a message vanish at the host's dedup.
      // The counter keeps two edits that share a millisecond distinct.
      eventId: `discord_edit_${messageId}_${timestamp}_${mem ? ++mem.edits : ++this.editSeq}`,
      timestamp,
      origin: this.messageEventOrigin(channelId, messageId, info, registeredId),
      tags: ['chat:edited', ...threadTags(info ?? {})],
      payload: { content },
      // RFC-006: replace the unread original; append once it was read.
      ...(this.hostCoalescing?.pushEvents
        ? { coalesce: { key: `message:${messageId}`, ...(scope ? { channelId: scope } : {}) } }
        : {}),
    };
    this.noteMutationOutcome('edit', messageId, channelId, registeredId ?? channelId, registeredId, conn, params);
  }

  private async forwardMessageDelete(channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo): Promise<void> {
    if (!this.conn || !this.mcplEnabled) return;
    if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
    if (!this.shouldEnterContext(channelId, { isDM, guildId: info?.guildId })) {
      dbg('handleMessageDelete:drop', { channelId, messageId, reason: this.isChannelMuted(channelId) ? 'muted' : 'not-open-or-subscribed' });
      return;
    }
    const admitted = this.conn; // as for an edit
    await this.afterCreate(messageId, () => this.sendMessageDelete(admitted, channelId, messageId, isDM, info));
  }

  private sendMessageDelete(admitted: McplConnection, channelId: string, messageId: string, isDM: boolean, info?: MessageEventInfo): void {
    const conn = this.mutationConn(admitted);
    if (!conn) {
      this.holdForHost('delete', channelId, messageId, (ready) => this.sendMessageDelete(ready, channelId, messageId, isDM, info));
      return;
    }
    const registeredId = this.registerEventChannel(channelId, isDM, info);
    const scope = this.subjectScope(messageId, info?.guildId ?? null, channelId);
    const timestamp = new Date().toISOString();
    const params: CoalescedPushEventParams = {
      featureSet: 'discord.messaging',
      eventId: `discord_delete_${messageId}_${timestamp}_${++this.editSeq}`,
      timestamp,
      origin: this.messageEventOrigin(channelId, messageId, info, registeredId),
      tags: ['chat:deleted', ...threadTags(info ?? {})],
      // The deletion notice (RFC-006 §6): shown only if a model read a
      // version of the message; an unread message is withdrawn without trace.
      payload: { content: [textContent(`[message deleted] ${messageId}${info?.authorName ? ` by @${info.authorName}` : ''}`)] },
      ...(this.hostCoalescing?.pushEvents
        ? { coalesce: { key: `message:${messageId}`, retract: true, ...(scope ? { channelId: scope } : {}) } }
        : {}),
    };
    this.noteMutationOutcome('delete', messageId, channelId, registeredId ?? channelId, registeredId, conn, params);
  }

  // ── DM refusal notices ──

  /** Durable per-sender notice state (src/dm-notices.ts), opened once its
   *  path is known: DISCORD_DM_NOTICES_FILE, or a per-bot default that needs
   *  the bot user id. Until then notices are suspended. */
  private readonly dmNotices = new DmNoticeState({
    // Reported on every open, including a reopen after a repaired file.
    onInterrupted: (i) =>
      console.error(
        `[discord-mcpl] DM notice to sender ${i.authorId} for message ${i.messageId} (reserved ` +
          `${new Date(i.at).toISOString()}) was interrupted before its outcome was recorded; ` +
          'outcome unknown, not retried',
      ),
  });
  /** The notice state's opening, once its path was known. */
  private dmNoticesOpening: Promise<void> | null = null;
  /** How long the catch-up sweep waits for a channel's refused DMs to be
   *  decided before moving past them (see awaitSweepDecisions). */
  private sweepDecisionWaitMs = 30_000;

  /** Start handling refused DMs, whether or not a host is connected:
   *  index.ts calls this right after constructing the server, as it calls
   *  setupSlashCommands. The adapter hands over the refusals it held since
   *  Discord connected, so every refusal gets its notice decision and log
   *  line. Resolves once the notice state is open; a refusal heard meanwhile
   *  waits for it. */
  async setupDmRefusals(): Promise<void> {
    this.discord.onDmRefused((ev) => {
      void this.handleDmRefusal(ev).settled;
    });
    this.dmNoticeState();
    await this.dmNoticesOpening;
  }

  /** Wait for a channel's refused DMs to be decided, at most
   *  sweepDecisionWaitMs. Each decision waits on the notice state's disk, and
   *  one write that never answers would otherwise stop the whole catch-up.
   *  A decision still pending is recorded when the disk answers, and its
   *  notice, if one is due, can't go out before then; the worst case is a
   *  notice never sent. */
  private async awaitSweepDecisions(channelId: string, decided: Promise<unknown>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ranOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), this.sweepDecisionWaitMs);
    });
    const late = await Promise.race([Promise.allSettled(decided).then(() => false), ranOut]);
    clearTimeout(timer);
    if (late) {
      console.error(
        `[discord-mcpl] Catch-up moved past channel ${channelId} with refused DMs still being decided after ` +
          `${this.sweepDecisionWaitMs / 1000}s: the notice state's disk hasn't answered. They're decided when it does.`,
      );
    }
  }

  private dmNoticeState(): DmNoticeState {
    if (!this.dmNoticesOpening) {
      const override = process.env.DISCORD_DM_NOTICES_FILE?.trim();
      const botId = this.discord.botUserId;
      if (override || botId) {
        this.dmNoticesOpening = this.dmNotices.open(resolveDmNoticesPath(botId ?? '', process.env));
      }
    }
    return this.dmNotices;
  }

  /**
   * A DM the allowlist refused, live or swept. It is never forwarded; its
   * sender is told at most once per 24 hours, and each refusal leaves one
   * operator log line without the message body. The live path hears every
   * refused DM while the bot is connected. The sweep only reaches DM
   * channels the bot already knows, ones it forwarded a DM in, so a DM from
   * a sender the bot has never seen, sent while it was offline, is never
   * seen and gets no notice.
   *
   * `decided` resolves when the decision attempt has finished: a notice due
   * is durably reserved by then, and a suspended decision has no
   * confirmed-durable reservation, so nothing is sent. The sweep waits for
   * it before moving its watermark past the message. `settled` resolves once
   * the notice, if one was due, has been sent or has failed, and the log
   * line is written. Nothing in the connector waits for it, so a slow
   * Discord request holds up no other work.
   */
  private handleDmRefusal(ev: DmRefusal): { decided: Promise<DmNoticeDecision>; settled: Promise<void> } {
    const state = this.dmNoticeState();
    const decided = state.decide(ev.messageId, ev.authorId);
    const settled = decided
      .then(async (decision) => {
        let outcome: string = decision;
        if (decision === 'notify') {
          let result: 'sent' | 'failed' | 'unknown' = 'sent';
          let detail = '';
          try {
            // The nonce is the reservation's own identity: one notice per
            // refused message, so the REST layer's retries can't duplicate it.
            await this.discord.sendDmNotice(ev.channelId, DM_NOTICE_TEXT, `dmn${ev.messageId}`);
          } catch (err) {
            // Only a definite rejection counts as failed: the send never
            // started, or Discord refused the request (refusedByDiscord). A
            // 4xx is Discord evaluating it, and with the enforced nonce an
            // earlier attempt that had posted would have been returned
            // instead. A 5xx, a timeout or a lost connection may have posted
            // it, so it's unknown. Either way the reservation stands; no retry.
            const e = err as { notPosted?: unknown; message?: unknown };
            const rejected = e.notPosted === true || refusedByDiscord(err);
            result = rejected ? 'failed' : 'unknown';
            detail = `: ${String(e.message ?? err)}`;
          }
          const unsaved = await state.recordOutcome(ev.authorId, ev.messageId, result);
          outcome = `${result}${detail}${unsaved ? `; its outcome was not saved durably (${unsaved})` : ''}`;
        } else if (decision === 'suspended') {
          // The state names why it isn't persisted. When it is again by now,
          // the decision's reservation couldn't be made durable and its
          // withdrawal then was (see DmNoticeState.decide).
          outcome = `suspended (${state.status().error ?? 'its reservation could not be made durable, so it was withdrawn'})`;
        }
        console.error(
          `[discord-mcpl] DM refused by the DM allowlist (${ev.origin}): sender ${ev.authorId}, ` +
            `message ${ev.messageId}; notice ${outcome}`,
        );
      })
      .catch((err) => {
        console.error(
          `[discord-mcpl] Handling the refused DM from sender ${ev.authorId} (message ${ev.messageId}) failed:`,
          (err as Error).message,
        );
      });
    return { decided, settled };
  }

  private setupDiscordForwarding(): void {
    this.discord.onMessage((msg) => {
      this.handleDiscordMessage(msg).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord message:', err);
      });
    });

    const acceptMutation = (channelId: string) => !this.isChannelMuted(channelId);
    this.discord.onMessageEdit((channelId, messageId, newContent, isDM, info) => {
      void this.forwardMessageEdit(channelId, messageId, newContent, isDM, info).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord edit:', err);
      });
    }, acceptMutation);

    this.discord.onMessageDelete((channelId, messageId, isDM, info) => {
      void this.forwardMessageDelete(channelId, messageId, isDM, info).catch((err) => {
        console.error('[discord-mcpl] Error forwarding Discord delete:', err);
      });
    }, acceptMutation);

    this.discord.onReaction((ev) => {
      if (!this.conn || !this.mcplEnabled) return;
      if (!isEnabled('discord.messaging', this.enabledFeatureSets)) return;
      // Reaction visibility is a per-channel opt-in (default off). Reactions
      // NEVER wake the agent — the reaction tags match no wake policy — they
      // just land in context so the agent sees them when next active. A
      // reaction in a thread names the thread in its origin but keeps the
      // reaction tags only, so a gate rule keyed on chat:thread, written for a
      // thread's messages, doesn't start matching its reactions.
      // SPEC §16.2 defines `chat:reaction` and `chat:reaction-remove` as
      // distinct tags: collapsing both onto `chat:reaction` made any consumer
      // rule for "reactions to my messages" fire on un-reactions too, with the
      // distinction surviving only in origin.action, which gate policy cannot
      // match on. Issue #14.
      this.ensureReactionChannelsLoaded();
      if (!this.reactionChannels.has(ev.channelId)) return;
      // A muted channel delivers nothing, its reactions included, as its
      // creates, edits and deletes already don't (shouldEnterContext).
      // mute_channel drops the channel's visibility, but visibility can come
      // back while it's muted: set_reaction_visibility, or a persisted
      // opt-in read after a restart. Muting takes precedence.
      if (this.isChannelMuted(ev.channelId)) {
        dbg('reaction:drop', { channelId: ev.channelId, messageId: ev.messageId, action: ev.action, reason: 'muted' });
        return;
      }
      // Reaction-suppression projection (issue #21): decided before ANY
      // model-visible text or the event id exists, so a suppressed reaction
      // leaves no glyph, name, or token anywhere — the eventId below embeds
      // the emoji, which is exactly why this guard sits above it. The dbg
      // line deliberately carries no emoji either. A broken filters plane
      // with no usable prior set suppresses every reaction event until the
      // file is repaired. (Subsumes the DISCORD_SUPPRESS_REACTION_EMOJIS
      // emergency guard — that env var now feeds this same projection as a
      // compat source.)
      if (
        this.filtersState.suppressAll() ||
        this.filtersState.isSuppressed({ emojiId: ev.emojiId ?? null, emoji: ev.emoji })
      ) {
        dbg('reaction:suppressed', {
          channelId: ev.channelId,
          messageId: ev.messageId,
          action: ev.action,
        });
        return;
      }
      const verb = ev.action === 'add' ? 'reacted' : 'removed a reaction';
      const target = ev.onOwnMessage ? 'your message' : `message ${ev.messageId}`;
      // Carry a snippet of the reacted-to message when it has text — a bare
      // message id is meaningless to the agent (it can't look messages up).
      const quoted = ev.messageSnippet ? ` — "${ev.messageSnippet}"` : '';
      const line = `[reaction] @${ev.userName} ${verb} ${ev.emoji} on ${target}${quoted}`;
      const reactionChannelId = mcplChannelId(ev.guildId ?? 'dm', ev.channelId);
      this.conn.sendRequest(method.PUSH_EVENT, {
        featureSet: 'discord.messaging',
        eventId: `discord_reaction_${ev.action}_${ev.messageId}_${ev.emojiId ?? ev.emoji}_${ev.userId}_${ev.timestamp.getTime()}`,
        timestamp: ev.timestamp.toISOString(),
        origin: {
          source: 'discord',
          channelId: ev.channelId,
          messageId: ev.messageId,
          guildId: ev.guildId,
          // The composite id the host registers and routes by, when the
          // channel is registered, as the origins of the message's own
          // pushes carry it.
          ...(this.channelManager.get(reactionChannelId) ? { mcplChannelId: reactionChannelId } : {}),
          reactorId: ev.userId,
          reactorName: ev.userName,
          emoji: ev.emoji,
          emojiToken: ev.token,
          onOwnMessage: ev.onOwnMessage,
          action: ev.action,
          ...threadFields(ev),
        } as Record<string, unknown>,
        tags: [ev.action === 'add' ? 'chat:reaction' : 'chat:reaction-remove'],
        payload: { content: [textContent(line)] },
      } satisfies PushEventParams).catch(() => {});
    });

    // The registry follows Discord whether or not a host is connected; a
    // host connecting later is given all of it, removals included
    // (syncChannelsWithHost).
    // A channel's name can take a label's name from a channel registered
    // under it (rederiveNamed).
    this.discord.onChannelCreate((channel) => {
      this.registerChannels([this.guildDescriptor(channel)]);
      this.rederiveNamed({ name: channel.name });
    });

    // A listed channel changed (renamed, moved, or the bot let into it): it
    // is registered or re-derived, and so are the threads registered under
    // it, whose labels name it. A forum or media channel isn't registered,
    // holding no messages, but its posts' labels name it too. One moved out
    // of what the filters admit is forgotten, with the threads the filters
    // admitted through it, as a guild's return forgets them (guildReturned).
    this.discord.onChannelUpdate((channel, change) => {
      const id = mcplChannelId(channel.guildId, channel.id);
      if (!change.admitted) {
        // Its threads are admitted through it, unless the filters list one.
        const gone = [id, ...this.registeredThreadsOf(channel.id).filter((d) => !this.admitted(d)).map((d) => d.id)];
        this.forgetChannels(gone.filter((g) => this.channelManager.get(g)));
      } else if (isListedKind(channel.type)) {
        this.registerChannels([this.guildDescriptor(channel)]);
      }
      // Only a new name, kind or category can change its threads' labels,
      // or give a name to another channel, or take one from it, and so can
      // a channel that's no longer stale, giving its guild's names back.
      if (change.addressChanged) {
        this.rederiveChannels(this.registeredThreadsOf(channel.id));
        this.rederiveNamed({ name: channel.name });
      }
    });

    // Bot joined a new guild after startup: register its existing channels
    // of a listed kind so they show up in the host's channel list
    // (channelCreate only covers channels created *after* the join).
    this.discord.onGuildCreate((guildId, channels) => {
      const { added } = this.registerChannels(channels.map((c) => this.guildDescriptor(c)));
      this.rederiveNamed('every');
      dbg('onGuildCreate', { guildId, total: channels.length, added: added.length });
    });

    // The bot left a guild, or was removed from it: what's registered there
    // is forgotten. Its channels still exist, so they keep their watermarks
    // and aren't remembered as deleted (deletedChannels). If the bot
    // rejoins, the guild's guildCreate registers its listed channels again,
    // as boot does, and its threads come back by their messages.
    this.discord.onGuildDelete((guildId) => {
      this.forgetChannels(this.registeredInGuild(guildId).map((d) => d.id));
      this.rederiveNamed('every');
    });

    // A guild back from an outage or a gateway gap: Discord doesn't replay
    // what happened while it was away, so the registry is reconciled with
    // what the guild has now (guildReturned).
    this.discord.onGuildAvailable((guildId, channels, present) => this.guildReturned(guildId, channels, present));

    // A guild's name is in every label of its channels.
    this.discord.onGuildRename((guildId) => {
      this.rederiveChannels(this.registeredInGuild(guildId));
      this.rederiveNamed('every');
    });

    // A registered thread that's archived is forgotten, so the registry
    // holds the live threads; the next message posted in it, which
    // unarchives it, registers it again. Its watermark stays, since it can
    // come back. A registered thread otherwise changed (renamed, locked) is
    // re-derived. An unregistered one waits for a message.
    this.discord.onThreadUpdate((thread) => this.threadReported(thread));

    // A fetch left a channel stale: its current name isn't known, so no
    // name in its guild resolves (resolveChannelRef), and the labels of the
    // channels a name addresses there are derived again, by id, as is its
    // own registration's, a thread's included. A registered thread under it
    // that isn't stale itself keeps its display-only label, with the names
    // it was registered with (knowsLessThan). Its fresh fetch derives them
    // again by name (onChannelRefreshed).
    this.discord.onChannelStale((channelId) => {
      const registered = this.channelManager.getAll()
        .filter((d) => (d.address as { channelId?: string } | undefined)?.channelId === channelId);
      if (registered.length > 0) this.rederiveChannels(registered);
      this.rederiveNamed('every');
    });

    this.discord.onChannelDelete((guildId, channelId, threadIds) => this.channelDeleted(guildId, channelId, threadIds));
    this.discord.onThreadDelete((guildId, threadId) => this.channelDeleted(guildId, threadId));
    // Discord synced a guild's threads (onThreadsSynced). A registered
    // thread it doesn't list is forgotten when its registration places it
    // under a channel the sync covers (any, for a whole-guild sync), or the
    // sync dropped it from the cache, which places a thread by the channel
    // the cache knew for it. It isn't remembered as deleted, since it may
    // only have been archived. A thread whose channel neither knows is under
    // none. A registered thread the sync lists is taken as updated.
    this.discord.onThreadsSynced((guildId, covered, listed, dropped) => {
      const channelOf = (d: ChannelDescriptor) => (d.address as { channelId: string }).channelId;
      const threads = this.registeredInGuild(guildId)
        .filter((d) => (d.metadata as { channelType?: string } | undefined)?.channelType === 'thread');
      const omitted = (d: ChannelDescriptor): boolean => {
        if (listed.has(channelOf(d))) return false;
        const parentId = (d.metadata as { parentId?: string } | undefined)?.parentId;
        return covered === null || dropped.has(channelOf(d)) || (parentId !== undefined && covered.has(parentId));
      };
      this.forgetChannels(threads.filter(omitted).map((d) => d.id));
      for (const d of threads) {
        if (!listed.has(channelOf(d))) continue;
        const facts = this.discord.getCachedChannelFacts(channelOf(d));
        if (facts) this.threadReported(facts);
      }
    });
    // A stale channel fetched fresh is taken as an update of it, since what
    // was derived from its older facts may be wrong in any of them: a thread
    // the fetch shows archived, or a channel it shows outside the filters,
    // is forgotten, as an update would forget it. Otherwise its registration
    // is derived again, with its threads' labels and the labels of channels
    // that share or shared its name.
    this.discord.onChannelRefreshed((channelId) => {
      const facts = this.discord.getCachedChannelFacts(channelId);
      if (!facts) return;
      const id = mcplChannelId(facts.guildId, channelId);
      const admitted = this.discord.channelAdmitted(facts.guildId, channelId, facts.parentId ?? null);
      if (facts.type === 'thread') {
        this.threadReported(facts);
        return;
      }
      if (!admitted) {
        const gone = [id, ...this.registeredThreadsOf(channelId).filter((d) => !this.admitted(d)).map((d) => d.id)];
        this.forgetChannels(gone.filter((g) => this.channelManager.get(g)));
      } else if (isListedKind(facts.type)) {
        this.registerChannels([this.guildDescriptor(facts)]);
      }
      this.rederiveChannels(this.registeredThreadsOf(channelId));
      this.rederiveNamed({ name: facts.name });
    });
  }

  /** Fetch + convert a message's attachments into MCPL content blocks so the
   *  agent actually sees them. Images are downloaded and inlined as base64
   *  image blocks (robust against Discord's expiring CDN URLs) — the text
   *  inline cap below deliberately does NOT apply to them; an image block is
   *  the model-native representation, not a text paste. Text files inline
   *  only up to attachmentInlineMaxBytes (issue #30), enforced on actual
   *  bytes: a declared-over-cap file skips the fetch entirely, and a
   *  misdeclared one is streamed to at most cap+1 bytes before degrading to
   *  a name+size+URL note. Anything else degrades to a short note with
   *  name + URL. Best-effort: a failed fetch becomes a note rather than
   *  dropping the message. */
  private async buildAttachmentBlocks(attachments: DiscordAttachment[]): Promise<ContentBlock[]> {
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
    /** Fetch a text body retaining at most maxBytes+1 bytes — Discord's
     *  declared size is advisory, so the inline decision has to come from
     *  what actually arrives, without buffering an arbitrarily large lie.
     *  A chunk larger than the remaining allowance is sliced to it before
     *  retention and the read cancelled immediately, so the bound is
     *  literal even for a single giant chunk. A bodyless response fails
     *  closed (treated as overflow) rather than full-buffering unknown
     *  data. overflow=true means the body exceeded maxBytes; its text is
     *  then unused (over-cap bytes must never become a text block).
     *  bytesRead reports actual bytes consumed off the wire, for budget
     *  accounting. */
    const fetchTextCapped = async (
      url: string,
      maxBytes: number,
      ms = 15000,
    ): Promise<{ text: string; overflow: boolean; bytesRead: number }> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) {
          return { text: '', overflow: true, bytesRead: 0 };
        }
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let retained = 0; // bytes held in chunks — never exceeds maxBytes + 1
        let bytesRead = 0; // bytes actually received, for budget accounting
        let overflow = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.length;
          const room = maxBytes + 1 - retained;
          const take = value.length > room ? value.subarray(0, room) : value;
          chunks.push(take);
          retained += take.length;
          if (retained > maxBytes) {
            overflow = true;
            break;
          }
        }
        if (overflow) {
          void reader.cancel().catch(() => {});
          return { text: '', overflow: true, bytesRead };
        }
        return { text: Buffer.concat(chunks).toString('utf8'), overflow: false, bytesRead };
      } finally {
        clearTimeout(timer);
      }
    };

    // Aggregate budget across the whole batch: the per-item ceilings bound
    // each attachment, but a multi-snapshot forward can carry many of them —
    // without a total cap one message could balloon the context payload.
    // Skipped items degrade to a name+URL note, same as other non-inlined.
    const AGGREGATE_FETCH_BUDGET = 40 * 1024 * 1024;
    let fetchBudgetLeft = AGGREGATE_FETCH_BUDGET;

    // Provenance marker: name the carrying forward. Numbered only when the
    // batch spans several snapshots — the common single-forward case stays
    // as a plain "(forwarded)".
    const multiSnapshot = attachments.some((a) => (a.forwardedSnapshotIndex ?? 0) > 1);
    const fwd = (att: DiscordAttachment) =>
      att.forwardedSnapshotIndex === undefined
        ? ''
        : multiSnapshot ? ` (forwarded #${att.forwardedSnapshotIndex})` : ' (forwarded)';

    // A Discord CDN URL is signed and stops working at its `ex` time, so each
    // marker says when, and the message says once how to get a fresh one.
    let linksExpire = false;
    const link = (att: DiscordAttachment) => {
      const expiry = attachmentUrlExpiry(att.url);
      if (!expiry) return att.url;
      linksExpire = true;
      return `${att.url} (link expires ${expiry.toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
    };

    const inlineCap = this.attachmentInlineMaxBytes;
    const blocks: ContentBlock[] = [];
    for (const att of attachments) {
      const ct = (att.contentType || '').toLowerCase();
      const isImage = ct.startsWith('image/');
      const isText =
        ct.startsWith('text/') ||
        TEXT_EXT.test(att.name) ||
        (att.contentType === null && att.size > 0 && att.size <= MAX_TEXT_BYTES);
      try {
        if (!isImage && isText && att.size > inlineCap) {
          // Declared size is already over the cap — no fetch at all. (A
          // misdeclared small size still gets caught below on actual bytes.)
          blocks.push(textContent(
            `[attachment: ${att.name}${fwd(att)} (${fmt(att.size)}) over the ${fmt(inlineCap)} inline cap — not inlined: ${link(att)}]`,
          ));
          dbg('attachment:over-inline-cap', { name: att.name, declaredSize: att.size, cap: inlineCap });
        } else if ((isImage || isText) && att.size > fetchBudgetLeft) {
          blocks.push(textContent(
            `[attachment: ${att.name}${fwd(att)} (${fmt(att.size)}) not inlined — message attachment budget exhausted: ${link(att)}]`,
          ));
          dbg('attachment:budget-exhausted', { name: att.name, size: att.size, budgetLeft: fetchBudgetLeft });
        } else if (isImage) {
          if (att.size > IMAGE_FETCH_CEILING) {
            blocks.push(textContent(`[image attachment "${att.name}"${fwd(att)} (${fmt(att.size)}) too large to fetch — ${link(att)}]`));
          } else {
            fetchBudgetLeft -= att.size;
            const res = await fetchWithTimeout(att.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = Buffer.from(await res.arrayBuffer());
            // Downsample to model-max on ingest (resize to ~1568px long edge,
            // re-encode under the inline cap). This also rescues images that
            // would previously be dropped for being over the old 4MB cap.
            const norm = await normalizeImageForInference(raw, att.contentType);
            if (norm) {
              blocks.push({ type: 'image', data: norm.data, mimeType: norm.mimeType } as ContentBlock);
              blocks.push(textContent(`[image attachment: ${att.name}${fwd(att)} — ${link(att)}]`));
            } else {
              blocks.push(textContent(`[image attachment "${att.name}"${fwd(att)} (${fmt(att.size)}) could not be inlined — ${link(att)}]`));
            }
          }
        } else if (isText) {
          // Budget is charged from bytes actually consumed, not Discord's
          // advisory size — the capped read bounds the overdraft past the
          // pre-check above to at most cap+1.
          const { text, overflow, bytesRead } = await fetchTextCapped(att.url, inlineCap);
          fetchBudgetLeft -= bytesRead;
          if (overflow) {
            // Declared size said it fit; the wire said otherwise. The cap is
            // a bound on actual bytes, so this degrades to a note too.
            blocks.push(textContent(
              `[attachment: ${att.name}${fwd(att)} (over the ${fmt(inlineCap)} inline cap; declared ${fmt(att.size)}) — not inlined: ${link(att)}]`,
            ));
            dbg('attachment:over-inline-cap', {
              name: att.name,
              declaredSize: att.size,
              cap: inlineCap,
              misdeclared: true,
            });
          } else {
            blocks.push(textContent(`[attachment: ${att.name}${fwd(att)} (${fmt(att.size)}) — ${link(att)}]\n${text}`));
          }
        } else {
          blocks.push(textContent(`[attachment: ${att.name}${fwd(att)} (${ct || 'unknown type'}, ${fmt(att.size)}) — not inlined: ${link(att)}]`));
        }
        dbg('attachment', {
          name: att.name,
          contentType: att.contentType,
          size: att.size,
          kind: isImage ? 'image' : isText ? 'text' : 'other',
        });
      } catch (err) {
        blocks.push(textContent(`[attachment: ${att.name}${fwd(att)} — could not fetch (${(err as Error).message}); ${link(att)}]`));
        dbg('attachment:failed', { name: att.name, error: (err as Error).message });
      }
    }
    if (linksExpire) {
      blocks.push(textContent('[Attachment links expire as marked; fetching the message again gives fresh links.]'));
    }
    return blocks;
  }

  private rememberCreate(messageId: string): CreateMemory {
    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    const mem: CreateMemory = { settled, resolve: () => { mem.done = true; resolve(); }, done: false, edits: 0 };
    this.recentCreates.set(messageId, mem);
    // The oldest settled ones go. A create still being sent stays, however
    // many come after it: an edit or delete must wait for it (afterCreate).
    while (this.recentCreates.size > RECENT_CREATES_MAX) {
      let evicted = false;
      for (const [id, m] of this.recentCreates) {
        if (m.done) {
          this.recentCreates.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
    return mem;
  }

  private async handleDiscordMessage(msg: DiscordMessageData): Promise<void> {
    // Registered synchronously, before any await: an edit or delete of this
    // message that arrives while the create is still being built (history
    // fetch, attachment download) waits for it instead of overtaking it.
    const mem = this.rememberCreate(msg.id);
    try {
      await this.forwardDiscordMessage(msg, mem);
    } finally {
      mem.resolve();
    }
  }

  private async forwardDiscordMessage(msg: DiscordMessageData, mem: CreateMemory): Promise<void> {
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

    // Muted channel: drop everything — ambient AND mentions/replies — before the
    // mention/auto-subscribe logic below, so a muted channel can neither wake the
    // agent nor auto-subscribe it back in.
    if (this.isChannelMuted(msg.channelId)) {
      dbg('handleDiscordMessage:drop', { reason: 'muted', channelId: msg.channelId });
      return;
    }

    // Direct address (mention or DM) always reaches Lena. For ambient
    // (non-direct) messages, only forward when the channel is open or in her
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
    const isExplicitMention =
      (botId !== null && msg.mentions.includes(botId)) || msg.mentionsBotRole === true;
    // Discord's "ping replied user" toggle controls only whether the bot
    // appears in msg.mentions; the reply itself is addressed to the bot
    // either way.
    const isReplyToBot = botId !== null && msg.replyToUserId === botId;
    const isBot = msg.isBot;
    // `isMention` (explicit OR reply) is retained for subscription-bypass /
    // backward compatibility only — the wake decision uses the granular
    // flags above via the gate.
    const isMention = isExplicitMention || isReplyToBot;
    if (!this.shouldEnterContext(msg.channelId, { isMention, isDM, guildId: msg.guildId })) {
      // If we're tracking this channel's missed-ambient (i.e. it was
      // unsubscribed), tally what we're dropping so the agent can ask later.
      // Skip the bot's own messages and chx no-op triggers (never "missed").
      this.ensureWatermarkLoaded();
      const tally = this.missedTally.get(msg.channelId);
      if (
        tally &&
        msg.authorId !== botId &&
        !msg.content.startsWith(CHX_NOOP_PREFIX)
      ) {
        tally.messages += 1;
        tally.characters += msg.cleanContent.length;
        tally.talliedThrough = msg.id;
        this.saveWatermark();
      }
      dbg('handleDiscordMessage:drop', {
        reason: 'ambient-not-subscribed',
        channelId: msg.channelId,
        channelName: msg.channelName,
        tracked: !!tally,
      });
      return;
    }

    // First-interaction handling is retained only for DMs. Guild mentions in
    // closed channels are deliberately one-shot push events: the host presents
    // an invitation and the agent chooses whether to open, including how much
    // history to request. Receiving a mention must not subscribe implicitly.
    this.ensureSubscriptionsLoaded();
    this.ensureWatermarkLoaded();
    const isFirstInteraction = !this.forwardedWatermark.has(msg.channelId);
    let prefixBlock = '';
    if (isFirstInteraction && isDM) {
      const watermark = this.forwardedWatermark.get(msg.channelId);
      let backscrollMsgs: Awaited<ReturnType<typeof this.discord.fetchHistory>> = [];
      try {
        backscrollMsgs = await this.discord.fetchHistory(msg.channelId, {
          limit: this.backscrollLimitFor(msg.channelId),
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
      // DMs have no subscription semantics. Give the agent an explicit reply
      // affordance on the first message from a person.
      blocks.push(
        `<system>Direct message from @${msg.authorName} (user id ${msg.authorId}). ` +
          `To reply, use send_dm("${msg.authorName}", content="your message") — or ` +
          `send_dm("${msg.authorId}", content="your message") if the name is ambiguous. ` +
          `The message text always travels in the "content" parameter; a send_dm with ` +
          `only userId sends nothing. DMs always reach you; there is nothing to subscribe to.</system>`,
      );
      if (backscrollMsgs.length > 0) {
        const attrs: string[] = [];
        if (msg.channelName) attrs.push(`channel="#${msg.channelName}"`);
        if (msg.guildName) attrs.push(`guild=${JSON.stringify(msg.guildName)}`);
        else if (isDM) attrs.push('dm="true"');
        attrs.push(`count="${backscrollMsgs.length}"`);
        const open = `<backscroll ${attrs.join(' ')}>`;
        const lines = backscrollMsgs.map((m) => {
          const ts = formatAgentDateTime(m.timestamp, AGENT_TIME_ZONE, AGENT_TIMESTAMP_STYLE);
          const att = m.attachments && m.attachments.length > 0
            ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]`
            : '';
          return `${ts ? `[${ts}] ` : ''}${m.authorName}: ${m.cleanContent}${att}${this.renderReactionState(m.reactions)}`;
        });
        blocks.push([open, ...lines, '</backscroll>'].join('\n'));
      }
      if (blocks.length > 0) {
        prefixBlock = blocks.join('\n') + '\n';
        dbg('backscroll:emitted', {
          channelId: msg.channelId,
          backscrollCount: backscrollMsgs.length,
          autoSubscribed: false,
        });
      }
    }

    const guildId = msg.guildId ?? 'dm';
    const channelMcplId = mcplChannelId(guildId, msg.channelId);

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
      // Discord-chosen names, rendered by the header rule (source-header.ts),
      // so one can't read as structure; a thread name is always quoted. A
      // channel name with a space is quoted too, so one can't carry this
      // prefix's own words (` in <guild>`): a text channel's name never has
      // one, but a voice, stage or forum channel's can.
      const locationParts: string[] = [];
      // Posted in a thread: the channel it hangs off, then the thread.
      const place = messagePlace(msg.channelName, msg);
      if (place.channel) {
        locationParts.push(`#${/\s/.test(place.channel) ? quotedValue(place.channel) : headerValue(place.channel)}`);
      }
      if (place.thread) locationParts.push(`thread ${quotedValue(place.thread)}`);
      if (msg.guildName) locationParts.push(`in ${headerValue(msg.guildName)}`);
      else if (msg.guildId === null) locationParts.push('DM');
      if (locationParts.length > 0) location = `[${locationParts.join(' ')}] `;
    }
    // A reply edge is part of the message's meaning, not hidden routing metadata.
    // Render a bounded structural marker into model-visible content so a nearby
    // "go ahead" cannot be mistaken for authorization addressed to the agent.
    // Keep the parent id even when Discord could not supply the author.
    const replyMarker = msg.replyToId
      ? `[replying to ${msg.replyToUserName ? `@${msg.replyToUserName}` : 'unknown author'}]\n`
      : '';
    const renderedContent = `${prefixBlock}${replyMarker}${location}${msg.authorName}: ${msg.cleanContent}`;
    // Advance the watermark so future backscroll on this channel doesn't
    // re-include this message. Set regardless of which forwarding path we
    // take below (channels/incoming vs push/event) — what matters is that
    // we forwarded it. Persist it (and the DM channel, if this is one) so the
    // reconnect catch-up sweep has a current anchor after a restart. Not for
    // a channel deleted while this message was on its way: the deletion
    // dropped its watermark, and there's nothing there to catch up on.
    if (isDM || !this.deletedLately(guildId, msg.channelId)) this.forwardedWatermark.set(msg.channelId, msg.id);
    if (isDM) this.dmChannelIds.add(msg.channelId);
    this.saveWatermark();
    // Update sticky-reply state: this inbound is now the "last
    // communication" for auto-reply routing, and the message we'd
    // replyTo on the next auto-send.
    this.lastChannelId = msg.channelId;
    this.lastInboundMessageId = msg.id;

    // Fetch + inline any attachments (images, text files) so the agent sees
    // them. Built once and appended to whichever forwarding path we take.
    const attachmentBlocks =
      msg.attachments.length > 0 ? await this.buildAttachmentBlocks(msg.attachments) : [];

    // Register the channel the message was posted in, or re-derive what's
    // registered (a rename, a name learned since), so the host knows it (its
    // label, and where a publish lands) before this message reaches it. A
    // DM's author is its other party (the bot's own messages don't come
    // through here), so their name labels it. A guild channel the listings
    // leave out is registered here: every thread, by its messages, so only
    // threads with activity are, never a server's whole thread archive.
    // Registered after the last await, and whether the channel is open read
    // then too, so the delivery names what's registered when it goes out,
    // judged by what's newest (registerGuildDelivery): a thread archived
    // after this message was posted stays archived, and a channel deleted, a
    // guild left, or a channel its guild came back without, while the
    // attachments were fetched, isn't registered.
    const guildDelivery = isDM
      ? undefined
      : this.registerGuildDelivery(guildId, msg.channelId, { postedAt: msg.timestamp.getTime() });
    const registeredId = guildDelivery
      ? guildDelivery.id
      : this.registerDmDelivery(msg.channelId, { id: msg.authorId, name: msg.authorName });
    const channelIsOpen = this.channelManager.isOpen(channelMcplId);
    dbg('handleDiscordMessage:forwarding', {
      channelMcplId,
      registeredId,
      channelIsOpen,
      path: channelIsOpen ? 'channels/incoming' : 'push/event',
    });

    // MCPL RFC-001 event tags — emit reserved chat:* core (umbrellas included,
    // so no host-side implication expansion is needed) derived from the address
    // flags computed above. The host's wake gate routes on these.
    const eventTags: string[] = (() => {
      const t = new Set<string>();
      if (isExplicitMention) t.add('chat:mention');
      if (isReplyToBot) t.add('chat:reply');
      if (isDM) { t.add('chat:dm'); t.add('chat:private'); }
      t.add(isMention || isDM ? 'chat:addressed' : 'chat:ambient');
      t.add(isBot ? 'chat:from-bot' : 'chat:from-human');
      for (const tag of threadTags(msg)) t.add(tag);
      for (const a of msg.attachments) {
        const ct = (a.contentType || '').toLowerCase();
        if (ct.startsWith('image/')) t.add('chat:has-image');
        else if (ct.startsWith('audio/')) t.add('chat:has-audio');
        else t.add('chat:has-file');
      }
      return [...t];
    })();

    // Without the closed channel's note (below): the gate admits an edit,
    // when it arrives, only while its channel is open or subscribed
    // (forwardMessageEdit), so an edit that replaces this create normally
    // comes once the note no longer holds. Admission is checked when an
    // edit arrives, not when it's sent, so one admitted while the channel
    // was open can follow a close during this create's attachment fetch,
    // and replace a create pushed with the note.
    mem.render = {
      prefix: prefixBlock, replyMarker, location, authorName: msg.authorName,
      attachments: rememberedAttachments(attachmentBlocks),
    };

    // If this channel is open, use channels/incoming
    if (channelIsOpen) {
      // channels/incoming is channel scope by definition (RFC-006 §3.2).
      mem.scope = channelMcplId;
      const message: CoalescedIncomingMessage = {
          channelId: channelMcplId,
          messageId: msg.id,
          // RFC-006: the create is the subject's first occurrence (`initial`),
          // keyed by the stable platform message id so later edits/deletes —
          // which always arrive as push/event — address the same subject.
          ...(this.hostCoalescing?.channelsIncoming
            ? { eventId: `discord_msg_${msg.id}`, coalesce: { key: `message:${msg.id}`, initial: true } }
            : {}),
          // No MCPL threadId: it means a thread WITHIN the channel, and a
          // Discord thread is its own channel, already named by channelId.
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: [textContent(renderedContent), ...attachmentBlocks],
          metadata: {
            mentions: msg.mentions,
            replyTo: msg.replyToId,
            replyToAuthorId: msg.replyToUserId ?? undefined,
            replyToAuthorName: msg.replyToUserName ?? undefined,
            channelName: msg.channelName,
            guildName: msg.guildName,
            ...threadFields(msg),
            rawContent: msg.content,
            isMention,
            isExplicitMention,
            isReplyToBot,
            isBot,
            isDM,
          },
          tags: eventTags,
      };
      await this.deliverCreate({
        lane: 'channels/incoming',
        conn,
        coalesced: (message as { coalesce?: unknown }).coalesce !== undefined,
        // Registered, as an open channel is.
        channel: channelMcplId,
        discordChannelId: msg.channelId,
        // channels/incoming is for an open channel: the host connected since
        // takes it only if it has the channel open too.
        fits: () => (this.channelManager.isOpen(channelMcplId) ? undefined : "its channel isn't open with the host connected now"),
        messageId: msg.id,
        channelMcplId,
        content: message.content,
        attachmentBlocks,
        mem,
        send: async (conn, content, resend) => {
          const params: ChannelsIncomingParams = {
            messages: [{
              ...message,
              content,
              // A refused item was never admitted (the host validates before
              // its coalescer accepts, so no receipt or subject exists for
              // it); a fresh occurrence id still keeps the resend clear of
              // any receipt or dedup keyed on the first one.
              ...(resend && message.eventId ? { eventId: `${message.eventId}_media_omitted` } : {}),
            } as CoalescedIncomingMessage],
          };
          try {
            return incomingOutcome(await conn.sendRequest(method.CHANNELS_INCOMING, params), msg.id);
          } catch (err) {
            return sendErrorOutcome(err);
          }
        },
      });
    } else {
      // Otherwise, use push/event.
      //
      // Closed channel: attach the missed-ambient tally (when tracked) so the
      // host's closed-channel invitation can show what staying out has cost —
      // replying without opening the channel is only an informed choice when the invisible
      // traffic is visible as a number (2026-08-05: Sol answered four
      // #architecture mentions over four days while the follow-ups to her own
      // replies fell into the tally, with nothing surfacing that fact).
      // Counts exclude this (addressed) message and all prior mentions/DMs —
      // those were delivered.
      const missed = this.missedTally.get(msg.channelId);
      // The note, for a guild channel this delivery registered, whose gate
      // now admits a message only when it addresses the agent.
      const closedNote = guildDelivery ? this.closedChannelNote(guildId, msg.channelId, guildDelivery) : '';
      const scope = this.coalesceChannelScope(msg.guildId, msg.channelId);
      mem.scope = scope ?? null;
      const pushParams: CoalescedPushEventParams = {
        featureSet: 'discord.messaging',
        eventId: `discord_msg_${msg.id}`,
        // RFC-006: channel-scoped when the host accepts that and the channel is
        // declared (guild channels at registration, DMs announced just above),
        // so an edit or delete addresses the same subject whichever lane
        // delivered the create.
        ...(this.hostCoalescing?.pushEvents
          ? { coalesce: { key: `message:${msg.id}`, initial: true, ...(scope ? { channelId: scope } : {}) } }
          : {}),
        timestamp: msg.timestamp.toISOString(),
        origin: {
          source: 'discord',
          messageId: msg.id,
          guildId: msg.guildId,
          guildName: msg.guildName,
          channelId: msg.channelId,
          // The MCPL composite channel id (`discord:{guild|dm}:{channel}`) — the
          // form the host registers and routes replies to. Raw `channelId` above
          // is Discord-internal; DMs especially only ever arrive via push/event
          // (channel closed), so without this the host can't route a reply back
          // to the DM (item-3 redux, DM sub-case). Named when the channel is
          // registered (registerGuildDelivery and registerDmDelivery say when
          // it isn't).
          ...(registeredId ? { mcplChannelId: registeredId } : {}),
          channelName: msg.channelName,
          // Display only; the composite channel id already names the thread.
          ...threadFields(msg),
          authorId: msg.authorId,
          authorName: msg.authorName,
          replyTo: msg.replyToId,
          replyToAuthorId: msg.replyToUserId ?? undefined,
          replyToAuthorName: msg.replyToUserName ?? undefined,
          isMention,
          isExplicitMention,
          isReplyToBot,
          isBot,
          isDM,
          ...(missed
            ? { missedMessages: missed.messages, missedCharacters: missed.characters }
            : {}),
        } as Record<string, unknown>,
        tags: eventTags, // MCPL RFC-001 — the host routes/gates on these
        payload: {
          content: [textContent(`${closedNote}${renderedContent}`), ...attachmentBlocks],
        },
      };

      await this.deliverCreate({
        lane: 'push/event',
        conn,
        coalesced: pushParams.coalesce !== undefined,
        channel: registeredId,
        discordChannelId: msg.channelId,
        fits: () => pushFits(pushParams, this.hostCoalescing),
        messageId: msg.id,
        channelMcplId,
        content: pushParams.payload.content,
        attachmentBlocks,
        mem,
        send: async (conn, content, resend) => {
          const params: CoalescedPushEventParams = {
            ...pushParams,
            // See the channels/incoming resend above: a fresh occurrence id.
            ...(resend ? { eventId: `${pushParams.eventId}_media_omitted` } : {}),
            payload: { content },
          };
          try {
            return pushOutcome(await conn.sendRequest(method.PUSH_EVENT, params as unknown as Record<string, unknown>));
          } catch (err) {
            return sendErrorOutcome(err);
          }
        },
      });
    }
  }

  /**
   * Send one message create to the host and read its verdict: sending is not
   * delivering. A host can refuse a message per item (channels/incoming
   * `results[]`, push/event `{accepted:false}`) or with a JSON-RPC error, and
   * the refused message never reaches the agent, its text included.
   *
   * - Every send here, the create and a resend without media, goes through
   *   sendWithRetries: an answer that leaves it worth sending again, by what
   *   the MCPL spec defines (answerClass), sends the same occurrence again.
   * - Accepted, or answered without a per-message verdict (an older host):
   *   `handleDiscordMessage:sent`, with `result`.
   * - Refused, by a result or by an error the host answered with
   *   (errorRejection): one `[discord-mcpl] host rejected message …` stderr
   *   line and `handleDiscordMessage:rejected` with the reason, an error's
   *   code, and what the message carried inline. channels/incoming answers
   *   each message without a code, so there the host's own failure reads the
   *   same as a refusal, and the line says `host didn't take message …`.
   * - Refused as malformed (isContentRejection) while carrying inline
   *   images/audio: resent ONCE, as a new occurrence, with each inline block
   *   replaced by a text note, so the text, and the fact that media was
   *   attached, still reach the agent. A compatibility measure for
   *   agent-framework's hosts before 0.22.2, which gave that answer to
   *   content over 1 MiB; see isContentRejection.
   * - No verdict after the resends sendWithRetries allows (no answer, a
   *   closed connection, the host's own failure): `[discord-mcpl] <lane>
   *   failed:` and `handleDiscordMessage:send-failed`.
   */
  private async deliverCreate(args: {
    lane: 'channels/incoming' | 'push/event';
    /** The connection the create is first sent on. */
    conn: McplConnection;
    /** Whether the occurrence carries `coalesce` (sendWithRetries). */
    coalesced: boolean;
    /** The registered MCPL channel the occurrence names, if any. */
    channel: string | undefined;
    /** The Discord channel the message was posted in. */
    discordChannelId: string;
    /** Why the occurrence doesn't fit the host connected now (sendWithRetries). */
    fits: () => string | undefined;
    messageId: string;
    channelMcplId: string;
    content: ContentBlock[];
    /** The create's attachment blocks, as `content` carries them. */
    attachmentBlocks: ContentBlock[];
    mem: CreateMemory;
    send: (conn: McplConnection, content: ContentBlock[], resend: boolean) => Promise<SendOutcome>;
  }): Promise<void> {
    const { lane, coalesced, channel, fits, discordChannelId, messageId, channelMcplId, content, attachmentBlocks, mem, send } = args;
    const { outcome: first, conn } = await this.sendWithRetries({
      lane, coalesced, channel, fits, conn: args.conn,
      what: `message ${messageId} in ${channelMcplId}`,
      dbgPrefix: 'handleDiscordMessage',
      attempt: (c) => send(c, content, false),
    });
    if (first.kind === 'failed') {
      console.error(`[discord-mcpl] ${lane} failed:`, first.error);
      dbg('handleDiscordMessage:send-failed', { method: lane, error: first.error });
      this.owe(discordChannelId, messageId, { uncertain: true });
      return;
    }
    if (first.kind !== 'rejected') {
      dbg('handleDiscordMessage:sent', { method: lane, channelMcplId, result: first.kind });
      // The host takes messages here again: what it didn't take before follows.
      if (this.owed.has(discordChannelId)) {
        void this.deliverOwedIn(conn, discordChannelId, 'live').catch((err) => {
          console.error('[discord-mcpl] Delivering owed messages failed:', errorText(err));
        });
      }
      return;
    }
    // channels/incoming answers each message without a code, so there the
    // host's own failure ("host is stopping", say) reads the same as a
    // refusal, and that lane's line says only that the host didn't take the
    // message.
    const verb = (code: number | undefined) => (lane === 'channels/incoming' && code === undefined ? "didn't take" : 'rejected');
    const attachments = summarizeAttachments(content);
    console.error(`[discord-mcpl] host ${verb(first.code)} message ${messageId} in ${channelMcplId}: ${first.reason}`);
    dbg('handleDiscordMessage:rejected', {
      method: lane, messageId, channelMcplId, reason: first.reason,
      ...(first.code !== undefined ? { code: first.code } : {}),
      attachments,
    });
    if (answerClass(first) === 'refused') this.owe(discordChannelId, messageId, { uncertain: false });
    if (!isContentRejection(first) || attachments.inline === 0) return;

    const stripped = withoutInlineMedia(content);
    // An edit that replaces this create re-renders the attachments the create
    // remembers. From here they are the ones resent, notes and links, so the
    // edit doesn't carry back the media the host refused. While the resent
    // blocks fit RECENT_CREATE_ATTACHMENT_BYTES it keeps the note and the link
    // the agent was sent, which the memory of a create over that size held
    // only as a placeholder.
    if (mem.render) mem.render.attachments = rememberedAttachments(withoutInlineMedia(attachmentBlocks).content);
    const { outcome: second } = await this.sendWithRetries({
      lane, coalesced, channel, fits, conn,
      what: `message ${messageId} in ${channelMcplId} (resent without inline media)`,
      dbgPrefix: 'handleDiscordMessage',
      attempt: (c) => send(c, stripped.content, true),
    });
    const what = `message ${messageId} in ${channelMcplId} with ${stripped.replaced} inline attachment(s) replaced by a note`;
    if (second.kind === 'failed') {
      console.error(`[discord-mcpl] resent ${what}: send failed: ${second.error}`);
      dbg('handleDiscordMessage:resend-failed', { method: lane, messageId, channelMcplId, error: second.error });
      this.owe(discordChannelId, messageId, { uncertain: true });
    } else if (second.kind === 'rejected') {
      console.error(`[discord-mcpl] resent ${what}: host ${verb(second.code)} it again: ${second.reason}`);
      if (answerClass(second) === 'refused') this.owe(discordChannelId, messageId, { uncertain: false });
      dbg('handleDiscordMessage:resend-rejected', {
        method: lane, messageId, channelMcplId, reason: second.reason,
        ...(second.code !== undefined ? { code: second.code } : {}),
      });
    } else {
      console.error(`[discord-mcpl] resent ${what}: ${second.kind === 'accepted' ? 'accepted' : 'sent (no verdict)'}`);
      dbg('handleDiscordMessage:resent', { method: lane, messageId, channelMcplId, replaced: stripped.replaced, result: second.kind });
    }
  }

  /** The retry window (RFC-006 §3.1) of the current host for `lane`: what it
   *  advertises, or the spec's default hour, when it advertises event
   *  coalescing for that lane; undefined when it doesn't. */
  private retryWindowFor(lane: 'channels/incoming' | 'push/event'): number | undefined {
    const c = this.hostCoalescing;
    const coalesces = lane === 'channels/incoming' ? c?.channelsIncoming : c?.pushEvents;
    return coalesces ? (this.hostRetryWindowMs ?? DEFAULT_RETRY_WINDOW_MS) : undefined;
  }

  /** `conn`'s start-up has settled (serve()): wake whatever waits for a
   *  ready connection. Nothing when another connection has replaced it. */
  private markReady(conn: McplConnection): void {
    if (this.conn !== conn || conn.isClosed) return;
    this.readyConn = conn;
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const wake of waiters) wake();
  }

  /** The current connection, when its start-up has settled and it takes
   *  Discord messages (MCPL, `discord.messaging` enabled); else null. */
  private readyNow(): McplConnection | null {
    const conn = this.conn;
    if (!conn || conn !== this.readyConn || conn.isClosed) return null;
    if (!this.mcplEnabled || !isEnabled('discord.messaging', this.enabledFeatureSets)) return null;
    return conn;
  }

  /** readyNow, waiting until `deadline` (epoch ms) for a connection to
   *  become ready; when there is none by then, or the ready one doesn't take
   *  Discord messages, why not. */
  private async readyConnection(deadline: number): Promise<McplConnection | string> {
    for (;;) {
      const conn = this.readyNow();
      if (conn) return conn;
      const current = this.conn;
      if (current && current === this.readyConn && !current.isClosed) {
        return "the host connected now doesn't take Discord messages";
      }
      const left = deadline - Date.now();
      if (left <= 0) return 'no host connection was ready in time';
      await new Promise<void>((resolve) => {
        const wake = (): void => { clearTimeout(timer); this.readyWaiters.delete(wake); resolve(); };
        // Not unref'd: the wait is bounded by the deadline, and a stdio
        // server exits on its own when its host goes (serveStdio).
        const timer = setTimeout(wake, left);
        this.readyWaiters.add(wake);
      });
    }
  }

  /** readyConnection for an occurrence that holds its content while it
   *  waits: at once when a connection is ready, else waiting only while
   *  fewer than maxWaitingForHost others do. */
  private async waitForHost(deadline: number): Promise<McplConnection | string> {
    const now = this.readyNow();
    if (now) return now;
    if (this.waitingForHost >= this.maxWaitingForHost) {
      return `as many messages as may wait for a host (${this.maxWaitingForHost}) already are`;
    }
    this.waitingForHost++;
    try {
      return await this.readyConnection(deadline);
    } finally {
      this.waitingForHost--;
    }
  }

  /** Announce a registered channel to the host again (channels/changed
   *  `added`), when it is registered here. */
  private reannounceChannel(conn: McplConnection, id: string): boolean {
    const descriptor = this.channelManager.get(id);
    if (!descriptor || conn.isClosed) return false;
    conn.sendNotification(method.CHANNELS_CHANGED, { added: [descriptor] });
    return true;
  }

  /**
   * Send an occurrence and, while its answer leaves it worth sending again,
   * send the SAME occurrence again (`attempt` sends the same params: the same
   * eventId and coalesce member). What decides is only what the MCPL spec
   * defines (answerClass), never a particular host's words, since this
   * server serves more than one kind of host:
   *
   * - `unknown-channel` (-32023): the channel is announced to the host again
   *   (channels/changed) and the occurrence sent once more, at once. The host
   *   didn't admit it, so that can't make a duplicate, on any host.
   * - `refused` (a refusal the spec gives no meaning): sent once more, after
   *   the first wait.
   * - `uncertain` (no answer, -32603, an implementation-defined server
   *   error): sent again after each wait in retryDelaysMs while answers stay
   *   uncertain.
   *
   * `refused` and `uncertain` occurrences are sent again only when they carry
   * `coalesce` to a host that advertises event coalescing for their lane.
   * RFC-006 §3.1 then obliges the host to recognize a repeated eventId for
   * its retry window and return the first result without repeating its
   * effects, so an occurrence admitted after all is never admitted twice.
   * Other hosts promise less (the base spec's deduplication is a SHOULD,
   * §9.4), and get each occurrence once. Resends stop at half the window
   * after the first send (the spec's limit is the window itself; half leaves
   * room for a slow last answer), over the shortest window advertised
   * meanwhile, as §3.1 asks.
   *
   * A permission refusal (isAuthorityRefusal) answered before the
   * connection's start-up had settled is "not yet": a host denies with them
   * until its §5.3 policy is in place. The occurrence wasn't admitted, so it
   * is sent once more, on any host, once a connection is ready.
   *
   * A resend goes to the current connection once it is ready
   * (readyConnection), waiting at most reconnectWaitMs for one: after a
   * reconnect, the host connected since (§3.1's guarantee survives
   * reconnects and host restarts; only the TCP transport reconnects, as a
   * stdio server exits with its host). Never to a host that doesn't
   * advertise coalescing for the lane, and never when the occurrence,
   * built for the first host, doesn't fit the one connected now (`fits`).
   * `superseded`, when given, is asked before each resend, and a superseded
   * occurrence isn't sent again.
   *
   * A resend reaches the host after messages that came after it, each with
   * its own timestamp; the waits are kept short for that reason (1 s, 5 s,
   * 30 s, and at most reconnectWaitMs for a host to come back).
   *
   * Returns the last answer and the connection it came on.
   */
  private async sendWithRetries(args: {
    lane: 'channels/incoming' | 'push/event';
    what: string;
    dbgPrefix: 'handleDiscordMessage' | 'handleMessageMutation';
    conn: McplConnection;
    coalesced: boolean;
    channel: string | undefined;
    attempt: (conn: McplConnection) => Promise<SendOutcome>;
    superseded?: () => boolean;
    /** Why the occurrence, built for the host it was first sent to, doesn't
     *  fit the host connected now, or undefined when it does. Asked before
     *  it goes to a connection other than the last one. */
    fits?: () => string | undefined;
  }): Promise<{ outcome: SendOutcome | { kind: 'superseded' }; conn: McplConnection }> {
    const { lane, what, dbgPrefix, coalesced, channel, attempt, superseded, fits } = args;
    let conn = args.conn;
    const firstSentAt = Date.now();
    let windowMs = this.retryWindowFor(lane);
    let sentBeforeReady = conn !== this.readyConn;
    let outcome = await attempt(conn);
    let resends = 0;
    let refusals = 0;
    let announced = false;
    let notYetResent = false;
    const said = (o: SendOutcome): string => describeOutcome(o, lane);
    const notResent = (why: string): void => {
      console.error(`[discord-mcpl] ${what}: ${said(outcome)}; not sent again: ${why}`);
      dbg(`${dbgPrefix}:not-resent`, { method: lane, what, result: outcome.kind, why });
    };
    for (;;) {
      const answer = answerClass(outcome);
      if (answer === 'done') return { outcome, conn };
      if (superseded?.()) {
        if (answer === 'final') return { outcome, conn };
        notResent('a later edit or delete of the message has been sent since');
        return { outcome: { kind: 'superseded' }, conn };
      }
      if (answer === 'final') {
        if (!sentBeforeReady || notYetResent || !isAuthorityRefusal(outcome)) return { outcome, conn };
        notYetResent = true;
        const ready = await this.waitForHost(Date.now() + this.reconnectWaitMs);
        if (typeof ready === 'string') {
          notResent(ready);
          return { outcome, conn };
        }
        if (superseded?.()) {
          notResent('a later edit or delete of the message has been sent since');
          return { outcome: { kind: 'superseded' }, conn };
        }
        const misfit = ready !== conn ? fits?.() : undefined;
        if (misfit) {
          notResent(misfit);
          return { outcome, conn };
        }
        console.error(`[discord-mcpl] ${what}: ${said(outcome)}, before the host's start-up had settled; sending the same occurrence again now that it has`);
        dbg(`${dbgPrefix}:resend`, { method: lane, what, answer: 'not-yet' });
        conn = ready;
        sentBeforeReady = false;
        outcome = await attempt(conn);
        console.error(`[discord-mcpl] sent ${what} again (same event id): ${said(outcome)}`);
        continue;
      }
      if (answer === 'unknown-channel') {
        if (announced || channel === undefined || !this.reannounceChannel(conn, channel)) return { outcome, conn };
        announced = true;
        console.error(`[discord-mcpl] ${what}: ${said(outcome)}; announced channel ${channel} to the host again, and sending the same occurrence again`);
        dbg(`${dbgPrefix}:resend`, { method: lane, what, answer, channel });
        sentBeforeReady = conn !== this.readyConn;
        outcome = await attempt(conn);
        console.error(`[discord-mcpl] sent ${what} again (same event id): ${said(outcome)}`);
        continue;
      }
      if (!coalesced || windowMs === undefined) return { outcome, conn };
      if (answer === 'refused' && ++refusals > 1) return { outcome, conn };
      if (resends >= this.retryDelaysMs.length) {
        notResent(`sent ${resends + 1} times`);
        return { outcome, conn };
      }
      // A resend whose wait wouldn't end before the deadline isn't sent:
      // cutting the wait short would send a burst of resends at the end.
      const deadline = firstSentAt + windowMs / 2;
      const wait = this.retryDelaysMs[resends];
      if (Date.now() + wait > deadline) {
        notResent("the host's retry window is closing");
        return { outcome, conn };
      }
      console.error(`[discord-mcpl] ${what}: ${said(outcome)}; sending the same occurrence again (same event id) in ${wait}ms`);
      dbg(`${dbgPrefix}:resend-wait`, { method: lane, what, answer, waitMs: wait, resend: resends + 1 });
      await sleep(wait);
      if (superseded?.()) {
        notResent('a later edit or delete of the message has been sent since');
        return { outcome: { kind: 'superseded' }, conn };
      }
      const next = await this.waitForHost(Math.min(deadline, Date.now() + this.reconnectWaitMs));
      if (typeof next === 'string') {
        notResent(next);
        return { outcome, conn };
      }
      const nextWindow = this.retryWindowFor(lane);
      if (nextWindow === undefined) {
        notResent("the host now connected doesn't coalesce events, so the same occurrence sent again could be a duplicate");
        return { outcome, conn };
      }
      windowMs = Math.min(windowMs, nextWindow);
      if (superseded?.()) {
        notResent('a later edit or delete of the message has been sent since');
        return { outcome: { kind: 'superseded' }, conn };
      }
      const moved = next !== conn;
      const misfit = moved ? fits?.() : undefined;
      if (misfit) {
        notResent(misfit);
        return { outcome, conn };
      }
      conn = next;
      resends++;
      sentBeforeReady = false;
      outcome = await attempt(conn);
      console.error(`[discord-mcpl] sent ${what} again (same event id${moved ? ', to the host connected since' : ''}): ${said(outcome)}`);
      dbg(`${dbgPrefix}:resent-same`, { method: lane, what, result: outcome.kind, resend: resends, newConnection: moved });
    }
  }

  /**
   * Send an edit or delete (fire-and-forget: nothing waits on it) and read the
   * host's verdict: a refusal is logged; a failed send stays in the debug
   * log, as before. While its answer leaves it worth sending again, it is
   * (sendWithRetries), unless a later edit or delete of the message has gone
   * out since, which supersedes it: the later occurrence replaces or
   * withdraws the subject, and sending the earlier one again after it would
   * put the older version back.
   */
  private noteMutationOutcome(
    kind: 'edit' | 'delete',
    messageId: string,
    discordChannelId: string,
    channel: string,
    registeredId: string | undefined,
    conn: McplConnection,
    params: CoalescedPushEventParams,
  ): void {
    const seq = ++this.mutationSeq;
    const inFlight = this.mutationsInFlight.get(messageId) ?? { latest: 0, unsettled: 0 };
    inFlight.latest = seq;
    inFlight.unsettled++;
    this.mutationsInFlight.set(messageId, inFlight);

    void (async () => {
      try {
        const { outcome } = await this.sendWithRetries({
          lane: 'push/event',
          what: `${kind} of message ${messageId} in ${channel}`,
          dbgPrefix: 'handleMessageMutation',
          conn,
          coalesced: params.coalesce !== undefined,
          channel: registeredId,
          superseded: () => inFlight.latest !== seq,
          fits: () => pushFits(params, this.hostCoalescing),
          attempt: async (c) => {
            try {
              return pushOutcome(await c.sendRequest(method.PUSH_EVENT, params as unknown as Record<string, unknown>));
            } catch (err) {
              return sendErrorOutcome(err);
            }
          },
        });
        if (outcome.kind === 'accepted' || outcome.kind === 'no-result') {
          // The host has the message as it is now (or its deletion): what was
          // owed for it is no longer.
          if (this.owed.get(discordChannelId)?.some((o) => o.id === messageId)) this.forgetOwed(discordChannelId, [messageId]);
        } else if (outcome.kind === 'rejected') {
          console.error(`[discord-mcpl] host rejected ${kind} of message ${messageId} in ${channel}: ${outcome.reason}`);
          dbg('handleMessageMutation:rejected', { kind, messageId, channel, reason: outcome.reason, ...(outcome.code !== undefined ? { code: outcome.code } : {}) });
          // An edit not taken leaves the agent an older version: the message
          // is owed as Discord has it. A delete's isn't: there is nothing
          // left on Discord to deliver.
          if (kind === 'edit' && answerClass(outcome) === 'refused') this.owe(discordChannelId, messageId, { uncertain: false, edit: true });
        } else if (outcome.kind === 'failed') {
          // The host's own error reaches the operator, as its refusals do; no
          // answer (a timeout, a closed connection) stays quiet, as before.
          if (outcome.hostError) console.error(`[discord-mcpl] host failed ${kind} of message ${messageId} in ${channel}: ${outcome.error}`);
          dbg('handleMessageMutation:send-failed', { kind, messageId, channel, error: outcome.error });
          if (kind === 'edit') this.owe(discordChannelId, messageId, { uncertain: true, edit: true });
        }
      } finally {
        if (--inFlight.unsettled === 0 && this.mutationsInFlight.get(messageId) === inFlight) {
          this.mutationsInFlight.delete(messageId);
        }
      }
    })();
  }
}

/** A forwarded occurrence's outcome: the host's answer, or no answer
 *  (`failed`: a timeout, a closed connection, the host's own failure). */
type SendOutcome = ForwardOutcome | { kind: 'failed'; error: string; hostError?: true };

/** An outcome as the log lines put it. A refusal without a code reads as
 *  "didn't take" on channels/incoming, where a host's own failure comes back
 *  the same way, and as "rejected" otherwise, as deliverCreate's lines say. */
function describeOutcome(outcome: SendOutcome | { kind: 'superseded' }, lane: 'channels/incoming' | 'push/event'): string {
  switch (outcome.kind) {
    case 'accepted': return 'accepted';
    case 'no-result': return 'sent (no verdict)';
    case 'rejected': return `host ${lane === 'channels/incoming' && outcome.code === undefined ? "didn't take it" : 'rejected it'}: ${outcome.reason}`;
    case 'failed': return `send failed: ${outcome.error}`;
    case 'superseded': return 'superseded';
  }
}

/** Why a push built for one host doesn't fit the host connected now: one
 *  scoped to a channel (`coalesce.channelId`) goes only to a host that
 *  advertises channel-scoped pushes (RFC-006 §10; another refuses it as
 *  malformed, §13). */
function pushFits(
  params: CoalescedPushEventParams,
  coalescing: { channelScopedPush?: boolean } | null | undefined,
): string | undefined {
  const scoped = (params.coalesce as { channelId?: unknown } | undefined)?.channelId !== undefined;
  return scoped && !coalescing?.channelScopedPush
    ? "the host connected now doesn't take channel-scoped pushes, and this one is scoped to its channel"
    : undefined;
}

/** A request's error, read as the host's verdict: its refusal
 *  (errorRejection), or a failed send. */
function sendErrorOutcome(err: unknown): SendOutcome {
  const rejection = errorRejection(err);
  if (rejection) return { kind: 'rejected', ...rejection };
  return { kind: 'failed', error: errorText(err), ...(hostAnsweredWithError(err) ? { hostError: true as const } : {}) };
}

/** Whether an error is the host's answer (a JSON-RPC error it sent), not
 *  mcpl-core's own timeout (an RpcError with -32000 in 0.2.1, "Request
 *  timed out after <n>ms: <method>"; ConnectionTimeoutError later) or a
 *  closed connection. */
function hostAnsweredWithError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; name?: unknown } | null | undefined;
  if (!e || typeof e.code !== 'number') return false;
  if (e.name === 'ConnectionTimeoutError') return false;
  return !(typeof e.message === 'string' && /Request timed out after \d+ms/.test(e.message));
}

/** A Discord id as a number, or null when it isn't one. */
function snowflake(id: string): bigint | null {
  return /^\d+$/.test(id) ? BigInt(id) : null;
}

/** Order Discord ids oldest first (others by their text). */
function compareSnowflakes(a: string, b: string): number {
  const x = snowflake(a);
  const y = snowflake(b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  return a.localeCompare(b);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** Serve a stdio host until its connection ends, then exit. A stdio server
 *  can't be reached again once its host has gone, so it exits, as MCP's
 *  stdio shutdown expects (the client closes the server's stdin, then waits
 *  for it to exit), rather than stay logged in to Discord with no host. The
 *  status is 0 whatever ended the connection: a host that goes away, before
 *  initialize or after, is a normal end. `exit` is process.exit, given here
 *  so a test can watch it. */
export async function serveStdio(
  server: DiscordMcplServer,
  conn: McplConnection,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  await server.serve(conn);
  console.error('[discord-mcpl] stdio connection ended; exiting');
  exit(0);
}

/**
 * Serve MCPL clients on a listening TCP server, one at a time, for as long as
 * the process runs. It owns the server's 'connection' and 'error' events for
 * the server's life, which a one-at-a-time server needs: mcpl-core's
 * `acceptTcp` takes a single connection, and leaves no listener that logs
 * the server's errors.
 *
 * - A client that connects while none is served is served: `serve` runs with
 *   its connection, and once `serve` settles, whether it resolves, rejects
 *   or throws, the connection is closed and the next client can be served.
 *   A rejection or a throw is logged. A client counts as served until then,
 *   after its socket has closed too.
 * - A client that connects while another is served is refused: its socket
 *   is destroyed at once, and the refusal logged. Its 'error' listener goes
 *   on first, so nothing that socket reports can go unheard.
 * - An 'error' the server emits (an accept that fails, say) is logged
 *   whenever it comes, and serving goes on: Node's server keeps listening.
 *
 * A read error on the served client's own socket (a reset, say) still ends
 * the process: it also reaches mcpl-core's readline interface, which listens
 * for none (see serve()).
 *
 * The server must be listening already, or this throws: a failure to listen
 * (a port already taken) belongs to the caller, and with the 'error'
 * listener added here it would only be logged, and the caller would wait for
 * a 'listening' that never comes.
 */
export function serveTcp(
  tcpServer: net.Server,
  serve: (conn: McplConnection) => Promise<void>,
  log: (...args: unknown[]) => void = console.error,
): void {
  if (!tcpServer.listening) {
    throw new Error("serveTcp needs a listening server: call it once the server has emitted 'listening'");
  }
  tcpServer.on('error', (err) => log('[discord-mcpl] TCP server error:', errorText(err)));
  // Set before anything awaits, so two clients connecting in the same tick
  // can't both be served.
  let serving = false;
  tcpServer.on('connection', (socket) => {
    if (serving) {
      socket.on('error', (err) => log('[discord-mcpl] Refused client socket error:', errorText(err)));
      socket.destroy();
      log('[discord-mcpl] Refused a client: one client is served at a time');
      return;
    }
    serving = true;
    // fromTcp listens for the socket's errors before this handler returns.
    const conn = McplConnection.fromTcp(socket);
    log('[discord-mcpl] Client connected');
    void Promise.resolve()
      .then(() => serve(conn))
      .catch((err) => log('[discord-mcpl] Serving a client failed:', errorText(err)))
      .finally(() => {
        conn.close();
        serving = false;
        log('[discord-mcpl] Client disconnected, waiting for next...');
      });
  });
}
