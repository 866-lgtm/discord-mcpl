/**
 * Refusals a tool gives before it does anything: each says what didn't
 * happen and what the agent can do about it.
 *
 * Run: node --import tsx --test test/tool-refusals.test.ts
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';

type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };
type Server = {
  handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  mcplEnabled: boolean;
  enabledFeatureSets: Set<string>;
  subscriptionsLoaded: boolean;
};

function server(t: TestContext): Server {
  const adapter = new DiscordAdapter({ token: 'unused' });
  t.after(() => adapter.rawClient.destroy());
  const s = new DiscordMcplServer(adapter) as unknown as Server;
  s.subscriptionsLoaded = true;
  return s;
}

const tempDir = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-refusals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** The channelId refusal: what was wrong with the value, and how to give one. */
const needsChannelId = (nothing: string, tool: string, wrong: string) =>
  `${nothing}: ${tool} needs channelId${wrong}. Give the channel's id in quotes, such as "123456789012345678", ` +
  "or, for a text, announcement, voice or stage channel, its #name. list_channels with guildId, a server's id " +
  'from list_guilds, lists the channels there that the configured filters allow, with their ids.';
/** Values a required string argument can't take, and how each fell short. */
const wrongChannelIds: Array<[unknown, string]> = [
  [undefined, ', and this call gave none'],
  [null, ', and this call gave none'],
  ['', ', and this call gave it blank'],
  ['   ', ', and this call gave it blank'],
  [42, ' as a string, and this call gave a number'],
  [['123456789012345678'], ' as a string, and this call gave a list'],
  [{ id: '123456789012345678' }, ' as a string, and this call gave an object'],
  [true, ' as a string, and this call gave a boolean'],
];

describe('tool refusals say what did not happen', () => {
  it('a tool whose feature set the host disabled names the tool, its feature set and who can change it', async (t) => {
    const s = server(t);
    s.mcplEnabled = true;
    s.enabledFeatureSets = new Set(['discord.messaging']);
    const r = await s.handleToolCall('fetch_history', { channelId: '123456789012345678' });
    assert.equal(r.isError, true);
    assert.equal(
      r.content[0].text,
      'fetch_history is turned off here: this host has disabled the "discord.history" feature set it belongs to, ' +
        "so the call didn't run, and calling it again won't change that. If you need it, ask whoever runs this host.",
    );
  });

  for (const [tool, nothing] of [
    ['set_reaction_visibility', 'Nothing was done'],
    ['mute_channel', 'Nothing was done'],
    ['unmute_channel', 'Nothing was done'],
    // A read, as the history reads are.
    ['channel_missed', 'Nothing was read'],
  ]) {
    it(`${tool} without a usable channelId says ${nothing.toLowerCase()}, what was wrong with it, and how to give one`, async (t) => {
      const s = server(t);
      for (const [channelId, wrong] of wrongChannelIds) {
        const r = await s.handleToolCall(tool, { channelId, visible: true });
        assert.equal(r.isError, true, `${tool} ${JSON.stringify(channelId)}`);
        assert.equal(r.content[0].text, needsChannelId(nothing, tool, wrong), `${tool} ${JSON.stringify(channelId)}`);
      }
    });
  }

  it('fetch_history and fetch_around without a usable channelId say nothing was read, in the same words', async (t) => {
    const s = server(t);
    for (const tool of ['fetch_history', 'fetch_around']) {
      for (const [channelId, wrong] of wrongChannelIds) {
        const r = await s.handleToolCall(tool, { channelId, messageId: '1' });
        assert.equal(r.content[0].text, needsChannelId('Nothing was read', tool, wrong), `${tool} ${JSON.stringify(channelId)}`);
      }
    }
  });

  it('channel_missed refuses a missing channelId before it loads anything', async (t) => {
    const s = server(t) as Server & Record<string, unknown>;
    const loads: string[] = [];
    s.ensureSubscriptionsLoaded = () => { loads.push('subscriptions'); };
    s.ensureWatermarkLoaded = () => { loads.push('watermarks'); };
    const r = await s.handleToolCall('channel_missed', {});
    assert.equal(r.isError, true);
    assert.deepEqual(loads, [], 'the watermarks file, which a load can set aside and rewrite, is never touched');
  });

  it('a tool name the server does not have says nothing ran', async (t) => {
    const r = await server(t).handleToolCall('send_messages', {});
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'There\'s no Discord tool "send_messages", so nothing ran. Call one of the Discord tools listed for you.');
  });

  it('the retired subscription tools say nothing was done and what replaces them', async (t) => {
    const s = server(t);
    assert.equal((await s.handleToolCall('subscribe_channel', {})).content[0].text,
      "Nothing was done: subscribe_channel is retired. Use the host's channel_open tool with the channel's id: " +
        'discord:<server id>:<channel id>, or discord:dm:<channel id> for a DM.');
    assert.equal((await s.handleToolCall('unsubscribe_channel', {})).content[0].text,
      "Nothing was done: unsubscribe_channel is retired. Use the host's channel_close tool with the channel's id: " +
        'discord:<server id>:<channel id>, or discord:dm:<channel id> for a DM.');
  });

  it('a send with neither content nor files says nothing was sent', async (t) => {
    const s = server(t);
    for (const [tool, args] of [
      ['send_message', { channelId: '123456789012345678', content: '  ' }],
      ['reply_message', { channelId: '123456789012345678', messageId: '1' }],
      ['send_dm', { userId: '123456789012345678', files: [] }],
      // null is content left out, as before, and so is false.
      ['send_message', { channelId: '123456789012345678', content: null }],
      ['send_message', { channelId: '123456789012345678', content: false }],
    ] as const) {
      const r = await s.handleToolCall(tool, args);
      assert.equal(r.isError, true, tool);
      assert.equal(r.content[0].text, 'Nothing was sent: the message is empty. Give it "content", "files", or both.', tool);
    }
  });

  it('a send whose content is given but is not a string says nothing was sent, and what content takes', async (t) => {
    const s = server(t);
    for (const [tool, args, gave] of [
      ['send_message', { channelId: '123456789012345678', content: 42 }, 'a number'],
      ['reply_message', { channelId: '123456789012345678', messageId: '1', content: { text: 'hi' } }, 'an object'],
      // 0 may have been meant as "0", so the files don't go without it.
      ['send_dm', { userId: '123456789012345678', content: 0, files: [{ path: '/tmp/a.png' }] }, 'a number'],
      // Falsy, with no files: still this refusal, not the empty message's.
      ['send_message', { channelId: '123456789012345678', content: 0 }, 'a number'],
      ['send_message', { channelId: '123456789012345678', content: true }, 'a boolean'],
    ] as const) {
      const r = await s.handleToolCall(tool, args);
      assert.equal(r.isError, true, tool);
      assert.equal(r.content[0].text, `Nothing was sent: ${tool} takes content as a string, and this call gave ${gave}. ` +
        "Give the message's text in quotes, or, to send only files, leave content out and give files.", `${tool} ${gave}`);
    }
  });

  it('send_dm without a usable userId says nothing was sent and how to name the recipient, looking nothing up', async (t) => {
    const s = server(t);
    // Each lookup a send_dm makes, recorded: none runs for a refused userId.
    const adapter = (s as unknown as { discord: DiscordAdapter }).discord;
    const looked: string[] = [];
    t.mock.method(adapter as unknown as { resolveRecipientId: (r: string) => Promise<string> }, 'resolveRecipientId',
      async (r: string) => { looked.push(`resolveRecipientId ${r}`); return r; });
    (adapter.rawClient as unknown as { users: { fetch: unknown } }).users.fetch = async (id: string) => {
      looked.push(`users.fetch ${id}`);
      return { id, username: 'ra', createDM: async () => { looked.push('createDM'); return { id: 'dm1' }; } };
    };
    for (const [userId, wrong] of [
      [undefined, ', and this call gave none'],
      ['  ', ', and this call gave it blank'],
      [42, ' as a string, and this call gave a number'],
    ] as const) {
      const r = await s.handleToolCall('send_dm', { userId, content: 'hi' });
      assert.equal(r.isError, true, String(userId));
      assert.equal(r.content[0].text, `Nothing was sent: send_dm needs userId${wrong}. Give the recipient's id in quotes, ` +
        'such as "123456789012345678", or their name: @username or display name.', String(userId));
    }
    assert.deepEqual(looked, []);
  });

  it('filters_update with a setDmNotice that is not a boolean says nothing was changed', async (t) => {
    const r = await server(t).handleToolCall('filters_update', { setDmNotice: 'yes' });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'setDmNotice must be true or false. Nothing was changed.');
  });

  it('a whitelist change beside a setDmNotice that is not a boolean changes nothing', async (t) => {
    const dir = tempDir(t);
    const path = join(dir, 'filters.json');
    const before = JSON.stringify({ dmUsers: ['friend'] });
    writeFileSync(path, before);
    const previous = process.env.DISCORD_FILTERS_FILE;
    process.env.DISCORD_FILTERS_FILE = path;
    t.after(() => {
      if (previous === undefined) delete process.env.DISCORD_FILTERS_FILE;
      else process.env.DISCORD_FILTERS_FILE = previous;
    });
    const r = await server(t).handleToolCall('filters_update', { setDmUsers: ['friend', 'new-friend'], setDmNotice: 'yes' });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'setDmNotice must be true or false. Nothing was changed.');
    assert.equal(readFileSync(path, 'utf8'), before, 'the filters file is as it was');
  });
});

describe('a send refused for its files says nothing was sent, and what to send instead', () => {
  function adapterWithChannel(t: TestContext) {
    const adapter = new DiscordAdapter({ token: 'unused' });
    t.after(() => adapter.rawClient.destroy());
    const sends: unknown[] = [];
    const channel = { id: '123456789012345678', send: async (payload: unknown) => { sends.push(payload); return { id: 'sent-1' }; } };
    const channels = (adapter.rawClient as unknown as { channels: { fetch: (id: string) => Promise<unknown> } }).channels;
    channels.fetch = async () => channel;
    return { adapter, sends };
  }
  const send = (adapter: DiscordAdapter, files: unknown) =>
    adapter.sendMessage('123456789012345678', 'hi', { files: files as never });

  it('files that are not a list', async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    for (const [files, gave] of [['/tmp/a.png', 'a string'], [{ path: '/tmp/a.png' }, 'an object']] as const) {
      await assert.rejects(send(adapter, files), {
        message: `Nothing was sent: "files" must be a list of files, each as {"path": "<its path>"}, and this call gave ${gave}.`,
      });
    }
    assert.deepEqual(sends, []);
  });

  it('a files value that says none ("", false, 0, null) sends the text alone, as before', async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    for (const files of ['', false, 0, null]) await send(adapter, files);
    assert.deepEqual(sends.map((s) => (s as { files?: unknown[] }).files), [undefined, undefined, undefined, undefined]);
  });

  it('more files than Discord takes in one message', async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const dir = tempDir(t);
    const files = Array.from({ length: 11 }, (_, i) => {
      const path = join(dir, `f${i}.txt`);
      writeFileSync(path, 'x');
      return { path };
    });
    await assert.rejects(send(adapter, files), {
      message: 'Nothing was sent: this call gave 11 files, and Discord takes at most 10 in one message. ' +
        'Send 10 or fewer, and the rest in another message.',
    });
    assert.deepEqual(sends, []);
  });

  it('a file without a usable path, named by its place in the list', async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const needsPath = (i: number) =>
      `Nothing was sent: files[${i}] needs "path", the path of a file on the machine running discord-mcpl, as a non-empty string`;
    for (const [files, end] of [
      // An entry that isn't an object is named by its kind.
      [[null], ', and this call gave null.'],
      [[42], ', and this call gave a number.'],
      [[true], ', and this call gave a boolean.'],
      [[['/tmp/a.png']], ', and this call gave a list.'],
      [[{}], '.'],
      [[{ path: 42 }], '.'],
      [[{ path: ' ' }], '.'],
      [['/tmp/a.png'], ': give it as {"path": "/tmp/a.png"}.'],
      // The form to copy holds the path trimmed.
      [[' /tmp/a.png\n'], ': give it as {"path": "/tmp/a.png"}.'],
      // A blank string is no path to give in that form.
      [['  '], ', and this one is blank.'],
    ] as const) {
      await assert.rejects(send(adapter, files), { message: `${needsPath(0)}${end}` }, JSON.stringify(files));
    }
    const dir = tempDir(t);
    const fine = join(dir, 'fine.txt');
    writeFileSync(fine, 'x');
    await assert.rejects(send(adapter, [{ path: fine }, { name: 'second' }]), { message: `${needsPath(1)}.` });
    assert.deepEqual(sends, []);
  });

  it("a file's name or description that is not a string, named by its place in the list", async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const fine = join(tempDir(t), 'fine.txt');
    writeFileSync(fine, 'x');
    await assert.rejects(send(adapter, [{ path: fine }, { path: fine, name: 42 }]), {
      message: "Nothing was sent: files[1].name must be a string, and this call gave a number. Give it in quotes, or " +
        "leave it out to use the file's own name.",
    });
    await assert.rejects(send(adapter, [{ path: fine, description: { text: 'a' } }]), {
      message: 'Nothing was sent: files[0].description must be a string, and this call gave an object. Give it in ' +
        'quotes, or leave it out.',
    });
    await assert.rejects(send(adapter, [{ path: fine, description: ['a'] }]), {
      message: 'Nothing was sent: files[0].description must be a string, and this call gave a list. Give it in ' +
        'quotes, or leave it out.',
    });
    assert.deepEqual(sends, []);
  });

  it("a file's description given as a number or true is sent as its text", async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const fine = join(tempDir(t), 'fine.txt');
    writeFileSync(fine, 'x');
    for (const description of [42, true]) await send(adapter, [{ path: fine, description }]);
    const attached = sends.map((s) => (s as { files: Array<{ description?: unknown }> }).files[0]!.description);
    assert.deepEqual(attached, ['42', 'true']);
  });

  it("a file's name or description that says none (null, false, 0) is left out, as before", async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const fine = join(tempDir(t), 'fine.txt');
    writeFileSync(fine, 'x');
    for (const none of [null, false, 0]) await send(adapter, [{ path: fine, name: none, description: none }]);
    const attached = sends.map((s) => (s as { files: Array<{ name?: string; description?: string }> }).files[0]);
    assert.deepEqual(attached.map((f) => [f.name, f.description]),
      [['fine.txt', undefined], ['fine.txt', undefined], ['fine.txt', undefined]]);
  });

  it('a path that is not a readable file, as it was read on this machine', async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const dir = tempDir(t);
    const missing = join(dir, 'missing.png');
    const end = 'on the machine running discord-mcpl. Give the path of a file there that it can read.';
    await assert.rejects(send(adapter, [{ path: missing }]), { message: `Nothing was sent: "${missing}" doesn't exist ${end}` });
    // A path through a file, as if it were a directory (ENOTDIR), doesn't exist either.
    const plain = join(dir, 'plain.txt');
    writeFileSync(plain, 'x');
    const through = join(plain, 'inner.png');
    await assert.rejects(send(adapter, [{ path: through }]), { message: `Nothing was sent: "${through}" doesn't exist ${end}` });
    await assert.rejects(send(adapter, [{ path: dir }]), { message: `Nothing was sent: "${dir}" isn't a file ${end}` });
    // A relative path is read against the working directory, which the agent can't see.
    await assert.rejects(send(adapter, [{ path: 'no-such-file.png' }]), {
      message: `Nothing was sent: "no-such-file.png" (read as ${resolve('no-such-file.png')}) doesn't exist ${end}`,
    });
    assert.deepEqual(sends, []);
  });

  it('exactly as many files as Discord takes, and a valid file rides the last part with its name and description', async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const dir = tempDir(t);
    const files = Array.from({ length: 10 }, (_, i) => {
      const path = join(dir, `f${i}.txt`);
      writeFileSync(path, 'x');
      return { path };
    });
    await send(adapter, files);
    assert.equal((sends[0] as { files?: unknown[] }).files?.length, 10);
    // Long enough to be sent in parts: the file goes with the last, named and described as given.
    await adapter.sendMessage('123456789012345678', 'x'.repeat(2500), {
      files: [{ path: files[0].path, name: 'report.txt', description: 'the report' }],
    });
    const [first, last] = sends.slice(1) as Array<{ files?: Array<{ name?: string; description?: string }> }>;
    assert.equal(first.files, undefined);
    assert.deepEqual(last.files?.map((f) => [f.name, f.description]), [['report.txt', 'the report']]);
  });

  it('a file this process cannot read is refused before any part of the message is sent', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root reads every file');
    const { adapter, sends } = adapterWithChannel(t);
    const locked = join(tempDir(t), 'locked.png');
    writeFileSync(locked, 'x');
    chmodSync(locked, 0o000);
    // Long enough to be sent in parts: the file would go with the last.
    await assert.rejects(adapter.sendMessage('123456789012345678', 'x'.repeat(2500), { files: [{ path: locked }] }), {
      message: `Nothing was sent: "${locked}" can't be read (EACCES) on the machine running discord-mcpl. ` +
        'Give the path of a file there that it can read.',
    });
    assert.deepEqual(sends, []);
  });

  it('files with content left out, null or false go as one message of files alone, through the real sendMessage and sendDM', async (t) => {
    const s = server(t);
    const adapter = (s as unknown as { discord: DiscordAdapter }).discord;
    const sends: Array<{ to: string; content?: unknown; files?: Array<{ name?: string }> }> = [];
    const record = (to: string) => async (p: { content?: unknown; files?: Array<{ name?: string }> }) => {
      sends.push({ to, content: p.content, files: p.files?.map((f) => ({ name: f.name })) });
      return { id: `sent-${sends.length}` };
    };
    const channel = { id: '123456789012345678', send: record('channel') };
    (adapter.rawClient as unknown as { channels: { fetch: unknown } }).channels.fetch = async () => channel;
    const user = { id: '223456789012345678', username: 'ra', createDM: async () => ({ id: '777777777777777777' }), send: record('dm') };
    (adapter.rawClient as unknown as { users: { fetch: unknown } }).users.fetch = async () => user;
    const path = join(tempDir(t), 'a.txt');
    writeFileSync(path, 'x');
    for (const content of [undefined, null, false]) {
      const viaChannel = await s.handleToolCall('send_message', { channelId: channel.id, content, files: [{ path }] });
      assert.notEqual(viaChannel.isError, true, `send_message ${String(content)}: ${viaChannel.content[0].text}`);
      const viaDm = await s.handleToolCall('send_dm', { userId: user.id, content, files: [{ path }] });
      assert.notEqual(viaDm.isError, true, `send_dm ${String(content)}: ${viaDm.content[0].text}`);
    }
    const alone = { content: undefined, files: [{ name: 'a.txt' }] };
    assert.deepEqual(sends, Array.from({ length: 3 }, () => [{ to: 'channel', ...alone }, { to: 'dm', ...alone }]).flat());
  });

  it('a DM is refused for its files the same way, through the real sendDM, before anything is sent', async (t) => {
    const adapter = new DiscordAdapter({ token: 'unused' });
    t.after(() => adapter.rawClient.destroy());
    const sends: unknown[] = [];
    const user = { id: '123456789012345678', username: 'ra', createDM: async () => ({ id: '777777777777777777' }), send: async (p: unknown) => { sends.push(p); return { id: 'sent-1' }; } };
    (adapter.rawClient as unknown as { users: { fetch: unknown } }).users.fetch = async () => user;
    const missing = join(tempDir(t), 'missing.png');
    await assert.rejects(adapter.sendDM('123456789012345678', 'hi', { files: [{ path: missing }] }), {
      message: `Nothing was sent: "${missing}" doesn't exist on the machine running discord-mcpl. Give the path of a file there that it can read.`,
    });
    assert.deepEqual(sends, []);
  });
});
