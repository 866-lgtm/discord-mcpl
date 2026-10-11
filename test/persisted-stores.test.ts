/**
 * The muted channels, the reaction channels and the watermarks are each read
 * once and then rewritten whole after every change. A file that couldn't be
 * read used to leave its store empty, and the next save then overwrote it,
 * so one unreadable file lost every earlier mute, reaction opt-in or
 * watermark. Now a file whose content can't be used is copied aside and
 * emptied in place before its store starts empty, and a file that can't be
 * read, copied or emptied is never saved over. A save replaces a plain file the server owns atomically, keeping its
 * permissions and group, and writes anything else in place, as before.
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
import { saveFiltersFile } from '../src/filters.js';

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

/** Run `body` with the umask set, restoring it after. */
async function withUmask(mask: number, body: () => unknown): Promise<void> {
  const before = process.umask(mask);
  try { await body(); } finally { process.umask(before); }
}

/** Run `body` with fs[name] wrapped by `wrap`, for the code under test too. */
async function withFs<K extends 'renameSync' | 'chmodSync' | 'chownSync' | 'writeFileSync' | 'copyFileSync'>(
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

const asides = (name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.unreadable-`));
const json = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8'));

describe('a store whose file has content it can not use', () => {
  it('copies an unparsable muted list aside and empties it, so the next mute writes a fresh list', async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    writeFileSync(join(dir, 'muted.json'), '["chan-a", "chan-b"');
    const s = server(t);
    s.ensureMutedLoaded();
    assert.deepEqual(json('muted.json'), [], 'the file is emptied as soon as it is read');
    await s.executeToolCall('mute_channel', { channelId: 'chan-new' });
    assert.deepEqual(json('muted.json'), ['chan-new']);
    const [aside] = asides('muted.json');
    assert.ok(aside, 'a copy is kept beside it');
    assert.equal(readFileSync(join(dir, aside), 'utf-8'), '["chan-a", "chan-b"', 'byte for byte');
    assert.ok(
      logged(log).some((line) => line.includes(aside) && line.includes('stop the server first')),
      'the operator log names the copy and how to restore it',
    );
    assert.ok(!logged(log).some((line) => line.includes('chan-a')), "the log doesn't quote the file");
    assert.match(readFileSync(join(dir, 'debug.log'), 'utf-8'), /persisted-json:copied-aside .*not valid JSON/);
  });

  it('copies aside a muted list of the wrong shape, or with an entry that is not an id', async (t) => {
    errors(t);
    for (const content of ['{"chan-a": true}', '["chan-a", 123456789012345678]', '["chan-a", null]', '["chan-a", ""]']) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeFileSync(join(dir, 'muted.json'), content);
      await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' });
      assert.deepEqual(json('muted.json'), ['chan-new'], content);
      assert.equal(readFileSync(join(dir, asides('muted.json')[0]), 'utf-8'), content, content);
    }
  });

  it('copies an unparsable reaction-channel list aside', async (t) => {
    errors(t);
    writeFileSync(join(dir, 'reactions.json'), 'not json');
    await server(t).executeToolCall('set_reaction_visibility', { channelId: 'chan-new', visible: true });
    assert.deepEqual(json('reactions.json'), ['chan-new']);
    assert.equal(asides('reactions.json').length, 1);
  });

  it('copies aside a watermark file that is unparsable, or has anything the loader reads in the wrong type', (t) => {
    errors(t);
    const tally = { anchorId: '1', talliedThrough: '2', messages: 3, characters: 40 };
    const cases = [
      '{"watermarks": {"chan-a": "1"',
      '[]',
      JSON.stringify({ watermarks: ['1'] }),
      JSON.stringify({ watermarks: { 'chan-a': 1 } }),
      JSON.stringify({ dmChannels: 'dm-1' }),
      JSON.stringify({ dmChannels: [1] }),
      JSON.stringify({ missed: { 'chan-b': null } }),
      JSON.stringify({ missed: { 'chan-b': { ...tally, messages: '3' } } }),
      JSON.stringify({ missed: { 'chan-b': { ...tally, anchorId: 1 } } }),
      JSON.stringify({ missed: { 'chan-b': { ...tally, talliedThrough: null } } }),
      JSON.stringify({ missed: { 'chan-b': { ...tally, characters: '40' } } }),
      JSON.stringify({ watermarks: { 'chan-a': '' } }),
      JSON.stringify({ dmChannels: [''] }),
      JSON.stringify({ missed: { '': tally } }),
    ];
    for (const content of cases) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeFileSync(join(dir, 'watermarks.json'), content);
      const s = server(t);
      s.ensureWatermarkLoaded();
      assert.equal(s.missedTally.size + s.forwardedWatermark.size + s.dmChannelIds.size, 0, content);
      s.forwardedWatermark.set('chan-new', '2');
      s.saveWatermark();
      assert.deepEqual(json('watermarks.json').watermarks, { 'chan-new': '2' }, content);
      assert.equal(readFileSync(join(dir, asides('watermarks.json')[0]), 'utf-8'), content, content);
    }
  });

  it('keeps the emptied file\'s permissions and group, after a restart too, and the copy is as private', async (t) => {
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
  it('never saves over a file it could neither use nor copy aside, and says so', async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    writeFileSync(join(dir, 'muted.json'), '["chan-a", "chan-b"');
    let reply: unknown;
    await withFs(t, 'copyFileSync', () => (() => {
      throw refuse('EIO', 'copy');
    }) as typeof fs.copyFileSync, async () => {
      reply = await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' });
    });
    assert.equal(readFileSync(join(dir, 'muted.json'), 'utf-8'), '["chan-a", "chan-b"', 'the file is as it was');
    assert.ok(logged(log).some((line) => line.includes('nothing is saved over that file')));
    assert.match(String(reply), /^Muted channel chan-new: .* The (muted|reaction) channel list couldn't be saved \(.*\), so until a later save succeeds, a restart would undo this\.$/);
    assert.match(readFileSync(join(dir, 'debug.log'), 'utf-8'), /persisted-json:copy-failed /);
  });

  it("never saves over a file it couldn't use or empty, though a copy is kept", async (t) => {
    const log = errors(t);
    process.env.DISCORD_MCPL_DEBUG_LOG = join(dir, 'debug.log');
    writeFileSync(join(dir, 'muted.json'), 'not json');
    const s = server(t);
    // The disk is full while the store loads, and has room again after.
    await withFs(t, 'writeFileSync', (real) => ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(p).endsWith('.tmp')) throw refuse('ENOSPC', 'no space');
      return (real as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync, () => s.ensureMutedLoaded());
    const reply = String(await s.executeToolCall('mute_channel', { channelId: 'chan-new' }));
    assert.match(reply, /The (muted|reaction) channel list couldn't be saved \(.*\), so until a later save succeeds, a restart would undo this\.$/);
    assert.equal(readFileSync(join(dir, 'muted.json'), 'utf-8'), 'not json', 'the file is as it was');
    assert.equal(readFileSync(join(dir, asides('muted.json')[0]), 'utf-8'), 'not json', 'and a copy is kept');
    assert.ok(logged(log).some((line) => line.includes("couldn't empty the file")));
    assert.match(readFileSync(join(dir, 'debug.log'), 'utf-8'), /persisted-json:empty-failed /);
    // A restart while the emptying still fails reads the same content again,
    // and keeps the one copy it already has.
    await withFs(t, 'writeFileSync', (real) => ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(p).endsWith('.tmp')) throw refuse('ENOSPC', 'no space');
      return (real as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync, () => server(t).ensureMutedLoaded());
    assert.equal(asides('muted.json').length, 1, 'one copy of the same content');
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
    for (const reply of replies) assert.match(String(reply), /The (muted|reaction) channel list couldn't be saved \(.*\), so until a later save succeeds, a restart would undo this\.$/);
    assert.match(String(replies[1]), /^Channel chan-new was already muted\./);
    assert.match(readFileSync(join(dir, 'debug.log'), 'utf-8'), /persisted-json:unreadable .*muted channels/);
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
});

describe('the watermark store and the tools', () => {
  it("refuses to save watermarks over a file it can't read, and logs each refusal", { skip: asRoot }, (t) => {
    const log = errors(t);
    writeFileSync(join(dir, 'watermarks.json'), '{"watermarks": {"chan-a": "1"}}');
    chmodSync(join(dir, 'watermarks.json'), 0o000);
    const s = server(t);
    s.ensureWatermarkLoaded();
    s.forwardedWatermark.set('chan-new', '2');
    s.saveWatermark();
    chmodSync(join(dir, 'watermarks.json'), 0o600);
    assert.deepEqual(json('watermarks.json'), { watermarks: { 'chan-a': '1' } }, 'the file is as it was');
    assert.ok(logged(log).some((line) => line.includes('Failed to save watermarks') && line.includes("couldn't be read")));
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
});

describe('a store whose file it can write but not read', () => {
  it("never saves over it, since it can't tell what the file holds", { skip: asRoot }, async (t) => {
    errors(t);
    writeFileSync(join(dir, 'muted.json'), '["keep-me"]');
    chmodSync(join(dir, 'muted.json'), 0o200);
    const reply = String(await server(t).executeToolCall('mute_channel', { channelId: 'chan-new' }));
    assert.match(reply, /The muted channel list couldn't be saved \(.*couldn't be read.*\), so until a later save succeeds, a restart would undo this\.$/);
    chmodSync(join(dir, 'muted.json'), 0o600);
    assert.deepEqual(json('muted.json'), ['keep-me'], 'the file is as it was');
  });
});

describe('a store whose file is there and readable, or not there yet', () => {
  it('starts empty with no files, and the first save of each store creates its file', async (t) => {
    const s = server(t);
    await s.executeToolCall('mute_channel', { channelId: 'chan-m' });
    await s.executeToolCall('set_reaction_visibility', { channelId: 'chan-r', visible: true });
    s.ensureWatermarkLoaded();
    s.forwardedWatermark.set('chan-w', '9');
    s.saveWatermark();
    assert.deepEqual(json('muted.json'), ['chan-m']);
    assert.deepEqual(json('reactions.json'), ['chan-r']);
    assert.deepEqual(json('watermarks.json').watermarks, { 'chan-w': '9' });
    assert.deepEqual(readdirSync(dir).sort(), ['muted.json', 'reactions.json', 'watermarks.json']);
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

  it("keeps the file's permissions, including bits the umask would take", async () => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    chmodSync(path, 0o660);
    await withUmask(0o022, () => writeJsonFile(path, ['b']));
    assert.equal(statSync(path).mode & 0o777, 0o660);
  });

  it("keeps the file's group", (t) => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    const other = process.getgroups?.().find((gid) => gid !== statSync(path).gid);
    if (other === undefined) return t.skip('the test user is in no second group');
    chownSync(path, statSync(path).uid, other);
    writeJsonFile(path, ['b']);
    assert.equal(statSync(path).gid, other);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
  });

  it("writes in place when it can't give the new file the old one's group", async (t) => {
    const path = join(dir, 'shared.json');
    writeJsonFile(path, ['a']);
    const inode = statSync(path).ino;
    await withFs(t, 'chownSync', () => (() => {
      throw refuse('EPERM', 'chown to a group the server is not in');
    }) as typeof fs.chownSync, () => writeJsonFile(path, ['b']));
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
        withFs(t, 'chmodSync', (real) => ((p: fs.PathLike, m: fs.Mode) => {
          atCreation.push(statSync(p).mode & 0o777);
          return real(p, m);
        }) as typeof fs.chmodSync, () => writeJsonFile(path, ['b'])),
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

  it("writes in place for each error that means the path can't be saved by replacement", async (t) => {
    // EBUSY: a bind-mounted file; EROFS: a read-only filesystem around one;
    // ENOTSUP and kin: a filesystem without permissions, from the chown or
    // chmod; the rest: a directory or name that won't take the temp file.
    const codes = ['EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS', 'ENAMETOOLONG', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];
    for (const code of codes) {
      const path = join(dir, `store-${code}.json`);
      writeJsonFile(path, ['a']);
      const inode = statSync(path).ino;
      await renameFailing(t, code, (to) => to === path, () => writeJsonFile(path, ['b']));
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b'], code);
      assert.equal(statSync(path).ino, inode, `${code}: written in place`);
    }
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  });

  it("writes in place when the directory won't take a new file", { skip: asRoot }, () => {
    const path = join(dir, 'store.json');
    writeJsonFile(path, ['a']);
    chmodSync(dir, 0o500);
    writeJsonFile(path, ['b']);
    chmodSync(dir, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), ['b']);
    assert.deepEqual(readdirSync(dir), ['store.json']);
  });

  it("writes in place when the name has no room for '.tmp'", () => {
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

  it('keeps a private filters file private', async () => {
    const path = join(dir, 'filters.json');
    saveFiltersFile(path, { dmUsers: ['111'] });
    chmodSync(path, 0o600);
    await withUmask(0o022, () => saveFiltersFile(path, { dmUsers: ['222'] }));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')).dmUsers, ['222']);
  });
});
