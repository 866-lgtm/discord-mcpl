/**
 * The server's small persisted JSON files: the muted channels, the reaction
 * channels and the watermarks, each read once and rewritten whole after every
 * change. The filters file is saved here too; its reader is loadFiltersFile.
 *
 * Reading (readJsonFile):
 * - No file means a store with nothing in it yet.
 * - A file whose content can't be used, because it isn't JSON or isn't the
 *   shape its store expects, is moved aside to `<file>.unreadable-<time>`,
 *   and the store starts empty. For a symlink, the file it names is moved,
 *   so the link stays. The next save writes a fresh file with the moved one's
 *   permissions, and leaves the old one for an operator to recover.
 * - A file that can't be read at all (EACCES, EIO, EMFILE…) says nothing
 *   about its content, so it stays where it is, and nothing saves over it
 *   until it's read again: at a restart, or by a new store. The same holds
 *   when a move aside fails. The store runs in memory meanwhile.
 *
 * Saving (writeJsonFile) replaces a plain file the server owns atomically: a
 * temp file beside it, created with its permissions and given its group,
 * renamed over it. So a process crash partway through can't leave a torn
 * file. There's no fsync, so on some filesystems a power loss can still
 * leave it empty, and the reader then moves that aside. Everything else is
 * written in place, as it was before saves were atomic: a symlink, a file
 * with other hard links or another owner, a group the server isn't in, and
 * a file whose directory or name won't take the temp file and rename (no
 * write access to the directory, a bind-mounted file, a name with no room
 * for `.tmp`). A file the server couldn't write in place isn't replaced
 * either. What Node can't see doesn't carry over a replacement: extended
 * attributes and a POSIX ACL on the file itself are lost at the first save
 * (a directory's default ACL still applies), so a store that needs them
 * should be a symlink to its file, which is written in place.
 */
import {
  accessSync,
  chmodSync,
  chownSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { dbg } from './debug-log.js';

/** Paths whose file couldn't be read or moved aside: saving over them could destroy them. */
const unsaveable = new Set<string>();
/** The permissions and group of a file moved aside, for the file the next save writes in its place. */
const movedAside = new Map<string, { mode: number; gid: number }>();
/** Errors from the temp file or the rename that mean this path can't be saved that way, so it's written in place. */
const WRITE_IN_PLACE_ON = new Set(['EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'ENAMETOOLONG']);

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

function lstatIfThere(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/** Write `value` as JSON at `path`. Throws on failure. */
export function writeJsonFile(path: string, value: unknown): void {
  if (unsaveable.has(path)) {
    throw new Error(`${path} couldn't be read, so nothing is saved over it until it's read again`);
  }
  const text = JSON.stringify(value, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  const old = lstatIfThere(path);
  // A symlink's own mode means nothing; a file created through one, after its
  // target was moved aside, takes the moved file's mode.
  const was = old && !old.isSymbolicLink() ? { mode: old.mode & 0o777, gid: old.gid } : movedAside.get(path);
  const mode = was?.mode;
  const ownUid = process.getuid?.();
  const writeInPlace = () => {
    const creating = !existsSync(path); // a link whose file was moved aside, say
    writeFileSync(path, text, mode === undefined ? undefined : { mode });
    if (!creating || !was || ownUid === undefined) return;
    try {
      chownSync(path, ownUid, was.gid); // the moved file's group, as for a replaced file
    } catch {
      // A group the server isn't in: the file stays in the server's, as when it's written in place.
    }
  };
  // A rename would turn a symlink into a plain file, split a hard link, or
  // take another user's file over, so only a plain file the server owns, with
  // no other name, is replaced.
  if (old && !(old.isFile() && old.nlink === 1 && (ownUid === undefined || old.uid === ownUid))) {
    writeInPlace();
    return;
  }
  // A file the server couldn't write in place isn't replaced either.
  if (old) accessSync(path, constants.W_OK);
  const tmp = `${path}.tmp`;
  try {
    // A stale temp file keeps its own mode and owner, so it's never reused:
    // the temp file is created fresh, never more open than its target.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, text, { mode: mode ?? 0o666, flag: 'wx' });
    // The temp file is in the server's group. It takes the old file's, and
    // for a group the server isn't in that fails (EPERM): written in place.
    if (was && ownUid !== undefined) chownSync(tmp, ownUid, was.gid);
    if (mode !== undefined) chmodSync(tmp, mode); // the bits the umask took
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The save's own error is the one to report.
    }
    if (!WRITE_IN_PLACE_ON.has(errorCode(err) ?? '')) throw err;
    writeInPlace();
  }
}

/** The file's parsed contents, or undefined when there's no file or it can't
 *  be used: moved aside, or left in place and not saved over (see the module
 *  comment). console.error and the debug log say which. `what` names the store. */
export function readJsonFile<T>(path: string, what: string, isShape: (value: unknown) => value is T): T | undefined {
  unsaveable.delete(path); // each read decides afresh
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    unsaveable.add(path);
    console.error(
      `[discord-mcpl] Couldn't read ${what} from ${path} (${(err as Error).message}). ` +
        "Starting with none, and nothing is saved over that file until it's read again.",
    );
    dbg('persisted-json:unreadable', { what, path, error: (err as Error).message });
    return undefined;
  }
  let problem: string;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isShape(parsed)) return parsed;
    problem = 'not the shape this store expects';
  } catch {
    problem = 'not valid JSON'; // JSON.parse's own message quotes the file's text
  }
  try {
    const file = realpathSync(path);
    const aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const { mode, gid } = statSync(file);
    renameSync(file, aside);
    movedAside.set(path, { mode: mode & 0o777, gid });
    console.error(`[discord-mcpl] Couldn't load ${what} from ${path} (${problem}). Moved it to ${aside}, and starting with none.`);
    dbg('persisted-json:moved-aside', { what, path, aside, problem });
  } catch (err) {
    unsaveable.add(path);
    console.error(
      `[discord-mcpl] Couldn't load ${what} from ${path} (${problem}), or move it aside (${(err as Error).message}). ` +
        "Starting with none, and nothing is saved over that file until it's read again.",
    );
    dbg('persisted-json:move-failed', { what, path, problem, error: (err as Error).message });
  }
  return undefined;
}

export const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
