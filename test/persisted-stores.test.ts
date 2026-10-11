/**
 * The muted channels, the reaction channels and the watermarks are each read
 * once and then rewritten whole after every change. A file that couldn't be
 * read used to leave its store empty, and the next save then overwrote it,
 * so one unreadable file lost every earlier mute, reaction opt-in or
 * watermark. Now a file that isn't exactly what its store writes is copied
 * aside, flushed to disk, and then rewritten with the entries its store can
 * use, and a file that can't be read, copied or rewritten is never saved
 * over. A save replaces a plain file the server owns atomically, keeping its
 * whole mode and its group, and writes anything else in place, as before.
 *
 * Run: node --import tsx --test test/persisted-stores.test.ts
 */
import { describe, it, beforeEach, afterEach, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import fs, {
  chmodSync,
  chownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { writeJsonFile } from '../src/persisted-json.js';
import { loadFiltersFile, saveFiltersFile } from '../src/filters.js';

const ENV = ['DISCORD_MUTED_CHANNELS_FILE', 'DISCORD_REACTION_CHANNELS_FILE', 'DISCORD_WATERMARK_FILE', 'DISCORD_MCPL_DEBUG_LOG'];
let dir: string;
const asRoot = process.getuid?.() === 0; // permission bits don't stop root

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persisted-stores-'));
  process.env.DISCORD_MUTED_CHANNELS_FILE = join(dir, 'muted.json');
  process.env.DISCORD_REACTION_CHANNELS_FILE = join(dir, 'reactions.json');
  process.env.DISCORD_WATERMARK_FILE = join(dir, 'watermarks.json');
});

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function server(t: TestContext) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  t.after(() => adapter.rawClient.destroy());
  const s = new DiscordMcplServer(adapter) as unknown as Record<string, unknown> & {
    executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    ensureWatermarkLoaded(): void;
    ensureMutedLoaded(): void;
    ensureReactionChannelsLoaded(): void;
    saveWatermark(): void;
    subscribeRawChannel(channelId: string): void;
    forwardedWatermark: Map<string, string>;
    dmChannelIds: Set<string>;
    missedTally: Map<string, { anchorId: string; talliedThrough: string; messages: number; characters: number }>;
    mutedChannels: Set<string>;
    reactionChannels: Set<string>;
  };
  s.subscriptionsLoaded = true;
  return s;
}

const errors = (t: TestContext) => t.mock.method(console, 'error', () => {});
const logged = (mock: ReturnType<typeof errors>) => mock.mock.calls.map((c) => c.arguments.map(String).join(' '));
const debugLog = () => readFileSync(join(dir, 'debug.log'), 'utf-8');

/** Run `body` with the umask set, restoring it after. */
async function withUmask(mask: number, body: () => unknown): Promise<void> {
  const before = process.umask(mask);
  try { await body(); } finally { process.umask(before); }
}

type Mockable = 'renameSync' | 'fchmodSync' | 'fchownSync' | 'writeFileSync' | 'openSync' | 'fsyncSync';

/** Run `body` with fs[name] wrapped by `wrap`, for the code under test too. */
async function withFs<K extends Mockable>(
  t: TestContext,
  name: K,
  wrap: (real: (typeof fs)[K]) => (typeof fs)[K],
  body: () => unknown,
): Promise<void> {
  const real = fs[name];
  const mock = t.mock.method(fs, name, wrap(real.bind(fs) as (typeof fs)[K]) as never);
  syncBuiltinESMExports();
  try { await body(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
}

const refuse = (code: string, what: string) => Object.assign(new Error(`${code}: refused, ${what}`), { code });

/** fs.renameSync failing with `code` where `fails` says. */
const renameFailing = (t: TestContext, code: string, fails: (to: string) => boolean, body: () => unknown) =>
  withFs(t, 'renameSync', (real) => ((from: fs.PathLike, to: fs.PathLike) => {
    if (fails(String(to))) throw refuse(code, `rename to ${String(to)}`);
    return real(from, to);
  }) as typeof fs.renameSync, body);

/** fs.openSync failing with `code` for the paths `fails` picks. */
const openFailing = (t: TestContext, code: string, fails: (path: string) => boolean, body: () => unknown) =>
  withFs(t, 'openSync', (real) => ((path: fs.PathLike, ...rest: unknown[]) => {
    if (fails(String(path))) throw refuse(code, `open ${String(path)}`);
    return (real as (...a: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync, body);

/** A full disk for temp files: every save that would replace a file fails. */
const tempsFail = (t: TestContext, body: () => unknown) => openFailing(t, 'ENOSPC', (p) => p.endsWith('.tmp'), body);

const asides = (name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.unreadable-`));
const json = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8'));
const fresh = () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
};
const NOTE = /couldn't be saved \((.*)\), so as it stands now it wouldn't survive a restart\.$/;

describe('a store whose file has content it can not use', () => {
  it('copies an unparsable muted list aside and empties it, so the next mute writes a fresh list', async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    // One id per line, as a hand edit might leave it: V8's parse error
    // quotes text like this, and the log mustn't.
    writeFileSync(join(dir, 'muted.json'), 'chan-a\nchan-b\n');
    const s = server(t);
    s.ensureMutedLoaded();
    assert.deepEqual(json('muted.json'), [], 'the file is emptied as soon as it is read');
    await s.executeToolCall('mute_channel', { channelId: 'chan-new' });
    assert.deepEqual(json('muted.json'), ['chan-new']);
    const [aside] = asides('muted.json');
    assert.ok(aside, 'a copy is kept beside it');
    assert.equal(readFileSync(join(dir, aside), 'utf-8'), 'chan-a\nchan-b\n', 'byte for byte');
    assert.ok(
      logged(log).some((line) => line.includes(aside) && line.includes('emptied the file') && line.includes('stop the server first')),
      'the operator log names the copy and how to restore it',
    );
    assert.ok(!logged(log).some((line) => line.includes('chan-a')), "the log doesn't quote the file");
    assert.match(debugLog(), /persisted-json:copied-aside .*not valid JSON/);
  });

  it("keeps a muted list's ids when it has entries that aren't, and keeps the whole list in a copy", async (t) => {
    const log = errors(t);
    const cases: Array<[string, string[]]> = [
      ['["chan-a", 123456789012345678]', ['chan-a']],
      ['["chan-a", null]', ['chan-a']],
      ['["chan-a", ""]', ['chan-a']],
      ['{"chan-a": true}', []],
    ];
    for (const [content, kept] of cases) {
      fresh();
      writeFileSync(join(dir, 'muted.json'), content);
      const s = server(t);
      s.ensureMutedLoaded();
      assert.deepEqual([...s.mutedChannels], kept, content);
      assert.deepEqual(json('muted.json'), kept, `${content}: the file holds what the store can use`);
      assert.equal(readFileSync(join(dir, asides('muted.json')[0]), 'utf-8'), content, content);
      await s.executeToolCall('mute_channel', { channelId: 'chan-new' });
      assert.deepEqual(json('muted.json'), [...kept, 'chan-new'], content);
    }
    assert.ok(logged(log).some((line) => line.includes('1 of its 2 entries aren\'t ids') && line.includes('rewrote the file with the entries it could use')));
  });

  it('keeps the opt-ins of a reaction list that base wrote with a null, and copies an unparsable one aside', async (t) => {
    errors(t);
    // Base's set_reaction_visibility saved a missing channelId as null.
    const written = JSON.stringify(['chan-r', null], null, 2) + '\n';
    writeFileSync(join(dir, 'reactions.json'), written);
    const s = server(t);
    s.ensureReactionChannelsLoaded();
    assert.deepEqual([...s.reactionChannels], ['chan-r']);
    assert.deepEqual(json('reactions.json'), ['chan-r']);
    assert.equal(readFileSync(join(dir, asides('reactions.json')[0]), 'utf-8'), written);
    fresh();
    writeFileSync(join(dir, 'reactions.json'), 'not json');
    await server(t).executeToolCall('set_reaction_visibility', { channelId: 'chan-new', visible: true });
    assert.deepEqual(json('reactions.json'), ['chan-new']);
    assert.equal(asides('reactions.json').length, 1);
  });

  it('keeps what a watermark file has that the store writes, and copies the file aside when it has anything else', (t) => {
    errors(t);
    const tally = { anchorId: '1', talliedThrough: '2', messages: 3, characters: 40 };
    const good = { watermarks: { 'chan-a': '1' }, dmChannels: ['dm-1'], missed: { 'chan-b': tally } };
    const { watermarks: _w, ...noWatermarks } = good;
    const { dmChannels: _d, ...noDms } = good;
    const cases: Array<[string, object]> = [
      ['{"watermarks": {"chan-a": "1"', {}],
      ['[]', {}],
      [JSON.stringify({ ...good, watermarks: ['1'] }), noWatermarks],
      [JSON.stringify({ ...good, watermarks: null }), noWatermarks],
      [JSON.stringify({ ...good, watermarks: { 'chan-a': '1', 'chan-x': 1 } }), good],
      [JSON.stringify({ ...good, watermarks: { 'chan-a': '1', 'chan-x': '' } }), good],
      [JSON.stringify({ ...good, dmChannels: 'dm-1' }), noDms],
      [JSON.stringify({ ...good, dmChannels: ['dm-1', 1, ''] }), good],
      [JSON.stringify({ ...good, missed: { 'chan-b': tally, 'chan-x': null } }), good],
      [JSON.stringify({ ...good, missed: { 'chan-b': tally, 'chan-x': { ...tally, messages: '3' } } }), good],
      [JSON.stringify({ ...good, missed: { 'chan-b': tally, 'chan-x': { ...tally, anchorId: 1 } } }), good],
      [JSON.stringify({ ...good, missed: { 'chan-b': tally, 'chan-x': { ...tally, talliedThrough: null } } }), good],
      [JSON.stringify({ ...good, missed: { 'chan-b': tally, 'chan-x': { ...tally, characters: '40' } } }), good],
      [JSON.stringify({ ...good, missed: { 'chan-b': tally, '': tally } }), good],
      // What the store doesn't write goes to the copy, not to the next save.
      [JSON.stringify({ ...good, version: 2 }), good],
      [JSON.stringify({ ...good, missed: { 'chan-b': { ...tally, seen: true } } }), good],
    ];
    for (const [content, kept] of cases) {
      fresh();
      writeFileSync(join(dir, 'watermarks.json'), content);
      const s = server(t);
      s.ensureWatermarkLoaded();
      assert.deepEqual(json('watermarks.json'), kept, `${content}: the file holds what the store can use`);
      assert.equal(readFileSync(join(dir, asides('watermarks.json')[0]), 'utf-8'), content, content);
      const has = kept as Partial<typeof good>;
      assert.equal(s.forwardedWatermark.get('chan-a'), has.watermarks?.['chan-a'], content);
      assert.deepEqual([...s.dmChannelIds], has.dmChannels ?? [], content);
      assert.deepEqual(s.missedTally.get('chan-b'), has.missed?.['chan-b'], content);
      assert.equal(s.forwardedWatermark.size + s.missedTally.size, Object.keys(has.watermarks ?? {}).length + Object.keys(has.missed ?? {}).length, content);
    }
  });

  it("keeps the rewritten file's permissions and group, after a restart too, and the copy is as private", async (t) => {
    errors(t);
    writeFileSync(join(dir, 'muted.json'), 'not json');
    chmodSync(join(dir, 'muted.json'), 0o660);
    const other = process.getgroups?.().find((gid) => gid !== statSync(join(dir, 'muted.json')).gid);
    if (other !== undefined) chownSync(join(dir, 'muted.json'), statSync(dir).uid, other);
    await withUmask(0o022, () => server(t).ensureMutedLoaded());
    // A restart before any other save: the next store reads the emptied file.
    await withUmask(0o022, () => server(t).executeToolCall('mute_channel', { channelId: 'chan-new' }));
    assert.equal(statSync(join(dir, 'muted.json')).mode & 0o777, 0o660);
    if (other !== undefined) assert.equal(statSync(join(dir, 'muted.json')).gid, other);
    assert.deepEqual(json('muted.json'), ['chan-new']);
    assert.equal(statSync(join(dir, asides('muted.json')[0])).mode & 0o777, 0o660, 'the copy is no more open');
  });

  it('reads a file that starts with a byte-order mark', (t) => {
    writeFileSync(join(dir, 'muted.json'), '\uFEFF["chan-a"]');
    const s = server(t);
    s.ensureMutedLoaded();
    assert.deepEqual([...s.mutedChannels], ['chan-a']);
    assert.deepEqual(asides('muted.json'), []);
  });

  it('copies a symlinked file aside beside the link, and empties the file it names through the link', async (t) => {
    errors(t);
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'muted.json'), 'not json');
    chmodSync(join(dir, 'real', 'muted.json'), 0o660);
    const other = process.getgroups?.().find((gid) => gid !== statSync(join(dir, 'real', 'muted.json')).gid);
    if (other !== undefined) chownSync(join(dir, 'real', 'muted.json'), statSync(join(dir, 'real')).uid, other);
    symlinkSync(join(dir, 'real', 'muted.json'), join(dir, 'muted.json'));
    await withUmask(0o022, () => server(t).executeToolCall('mute_channel', { channelId: 'chan-new' }));
    assert.ok(lstatSync(join(dir, 'muted.json')).isSymbolicLink(), 'the link is still a link');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'real', 'muted.json'), 'utf-8')), ['chan-new']);
    assert.equal(statSync(join(dir, 'real', 'muted.json')).mode & 0o777, 0o660, 'with the bits the umask would take');
    if (other !== undefined) assert.equal(statSync(join(dir, 'real', 'muted.json')).gid, other, "the file's group");
    assert.equal(readFileSync(join(dir, asides('muted.json')[0]), 'utf-8'), 'not json', 'the copy is beside the link');
  });
});

describe('a store whose file is left in place', () => {
  it('never saves over a file it could neither use nor copy aside, and starts with what it could use', async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    writeFileSync(join(dir, 'muted.json'), '["chan-a", 5]');
    const s = server(t);
    let reply = '';
    await openFailing(t, 'EIO', (p) => p.includes('.unreadable-'), async () => {
      reply = String(await s.executeToolCall('mute_channel', { channelId: 'chan-new' }));
    });
    assert.equal(readFileSync(join(dir, 'muted.json'), 'utf-8'), '["chan-a", 5]', 'the file is as it was');
    assert.deepEqual([...s.mutedChannels].sort(), ['chan-a', 'chan-new'], 'the ids it could use are in force');
    assert.ok(logged(log).some((line) => line.includes('or copy it aside') && line.includes('nothing is saved over that file')));
    assert.match(reply, /^Muted channel chan-new: .* The muted channel list couldn't be saved \(.*muted\.json couldn't be copied aside, so nothing is saved over it until it's read again\), so as it stands now it wouldn't survive a restart\.$/);
    assert.match(debugLog(), /persisted-json:copy-failed /);
  });

  it("doesn't rewrite the file until its copy is flushed to disk, and removes a copy it couldn't flush", async (t) => {
    errors(t);
    writeFileSync(join(dir, 'muted.json'), '["chan-a", 5]');
    let reply = '';
    await withFs(t, 'fsyncSync', () => (() => {
      throw refuse('EIO', 'fsync');
    }) as typeof fs.fsyncSync, async () => {
      reply = String(await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' }));
    });
    assert.equal(readFileSync(join(dir, 'muted.json'), 'utf-8'), '["chan-a", 5]', 'the file is as it was');
    assert.deepEqual(asides('muted.json'), [], 'no unflushed copy is left');
    assert.match(reply, /couldn't be copied aside/);
  });

  it('removes a copy that fails partway, so no partial copy sits under the name of its content', async (t) => {
    errors(t);
    writeFileSync(join(dir, 'muted.json'), '["chan-a", 5]');
    const opened = new Map<number, string>();
    let reply = '';
    await withFs(t, 'openSync', (real) => ((path: fs.PathLike, ...rest: unknown[]) => {
      const fd = (real as (...a: unknown[]) => number)(path, ...rest);
      opened.set(fd, String(path));
      return fd;
    }) as typeof fs.openSync, () =>
      withFs(t, 'writeFileSync', (real) => ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
        if (typeof file === 'number' && opened.get(file)?.includes('.unreadable-')) {
          (real as (...a: unknown[]) => void)(file, String(data).slice(0, 4));
          throw refuse('ENOSPC', 'the copy, partway');
        }
        return (real as (...a: unknown[]) => void)(file, data, ...rest);
      }) as typeof fs.writeFileSync, async () => {
        reply = String(await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' }));
      }));
    assert.deepEqual(asides('muted.json'), [], 'no partial copy is left');
    assert.equal(readFileSync(join(dir, 'muted.json'), 'utf-8'), '["chan-a", 5]', 'the file is as it was');
    assert.match(reply, /couldn't be copied aside/);
  });

  it("never saves over a file it couldn't use or rewrite, though a copy is kept", async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    writeFileSync(join(dir, 'muted.json'), 'not json');
    const s = server(t);
    // The disk is full while the store loads, and has room again after.
    await tempsFail(t, () => s.ensureMutedLoaded());
    const reply = String(await s.executeToolCall('mute_channel', { channelId: 'chan-new' }));
    assert.match(reply, /The muted channel list couldn't be saved \(.*couldn't be rewritten after its copy was kept.*\), so as it stands now it wouldn't survive a restart\.$/);
    assert.equal(readFileSync(join(dir, 'muted.json'), 'utf-8'), 'not json', 'the file is as it was');
    assert.equal(readFileSync(join(dir, asides('muted.json')[0]), 'utf-8'), 'not json', 'and a copy is kept');
    assert.ok(logged(log).some((line) => line.includes("couldn't rewrite the file")));
    assert.match(debugLog(), /persisted-json:rewrite-failed /);
    // A restart while the rewrite still fails reads the same content again,
    // and keeps the one copy it already has.
    await tempsFail(t, () => server(t).ensureMutedLoaded());
    assert.equal(asides('muted.json').length, 1, 'one copy of the same content');
    // An operator edits that copy in place; the next read keeps the
    // original's bytes under a name of their own.
    writeFileSync(join(dir, asides('muted.json')[0]), '["chan-fixed"]');
    await tempsFail(t, () => server(t).ensureMutedLoaded());
    const kept = asides('muted.json').map((f) => readFileSync(join(dir, f), 'utf-8')).sort();
    assert.deepEqual(kept, ['["chan-fixed"]', 'not json'], 'the edited copy and the original bytes both stay');
  });

  it("leaves a file it can't read where it is, refuses to save over it, and reads it again in a new store", { skip: asRoot }, async (t) => {
    const log = errors(t);
    writeFileSync(join(dir, 'muted.json'), '["chan-a"]');
    writeFileSync(join(dir, 'reactions.json'), '["chan-r"]');
    chmodSync(join(dir, 'muted.json'), 0o000);
    chmodSync(join(dir, 'reactions.json'), 0o000);
    const s = server(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    const replies = [
      await s.executeToolCall('mute_channel', { channelId: 'chan-new' }),
      await s.executeToolCall('mute_channel', { channelId: 'chan-new' }), // a repeat says so too
      await s.executeToolCall('unmute_channel', { channelId: 'chan-new' }),
      await s.executeToolCall('set_reaction_visibility', { channelId: 'chan-new', visible: true }),
      await s.executeToolCall('set_reaction_visibility', { channelId: 'chan-new', visible: true }),
    ];
    for (const reply of replies) assert.match(String(reply), / The (muted|reaction) channel list couldn't be saved \(.*couldn't be read, so nothing is saved over it until it's read again\), so as it stands now it wouldn't survive a restart\.$/);
    assert.match(String(replies[1]), /^Channel chan-new was already muted\./);
    assert.match(debugLog(), /persisted-json:unreadable .*muted channels/);
    assert.ok(logged(log).some((line) => line.includes("Couldn't read muted channels") && line.includes('EACCES')));
    assert.deepEqual(
      readdirSync(dir).filter((f) => f !== 'debug.log').sort(), ['muted.json', 'reactions.json'], 'nothing copied, no temp file left',
    );
    chmodSync(join(dir, 'muted.json'), 0o600);
    chmodSync(join(dir, 'reactions.json'), 0o600);
    assert.deepEqual(json('muted.json'), ['chan-a'], 'the file is as it was');
    const again = server(t);
    again.ensureMutedLoaded();
    assert.deepEqual([...again.mutedChannels], ['chan-a'], 'a new store reads it');
    const saved = String(await again.executeToolCall('mute_channel', { channelId: 'chan-b' }));
    assert.match(saved, /^Muted channel chan-b: /);
    assert.doesNotMatch(saved, /couldn't be saved/);
    assert.deepEqual(json('muted.json'), ['chan-a', 'chan-b'], 'and saves again');
  });

  it("leaves a path it can't read as a file where it is, and refuses to save over it, as root too", async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    mkdirSync(join(dir, 'muted.json')); // its read fails with EISDIR, which root gets too
    const s = server(t);
    // The first call changes nothing, but the file may not hold the list.
    const first = String(await s.executeToolCall('unmute_channel', { channelId: 'chan-z' }));
    assert.match(first, /^Channel chan-z was not muted\. The muted channel list couldn't be saved/);
    const reply = String(await s.executeToolCall('mute_channel', { channelId: 'chan-new' }));
    assert.match(reply, /^Muted channel chan-new: .* The muted channel list couldn't be saved \(.*muted\.json couldn't be read, so nothing is saved over it until it's read again\), so as it stands now it wouldn't survive a restart\.$/);
    assert.ok(lstatSync(join(dir, 'muted.json')).isDirectory(), 'the path is as it was');
    assert.ok(logged(log).some((line) => line.includes("Couldn't read muted channels") && line.includes('EISDIR')));
    assert.match(debugLog(), /persisted-json:unreadable .*muted channels/);
  });
});

describe('the watermark store and the tools', () => {
  it("refuses to save watermarks over a path it can't read, and logs a lasting refusal once", (t) => {
    const log = errors(t);
    mkdirSync(join(dir, 'watermarks.json'));
    const s = server(t);
    s.ensureWatermarkLoaded();
    for (const id of ['2', '3', '4']) {
      s.forwardedWatermark.set('chan-new', id);
      s.saveWatermark();
    }
    assert.ok(lstatSync(join(dir, 'watermarks.json')).isDirectory(), 'the path is as it was');
    const failures = logged(log).filter((line) => line.includes('Failed to save watermarks'));
    assert.equal(failures.length, 1, 'three refused saves, logged once');
    assert.match(failures[0], /couldn't be read/);
  });

  it('logs a failing watermark save when it starts, when its reason changes and when saves succeed again', async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    const s = server(t);
    s.ensureWatermarkLoaded();
    let id = 10;
    const save = () => {
      s.forwardedWatermark.set('chan-a', String(id++));
      s.saveWatermark();
    };
    await openFailing(t, 'ENOSPC', (p) => p.endsWith('.tmp'), () => { save(); save(); });
    await openFailing(t, 'EDQUOT', (p) => p.endsWith('.tmp'), () => save());
    save();
    save();
    await openFailing(t, 'ENOSPC', (p) => p.endsWith('.tmp'), () => save());
    const lines = logged(log).filter((line) => line.includes('watermarks'));
    assert.deepEqual(
      lines.map((line) => (/ENOSPC|EDQUOT/.exec(line)?.[0] ?? (line.includes('again') ? 'again' : line))),
      ['ENOSPC', 'EDQUOT', 'again', 'ENOSPC'],
    );
    assert.equal(debugLog().match(/watermark:save-failed /g)?.length, 4, 'the debug log records each');
    assert.deepEqual(json('watermarks.json').watermarks, { 'chan-a': '14' }, 'the last save that landed');
  });

  it('refuses a channelId that is not an id, so no store saves one', async (t) => {
    const s = server(t);
    for (const channelId of [undefined, 42, '']) {
      for (const tool of ['set_reaction_visibility', 'mute_channel', 'unmute_channel']) {
        await assert.rejects(s.executeToolCall(tool, { channelId, visible: true }), /channelId is required/, `${tool} ${String(channelId)}`);
      }
    }
    assert.deepEqual(readdirSync(dir), [], 'nothing was saved');
  });

  it("saves the muted list when a call changes it or its file may not hold it, and says so only then", async (t) => {
    errors(t);
    const s = server(t);
    const call = async (tool: string, channelId: string) => String(await s.executeToolCall(tool, { channelId }));
    assert.doesNotMatch(await call('mute_channel', 'chan-a'), /couldn't be saved/);
    await tempsFail(t, async () => {
      assert.equal(await call('mute_channel', 'chan-a'), 'Channel chan-a was already muted.', 'a no-op makes no save');
      assert.equal(await call('unmute_channel', 'chan-z'), 'Channel chan-z was not muted.', 'nor does this one');
      assert.match(await call('mute_channel', 'chan-b'), /^Muted channel chan-b: .* The muted channel list couldn't be saved \(.*ENOSPC.*\), so as it stands now it wouldn't survive a restart\.$/);
      assert.match(await call('mute_channel', 'chan-b'), /^Channel chan-b was already muted\. The muted channel list couldn't be saved/, 'until a save lands, a repeat saves again');
    });
    assert.equal(await call('mute_channel', 'chan-b'), 'Channel chan-b was already muted.', 'and the repeat that lands says nothing');
    assert.deepEqual(json('muted.json'), ['chan-a', 'chan-b']);
    await tempsFail(t, async () => {
      assert.equal(await call('mute_channel', 'chan-b'), 'Channel chan-b was already muted.', 'once saved, a no-op makes no save');
    });
  });

  it("saves the reaction list when a call changes it or its file may not hold it, an open's opt-in included", async (t) => {
    errors(t);
    const s = server(t);
    const call = async (channelId: string) => String(await s.executeToolCall('set_reaction_visibility', { channelId, visible: true }));
    await call('chan-r');
    await tempsFail(t, async () => {
      assert.doesNotMatch(await call('chan-r'), /couldn't be saved/, 'a no-op makes no save');
    });
    s.subscribeRawChannel('chan-open'); // an open opts in without saving
    assert.deepEqual(json('reactions.json'), ['chan-r']);
    await call('chan-open');
    assert.deepEqual(json('reactions.json'), ['chan-open', 'chan-r'], 'the next call saves the opt-in');
  });
});

describe('a store whose file it can write but not read', () => {
  it("never saves over it, since it can't tell what the file holds", { skip: asRoot }, async (t) => {
    errors(t);
    writeFileSync(join(dir, 'muted.json'), '["keep-me"]');
    chmodSync(join(dir, 'muted.json'), 0o200);
    const reply = String(await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' }));
    assert.match(reply, NOTE);
    assert.match(reply, /couldn't be read/);
    chmodSync(join(dir, 'muted.json'), 0o600);
    assert.deepEqual(json('muted.json'), ['keep-me'], 'the file is as it was');
  });
});

describe('a store whose file is there and readable, or not there yet', () => {
  it('starts empty with no files, and the first save of each store creates its file at the default mode', async (t) => {
    await withUmask(0o022, async () => {
      const s = server(t);
      await s.executeToolCall('mute_channel', { channelId: 'chan-m' });
      await s.executeToolCall('set_reaction_visibility', { channelId: 'chan-r', visible: true });
      s.ensureWatermarkLoaded();
      s.forwardedWatermark.set('chan-w', '9');
      s.saveWatermark();
    });
    assert.deepEqual(json('muted.json'), ['chan-m']);
    assert.deepEqual(json('reactions.json'), ['chan-r']);
    assert.deepEqual(json('watermarks.json').watermarks, { 'chan-w': '9' });
    assert.deepEqual(readdirSync(dir).sort(), ['muted.json', 'reactions.json', 'watermarks.json']);
    for (const name of ['muted.json', 'reactions.json', 'watermarks.json']) {
      assert.equal(statSync(join(dir, name)).mode & 0o7777, 0o644, `${name}: 0666 less the umask, as before`);
    }
  });

  it('loads a readable file of each store as before, and moves nothing', async (t) => {
    const tally = { anchorId: '1', talliedThrough: '2', messages: 3, characters: 40 };
    writeFileSync(join(dir, 'muted.json'), '["chan-a"]');
    writeFileSync(join(dir, 'reactions.json'), '["chan-r"]');
    writeFileSync(
      join(dir, 'watermarks.json'),
      JSON.stringify({
        watermarks: { 'chan-a': '1' },
        dmChannels: ['dm-1'],
        missed: { 'chan-b': tally, 'chan-c': { anchorId: '5', messages: 0, characters: 0 } },
      }),
    );
    const s = server(t);
    await s.executeToolCall('mute_channel', { channelId: 'chan-new' });
    assert.deepEqual(json('muted.json'), ['chan-a', 'chan-new']);
    s.ensureReactionChannelsLoaded();
    assert.deepEqual([...s.reactionChannels], ['chan-r']);
    s.ensureWatermarkLoaded();
    assert.equal(s.forwardedWatermark.get('chan-a'), '1');
    assert.deepEqual([...s.dmChannelIds], ['dm-1']);
    assert.deepEqual(s.missedTally.get('chan-b'), tally);
    assert.deepEqual(s.missedTally.get('chan-c'), { anchorId: '5', talliedThrough: '5', messages: 0, characters: 0 });
    assert.deepEqual(readdirSync(dir).sort(), ['muted.json', 'reactions.json', 'watermarks.json']);
  });

  it('loads a watermark file that lacks any of its keys, or holds the tally base writes for a channel closed before any forward', (t) => {
    const tally = { anchorId: '1', talliedThrough: '2', messages: 3, characters: 40 };
    const whole = { watermarks: { 'chan-a': '1' }, dmChannels: ['dm-1'], missed: { 'chan-b': tally } };
    for (const key of ['watermarks', 'dmChannels', 'missed'] as const) {
      fresh();
      const rest: Partial<typeof whole> = { ...whole };
      delete rest[key];
      writeFileSync(join(dir, 'watermarks.json'), JSON.stringify(rest));
      const s = server(t);
      s.ensureWatermarkLoaded();
      assert.deepEqual(readdirSync(dir), ['watermarks.json'], `without ${key}: nothing copied`);
      assert.equal(s.forwardedWatermark.get('chan-a'), key === 'watermarks' ? undefined : '1', key);
      assert.deepEqual([...s.dmChannelIds], key === 'dmChannels' ? [] : ['dm-1'], key);
      assert.deepEqual(s.missedTally.get('chan-b'), key === 'missed' ? undefined : tally, key);
    }
    fresh();
    // Base's unsubscribe before any forward: an empty anchor and cursor.
    const unanchored = { anchorId: '', talliedThrough: '', messages: 2, characters: 9 };
    writeFileSync(join(dir, 'watermarks.json'), JSON.stringify({ watermarks: {}, dmChannels: [], missed: { 'chan-c': unanchored } }));
    const s = server(t);
    s.ensureWatermarkLoaded();
    assert.deepEqual(s.missedTally.get('chan-c'), unanchored);
    assert.deepEqual(readdirSync(dir), ['watermarks.json'], 'nothing copied');
  });
});

describe('writeJsonFile', () => {
  it('replaces the file only by the rename, so a save that fails leaves the old bytes and no temp file', async (t) => {
    const path = join(dir, 'store.json');
    writeJsonFile(path, ['a']);
    const before = readFileSync(path, 'utf-8');
    await renameFailing(t, 'EIO', (to) => to === path, () => {
      assert.throws(() => writeJsonFile(path, ['b']), /EIO/);
    });
    assert.equal(readFileSync(path, 'utf-8'), before, 'the old file is whole and unchanged');
    assert.deepEqual(readdirSync(dir), ['store.json'], 'the failed save left no temp file');
    writeJsonFile(path, ['b']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
    assert.deepEqual(readdirSync(dir), ['store.json'], 'a good save leaves no temp file');
  });

  it('fails a save on a full disk or quota rather than write in place, leaving the file as last saved', async (t) => {
    for (const code of ['ENOSPC', 'EDQUOT']) {
      const path = join(dir, `store-${code}.json`);
      writeJsonFile(path, ['a']);
      await withFs(t, 'writeFileSync', (real) => ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof file === 'number') throw refuse(code, 'write the temp file');
        return (real as (...a: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync, () => {
        assert.throws(() => writeJsonFile(path, ['b']), { code });
      });
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['a'], code);
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  });

  it("keeps the file's permissions, including bits the umask would take", async () => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    chmodSync(path, 0o660);
    await withUmask(0o022, () => writeJsonFile(path, ['b']));
    assert.equal(statSync(path).mode & 0o777, 0o660);
  });

  it('keeps the mode bits beyond the permissions that a write in place keeps: sticky, and setgid without group execute', async () => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    chmodSync(path, 0o3660);
    await withUmask(0o022, () => writeJsonFile(path, ['b']));
    assert.equal(statSync(path).mode & 0o7777, 0o3660);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
  });

  it("gives the replacement the old file's group", async (t) => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    const calls: Array<[number, number]> = [];
    await withFs(t, 'fchownSync', (real) => ((fd: number, uid: number, gid: number) => {
      calls.push([uid, gid]);
      return real(fd, uid, gid);
    }) as typeof fs.fchownSync, () => writeJsonFile(path, ['b']));
    assert.deepEqual(calls, [[statSync(path).uid, statSync(path).gid]]);
  });

  it("keeps the file's group", (t) => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    const own = statSync(path).gid;
    const other = asRoot ? (own === 1 ? 2 : 1) : process.getgroups?.().find((gid) => gid !== own);
    if (other === undefined) return t.skip('the test user is in no second group');
    chownSync(path, statSync(path).uid, other);
    writeJsonFile(path, ['b']);
    assert.equal(statSync(path).gid, other);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
  });

  it("puts content in the temp file only once it has the target's mode and group", async (t) => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    chmodSync(path, 0o660);
    const atWrite: Array<{ mode: number; gid: number }> = [];
    await withUmask(0o022, () =>
      withFs(t, 'writeFileSync', (real) => ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof file === 'number') {
          const st = fs.fstatSync(file);
          atWrite.push({ mode: st.mode & 0o7777, gid: st.gid });
        }
        return (real as (...a: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync, () => writeJsonFile(path, ['b'])),
    );
    assert.deepEqual(atWrite, [{ mode: 0o660, gid: statSync(path).gid }]);
  });

  it("writes in place when it can't give the new file the old one's group", async (t) => {
    errors(t);
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    const inode = statSync(path).ino;
    await withFs(t, 'fchownSync', () => (() => {
      throw refuse('EPERM', 'chown to a group the server is not in');
    }) as typeof fs.fchownSync, () => writeJsonFile(path, ['b']));
    assert.equal(statSync(path).ino, inode, 'the same file, not a replacement');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
    assert.deepEqual(readdirSync(dir), ['shared.json'], 'no temp file left');
  });

  it('makes a fresh temp file at the target permissions, whatever a stale one had', async (t) => {
    const path = join(dir, 'private.json');
    writeJsonFile(path, ['a']);
    chmodSync(path, 0o600);
    for (const staleMode of [0o644, 0o400]) {
      writeFileSync(`${path}.tmp`, 'stale');
      chmodSync(`${path}.tmp`, staleMode);
      const atCreation: number[] = [];
      await withUmask(0o000, () =>
        withFs(t, 'fchmodSync', (real) => ((fd: number, m: fs.Mode) => {
          atCreation.push(fs.fstatSync(fd).mode & 0o777);
          return real(fd, m);
        }) as typeof fs.fchmodSync, () => writeJsonFile(path, ['b'])),
      );
      assert.deepEqual(atCreation, [0o600], `the temp file is created private (stale ${staleMode.toString(8)})`);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
      assert.deepEqual(readdirSync(dir), ['private.json']);
    }
  });

  it('writes a symlinked file through the link, keeping the link', () => {
    mkdirSync(join(dir, 'real'));
    const target = join(dir, 'real', 'store.json');
    writeJsonFile(target, ['a']);
    symlinkSync(target, join(dir, 'store.json'));
    writeJsonFile(join(dir, 'store.json'), ['b']);
    assert.ok(lstatSync(join(dir, 'store.json')).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf-8')), ['b']);
  });

  it('writes a hard-linked file in place, so every name sees the save', () => {
    const path = join(dir, 'store.json');
    writeJsonFile(path, ['a']);
    linkSync(path, join(dir, 'other-name.json'));
    writeJsonFile(path, ['b']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'other-name.json'), 'utf-8')), ['b']);
  });

  it("writes another user's file in place, so its owner stays", async (t) => {
    const path = join(dir, 'store.json');
    writeJsonFile(path, ['a']);
    const inode = statSync(path).ino;
    t.mock.method(process as unknown as { getuid(): number }, 'getuid', () => statSync(path).uid + 1);
    writeJsonFile(path, ['b']);
    assert.equal(statSync(path).ino, inode, 'the same file, not a replacement');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
  });

  it("writes in place for each error that means the path can't be saved by replacement, from the chown, the chmod or the rename", async (t) => {
    errors(t);
    // EBUSY: a bind-mounted file; EROFS: a read-only filesystem around one;
    // ENOTSUP and kin: a filesystem without permissions; EINVAL: a group the
    // user namespace doesn't map; the rest: a directory or name that won't
    // take the temp file.
    const codes = ['EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS', 'ENAMETOOLONG', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'];
    for (const step of ['fchownSync', 'fchmodSync', 'renameSync'] as const) {
      for (const code of codes) {
        const path = join(dir, `store-${step}-${code}.json`);
        writeJsonFile(path, ['a']);
        chmodSync(path, 0o640); // so the chmod runs
        const inode = statSync(path).ino;
        await withFs(t, step, () => (() => {
          throw refuse(code, step);
        }) as never, () => writeJsonFile(path, ['b']));
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b'], `${step} ${code}`);
        assert.equal(statSync(path).ino, inode, `${step} ${code}: written in place`);
      }
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  });

  it('logs the first in-place write of a path for such an error, and records each in the debug log', async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    const path = join(dir, 'store.json');
    writeJsonFile(path, ['a']);
    await renameFailing(t, 'EXDEV', (to) => to === path, () => {
      writeJsonFile(path, ['b']);
      writeJsonFile(path, ['c']);
    });
    const lines = logged(log).filter((line) => line.includes(path));
    assert.equal(lines.length, 1, 'logged once');
    assert.match(lines[0], /in place.*EXDEV.*could tear it/);
    assert.equal(debugLog().match(/persisted-json:in-place .*EXDEV/g)?.length, 2);
  });

  it("writes in place when the directory won't take a new file", { skip: asRoot }, (t) => {
    errors(t);
    const path = join(dir, 'store.json');
    writeJsonFile(path, ['a']);
    chmodSync(dir, 0o500);
    writeJsonFile(path, ['b']);
    chmodSync(dir, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
    assert.deepEqual(readdirSync(dir), ['store.json']);
  });

  it("writes in place when the name has no room for '.tmp'", (t) => {
    errors(t);
    const path = join(dir, `${'s'.repeat(250)}.json`); // 255 bytes, the usual limit
    writeJsonFile(path, ['a']);
    writeJsonFile(path, ['b']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
  });

  it("doesn't replace a file it couldn't write in place", { skip: asRoot }, () => {
    const path = join(dir, 'locked.json');
    writeJsonFile(path, ['a']);
    chmodSync(path, 0o444);
    assert.throws(() => writeJsonFile(path, ['b']), { code: 'EACCES' });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['a']);
  });
});

describe('the filters file', () => {
  it('keeps a private filters file private', async () => {
    const path = join(dir, 'filters.json');
    saveFiltersFile(path, { dmUsers: ['111'] });
    chmodSync(path, 0o600);
    await withUmask(0o022, () => saveFiltersFile(path, { dmUsers: ['222'] }));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')).dmUsers, ['222']);
  });

  it('refuses to save over a read-only filters file, leaving it as it is', { skip: asRoot }, () => {
    const path = join(dir, 'filters.json');
    saveFiltersFile(path, { dmUsers: ['111'] });
    chmodSync(path, 0o444);
    assert.throws(() => saveFiltersFile(path, { dmUsers: ['222'] }), { code: 'EACCES' });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')).dmUsers, ['111']);
    assert.equal(statSync(path).mode & 0o777, 0o444);
  });

  it('reads a filters file that starts with a byte-order mark', () => {
    const path = join(dir, 'filters.json');
    writeFileSync(path, '\uFEFF{"dmUsers": ["111"]}');
    assert.deepEqual(loadFiltersFile(path)?.dmUsers, ['111']);
  });
});
