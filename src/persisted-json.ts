/**
 * The server's small persisted JSON files: the muted channels, the reaction
 * channels and the watermarks, each read once, when its store is first used,
 * and rewritten whole after every change. The filters file is saved here too;
 * its reader is loadFiltersFile. The server owns these files while it runs:
 * a save writes over whatever is at the path then, so to edit or restore one,
 * an operator stops the server first.
 *
 * Reading (readJsonFile):
 * - No file means a store with nothing in it yet.
 * - A file that isn't exactly what its store writes (not JSON, the wrong
 *   shape, or entries the store doesn't write) is copied aside first, to
 *   `<file>.unreadable-<hash>`, named by its content so that reading the same
 *   content again keeps one copy. Once the copy is on disk, the file itself
 *   is rewritten by an ordinary save with the entries its store can use, or
 *   emptied when there are none, so it keeps its mode, owner, group and
 *   links. The store starts with those entries.
 * - A file that can't be read at all (EACCES, EIO, EMFILE…) says nothing
 *   about its content, so it stays as it is, and nothing saves over it until
 *   it's read again: at a restart, or by a new store. The store runs empty
 *   in memory meanwhile. When the copy or the rewrite fails, the file stays
 *   as it is the same way, and the store runs in memory on the entries it
 *   could use.
 *
 * Saving (writeJsonFile) replaces a plain file the server owns atomically: a
 * temp file beside it, given the file's group and its whole mode before any
 * content goes in, renamed over it. So a process crash partway through can't
 * leave a torn file. There's no fsync, so on some filesystems a power loss
 * can still leave it empty, and the reader then copies that aside. A full
 * disk or quota (ENOSPC, EDQUOT) fails the save, and the file keeps what was
 * last saved. Everything else is written in place, as it was before saves
 * were atomic, where a crash or full disk partway through can still tear the
 * file: a symlink, a file with other hard links or another owner, a group the
 * server isn't in or its user namespace doesn't map, and a file whose
 * directory, filesystem or name won't take the temp file and rename (no
 * write access to the directory, a read-only filesystem around a
 * bind-mounted file, a filesystem without permissions, a name with no room
 * for `.tmp`). The first time a path is written in place for such an error,
 * the log says so. A file the server couldn't write in place isn't replaced
 * either. What Node can't see doesn't carry over a replacement: extended
 * attributes and a POSIX ACL on the file itself are lost at its first
 * replacement, the rewrite after a copy included (a directory's default ACL
 * still applies), so a store that needs them should be a symlink to its
 * file, which is written in place.
 */
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { dbg } from './debug-log.js';

/** Paths that nothing saves over until they're read again, each with why:
 *  their file couldn't be read, copied aside or rewritten, so saving over it
 *  could destroy it. */
const unsaveable = new Map<string, string>();
/** Errors from the temp file, its chown or chmod, or the rename that mean this
 *  path can't be saved by replacement, so it's written in place. EINVAL is the
 *  chown's, for a group the user namespace doesn't map. */
const WRITE_IN_PLACE_ON = new Set([
  'EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS', 'ENAMETOOLONG', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL',
]);
/** Paths whose writing in place, for one of those errors, has been logged. */
const loggedInPlace = new Set<string>();

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
  const refused = unsaveable.get(path);
  if (refused !== undefined) {
    throw new Error(`${path} ${refused}, so nothing is saved over it until it's read again`);
  }
  const text = JSON.stringify(value, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  const old = lstatIfThere(path);
  const ownUid = process.getuid?.();
  // A rename would turn a symlink into a plain file, split a hard link, or
  // take another user's file over, so only a plain file the server owns, with
  // no other name, is replaced.
  if (old && !(old.isFile() && old.nlink === 1 && (ownUid === undefined || old.uid === ownUid))) {
    const why = old.isSymbolicLink()
      ? 'a symlink'
      : !old.isFile()
        ? 'not a plain file'
        : old.nlink > 1
          ? 'other hard links'
          : 'another owner';
    dbg('persisted-json:in-place', { path, why });
    writeFileSync(path, text);
    return;
  }
  // A file the server couldn't write in place isn't replaced either.
  if (old) accessSync(path, constants.W_OK);
  const mode = old ? old.mode & 0o7777 : undefined;
  const tmp = `${path}.tmp`;
  try {
    // A stale temp file keeps its own mode and owner, so it's never reused:
    // the temp file is created fresh, never more open than its target.
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, 'wx', mode ?? 0o666);
    try {
      // The group and mode go on before the content. The temp file is in the
      // server's group and takes the old file's: for a group the server isn't
      // in that fails (EPERM), and so does one its user namespace doesn't map
      // (EINVAL), so the file is written in place.
      if (old && ownUid !== undefined) fchownSync(fd, ownUid, old.gid);
      // Then the whole mode, which the umask trimmed, after the chown, which
      // clears setuid. Writing the content then clears set-id bits as a
      // write in place would, so the file keeps what an in-place save kept.
      if (mode !== undefined) fchmodSync(fd, mode);
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The save's own error is the one to report.
    }
    const code = errorCode(err) ?? '';
    if (!WRITE_IN_PLACE_ON.has(code)) throw err;
    if (!loggedInPlace.has(path)) {
      loggedInPlace.add(path);
      console.error(
        `[discord-mcpl] Saving ${path} in place, since it can't be replaced (${code}), ` +
          'so a crash partway through a save could tear it. Logged once for this path.',
      );
    }
    dbg('persisted-json:in-place', { path, why: code });
    writeFileSync(path, text);
  }
}

/** What a store can use of a file's parsed content. */
export interface Usable<T> {
  /** The entries the store can use, or null when the content has none at all. */
  value: T | null;
  /** What it can't use, or null when the content is exactly what the store writes. */
  unusable: string | null;
}

/** An id: a non-empty string. */
export const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The ids in a list, and how many of its entries aren't ids. */
export function usableIds(value: unknown): Usable<string[]> {
  if (!Array.isArray(value)) return { value: null, unusable: 'not a list' };
  const ids = value.filter(isId);
  const others = value.length - ids.length;
  return { value: ids, unusable: others ? `${others} of its ${value.length} entries aren't ids` : null };
}

/** The store's content and whether its file holds it, as read: false when
 *  nothing is saved over the file until it's read again. */
export interface Read<T> {
  value: T;
  held: boolean;
}

/** Read a store's file (see the module comment). console.error and the debug
 *  log say what was done with a file that couldn't be used. `what` names the
 *  store, `usable` says what it can use of the file's content, and `empty`
 *  is the store with nothing in it. */
export function readJsonFile<T>(
  path: string,
  what: string,
  usable: (value: unknown) => Usable<T>,
  empty: T,
): Read<T> {
  unsaveable.delete(path); // each read decides afresh
  let bytes: Buffer;
  let mode: number;
  try {
    const fd = openSync(path, 'r');
    try {
      mode = fstatSync(fd).mode;
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { value: empty, held: true };
    unsaveable.set(path, "couldn't be read");
    console.error(
      `[discord-mcpl] Couldn't read ${what} from ${path} (${(err as Error).message}). ` +
        "Starting with none, and nothing is saved over that file until it's read again.",
    );
    dbg('persisted-json:unreadable', { what, path, error: (err as Error).message });
    return { value: empty, held: false };
  }
  let found: Usable<T>;
  try {
    // An editor's byte-order mark isn't part of the JSON.
    found = usable(JSON.parse(bytes.toString('utf-8').replace(/^\uFEFF/, '')));
  } catch {
    found = { value: null, unusable: 'not valid JSON' }; // JSON.parse's own message quotes the file's text
  }
  if (found.unusable === null && found.value !== null) return { value: found.value, held: true };
  const problem = found.unusable ?? 'nothing it can use';
  const value = found.value ?? empty;
  let aside: string;
  try {
    aside = copyAside(path, bytes, mode & 0o777);
  } catch (err) {
    unsaveable.set(path, "couldn't be copied aside");
    console.error(
      `[discord-mcpl] Couldn't use ${what} in ${path} as it is (${problem}), or copy it aside ` +
        `(${(err as Error).message}). Starting with what it could use, and nothing is saved over that file ` +
        "until it's read again.",
    );
    dbg('persisted-json:copy-failed', { what, path, problem, error: (err as Error).message });
    return { value, held: false };
  }
  try {
    writeJsonFile(path, value);
  } catch (err) {
    unsaveable.set(path, "couldn't be rewritten after its copy was kept");
    console.error(
      `[discord-mcpl] Couldn't use ${what} in ${path} as it is (${problem}). Kept a copy at ${aside}, but ` +
        `couldn't rewrite the file (${(err as Error).message}). Starting with what it could use, and nothing is ` +
        "saved over the file until it's read again.",
    );
    dbg('persisted-json:rewrite-failed', { what, path, aside, problem, error: (err as Error).message });
    return { value, held: false };
  }
  console.error(
    `[discord-mcpl] Couldn't use ${what} in ${path} as it is (${problem}). Kept a copy at ${aside}, ` +
      (found.value === null
        ? 'emptied the file, and starting with none. '
        : 'rewrote the file with the entries it could use, and starting with those. ') +
      'To restore the copy, stop the server first: a running server saves over its file.',
  );
  dbg('persisted-json:copied-aside', { what, path, aside, problem });
  return { value, held: true };
}

/** Keep `bytes`, read from `path`, in a copy beside it, flushed to disk, at
 *  `mode`. Returns the copy's path. */
function copyAside(path: string, bytes: Buffer, mode: number): string {
  // Named by content, so the same content is kept once. A copy already under
  // that name is checked byte for byte, since an operator may have edited it
  // in place; then this content gets a name of its own, by time.
  const byContent = `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
  if (writeNewFile(byContent, bytes, mode)) return byContent;
  if (readFileSync(byContent).equals(bytes)) {
    // An earlier read kept these very bytes, as when the rewrite keeps
    // failing across restarts. One copy is enough, once it's on disk.
    const fd = openSync(byContent, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return byContent;
  }
  const byTime = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (!writeNewFile(byTime, bytes, mode)) throw Object.assign(new Error(`${byTime} already exists`), { code: 'EEXIST' });
  return byTime;
}

/** Create `to` holding `bytes` at `mode`, flushed to disk with its directory
 *  entry where the filesystem allows. False when `to` already exists. A file
 *  this call created and couldn't finish is removed. */
function writeNewFile(to: string, bytes: Buffer, mode: number): boolean {
  let fd: number;
  try {
    fd = openSync(to, 'wx', mode);
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    try {
      fchmodSync(fd, mode); // the bits the umask took
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      rmSync(to, { force: true });
    } catch {
      // The copy's own error is the one to report.
    }
    throw err;
  }
  try {
    const dirFd = openSync(dirname(to), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Not every filesystem can flush a directory; the copy's own data is.
  }
  return true;
}

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
