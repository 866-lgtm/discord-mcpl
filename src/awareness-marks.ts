/**
 * The host's 💤 awareness marks, as the admin slash commands present them.
 *
 * Marks are the framework's: an agent framework with the `marks` host
 * command (anima-research/agent-framework#250) places them for an /undo or
 * /hide only when the operator chooses a scope (`addressed` or `all`), keeps
 * a journal of what it asked Discord to do, and returns a `markers` receipt
 * describing what it scheduled. This server places none itself. This module
 * turns those answers into the operator's replies and reads the operator's
 * choice from an interaction.
 */
import type { ChatInputCommandInteraction } from 'discord.js';

/** The operator's choice of which removed messages get a 💤 mark. */
export type MarksChoice = 'none' | 'addressed' | 'all';

/** The `marks` option /undo and /hide take. Omitted means none. */
export const MARKS_OPTION = {
  type: 3, // STRING
  name: 'marks',
  description: 'Mark removed messages with 💤: none (default), addressed (ones that addressed the agent), or all',
  required: false,
  choices: [
    { name: 'none', value: 'none' },
    { name: 'addressed', value: 'addressed' },
    { name: 'all', value: 'all' },
  ],
} as const;

const isMarksChoice = (v: unknown): v is MarksChoice => v === 'none' || v === 'addressed' || v === 'all';

export function readMarksChoice(interaction: ChatInputCommandInteraction): MarksChoice | undefined {
  const raw = interaction.options.getString('marks');
  return isMarksChoice(raw) ? raw : undefined;
}

/** What a surgery did about marks (agent-framework's SurgeryMarkerReceipt). */
export type MarkersReceipt = {
  scope: MarksChoice;
  unmarked: number;
  notRemoved: number;
} & (
  | { status: 'none'; queued: 0 }
  | { status: 'queued'; queued: number; batchId: string; error?: string }
  | { status: 'not-scheduled'; queued: 0; error: string }
  | { status: 'unresolved'; queued: 0; batchId: string; error: string }
);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Whether the host said anything about marks. Only an absent receipt
 * (undefined or null) says nothing; anything else is its account, shown even
 * when this server can't read it, and never supplemented.
 */
export const markersReported = (markers: unknown): boolean => markers !== undefined && markers !== null;

/**
 * The reply's account of marks, saying what the receipt says and no more: a
 * queued mark is requested, not yet confirmed on Discord. A receipt this
 * server can't read (a status it doesn't know, a field it reads missing) is
 * shown as sent, never described as something else or left out.
 */
export function describeMarkers(markers: unknown): string {
  if (!markersReported(markers)) {
    return 'Marks: this host reported nothing about 💤 marks; `/marks list` shows whether it scheduled any.';
  }
  if (!isMarkersReceipt(markers)) {
    return `Marks: the host's receipt is in a shape this server can't read; here it is as sent:\n${asSent(markers)}`;
  }
  const extras: string[] = [];
  if (markers.unmarked > 0 && markers.scope !== 'none') {
    extras.push(`${plural(markers.unmarked, 'removed message')} outside that scope left unmarked`);
  }
  if (markers.notRemoved > 0) {
    extras.push(`${plural(markers.notRemoved, 'chosen message')} not removed, so not marked`);
  }
  const tail = extras.length ? ` (${extras.join('; ')})` : '';
  switch (markers.status) {
    case 'none':
      // The receipt's scope can't tell an explicit none from one left out.
      return markers.scope === 'none'
        ? `Marks: none.${tail}`
        : `Marks: none placed — nothing removed fell within "${markers.scope}".${tail}`;
    case 'queued':
      return `Marks: ${plural(markers.queued, '💤 mark')} requested (${markers.scope}; batch \`${markers.batchId}\`) — ` +
        `not yet confirmed on Discord; \`/marks list\` shows progress.${tail}` + (markers.error === undefined ? '' :
          ` The host's journal couldn't be synced after recording them (${markers.error}), so an operating system crash ` +
          'or a power failure before its next sync could lose them.');
    case 'not-scheduled':
      return `Marks: not scheduled — ${markers.error}. None will be placed.${tail}`;
    case 'unresolved':
      return `Marks: unresolved — ${markers.error}. Batch \`${markers.batchId}\` may still be delivered later; ` +
        `check \`/marks list\`.${tail}`;
  }
}

/** A batch id or other host text inside a one-line account. */
const SHORT_TEXT_MAX = 100;

/**
 * The marks in one bounded line, for the short account of an applied /undo
 * or /hide when its full reply can't be shown: what the receipt says was
 * scheduled and the batch to find it by, never what Discord confirmed.
 */
export function summarizeMarkers(markers: unknown): string {
  if (!markersReported(markers)) return 'Marks: the host reported nothing about them; `/marks list` shows whether it scheduled any.';
  if (!isMarkersReceipt(markers)) return "Marks: the host's receipt couldn't be read; `/marks list` shows the journal.";
  const batch = (id: string): string => `batch \`${clip(id, SHORT_TEXT_MAX)}\``;
  switch (markers.status) {
    case 'none':
      return markers.scope === 'none' ? 'Marks: none.' : 'Marks: none placed.';
    case 'queued':
      return `Marks: ${plural(markers.queued, '💤 mark')} requested (${batch(markers.batchId)})` +
        (markers.error === undefined ? '.' : "; the host's journal sync failed after recording them, so an operating system " +
          'crash or a power failure before its next sync could lose them.');
    case 'not-scheduled':
      return `Marks: not scheduled — ${clip(markers.error, SHORT_TEXT_MAX)}.`;
    case 'unresolved':
      return `Marks: unresolved — ${clip(markers.error, SHORT_TEXT_MAX)} (${batch(markers.batchId)}); check \`/marks list\`.`;
  }
}

/** An operation's status in the journal (agent-framework's DiscordAwarenessOpStatus). */
export type OpStatus = 'requested' | 'dispatching' | 'confirmed' | 'failed' | 'unknown' | 'cancelled';
type Counts = Partial<Record<OpStatus, number>>;

/** One batch, as the journal lists it (agent-framework's DiscordAwarenessBatchView). */
export interface BatchView {
  kind: 'batch';
  id: string;
  /** prepared, active or discarded at agent-framework#250; shown as the host
   *  names it, so a state a later host adds still reads. */
  status: string;
  scope: string;
  agentName: string;
  sourceBranch?: string;
  targetBranch?: string;
  emoji?: string;
  createdAt: number;
  refs: number;
  unmarked?: number;
  notRemoved?: number;
  cancelled?: { at: number; by?: string };
  adds: Counts;
  removals: Counts;
  unresolvedAttempts: number;
  /** What a pre-journal ledger recorded about this batch's refs, all counts:
   *  the refs it imported, those whose last recorded action was an add (a
   *  removal) it saw applied, and the attempts whose outcome it never
   *  recorded. */
  legacy?: { entries: number; lastAddConfirmed: number; lastRemoveConfirmed: number; outcomesUnrecorded: number };
}

/** One retract request (agent-framework's DiscordAwarenessRetractView). */
export interface RetractView {
  kind: 'retract';
  id: string;
  target: string;
  at: number;
  by?: string;
  cancelled?: { at: number; by?: string };
  removals: Counts;
  unresolvedAttempts: number;
}

export type AwarenessView = BatchView | RetractView;

/** cancel's receipt (agent-framework's DiscordAwarenessCancelReceipt). */
export interface CancelReceipt {
  target: string;
  kind: 'batch' | 'retract';
  cancelled: number;
  inFlight: number;
  unknown: number;
  confirmed: number;
  unresolvedAttempts: number;
  legacyOutcomesUnrecorded: number;
}

/** retract's receipt (agent-framework's DiscordAwarenessRetractReceipt). */
export interface RetractReceipt {
  requestId: string;
  removalsQueued: number;
  addsSuperseded: number;
  keysWithUnresolvedAdds: number;
  unresolvedAddAttempts: number;
  keysWithLegacyUncertainty: number;
}

/** Discord's limit on one reply. */
export const REPLY_LIMIT = 2000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A count as the host gave it, or undefined when it gave none it can be
 *  read as: a missing count is reported as not given, never as zero. */
export const hostCount = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Cut text to `max` UTF-16 units (its `length`), marking the cut. The cut
 * falls between code points, so it never leaves half of a surrogate pair,
 * such as one of 💤's two units.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const before = text.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** A value as the host sent it, as a JSON block. */
const asSent = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value) ?? String(value)}\n\`\`\``;

/** An answer this server can't read, shown as it came (bounded) rather than misread. */
export function unreadable(what: string, value: unknown): string {
  return `The host answered ${what} in a shape this server can't read; here it is as sent:\n${asSent(value)}`;
}

const counts = (c: Counts | undefined): string => {
  const parts = Object.entries(c ?? {}).filter(([, n]) => isNum(n) && n > 0).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(', ') : 'none';
};

const when = (ms: number | undefined): string => (isNum(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : 'unknown time');

const legacyText = (l: NonNullable<BatchView['legacy']>): string =>
  `imported history: ${plural(l.entries, 'entry', 'entries')}, of which ${l.lastAddConfirmed} last had an add confirmed ` +
  `and ${l.lastRemoveConfirmed} a removal confirmed` +
  (l.outcomesUnrecorded > 0 ? `; ${plural(l.outcomesUnrecorded, 'attempt')} with unrecorded outcomes — any may have landed` : '');

/** One line per entry, for the paged list. */
export function summaryLine(v: AwarenessView): string {
  const unresolved = v.unresolvedAttempts ? `; ${v.unresolvedAttempts} unresolved` : '';
  if (v.kind === 'retract') {
    return `• retract \`${v.id}\` → ${v.target}${v.cancelled ? ' (cancelled)' : ''}: removals ${counts(v.removals)}${unresolved}`;
  }
  const state = v.cancelled ? `${v.status}, cancelled` : v.status;
  const legacy = v.legacy ? `; imported history (${plural(v.legacy.outcomesUnrecorded, 'unrecorded outcome')})` : '';
  return `• batch \`${v.id}\` — ${state}, ${v.scope}, ${plural(v.refs, 'message')} (${v.agentName}): ` +
    `adds ${counts(v.adds)}; removals ${counts(v.removals)}${unresolved}${legacy}`;
}

/** One entry in full (the caller fits it into a reply). */
export function detailText(v: AwarenessView): string {
  const lines: string[] = [];
  if (v.kind === 'retract') {
    lines.push(`**Retract \`${v.id}\`** of ${v.target === 'all' ? 'every marked message' : `batch \`${v.target}\``}, ${when(v.at)}${v.by ? ` by ${v.by}` : ''}.`);
    if (v.cancelled) lines.push(`Cancelled ${when(v.cancelled.at)}${v.cancelled.by ? ` by ${v.cancelled.by}` : ''}.`);
    lines.push(`Removals: ${counts(v.removals)}.`);
    if (v.unresolvedAttempts) lines.push(`${plural(v.unresolvedAttempts, 'request')} on the wire or with unknown outcome — any may land.`);
  } else {
    lines.push(`**Batch \`${v.id}\`** — ${v.status}; ${v.scope} for ${v.agentName}; ${plural(v.refs, 'message')}; created ${when(v.createdAt)}.`);
    if (v.sourceBranch || v.targetBranch) lines.push(`Branches: ${v.sourceBranch ?? '?'} → ${v.targetBranch ?? '?'}.`);
    // agent-framework#250 keeps each of these counts only when it isn't zero
    // (and its view carries only what it kept), so one left out is zero.
    if (isNum(v.unmarked) || isNum(v.notRemoved)) {
      lines.push(`Left unmarked: ${v.unmarked ?? 0} outside the scope; ${v.notRemoved ?? 0} chosen but not removed.`);
    }
    if (v.cancelled) lines.push(`Cancelled ${when(v.cancelled.at)}${v.cancelled.by ? ` by ${v.cancelled.by}` : ''}.`);
    lines.push(`Adds: ${counts(v.adds)}. Removals on its messages: ${counts(v.removals)}.`);
    if (v.unresolvedAttempts) lines.push(`${plural(v.unresolvedAttempts, 'request')} on its messages on the wire or with unknown outcome — any may land.`);
    if (v.legacy) {
      const legacy = legacyText(v.legacy);
      lines.push(`${legacy[0]!.toUpperCase()}${legacy.slice(1)}.`);
    }
  }
  return lines.join('\n');
}

const entryTime = (v: AwarenessView): number => (v.kind === 'batch' ? v.createdAt : v.at) ?? 0;

/**
 * The journal, newest first, cut into pages that each fit one reply with
 * their heading. Every entry is on some page; a line too long for a page
 * alone is clipped (its entry still opens in full with `target:`).
 */
export function paginate(views: AwarenessView[], budget = REPLY_LIMIT): string[][] {
  const ordered = [...views].sort((a, b) => entryTime(b) - entryTime(a));
  // Room for the heading ("Awareness journal — page 999 of 999, …"), its
  // newline, and the footer pointing at target:.
  const room = budget - HEADING_RESERVE;
  const pages: string[][] = [];
  let page: string[] = [];
  let used = 0;
  for (const view of ordered) {
    const line = clip(summaryLine(view), room);
    const cost = line.length + 1;
    if (page.length > 0 && used + cost > room) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(line);
    used += cost;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

const HEADING_RESERVE = 220;

/** One page of `/marks list`, heading and footer included, within one reply. */
export function renderListPage(views: AwarenessView[], pageNumber: number, budget = REPLY_LIMIT): string {
  if (views.length === 0) return 'No awareness-mark batches or retracts in the journal.';
  const pages = paginate(views, budget);
  if (pageNumber < 1 || pageNumber > pages.length) {
    return `The journal has ${plural(views.length, 'entry', 'entries')} on ${plural(pages.length, 'page')}; there is no page ${pageNumber}.`;
  }
  const lines = pages[pageNumber - 1]!;
  const heading = `Awareness journal — page ${pageNumber} of ${pages.length}, ${plural(views.length, 'entry', 'entries')}, newest first.`;
  const footer = pages.length > 1
    ? `\`/marks list page:${pageNumber < pages.length ? pageNumber + 1 : 1}\` for ${pageNumber < pages.length ? 'the next page' : 'the first page'}; \`/marks list target:<id>\` shows one entry in full.`
    : '`/marks list target:<id>` shows one entry in full.';
  return clip([heading, ...lines, footer].join('\n'), budget);
}

/** One entry of the journal by id, in full, or why not. */
export function renderEntry(views: AwarenessView[], id: string): string {
  const found = views.filter((v) => v.id === id);
  if (found.length === 0) return `No batch or retract \`${clip(id, 100)}\` in the journal.`;
  return found.map(detailText).join('\n\n');
}

const isStr = (v: unknown): v is string => typeof v === 'string';
/** An optional field: absent, or what `is` accepts. */
const opt = (v: unknown, is: (x: unknown) => boolean): boolean => v === undefined || is(v);
const allNums = (o: Record<string, unknown>, keys: string[]): boolean => keys.every((k) => isNum(o[k]));
/** Operations by status: a status is shown as the host names it, and every count is a number. */
const isCounts = (v: unknown): boolean => isObj(v) && Object.values(v).every(isNum);
/** When something was cancelled, and by whom if known. */
const isStamp = (v: unknown): boolean => isObj(v) && isNum(v.at) && opt(v.by, isStr);

/**
 * A journal entry the formatters can show without misreading it: every field
 * they read has the type they read it as, optional ones when present. `status`
 * and `scope` are shown as the host names them, so they need only be text; a
 * field nothing here reads isn't checked, so a host's change there doesn't
 * make the journal unreadable.
 */
export function isView(v: unknown): v is AwarenessView {
  if (!isObj(v) || !isStr(v.id) || !isCounts(v.removals) || !isNum(v.unresolvedAttempts) || !opt(v.cancelled, isStamp)) {
    return false;
  }
  if (v.kind === 'retract') return isStr(v.target) && isNum(v.at) && opt(v.by, isStr);
  return v.kind === 'batch' && isStr(v.status) && isStr(v.scope) && isStr(v.agentName) && isNum(v.createdAt) &&
    isNum(v.refs) && isCounts(v.adds) && opt(v.sourceBranch, isStr) && opt(v.targetBranch, isStr) &&
    opt(v.unmarked, isNum) && opt(v.notRemoved, isNum) &&
    opt(v.legacy, (l) => isObj(l) && allNums(l, ['entries', 'lastAddConfirmed', 'lastRemoveConfirmed', 'outcomesUnrecorded']));
}

/**
 * A markers receipt as agent-framework#250 defines it, with every field its
 * description reads: a status this server doesn't know is not one it can
 * describe.
 */
export function isMarkersReceipt(m: unknown): m is MarkersReceipt {
  if (!isObj(m) || !isMarksChoice(m.scope) || !isNum(m.unmarked) || !isNum(m.notRemoved)) return false;
  switch (m.status) {
    case 'none':
      return true;
    case 'queued':
      return isNum(m.queued) && isStr(m.batchId) && opt(m.error, isStr);
    case 'not-scheduled':
      return isStr(m.error);
    case 'unresolved':
      return isStr(m.batchId) && isStr(m.error);
    default:
      return false;
  }
}

export function isCancelReceipt(r: unknown): r is CancelReceipt {
  return isObj(r) && typeof r.target === 'string' && (r.kind === 'batch' || r.kind === 'retract') &&
    allNums(r, ['cancelled', 'inFlight', 'unknown', 'confirmed', 'unresolvedAttempts', 'legacyOutcomesUnrecorded']);
}

export function isRetractReceipt(r: unknown): r is RetractReceipt {
  return isObj(r) && typeof r.requestId === 'string' &&
    allNums(r, ['removalsQueued', 'addsSuperseded', 'keysWithUnresolvedAdds', 'unresolvedAddAttempts', 'keysWithLegacyUncertainty']);
}

/** What a cancel stopped: its unsent requests, or none still waiting. */
const stopped = (cancelled: number, fate: string): string =>
  cancelled === 0 ? 'no request was still waiting to be sent' : `${plural(cancelled, 'request')} ${fate}`;

/** cancel's reply: what will never be sent, and what cancel can't undo. */
export function describeCancel(r: CancelReceipt): string {
  const what = r.kind === 'batch' ? `batch \`${r.target}\`` : `retract \`${r.target}\``;
  const lines = [`✅ Cancelled ${what}: ${stopped(r.cancelled, 'will now never be sent')}.`];
  const limits: string[] = [];
  if (r.confirmed) limits.push(`${r.confirmed} already confirmed on Discord ${r.confirmed === 1 ? 'stays' : 'stay'} as ${r.confirmed === 1 ? 'it is' : 'they are'}`);
  if (r.inFlight) limits.push(`${r.inFlight} on the wire may still land`);
  if (r.unknown) limits.push(`${r.unknown} with unknown outcome may have landed`);
  if (r.unresolvedAttempts) limits.push(`${plural(r.unresolvedAttempts, 'unresolved attempt')} in all`);
  if (r.legacyOutcomesUnrecorded) limits.push(`${plural(r.legacyOutcomesUnrecorded, 'imported attempt')} with unrecorded outcomes may have landed`);
  lines.push(`Cancel removes nothing from Discord${limits.length ? `: ${limits.join('; ')}.` : '.'}`);
  if (r.kind === 'batch' && (r.confirmed || r.inFlight || r.unknown)) {
    lines.push(`To take marks down, \`/marks retract target:${r.target}\`.`);
  }
  return lines.join('\n');
}

/** retract's reply: removals requested, and adds that may land after them. */
export function describeRetract(r: RetractReceipt): string {
  const superseded = r.addsSuperseded ? `; ${plural(r.addsSuperseded, 'unsent add')} superseded` : '';
  const lines = [
    `✅ Retract \`${r.requestId}\`: ${plural(r.removalsQueued, '💤 removal')} requested — not yet confirmed on Discord${superseded}.`,
  ];
  if (r.keysWithUnresolvedAdds) {
    lines.push(`${plural(r.keysWithUnresolvedAdds, 'message')} ${r.keysWithUnresolvedAdds === 1 ? 'has' : 'have'} earlier add attempts still unresolved ` +
      `(${plural(r.unresolvedAddAttempts, 'attempt')}): such an add may land after its removal.`);
  }
  if (r.keysWithLegacyUncertainty) {
    lines.push(`${plural(r.keysWithLegacyUncertainty, 'message')} ${r.keysWithLegacyUncertainty === 1 ? 'has' : 'have'} imported history with unrecorded outcomes.`);
  }
  lines.push(`\`/marks list target:${r.requestId}\` shows progress; \`/marks cancel target:${r.requestId}\` stops what hasn't been sent.`);
  return lines.join('\n');
}

/** A reply too long for one message: cut visibly, with the whole answer attached. */
export type BoundedReply = string | { content: string; files: Array<{ attachment: Buffer; name: string }> };

/**
 * Fit `text` into one Discord reply. When it doesn't fit, the reply says it
 * was cut and attaches the whole answer: `full` as JSON when given (the
 * host's own record), else the text itself.
 */
export function boundedReply(text: string, full?: unknown, budget = REPLY_LIMIT): BoundedReply {
  if (text.length <= budget) return text;
  const json = full !== undefined;
  const note = `\n… (cut to fit one message; the whole ${json ? 'answer is attached as JSON' : 'reply is attached'})`;
  return {
    content: clip(text, budget - note.length) + note,
    files: [
      json
        ? { attachment: Buffer.from(JSON.stringify(full, null, 2) ?? String(full), 'utf8'), name: 'awareness.json' }
        : { attachment: Buffer.from(text, 'utf8'), name: 'reply.txt' },
    ],
  };
}

/**
 * The short account of an accepted control, for when its full reply can't be
 * shown: the action, its target or request id, and what was requested —
 * never what Discord confirmed.
 */
export function summarizeControl(action: string, target: string | undefined, answer: unknown): string {
  if (action === 'cancel' && isCancelReceipt(answer)) {
    // The short account keeps what cancel couldn't stop: requests that may
    // still land, or may already have landed.
    const mayLand = [
      ...(answer.inFlight ? [`${answer.inFlight} on the wire may still land`] : []),
      ...(answer.unknown ? [`${answer.unknown} with unknown outcome may have landed`] : []),
      ...(answer.legacyOutcomesUnrecorded
        ? [`${plural(answer.legacyOutcomesUnrecorded, 'imported attempt')} with unrecorded outcomes may have landed`]
        : []),
    ];
    return `✅ Cancelled ${answer.kind} \`${answer.target}\`: ${stopped(answer.cancelled, 'will never be sent')}; ` +
      `cancel removes nothing from Discord${mayLand.length ? `: ${mayLand.join('; ')}` : ''}.`;
  }
  if (action === 'retract' && isRetractReceipt(answer)) {
    // Like cancel's, it keeps what may still change Discord after it: an
    // earlier add that may land after its removal, and imported history
    // whose outcomes weren't recorded.
    const after = [
      ...(answer.keysWithUnresolvedAdds
        ? [answer.keysWithUnresolvedAdds === 1
          ? '1 message has an earlier add still unresolved, which may land after its removal'
          : `${answer.keysWithUnresolvedAdds} messages have earlier adds still unresolved, which may land after their removal`]
        : []),
      ...(answer.keysWithLegacyUncertainty
        ? [`${plural(answer.keysWithLegacyUncertainty, 'message')} ${answer.keysWithLegacyUncertainty === 1 ? 'has' : 'have'} ` +
          'imported history with unrecorded outcomes']
        : []),
    ];
    return `✅ Retract \`${answer.requestId}\`: ${plural(answer.removalsQueued, 'removal')} requested, not yet confirmed on Discord` +
      `${after.length ? `; ${after.join('; ')}` : ''}.`;
  }
  return `✅ The host accepted /marks ${action}${target ? ` \`${target}\`` : ''} (its receipt couldn't be read).`;
}

/**
 * A control whose request failed in transit: it may have been applied.
 * Without `error`, it's the short account kept when the reply can't be shown.
 */
export function controlOutcomeUnknown(action: string, target: string | undefined, error?: string): string {
  const effect = action === 'cancel' ? 'already have cancelled it' : 'already have queued the removals';
  return `⚠️ /marks ${action} outcome unknown${error ? ` (${error})` : ''}: the host may ${effect}. ${controlCheck(target)}`;
}

const controlCheck = (target: string | undefined): string =>
  `Check ${target && target !== 'all' ? `\`/marks list target:${target}\`` : '`/marks list`'} before trying again.`;

/**
 * After a probe whose request failed: what can make running the command
 * again work. agent-framework refuses every host command from a server its
 * config doesn't allow (`allowHostCommands`, deny by default), and the
 * reason shown names it then; a timeout or a restarting host can clear.
 */
export const PROBE_AGAIN = 'Running it again can work after a timeout, or once the host is back if it was restarting. ' +
  'If the host refuses host commands, whoever runs it has to allow them for this server (`allowHostCommands`).';

/** Before retrying an /undo or /hide that may have been applied: the agent's
 *  context, and, when marks were chosen, the journal for a batch it scheduled. */
const surgeryCheck = (marksChosen: boolean): string =>
  `Check the agent's context${marksChosen ? ', and `/marks list` for a 💤 batch it may have scheduled,' : ''} before trying again.`;

/**
 * An /undo or /hide whose request failed in transit: the host may have
 * applied it. Without `error`, it's the short account kept when the reply
 * can't be shown.
 */
export function surgeryOutcomeUnknown(command: 'Undo' | 'Hide', marksChosen: boolean, error?: string): string {
  return `⚠️ ${command} outcome unknown${error ? ` (${error})` : ''}: the host may or may not have applied it. ` +
    surgeryCheck(marksChosen);
}

/**
 * An /undo or /hide answer without a boolean `ok`: not a refusal, so the
 * host may have applied it. Shown as sent, with the check before retrying.
 */
export function unreadableSurgery(command: 'undo' | 'hide', answer: unknown, marksChosen: boolean): string {
  return `⚠️ The host answered /${command} in a shape this server can't read, so it may have been applied; ` +
    `here it is as sent:\n${asSent(answer)}\n${surgeryCheck(marksChosen)}`;
}

/** A /marks control's answer without a boolean `ok`, as unreadableSurgery. */
export function unreadableControl(action: string, target: string | undefined, answer: unknown): string {
  return `⚠️ The host answered /marks ${action} in a shape this server can't read, so it may have been applied; ` +
    `here it is as sent:\n${asSent(answer)}\n${controlCheck(target)}`;
}

/** The host's refusal (`ok: false`) of a command, with its code when it gave one. */
export function hostRefusal(command: string, answer: Record<string, unknown>): string {
  const code = isStr(answer.code) && answer.code !== '' ? ` (${answer.code})` : '';
  const error = isStr(answer.error) && answer.error !== '' ? answer.error : 'unknown error';
  return `⚠️ ${command} failed${code}: ${error}`;
}
