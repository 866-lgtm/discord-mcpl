/**
 * The server's small persisted JSON files: the muted channels, the reaction
 * channels and the watermarks, each read once and rewritten whole after every
 * change. The filters file is saved here too; its reader is loadFiltersFile.
 *
 * Reading (readJsonFile):
 * - No file means a store with nothing in it yet.
 * - A file whose content can't be used, because it isn't JSON or isn't the
 *   shape its store expects, keeps its place: a copy goes aside to
 *   `<file>.unreadable-<hash>`, named by its content so that reading the same
 *   content again (say, while the emptying keeps failing) keeps one copy, and
 *   the file itself is emptied by an ordinary save, so its permissions, owner,
 *   group and links stay. The store starts empty. To restore the copy, an
 *   operator stops the server first, since a running server saves over its
 *   file.
 * - A file that can't be read at all (EACCES, EIO, EMFILE…) says nothing
 *   about its content, so it stays as it is, and nothing saves over it until
 *   it's read again: at a restart, or by a new store. The same holds when
 *   the copy or the emptying fails. The store runs in memory meanwhile.
 *
 * Saving (writeJsonFile) replaces a plain file the server owns atomically: a
 * temp file beside it, created with its permissions and given its group,
 * renamed over it. So a process crash partway through can't leave a torn
 * file. There's no fsync, so on some filesystems a power loss can still
 * leave it empty, and the reader then copies that aside. Everything else is
 * written in place, as it was before saves were atomic, where a crash
 * partway through can still tear the file: a symlink, a file with other hard
 * links or another owner, a group the server isn't in, and a file whose
 * directory, filesystem or name won't take the temp file and rename (no
 * write access to the directory, a read-only filesystem around a
 * bind-mounted file, a filesystem without permissions, a name with no room
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
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { dbg } from './debug-log.js';

/** Paths whose file couldn't be read, or copied aside and emptied: saving over them could destroy them. */
const unsaveable = new Set<string>();
/** Errors from the temp file, its chown or chmod, or the rename that mean this
 *  path can't be saved by replacement, so it's written in place. */
const WRITE_IN_PLACE_ON = new Set([
  'EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS', 'ENAMETOOLONG', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS',
]);

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
  const ownUid = process.getuid?.();
  // A rename would turn a symlink into a plain file, split a hard link, or
  // take another user's file over, so only a plain file the server owns, with
  // no other name, is replaced.
  if (old && !(old.isFile() && old.nlink === 1 && (ownUid === undefined || old.uid === ownUid))) {
    writeFileSync(path, text);
    return;
  }
  // A file the server couldn't write in place isn't replaced either.
  if (old) accessSync(path, constants.W_OK);
  const mode = old ? old.mode & 0o777 : undefined;
  const tmp = `${path}.tmp`;
  try {
    // A stale temp file keeps its own mode and owner, so it's never reused:
    // the temp file is created fresh, never more open than its target.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, text, { mode: mode ?? 0o666, flag: 'wx' });
    // The temp file is in the server's group. It takes the old file's, and
    // for a group the server isn't in that fails (EPERM): written in place.
    if (old && ownUid !== undefined) chownSync(tmp, ownUid, old.gid);
    if (mode !== undefined) chmodSync(tmp, mode); // the bits the umask, or the chown, took
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The save's own error is the one to report.
    }
    if (!WRITE_IN_PLACE_ON.has(errorCode(err) ?? '')) throw err;
    writeFileSync(path, text);
  }
}

/** The file's parsed contents, or undefined when there's no file or it can't
 *  be used: copied aside and emptied (as `empty`), or left as it is and not
 *  saved over (see the module comment). console.error and the debug log say
 *  which. `what` names the store. */
export function readJsonFile<T>(
  path: string,
  what: string,
  isShape: (value: unknown) => value is T,
  empty: T,
): T | undefined {
  unsaveable.delete(path); // each read decides afresh
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
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
    // An editor's byte-order mark isn't part of the JSON.
    const parsed: unknown = JSON.parse(bytes.toString('utf-8').replace(/^\uFEFF/, ''));
    if (isShape(parsed)) return parsed;
    problem = 'not the shape this store expects';
  } catch {
    problem = 'not valid JSON'; // JSON.parse's own message quotes the file's text
  }
  // Named by content: a copy already kept under this name holds these bytes.
  const aside = `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
  try {
    copyFileSync(path, aside, constants.COPYFILE_EXCL);
  } catch (err) {
    // EEXIST: an earlier read kept this very content, as when the emptying
    // keeps failing across restarts. One copy is enough.
    if (errorCode(err) !== 'EEXIST') {
      unsaveable.add(path);
      console.error(
        `[discord-mcpl] Couldn't load ${what} from ${path} (${problem}), or copy it aside (${(err as Error).message}). ` +
          "Starting with none, and nothing is saved over that file until it's read again.",
      );
      dbg('persisted-json:copy-failed', { what, path, problem, error: (err as Error).message });
      return undefined;
    }
  }
  try {
    writeJsonFile(path, empty);
  } catch (err) {
    unsaveable.add(path);
    console.error(
      `[discord-mcpl] Couldn't load ${what} from ${path} (${problem}). Kept a copy at ${aside}, but couldn't empty ` +
        `the file (${(err as Error).message}). Starting with none, and nothing is saved over it until it's read again.`,
    );
    dbg('persisted-json:empty-failed', { what, path, aside, problem, error: (err as Error).message });
    return undefined;
  }
  console.error(
    `[discord-mcpl] Couldn't load ${what} from ${path} (${problem}). Kept a copy at ${aside}, emptied the file, ` +
      'and starting with none. To restore the copy, stop the server first: a running server saves over its file.',
  );
  dbg('persisted-json:copied-aside', { what, path, aside, problem });
  return undefined;
}

/** A list of ids, every one a non-empty string. */
export const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
