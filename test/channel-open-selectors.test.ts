/**
 * channels/open reads its selectors by MCPL's precedence: a channelId alone
 * selects; without one, an address does; with neither, the one channel of
 * the request's type. An exact selector names exactly one channel or is
 * refused with its code, and an id the registry doesn't hold is looked up in
 * Discord and opened when this server serves it. Nothing is fetched, opened
 * or subscribed before the channel is named, and a close, a mute or an
 * unregistration that arrives during the history fetch stands over the open.
 */
import { after, before, describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';
import { formatChannelLabel } from '../src/channel-names.js';
import { DiscordMcplServer } from '../src/server.js';
import { OPEN_CHOICES_SHOWN, resolveOpenTarget, toDescriptor, toDmDescriptor } from '../src/channels.js';

const general = toDescriptor('g1', 'Guild', { id: 'c1', name: 'general', type: 'text', label: '#general (Guild)' });
const dev = toDescriptor('g1', 'Guild', { id: 'c2', name: 'dev', type: 'text', label: '#dev (Guild)' });
const dm = toDmDescriptor('d1', 'ra');

const UNKNOWN_CHANNEL = -32023;
const OPEN_FAILED = -32024;
const INVALID_PARAMS = -32602;

// The stores' files come from the environment: clear those variables for
// this file, so each store lives in memory as a fresh server has it (its
// loaded flag false), and nothing here can touch real files.
const STORE_ENV = ['DISCORD_SUBSCRIPTIONS_FILE', 'DISCORD_MUTED_CHANNELS_FILE', 'DISCORD_REACTION_CHANNELS_FILE', 'DISCORD_WATERMARK_FILE'];
const savedEnv = new Map<string, string | undefined>();
before(() => { for (const name of STORE_ENV) { savedEnv.set(name, process.env[name]); delete process.env[name]; } });
after(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

type Served =
  | { kind: 'guild'; guildId: string; guildName: string; channel: { id: string; name: string; type: 'text'; label: string } }
  | { kind: 'dm'; recipientId: string; recipientName: string };

const historyItem = (channelId: string) => ({
  id: '900', authorId: 'u1', authorName: 'Alice', isBot: false, content: `from ${channelId}`,
  cleanContent: `from ${channelId}`, attachments: [], mentionsBot: false, timestamp: new Date(), reactions: [],
});

interface OpenResult {
  channel: { id: string; label: string };
  history?: Array<{ channelId: string; content: Array<{ text: string }> }>;
}

function fixture(
  channels: unknown[] = [general, dev],
  opts: {
    served?: (guildSegment: string, channelId: string) => Served | null;
    history?: (channelId: string) => Promise<unknown[]>;
  } = {},
) {
  const fetched: Array<{ channelId: string; after?: string }> = [];
  const lookups: string[] = [];
  const adapter = {
    async fetchHistory(channelId: string, o?: { after?: string }) {
      fetched.push({ channelId, ...(o?.after !== undefined ? { after: o.after } : {}) });
      return opts.history ? opts.history(channelId) : [historyItem(channelId)];
    },
    async lookUpServedChannel(guildSegment: string, channelId: string) {
      lookups.push(`${guildSegment}/${channelId}`);
      return opts.served?.(guildSegment, channelId) ?? null;
    },
  } as unknown as DiscordAdapter;
  const server = new DiscordMcplServer(adapter) as unknown as {
    channelManager: {
      register(d: unknown): void; unregister(id: string): boolean; isOpen(id: string): boolean;
      get(id: string): { id: string; label: string } | undefined; getAll(): Array<{ id: string }>;
    };
    subscribedChannels: Set<string>;
    mutedChannels: Set<string>;
    conn: unknown;
    handleChannelOpen(params: Record<string, unknown>): Promise<OpenResult>;
    handleChannelClose(params: { channelId: string }): unknown;
    executeToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
    handleRequest(req: { jsonrpc: '2.0'; id: number; method: string; params: Record<string, unknown> }): Promise<void>;
  };
  for (const c of channels) server.channelManager.register(c);
  const subscribed = () => [...server.subscribedChannels].sort();
  const nothingOpened = () => {
    assert.deepEqual(fetched, [], 'no history was fetched');
    for (const c of server.channelManager.getAll()) assert.equal(server.channelManager.isOpen(c.id), false, `${c.id} stayed closed`);
    assert.deepEqual(subscribed(), [], 'nothing was subscribed');
  };
  /** Assert the open is refused with `code`, its reason matching `reason`. */
  const refused = async (params: Record<string, unknown>, code: number, reason: RegExp) => {
    await assert.rejects(server.handleChannelOpen(params), (err: Error & { code?: unknown }) => {
      assert.equal(err.code, code, `${JSON.stringify(params)}: ${err.message}`);
      assert.match(err.message, reason, JSON.stringify(params));
      return true;
    });
  };
  return { server, fetched, lookups, subscribed, nothingOpened, refused };
}

/** A history fetch held open until released, so a test can act during it. */
function heldHistory() {
  let reached!: () => void;
  let release!: () => void;
  const atFetch = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const history = async (channelId: string) => {
    reached();
    await gate;
    return [historyItem(channelId)];
  };
  return { history, atFetch, release };
}

describe('channels/open: what selects', () => {
  it('opens exactly the channel an id names, with its own history, and subscribes only it', async () => {
    const f = fixture();
    const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:c2', type: 'discord', history: { limit: 5 } });
    assert.equal(res.channel.id, 'discord:g1:c2');
    assert.deepEqual(f.fetched, [{ channelId: 'c2' }]);
    assert.equal(res.history?.[0].channelId, 'discord:g1:c2');
    assert.match(res.history?.[0].content[0].text ?? '', /from c2/);
    assert.equal(f.server.channelManager.isOpen('discord:g1:c2'), true);
    assert.equal(f.server.channelManager.isOpen('discord:g1:c1'), false);
    assert.deepEqual(f.subscribed(), ['c2']);
  });

  it('opens exactly the channel an address names, with its own history, and subscribes only it', async () => {
    const f = fixture();
    const res = await f.server.handleChannelOpen({ type: 'discord', address: { guildId: 'g1', channelId: 'c1' }, history: { limit: 5 } });
    assert.equal(res.channel.id, 'discord:g1:c1');
    assert.deepEqual(f.fetched, [{ channelId: 'c1' }]);
    assert.match(res.history?.[0].content[0].text ?? '', /from c1/);
    assert.deepEqual(f.subscribed(), ['c1']);
  });

  it("opens a channelId's channel whatever an address beside it says, malformed or naming another", async () => {
    for (const address of [{ guildId: 'g1', channelId: 'c2' }, { guildId: 'g1' }, [], 'g1/c2', { guildId: 1, channelId: 2 }]) {
      const f = fixture();
      const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', address });
      assert.equal(res.channel.id, 'discord:g1:c1', JSON.stringify(address));
      assert.deepEqual(f.subscribed(), ['c1']);
    }
  });

  it('reads an absent or null channelId, with an absent, null or {} address, as no selector', async () => {
    for (const selector of [{}, { address: null }, { address: {} }, { channelId: null }, { channelId: null, address: null }]) {
      const f = fixture([general]);
      const res = await f.server.handleChannelOpen({ type: 'discord', ...selector });
      assert.equal(res.channel.id, 'discord:g1:c1', JSON.stringify(selector));
    }
  });

  it('refuses an empty channelId, saying how to send no selector or name a channel', async () => {
    const f = fixture([general]); // with no selector, this request would open discord:g1:c1
    await f.refused(
      { channelId: '', type: 'discord', history: { limit: 10 } }, INVALID_PARAMS,
      /^channelId is empty: send null or omit it for no selector, or name the channel as discord:<guildId>:<channelId>\. Nothing was opened\.$/,
    );
    f.nothingOpened();
  });

  it('refuses a channelId that is not a string, saying ids are strings', async () => {
    for (const channelId of [42, {}, [], true]) {
      const f = fixture([general]);
      await f.refused({ channelId, type: 'discord', history: { limit: 10 } }, INVALID_PARAMS, /^channelId must be a string, such as "discord:<guildId>:<channelId>"/);
      f.nothingOpened();
    }
  });

  it('refuses a malformed address without a channelId, before any history is fetched', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /^address must be absent, null, \{\}, or an object naming a guildId and a channelId\. Nothing was opened\.$/],
      [false, /^address must be absent, null, \{\}, or an object naming a guildId and a channelId/],
      ['g1/c1', /^address must be absent, null, \{\}, or an object naming a guildId and a channelId/],
      [{ guildId: 'g1' }, /^address must name both a guildId and a channelId, or be absent, null or \{\} for no selector\./],
      [{ guildId: '', channelId: 'c1' }, /^address must name both a guildId and a channelId/],
      [{ guildId: 'g1', channelId: '' }, /^address must name both a guildId and a channelId/],
      [{ guildId: 1, channelId: 'c1' }, /^address guildId and channelId are strings \(a Discord id as a JSON number loses precision\)\./],
      [{ guildId: 'g1', channelId: 1 }, /^address guildId and channelId are strings/],
    ];
    for (const [address, reason] of cases) {
      const f = fixture([general]);
      await f.refused({ type: 'discord', address, history: { limit: 10 } }, INVALID_PARAMS, reason);
      f.nothingOpened();
    }
  });

  it('refuses a missing, empty or non-string type on every path, even where the selector fits', async () => {
    // With type "discord", each of these requests would open discord:g1:c1.
    const selectors = [{}, { address: null }, { address: {} }, { channelId: 'discord:g1:c1' }, { address: { guildId: 'g1', channelId: 'c1' } }];
    for (const type of [undefined, null, '', 0, false, {}, []]) {
      for (const selector of selectors) {
        const f = fixture([general]);
        const params = { ...selector, ...(type === undefined ? {} : { type }), history: { limit: 10 } };
        await f.refused(params, INVALID_PARAMS, /^type must be a non-empty string naming a channel type, such as "discord"\. Nothing was opened\.$/);
        f.nothingOpened();
      }
    }
  });

  it('refuses a string type the channel does not have, on every path, a registered channelId and a looked-up one included', async () => {
    // c7 isn't registered, but the lookup finds it served: its type is checked
    // there, and it isn't registered for a request of another type.
    const served = (guild: string, channel: string): Served | null =>
      (guild === 'g1' && channel === 'c7'
        ? { kind: 'guild', guildId: 'g1', guildName: 'Guild', channel: { id: 'c7', name: 'new', type: 'text', label: '#new (Guild)' } }
        : null);
    const cases: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ address: null }, UNKNOWN_CHANNEL, /^No slack channel is registered, so there is none to open without a selector\. Nothing was opened\.$/],
      [{ address: {} }, UNKNOWN_CHANNEL, /^No slack channel is registered/],
      [{ channelId: 'discord:g1:c1' }, INVALID_PARAMS, /^channelId "discord:g1:c1" is a discord channel, not slack\. Nothing was opened\.$/],
      [{ address: { guildId: 'g1', channelId: 'c1' } }, INVALID_PARAMS, /^address "g1"\/"c1" is a discord channel, not slack\. Nothing was opened\.$/],
      [{ channelId: 'discord:g1:c7' }, INVALID_PARAMS, /^channelId "discord:g1:c7" is a discord channel, not slack\. Nothing was opened\.$/],
      [{ address: { guildId: 'g1', channelId: 'c7' } }, INVALID_PARAMS, /^address "g1"\/"c7" is a discord channel, not slack\. Nothing was opened\.$/],
    ];
    for (const [selector, code, reason] of cases) {
      const f = fixture([general], { served });
      await f.refused({ ...selector, type: 'slack', history: { limit: 10 } }, code, reason);
      f.nothingOpened();
      assert.equal(f.server.channelManager.get('discord:g1:c7'), undefined, `${JSON.stringify(selector)}: nothing registered`);
    }
  });

  it('opens a DM by its address, and counts DMs among the channels a selector-free request chooses from', async () => {
    const f = fixture([general, dm]);
    const res = await f.server.handleChannelOpen({ type: 'discord', address: { guildId: 'dm', channelId: 'd1' } });
    assert.equal(res.channel.id, 'discord:dm:d1');
    assert.deepEqual(f.subscribed(), ['d1']);
    const g = fixture([general, dev, dm]);
    await g.refused({ type: 'discord', history: { limit: 10 } }, INVALID_PARAMS, /^3 discord channels are registered; name one with channelId\. Choices: /);
    await assert.rejects(g.server.handleChannelOpen({ type: 'discord' }), (err: Error) => err.message.includes('discord:dm:d1 (DM: ra)'));
    g.nothingOpened();
  });

  it('lets a selector-free request open the only channel of its type, and refuses when there is none', async () => {
    assert.equal((await fixture([general]).server.handleChannelOpen({ type: 'discord', address: {} })).channel.id, 'discord:g1:c1');
    const f = fixture([]);
    await f.refused({ type: 'discord' }, UNKNOWN_CHANNEL, /^No discord channel is registered, so there is none to open without a selector\. Nothing was opened\.$/);
  });

  it('lists every choice up to ten, and past ten points to channels/list for the rest', () => {
    const rooms = (n: number) => Array.from({ length: n }, (_, i) =>
      toDescriptor('g1', 'Guild', { id: `c${i}`, name: `room${i}`, type: 'text', label: `#room${i} (Guild)` }));
    assert.equal(OPEN_CHOICES_SHOWN, 10);
    const ten = resolveOpenTarget({ type: 'discord' }, rooms(10));
    assert.equal(ten.kind, 'refused');
    const tenReason = (ten as { reason: string }).reason;
    assert.equal(tenReason.match(/discord:g1:c\d+ \(/g)?.length, 10, 'all ten listed');
    assert.match(tenReason, /\(#room9 \(Guild\)\)\. Nothing was opened\.$/, 'and nothing more said');
    const eleven = resolveOpenTarget({ type: 'discord' }, rooms(11));
    const elevenReason = (eleven as { reason: string }).reason;
    assert.equal(elevenReason.match(/discord:g1:c\d+ \(/g)?.length, 10, 'ten listed');
    assert.ok(!elevenReason.includes('discord:g1:c10 '), 'the eleventh is left out');
    assert.match(elevenReason, /, and 1 more, which channels\/list returns\. Nothing was opened\.$/);
  });

  it('bounds a caller value it echoes in a refusal', async () => {
    const f = fixture([general]);
    const long = `discord:g1:${'x'.repeat(5000)}`;
    await assert.rejects(f.server.handleChannelOpen({ channelId: long, type: 'discord' }), (err: Error) => {
      assert.ok(err.message.length < 400, `${err.message.length} characters`);
      assert.ok(err.message.includes(`"${long.slice(0, 100)}…"`), 'the first hundred characters, marked as cut');
      return true;
    });
  });
});

describe("channels/open: an id the registry doesn't hold", () => {
  it('opens and registers a DM no traffic has registered since a restart', async () => {
    const f = fixture([general], {
      served: (guild, channel) => (guild === 'dm' && channel === 'd9' ? { kind: 'dm', recipientId: 'u9', recipientName: 'ra' } : null),
    });
    const res = await f.server.handleChannelOpen({ channelId: 'discord:dm:d9', type: 'discord', history: { limit: 5 } });
    assert.equal(res.channel.id, 'discord:dm:d9');
    assert.equal(res.channel.label, 'DM: ra');
    assert.deepEqual(f.lookups, ['dm/d9']);
    assert.deepEqual(f.fetched, [{ channelId: 'd9' }]);
    assert.equal(f.server.channelManager.get('discord:dm:d9')?.label, 'DM: ra', 'registered');
    assert.equal(f.server.channelManager.isOpen('discord:dm:d9'), true);
    assert.deepEqual(f.subscribed(), ['d9']);
  });

  it('opens and registers a text channel the registry does not hold yet, by id or by address', async () => {
    const served = (guild: string, channel: string): Served | null =>
      (guild === 'g1' && channel === 'c7'
        ? { kind: 'guild', guildId: 'g1', guildName: 'Guild', channel: { id: 'c7', name: 'new', type: 'text', label: '#new (Guild)' } }
        : null);
    for (const selector of [{ channelId: 'discord:g1:c7' }, { address: { guildId: 'g1', channelId: 'c7' } }]) {
      const f = fixture([general], { served });
      const res = await f.server.handleChannelOpen({ ...selector, type: 'discord' });
      assert.equal(res.channel.id, 'discord:g1:c7', JSON.stringify(selector));
      assert.equal(f.server.channelManager.get('discord:g1:c7')?.label, '#new (Guild)');
      assert.deepEqual(f.subscribed(), ['c7']);
    }
  });

  it('refuses an id this server does not serve as unknown, whatever an address beside it says', async () => {
    const f = fixture();
    await f.refused(
      { channelId: 'discord:g1:c9', type: 'discord', address: { guildId: 'g1', channelId: 'c1' }, history: { limit: 10 } }, UNKNOWN_CHANNEL,
      /^No channel this server serves matches channelId "discord:g1:c9": Discord doesn't know it, or it isn't a text channel or DM the filters admit\. Nothing was opened\.$/,
    );
    await f.refused({ type: 'discord', address: { guildId: 'g1', channelId: 'c9' } }, UNKNOWN_CHANNEL, /^No channel this server serves matches address "g1"\/"c9"/);
    assert.deepEqual(f.lookups, ['g1/c9', 'g1/c9']);
    f.nothingOpened();
  });

  it('refuses an id not of the form discord:<guildId>:<channelId> as unknown, saying the form, without a lookup', async () => {
    const f = fixture();
    await f.refused(
      { channelId: 'general', type: 'discord', history: { limit: 10 } }, UNKNOWN_CHANNEL,
      /^channelId "general" names no channel: a Discord channel id has the form discord:<guildId>:<channelId> \(discord:dm:<channelId> for a DM\)\. Nothing was opened\.$/,
    );
    assert.deepEqual(f.lookups, []);
    f.nothingOpened();
  });
});

describe('channels/open: what arrives during the history fetch stands', () => {
  it('opens nothing when the channel is unregistered meanwhile', async () => {
    const held = heldHistory();
    const f = fixture([general], { history: held.history });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    await held.atFetch;
    f.server.channelManager.unregister('discord:g1:c1');
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) =>
      err.code === UNKNOWN_CHANNEL && /^discord:g1:c1 was unregistered while this open was in progress/.test(err.message));
    assert.deepEqual(f.subscribed(), []);
  });

  it('opens nothing when a mute arrives meanwhile, and the mute stands', async () => {
    const held = heldHistory();
    const f = fixture([general], { history: held.history });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    await held.atFetch;
    await f.server.executeToolCall('mute_channel', { channelId: 'c1' });
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) =>
      err.code === OPEN_FAILED && /^A channels\/close or mute_channel for discord:g1:c1 arrived while this open was in progress, and it stands\./.test(err.message));
    assert.equal(f.server.channelManager.isOpen('discord:g1:c1'), false);
    assert.deepEqual(f.subscribed(), []);
    assert.equal(f.server.mutedChannels.has('c1'), true, 'still muted');
  });

  it('opens nothing when a close arrives meanwhile', async () => {
    const held = heldHistory();
    const f = fixture([general], { history: held.history });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    await held.atFetch;
    f.server.handleChannelClose({ channelId: 'discord:g1:c1' });
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) => err.code === OPEN_FAILED);
    assert.equal(f.server.channelManager.isOpen('discord:g1:c1'), false);
    assert.deepEqual(f.subscribed(), []);
  });

  it('still lifts a mute that was in place before the open began', async () => {
    const f = fixture([general]);
    await f.server.executeToolCall('mute_channel', { channelId: 'c1' });
    await f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    assert.equal(f.server.mutedChannels.has('c1'), false);
    assert.deepEqual(f.subscribed(), ['c1']);
  });

  it('answers a history fetch that fails as an open that failed, with its cause, and opens nothing', async () => {
    const f = fixture([general], { history: async () => { throw new Error('Missing Access'); } });
    await assert.rejects(
      f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } }),
      (err: Error & { code?: number }) =>
        err.code === OPEN_FAILED && err.message === "discord:g1:c1's history couldn't be fetched, so nothing was opened: Missing Access",
    );
    assert.equal(f.server.channelManager.isOpen('discord:g1:c1'), false);
    assert.deepEqual(f.subscribed(), []);
    // A rejection that isn't an Error is still this refusal, not a fault.
    const g = fixture([general], { history: async () => { throw 'rate limited'; } });
    await assert.rejects(
      g.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } }),
      (err: Error & { code?: number }) =>
        err.code === OPEN_FAILED && err.message === "discord:g1:c1's history couldn't be fetched, so nothing was opened: rate limited",
    );
  });

  it('reads a persisted watermark for sinceLastSeen on the first open', async (t: TestContext) => {
    const dir = mkdtempSync(join(tmpdir(), 'open-watermark-'));
    process.env.DISCORD_WATERMARK_FILE = join(dir, 'wm.json');
    t.after(() => { delete process.env.DISCORD_WATERMARK_FILE; rmSync(dir, { recursive: true, force: true }); });
    writeFileSync(process.env.DISCORD_WATERMARK_FILE, JSON.stringify({ watermarks: { c2: '500' }, dmChannels: [] }));
    const f = fixture();
    await f.server.handleChannelOpen({ channelId: 'discord:g1:c2', type: 'discord', history: { limit: 5, sinceLastSeen: true } });
    assert.deepEqual(f.fetched, [{ channelId: 'c2', after: '500' }]);
  });
});

describe('channels/open over the wire', () => {
  it('answers each refusal with its MCPL code and logs it as one line, and a fault as -32603 with its stack', async (t: TestContext) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const broken = { ...general, id: 'not-a-discord-id' }; // a registry entry the server can't parse: a fault
    const f = fixture([general, broken]);
    const errors: Array<{ id: number; code: number; message: string }> = [];
    f.server.conn = {
      sendResponse: () => {},
      sendError: (id: number, code: number, message: string) => { errors.push({ id, code, message }); },
    };
    const send = (id: number, params: Record<string, unknown>) =>
      f.server.handleRequest({ jsonrpc: '2.0', id, method: 'channels/open', params });
    await send(1, { channelId: 'general', type: 'discord' });
    await send(2, { channelId: '', type: 'discord' });
    await send(3, { channelId: 'not-a-discord-id', type: 'discord' });
    assert.deepEqual(errors.map((e) => [e.id, e.code]), [[1, UNKNOWN_CHANNEL], [2, INVALID_PARAMS], [3, -32603]]);
    const refusalLines = logged.filter((l) => l.startsWith('[discord-mcpl] channels/open refused'));
    assert.equal(refusalLines.length, 2);
    assert.ok(refusalLines.every((l) => !l.includes('\n    at ')), 'no stack for a refusal');
    assert.ok(logged.some((l) => l.includes('handleRequest error') && l.includes('Invalid Discord channel ID')), 'a fault keeps its stack');
  });
});

describe('the adapter: which channels an exact open may register', () => {
  function adapterFixture(t: TestContext, config: Record<string, unknown>) {
    const adapter = new DiscordAdapter({ token: 'unused', ...config });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    return { adapter, client };
  }

  it('serves a DM whose recipient the DM list admits, labelled by username, and no other', async (t) => {
    const { adapter, client } = adapterFixture(t, { dmUsers: ['u1'] });
    const dms: Record<string, unknown> = {
      d1: { type: ChannelType.DM, recipientId: 'u1', recipient: { username: 'ra' } },
      d2: { type: ChannelType.DM, recipientId: 'u2', recipient: { username: 'someone' } },
    };
    t.mock.method(client.channels, 'fetch', (async (id: string) => dms[id] ?? null) as never);
    assert.deepEqual(await adapter.lookUpServedChannel('dm', 'd1'), { kind: 'dm', recipientId: 'u1', recipientName: 'ra' });
    assert.equal(await adapter.lookUpServedChannel('dm', 'd2'), null, 'the DM list refuses its recipient');
    assert.equal(await adapter.lookUpServedChannel('g1', 'd1'), null, 'a DM named under a guild');
    assert.equal(await adapter.lookUpServedChannel('dm', 'gone'), null, 'Discord finds nothing');
  });

  it('serves a text or announcement channel of its own guild that the filters admit, and nothing else', async (t) => {
    const { adapter, client } = adapterFixture(t, { guildIds: ['g1', 'g2'], guildChannels: { g2: ['listed'] } });
    const channel = (id: string, type: number, guildId: string) => ({ id, type, guildId, name: id, parentId: null, guild: { name: `${guildId}-name` } });
    const channels: Record<string, unknown> = {
      text: channel('text', ChannelType.GuildText, 'g1'),
      news: channel('news', ChannelType.GuildAnnouncement, 'g1'),
      voice: channel('voice', ChannelType.GuildVoice, 'g1'),
      thread: channel('thread', ChannelType.PublicThread, 'g1'),
      elsewhere: channel('elsewhere', ChannelType.GuildText, 'g3'),
      unlisted: channel('unlisted', ChannelType.GuildText, 'g2'),
      listed: channel('listed', ChannelType.GuildText, 'g2'),
    };
    t.mock.method(client.channels, 'fetch', (async (id: string) => {
      if (id === 'broken') throw new Error('Service Unavailable');
      return channels[id] ?? null;
    }) as never);
    assert.deepEqual(await adapter.lookUpServedChannel('g1', 'text'), {
      kind: 'guild', guildId: 'g1', guildName: 'g1-name',
      channel: { id: 'text', name: 'text', type: 'text', parentId: undefined, label: formatChannelLabel('text', 'g1-name') },
    });
    assert.equal((await adapter.lookUpServedChannel('g1', 'news'))?.kind, 'guild', 'an announcement channel');
    assert.equal(await adapter.lookUpServedChannel('g1', 'voice'), null, 'not a text channel');
    assert.equal(await adapter.lookUpServedChannel('g1', 'thread'), null, 'threads are left to the registry');
    assert.equal(await adapter.lookUpServedChannel('g2', 'text'), null, 'named under another guild');
    assert.equal(await adapter.lookUpServedChannel('g3', 'elsewhere'), null, 'a guild the guild filter leaves out');
    assert.equal(await adapter.lookUpServedChannel('g2', 'unlisted'), null, "a channel the guild's channel list leaves out");
    assert.equal((await adapter.lookUpServedChannel('g2', 'listed'))?.kind, 'guild');
    assert.equal(await adapter.lookUpServedChannel('g1', 'broken'), null, 'a lookup that fails');
  });
});
