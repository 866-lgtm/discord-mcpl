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
  "or, for a text, announcement or voice channel, its #name. list_channels, given a server's id (list_guilds " +
  'lists them), lists the channels there that the configured filters allow, with their ids.';
const wrongChannelIds: Array<[unknown, string]> = [
  [undefined, ", which this call didn't give"],
  [null, ", which this call didn't give"],
  ['', ', and this call gave it blank'],
  ['   ', ', and this call gave it blank'],
  [42, ' as a string, and this call gave a number'],
  [['123456789012345678'], ' as a string, and this call gave a list'],
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

  for (const tool of ['set_reaction_visibility', 'mute_channel', 'unmute_channel', 'channel_missed']) {
    it(`${tool} without a usable channelId says nothing was done, what was wrong with it, and how to give one`, async (t) => {
      const s = server(t);
      for (const [channelId, wrong] of wrongChannelIds) {
        const r = await s.handleToolCall(tool, { channelId, visible: true });
        assert.equal(r.isError, true, `${tool} ${JSON.stringify(channelId)}`);
        assert.equal(r.content[0].text, needsChannelId('Nothing was done', tool, wrong), `${tool} ${JSON.stringify(channelId)}`);
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
      'Nothing was done: subscribe_channel is retired. Use the host channel_open tool with the MCPL channel id.');
    assert.equal((await s.handleToolCall('unsubscribe_channel', {})).content[0].text,
      'Nothing was done: unsubscribe_channel is retired. Use the host channel_close tool with the MCPL channel id.');
  });

  it('a send with neither content nor files says nothing was sent', async (t) => {
    const s = server(t);
    for (const [tool, args] of [
      ['send_message', { channelId: '123456789012345678', content: '  ' }],
      ['reply_message', { channelId: '123456789012345678', messageId: '1' }],
      ['send_dm', { userId: '123456789012345678', files: [] }],
    ] as const) {
      const r = await s.handleToolCall(tool, args);
      assert.equal(r.isError, true, tool);
      assert.equal(r.content[0].text, 'Nothing was sent: the message is empty. Give it "content", "files", or both.', tool);
    }
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
      [[null], '.'],
      [[{}], '.'],
      [[{ path: 42 }], '.'],
      [[{ path: ' ' }], '.'],
      [['/tmp/a.png'], ': give it as {"path": "/tmp/a.png"}.'],
    ] as const) {
      await assert.rejects(send(adapter, files), { message: `${needsPath(0)}${end}` }, JSON.stringify(files));
    }
    const dir = tempDir(t);
    const fine = join(dir, 'fine.txt');
    writeFileSync(fine, 'x');
    await assert.rejects(send(adapter, [{ path: fine }, { name: 'second' }]), { message: `${needsPath(1)}.` });
    assert.deepEqual(sends, []);
  });

  it('a path that is not a readable file, as it was read on this machine', async (t) => {
    const { adapter, sends } = adapterWithChannel(t);
    const dir = tempDir(t);
    const missing = join(dir, 'missing.png');
    const end = 'on the machine running discord-mcpl. Give the path of a file there that it can read.';
    await assert.rejects(send(adapter, [{ path: missing }]), { message: `Nothing was sent: "${missing}" doesn't exist ${end}` });
    await assert.rejects(send(adapter, [{ path: dir }]), { message: `Nothing was sent: "${dir}" isn't a file ${end}` });
    // A relative path is read against the working directory, which the agent can't see.
    await assert.rejects(send(adapter, [{ path: 'no-such-file.png' }]), {
      message: `Nothing was sent: "no-such-file.png" (read as ${resolve('no-such-file.png')}) doesn't exist ${end}`,
    });
    assert.deepEqual(sends, []);
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
