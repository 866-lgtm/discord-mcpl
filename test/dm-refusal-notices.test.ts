/**
 * Refused DMs: the sender gets one automatic delivery notice, the agent gets
 * nothing, and the reconnect catch-up sweep applies the same ingress decision
 * as live delivery.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelType, Collection, MessageType, type Client } from 'discord.js';
import { DM_REFUSALS_HELD, DiscordAdapter, type DmRefusal } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { DM_NOTICE_TEXT, snowflakeAt } from '../src/dm-notices.js';

/** A message id Discord could assign right now (plus an increment), and
 *  never one this file handed out before: two calls in one millisecond would
 *  otherwise collide, and the second message would count as already handled.
 *  Call it after the harness exists: the notice state's floor is set when it
 *  opens. */
let lastFreshId = 0n;
const freshId = (n = 0) => {
  const id = BigInt(snowflakeAt(Date.now())) + BigInt(n);
  lastFreshId = id > lastFreshId ? id : lastFreshId + 1n;
  return lastFreshId.toString();
};

interface HistoryMessage {
  id: string; authorId: string; authorName: string; isBot: boolean; content: string; cleanContent: string;
  attachments: never[]; mentionsBot: boolean; timestamp: Date; reactions: never[];
}
const historyMessage = (id: string, authorId: string, text: string, mentionsBot = false): HistoryMessage => ({
  id, authorId, authorName: authorId, isBot: false, content: text, cleanContent: text,
  attachments: [], mentionsBot, timestamp: new Date(), reactions: [],
});

// Harnesses capture console.error; every one restores the real one, so two
// harnesses alive in one test (a restart) can't leave a stale capture behind.
const REAL_CONSOLE_ERROR = console.error;

type ChannelMeta = { name: string | null; guildId: string | null; guildName: string | null; isDM: boolean };
/** What the server hands back for one refusal (see handleDmRefusal). */
type Refusal = { decided: Promise<unknown>; settled: Promise<void> };

async function harness(t: TestContext, opts: {
  dmUsers?: string[];
  guildIds?: string[];
  guildChannels?: Record<string, string[]>;
  watermarks?: Record<string, string>;
  dmChannels?: string[];
  history?: (channelId: string) => Promise<HistoryMessage[]>;
  meta?: (channelId: string) => ChannelMeta | null;
  noticesFile?: 'fresh' | 'unwritable';
  /** Reuse a notice-state path, to model a restart. */
  noticesPath?: string;
  /** 'on' (the default here) turns notices on at startup, as a resident
   *  would; 'as-saved' leaves the state's own setting, which is off in a
   *  new state. */
  notices?: 'on' | 'as-saved';
  /** Use the adapter's real channel-metadata helpers instead of stubs. */
  realMeta?: boolean;
  /** Send notices through the adapter's real sendDmNotice. */
  realSend?: boolean;
  /** Start as index.ts does but connect no host, as in TCP mode before its
   *  first client: no host connection and no message forwarding. */
  noHost?: boolean;
  /** Runs once Discord's client exists and before the server handles
   *  refusals, as when Discord reports refusals before index.ts gets there. */
  beforeRefusals?: (emit: (authorId: string, opts?: { id?: string; channelId?: string }) => void) => void;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-refusal-'));
  const env = { wm: process.env.DISCORD_WATERMARK_FILE, notices: process.env.DISCORD_DM_NOTICES_FILE };
  const wm = join(dir, 'wm.json');
  writeFileSync(wm, JSON.stringify({ watermarks: opts.watermarks ?? {}, dmChannels: opts.dmChannels ?? [] }));
  process.env.DISCORD_WATERMARK_FILE = wm;
  const noticesDir = join(dir, 'notices');
  process.env.DISCORD_DM_NOTICES_FILE = opts.noticesPath ?? join(noticesDir, 'dm-notices.json');
  if (opts.noticesFile === 'unwritable') {
    // A directory where the file should be: it can be neither read nor written.
    rmSync(noticesDir, { recursive: true, force: true });
    writeFileSync(noticesDir, 'not a directory');
  }

  const adapter = new DiscordAdapter({
    token: 'unused', dmUsers: opts.dmUsers, guildIds: opts.guildIds, guildChannels: opts.guildChannels,
  });
  const client = (adapter as unknown as { client: Client }).client;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  t.after(() => {
    console.error = REAL_CONSOLE_ERROR;
    client.destroy();
    if (env.wm === undefined) delete process.env.DISCORD_WATERMARK_FILE; else process.env.DISCORD_WATERMARK_FILE = env.wm;
    if (env.notices === undefined) delete process.env.DISCORD_DM_NOTICES_FILE; else process.env.DISCORD_DM_NOTICES_FILE = env.notices;
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const a = adapter as unknown as Record<string, unknown>;
  a.fetchHistory = (channelId: string) => (opts.history ? opts.history(channelId) : Promise.resolve([]));
  if (!opts.realMeta) {
    const meta = opts.meta ?? (() => null);
    a.getCachedChannelMeta = (channelId: string) => meta(channelId);
    a.getChannelMeta = async (channelId: string) => {
      const m = meta(channelId);
      if (!m) throw new Error('lookup failed');
      return m;
    };
  }
  const notices: Array<{ channelId: string; content: string }> = [];
  let noticeError: Error | null = null;
  if (!opts.realSend) {
    a.sendDmNotice = async (channelId: string, content: string) => {
      if (noticeError) throw noticeError;
      notices.push({ channelId, content });
      return { messageId: 'notice' };
    };
  }

  const delivered: string[] = [];
  const emit = (authorId: string, opts2: { id?: string; guildId?: string | null; channelId?: string; content?: string } = {}) => {
    (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
      id: opts2.id ?? freshId(), channelId: opts2.channelId ?? `dm-${authorId}`, guildId: opts2.guildId ?? null, channel: null,
      author: { id: authorId, username: authorId, bot: false },
      content: opts2.content ?? 'hello', cleanContent: opts2.content ?? 'hello', type: MessageType.Default,
      attachments: new Collection(), createdAt: new Date(),
      mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
    });
  };

  const server = new DiscordMcplServer(adapter) as unknown as Record<string, unknown> & {
    runReconnectSweep(): Promise<void>;
    setupDiscordForwarding(): void;
    setupDmRefusals(): Promise<void>;
    filtersUpdate(args: Record<string, unknown>): Promise<{ applied: { dmNotice: boolean | null }; notes: string[] }>;
    executeToolCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    handleDmRefusal(ev: DmRefusal): Refusal;
    forwardedWatermark: Map<string, string>;
  };
  // Keep what each refusal hands back, so a test can wait for it.
  const refusals: Refusal[] = [];
  const handle = server.handleDmRefusal.bind(server);
  server.handleDmRefusal = (ev: DmRefusal) => {
    const r = handle(ev);
    refusals.push(r);
    return r;
  };
  const pushes: Array<{ payload: { content: Array<{ text: string }> } }> = [];
  if (!opts.noHost) {
    server.conn = {
      sendRequest: async (_method: string, params: unknown) => {
        pushes.push(params as (typeof pushes)[number]);
        return {};
      },
      // A real connection has both. The server announces registrations
      // (channels/changed) as notifications, which these tests don't inspect.
      sendNotification: () => {},
    };
    server.mcplEnabled = true;
    server.enabledFeatureSets = new Set(['discord.messaging']);
    server.setupDiscordForwarding();
  }
  opts.beforeRefusals?.(emit);
  // As index.ts does at startup: refusals are handled from here on, and the
  // notice state's floor predates the sweep.
  await server.setupDmRefusals();
  // Notices are off in a new notice state; most tests here are about what
  // happens once a resident has turned them on.
  if ((opts.notices ?? 'on') === 'on' && opts.noticesFile !== 'unwritable') {
    await server.filtersUpdate({ setDmNotice: true });
  }
  // Record what the adapter hands the server, then let the server handle it.
  const toServer = (adapter as unknown as { messageHandler?: (m: { authorId: string; content: string }) => void }).messageHandler;
  (adapter as unknown as { messageHandler: (m: { authorId: string; content: string }) => void }).messageHandler = (m) => {
    delivered.push(`${m.authorId}:${m.content}`);
    toServer?.(m);
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    adapter, client, server, emit, delivered, pushes, notices, logs,
    /** Wait until every refusal so far is decided: a notice due is reserved. */
    decided: async () => { await tick(); await Promise.all(refusals.map((r) => r.decided)); },
    /** Wait until every refusal so far is handled, its log line written. */
    settle: async () => { await tick(); await Promise.all(refusals.map((r) => r.settled)); },
    failNoticesWith: (err: Error | null) => { noticeError = err; },
    noticesPath: process.env.DISCORD_DM_NOTICES_FILE!,
  };
}

describe('live refusals', () => {
  it('tells a refused sender once per 24 hours and forwards nothing', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'] });
    h.emit('stranger', { id: freshId(1), content: 'first private words' });
    await h.settle();
    h.emit('stranger', { id: freshId(2), content: 'second private words' });
    await h.settle();
    assert.deepEqual(h.delivered, [], 'nothing reaches the agent');
    assert.deepEqual(h.notices, [{ channelId: 'dm-stranger', content: DM_NOTICE_TEXT }]);
    const lines = h.logs.filter((l) => l.includes('DM refused by the DM allowlist'));
    assert.equal(lines.length, 2, 'one operator line per refused DM');
    assert.match(lines[0], /\(live\): sender stranger, message \d+; notice sent/);
    assert.match(lines[1], /notice rate-limited/);
    assert.ok(!h.logs.some((l) => l.includes('private words')), 'no message body is logged');
    const state = readFileSync(h.noticesPath, 'utf-8');
    assert.ok(!state.includes('private words'), 'the notice state stores no message bodies');
  });

  it('decides concurrent refusals once: the same message twice, or two messages from one sender, in one tick', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'] });
    const id = freshId(3);
    h.emit('stranger', { id });
    h.emit('stranger', { id });
    h.emit('stranger', { id: freshId(4) });
    await h.settle();
    assert.equal(h.notices.length, 1);
    const outcomes = h.logs.filter((l) => l.includes('sender stranger')).map((l) => l.replace(/.*; notice /, ''));
    assert.deepEqual(outcomes.sort(), ['already-handled', 'rate-limited', 'sent']);
  });

  it('after a crash between reservation and outcome, reports the attempt as unknown and does not retry it', async (t) => {
    const keep = mkdtempSync(join(tmpdir(), 'dm-notice-crash-'));
    t.after(() => rmSync(keep, { recursive: true, force: true }));
    const noticesPath = join(keep, 'dm-notices.json');
    const first = await harness(t, { dmUsers: ['friend'], noticesPath });
    (first.adapter as unknown as Record<string, unknown>).sendDmNotice = () => new Promise(() => {}); // never settles
    first.emit('stranger', { id: freshId(1) });
    await first.decided();
    assert.equal(JSON.parse(readFileSync(noticesPath, 'utf-8')).senders.stranger.lastNotice.outcome, 'pending');

    const restarted = await harness(t, { dmUsers: ['friend'], noticesPath });
    assert.ok(restarted.logs.some((l) => /DM notice to sender stranger .* was interrupted before its outcome was recorded; outcome unknown, not retried/.test(l)));
    restarted.emit('stranger', { id: freshId(2) });
    await restarted.settle();
    assert.deepEqual(restarted.notices, []);
    assert.ok(restarted.logs.some((l) => /sender stranger.*notice rate-limited/.test(l)));
  });

  it('sends no notice for allowed senders, guild messages, or a duplicate of a handled message', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'] });
    h.emit('friend', { content: 'hi' });
    h.emit('anyone', { guildId: 'g1', channelId: 'chan1', content: 'in a guild' });
    const id = freshId(7);
    h.emit('stranger', { id });
    await h.settle();
    h.emit('stranger', { id }); // the same gateway event again
    await h.settle();
    assert.deepEqual(h.delivered, ['friend:hi', 'anyone:in a guild']);
    assert.equal(h.notices.length, 1);
    assert.ok(h.logs.some((l) => l.includes('notice already-handled')));
  });

  it('sends nothing for an old message arriving live, from before the connector began handling refusals', async (t) => {
    const before = (BigInt(snowflakeAt(Date.now() - 60_000)) + 1n).toString();
    const h = await harness(t, { dmUsers: ['friend'] });
    h.emit('stranger', { id: before });
    await h.settle();
    assert.deepEqual(h.notices, []);
    assert.ok(h.logs.some((l) => /\(live\): sender stranger.*notice before-floor/.test(l)));
  });

  it('reports an interrupted notice found when a repaired state file is reopened by a later refusal', async (t) => {
    const keep = mkdtempSync(join(tmpdir(), 'dm-notice-repair-'));
    t.after(() => rmSync(keep, { recursive: true, force: true }));
    const noticesPath = join(keep, 'dm-notices.json');
    const first = await harness(t, { dmUsers: ['friend'], noticesPath });
    (first.adapter as unknown as Record<string, unknown>).sendDmNotice = () => new Promise(() => {}); // never settles
    first.emit('stranger', { id: freshId(1) });
    await first.decided();
    const pendingFile = readFileSync(noticesPath, 'utf-8');

    writeFileSync(noticesPath, '{ broken');
    const restarted = await harness(t, { dmUsers: ['friend'], noticesPath, notices: 'as-saved' }); // opens broken: suspended
    writeFileSync(noticesPath, pendingFile); // an operator repairs it
    restarted.emit('someone-else', { id: freshId(2) });
    await restarted.settle();
    assert.ok(restarted.logs.some((l) => /DM notice to sender stranger .* was interrupted before its outcome was recorded/.test(l)),
      'reported on the reopen, not only on the first open');
  });

  it('sends nothing when the resident has silenced notices', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'] });
    await h.server.filtersUpdate({ setDmNotice: false });
    h.emit('stranger');
    await h.settle();
    assert.deepEqual(h.notices, []);
    assert.ok(h.logs.some((l) => /notice silenced/.test(l)));
  });

  it('suspends notices when their state cannot be persisted', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'], noticesFile: 'unwritable' });
    h.emit('stranger');
    await h.settle();
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.delivered, []);
    assert.ok(h.logs.some((l) => /notice suspended \(/.test(l)));
  });

  it('records a failed or unknown send honestly and never retries it', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'] });
    h.failNoticesWith(Object.assign(new Error('Cannot send messages to this user'), { status: 403 }));
    h.emit('blocked-us', { id: freshId(1) });
    await h.settle();
    h.failNoticesWith(new Error('socket hang up'));
    h.emit('flaky', { id: freshId(2) });
    await h.settle();
    h.failNoticesWith(Object.assign(new Error('Service Unavailable'), { status: 503 }));
    h.emit('server-error', { id: freshId(5) });
    await h.settle();
    h.failNoticesWith(Object.assign(new Error('You are being rate limited.'), { status: 429 }));
    h.emit('rate-limited-us', { id: freshId(6) });
    await h.settle();
    h.failNoticesWith(null);
    h.emit('blocked-us', { id: freshId(3) });
    h.emit('flaky', { id: freshId(4) });
    await h.settle();
    assert.deepEqual(h.notices, [], 'the window was reserved before each attempt; nothing is retried');
    assert.ok(h.logs.some((l) => /sender blocked-us.*notice failed: Cannot send messages/.test(l)));
    assert.ok(h.logs.some((l) => /sender flaky.*notice unknown: socket hang up/.test(l)));
    assert.ok(h.logs.some((l) => /sender server-error.*notice unknown: Service Unavailable/.test(l)),
      'a 5xx may have posted it, so it is unknown, not failed');
    assert.ok(h.logs.some((l) => /sender rate-limited-us.*notice unknown: You are being rate limited/.test(l)),
      'a 429 is refused before Discord evaluates it, so an earlier attempt may have posted: unknown');
    assert.equal(JSON.parse(readFileSync(h.noticesPath, 'utf-8')).senders['rate-limited-us'].lastNotice.outcome, 'unknown');
  });

  it('records a notice whose channel lookup failed as failed, since nothing was sent', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'], realSend: true });
    t.mock.method(h.client.channels, 'fetch', async () => {
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    });
    h.emit('stranger', { id: freshId(1) });
    await h.settle();
    assert.ok(h.logs.some((l) => /sender stranger.*notice failed: could not look up channel dm-stranger: Service Unavailable/.test(l)),
      'the send never started, whatever the lookup error says');
    assert.equal(JSON.parse(readFileSync(h.noticesPath, 'utf-8')).senders.stranger.lastNotice.outcome, 'failed');
  });

  it('says in the refusal line when a notice went out but its outcome could not be saved', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('needs POSIX permissions as non-root');
    const h = await harness(t, { dmUsers: ['friend'] });
    const stateDir = dirname(h.noticesPath);
    // The state directory stops taking writes while the notice is in flight.
    (h.adapter as unknown as Record<string, unknown>).sendDmNotice = async () => {
      chmodSync(stateDir, 0o500);
      return { messageId: 'notice' };
    };
    h.emit('stranger', { id: freshId(1) });
    try {
      await h.settle();
    } finally {
      chmodSync(stateDir, 0o700);
    }
    assert.ok(h.logs.some((l) => /sender stranger.*notice sent; its outcome was not saved durably \(.*EACCES/.test(l)));
    assert.equal(JSON.parse(readFileSync(h.noticesPath, 'utf-8')).senders.stranger.lastNotice.outcome, 'pending',
      'the file still holds the reservation, which the next start reports as interrupted');
  });

  it('handles refusals before any host has connected', async (t) => {
    const h = await harness(t, { dmUsers: ['friend'], noHost: true });
    h.emit('stranger', { id: freshId(1) });
    await h.settle();
    assert.deepEqual(h.notices, [{ channelId: 'dm-stranger', content: DM_NOTICE_TEXT }]);
    assert.ok(h.logs.some((l) => /\(live\): sender stranger, message \d+; notice sent/.test(l)));
  });

  it('decides the refusals Discord reported before the server handled them, once it does', async (t) => {
    const keep = mkdtempSync(join(tmpdir(), 'dm-notice-early-'));
    t.after(() => rmSync(keep, { recursive: true, force: true }));
    const noticesPath = join(keep, 'dm-notices.json');
    await harness(t, { dmUsers: ['friend'], noticesPath }); // a state with notices on, as a restart finds it
    const early = freshId(1);
    const h = await harness(t, {
      dmUsers: ['friend'], noticesPath, notices: 'as-saved', noHost: true,
      beforeRefusals: (emit) => emit('stranger', { id: early }),
    });
    await h.settle();
    assert.deepEqual(h.notices, [{ channelId: 'dm-stranger', content: DM_NOTICE_TEXT }]);
    assert.ok(h.logs.some((l) => l.includes(`(live): sender stranger, message ${early}; notice sent`)),
      'decided and logged like any other refusal');
  });
});

describe('the reconnect catch-up sweep applies the live ingress decision', () => {
  it('withholds a DM from a sender removed from the DM list, and notifies it once', async (t) => {
    const h = await harness(t, {
      dmUsers: ['still-allowed'],
      watermarks: { 'dm-chan-1': '100' },
      dmChannels: ['dm-chan-1'],
      history: async () => [historyMessage(freshId(1), 'removed-user', 'sent during downtime')],
    });
    await h.server.runReconnectSweep();
    await h.settle();
    assert.deepEqual(h.pushes, [], 'nothing is rendered for the agent');
    assert.deepEqual(h.notices, [{ channelId: 'dm-chan-1', content: DM_NOTICE_TEXT }]);
    assert.ok(h.logs.some((l) => /\(sweep\): sender removed-user/.test(l)));
    assert.ok(!h.logs.some((l) => l.includes('sent during downtime')));
    assert.notEqual(h.server.forwardedWatermark.get('dm-chan-1'), '100', 'the anchor moves past what was withheld');
  });

  it('decides each refused DM before moving its watermark, without waiting for the notice to go out', async (t) => {
    let refusedId = '';
    const h = await harness(t, {
      dmUsers: ['still-allowed'],
      watermarks: { 'dm-chan-1': '100' },
      dmChannels: ['dm-chan-1'],
      history: async () => [historyMessage(refusedId, 'removed-user', 'sent during downtime')],
    });
    refusedId = freshId(1);
    (h.adapter as unknown as Record<string, unknown>).sendDmNotice = () => new Promise(() => {}); // Discord never answers
    // What the notice state's file held for the sender when the watermark moved past the message.
    let heldWhenMoved: { lastHandledId?: string; lastNotice?: { outcome: string } } | undefined;
    const marks = h.server.forwardedWatermark;
    const set = marks.set.bind(marks);
    marks.set = (channelId: string, id: string) => {
      if (channelId === 'dm-chan-1' && id !== '100') {
        heldWhenMoved = JSON.parse(readFileSync(h.noticesPath, 'utf-8')).senders['removed-user'];
      }
      return set(channelId, id);
    };
    await h.server.runReconnectSweep(); // finishes, though the notice never does
    assert.equal(heldWhenMoved?.lastHandledId, refusedId, 'the refusal was recorded before the watermark moved');
    assert.equal(heldWhenMoved?.lastNotice?.outcome, 'pending', 'and its notice reserved');
  });

  it('delivers a batch without waiting for its refusals to be decided, and moves the watermark only once they are', async (t) => {
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'dm-chan-3': '100' },
      dmChannels: ['dm-chan-3'],
      history: async () => [
        historyMessage(freshId(1), 'stranger', 'refused words'),
        historyMessage(freshId(2), 'friend', 'allowed words'),
      ],
    });
    // Hold the refused DM's decision at its directory flush.
    let reached!: () => void;
    let release!: () => void;
    const atFlush = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    type Sync = (handle: unknown, what: string) => Promise<void>;
    const state = (h.server as unknown as { dmNotices: { sync: Sync } }).dmNotices;
    const sync = state.sync;
    state.sync = async (handle, what) => {
      if (what === 'directory') {
        reached();
        await gate;
      }
      return sync(handle, what);
    };
    const sweep = h.server.runReconnectSweep();
    await atFlush;
    // Pushed under the filters read after the fetch, so a filter change made
    // while a refusal is being decided can't reach this batch.
    assert.equal(h.pushes.length, 1, 'delivered while the refusal was still being decided');
    assert.ok(h.pushes[0].payload.content[0].text.includes('allowed words'));
    assert.equal(h.server.forwardedWatermark.get('dm-chan-3'), '100', 'the watermark waits for the decision');
    release();
    await sweep;
    assert.notEqual(h.server.forwardedWatermark.get('dm-chan-3'), '100');
    await h.settle(); // the notice's outcome write finishes before teardown
  });

  it('still delivers DMs from allowed senders in the same channel', async (t) => {
    const h = await harness(t, {
      dmUsers: ['still-allowed'],
      watermarks: { 'dm-chan-1': '100' },
      dmChannels: ['dm-chan-1'],
      history: async () => [
        historyMessage(freshId(1), 'removed-user', 'withheld words'),
        historyMessage(freshId(2), 'still-allowed', 'welcome words'),
      ],
    });
    await h.server.runReconnectSweep();
    assert.equal(h.pushes.length, 1);
    const text = h.pushes[0].payload.content[0].text;
    assert.ok(text.includes('welcome words'));
    assert.ok(!text.includes('withheld words'));
    await h.settle(); // the refused DM's notice finishes before teardown
  });

  it('withholds messages from a channel of a guild removed from the guild filter', async (t) => {
    const h = await harness(t, {
      guildIds: ['kept-guild'],
      watermarks: { 'chan-in-removed-guild': '200' },
      history: async () => [historyMessage(freshId(1), 'someone', '@bot are you there', true)],
      meta: () => ({ name: 'general', guildId: 'removed-guild', guildName: 'Removed Guild', isDM: false }),
    });
    await h.server.runReconnectSweep();
    assert.deepEqual(h.pushes, []);
    assert.deepEqual(h.notices, [], 'guild refusals send no DM notice');
  });

  it('decides with the filters in force after the fetch, not before it', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness(t, {
      dmUsers: ['friend', 'soon-removed'],
      watermarks: { 'dm-chan-2': '100' },
      dmChannels: ['dm-chan-2'],
      history: async () => {
        await gate;
        return [historyMessage(freshId(1), 'soon-removed', 'pending words')];
      },
    });
    const sweep = h.server.runReconnectSweep();
    await h.settle();
    h.adapter.updateFilters({ dmUsers: ['friend'] }); // the contact is removed while the fetch is pending
    release();
    await sweep;
    assert.deepEqual(h.pushes, []);
    await h.settle(); // the refused DM's notice finishes before teardown
  });

  it('with the real metadata helpers, an unresolvable channel is held back, not read as a DM, and says so', async (t) => {
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'gone-chan': '400' },
      history: async () => [historyMessage(freshId(1), 'friend', '@bot ping', true)],
      realMeta: true,
    });
    t.mock.method(h.client.channels, 'fetch', async () => null);
    await h.server.runReconnectSweep();
    assert.deepEqual(h.pushes, []);
    assert.equal(h.server.forwardedWatermark.get('gone-chan'), '400');
    assert.ok(h.logs.some((l) => /Catch-up held back channel gone-chan: neither its guild nor DM identity could be resolved/.test(l)),
      'visible outside the debug log');
  });

  it('with the real metadata helpers, a channel whose lookup fails and that the cache never held is held back, and its log line says so alone', async (t) => {
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'gone-chan': '400' },
      history: async () => [historyMessage(freshId(1), 'friend', '@bot ping', true)],
      realMeta: true,
    });
    t.mock.method(h.client.channels, 'fetch', async () => { throw new Error('Missing Access'); });
    await h.server.runReconnectSweep();
    assert.deepEqual(h.pushes, []);
    assert.equal(h.server.forwardedWatermark.get('gone-chan'), '400');
    assert.ok(h.logs.some((l) => /Catch-up held back channel gone-chan: neither its guild nor DM identity could be resolved \(its lookup failed: Missing Access\), so its missed messages were not delivered/.test(l)),
      h.logs.join('\n'));
    // Nothing went out, so no line says its messages may.
    assert.ok(!h.logs.some((l) => l.includes('may go out')), h.logs.join('\n'));
  });

  it('says outside the debug log when it withholds guild messages the filters refuse', async (t) => {
    const h = await harness(t, {
      guildIds: ['kept-guild'],
      watermarks: { 'chan-in-removed-guild': '200' },
      history: async () => [historyMessage(freshId(1), 'someone', '@bot hello', true)],
      meta: () => ({ name: 'general', guildId: 'removed-guild', guildName: 'Removed Guild', isDM: false }),
    });
    await h.server.runReconnectSweep();
    assert.ok(h.logs.some((l) => /Catch-up withheld 1 missed message\(s\) in channel chan-in-removed-guild: guild-not-allowed/.test(l)));
    assert.ok(!h.logs.some((l) => l.includes('@bot hello')), 'no body in the log');
  });

  it('never delivers a channel whose identity cannot be resolved as if it were a DM', async (t) => {
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'mystery-chan': '300' },
      history: async () => [historyMessage(freshId(1), 'friend', '@bot ping', true)],
      meta: () => null,
    });
    await h.server.runReconnectSweep();
    assert.deepEqual(h.pushes, []);
    assert.equal(h.server.forwardedWatermark.get('mystery-chan'), '300', 'it waits for the next sweep');
  });

  it('a message already handled live is not notified again by the sweep', async (t) => {
    let id = '';
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'dm-stranger': '100' },
      dmChannels: ['dm-stranger'],
      history: async () => [historyMessage(id, 'stranger', 'once')],
    });
    id = freshId(9);
    h.emit('stranger', { id, channelId: 'dm-stranger' });
    await h.settle();
    await h.server.runReconnectSweep();
    await h.settle();
    assert.equal(h.notices.length, 1);
    assert.ok(h.logs.some((l) => /\(sweep\): sender stranger.*notice already-handled/.test(l)));
  });

  /** Hold every flush of the server's notice state until released, the
   *  first one signalling that it was reached. */
  function holdFlushes(h: Awaited<ReturnType<typeof harness>>) {
    let reached!: () => void;
    let release!: () => void;
    const atFlush = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    type Sync = (handle: unknown, what: string) => Promise<void>;
    const state = (h.server as unknown as { dmNotices: { sync: Sync } }).dmNotices;
    const sync = state.sync;
    state.sync = async (handle, what) => {
      reached();
      await gate;
      return sync(handle, what);
    };
    return { atFlush, release };
  }

  it('moves past a channel whose refusals are still being decided once its wait runs out, and says so', async (t) => {
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'dm-chan-4': '100' },
      dmChannels: ['dm-chan-4'],
      history: async () => [historyMessage(freshId(1), 'stranger', 'refused words')],
    });
    (h.server as unknown as { sweepDecisionWaitMs: number }).sweepDecisionWaitMs = 50;
    const disk = holdFlushes(h); // the notice state's disk stops answering
    await h.server.runReconnectSweep(); // finishes, though the decision doesn't
    assert.notEqual(h.server.forwardedWatermark.get('dm-chan-4'), '100', 'the watermark moved on');
    assert.ok(h.logs.some((l) => /Catch-up moved past channel dm-chan-4 with refused DMs still being decided after 0\.05s/.test(l)));
    disk.release();
    await h.settle();
    assert.equal(h.notices.length, 1, 'decided once the disk answers, and its notice goes out then');
  });

  it('keeps a channel\'s watermark when the push to the host fails', async (t) => {
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'dm-chan-5': '100' },
      dmChannels: ['dm-chan-5'],
      history: async () => [historyMessage(freshId(1), 'friend', 'missed words')],
    });
    (h.server.conn as { sendRequest: unknown }).sendRequest = async () => { throw new Error('host went away'); };
    await h.server.runReconnectSweep();
    assert.equal(h.server.forwardedWatermark.get('dm-chan-5'), '100', 'not moved past what never reached the host');
  });

  it('moves a watermark only forward, keeping a newer one the live path set while it waited', async (t) => {
    const h = await harness(t, {
      dmUsers: ['friend'],
      watermarks: { 'dm-chan-6': '100' },
      dmChannels: ['dm-chan-6'],
      history: async () => [historyMessage(freshId(1), 'stranger', 'refused words')],
    });
    const disk = holdFlushes(h);
    const sweep = h.server.runReconnectSweep();
    await disk.atFlush; // the sweep waits for the refusal's decision
    const newer = freshId(50);
    h.emit('friend', { id: newer, channelId: 'dm-chan-6', content: 'live words' });
    for (let i = 0; i < 100 && h.server.forwardedWatermark.get('dm-chan-6') !== newer; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(h.server.forwardedWatermark.get('dm-chan-6'), newer, 'the live path forwarded a newer message');
    disk.release();
    await sweep;
    assert.equal(h.server.forwardedWatermark.get('dm-chan-6'), newer, 'the sweep did not move it back');
    await h.settle();
  });
});

describe('the notice setting', () => {
  it('works without a filters file and survives a restart', async (t) => {
    const prev = process.env.DISCORD_FILTERS_FILE;
    delete process.env.DISCORD_FILTERS_FILE;
    t.after(() => { if (prev !== undefined) process.env.DISCORD_FILTERS_FILE = prev; });
    const keep = mkdtempSync(join(tmpdir(), 'dm-notice-keep-'));
    t.after(() => rmSync(keep, { recursive: true, force: true }));
    const noticesPath = join(keep, 'dm-notices.json');

    const first = await harness(t, { dmUsers: ['friend'], noticesPath, notices: 'as-saved' });
    const shown = await first.server.executeToolCall('filters_get', {}) as { dmNotice: { enabled: boolean; persisted: boolean; path: string } };
    assert.deepEqual([shown.dmNotice.enabled, shown.dmNotice.persisted, shown.dmNotice.path], [false, true, noticesPath],
      'off until the resident turns it on');
    first.emit('stranger');
    await first.settle();
    assert.deepEqual(first.notices, [], 'an upgrade starts no notices');
    assert.ok(first.logs.some((l) => /sender stranger.*notice silenced/.test(l)));
    await assert.rejects(first.server.filtersUpdate({ setDmNotice: true, setDmUsers: ['x'] }), /DISCORD_FILTERS_FILE is not set/);
    assert.equal(JSON.parse(readFileSync(noticesPath, 'utf-8')).enabled, false, 'a refused filter change applies nothing');
    const on = await first.server.filtersUpdate({ setDmNotice: true });
    assert.equal(on.applied.dmNotice, true);
    await assert.rejects(first.server.filtersUpdate({ setDmNotice: 'no' }), /true or false/);
    await assert.rejects(first.server.filtersUpdate({ setDmUsers: ['x'] }), /DISCORD_FILTERS_FILE is not set/,
      'whitelist changes still need the filters file');

    const restarted = await harness(t, { dmUsers: ['friend'], noticesPath, notices: 'as-saved' });
    const again = await restarted.server.executeToolCall('filters_get', {}) as { dmNotice: { enabled: boolean } };
    assert.equal(again.dmNotice.enabled, true, 'the resident\'s choice survives the restart');
    restarted.emit('stranger');
    await restarted.settle();
    assert.equal(restarted.notices.length, 1);
    await restarted.server.filtersUpdate({ setDmNotice: false });
    restarted.emit('another');
    await restarted.settle();
    assert.equal(restarted.notices.length, 1, 'and turning it off again holds');
  });

  it('works alongside whitelist changes when a filters file is configured, without writing to it', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-notice-tool-'));
    const prev = process.env.DISCORD_FILTERS_FILE;
    const path = join(dir, 'filters.json');
    writeFileSync(path, JSON.stringify({ dmUsers: ['friend'] }));
    process.env.DISCORD_FILTERS_FILE = path;
    t.after(() => {
      if (prev === undefined) delete process.env.DISCORD_FILTERS_FILE; else process.env.DISCORD_FILTERS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    });
    const h = await harness(t, { dmUsers: ['friend'] });
    const res = await h.server.filtersUpdate({ setDmNotice: false, setDmUsers: ['friend', 'new-friend'] });
    assert.equal(res.applied.dmNotice, false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), { dmUsers: ['friend', 'new-friend'] });
    assert.equal(JSON.parse(readFileSync(h.noticesPath, 'utf-8')).enabled, false);
  });

  it('applies a whitelist change, and says so, when the notice setting beside it could not be saved', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-notice-tool-'));
    const prev = process.env.DISCORD_FILTERS_FILE;
    const path = join(dir, 'filters.json');
    writeFileSync(path, JSON.stringify({ dmUsers: ['friend'] }));
    process.env.DISCORD_FILTERS_FILE = path;
    t.after(() => {
      if (prev === undefined) delete process.env.DISCORD_FILTERS_FILE; else process.env.DISCORD_FILTERS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    });
    const h = await harness(t, { dmUsers: ['friend'] }); // notices on
    mkdirSync(`${h.noticesPath}.tmp`); // the notice state's next write can't make its temp file
    const res = await h.server.filtersUpdate({ setDmNotice: false, setDmUsers: ['friend', 'new-friend'] }) as unknown as {
      applied: { dmUsers: string[] | null; dmNotice: boolean | null }; notes: string[];
    };
    assert.deepEqual(res.applied.dmUsers, ['friend', 'new-friend'], 'the whitelist change is applied');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')), { dmUsers: ['friend', 'new-friend'] }, 'and written');
    assert.ok(res.notes.some((n) => /^The whitelist change was applied, but the notice setting was not: could not save the DM notice setting/.test(n)),
      res.notes.join('\n'));
    assert.equal(res.applied.dmNotice, true, 'the notice setting is as it was');
    assert.equal(JSON.parse(readFileSync(h.noticesPath, 'utf-8')).enabled, true);
  });
});

describe('adapter surfaces', () => {
  function adapterFixture(t: TestContext, config: ConstructorParameters<typeof DiscordAdapter>[0]) {
    const adapter = new DiscordAdapter(config);
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    return { adapter, client };
  }

  it('reports a refused DM by identity only, and nothing else', (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused', dmUsers: ['friend'] });
    const refusals: DmRefusal[] = [];
    adapter.onDmRefused((ev) => refusals.push(ev));
    adapter.onMessage(() => {});
    const emit = (authorId: string, guildId: string | null) =>
      (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
        id: '12345', channelId: 'chan', guildId, channel: null,
        author: { id: authorId, username: authorId, bot: false },
        content: 'secret', cleanContent: 'secret', type: MessageType.Default,
        attachments: new Collection(), createdAt: new Date(),
        mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
      });
    emit('friend', null);
    emit('anyone', 'g1');
    emit('stranger', null);
    assert.deepEqual(refusals, [{ messageId: '12345', channelId: 'chan', authorId: 'stranger', origin: 'live' }]);
  });

  it('holds refusals heard before a handler is registered, up to a bound, and hands them over in order', (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused', dmUsers: ['friend'] });
    adapter.onMessage(() => {});
    const logs: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    const emit = (id: string) =>
      (client.emit as (event: string, ...args: unknown[]) => boolean)('messageCreate', {
        id, channelId: 'chan', guildId: null, channel: null,
        author: { id: 'stranger', username: 'stranger', bot: false },
        content: 'secret', cleanContent: 'secret', type: MessageType.Default,
        attachments: new Collection(), createdAt: new Date(),
        mentions: { users: new Collection(), roles: new Collection(), repliedUser: null },
      });
    const ids = Array.from({ length: DM_REFUSALS_HELD + 2 }, (_, i) => String(1000 + i));
    for (const id of ids) emit(id);
    const past = logs.filter((l) => l.includes(`before refusals were handled, past the ${DM_REFUSALS_HELD} held until then`));
    assert.equal(past.length, 2, 'each refusal past the bound still leaves its line');
    assert.ok(past[0].includes(`sender stranger, message ${ids[DM_REFUSALS_HELD]}; no notice`));
    assert.ok(!logs.some((l) => l.includes('secret')), 'no body in the log');
    const refusals: DmRefusal[] = [];
    adapter.onDmRefused((ev) => refusals.push(ev));
    assert.deepEqual(refusals.map((r) => r.messageId), ids.slice(0, DM_REFUSALS_HELD), 'the held ones, in order');
    emit('5000');
    assert.equal(refusals.at(-1)?.messageId, '5000', 'later ones go straight to the handler');
    assert.equal(refusals.length, DM_REFUSALS_HELD + 1);
  });

  it('decides history with the live rules, including a thread under an allowed parent', (t) => {
    const { adapter, client } = adapterFixture(t, {
      token: 'unused', dmUsers: ['friend'], guildIds: ['g1'], guildChannels: { g1: ['parent'] },
    });
    (client.channels.cache as unknown as Map<string, unknown>).set('thread1', { id: 'thread1', parentId: 'parent' });
    assert.equal(adapter.historyIngressReason('dm1', null, 'friend'), null);
    assert.equal(adapter.historyIngressReason('dm1', null, 'stranger'), 'dm-user-not-allowed');
    assert.equal(adapter.historyIngressReason('thread1', 'g1', 'someone'), null);
    assert.equal(adapter.historyIngressReason('other', 'g1', 'someone'), 'channel-not-allowed');
    assert.equal(adapter.historyIngressReason('chan', 'g2', 'someone'), 'guild-not-allowed');
  });

  it('sends the notice through discord.js with an enforced nonce and no mentions', async (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused' });
    // A real DMChannel in the cache, and the REST layer captured: this
    // exercises discord.js's own MessagePayload, not a mocked send.
    (client.channels as unknown as { _add(data: unknown): unknown })._add({
      id: 'dm1', type: ChannelType.DM, last_message_id: null,
      recipients: [{ id: 'u1', username: 'u1', discriminator: '0' }],
    });
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    t.mock.method(client.rest, 'post', async (route: string, options: { body: Record<string, unknown> }) => {
      calls.push({ route, body: options.body });
      return {
        id: '1300000000000000001', channel_id: 'dm1', author: { id: '1300000000000000002', username: 'bot', discriminator: '0' },
        content: options.body.content, timestamp: new Date().toISOString(), edited_timestamp: null,
        tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [],
        pinned: false, type: 0,
      };
    });
    assert.deepEqual(await adapter.sendDmNotice('dm1', DM_NOTICE_TEXT, 'dmn123'), { messageId: '1300000000000000001' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, '/channels/dm1/messages');
    assert.equal(calls[0].body.content, DM_NOTICE_TEXT);
    assert.equal(calls[0].body.nonce, 'dmn123');
    assert.equal(calls[0].body.enforce_nonce, true);
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  });

  it('marks a failed channel lookup as never posted, but not a failed send', async (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused' });
    (client.channels as unknown as { _add(data: unknown): unknown })._add({
      id: 'dm1', type: ChannelType.DM, last_message_id: null,
      recipients: [{ id: 'u1', username: 'u1', discriminator: '0' }],
    });
    const unavailable = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
    t.mock.method(client.channels, 'fetch', async (id: string) => {
      if (id === 'lookup-fails') throw unavailable();
      return client.channels.cache.get(id) ?? null;
    });
    const posts = t.mock.method(client.rest, 'post', async () => { throw unavailable(); });
    await assert.rejects(
      adapter.sendDmNotice('lookup-fails', DM_NOTICE_TEXT, 'dmn1'),
      (err: Error & { notPosted?: unknown }) =>
        err.notPosted === true && /could not look up channel lookup-fails: Service Unavailable/.test(err.message),
    );
    assert.equal(posts.mock.callCount(), 0, 'nothing was sent after the failed lookup');
    await assert.rejects(
      adapter.sendDmNotice('dm1', DM_NOTICE_TEXT, 'dmn2'),
      (err: Error & { notPosted?: unknown; status?: unknown }) => err.notPosted === undefined && err.status === 503,
      'a send that failed may still have posted',
    );
  });

  it('marks a lookup that finds no channel, or one it cannot send in, as never posted', async (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused' });
    const answers: unknown[] = [null, { id: 'no-send' }];
    t.mock.method(client.channels, 'fetch', async () => answers.shift());
    const posts = t.mock.method(client.rest, 'post', async () => ({}));
    for (const id of ['gone', 'no-send']) {
      await assert.rejects(
        adapter.sendDmNotice(id, DM_NOTICE_TEXT, 'dmn3'),
        (err: Error & { notPosted?: unknown }) => err.notPosted === true && /not found or not a text channel/.test(err.message),
        id,
      );
    }
    assert.equal(posts.mock.callCount(), 0);
  });

  it('reports channel kind only when it is known', async (t) => {
    const { adapter, client } = adapterFixture(t, { token: 'unused' });
    const answers: unknown[] = [
      null,
      {},
      { isDMBased: () => true },
      { guildId: 'g1', name: 'general', guild: { name: 'Guild' }, isDMBased: () => false },
    ];
    t.mock.method(client.channels, 'fetch', async () => answers.shift());
    assert.equal((await adapter.getChannelMeta('a')).isDM, null, 'unresolvable');
    assert.equal((await adapter.getChannelMeta('b')).isDM, null, 'sparse');
    assert.equal((await adapter.getChannelMeta('c')).isDM, true);
    assert.deepEqual(await adapter.getChannelMeta('d'), { name: 'general', guildId: 'g1', guildName: 'Guild', isDM: false });
  });
});
