/**
 * Sender notices for DMs the DM allowlist refuses.
 *
 * A refused DM is never forwarded to the agent. Without a notice the sender
 * can't tell a contact filter from a resident ignoring them, so the connector
 * tells them once. This module holds the durable per-sender state that keeps
 * the notice to once per message, at most once a day per sender, and at most
 * DM_NOTICE_HOURLY_CEILING in any hour across all senders, through
 * restarts, reconnect catch-up and duplicate gateway events:
 *
 *   - floorId: a Discord snowflake. A message older than it never
 *     notifies, on any path: a gateway event can carry an older message as
 *     well as the catch-up sweep can. A new state's floor is the moment the
 *     state is created, and turning notices on moves it to that moment, so
 *     nothing refused before then notifies later: while they are off nothing
 *     is recorded, and a new state starts off. It also follows the retention
 *     horizon below.
 *   - per sender, lastHandledId: the newest refused message already handled.
 *     A message whose id isn't newer never notifies again.
 *   - per sender, lastNotice: the last notice's message, when it was
 *     reserved, and its outcome. It's reserved (persisted, outcome
 *     "pending") BEFORE the send and settled to sent / failed / unknown
 *     after. A reservation found still pending when the state is opened
 *     was interrupted (say, by a crash after dispatch): it becomes unknown,
 *     is reported once, and is never retried.
 *
 * The hourly ceiling bounds what a wave of new accounts DMing the bot can
 * cause: each would get its one notice, an unbounded burst of outbound DMs,
 * which is the pattern Discord's anti-spam watches bot accounts for. It
 * counts the senders whose last notice was reserved within the hour. Each
 * sender has at most one notice a day, so that is every notice reserved
 * within the hour, durable with the rest of the state. Past the ceiling, a
 * refused DM gets no notice. A sender the state already holds is recorded
 * as handled, so that message never notifies later. A sender it doesn't
 * hold yet isn't recorded at all, so a wave of new accounts adds no senders
 * and costs no writes: the file grows by at most the ceiling's worth of new
 * senders an hour. Their message got no notice, so a later sight of it can
 * still notify, within the usual limits.
 *
 * A sender is kept for DM_NOTICE_RETENTION_MS after their latest refusal
 * or notice, and dropped when the state next changes while notices are on,
 * and the floor follows that horizon, so a message from before it can't
 * notify once its sender is gone. While notices are off nothing is written,
 * so the state keeps the senders it held. The file holds the senders
 * refused within the retention while notices were on, not everyone ever
 * refused.
 *
 * The same file holds the resident's on/off setting for notices. It is off
 * until the resident turns it on with filters_update setDmNotice: a bot
 * account shouldn't start sending text to strangers because the connector was
 * upgraded, with nobody having chosen it. The choice survives restarts
 * whether or not a filters file is configured.
 *
 * The state lives in its own file, separate from the filters file. If it
 * can't be read or written, notices are suspended rather than sent without a
 * durable limit; refusals themselves are unaffected. A refusal decided
 * meanwhile gets no notice, and nothing retries it: only a later sight of
 * the same message decides it again, such as a duplicate gateway event, or
 * the catch-up at the next start for a refusal heard live in a DM channel
 * the bot knows (the catch-up moves its watermark past what it decided).
 *
 * The file is read and written asynchronously, so a slow disk never stalls
 * the gateway, and the state's operations (open, decide, recordOutcome,
 * setEnabled) run one at a time, in the order they were called: each sees the
 * state the one before it left. Every change rewrites the whole file. While
 * notices are off, a refusal changes nothing, so nothing is written.
 */
import { mkdir, open, readFile, rename, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DM_NOTICE_TEXT =
  'Automatic delivery notice: this connection did not forward your DM because this sender is outside ' +
  'its configured contacts. It sends this notice at most once per 24 hours.';

export const DM_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long a sender is kept after their latest refusal or notice. Longer
 *  than the 24-hour window, which it must outlast. */
export const DM_NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** At most this many notices in any hour, across all senders. */
export const DM_NOTICE_HOURLY_CEILING = 10;
export const DM_NOTICE_CEILING_WINDOW_MS = 60 * 60 * 1000;

const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE_RE = /^\d{1,20}$/;

/** The smallest snowflake Discord could assign at `ms` (epoch milliseconds). */
export function snowflakeAt(ms: number): string {
  const offset = BigInt(Math.floor(ms)) - DISCORD_EPOCH_MS;
  return (offset > 0n ? offset << 22n : 0n).toString();
}

/** When Discord assigned a snowflake, as epoch ms. */
function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

const laterSnowflake = (a: string, b: string): string => (BigInt(a) >= BigInt(b) ? a : b);

/** Where the notice state lives: DISCORD_DM_NOTICES_FILE when set, else
 *  $XDG_STATE_HOME/discord-mcpl/<bot user id>/dm-notices.json, falling back
 *  to ~/.local/state. Keyed by bot id so several bots on one host don't
 *  share a rate limit. */
export function resolveDmNoticesPath(botUserId: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DISCORD_DM_NOTICES_FILE?.trim();
  if (override) return override;
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'discord-mcpl', botUserId, 'dm-notices.json');
}

export type DmNoticeOutcome = 'pending' | 'sent' | 'failed' | 'unknown';

/** A reservation found still pending when the state was opened. */
export interface DmNoticeInterruption {
  authorId: string;
  messageId: string;
  /** When it was reserved (epoch ms). */
  at: number;
}

interface LastNotice {
  messageId: string;
  /** When it was reserved (epoch ms); its 24-hour window starts here. */
  at: number;
  outcome: DmNoticeOutcome;
}

interface SenderState {
  lastHandledId: string;
  lastNotice?: LastNotice;
}

const OUTCOMES = new Set<string>(['pending', 'sent', 'failed', 'unknown']);

interface NoticeFile {
  version: 1;
  floorId: string;
  /** The resident's setting: false (the default) = refused DMs get no notice. */
  enabled: boolean;
  senders: Record<string, SenderState>;
}

/** What happened to one refused DM's notice. `notify` means the reservation
 *  is persisted and the caller should send now. */
export type DmNoticeDecision =
  | 'notify'
  | 'silenced'
  | 'suspended'
  | 'before-floor'
  | 'already-handled'
  | 'rate-limited'
  | 'ceiling-reached';

export interface DmNoticeStatus {
  path: string | null;
  persisted: boolean;
  /** The resident's setting, or null while the state can't be read. */
  enabled: boolean | null;
  /** Why notices are suspended, when they are. */
  error?: string;
}

function parseNoticeFile(raw: unknown): NoticeFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.floorId !== 'string' || !SNOWFLAKE_RE.test(r.floorId)) return null;
  if (typeof r.enabled !== 'boolean') return null;
  if (typeof r.senders !== 'object' || r.senders === null || Array.isArray(r.senders)) return null;
  const senders: Record<string, SenderState> = {};
  for (const [id, v] of Object.entries(r.senders as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) return null;
    const s = v as Record<string, unknown>;
    if (typeof s.lastHandledId !== 'string' || !SNOWFLAKE_RE.test(s.lastHandledId)) return null;
    let lastNotice: LastNotice | undefined;
    if (s.lastNotice !== undefined) {
      const n = s.lastNotice as Record<string, unknown> | null;
      if (typeof n !== 'object' || n === null) return null;
      if (typeof n.messageId !== 'string' || !SNOWFLAKE_RE.test(n.messageId)) return null;
      // Within Date's range, so an interrupted reservation's time can be printed.
      if (typeof n.at !== 'number' || Number.isNaN(new Date(n.at).getTime())) return null;
      if (typeof n.outcome !== 'string' || !OUTCOMES.has(n.outcome)) return null;
      lastNotice = { messageId: n.messageId, at: n.at, outcome: n.outcome as DmNoticeOutcome };
    }
    senders[id] = { lastHandledId: s.lastHandledId, ...(lastNotice ? { lastNotice } : {}) };
  }
  return { version: 1, floorId: r.floorId, enabled: r.enabled, senders };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A write that failed after the new file replaced the old one: the file
 *  holds the new state, but its directory couldn't be flushed, so the
 *  replacement may not survive a host crash. */
class UnflushedReplace extends Error {}

export class DmNoticeState {
  /** The state as the file holds it (see commit), or null while it can't be read. */
  private file: NoticeFile | null = null;
  private path: string | null = null;
  /** Why the state isn't persisted right now, or null when it is. */
  private error: string | null = 'not opened yet';
  /** Settles when the last operation called so far has finished. */
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sync: (handle: FileHandle, what: 'file' | 'directory') => Promise<void>;
  private readonly onInterrupted: (i: DmNoticeInterruption) => void;

  /** `onInterrupted` hears about each reservation found still pending when
   *  the state is opened, every time it is opened (startup, or a reopen once
   *  a broken file is repaired). `now` and `sync` (which flushes the state
   *  file, or its directory after the rename) are injectable for tests. */
  constructor(opts: {
    now?: () => number;
    sync?: (handle: FileHandle, what: 'file' | 'directory') => Promise<void>;
    onInterrupted?: (i: DmNoticeInterruption) => void;
  } = {}) {
    this.now = opts.now ?? Date.now;
    this.sync = opts.sync ?? ((handle) => handle.sync());
    this.onInterrupted = opts.onInterrupted ?? (() => {});
  }

  /** Run `op` once every operation called before it has finished. */
  private serially<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Open the state at `path`, creating it (notices off) if there is none.
   *  An unreadable or invalid file is left untouched and suspends notices
   *  until an operator repairs or removes it; the next decision or setting
   *  change tries it again. */
  open(path: string): Promise<void> {
    return this.serially(() => this.load(path));
  }

  private async load(path: string): Promise<void> {
    this.path = path;
    this.file = null;
    this.error = 'opening';
    let text: string | null = null;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.error = errorText(err);
        return;
      }
    }
    if (text === null) {
      await this.commit({ version: 1, floorId: snowflakeAt(this.now()), enabled: false, senders: {} });
      return;
    }
    let parsed: NoticeFile | null = null;
    try {
      parsed = parseNoticeFile(JSON.parse(text));
    } catch {
      // not JSON: invalid, as below
    }
    if (!parsed) {
      this.error = `${path} is not a valid DM notice state file`;
      return;
    }
    // A reservation still pending was interrupted between reserving and
    // recording its outcome: settle it as unknown (never retried), and report
    // it once the file says so. Until then the state stays closed, so the
    // next use tries again.
    const pending = Object.entries(parsed.senders).filter(([, v]) => v.lastNotice?.outcome === 'pending');
    if (!pending.length) {
      this.file = parsed;
      this.error = null;
      return;
    }
    const senders = { ...parsed.senders };
    for (const [authorId, v] of pending) {
      senders[authorId] = { ...v, lastNotice: { ...v.lastNotice!, outcome: 'unknown' } };
    }
    await this.commit({ ...parsed, senders });
    if (!this.file) return;
    for (const [authorId, v] of pending) {
      this.onInterrupted({ authorId, messageId: v.lastNotice!.messageId, at: v.lastNotice!.at });
    }
  }

  status(): DmNoticeStatus {
    return {
      path: this.path,
      persisted: this.file !== null && this.error === null,
      enabled: this.file ? this.file.enabled : null,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Settle a reserved notice's outcome. Resolves to null once that is
   *  durable, else to why not. The state keeps the outcome either way, so
   *  the next write that succeeds records it. Until one does, the file holds
   *  the reservation pending, and if none does before the process ends, the
   *  next open reports it as interrupted (unknown). */
  recordOutcome(
    authorId: string,
    messageId: string,
    outcome: Exclude<DmNoticeOutcome, 'pending'>,
  ): Promise<string | null> {
    return this.serially(async () => {
      const file = this.file;
      const prev = file?.senders[authorId];
      if (!file || !prev?.lastNotice || prev.lastNotice.messageId !== messageId) {
        return 'its reservation is no longer in the notice state';
      }
      const next: NoticeFile = {
        ...file,
        senders: { ...file.senders, [authorId]: { ...prev, lastNotice: { ...prev.lastNotice, outcome } } },
      };
      const error = await this.commit(next);
      // Kept even when the file couldn't take it, so a later write carries
      // the outcome rather than the reservation's pending.
      if (error) this.file = next;
      return error;
    });
  }

  /** Save the resident's setting. Rejects when it didn't take effect, so the
   *  caller can say so. Resolves to null once it is durable, or to why it
   *  may not be: the file was replaced, so the setting is in effect, but its
   *  directory couldn't be flushed. */
  setEnabled(enabled: boolean): Promise<string | null> {
    return this.serially(async () => {
      if (!this.file && this.path) await this.load(this.path);
      if (!this.file) throw new Error(`DM notice state is unavailable: ${this.error ?? 'no path'}`);
      // Refusals while off weren't recorded, so turning notices on moves the
      // floor to now: nothing refused before this moment ever notifies.
      const floorId = enabled && !this.file.enabled
        ? laterSnowflake(this.file.floorId, snowflakeAt(this.now()))
        : this.file.floorId;
      const next: NoticeFile = { ...this.file, enabled, floorId };
      const error = await this.commit(next);
      if (error && this.file !== next) throw new Error(`could not save the DM notice setting: ${error}`);
      return error;
    });
  }

  /**
   * Decide one refused DM's notice and record it durably. While notices are
   * on, a refusal advances its sender's lastHandledId, so a later catch-up of
   * the same message can't notify; past the hourly ceiling, a sender the
   * state doesn't hold yet is the exception, and nothing is written. While
   * they are off, nothing is recorded (see setEnabled's floor). A `notify`
   * result is returned only after the reservation is durable; while the
   * file can't be written durably, notices are suspended (checked again on
   * the next refusal), and a reservation that couldn't be made durable is
   * withdrawn, since nothing is sent for it.
   */
  decide(messageId: string, authorId: string): Promise<DmNoticeDecision> {
    return this.serially(async () => {
      // A file that couldn't be opened may have been repaired or removed since.
      if (!this.file && this.path) await this.load(this.path);
      const file = this.file;
      if (!file) return 'suspended';
      const now = this.now();
      const horizon = now - DM_NOTICE_RETENTION_MS;
      const floorId = laterSnowflake(file.floorId, snowflakeAt(horizon));
      if (!SNOWFLAKE_RE.test(messageId) || BigInt(messageId) < BigInt(floorId)) return 'before-floor';
      const prev = file.senders[authorId];
      if (prev && BigInt(messageId) <= BigInt(prev.lastHandledId)) return 'already-handled';
      if (!file.enabled) return 'silenced';

      const inWindow = prev?.lastNotice !== undefined && now - prev.lastNotice.at < DM_NOTICE_WINDOW_MS;
      const atCeiling =
        !inWindow &&
        Object.values(file.senders).filter(
          (s) => s.lastNotice !== undefined && now - s.lastNotice.at < DM_NOTICE_CEILING_WINDOW_MS,
        ).length >= DM_NOTICE_HOURLY_CEILING;
      // Past the ceiling, a sender the state doesn't hold yet isn't recorded,
      // so a wave of new accounts adds no senders and costs no writes. Their
      // message got no notice, so a later sight of it can still notify.
      if (atCeiling && !prev) return 'ceiling-reached';
      const reserve = !inWindow && !atCeiling;
      const lastNotice: LastNotice | undefined = reserve
        ? { messageId, at: now, outcome: 'pending' }
        : prev?.lastNotice;
      // Senders quiet since the horizon are dropped; the floor that moved
      // with it keeps their older messages from notifying.
      const senders: Record<string, SenderState> = {};
      for (const [id, s] of Object.entries(file.senders)) {
        if (Math.max(snowflakeTime(s.lastHandledId), s.lastNotice?.at ?? -Infinity) >= horizon) senders[id] = s;
      }
      senders[authorId] = { lastHandledId: messageId, ...(lastNotice ? { lastNotice } : {}) };
      const next: NoticeFile = { ...file, floorId, senders };
      if (await this.commit(next)) {
        if (reserve) {
          // The reservation isn't durable, so nothing is sent for it. Withdraw
          // it: the message is handled, and the sender keeps their earlier
          // notice, if any. Once that's written, no open reports the
          // never-sent notice as interrupted. The state holds the withdrawal
          // even if this write fails too, so the next write that succeeds
          // records it.
          const handled: SenderState = {
            lastHandledId: messageId,
            ...(prev?.lastNotice ? { lastNotice: prev.lastNotice } : {}),
          };
          const withdrawn: NoticeFile = { ...next, senders: { ...senders, [authorId]: handled } };
          await this.commit(withdrawn);
          this.file = withdrawn;
        }
        return 'suspended';
      }
      if (reserve) return 'notify';
      return inWindow ? 'rate-limited' : 'ceiling-reached';
    });
  }

  /** Write `next` and make it the state. The state matches what the file
   *  holds: a write that failed before replacing the file changes nothing,
   *  and one that replaced the file but couldn't flush its directory still
   *  leaves `next` as the state (this is the file's only writer, so a reread
   *  would return the same), with the error kept until a later write is
   *  durable. Two callers keep a change the file couldn't take, for the next
   *  write that succeeds to carry: a settled outcome (recordOutcome) and a
   *  withdrawn reservation (decide). Resolves to null once `next` is
   *  durable, else to the error. */
  private async commit(next: NoticeFile): Promise<string | null> {
    try {
      await this.write(next);
      this.file = next;
      this.error = null;
      return null;
    } catch (err) {
      if (err instanceof UnflushedReplace) this.file = next;
      this.error = errorText(err);
      return this.error;
    }
  }

  /** Durable replace: the new content is flushed before it takes the old
   *  file's place, and the rename is flushed with its directory, so a
   *  reservation that returned has survived a host crash. Private to the
   *  bot's user: a 0600 file, in a directory created 0700 when it doesn't
   *  exist (an existing one keeps its mode). A failure before the rename
   *  leaves the old file in place; one after it is an UnflushedReplace. */
  private async write(file: NoticeFile): Promise<void> {
    if (!this.path) throw new Error('DM notice state has no path');
    const path = this.path;
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.chmod(0o600); // a stale tmp keeps its old mode otherwise
      // writeFile on a handle loops until every byte is written, so a short
      // write can't pass for a durable reservation.
      await handle.writeFile(JSON.stringify(file, null, 2) + '\n');
      await this.sync(handle, 'file');
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    if (process.platform === 'win32') return;
    try {
      const dirHandle = await open(dir, 'r');
      try {
        await this.sync(dirHandle, 'directory');
      } finally {
        await dirHandle.close();
      }
    } catch (err) {
      throw new UnflushedReplace(
        `${path} was replaced, but flushing its directory failed, so the change may not survive a host crash: ${errorText(err)}`,
      );
    }
  }
}
