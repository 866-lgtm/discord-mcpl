/**
 * latestFrom: reply to or react to the newest message from a named author,
 * resolved once at invocation among the 100 most recent messages, as the
 * exclusive alternative to an explicit messageId.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField, type Client } from 'discord.js';
import { DiscordAdapter, type HistoryMessage } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';

// Every assert.ok here carries a message. Without one, a failing assert.ok on
// Node 20 quotes the failed expression by re-reading this file at the call's
// position, which under tsx is the compiled code's (line 1, a large column);
// that search retries without progress, so a regression hangs the run
// instead of failing it.

const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 8, 0, s));
const msg = (id: string, authorId: string, authorName: string, text: string, s: number, isBot = false): HistoryMessage => ({
  id, authorId, authorName, isBot, content: text, cleanContent: text, attachments: [], mentionsBot: false, timestamp: at(s),
});
const RA = '100000000000000001';
const RA2 = '100000000000000002';
const FABLE_BOT = '100000000000000003';
const LINN = '100000000000000004';

const members = [
  { id: RA, username: 'ra', displayName: 'Ra', isBot: false },
  { id: FABLE_BOT, username: 'fable', displayName: 'Fable', isBot: true },
  { id: LINN, username: 'linn', displayName: 'Linn', isBot: false },
];

function adapterFixture(
  t: TestContext,
  history: HistoryMessage[],
  memberList: typeof members | Error = members,
  unresolved = 0,
) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  const a = adapter as unknown as Record<string, unknown>;
  a.fetchHistory = async () => history;
  a.listChannelMembers = async (channelId: string, opts: { cap?: boolean }) => {
    assert.equal(opts?.cap, false, 'author resolution reads the uncapped member list');
    if (memberList instanceof Error) throw memberList;
    if (channelId === 'p1') {
      // The private thread's parent: no one there manages threads.
      return { channelId: 'p1', channelName: 'general', scope: 'guild-channel', total: 0, members: [], truncated: false };
    }
    return {
      channelId: 'c1', channelName: 'general', scope: unresolved ? 'thread-joined' : 'guild-channel',
      total: memberList.length, members: memberList, truncated: false, ...(unresolved ? { unresolved } : {}),
    };
  };
  // The thread-joined listing above stands for a private thread (no parent lookup).
  (client.channels as unknown as { fetch: unknown }).fetch = async () =>
    ({ isThread: () => true, type: ChannelType.PrivateThread, parentId: 'p1' });
  return { adapter, client };
}

describe('resolveLatestFrom', () => {
  const history = [
    msg('200000000000000010', RA, 'Ra', 'older from Ra', 1),
    msg('200000000000000020', LINN, 'Linn', 'Linn speaks', 2),
    msg('200000000000000030', RA, 'Ra', 'newest from Ra', 3),
    msg('200000000000000040', FABLE_BOT, 'Fable', 'a bot resident speaks', 4, true),
  ];

  it('picks the newest message by a numeric id, a mention, a username or a display name', async (t) => {
    const { adapter } = adapterFixture(t, history);
    for (const ref of [RA, `<@${RA}>`, '@ra', 'Ra', ' ra ']) {
      const r = await adapter.resolveLatestFrom('c1', ref);
      assert.equal(r.ok, true, ref);
      if (r.ok) {
        assert.equal(r.message.id, '200000000000000030', ref);
        assert.equal(r.authorId, RA);
      }
    }
  });

  it('resolves bot residents as well as people', async (t) => {
    const { adapter } = adapterFixture(t, history);
    const r = await adapter.resolveLatestFrom('c1', 'Fable');
    assert.ok(r.ok && r.message.id === '200000000000000040', JSON.stringify(r));
  });

  it('refuses a name two people share, with choices, even if only one of them spoke recently', async (t) => {
    const { adapter } = adapterFixture(t, history, [...members, { id: RA2, username: 'ra_two', displayName: 'Ra', isBot: false }]);
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /^"Ra" matches 2 people here: /);
      assert.ok(r.message.includes(`Ra (@ra) = ${RA}`), r.message);
      assert.ok(r.message.includes(`Ra (@ra_two) = ${RA2}`), r.message);
      assert.match(r.message, /nothing was done\.$/);
    }
  });

  it('refuses when the author has no message in the window, naming the window', async (t) => {
    const { adapter } = adapterFixture(t, history, [...members, { id: RA2, username: 'quiet', displayName: 'Quiet', isBot: false }]);
    const r = await adapter.resolveLatestFrom('c1', 'Quiet');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /^No message from Quiet among the 4 most recent messages here \(2026-10-07T08:00:01.000Z to 2026-10-07T08:00:04.000Z\); nothing was done\./);
      assert.match(r.message, /never reaches further back or picks another author/);
    }
    const nobody = await adapter.resolveLatestFrom('c1', 'Nobody');
    assert.ok(!nobody.ok && /No one named "Nobody"/.test(nobody.message), JSON.stringify(nobody));
  });

  it('refuses a name it cannot check for collisions when the member list fails, but still takes an id', async (t) => {
    // Two people named Ra; only one spoke recently. Without the member list,
    // the recent one would look unique.
    const { adapter } = adapterFixture(t, history, new Error('Guild member cache warm-up failed'));
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.message, '"Ra" can\'t be checked for people sharing that name: this channel\'s member list is unavailable (Guild member cache warm-up failed). Use their numeric user id; nothing was done.');
    }
    const byId = await adapter.resolveLatestFrom('c1', RA);
    assert.ok(byId.ok && byId.message.id === '200000000000000030', JSON.stringify(byId));
  });

  it('refuses a name when some members are listed by id only (a thread after a failed warm-up)', async (t) => {
    const idOnly = { id: RA2, username: RA2, displayName: RA2, isBot: false };
    const { adapter } = adapterFixture(t, history, [...members, idOnly], 1);
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /1 member\(s\) here couldn't be resolved to names\. Use their numeric user id; nothing was done\.$/);
    const byId = await adapter.resolveLatestFrom('c1', `<@${RA}>`);
    assert.ok(byId.ok && byId.message.id === '200000000000000030', JSON.stringify(byId));
  });

  it('checks a thread\'s name against its other readers: all parent viewers (public), thread managers (private)', async (t) => {
    const THREAD = '300000000000000001';
    const PARENT = '300000000000000002';
    // Joined: the Ra who spoke. Parent viewers: another Ra who never joined,
    // who can manage threads in the parent or not.
    for (const [type, readerManages, expectRefusal] of [
      [ChannelType.PublicThread, false, true],
      [ChannelType.PrivateThread, true, true],
      [ChannelType.PrivateThread, false, false],
    ] as const) {
      const adapter = new DiscordAdapter({ token: 'unused' });
      const client = (adapter as unknown as { client: Client }).client;
      t.after(() => client.destroy());
      const a = adapter as unknown as Record<string, unknown>;
      a.fetchHistory = async () => history;
      const reader = { id: RA2, username: 'ra_reader', displayName: 'Ra', isBot: false };
      a.listChannelMembers = async (id: string, opts: { withPermission?: bigint }) => {
        if (id === THREAD) {
          return { channelId: THREAD, channelName: 'thread', scope: 'thread-joined', total: 1, members: [members[0]], truncated: false };
        }
        assert.equal(opts.withPermission, type === ChannelType.PrivateThread ? PermissionsBitField.Flags.ManageThreads : undefined);
        const viewers = opts.withPermission === undefined || readerManages ? [members[0], reader] : [];
        return { channelId: PARENT, channelName: 'general', scope: 'guild-channel', total: viewers.length, members: viewers, truncated: false };
      };
      (client.channels as unknown as { fetch: unknown }).fetch = async () => ({ isThread: () => true, type, parentId: PARENT });
      const r = await adapter.resolveLatestFrom(THREAD, 'Ra');
      const label = `${type === ChannelType.PublicThread ? 'public' : 'private'} thread, reader manages threads: ${readerManages}`;
      if (expectRefusal) {
        assert.ok(!r.ok && /^"Ra" matches 2 people here: /.test(r.message), `${label}: ${JSON.stringify(r)}`);
      } else {
        assert.ok(r.ok && r.authorId === RA, `${label}: ${JSON.stringify(r)}`);
      }
    }
  });

  it('refuses a channel outside the configured channel filters before reading it, by id or by name', async (t) => {
    const ALLOWED = '500000000000000001';
    const EXCLUDED = '500000000000000002';
    const THREAD_IN_ALLOWED = '500000000000000004';
    const THREAD_IN_EXCLUDED = '500000000000000005';
    const DM = '500000000000000006';
    const adapter = new DiscordAdapter({ token: 'unused', guildChannels: { g1: [ALLOWED] } });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    const channels: Record<string, Record<string, unknown>> = {
      [ALLOWED]: { id: ALLOWED, type: ChannelType.GuildText, guildId: 'g1', parentId: null },
      [EXCLUDED]: { id: EXCLUDED, type: ChannelType.GuildText, guildId: 'g1', parentId: null },
      [THREAD_IN_ALLOWED]: { id: THREAD_IN_ALLOWED, type: ChannelType.PublicThread, guildId: 'g1', parentId: ALLOWED },
      [THREAD_IN_EXCLUDED]: { id: THREAD_IN_EXCLUDED, type: ChannelType.PublicThread, guildId: 'g1', parentId: EXCLUDED },
      [DM]: { id: DM, type: ChannelType.DM },
    };
    (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => channels[id] ?? null;
    const reads: string[] = [];
    const a = adapter as unknown as Record<string, unknown>;
    a.fetchHistory = async (id: string) => { reads.push(id); return history; };
    a.listChannelMembers = async (id: string) => {
      reads.push(`members of ${id}`);
      return { channelId: id, channelName: 'general', scope: 'guild-channel', total: members.length, members, truncated: false };
    };
    for (const id of [EXCLUDED, THREAD_IN_EXCLUDED]) {
      for (const ref of [RA, 'Ra']) {
        const r = await adapter.resolveLatestFrom(id, ref);
        assert.ok(!r.ok, `${id} by ${ref}`);
        if (!r.ok) {
          assert.equal(r.message, `Channel ${id} is outside this residence's configured channel filters, which bound reading as well as delivery, so latestFrom can't choose a message there; nothing was done.`);
        }
      }
    }
    assert.deepEqual(reads, [], 'no history or members of a filtered-out channel are read');
    for (const id of [ALLOWED, THREAD_IN_ALLOWED, DM]) {
      const r = await adapter.resolveLatestFrom(id, RA);
      assert.ok(r.ok && r.message.id === '200000000000000030', id);
    }
    assert.deepEqual(reads, [ALLOWED, THREAD_IN_ALLOWED, DM]);
  });

  it('checks a private thread past one page of members through the real listings, warming the member cache once', async (t) => {
    const THREAD = '300000000000000011';
    const PARENT = '300000000000000012';
    const MOD = '100000000000000009';
    const NAMESAKE = '900000000000000002';
    const fixture = (namesake: boolean, warmSucceeds = true) => {
      const adapter = new DiscordAdapter({ token: 'unused' });
      const client = (adapter as unknown as { client: Client }).client;
      t.after(() => client.destroy());
      const member = (id: string, username: string, displayName: string) => ({ id, displayName, user: { username, bot: false } });
      // 248 others sort after Ra by id and before "Ra" by display name, so a
      // namesake who joined is beyond Discord's 100-member page and beyond
      // the listing tool's 200 cap.
      const others = Array.from({ length: 248 }, (_, i) =>
        member(String(400000000000000000n + BigInt(i)), `member${i}`, `Member ${String(i).padStart(3, '0')}`));
      const joined = [member(RA, 'ra', 'Ra'), ...others, ...(namesake ? [member(NAMESAKE, 'ra_two', 'Ra')] : [])];
      const guild = { id: 'g1', name: 'Guild', members: { cache: new Map([...joined, member(MOD, 'mod', 'Mod')].map((m) => [m.id, m])) } };
      const joinedIds = joined.map((m) => m.id).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
      const thread = {
        id: THREAD, name: 'plans', type: ChannelType.PrivateThread, guild, guildId: 'g1', parentId: PARENT, isThread: () => true,
        members: {
          // List Thread Members as discord.js 14 documents it on API v10:
          // without withMember, every member at once; with it, pages of at
          // most 100 after `after`.
          async fetch(options?: { withMember?: boolean; after?: string; limit?: number }) {
            let ids = joinedIds;
            if (options?.withMember) {
              const start = options.after ? ids.findIndex((id) => BigInt(id) > BigInt(options.after!)) : 0;
              ids = start < 0 ? [] : ids.slice(start, start + Math.min(options.limit ?? 100, 100));
            }
            return new Map(ids.map((id) => [id, { id }]));
          },
        },
      };
      // Everyone can view the parent; only the moderator manages threads there.
      const parent = {
        id: PARENT, name: 'general', type: ChannelType.GuildText, guild, guildId: 'g1', parentId: null, isThread: () => false,
        members: guild.members.cache,
        permissionsFor: (m: { id: string }) => ({ has: (p: bigint) => p === PermissionsBitField.Flags.ManageThreads && m.id === MOD }),
      };
      (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => (id === THREAD ? thread : id === PARENT ? parent : null);
      let warmups = 0;
      const a = adapter as unknown as Record<string, unknown>;
      a.warmGuildMemberCache = async () => { warmups++; return warmSucceeds; };
      a.fetchHistory = async () => [msg('200000000000000030', RA, 'ra', 'newest from Ra', 3)];
      return { adapter, warmups: () => warmups };
    };

    const collision = fixture(true);
    const refused = await collision.adapter.resolveLatestFrom(THREAD, 'Ra');
    assert.ok(!refused.ok && /^"Ra" matches 2 people here: /.test(refused.message), JSON.stringify(refused));
    assert.ok(!refused.ok && refused.message.includes(`Ra (@ra_two) = ${NAMESAKE}`), JSON.stringify(refused));
    assert.equal(collision.warmups(), 1, 'the thread and its parent share one member-cache warm-up');

    const unique = fixture(false);
    const chosen = await unique.adapter.resolveLatestFrom(THREAD, 'Ra');
    assert.ok(chosen.ok && chosen.authorId === RA && chosen.message.id === '200000000000000030', JSON.stringify(chosen));
    assert.equal(unique.warmups(), 1);

    const cold = fixture(false, false);
    const unchecked = await cold.adapter.resolveLatestFrom(THREAD, 'Ra');
    assert.ok(!unchecked.ok && /member list is unavailable \(Guild member cache warm-up failed/.test(unchecked.message), JSON.stringify(unchecked));
    assert.equal(cold.warmups(), 1, 'a failed warm-up is not waited out a second time');
  });

  it('narrows a guild channel\'s viewers to those holding a permission when asked', async (t) => {
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    const member = (id: string, username: string) => ({ id, displayName: username, user: { username, bot: false } });
    const viewers = new Map([[RA, member(RA, 'ra')], [RA2, member(RA2, 'moderator')]]);
    const parent = {
      id: 'p1', name: 'general', type: ChannelType.GuildText, parentId: null, isThread: () => false,
      guild: { id: 'g1' }, members: viewers,
      permissionsFor: (m: { id: string }) => ({ has: (p: bigint) => p === PermissionsBitField.Flags.ManageThreads && m.id === RA2 }),
    };
    (client.channels as unknown as { fetch: unknown }).fetch = async () => parent;
    (adapter as unknown as Record<string, unknown>).warmGuildMemberCache = async () => true;
    const all = await adapter.listChannelMembers('p1', { cap: false });
    assert.deepEqual(all.members.map((m) => m.id).sort(), [RA, RA2]);
    const managers = await adapter.listChannelMembers('p1', { cap: false, withPermission: PermissionsBitField.Flags.ManageThreads });
    assert.deepEqual(managers.members.map((m) => m.id), [RA2]);
  });

  it('recognizes id-only members by their shape even when the list gives no count', async (t) => {
    // Wren's probe: both Ra identities came back id-only from a thread listing.
    const idOnly = [RA, RA2].map((id) => ({ id, username: id, displayName: id, isBot: false }));
    const { adapter } = adapterFixture(t, history, idOnly);
    const r = await adapter.resolveLatestFrom('c1', 'Ra');
    assert.ok(!r.ok && /2 member\(s\) here couldn't be resolved to names/.test(r.message), JSON.stringify(r));
  });

  it('sends every reply with fail_if_not_exists, discord.js\'s default, so a reply to a message that\'s gone fails rather than posting unthreaded', async (t) => {
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    // A logged-out client has no user; the DM channel's recipient getter needs one.
    (client as unknown as { user: unknown }).user = { id: '1300000000000000002' };
    (client.channels as unknown as { _add(data: unknown): unknown })._add({
      id: 'dm1', type: ChannelType.DM, last_message_id: null,
      recipients: [{ id: 'u1', username: 'u1', discriminator: '0' }],
    });
    const bodies: Array<Record<string, unknown>> = [];
    t.mock.method(client.rest, 'post', async (_route: string, options: { body: Record<string, unknown> }) => {
      bodies.push(options.body);
      return {
        id: '1300000000000000001', channel_id: 'dm1', author: { id: '1300000000000000002', username: 'bot', discriminator: '0' },
        content: options.body.content, timestamp: new Date().toISOString(), edited_timestamp: null, tts: false,
        mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0,
      };
    });
    // A reply by exact id and one to a latestFrom selection reach the adapter the same way.
    await adapter.sendMessage('dm1', 'by id', { replyTo: '1200000000000000001' });
    await adapter.sendMessage('dm1', 'by latestFrom', { replyTo: '1200000000000000002' });
    assert.equal(bodies.length, 2);
    for (const [i, id] of ['1200000000000000001', '1200000000000000002'].entries()) {
      const reference = bodies[i].message_reference as Record<string, unknown>;
      assert.equal(reference.message_id, id);
      assert.equal(reference.fail_if_not_exists, true, `send ${i + 1} carries discord.js's default`);
    }
  });
});

describe('reply and reaction tools', () => {
  function serverFixture() {
    let history = [msg('200000000000000030', RA, 'Ra', 'the message Ra just sent, which is long enough that the receipt only echoes a short part of it to the resident', 3)];
    const calls: Array<{ op: string; channelId: string; messageId?: string; options?: Record<string, unknown> }> = [];
    let gone = false;
    const adapter = {
      botUserId: 'bot',
      resolveChannelRef: (given: string) => ({ ok: true, id: given }),
      async resolveLatestFrom(channelId: string, ref: string) {
        const real = new DiscordAdapter({ token: 'unused' }) as unknown as Record<string, unknown>;
        ((real as unknown as { client: Client }).client.channels as unknown as { fetch: unknown }).fetch = async () =>
          ({ id: channelId, type: ChannelType.GuildText, guildId: 'g1', parentId: null, isThread: () => false });
        real.fetchHistory = async () => history;
        real.listChannelMembers = async () => ({ channelId, channelName: 'general', scope: 'guild-channel', total: 1, members, truncated: false });
        try {
          return await (real as unknown as DiscordAdapter).resolveLatestFrom(channelId, ref);
        } finally {
          ((real as unknown as { client: Client }).client).destroy();
        }
      },
      async sendMessage(channelId: string, _content: string, options: Record<string, unknown>) {
        calls.push({ op: 'send', channelId, options });
        return { messageId: '300000000000000001' };
      },
      async addReaction(channelId: string, messageId: string) {
        if (gone) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
        calls.push({ op: 'react', channelId, messageId });
      },
      async removeReaction(channelId: string, messageId: string) {
        calls.push({ op: 'unreact', channelId, messageId });
      },
    };
    const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };
    return {
      server, calls,
      setHistory: (h: HistoryMessage[]) => { history = h; },
      deleteTarget: () => { gone = true; },
      call: async (name: string, args: Record<string, unknown>) => server.handleToolCall(name, { channelId: '1234567890123456789', ...args }),
    };
  }

  it('advertises messageId and latestFrom as nullable, exclusive, and neither required', () => {
    for (const name of ['reply_message', 'add_reaction', 'remove_reaction']) {
      const tool = toolDefinitions.find((d) => d.name === name)!;
      const schema = tool.inputSchema as { properties: Record<string, { type: unknown; description: string }>; required: string[] };
      for (const key of ['messageId', 'latestFrom']) {
        assert.deepEqual(schema.properties[key].type, ['string', 'null'], `${name}.${key}`);
        assert.match(schema.properties[key].description, /^Give exactly one of messageId or latestFrom; the other may be omitted or null\./);
        assert.ok(!schema.required.includes(key), `${name} doesn't require ${key}`);
      }
      assert.ok(schema.required.includes('channelId'), `${name} requires channelId`);
    }
  });

  it('keeps sparse exact-id calls working', async () => {
    const f = serverFixture();
    const res = await f.call('add_reaction', { messageId: '200000000000000099', emoji: '👍' });
    assert.ok(!res.isError, res.content[0].text);
    assert.equal(res.content[0].text, 'Reaction added');
    assert.deepEqual(f.calls, [{ op: 'react', channelId: '1234567890123456789', messageId: '200000000000000099' }]);
  });

  it('accepts all-properties calls with the unused selector null, either way round', async () => {
    const f = serverFixture();
    const byId = await f.call('add_reaction', { messageId: '200000000000000099', latestFrom: null, emoji: '👍' });
    assert.ok(!byId.isError, byId.content[0].text);
    const byName = await f.call('remove_reaction', { messageId: null, latestFrom: 'Ra', emoji: '👍' });
    assert.ok(!byName.isError, byName.content[0].text);
    assert.deepEqual(f.calls.map((c) => c.messageId), ['200000000000000099', '200000000000000030']);
  });

  it('refuses two selectors, no selector, and a non-string selector, doing nothing', async () => {
    const f = serverFixture();
    const both = await f.call('reply_message', { messageId: '200000000000000099', latestFrom: 'Ra', content: 'x' });
    assert.ok(both.isError && /Give messageId or latestFrom, not both; nothing was done\./.test(both.content[0].text), both.content[0].text);
    const neither = await f.call('add_reaction', { messageId: null, latestFrom: null, emoji: '👍' });
    assert.ok(neither.isError && /Give exactly one of messageId or latestFrom/.test(neither.content[0].text), neither.content[0].text);
    // A string is a selector given, blank included.
    const blankId = await f.call('add_reaction', { messageId: '  ', latestFrom: null, emoji: '👍' });
    assert.ok(blankId.isError && /messageId is blank, so it names no message; nothing was done\./.test(blankId.content[0].text), blankId.content[0].text);
    const blankBeside = await f.call('add_reaction', { messageId: '', latestFrom: 'Ra', emoji: '👍' });
    assert.ok(blankBeside.isError && /not both/.test(blankBeside.content[0].text), blankBeside.content[0].text);
    const wrong = await f.call('add_reaction', { latestFrom: 42, emoji: '👍' });
    assert.ok(wrong.isError && /latestFrom must be a string or null/.test(wrong.content[0].text), wrong.content[0].text);
    assert.deepEqual(f.calls, []);
  });

  it('replies to the resolved target, requires it to exist, and echoes it', async () => {
    const f = serverFixture();
    const res = await f.call('reply_message', { latestFrom: 'Ra', content: 'answering you' });
    assert.ok(!res.isError, res.content[0].text);
    assert.deepEqual(f.calls[0].options, { replyTo: '200000000000000030', files: undefined });
    const receipt = JSON.parse(res.content[0].text);
    assert.equal(receipt.messageId, '300000000000000001');
    assert.equal(receipt.target.messageId, '200000000000000030');
    assert.deepEqual(receipt.target.author, { id: RA, name: 'Ra' });
    assert.equal(receipt.target.discordChannelId, '1234567890123456789');
    assert.equal(receipt.target.channelId, undefined, 'channelId is reserved for the canonical form');
    assert.equal(receipt.target.timestamp, '2026-10-07T08:00:03.000Z');
    const sent = 'the message Ra just sent, which is long enough that the receipt only echoes a short part of it to the resident';
    assert.equal(receipt.target.excerpt, `${sent.slice(0, 79)}…`, '80 characters, the ellipsis included');
    assert.match(receipt.target.selectedBy, /not a claim about what you have seen/);
  });

  it('acts on the message chosen at selection, even if newer traffic arrives before the action', async () => {
    const f = serverFixture();
    const adapter = (f.server as unknown as { discord: Record<string, unknown> }).discord;
    const realAdd = adapter.addReaction as (c: string, m: string) => Promise<void>;
    adapter.addReaction = async (c: string, m: string) => {
      f.setHistory([msg('200000000000000050', RA, 'Ra', 'even newer', 5)]); // arrives after selection
      return realAdd(c, m);
    };
    await f.call('add_reaction', { latestFrom: 'Ra', emoji: '👍' });
    assert.equal(f.calls[0].messageId, '200000000000000030');
  });

  it('fails explicitly when the chosen target is deleted before the action', async () => {
    const f = serverFixture();
    f.deleteTarget();
    const res = await f.call('add_reaction', { latestFrom: 'Ra', emoji: '👍' });
    assert.ok(res.isError, res.content[0].text);
    assert.match(res.content[0].text, /Unknown Message/);
  });

  it('refuses latestFrom in a channel outside the filters, for every tool, without reading it or acting', async (t) => {
    const EXCLUDED = '500000000000000002';
    const adapter = new DiscordAdapter({ token: 'unused', guildChannels: { g1: ['500000000000000001'] } });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    (client.channels as unknown as { fetch: unknown }).fetch = async () =>
      ({ id: EXCLUDED, type: ChannelType.GuildText, guildId: 'g1', parentId: null });
    const touched: string[] = [];
    const a = adapter as unknown as Record<string, unknown>;
    a.fetchHistory = async () => {
      touched.push('fetchHistory');
      return [msg('200000000000000030', RA, 'Ra', 'secret words from an excluded channel', 3)];
    };
    for (const op of ['sendMessage', 'addReaction', 'removeReaction']) {
      a[op] = async () => { touched.push(op); return { messageId: '300000000000000001' }; };
    }
    const server = new DiscordMcplServer(adapter) as unknown as {
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };
    for (const [name, extra] of [['reply_message', { content: 'x' }], ['add_reaction', { emoji: '👍' }], ['remove_reaction', { emoji: '👍' }]] as const) {
      for (const latestFrom of [RA, 'Ra']) {
        const res = await server.handleToolCall(name, { channelId: EXCLUDED, latestFrom, ...extra });
        assert.ok(res.isError, `${name} by ${latestFrom}`);
        assert.match(res.content[0].text, /is outside this residence's configured channel filters/);
        assert.ok(!res.content[0].text.includes('secret words'), 'no excerpt of what is there');
      }
    }
    assert.deepEqual(touched, []);
  });

  it('refuses a latestFrom with no match without acting', async () => {
    const f = serverFixture();
    const res = await f.call('reply_message', { latestFrom: 'Linn', content: 'x' });
    assert.ok(res.isError && /No message from Linn among the 1 most recent messages here/.test(res.content[0].text), res.content[0].text);
    assert.deepEqual(f.calls, []);
  });
});

// ── The second review's cases (sw-dm64) ────────────────────────────────────

/** A discord.js message as fetchHistory reads it, shaped just enough. */
function wireMessage(o: {
  id: string; authorId: string; username: string; displayName: string; member?: string;
  text: string; s: number; system?: boolean; bot?: boolean;
}) {
  return {
    id: o.id,
    author: { id: o.authorId, username: o.username, displayName: o.displayName, bot: o.bot ?? false },
    member: o.member ? { displayName: o.member } : null,
    system: o.system ?? false,
    type: o.system ? 6 : 0,
    content: o.text, cleanContent: o.text, messageSnapshots: null,
    attachments: new Map(), reactions: { cache: new Map() }, createdAt: at(o.s),
  };
}

describe('latestFrom after the second review', () => {
  /** A real adapter over one guild text channel whose history and member list are given. */
  function realFixture(
    t: TestContext,
    wire: ReturnType<typeof wireMessage>[],
    memberList: typeof members = members,
    config: Record<string, unknown> = {},
    channel: Record<string, unknown> = { id: 'c1', type: ChannelType.GuildText, guildId: 'g1', parentId: null, isThread: () => false },
  ) {
    const adapter = new DiscordAdapter({ token: 'unused', ...config });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    const historyOptions: unknown[] = [];
    const fetched: string[] = [];
    const withMessages = {
      ...channel,
      messages: {
        async fetch(options: unknown) {
          historyOptions.push(options);
          return new Map(wire.map((m) => [m.id, m]));
        },
      },
    };
    (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => { fetched.push(id); return withMessages; };
    const a = adapter as unknown as Record<string, unknown>;
    const listings: string[] = [];
    a.listChannelMembers = async (id: string) => {
      listings.push(id);
      return { channelId: id, channelName: 'general', scope: 'guild-channel', total: memberList.length, members: memberList, truncated: false };
    };
    return { adapter, client, historyOptions, fetched, listings };
  }

  it('fetches a window of 100 through fetchHistory (I9)', async (t) => {
    const f = realFixture(t, [wireMessage({ id: '200000000000000030', authorId: RA, username: 'ra', displayName: 'Ra', text: 'hello', s: 3 })]);
    const r = await f.adapter.resolveLatestFrom('c1', RA);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(f.historyOptions, [{ limit: 100 }], 'one page of the 100 most recent');
  });

  it('keeps each author\'s display name in the window, matches on it, and names the author by it on every path (I1)', async (t) => {
    // Ari left the server: no member, only the account's global display name.
    const ARI = '100000000000000007';
    const wire = [
      wireMessage({ id: '200000000000000020', authorId: ARI, username: 'ari_99', displayName: 'Ari', text: 'from Ari', s: 2 }),
      wireMessage({ id: '200000000000000030', authorId: RA, username: 'ra', displayName: 'Raymond', member: 'Ra', text: 'from Ra', s: 3 }),
    ];
    const f = realFixture(t, wire);
    const history = await f.adapter.fetchHistory('c1', { limit: 100 });
    assert.deepEqual(history.map((m) => [m.authorName, m.authorDisplayName]), [['ra', 'Ra'], ['ari_99', 'Ari']],
      'the member\'s display name, else the account\'s');
    const byDisplay = await f.adapter.resolveLatestFrom('c1', 'Ari');
    assert.ok(byDisplay.ok && byDisplay.authorId === ARI && byDisplay.authorLabel === 'Ari', JSON.stringify(byDisplay));
    const byUsername = await f.adapter.resolveLatestFrom('c1', '@ari_99');
    assert.ok(byUsername.ok && byUsername.authorLabel === 'Ari', JSON.stringify(byUsername));
    const byId = await f.adapter.resolveLatestFrom('c1', ARI);
    assert.ok(byId.ok && byId.authorLabel === 'Ari', `an id names the author by display name too: ${JSON.stringify(byId)}`);
    // A current member who shares the departed author's display name is a collision.
    const g = realFixture(t, wire, [...members, { id: RA2, username: 'ari_two', displayName: 'Ari', isBot: false }]);
    const both = await g.adapter.resolveLatestFrom('c1', 'Ari');
    assert.ok(!both.ok && /^"Ari" matches 2 people here: /.test(both.message) && both.message.includes(`Ari (@ari_99) = ${ARI}`), JSON.stringify(both));
  });

  it('never chooses a system notice as someone\'s latest message (I3)', async (t) => {
    const wire = [
      wireMessage({ id: '200000000000000010', authorId: RA, username: 'ra', displayName: 'Ra', text: 'what Ra wrote', s: 1 }),
      // Ra pinned a message afterwards: a system notice authored by Ra.
      wireMessage({ id: '200000000000000020', authorId: RA, username: 'ra', displayName: 'Ra', text: '', s: 2, system: true }),
    ];
    const f = realFixture(t, wire);
    const history = await f.adapter.fetchHistory('c1', { limit: 100 });
    assert.equal(history.find((m) => m.id === '200000000000000020')?.system, true, 'the window marks the notice');
    assert.equal(history.find((m) => m.id === '200000000000000010')?.system, undefined);
    for (const ref of ['Ra', RA]) {
      const r = await f.adapter.resolveLatestFrom('c1', ref);
      assert.ok(r.ok && r.message.id === '200000000000000010', `${ref}: ${JSON.stringify(r)}`);
    }
  });

  it('reads @ followed by an id as that id (I18)', async (t) => {
    const f = realFixture(t, [wireMessage({ id: '200000000000000030', authorId: RA, username: 'ra', displayName: 'Ra', text: 'hi', s: 3 })], []);
    const r = await f.adapter.resolveLatestFrom('c1', `@${RA}`);
    assert.ok(r.ok && r.authorId === RA, JSON.stringify(r));
    assert.deepEqual(f.listings, [], 'an id needs no member list');
  });

  it('refuses a latestFrom naming no one before fetching the channel (I14)', async (t) => {
    const f = realFixture(t, []);
    for (const ref of ['@', '@  ', '  ']) {
      const r = await f.adapter.resolveLatestFrom('c1', ref);
      assert.ok(!r.ok && r.message === 'latestFrom names no one; nothing was done.', `${JSON.stringify(ref)}: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(f.fetched, [], 'nothing was fetched');
  });

  it('says an empty channel has nothing to choose from in a sentence of its own (I20)', async (t) => {
    const f = realFixture(t, []);
    for (const ref of [RA, 'Ra']) {
      const r = await f.adapter.resolveLatestFrom('c1', ref);
      assert.ok(!r.ok && r.message === 'This channel has no messages, so latestFrom has nothing to choose from; nothing was done.', JSON.stringify(r));
    }
    assert.deepEqual(f.listings, [], 'no member list is read for an empty channel');
  });

  it('applies the guild filter and, in a DM, the DM user filter, before any read (I6)', async (t) => {
    const wire = [wireMessage({ id: '200000000000000030', authorId: RA, username: 'ra', displayName: 'Ra', text: 'hi', s: 3 })];
    const otherGuild = realFixture(t, wire, members, { guildIds: ['g9'] });
    for (const ref of [RA, 'Ra']) {
      const r = await otherGuild.adapter.resolveLatestFrom('c1', ref);
      assert.ok(!r.ok && r.message === 'Channel c1 is in a server outside this residence\'s configured guild filter, which bounds reading as well as delivery, so latestFrom can\'t choose a message there; nothing was done.', JSON.stringify(r));
    }
    assert.deepEqual([otherGuild.historyOptions, otherGuild.listings], [[], []], 'nothing read in a guild outside the filter');
    const listedGuild = realFixture(t, wire, members, { guildIds: ['g1'] });
    assert.ok((await listedGuild.adapter.resolveLatestFrom('c1', 'Ra')).ok, 'a listed guild resolves');

    const dm = { id: 'd1', type: ChannelType.DM, recipientId: RA, isThread: () => false };
    const stranger = realFixture(t, wire, members, { dmUsers: [LINN] }, dm);
    for (const ref of [RA, 'Ra']) {
      const r = await stranger.adapter.resolveLatestFrom('d1', ref);
      assert.ok(!r.ok && r.message === 'This DM is with someone outside this residence\'s configured DM users, which bound reading as well as delivery, so latestFrom can\'t choose a message there; nothing was done.', JSON.stringify(r));
    }
    assert.deepEqual([stranger.historyOptions, stranger.listings], [[], []], 'nothing read in a DM outside the filter');
    const allowed = realFixture(t, wire, members, { dmUsers: [RA] }, dm);
    assert.ok((await allowed.adapter.resolveLatestFrom('d1', RA)).ok, 'an allowed DM resolves');
  });

  it('checks the filters again after its reads, refusing if they changed meanwhile (I10)', async (t) => {
    const wire = [wireMessage({ id: '200000000000000030', authorId: RA, username: 'ra', displayName: 'Ra', text: 'hi', s: 3 })];
    const f = realFixture(t, wire);
    const a = f.adapter as unknown as Record<string, unknown>;
    // A slow member download, during which the channel filters exclude this channel.
    a.listChannelMembers = async (id: string) => {
      f.adapter.updateFilters({ guildChannels: { g1: ["c2"] } });
      return { channelId: id, channelName: 'general', scope: 'guild-channel', total: members.length, members, truncated: false };
    };
    const r = await f.adapter.resolveLatestFrom('c1', 'Ra');
    assert.ok(!r.ok && /is outside this residence's configured channel filters/.test(r.message), JSON.stringify(r));
  });
});

describe('latestFrom through the real listings (sw-dm64)', () => {
  const THREAD = '310000000000000001';
  const PARENT = '310000000000000002';
  const member = (id: string, username: string, displayName: string) => ({ id, displayName, user: { username, bot: false } });

  /** A thread of `type` with `joined` members, under a parent everyone can view, where only `managers` manage threads. */
  function threadFixture(
    t: TestContext,
    o: { type: ChannelType; joined: string[]; cached: ReturnType<typeof member>[]; managers?: string[]; warm?: () => Promise<boolean> },
  ) {
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: Client }).client;
    t.after(() => client.destroy());
    const guild = { id: 'g1', name: 'Guild', members: { cache: new Map(o.cached.map((m) => [m.id, m])) } };
    const thread = {
      id: THREAD, name: 'plans', type: o.type, guild, guildId: 'g1', parentId: PARENT, isThread: () => true,
      members: { fetch: async () => new Map(o.joined.map((id) => [id, { id }])) },
    };
    const parent = {
      id: PARENT, name: 'general', type: ChannelType.GuildText, guild, guildId: 'g1', parentId: null, isThread: () => false,
      members: guild.members.cache,
      permissionsFor: (m: { id: string }) => ({
        has: (p: bigint) => p === PermissionsBitField.Flags.ManageThreads && (o.managers ?? []).includes(m.id),
      }),
    };
    (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => (id === THREAD ? thread : id === PARENT ? parent : null);
    const a = adapter as unknown as Record<string, unknown>;
    let warmups = 0;
    a.warmGuildMemberCache = async () => { warmups++; return o.warm ? o.warm() : true; };
    a.fetchHistory = async () => [msg('200000000000000030', RA, 'ra', 'newest from Ra', 3)];
    return { adapter, warmups: () => warmups };
  }

  it('in a private thread, a parent viewer of the same name collides only if they manage threads (I16)', async (t) => {
    const ra = member(RA, 'ra', 'Ra');
    const namesake = member(RA2, 'ra_reader', 'Ra');
    for (const manages of [false, true]) {
      const f = threadFixture(t, { type: ChannelType.PrivateThread, joined: [RA], cached: [ra, namesake], managers: manages ? [RA2] : [] });
      const r = await f.adapter.resolveLatestFrom(THREAD, 'Ra');
      if (manages) assert.ok(!r.ok && /^"Ra" matches 2 people here: /.test(r.message), `a manager: ${JSON.stringify(r)}`);
      else assert.ok(r.ok && r.authorId === RA, `neither joined nor manages threads: ${JSON.stringify(r)}`);
    }
  });

  it('reports a joined member the guild cache can\'t name as unresolved (I17)', async (t) => {
    const f = threadFixture(t, { type: ChannelType.PublicThread, joined: [RA, RA2], cached: [member(RA, 'ra', 'Ra')] });
    const listed = await f.adapter.listChannelMembers(THREAD);
    assert.equal(listed.unresolved, 1);
    assert.deepEqual(listed.members.find((m) => m.id === RA2), { id: RA2, username: RA2, displayName: RA2, isBot: false });
  });

  it('treats a thread listing of exactly one page as possibly cut short: a name is refused, an id still works (I4)', async (t) => {
    const joined = [RA, ...Array.from({ length: 99 }, (_, i) => String(400000000000000000n + BigInt(i)))];
    const cached = joined.map((id, i) => (id === RA ? member(RA, 'ra', 'Ra') : member(id, `member${i}`, `Member ${i}`)));
    const f = threadFixture(t, { type: ChannelType.PublicThread, joined, cached });
    const listed = await f.adapter.listChannelMembers(THREAD);
    assert.equal(listed.total, 100);
    assert.equal(listed.possiblyIncomplete, true);
    assert.match(listed.note ?? '', /exactly one page \(100\) of joined members, so there may be more/);
    const byName = await f.adapter.resolveLatestFrom(THREAD, 'Ra');
    assert.ok(!byName.ok && /Discord returned exactly one page \(100\) of this thread's members, so there may be more\. Use their numeric user id; nothing was done\.$/.test(byName.message), JSON.stringify(byName));
    const byId = await f.adapter.resolveLatestFrom(THREAD, RA);
    assert.ok(byId.ok, JSON.stringify(byId));
    // 99 or 101 joined: a short page, or more than a page, is whole.
    for (const n of [99, 101]) {
      const ids = [RA, ...Array.from({ length: n - 1 }, (_, i) => String(400000000000000000n + BigInt(i)))];
      const g = threadFixture(t, { type: ChannelType.PublicThread, joined: ids, cached: ids.map((id, i) => member(id, `m${i}`, id === RA ? 'Ra' : `M ${i}`)) });
      assert.equal((await g.adapter.listChannelMembers(THREAD)).possiblyIncomplete, undefined, `${n} joined`);
    }
  });

  it('remembers a guild whose warm-up failed, refusing names there at once for a while (I8)', async (t) => {
    let succeed = false;
    const f = threadFixture(t, { type: ChannelType.PublicThread, joined: [RA], cached: [member(RA, 'ra', 'Ra')], warm: async () => succeed });
    const first = await f.adapter.resolveLatestFrom(THREAD, 'Ra');
    assert.ok(!first.ok, JSON.stringify(first));
    assert.equal(f.warmups(), 1);
    const second = await f.adapter.resolveLatestFrom(THREAD, 'Ra');
    assert.ok(!second.ok && /can't be checked for people sharing that name/.test(second.message), JSON.stringify(second));
    assert.equal(f.warmups(), 1, 'refused at once: no second download');
    // Ten minutes on, it's tried again; a success is not remembered as a failure.
    const failures = (f.adapter as unknown as { latestFromWarmupFailures: Map<string, number> }).latestFromWarmupFailures;
    failures.set('g1', Date.now() - 10 * 60_000 - 1);
    succeed = true;
    const later = await f.adapter.resolveLatestFrom(THREAD, 'Ra');
    assert.ok(later.ok && later.authorId === RA, JSON.stringify(later));
    assert.equal(f.warmups(), 2);
    assert.equal(failures.has('g1'), false, 'the success clears it');
  });

  it('skips the member download when the guild cache already holds every member (I5)', async () => {
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: Client }).client;
    try {
      let downloads = 0;
      const guild = (size: number, memberCount: number) => ({
        id: 'g1', name: 'Guild', memberCount,
        members: { cache: { size }, fetch: async () => { downloads++; } },
      });
      const warm = (adapter as unknown as { warmGuildMemberCache(g: unknown): Promise<boolean> }).warmGuildMemberCache.bind(adapter);
      assert.equal(await warm(guild(3, 3)), true);
      assert.equal(downloads, 0, 'a complete cache downloads nothing');
      assert.equal(await warm(guild(2, 3)), true);
      assert.equal(downloads, 1, 'a partial cache is downloaded');
    } finally {
      client.destroy();
    }
  });
});

describe('reply and reaction tools after the second review (sw-dm64)', () => {
  function toolsFixture(history: HistoryMessage[]) {
    const fetched: string[] = [];
    const acted: string[] = [];
    const adapter = {
      botUserId: 'bot',
      resolveChannelRef: (given: string) => ({ ok: true, id: given }),
      async resolveLatestFrom(channelId: string, ref: string) {
        const real = new DiscordAdapter({ token: 'unused' }) as unknown as Record<string, unknown>;
        const client = (real as unknown as { client: Client }).client;
        (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => {
          fetched.push(id);
          return { id: channelId, type: ChannelType.GuildText, guildId: 'g1', parentId: null, isThread: () => false };
        };
        real.fetchHistory = async () => history;
        real.listChannelMembers = async () => ({ channelId, channelName: 'general', scope: 'guild-channel', total: members.length, members, truncated: false });
        try {
          return await (real as unknown as DiscordAdapter).resolveLatestFrom(channelId, ref);
        } finally {
          client.destroy();
        }
      },
      async sendMessage() { acted.push('send'); return { messageId: '300000000000000001' }; },
      async addReaction() { acted.push('react'); },
      async removeReaction() { acted.push('unreact'); },
    };
    const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };
    const call = (name: string, args: Record<string, unknown>) => server.handleToolCall(name, { channelId: '1234567890123456789', ...args });
    return { call, fetched, acted };
  }
  const extra = { reply_message: { content: 'x' }, add_reaction: { emoji: '👍' }, remove_reaction: { emoji: '👍' } } as const;

  it('refuses every malformed selection on each tool before anything is fetched (I14, I7)', async () => {
    const forms: Array<[string, Record<string, unknown>, RegExp]> = [
      ['both', { messageId: '200000000000000030', latestFrom: 'Ra' }, /not both/],
      ['neither', {}, /Give exactly one of messageId or latestFrom/],
      ['null on both', { messageId: null, latestFrom: null }, /Give exactly one of messageId or latestFrom/],
      ['a non-string', { latestFrom: 42 }, /latestFrom must be a string or null/],
      ['blank', { latestFrom: '   ' }, /latestFrom is blank, so it names no one/],
      ['a blank beside a real one', { messageId: '', latestFrom: 'Ra' }, /not both/],
      ['@ alone', { latestFrom: '@' }, /latestFrom names no one/],
      ['@ and spaces', { latestFrom: '@  ' }, /latestFrom names no one/],
    ];
    for (const name of ['reply_message', 'add_reaction', 'remove_reaction'] as const) {
      const f = toolsFixture([msg('200000000000000030', RA, 'ra', 'hi', 3)]);
      for (const [label, selection, expected] of forms) {
        const res = await f.call(name, { ...selection, ...extra[name] });
        assert.ok(res.isError && expected.test(res.content[0].text), `${name}, ${label}: ${res.content[0].text}`);
      }
      assert.deepEqual([f.fetched, f.acted], [[], []], `${name}: nothing fetched, nothing done`);
    }
  });

  it('returns { result, target } from add_reaction and remove_reaction for a latestFrom selection (I11)', async () => {
    const f = toolsFixture([msg('200000000000000030', RA, 'ra', 'the message', 3)]);
    for (const [name, result] of [['add_reaction', 'Reaction added'], ['remove_reaction', 'Reaction removed']] as const) {
      const res = await f.call(name, { latestFrom: 'Ra', emoji: '👍' });
      assert.ok(!res.isError, res.content[0].text);
      const receipt = JSON.parse(res.content[0].text);
      assert.equal(receipt.result, result);
      assert.equal(receipt.target.messageId, '200000000000000030');
      assert.deepEqual(receipt.target.author, { id: RA, name: 'Ra' });
      assert.equal(receipt.target.excerpt, 'the message');
    }
  });

  it('cuts the excerpt by code points, never inside a surrogate pair, to 80 characters with its ellipsis (I12)', async () => {
    const emoji = '😀🎉👍🏽'.repeat(40);
    const f = toolsFixture([{ ...msg('200000000000000030', RA, 'ra', emoji, 3), cleanContent: emoji }]);
    const res = await f.call('add_reaction', { latestFrom: 'Ra', emoji: '👍' });
    assert.ok(!res.isError, res.content[0].text);
    const excerpt: string = JSON.parse(res.content[0].text).target.excerpt;
    const points = Array.from(excerpt);
    assert.equal(points.length, 80, '79 code points of the message and the ellipsis');
    assert.equal(points.at(-1), '…');
    assert.equal(points.slice(0, 79).join(''), Array.from(emoji).slice(0, 79).join(''));
    assert.doesNotMatch(excerpt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate');
  });
});

