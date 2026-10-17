/**
 * channels/open reads its selectors in the order hosts code against
 * (agent-framework's ChannelsOpenParams prefers channelId): a channelId alone
 * selects; without one, an address does; with neither, the one channel of
 * the request's type. An exact selector names exactly one channel or is
 * refused with its code, and an id the registry doesn't hold is looked up in
 * Discord and opened when this server serves it. Nothing is fetched, opened
 * or subscribed before the channel is named. Requests are handled one at a
 * time, so a close or a mute sent during an open is handled after it; what
 * arrives meanwhile is Discord's: a deletion or the bot leaving the guild
 * during the lookup or the history fetch refuses the open as unknown, and a
 * channel unregistered during the history fetch isn't opened.
 */
import { after, before, describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, type Client } from 'discord.js';
import { DiscordAdapter, type ChannelFacts } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { OPEN_CHOICES_SHOWN, resolveOpenTarget, toDescriptor, toDmDescriptor } from '../src/channels.js';

const general = toDescriptor({ id: 'c1', guildId: 'g1', guildName: 'Guild', name: 'general', type: 'text' });
const dev = toDescriptor({ id: 'c2', guildId: 'g1', guildName: 'Guild', name: 'dev', type: 'text' });
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
  | { kind: 'guild'; facts: ChannelFacts }
  | { kind: 'dm'; recipientId: string; recipientName: string }
  | { kind: 'uncertain' };

/** Wait, a turn at a time, for what a test can't await directly. */
async function until(what: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !what(); i++) await new Promise((done) => setImmediate(done));
}

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
    served?: (guildSegment: string, channelId: string) => Served | null | Promise<Served | null>;
    history?: (channelId: string) => Promise<unknown[]>;
    inspection?: (channelId: string) => Promise<string | null>;
    /** What the cache knows of channels when the server asks, as
     *  getCachedChannelFactsFor answers: nothing unless a test says. */
    cachedFacts?: (channelIds: string[]) => Map<string, ChannelFacts>;
    /** The channels whose facts are stale (isStale): none unless a test says. */
    stale?: Set<string>;
  } = {},
) {
  const fetched: Array<{ channelId: string; after?: string }> = [];
  const lookups: string[] = [];
  /** Guilds the bot has left (hasGuild). */
  const left = new Set<string>();
  /** Users the DM list doesn't admit (dmUserAdmitted). */
  const offDmList = new Set<string>();
  const adapter = {
    async fetchHistory(channelId: string, o?: { after?: string }) {
      fetched.push({ channelId, ...(o?.after !== undefined ? { after: o.after } : {}) });
      return opts.history ? opts.history(channelId) : [historyItem(channelId)];
    },
    async lookUpServedChannel(guildSegment: string, channelId: string) {
      lookups.push(`${guildSegment}/${channelId}`);
      return opts.served?.(guildSegment, channelId) ?? null;
    },
    // The channel filters admit every channel here unless a test says
    // otherwise (their refusals are history-inspection-filter.test.ts's).
    async inspectionRefusal(channelId: string) {
      return opts.inspection ? opts.inspection(channelId) : null;
    },
    // As the adapter answers whenever a DM list is set: a user it isn't
    // given isn't admitted, so only a DM's recipient may be asked about.
    dmUserAdmitted(userId: string | undefined) {
      return userId !== undefined && !offDmList.has(userId);
    },
    // A deletion re-derives what's registered from the cache, which holds
    // nothing here unless a test says, and nothing is stale unless one does.
    isStale(channelId: string) {
      return opts.stale?.has(channelId) ?? false;
    },
    hasGuild(guildId: string) {
      return !left.has(guildId);
    },
    getCachedChannelFactsFor(channelIds: Iterable<string>) {
      return opts.cachedFacts ? opts.cachedFacts([...channelIds]) : new Map();
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
  return { server, fetched, lookups, left, offDmList, subscribed, nothingOpened, refused };
}

/** A history fetch held open until released, so a test can act during it.
 *  With `fails`, the fetch rejects with it once released. */
function heldHistory(fails?: Error) {
  let reached!: () => void;
  let release!: () => void;
  const atFetch = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const history = async (channelId: string) => {
    reached();
    await gate;
    if (fails) throw fails;
    return [historyItem(channelId)];
  };
  return { history, atFetch, release };
}

/** Wait until the call under test reaches a held fetch, failing with the
 *  call's own error, rather than waiting forever, if it settles before. */
async function untilFetch(held: { atFetch: Promise<void> }, call: Promise<unknown>, fetch = 'its history fetch'): Promise<void> {
  await Promise.race([
    held.atFetch,
    call.then(() => { throw new Error(`the call settled before ${fetch}`); }),
  ]);
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
        ? { kind: 'guild', facts: { id: 'c7', guildId: 'g1', guildName: 'Guild', name: 'new', type: 'text' } }
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
      toDescriptor({ id: `c${i}`, guildId: 'g1', guildName: 'Guild', name: `room${i}`, type: 'text' }));
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
      // The value as the refusal quotes it: its first hundred characters,
      // marked as cut, and nothing more of it.
      assert.equal(/^No channel this server serves matches channelId "([^"]*)": /.exec(err.message)?.[1], `${long.slice(0, 100)}…`);
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

  it('opens and registers a thread, a voice channel, and an archived thread the host names, by the rule every path registers by', async () => {
    const facts: Record<string, ChannelFacts> = {
      th5: { id: 'th5', guildId: 'g1', guildName: 'Guild', type: 'thread', name: 'plans', parentId: 'c1', parentName: 'general', archived: false },
      v5: { id: 'v5', guildId: 'g1', guildName: 'Guild', type: 'voice', name: 'lounge' },
      // Archived: the registry holds live threads of its own accord, but the
      // host named this one.
      th6: { id: 'th6', guildId: 'g1', guildName: 'Guild', type: 'thread', name: 'old', parentId: 'c1', parentName: 'general', archived: true },
    };
    const f = fixture([general], {
      served: (guild, channel) => (guild === 'g1' && facts[channel] ? { kind: 'guild', facts: facts[channel] } : null),
    });
    for (const [id, label] of [['th5', '#general › plans (Guild)'], ['v5', '#lounge (Guild)'], ['th6', '#general › old (Guild)']]) {
      const res = await f.server.handleChannelOpen({ channelId: `discord:g1:${id}`, type: 'discord' });
      assert.equal(res.channel.label, label, id);
      assert.equal(f.server.channelManager.get(`discord:g1:${id}`)?.label, label, `${id} is registered`);
      assert.equal(f.server.channelManager.isOpen(`discord:g1:${id}`), true, `${id} is open`);
    }
  });

  it('refuses a channel deleted lately or while it is looked up, and a thread of one, though Discord still answers for them', async () => {
    const facts: Record<string, ChannelFacts> = {
      c5: { id: 'c5', guildId: 'g1', guildName: 'Guild', type: 'text', name: 'gone' },
      th7: { id: 'th7', guildId: 'g1', guildName: 'Guild', type: 'thread', name: 'orphan', parentId: 'c6', parentName: 'also-gone' },
    };
    const f = fixture([general], {
      served: (guild, channel) => (guild === 'g1' && facts[channel] ? { kind: 'guild', facts: facts[channel] } : null),
    });
    const server = f.server as unknown as { channelDeleted(guildId: string, channelId: string): void };
    server.channelDeleted('g1', 'c5');
    server.channelDeleted('g1', 'c6');
    for (const id of ['c5', 'th7']) {
      await f.refused({ channelId: `discord:g1:${id}`, type: 'discord', history: { limit: 5 } }, UNKNOWN_CHANNEL, /^No channel this server serves matches/);
      assert.equal(f.server.channelManager.get(`discord:g1:${id}`), undefined, `${id} isn't registered`);
    }
    f.nothingOpened();
    // The channel is deleted while the lookup is out.
    const g = fixture([general], {
      served: async (guild, channel) => {
        (g.server as unknown as { channelDeleted(guildId: string, channelId: string): void }).channelDeleted('g1', channel);
        return guild === 'g1' && facts[channel] ? { kind: 'guild', facts: facts[channel] } : null;
      },
    });
    await g.refused({ channelId: 'discord:g1:c5', type: 'discord', history: { limit: 5 } }, UNKNOWN_CHANNEL, /^No channel this server serves matches/);
    assert.equal(g.server.channelManager.get('discord:g1:c5'), undefined, "c5 isn't registered");
    g.nothingOpened();
  });

  it('opens and registers a text channel the registry does not hold yet, by id or by address', async () => {
    const served = (guild: string, channel: string): Served | null =>
      (guild === 'g1' && channel === 'c7'
        ? { kind: 'guild', facts: { id: 'c7', guildId: 'g1', guildName: 'Guild', name: 'new', type: 'text' } }
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
      /^No channel this server serves matches channelId "discord:g1:c9": Discord doesn't know it or won't show it to this bot, it's in another server than the id names, it was deleted lately or is in a server the bot left, or it isn't a channel messages are posted in or a thread that the filters admit\. Nothing was opened\. list_channels with a server's id lists the channels this server serves there\.$/,
    );
    await f.refused({ type: 'discord', address: { guildId: 'g1', channelId: 'c9' } }, UNKNOWN_CHANNEL, /^No channel this server serves matches address "g1"\/"c9"/);
    assert.deepEqual(f.lookups, ['g1/c9', 'g1/c9']);
    f.nothingOpened();
  });

  it("refuses a DM id this server does not serve as unknown, with a DM's causes and no server to list", async () => {
    const f = fixture();
    await f.refused(
      { channelId: 'discord:dm:d9', type: 'discord', history: { limit: 10 } }, UNKNOWN_CHANNEL,
      /^No DM this server serves matches channelId "discord:dm:d9": Discord doesn't know it or won't show it to this bot, it isn't a DM, or the DM list doesn't admit its recipient\. Nothing was opened\.$/,
    );
    assert.deepEqual(f.lookups, ['dm/d9']);
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

  it('refuses a channel of a guild the bot has left, read after the lookup, and registers nothing', async () => {
    const kept: ChannelFacts = { id: 'c8', guildId: 'g2', guildName: 'Gone', name: 'kept', type: 'text' };
    // discord.js can keep a channel past the leave, so the lookup still finds it.
    const f = fixture([general], { served: () => ({ kind: 'guild', facts: kept }) });
    f.left.add('g2');
    await f.refused({ channelId: 'discord:g2:c8', type: 'discord', history: { limit: 5 } }, UNKNOWN_CHANNEL, /^No channel this server serves matches/);
    // The bot leaves while the lookup is out.
    const g = fixture([general], {
      served: async () => {
        g.left.add('g1');
        return { kind: 'guild', facts: { ...kept, guildId: 'g1', guildName: 'Guild' } };
      },
    });
    await g.refused({ channelId: 'discord:g1:c8', type: 'discord', history: { limit: 5 } }, UNKNOWN_CHANNEL, /^No channel this server serves matches/);
    for (const x of [f, g]) {
      assert.deepEqual(x.server.channelManager.getAll().map((c) => c.id), [general.id], 'nothing more is registered');
      x.nothingOpened();
    }
  });

  it('opens a text channel whose category was deleted, since a channel outlives its category', async () => {
    const survivor: ChannelFacts = { id: 'c9', guildId: 'g1', guildName: 'Guild', name: 'survivor', type: 'text', parentId: 'cat1' };
    const f = fixture([general], { served: (guild, channel) => (channel === 'c9' ? { kind: 'guild', facts: survivor } : null) });
    (f.server as unknown as { channelDeleted(guildId: string, channelId: string): void }).channelDeleted('g1', 'cat1');
    const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord' });
    assert.equal(res.channel.id, 'discord:g1:c9');
    assert.equal(f.server.channelManager.get('discord:g1:c9')?.label, '#survivor (Guild)');
  });

  it("refuses an id whose channel's current facts aren't known as an open that failed, and registers nothing", async () => {
    const f = fixture([general], { served: () => ({ kind: 'uncertain' }) });
    await f.refused(
      { channelId: 'discord:g1:c8', type: 'discord', history: { limit: 5 } }, OPEN_FAILED,
      /^channelId "discord:g1:c8" can't be opened right now: Discord's current facts for it, or for the channel it's a thread of, aren't known \(the latest fetch failed or was overtaken by a change\)\. Nothing was opened; another open fetches it again\.$/,
    );
    assert.equal(f.server.channelManager.get('discord:g1:c8'), undefined, "it isn't registered");
    f.nothingOpened();
  });
});

describe("channels/open: the open registers a looked-up channel only when it commits", () => {
  const late: ChannelFacts = { id: 'c9', guildId: 'g1', guildName: 'Guild', name: 'late', type: 'text' };
  const lateServed = (guild: string, channel: string): Served | null =>
    (guild === 'g1' && channel === 'c9' ? { kind: 'guild', facts: late } : null);
  /** The host's side of the connection, so what's announced can be read. */
  function announcing(server: unknown) {
    const sent: Array<{ method: string; params: { added?: Array<{ id: string }> } }> = [];
    Object.assign(server as object, {
      mcplEnabled: true,
      conn: { isClosed: false, sendNotification: (method: string, params: never) => { sent.push({ method, params }); } },
    });
    return () => sent.filter((x) => x.method === 'channels/changed').flatMap((x) => x.params.added ?? []).map((d) => d.id);
  }

  it('registers and announces nothing when its open is refused after the lookup', async () => {
    // The history fetch fails.
    const f = fixture([general], { served: lateServed, history: async () => { throw new Error('Service Unavailable'); } });
    const added = announcing(f.server);
    await f.refused({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } }, OPEN_FAILED,
      /^discord:g1:c9's history couldn't be fetched, so nothing was opened: Service Unavailable$/);
    assert.equal(f.server.channelManager.get('discord:g1:c9'), undefined, "it isn't registered");
    assert.deepEqual(added(), [], 'nothing was announced');
  });

  it('registers and announces it once the open commits', async () => {
    const f = fixture([general], { served: lateServed });
    const added = announcing(f.server);
    const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
    assert.equal(res.channel.label, '#late (Guild)');
    assert.deepEqual(added(), ['discord:g1:c9']);
    assert.equal(f.server.channelManager.isOpen('discord:g1:c9'), true);
  });

  it('refuses one deleted, or whose server the bot leaves, while its history is fetched, and registers nothing', async () => {
    for (const during of ['deleted', 'left'] as const) {
      const held = heldHistory();
      const f = fixture([general], { served: lateServed, history: held.history });
      const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
      await untilFetch(held, open);
      if (during === 'deleted') (f.server as unknown as { channelDeleted(guildId: string, channelId: string): void }).channelDeleted('g1', 'c9');
      else f.left.add('g1');
      held.release();
      await assert.rejects(open, (err: Error & { code?: number }) =>
        err.code === UNKNOWN_CHANNEL
          && err.message === 'discord:g1:c9 was deleted, or the bot left its server, while this open was in progress. Nothing was opened.', during);
      assert.equal(f.server.channelManager.get('discord:g1:c9'), undefined, `${during}: it isn't registered`);
      assert.deepEqual(f.subscribed(), [], `${during}: nothing was subscribed`);
    }
  });

  it('refuses one gone during the history fetch as gone, even when the filters check after the fetch can no longer find it', async () => {
    // As the adapter's inspectionRefusal does, the check fails once the
    // channel can't be found.
    let gone = false;
    const inspection = async (channelId: string) => {
      if (gone) throw new Error(`Channel ${channelId} not found`);
      return null;
    };
    // A looked-up channel deleted during the fetch.
    const held = heldHistory();
    const f = fixture([general], { served: lateServed, history: held.history, inspection });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    (f.server as unknown as { channelDeleted(guildId: string, channelId: string): void }).channelDeleted('g1', 'c9');
    gone = true;
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) =>
      err.code === UNKNOWN_CHANNEL
        && err.message === 'discord:g1:c9 was deleted, or the bot left its server, while this open was in progress. Nothing was opened.');
    assert.equal(f.server.channelManager.get('discord:g1:c9'), undefined, "it isn't registered");
    assert.deepEqual(f.subscribed(), [], 'nothing was subscribed');
    // A registered channel deleted during the fetch.
    gone = false;
    const heldG = heldHistory();
    const g = fixture([general], { history: heldG.history, inspection });
    const openG = g.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    await untilFetch(heldG, openG);
    (g.server as unknown as { channelDeleted(guildId: string, channelId: string): void }).channelDeleted('g1', 'c1');
    gone = true;
    heldG.release();
    await assert.rejects(openG, (err: Error & { code?: number }) =>
      err.code === UNKNOWN_CHANNEL
        && err.message === 'discord:g1:c1 was unregistered while this open was in progress (deleted, archived, in a server the bot left, or no longer admitted by the filters). Nothing was opened. A thread archived meanwhile opens again when it is opened by its id.');
    assert.deepEqual(g.subscribed(), [], 'nothing was subscribed');
  });

  it('refuses a DM looked up whose recipient the DM list stops admitting during the history fetch, and registers nothing', async () => {
    const held = heldHistory();
    const f = fixture([general], {
      served: (guild, channel) => (guild === 'dm' && channel === 'd9' ? { kind: 'dm', recipientId: 'u9', recipientName: 'ra' } : null),
      history: held.history,
    });
    const added = announcing(f.server);
    const open = f.server.handleChannelOpen({ channelId: 'discord:dm:d9', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    f.offDmList.add('u9');
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) =>
      err.code === UNKNOWN_CHANNEL
        && err.message === "The DM list stopped admitting discord:dm:d9's recipient while this open was in progress. Nothing was opened. "
          + 'Opening it is refused while the DM list leaves its recipient out.');
    assert.equal(f.server.channelManager.get('discord:dm:d9'), undefined, "it isn't registered");
    assert.deepEqual(added(), [], 'nothing was announced');
    assert.deepEqual(f.subscribed(), [], 'nothing was subscribed');
  });

  it('refuses one deleted, or whose server the bot leaves, as gone when that is what fails its history fetch', async () => {
    const goneText = 'discord:g1:c9 was deleted, or the bot left its server, while this open was in progress. Nothing was opened.';
    for (const during of ['deleted', 'left'] as const) {
      // Discord answers the fetch with the channel gone, after the server
      // has heard of it.
      const held = heldHistory(new Error(during === 'deleted' ? 'Unknown Channel' : 'Missing Access'));
      const f = fixture([general], { served: lateServed, history: held.history });
      const added = announcing(f.server);
      const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
      await untilFetch(held, open);
      if (during === 'deleted') (f.server as unknown as { channelDeleted(guildId: string, channelId: string): void }).channelDeleted('g1', 'c9');
      else f.left.add('g1');
      held.release();
      await assert.rejects(open, (err: Error & { code?: number }) => err.code === UNKNOWN_CHANNEL && err.message === goneText, during);
      assert.equal(f.server.channelManager.get('discord:g1:c9'), undefined, `${during}: it isn't registered`);
      assert.deepEqual(added(), [], `${during}: nothing was announced`);
      assert.deepEqual(f.subscribed(), [], `${during}: nothing was subscribed`);
    }
    // A registered channel deleted while its history is fetched.
    const held = heldHistory(new Error('Unknown Channel'));
    const g = fixture([general], { history: held.history });
    const open = g.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    (g.server as unknown as { channelDeleted(guildId: string, channelId: string): void }).channelDeleted('g1', 'c1');
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) =>
      err.code === UNKNOWN_CHANNEL
        && err.message === 'discord:g1:c1 was unregistered while this open was in progress (deleted, archived, in a server the bot left, or no longer admitted by the filters). Nothing was opened. A thread archived meanwhile opens again when it is opened by its id.');
    assert.deepEqual(g.subscribed(), [], 'nothing was subscribed');
  });

  it('refuses one gone meanwhile as gone when the filters check refuses it, before the history fetch or after it', async () => {
    const goneText = 'discord:g1:c9 was deleted, or the bot left its server, while this open was in progress. Nothing was opened.';
    const outside = 'Channel c9 is outside this residence\'s configured channel filters — filters bound inspection as well as delivery. Nothing was read.';
    // Before the fetch: the bot leaves the server while the check runs, and
    // the check refuses the channel, or fails to place it.
    for (const check of ['refuses', 'fails'] as const) {
      let f!: ReturnType<typeof fixture>;
      f = fixture([general], {
        served: lateServed,
        inspection: async () => {
          f.left.add('g1');
          if (check === 'fails') throw new Error('Channel c9 not found');
          return outside;
        },
      });
      await f.refused({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } }, UNKNOWN_CHANNEL,
        /^discord:g1:c9 was deleted, or the bot left its server, while this open was in progress\. Nothing was opened\.$/);
      assert.deepEqual(f.fetched, [], `${check}: no history was fetched`);
      assert.equal(f.server.channelManager.get('discord:g1:c9'), undefined, `${check}: it isn't registered`);
    }
    // After the fetch: the bot leaves the server during it, and the check
    // after it refuses the channel.
    let left = false;
    const held = heldHistory();
    const g = fixture([general], { served: lateServed, history: held.history, inspection: async () => (left ? outside : null) });
    const open = g.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    g.left.add('g1');
    left = true;
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) => err.code === UNKNOWN_CHANNEL && err.message === goneText);
    assert.deepEqual(g.subscribed(), [], 'nothing was subscribed');
  });

  it('opens a guild channel it looks up, with a DM list set, since the DM list is asked only about a DM', async () => {
    const f = fixture([general], { served: lateServed });
    f.offDmList.add('u9');
    const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
    assert.equal(res.channel.id, 'discord:g1:c9');
    assert.equal(f.server.channelManager.isOpen('discord:g1:c9'), true);
  });

  it('keeps a registration traffic made during the history fetch, and labels the history by what it commits to', async () => {
    const held = heldHistory();
    const f = fixture([general], { served: lateServed, history: held.history });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    // A message registers it meanwhile, under the name it has now.
    f.server.channelManager.register(toDescriptor({ id: 'c9', guildId: 'g1', guildName: 'Guild', name: 'renamed', type: 'text' }));
    held.release();
    const res = await open as OpenResult & { history?: Array<{ channelLabel?: string }> };
    assert.equal(res.channel.label, '#renamed (Guild)');
    assert.equal(f.server.channelManager.get('discord:g1:c9')?.label, '#renamed (Guild)', 'the registration traffic made stands');
    assert.equal(res.history?.[0].channelLabel, '#renamed (Guild)');
  });

  it('registers a looked-up channel as the names stand at commit, when another channel takes its name during the fetch', async () => {
    const voice: ChannelFacts = { id: 'c7', guildId: 'g1', guildName: 'Guild', name: 'General', type: 'voice' };
    // What the cache knows of it, which the history fetch's wait can change.
    let known: ChannelFacts = voice;
    const held = heldHistory();
    const f = fixture([dev], {
      served: (guild, channel) => (guild === 'g1' && channel === 'c7' ? { kind: 'guild', facts: voice } : null),
      history: held.history,
      cachedFacts: (ids) => new Map(ids.includes('c7') ? [['c7', known]] : []),
    });
    // What the host is told, so a label announced and then corrected shows.
    const announced: string[] = [];
    Object.assign(f.server as object, {
      mcplEnabled: true,
      conn: {
        isClosed: false,
        sendNotification: (_m: string, p: { added?: Array<{ id: string; label: string }>; updated?: Array<{ id: string; label: string }> }) => {
          for (const d of [...(p.added ?? []), ...(p.updated ?? [])]) if (d.id === 'discord:g1:c7') announced.push(d.label);
        },
      },
    });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c7', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    // A text channel named general is made meanwhile, and the resolver
    // prefers it, so General no longer resolves back to the voice channel.
    known = { ...voice, nameResolves: false };
    held.release();
    const res = await open as OpenResult & { history?: Array<{ channelLabel?: string }> };
    assert.equal(res.channel.label, 'discord:g1:c7', 'labelled by its id, since its name now reaches another channel');
    assert.equal(f.server.channelManager.get('discord:g1:c7')?.label, 'discord:g1:c7');
    assert.equal(res.history?.[0].channelLabel, 'discord:g1:c7');
    assert.deepEqual(announced, ['discord:g1:c7'], 'announced once, by the label it commits to');
  });

  it('registers a looked-up channel that went stale during the fetch labelled by its id', async () => {
    const stale = new Set<string>();
    const held = heldHistory();
    const f = fixture([general], {
      served: lateServed,
      history: held.history,
      cachedFacts: (ids) => new Map(ids.includes('c9') ? [['c9', late]] : []),
      stale,
    });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    // A fetch of it is overtaken meanwhile, so its cached facts decide nothing.
    stale.add('c9');
    held.release();
    const res = await open;
    assert.equal(res.channel.label, 'discord:g1:c9', 'its name may no longer be its own, so it answers none');
    assert.equal(f.server.channelManager.get('discord:g1:c9')?.label, 'discord:g1:c9');
  });

  it('re-derives the registered channels of its name once it registers a looked-up channel, as a creation does', async () => {
    const voice: ChannelFacts = { id: 'c5', guildId: 'g1', guildName: 'Guild', name: 'General', type: 'voice' };
    const text: ChannelFacts = { id: 'c6', guildId: 'g1', guildName: 'Guild', name: 'general', type: 'text' };
    // The cache didn't hold the text channel when the voice channel was
    // labelled, and now the resolver prefers it.
    const known = new Map<string, ChannelFacts>([['c5', { ...voice, nameResolves: false }], ['c6', text]]);
    const f = fixture([dev, toDescriptor(voice)], {
      served: (guild, channel) => (guild === 'g1' && channel === 'c6' ? { kind: 'guild', facts: text } : null),
      cachedFacts: (ids) => new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!])),
    });
    assert.equal(f.server.channelManager.get('discord:g1:c5')?.label, '#General (Guild)', 'labelled by its name before the open');
    const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:c6', type: 'discord', history: { limit: 5 } });
    assert.equal(res.channel.label, '#general (Guild)');
    assert.equal(f.server.channelManager.get('discord:g1:c5')?.label, 'discord:g1:c5', 'the voice channel answers its name no longer');
  });

  it('labels a registered channel\'s history by its label at commit, when it is relabelled during the fetch', async () => {
    const held = heldHistory();
    const f = fixture([general], { history: held.history });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    f.server.channelManager.register(toDescriptor({ id: 'c1', guildId: 'g1', guildName: 'Guild', name: 'general-2', type: 'text' }));
    held.release();
    const res = await open as OpenResult & { history?: Array<{ channelLabel?: string }> };
    assert.equal(res.channel.label, '#general-2 (Guild)');
    assert.equal(res.history?.[0].channelLabel, '#general-2 (Guild)');
  });

  it("refuses as unknown a lookup that hands back another channel's facts, and registers neither", async () => {
    const other: ChannelFacts = { id: 'c8', guildId: 'g1', guildName: 'Guild', name: 'other', type: 'text' };
    const f = fixture([general], { served: (guild, channel) => (channel === 'c9' ? { kind: 'guild', facts: other } : null) });
    await f.refused({ channelId: 'discord:g1:c9', type: 'discord', history: { limit: 5 } }, UNKNOWN_CHANNEL,
      /^No channel this server serves matches channelId "discord:g1:c9": looking it up found another channel, discord:g1:c8\. Nothing was opened\.$/);
    assert.equal(f.server.channelManager.get('discord:g1:c9'), undefined);
    assert.equal(f.server.channelManager.get('discord:g1:c8'), undefined);
    f.nothingOpened();
  });
});

describe('channels/open: what arrives during the lookup or the history fetch stands', () => {
  it('opens nothing when the channel is unregistered meanwhile', async () => {
    const held = heldHistory();
    const f = fixture([general], { history: held.history });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:c1', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    f.server.channelManager.unregister('discord:g1:c1');
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) =>
      err.code === UNKNOWN_CHANNEL
        && err.message === 'discord:g1:c1 was unregistered while this open was in progress (deleted, archived, in a server the bot left, or no longer admitted by the filters). Nothing was opened. A thread archived meanwhile opens again when it is opened by its id.');
    assert.deepEqual(f.subscribed(), []);
  });

  it('refuses a registered thread archived during its history fetch as unregistered, and an open by its id then opens it', async () => {
    const thread = toDescriptor({ id: 't1', guildId: 'g1', guildName: 'Guild', type: 'thread', name: 'plans', parentId: 'c1', parentName: 'general' });
    const archived: ChannelFacts = { id: 't1', guildId: 'g1', guildName: 'Guild', type: 'thread', name: 'plans', parentId: 'c1', parentName: 'general', archived: true };
    const held = heldHistory();
    let fetches = 0;
    const f = fixture([general, thread], {
      served: (guild, channel) => (guild === 'g1' && channel === 't1' ? { kind: 'guild', facts: archived } : null),
      history: async (channelId) => (++fetches === 1 ? held.history(channelId) : [historyItem(channelId)]),
    });
    const open = f.server.handleChannelOpen({ channelId: 'discord:g1:t1', type: 'discord', history: { limit: 5 } });
    await untilFetch(held, open);
    // As an archive reported meanwhile does (threadReported).
    f.server.channelManager.unregister('discord:g1:t1');
    held.release();
    await assert.rejects(open, (err: Error & { code?: number }) =>
      err.code === UNKNOWN_CHANNEL
        && err.message === 'discord:g1:t1 was unregistered while this open was in progress (deleted, archived, in a server the bot left, or no longer admitted by the filters). Nothing was opened. A thread archived meanwhile opens again when it is opened by its id.');
    assert.deepEqual(f.subscribed(), [], 'nothing was subscribed');
    // The same open again looks it up, and opens it with its history.
    const res = await f.server.handleChannelOpen({ channelId: 'discord:g1:t1', type: 'discord', history: { limit: 5 } });
    assert.equal(res.channel.id, 'discord:g1:t1');
    assert.equal(res.history?.length, 1);
    assert.equal(f.server.channelManager.isOpen('discord:g1:t1'), true);
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
      d1: { type: ChannelType.DM, recipientIds: ['u1'] },
      d2: { type: ChannelType.DM, recipientIds: ['u2'] },
    };
    const names: Record<string, string> = { u1: 'ra', u2: 'someone' };
    t.mock.method(client.channels, 'fetch', (async (id: string) => dms[id] ?? null) as never);
    t.mock.method(client.users, 'fetch', (async (id: string) => ({ username: names[id] })) as never);
    assert.deepEqual(await adapter.lookUpServedChannel('dm', 'd1'), { kind: 'dm', recipientId: 'u1', recipientName: 'ra' });
    assert.equal(await adapter.lookUpServedChannel('dm', 'd2'), null, 'the DM list refuses its recipient');
    assert.equal(await adapter.lookUpServedChannel('g1', 'd1'), null, 'a DM named under a guild');
    assert.equal(await adapter.lookUpServedChannel('dm', 'gone'), null, 'Discord finds nothing');
  });

  /** A DM as discord.js 14.26.5 holds one it has seen a message in, in the
   *  client's channel cache: whole (it has a last message), with the
   *  recipients it recorded, which are only the bot when the bot's own
   *  message came first (Action.getChannel), and none when it was told of
   *  none. Its recipientId and recipient getters are discord.js's
   *  (DMChannel.js:83-95): the bot's id, and the bot's user, when the bot is
   *  all it recorded, and a throw when nothing is. The bot's own user is in
   *  the client's user cache. Asked past the cache, Discord answers with
   *  `discordSays`. */
  function heldDm(t: TestContext, client: Client, recorded: string[] | undefined, discordSays: () => Promise<unknown>) {
    (client as unknown as { user: { id: string } }).user = { id: 'the-bot' };
    t.mock.method(client.users, 'resolve', ((id: string) => (id === 'the-bot' ? { id, username: 'the-bot-itself' } : null)) as never);
    const held = {
      type: ChannelType.DM,
      partial: false,
      recipientIds: recorded,
      get recipientId(): string {
        return this.recipientIds!.find((id) => id !== 'the-bot') ?? this.recipientIds![0];
      },
      get recipient(): unknown {
        return client.users.resolve(this.recipientId);
      },
    };
    client.channels.cache.set('d1', held as never);
    const forced: boolean[] = [];
    t.mock.method(client.channels, 'fetch', (async (_id: string, o?: { force?: boolean }) => {
      forced.push(o?.force === true);
      return discordSays();
    }) as never);
    t.mock.method(client.users, 'fetch', (async (id: string) => ({ username: id === 'u1' ? 'ra' : id })) as never);
    return forced;
  }

  it('asks Discord again, past the cache, for the other party of a DM held with only the bot recorded, or none', async (t) => {
    for (const recorded of [['the-bot'], undefined]) {
      for (const dmUsers of [['u1'], undefined]) {
        const { adapter, client } = adapterFixture(t, dmUsers ? { dmUsers } : {});
        const forced = heldDm(t, client, recorded, async () => ({ type: ChannelType.DM, recipientIds: ['u1', 'the-bot'] }));
        const what = `recorded ${JSON.stringify(recorded)}, DM list ${JSON.stringify(dmUsers)}`;
        assert.deepEqual(await adapter.lookUpServedChannel('dm', 'd1'), { kind: 'dm', recipientId: 'u1', recipientName: 'ra' }, what);
        assert.deepEqual(forced, [true], `${what}: the cache answers the lookup, then Discord is asked past it`);
      }
    }
  });

  it('asks Discord nothing for a DM whose cache names its other party', async (t) => {
    const { adapter, client } = adapterFixture(t, { dmUsers: ['u1'] });
    const forced = heldDm(t, client, ['u1', 'the-bot'], async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); });
    assert.deepEqual(await adapter.lookUpServedChannel('dm', 'd1'), { kind: 'dm', recipientId: 'u1', recipientName: 'ra' });
    assert.deepEqual(forced, [], 'no fetch past the cache');
  });

  it("serves no DM whose other party Discord's answer past the cache doesn't name either, and reads that fetch's failure as the lookup's", async (t) => {
    const outcomes: Array<[string, () => Promise<unknown>, unknown]> = [
      ['names only the bot', async () => ({ type: ChannelType.DM, recipientIds: ['the-bot'] }), null],
      ['names a party the DM list leaves out', async () => ({ type: ChannelType.DM, recipientIds: ['u2', 'the-bot'] }), null],
      ['gets no answer', async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); }, { kind: 'uncertain' }],
      ['is refused', async () => { throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 }); }, null],
    ];
    for (const [what, discordSays, expected] of outcomes) {
      const { adapter, client } = adapterFixture(t, { dmUsers: ['u1'] });
      heldDm(t, client, ['the-bot'], discordSays);
      assert.deepEqual(await adapter.lookUpServedChannel('dm', 'd1'), expected, what);
    }
  });

  it('comes back uncertain when Discord gives its lookup no answer, a rejection that is not an Error included', async (t) => {
    const { adapter, client } = adapterFixture(t, {});
    const failures: unknown[] = [
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
      new TypeError('fetch failed'),
      null,
    ];
    let failure: unknown;
    const fetch = t.mock.method(client.channels, 'fetch', (async () => { throw failure; }) as never);
    for (const [i, f] of failures.entries()) {
      failure = f;
      assert.deepEqual(await adapter.lookUpServedChannel('dm', 'x'), { kind: 'uncertain' }, String(f));
      assert.equal(fetch.mock.callCount(), i + 1, `${String(f)}: the lookup asked Discord`);
    }
  });

  it('serves nothing when Discord refuses its lookup', async (t) => {
    const { adapter, client } = adapterFixture(t, {});
    let failure: unknown;
    t.mock.method(client.channels, 'fetch', (async () => { throw failure; }) as never);
    failure = Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });
    assert.equal(await adapter.lookUpServedChannel('g1', 'hidden'), null, 'no access');
    failure = Object.assign(new Error('Invalid Form Body'), { status: 400, code: 50035 });
    assert.equal(await adapter.lookUpServedChannel('dm', 'not-a-snowflake'), null, 'a malformed id');
  });

  it("comes back uncertain for a refusal that isn't about the id, a 401 included, and serves nothing for any 403 or 404", async (t) => {
    const { adapter, client } = adapterFixture(t, {});
    let failure: unknown;
    t.mock.method(client.channels, 'fetch', (async () => { throw failure; }) as never);
    // The bot's token was revoked or rotated: nothing here says the id is unknown.
    failure = Object.assign(new Error('401: Unauthorized'), { status: 401, code: 0 });
    assert.deepEqual(await adapter.lookUpServedChannel('g1', 'c1'), { kind: 'uncertain' }, 'a 401');
    failure = Object.assign(new Error('Bad Request'), { status: 400, code: 0 });
    assert.deepEqual(await adapter.lookUpServedChannel('g1', 'c1'), { kind: 'uncertain' }, 'a 400 without Invalid Form Body');
    failure = Object.assign(new Error('Forbidden'), { status: 403 });
    assert.equal(await adapter.lookUpServedChannel('g1', 'c1'), null, 'a 403 without a code');
    failure = Object.assign(new Error('Not Found'), { status: 404 });
    assert.equal(await adapter.lookUpServedChannel('g1', 'c1'), null, 'a 404 without a code');
  });

  it('says whether the DM list admits a user as it stands now, every user when there is no list', (t) => {
    const { adapter } = adapterFixture(t, { dmUsers: ['u1'] });
    assert.equal(adapter.dmUserAdmitted('u1'), true);
    assert.equal(adapter.dmUserAdmitted('u2'), false);
    adapter.updateFilters({ dmUsers: ['u2'] });
    assert.equal(adapter.dmUserAdmitted('u1'), false, 'after a reload without u1');
    assert.equal(adapter.dmUserAdmitted('u2'), true);
    const open = adapterFixture(t, {}).adapter;
    assert.equal(open.dmUserAdmitted('anyone'), true, 'no DM list');
  });

  it("serves no DM whose recipient the DM list stops admitting while the recipient's name is fetched", async (t) => {
    const { adapter, client } = adapterFixture(t, { dmUsers: ['u1'] });
    t.mock.method(client.channels, 'fetch', (async () => ({ type: ChannelType.DM, recipientIds: ['u1'] })) as never);
    let reached!: () => void;
    let release!: () => void;
    const atFetch = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(client.users, 'fetch', (async () => { reached(); await gate; return { username: 'ra' }; }) as never);
    const lookup = adapter.lookUpServedChannel('dm', 'd1');
    await untilFetch({ atFetch }, lookup, "the recipient's name fetch");
    adapter.updateFilters({ dmUsers: ['u2'] });
    release();
    assert.equal(await lookup, null);
  });

  it('serves a channel messages are posted in, or a thread, of its own guild that the filters admit, and nothing else', async (t) => {
    const { adapter, client } = adapterFixture(t, { guildIds: ['g1', 'g2'], guildChannels: { g2: ['listed'] } });
    const channel = (id: string, type: number, guildId: string, extra: Record<string, unknown> = {}) =>
      ({ id, type, guildId, name: id, parentId: null, ...extra });
    const channels: Record<string, unknown> = {
      text: channel('text', ChannelType.GuildText, 'g1'),
      news: channel('news', ChannelType.GuildAnnouncement, 'g1'),
      voice: channel('voice', ChannelType.GuildVoice, 'g1'),
      stage: channel('stage', ChannelType.GuildStageVoice, 'g1'),
      thread: channel('thread', ChannelType.PublicThread, 'g1', { parentId: 'text', archived: false }),
      archived: channel('archived', ChannelType.PublicThread, 'g1', { parentId: 'text', archived: true }),
      forum: channel('forum', ChannelType.GuildForum, 'g1'),
      category: channel('category', ChannelType.GuildCategory, 'g1'),
      elsewhere: channel('elsewhere', ChannelType.GuildText, 'g3'),
      unlisted: channel('unlisted', ChannelType.GuildText, 'g2'),
      listed: channel('listed', ChannelType.GuildText, 'g2'),
      listedThread: channel('listedThread', ChannelType.PublicThread, 'g2', { parentId: 'listed' }),
      unlistedThread: channel('unlistedThread', ChannelType.PublicThread, 'g2', { parentId: 'unlisted' }),
    };
    t.mock.method(client.channels, 'fetch', (async (id: string) => {
      if (id === 'broken') throw new Error('Service Unavailable');
      return channels[id] ?? null;
    }) as never);
    // A guild's name comes from the client's guild cache, as the registry's
    // other paths read it, and so do the channels its names resolve among.
    const g1Channels = new Map(Object.entries(channels).filter(([, c]) => (c as { guildId: string }).guildId === 'g1'));
    client.guilds.cache.set('g1', { id: 'g1', name: 'g1-name', channels: { cache: g1Channels } } as never);
    // The facts its descriptor is made from, as every other path builds them.
    assert.deepEqual(await adapter.lookUpServedChannel('g1', 'text'), {
      kind: 'guild',
      facts: { id: 'text', guildId: 'g1', guildName: 'g1-name', type: 'text', name: 'text', parentId: null, parentName: null, archived: false, nameResolves: true },
    });
    for (const [id, kind] of [['news', 'announcement'], ['voice', 'voice'], ['stage', 'stage'], ['thread', 'thread'], ['archived', 'thread']] as const) {
      const found = await adapter.lookUpServedChannel('g1', id);
      assert.equal(found?.kind === 'guild' ? found.facts.type : null, kind, id);
    }
    const archived = await adapter.lookUpServedChannel('g1', 'archived');
    assert.equal(archived?.kind === 'guild' && archived.facts.archived, true, 'an archived thread is served, and says so');
    assert.equal(await adapter.lookUpServedChannel('g1', 'forum'), null, 'a forum holds no messages of its own');
    assert.equal(await adapter.lookUpServedChannel('g1', 'category'), null, 'nor does a category');
    assert.equal(await adapter.lookUpServedChannel('g2', 'text'), null, 'named under another guild');
    assert.equal(await adapter.lookUpServedChannel('g3', 'elsewhere'), null, 'a guild the guild filter leaves out');
    assert.equal(await adapter.lookUpServedChannel('g2', 'unlisted'), null, "a channel the guild's channel list leaves out");
    assert.equal((await adapter.lookUpServedChannel('g2', 'listed'))?.kind, 'guild');
    assert.equal((await adapter.lookUpServedChannel('g2', 'listedThread'))?.kind, 'guild', 'a thread of a listed channel');
    assert.equal(await adapter.lookUpServedChannel('g2', 'unlistedThread'), null, "a thread of a channel the list leaves out");
    assert.deepEqual(await adapter.lookUpServedChannel('g1', 'broken'), { kind: 'uncertain' }, 'a lookup Discord gives no answer to');
  });

  it('looks a channel up by the freshness rule: overtaken on every try, it comes back uncertain, and looked up again it is fetched fresh', { timeout: 5000 }, async (t) => {
    const { adapter, client } = adapterFixture(t, {});
    const text = { id: 'text', type: ChannelType.GuildText, guildId: 'g1', name: 'text', parentId: null };
    let held = true;
    let out: () => void = () => {};
    const fetch = t.mock.method(client.channels, 'fetch', (async () => {
      if (held) await new Promise<void>((done) => { out = done; });
      return text;
    }) as never);
    const lookup = adapter.lookUpServedChannel('g1', 'text');
    for (let tries = 1; tries <= 3; tries++) {
      await until(() => fetch.mock.callCount() === tries);
      // Discord reports on the channel while its fetch is out.
      client.ws.emit('CHANNEL_UPDATE', { id: 'text', guild_id: 'g1', type: ChannelType.GuildText, name: 'text', topic: `edit ${tries}` }, 0);
      out();
    }
    assert.deepEqual(await lookup, { kind: 'uncertain' });
    assert.equal(fetch.mock.callCount(), 3);
    assert.equal(adapter.isStale('text'), true);
    held = false;
    assert.equal((await adapter.lookUpServedChannel('g1', 'text'))?.kind, 'guild', 'fetched fresh, it is served');
    assert.equal(adapter.isStale('text'), false);
  });

  it("looks a thread's stale channel up first, and comes back uncertain while that channel stays stale", async (t) => {
    // The guild's channel list admits category `cat`, which Discord moved
    // `text` into; an older reply left `text` cached outside it, stale.
    const { adapter, client } = adapterFixture(t, { guildChannels: { g1: ['cat'] } });
    const text = { id: 'text', type: ChannelType.GuildText, guildId: 'g1', name: 'text', parentId: 'cat' };
    const thread = { id: 'th', type: ChannelType.PublicThread, guildId: 'g1', name: 'th', parentId: 'text', archived: false, isThread: () => true };
    client.channels.cache.set('text', { ...text, parentId: 'old' } as never);
    (adapter as unknown as { stale: Map<string, { guildId: string }> }).stale.set('text', { guildId: 'g1' });
    let channelFails = true;
    const fetch = t.mock.method(client.channels, 'fetch', (async (id: string) => {
      if (id === 'th') return thread;
      if (channelFails) throw new Error('Service Unavailable');
      client.channels.cache.set('text', text as never);
      return text;
    }) as never);
    assert.deepEqual(await adapter.lookUpServedChannel('g1', 'th'), { kind: 'uncertain' }, "its channel's lookup failed, so it stays stale");
    assert.deepEqual(fetch.mock.calls.map((c) => c.arguments[0]), ['th', 'text']);
    channelFails = false;
    const found = await adapter.lookUpServedChannel('g1', 'th');
    assert.equal(found?.kind === 'guild' ? found.facts.id : null, 'th', "its channel fetched fresh, that channel's category admits it");
    assert.equal(adapter.isStale('text'), false);
  });

  it("takes Discord's Unknown Channel, for a channel the cache placed in a guild, as its deletion, and serves nothing", async (t) => {
    const { adapter, client } = adapterFixture(t, {});
    client.channels.cache.set('text', { id: 'text', type: ChannelType.GuildText, guildId: 'g1', name: 'text', parentId: null } as never);
    // Stale, so the lookup asks Discord rather than reading the cache.
    (adapter as unknown as { stale: Map<string, { guildId: string }> }).stale.set('text', { guildId: 'g1' });
    const deleted: string[] = [];
    adapter.onChannelDelete((guildId, channelId) => { deleted.push(`${guildId}/${channelId}`); });
    t.mock.method(client.channels, 'fetch', (async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); }) as never);
    assert.equal(await adapter.lookUpServedChannel('g1', 'text'), null);
    assert.deepEqual(deleted, ['g1/text']);
    assert.equal(client.channels.cache.has('text'), false);
    assert.equal(adapter.isStale('text'), false);
  });
});
