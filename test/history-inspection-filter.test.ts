/**
 * Deliberate history reads respect the channel filters' inspection boundary
 * (guildChannels, a channel admitted by its parent) for numeric channel ids,
 * as list_channels and list_channel_members already do. guildIds and dmUsers
 * stay delivery filters and don't restrict reads. A channel lookup that fails
 * is returned as the tool's error, with nothing read. The backscroll a
 * channels/open requests is held to the same boundary.
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Client } from 'discord.js';
import { DiscordAdapter, mapAllAttachments, type DiscordAdapterConfig } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { mcplChannelId, toDescriptor } from '../src/channels.js';

const G1 = '400000000000000001'; // a guild with a channel list
const G2 = '400000000000000002'; // a guild without one
const ALLOWED = '410000000000000001';
const EXCLUDED = '410000000000000002';
const CATEGORY = '410000000000000003';
const UNDER_CATEGORY = '410000000000000004';
const THREAD_OF_ALLOWED = '410000000000000005';
const THREAD_OF_EXCLUDED = '410000000000000006';
const OTHER_GUILD = '410000000000000007';
const DM = '410000000000000008';
const LOOKUP_FAILS = '410000000000000009'; // a channel whose lookup rejects
const UNKNOWN = '410000000000000010'; // a channel whose lookup finds nothing
const THREAD_UNDER_CATEGORY = '410000000000000011'; // a thread of a channel its category admits

const channels: Record<string, Record<string, unknown>> = {
  [ALLOWED]: { guildId: G1, parentId: null },
  [EXCLUDED]: { guildId: G1, parentId: null },
  [UNDER_CATEGORY]: { guildId: G1, parentId: CATEGORY },
  [THREAD_OF_ALLOWED]: { guildId: G1, parentId: ALLOWED },
  [THREAD_OF_EXCLUDED]: { guildId: G1, parentId: EXCLUDED },
  [THREAD_UNDER_CATEGORY]: { guildId: G1, parentId: UNDER_CATEGORY },
  [OTHER_GUILD]: { guildId: G2, parentId: null },
};

function adapterWith(t: TestContext, config: Partial<DiscordAdapterConfig>) {
  const adapter = new DiscordAdapter({ token: 'unused', guildChannels: { [G1]: [ALLOWED, CATEGORY] }, ...config });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  // channelAllowed reads a thread's channel from the cache to find its
  // category (#73), as the gateway leaves it there for a guild's channels.
  client.channels.cache.set(UNDER_CATEGORY, { id: UNDER_CATEGORY, isDMBased: () => false, ...channels[UNDER_CATEGORY], parentId: CATEGORY } as never);
  (client.channels as unknown as { fetch: unknown }).fetch = async (id: string) => {
    if (id === DM) return { id, isDMBased: () => true };
    // As discord.js's DiscordAPIError carries it: Discord's JSON code.
    if (id === LOOKUP_FAILS) throw Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
    const c = channels[id];
    return c ? { id, isDMBased: () => false, ...c } : null;
  };
  const reads: string[] = [];
  const a = adapter as unknown as Record<string, unknown>;
  a.fetchHistory = async (channelId: string) => {
    reads.push(`history:${channelId}`);
    return [{
      id: '420000000000000001', authorId: 'u1', authorName: 'Alice', isBot: false, content: `body in ${channelId}`,
      cleanContent: `body in ${channelId}`, attachments: [], mentionsBot: false, timestamp: new Date(), reactions: [],
    }];
  };
  a.fetchAround = async (channelId: string) => {
    reads.push(`around:${channelId}`);
    return [];
  };
  const sends: string[] = [];
  a.sendMessage = async (channelId: string) => {
    sends.push(channelId);
    return { messageId: '430000000000000001', channelId };
  };
  return { adapter, reads, sends };
}

const REFUSAL = /is outside this residence's configured channel filters — filters bound inspection as well as delivery\. Nothing was read\.$/;

describe('inspectionRefusal', () => {
  it('applies the guildChannels boundary, a parent admitting its channel', async (t) => {
    const { adapter } = adapterWith(t, {});
    for (const id of [ALLOWED, UNDER_CATEGORY, THREAD_OF_ALLOWED, THREAD_UNDER_CATEGORY, OTHER_GUILD, DM]) {
      assert.equal(await adapter.inspectionRefusal(id), null, id);
    }
    for (const id of [EXCLUDED, THREAD_OF_EXCLUDED]) {
      assert.match((await adapter.inspectionRefusal(id)) ?? '', REFUSAL, id);
    }
  });

  it('leaves guildIds and dmUsers as delivery filters', async (t) => {
    const { adapter } = adapterWith(t, { guildIds: [G1], dmUsers: ['999999999999999999'] });
    assert.equal(await adapter.inspectionRefusal(OTHER_GUILD), null, 'a guild outside guildIds');
    assert.equal(await adapter.inspectionRefusal(DM), null, 'a DM whose partner is outside dmUsers');
  });
});

describe('fetch_history and fetch_around by numeric id', () => {
  function serverWith(t: TestContext) {
    const { adapter, reads, sends } = adapterWith(t, {});
    const server = new DiscordMcplServer(adapter) as unknown as {
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };
    return { server, reads, sends };
  }

  it('refuses an excluded channel, and a thread under one, before any message is read', async (t) => {
    const { server, reads } = serverWith(t);
    for (const [tool, args] of [
      ['fetch_history', { channelId: EXCLUDED }],
      ['fetch_around', { channelId: EXCLUDED, messageId: '420000000000000001' }],
      ['fetch_history', { channelId: THREAD_OF_EXCLUDED }],
    ] as const) {
      const res = await server.handleToolCall(tool, args);
      assert.equal(res.isError, true, `${tool} ${args.channelId}`);
      assert.match(res.content[0].text, REFUSAL);
    }
    assert.deepEqual(reads, [], 'no history was read');
  });

  it('returns a failed channel lookup as its error, explained, before any message is read', async (t) => {
    const { server, reads } = serverWith(t);
    for (const [tool, args] of [
      ['fetch_history', { channelId: LOOKUP_FAILS }],
      ['fetch_around', { channelId: LOOKUP_FAILS, messageId: '420000000000000001' }],
    ] as const) {
      const res = await server.handleToolCall(tool, args);
      assert.equal(res.isError, true, tool);
      assert.match(res.content[0].text, /^Unknown Channel\n\n/, `${tool}: Discord's own words come first`);
      assert.match(res.content[0].text, new RegExp(`No channel ${LOOKUP_FAILS} is visible to this connection`), tool);
    }
    assert.deepEqual(reads, [], 'no history was read');
  });

  it('explains a failed lookup against the name the model sent', async (t) => {
    const { server, reads } = serverWith(t);
    // The name route resolved '#gone' to an id whose lookup Discord refuses.
    const discord = (server as unknown as { discord: Record<string, unknown> }).discord;
    discord.resolveChannelRef = () => ({ ok: true, id: LOOKUP_FAILS });
    const res = await server.handleToolCall('fetch_history', { channelId: '#gone' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, new RegExp(`#gone resolved to channel ${LOOKUP_FAILS}, which Discord doesn't know`));
    assert.deepEqual(reads, [], 'no history was read');
  });

  it("refuses a channel whose lookup finds nothing, before any message is read", async (t) => {
    const { server, reads } = serverWith(t);
    for (const [tool, args] of [
      ['fetch_history', { channelId: UNKNOWN }],
      ['fetch_around', { channelId: UNKNOWN, messageId: '420000000000000001' }],
    ] as const) {
      const res = await server.handleToolCall(tool, args);
      assert.equal(res.isError, true, tool);
      assert.equal(res.content[0].text, `Channel ${UNKNOWN} not found`, tool);
    }
    assert.deepEqual(reads, [], 'no history was read');
  });

  it("refuses a channelId that isn't a string, rather than let it past the check", async (t) => {
    const { server, reads } = serverWith(t);
    for (const channelId of [[EXCLUDED], Number(EXCLUDED), undefined, '', '   ']) {
      for (const tool of ['fetch_history', 'fetch_around']) {
        const res = await server.handleToolCall(tool, { channelId, messageId: '420000000000000001' });
        assert.equal(res.isError, true, `${tool} ${JSON.stringify(channelId)}`);
        assert.match(res.content[0].text, /needs channelId as a channel id string.*Nothing was read\.$/);
      }
    }
    assert.deepEqual(reads, [], 'no history was read');
  });

  it("doesn't hold a send to the read boundary", async (t) => {
    const { server, sends } = serverWith(t);
    const res = await server.handleToolCall('send_message', { channelId: EXCLUDED, content: 'hello' });
    assert.ok(!res.isError, res.content[0]?.text);
    assert.deepEqual(sends, [EXCLUDED]);
  });

  it('still reads allowed channels, threads under them, other guilds and DMs', async (t) => {
    const { server, reads } = serverWith(t);
    for (const id of [ALLOWED, THREAD_OF_ALLOWED, UNDER_CATEGORY, OTHER_GUILD, DM]) {
      const res = await server.handleToolCall('fetch_history', { channelId: id });
      assert.ok(!res.isError, `${id}: ${res.content[0].text}`);
      assert.match(res.content[0].text, new RegExp(`body in ${id}`));
    }
    const around = await server.handleToolCall('fetch_around', { channelId: ALLOWED, messageId: '420000000000000001' });
    assert.ok(!around.isError);
    assert.deepEqual(reads, [
      `history:${ALLOWED}`, `history:${THREAD_OF_ALLOWED}`, `history:${UNDER_CATEGORY}`,
      `history:${OTHER_GUILD}`, `history:${DM}`, `around:${ALLOWED}`,
    ]);
  });
});

describe('channels/open backscroll', () => {
  // The registry only grows until restart: filters_update and hot reload add
  // channels, and only a deleted channel leaves. So a channel registered
  // before guildChannels narrowed can still be named by channels/open.
  function serverWith(t: TestContext) {
    const { adapter, reads } = adapterWith(t, {});
    const server = new DiscordMcplServer(adapter) as unknown as {
      channelManager: { register(d: unknown): void; isOpen(id: string): boolean };
      subscribedChannels: Set<string>;
      reactionChannels: Set<string>;
      missedTally: Map<string, unknown>;
      forwardedWatermark: Map<string, string>;
      subscriptionsLoaded: boolean;
      reactionChannelsLoaded: boolean;
      watermarkLoaded: boolean;
      handleChannelOpen(params: { channelId: string; type: string; history?: { limit: number } }): Promise<{
        history?: Array<{ content: Array<{ text: string }> }>;
      }>;
    };
    const kinds = {
      [ALLOWED]: 'text', [EXCLUDED]: 'text', [THREAD_OF_EXCLUDED]: 'thread', [LOOKUP_FAILS]: 'text',
      [UNDER_CATEGORY]: 'text', [THREAD_OF_ALLOWED]: 'thread',
    } as const;
    for (const [id, type] of Object.entries(kinds)) {
      const name = `${type}-${id.slice(-1)}`;
      server.channelManager.register(toDescriptor({ id, guildId: G1, guildName: 'Guild', type, name }));
    }
    const opened = (id: string) =>
      server.channelManager.isOpen(mcplChannelId(G1, id)) || server.subscribedChannels.has(id);
    return { server, reads, opened };
  }

  it('refuses backscroll from an excluded channel, and a thread under one, before anything is read, opened or changed', async (t) => {
    const { server, reads, opened } = serverWith(t);
    // What subscribing would change, set as an earlier session left it.
    server.subscriptionsLoaded = server.reactionChannelsLoaded = server.watermarkLoaded = true;
    const tally = { anchorId: '1', talliedThrough: '1', messages: 2, characters: 30 };
    for (const id of [EXCLUDED, THREAD_OF_EXCLUDED]) {
      server.missedTally.set(id, tally);
      server.forwardedWatermark.set(id, '1');
    }
    for (const id of [EXCLUDED, THREAD_OF_EXCLUDED]) {
      await assert.rejects(
        server.handleChannelOpen({ channelId: mcplChannelId(G1, id), type: 'discord', history: { limit: 20 } }),
        REFUSAL,
        id,
      );
      assert.equal(opened(id), false, `${id} is neither open nor subscribed`);
      assert.equal(server.reactionChannels.has(id), false, `${id}: reaction visibility unchanged`);
      assert.deepEqual(server.missedTally.get(id), tally, `${id}: the missed tally is kept`);
      assert.equal(server.forwardedWatermark.get(id), '1', `${id}: the watermark is unchanged`);
    }
    assert.deepEqual(reads, [], 'no history was read');
  });

  it('fails the open with a failed channel lookup, before anything is read or opened', async (t) => {
    const { server, reads, opened } = serverWith(t);
    await assert.rejects(
      server.handleChannelOpen({ channelId: mcplChannelId(G1, LOOKUP_FAILS), type: 'discord', history: { limit: 20 } }),
      /^Error: Unknown Channel$/,
    );
    assert.equal(opened(LOOKUP_FAILS), false);
    assert.deepEqual(reads, [], 'no history was read');
  });

  it('still returns backscroll from an allowed channel, and from one admitted through its parent', async (t) => {
    const { server, reads, opened } = serverWith(t);
    for (const id of [ALLOWED, UNDER_CATEGORY, THREAD_OF_ALLOWED]) {
      const result = await server.handleChannelOpen({
        channelId: mcplChannelId(G1, id), type: 'discord', history: { limit: 20 },
      });
      assert.match(result.history?.[0]?.content[0]?.text ?? '', new RegExp(`body in ${id}`), id);
      assert.equal(opened(id), true, id);
    }
    assert.deepEqual(reads, [`history:${ALLOWED}`, `history:${UNDER_CATEGORY}`, `history:${THREAD_OF_ALLOWED}`]);
  });

  it("opens an excluded channel without backscroll, with a limit of 0 too, and reads nothing", async (t) => {
    // Ingress, and the reconnect sweep once #61 lands, drop what it would
    // deliver, so an open that reads nothing isn't refused.
    const { server, reads, opened } = serverWith(t);
    await server.handleChannelOpen({ channelId: mcplChannelId(G1, EXCLUDED), type: 'discord' });
    await server.handleChannelOpen({ channelId: mcplChannelId(G1, THREAD_OF_EXCLUDED), type: 'discord', history: { limit: 0 } });
    assert.equal(opened(EXCLUDED), true);
    assert.equal(opened(THREAD_OF_EXCLUDED), true);
    assert.deepEqual(reads, []);
  });
});

describe('attachment links in history results', () => {
  const signed = 'https://cdn.discordapp.example/1/2/notes.txt?ex=6ad179e0&is=6ad02860&hm=1';
  function serverWith(t: TestContext) {
    const { adapter } = adapterWith(t, {});
    const message = {
      id: '420000000000000001', authorId: 'u1', authorName: 'Alice', isBot: false, content: 'see the file',
      cleanContent: 'see the file', mentionsBot: false, timestamp: new Date(), reactions: [],
      attachments: mapAllAttachments({
        attachments: new Map([['a1', { id: 'a1', name: 'notes.txt', url: signed, contentType: 'text/plain', size: 3 }]]),
      }),
    };
    const a = adapter as unknown as Record<string, unknown>;
    a.fetchHistory = async () => [message];
    a.fetchAround = async () => [message];
    const server = new DiscordMcplServer(adapter) as unknown as {
      channelManager: { register(d: unknown): void };
      handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
      handleChannelOpen(params: { channelId: string; type: string; history?: { limit: number } }): Promise<{
        history?: Array<{ metadata: { attachments: Array<{ url: string; expiresAt?: string }> } }>;
      }>;
    };
    return server;
  }

  it('gives each attachment its expiresAt beside its url in fetch_history and fetch_around results', async (t) => {
    const server = serverWith(t);
    for (const [tool, args] of [
      ['fetch_history', { channelId: ALLOWED }],
      ['fetch_around', { channelId: ALLOWED, messageId: '420000000000000001' }],
    ] as const) {
      const res = await server.handleToolCall(tool, args);
      assert.ok(!res.isError, res.content[0].text);
      const [message] = JSON.parse(res.content[0].text) as Array<{ attachments: Array<{ url: string; expiresAt?: string }> }>;
      assert.deepEqual(
        [message.attachments[0].url, message.attachments[0].expiresAt],
        [signed, '2026-10-16T01:12:00.000Z'],
        tool,
      );
    }
  });

  it('keeps it in the metadata of channels/open history', async (t) => {
    const server = serverWith(t);
    server.channelManager.register(toDescriptor({ id: ALLOWED, guildId: G1, guildName: 'Guild', type: 'text', name: 'text-1' }));
    const result = await server.handleChannelOpen({ channelId: mcplChannelId(G1, ALLOWED), type: 'discord', history: { limit: 20 } });
    assert.equal(result.history?.[0]?.metadata.attachments[0]?.expiresAt, '2026-10-16T01:12:00.000Z');
  });
});
