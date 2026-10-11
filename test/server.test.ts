/**
 * Integration tests for DiscordMcplServer.
 * Uses a mock Discord adapter (no real Discord connection).
 */

import { describe, it, beforeEach, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import {
  McplConnection,
  textContent,
  method,
} from '@animalabs/mcpl-core';

import type {
  McplInitializeParams,
  McplInitializeResult,
  McplCapabilities,
  ChannelsRegisterParams,
  ChannelsIncomingParams,
  PushEventParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsListResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
} from '@animalabs/mcpl-core';

import { DiscordMcplServer, serveStdio } from '../src/server.js';
import { applyMentionCandidates } from '../src/discord-adapter.js';
import { TOOL_CLASSES } from '../src/tool-classes.js';
import type {
  ChannelMeta,
  DiscordAdapter,
  DiscordMessageData,
  DiscordChannelInfo,
  MentionCandidate,
} from '../src/discord-adapter.js';

// ── Mock Discord Adapter ──

class MockDiscordAdapter {
  private _messageHandler?: (msg: DiscordMessageData) => void;
  private _channelCreateHandler?: (guildId: string, channel: DiscordChannelInfo) => void;
  private _channelDeleteHandler?: (guildId: string, channelId: string) => void;
  private _guildCreateHandler?: (
    guildId: string,
    guildName: string,
    channels: DiscordChannelInfo[],
  ) => void;
  private _channelAvailableHandler?: (guildId: string, channel: DiscordChannelInfo) => void;

  sentMessages: Array<{ channelId: string; content: string; replyTo?: string }> = [];
  deletedMessages: Array<{ channelId: string; messageId: string }> = [];
  reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  removedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  private nextMessageId = 1;

  get isConnected(): boolean { return true; }
  get botUserId(): string | null { return 'bot_123'; }

  onMessage(handler: (msg: DiscordMessageData) => void): void {
    this._messageHandler = handler;
  }
  private _editHandler?: (channelId: string, messageId: string, newContent: string, isDM: boolean, info?: unknown) => void;
  private _deleteHandler?: (channelId: string, messageId: string, isDM: boolean, info?: unknown) => void;
  onMessageEdit(handler: (channelId: string, messageId: string, newContent: string, isDM: boolean, info?: unknown) => void): void {
    this._editHandler = handler;
  }
  onMessageDelete(handler: (channelId: string, messageId: string, isDM: boolean, info?: unknown) => void): void {
    this._deleteHandler = handler;
  }
  simulateEdit(channelId: string, messageId: string, newContent: string, isDM: boolean, info?: unknown): void {
    this._editHandler?.(channelId, messageId, newContent, isDM, info);
  }
  simulateDelete(channelId: string, messageId: string, isDM: boolean, info?: unknown): void {
    this._deleteHandler?.(channelId, messageId, isDM, info);
  }
  onReaction(): void {}
  onReady(): void {}

  // The catch-up sweep's ingress decision: these tests' filters refuse nothing.
  historyIngressReason(): string | null {
    return null;
  }
  onChannelCreate(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this._channelCreateHandler = handler;
  }
  onChannelDelete(handler: (guildId: string, channelId: string) => void): void {
    this._channelDeleteHandler = handler;
  }
  onGuildCreate(
    handler: (guildId: string, guildName: string, channels: DiscordChannelInfo[]) => void,
  ): void {
    this._guildCreateHandler = handler;
  }
  onChannelAvailable(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this._channelAvailableHandler = handler;
  }
  getGuildName(guildId: string): string {
    return guildId === 'g1' ? 'Test Guild' : guildId;
  }

  async sendMessage(channelId: string, content: string, options?: { replyTo?: string }): Promise<{ messageId: string }> {
    const id = `msg_${this.nextMessageId++}`;
    this.sentMessages.push({ channelId, content, replyTo: options?.replyTo });
    return { messageId: id };
  }

  async sendDM(userId: string, content: string): Promise<{ messageId: string }> {
    const id = `dm_${this.nextMessageId++}`;
    this.sentMessages.push({ channelId: `dm:${userId}`, content });
    return { messageId: id };
  }

  async editMessage(): Promise<void> {}

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    this.deletedMessages.push({ channelId, messageId });
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji });
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.removedReactions.push({ channelId, messageId, emoji });
  }

  /** Messages the next fetchHistory/fetchAround call should return. Tests set
   *  this to drive the reconnect catch-up sweep. */
  historyToReturn: Array<{
    id: string; authorId: string; authorName: string; isBot: boolean;
    content: string; cleanContent: string; attachments: never[]; mentionsBot: boolean; timestamp: Date;
    reactions?: Array<{ emoji: string; emojiId: string | null; token: string; count: number; me: boolean }>;
  }> = [];
  channelMeta: ChannelMeta = { name: 'general', guildId: 'g1', guildName: 'Test Guild', isDM: false };

  async fetchHistory(): Promise<MockDiscordAdapter['historyToReturn']> {
    return this.historyToReturn;
  }

  async fetchAround(): Promise<MockDiscordAdapter['historyToReturn']> {
    return this.historyToReturn;
  }

  /** No channel filters are configured here, so no read is refused. */
  async inspectionRefusal(): Promise<string | null> {
    return null;
  }

  async getChannelMeta(): Promise<MockDiscordAdapter['channelMeta']> {
    return this.channelMeta;
  }

  /** Gateway-cache metadata by raw channel id. Empty by default so tests of
   *  the REST fallback keep exercising getChannelMeta. */
  cachedChannelMeta: Record<string, MockDiscordAdapter['channelMeta']> = {};

  getCachedChannelMeta(channelId: string): MockDiscordAdapter['channelMeta'] | null {
    return this.cachedChannelMeta[channelId] ?? null;
  }

  async listGuilds(): Promise<Array<{ id: string; name: string; memberCount: number }>> {
    return [{ id: 'g1', name: 'Test Guild', memberCount: 10 }];
  }

  async listChannels(): Promise<DiscordChannelInfo[]> {
    return [
      { id: 'c1', name: 'general', type: 'text', label: '#general (TestGuild)' },
      { id: 'c2', name: 'dev', type: 'text', label: '#dev (TestGuild)' },
    ];
  }

  /** Channel-members fixture; tests may reassign. */
  channelMembersToReturn = {
    channelId: 'c1',
    channelName: 'general',
    scope: 'guild-channel' as const,
    total: 3,
    members: [
      { id: 'u1', username: 'ra', displayName: 'Ra', isBot: false },
      { id: 'u2', username: 'tessera', displayName: 'Tessera', isBot: false },
      { id: 'b1', username: 'connectome', displayName: 'Connectome', isBot: true },
    ],
    truncated: false,
  };

  async listChannelMembers(channelId: string): Promise<MockDiscordAdapter['channelMembersToReturn']> {
    return { ...this.channelMembersToReturn, channelId };
  }

  async createTextChannel(): Promise<DiscordChannelInfo> {
    return { id: 'c_new', name: 'new-channel', type: 'text', label: '#new-channel (TestGuild)' };
  }

  async deleteChannel(): Promise<void> {}

  getTextChannels(): Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> {
    return [
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c1', name: 'general', type: 'text', label: '#general (TestGuild)' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c2', name: 'dev', type: 'text', label: '#dev (TestGuild)' } },
    ];
  }

  /** Simulate an incoming Discord message (for push event / channels/incoming tests). */
  simulateMessage(msg: DiscordMessageData): void {
    this._messageHandler?.(msg);
  }

  /** Simulate the bot joining a new guild after startup. */
  simulateGuildCreate(guildId: string, guildName: string, channels: DiscordChannelInfo[]): void {
    this._guildCreateHandler?.(guildId, guildName, channels);
  }

  /** Simulate the bot being granted access to a pre-existing channel. */
  simulateChannelAvailable(guildId: string, channel: DiscordChannelInfo): void {
    this._channelAvailableHandler?.(guildId, channel);
  }
}

// ── Test Helpers ──

/** The client's next message, or a failure once `ms` has passed, so a server
 *  that never sends fails the test instead of hanging the suite. */
function nextWithin(client: McplConnection, ms = 10_000): ReturnType<McplConnection['nextMessage']> {
  return Promise.race([
    client.nextMessage(),
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`the server sent nothing within ${ms} ms`)), ms);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

async function createTestPair(): Promise<{
  client: McplConnection;
  /** The client's own socket, for writing what a well-behaved client wouldn't. */
  clientSocket: net.Socket;
  serverConn: McplConnection;
  discord: MockDiscordAdapter;
}> {
  const tcpServer = net.createServer();
  tcpServer.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => tcpServer.once('listening', resolve));
  const addr = tcpServer.address() as net.AddressInfo;

  const [serverConn, clientSocket] = await Promise.all([
    McplConnection.acceptTcp(tcpServer),
    new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: addr.port }, () => resolve(socket));
      socket.once('error', reject);
    }),
  ]);

  const client = McplConnection.fromTcp(clientSocket);
  const discord = new MockDiscordAdapter();

  tcpServer.close();
  return { client, clientSocket, serverConn, discord };
}

/** Perform MCPL handshake from client side with MCPL capabilities. */
async function mcplHandshake(client: McplConnection, hostExtras: Record<string, unknown> = {}): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: {
      experimental: {
        mcpl: {
          version: '0.4',
          pushEvents: true,
          channels: true,
          rollback: true,
          ...hostExtras,
        } as McplInitializeParams['capabilities']['experimental'] extends { mcpl?: infer M } ? M : never,
      },
    },
    clientInfo: { name: 'test-client', version: '0.1.0' },
  };

  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  // 0.5 host behavior: settle the §5.3 initial policy right after
  // initialize. This is also what releases the server's policy-gated channel
  // registration + reconnect sweep (see serve()) — without it every test
  // sits out the 20s pre-0.5 grace before channels/register arrives.
  const receipt = (await client.sendRequest('featureSets/update', {
    enabled: ['discord.messaging', 'discord.channels', 'discord.history', 'discord.subscriptions'],
  })) as { accepted: boolean };
  assert.equal(receipt.accepted, true);
  return result;
}

/** Perform MCP-only handshake (no MCPL capabilities). */
async function mcpHandshake(client: McplConnection): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-mcp-client', version: '0.1.0' },
  };

  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

// ── Tests ──

describe('DiscordMcplServer', () => {
  it('MCPL handshake exposes feature sets and channels', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);

    // Start server in background
    const serverPromise = server.serve(serverConn);

    // Client: handshake + accept channel registration
    const initResult = await mcplHandshake(client);

    assert.equal(initResult.serverInfo.name, 'discord-mcpl');
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(initResult.serverInfo.version, manifest.version);
    const mcpl = initResult.capabilities.experimental?.mcpl as McplCapabilities;
    assert.ok(mcpl);
    assert.equal(mcpl.pushEvents, true);
    assert.equal(mcpl.channels, true);
    assert.equal(mcpl.rollback, true);
    assert.ok(mcpl.featureSets);
    // This server advertises the legacy ARRAY form (hashed verbatim per the
    // conformance corpus; hosts normalize it — af feature-set-manager). The
    // 0.5 core type is `Record<string, FeatureSetDeclaration> | boolean`, so
    // narrow explicitly to the wire shape actually sent.
    const declaredSets = mcpl.featureSets as unknown as Array<{ name: string }>;
    assert.equal(declaredSets.length, 4);
    assert.equal(declaredSets[0].name, 'discord.messaging');
    assert.ok(
      declaredSets.some((fs) => fs.name === 'discord.subscriptions'),
      'discord.subscriptions feature set should be declared',
    );

    // Server should register channels — accept the request
    const regMsg = await client.nextMessage();
    assert.equal(regMsg.type, 'request');
    if (regMsg.type === 'request') {
      assert.equal(regMsg.request.method, 'channels/register');
      const p = regMsg.request.params as ChannelsRegisterParams;
      assert.equal(p.channels.length, 2);
      assert.equal(p.channels[0].type, 'discord');
      client.sendResponse(regMsg.request.id, {});
    }

    client.close();
    await serverPromise;
  });

  it('MCP-only handshake omits MCPL extensions', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    const initResult = await mcpHandshake(client);

    assert.equal(initResult.serverInfo.name, 'discord-mcpl');
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(initResult.serverInfo.version, manifest.version);
    // No MCPL capabilities in MCP mode
    assert.equal(initResult.capabilities.experimental, undefined);
    // But tools should be declared
    assert.ok(initResult.capabilities.tools);

    client.close();
    await serverPromise;
  });

  /** Whether `request` is answered at all; the bound only ends a wait on a loop that stopped reading. */
  function answeredWithin(request: Promise<unknown>, ms = 15_000): Promise<boolean> {
    return Promise.race([
      request.then(() => true),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), ms);
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
  }

  it('a notification whose handler throws leaves the server serving requests', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);
    let answered = false;
    let errors: ReturnType<typeof t.mock.method>;
    try {
      await mcpHandshake(client);
      errors = t.mock.method(console, 'error', () => {});
      // A typing notification with no params, as a broken host could send:
      // its handler throws reading the missing params, synchronously.
      client.sendNotification('channels/typing');
      answered = await answeredWithin(client.sendRequest('tools/list', {}));
    } finally {
      // Close whatever happened above: an open socket would keep the runner
      // from ever exiting, even after it reported the failure.
      client.close();
      await serverPromise;
    }

    assert.equal(answered, true, 'tools/list was answered after the throwing notification');
    // The throw was logged once, naming the method, with the handler's own Error, stack and all.
    // (The handshake's and the disconnect's own lines go to stderr too.)
    const failures = errors!.mock.calls.filter((c) => /notification channels\/typing failed/.test(String(c.arguments[0])));
    assert.equal(failures.length, 1, JSON.stringify(errors!.mock.calls.map((c) => String(c.arguments[0]))));
    const logged = failures[0].arguments;
    assert.ok(logged[1] instanceof Error, 'the Error itself was logged, not only its message');
    assert.match(String((logged[1] as Error).stack), /handleNotification/, "the stack is the handler's, not one built in the catch");
  });

  it('a malformed featureSets/update notification changes no grant, and the server goes on serving', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);
    let history: { content: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    let reaction: { content: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    let errors: ReturnType<typeof t.mock.method>;
    try {
      await mcplHandshake(client);
      // Answer the server's own requests (channel registration) as they come.
      void (async () => {
        try {
          for (;;) {
            const m = await client.nextMessage();
            if (m.type === 'request') client.sendResponse(m.request.id, {});
          }
        } catch { /* closed */ }
      })();
      const receipt = (await client.sendRequest('featureSets/update', { disabled: ['discord.history'] })) as { accepted: boolean };
      assert.equal(receipt.accepted, true);

      errors = t.mock.method(console, 'error', () => {});
      // The Request form of the same malformed update is answered with an error.
      await assert.rejects(
        client.sendRequest('featureSets/update', { enabled: ['discord.history'], disabled: 'discord.messaging' }),
        (err: { code?: number; message?: string }) =>
          err.code === -32603 && /disabled must be a list of feature-set names/.test(String(err.message)),
      );
      // Its enable is well formed and its disable isn't: neither may apply, in either form.
      client.sendNotification('featureSets/update', { enabled: ['discord.history'], disabled: 'discord.messaging' });
      history = (await client.sendRequest('tools/call', {
        name: 'fetch_history', arguments: { channelId: 'discord:g1:c1' },
      })) as typeof history;
      reaction = (await client.sendRequest('tools/call', {
        name: 'add_reaction', arguments: { channelId: 'discord:g1:c1', messageId: 'm1', emoji: '👍' },
      })) as typeof reaction;
    } finally {
      client.close();
      await serverPromise;
    }

    // The enable didn't apply: history stays off, as the request before it left it.
    assert.equal(history?.isError, true);
    assert.match(history?.content[0]?.text ?? '', /Feature set 'discord\.history' is not enabled/);
    // Nor did the disable: messaging still works.
    assert.notEqual(reaction?.isError, true, `add_reaction was refused: ${reaction?.content[0]?.text}`);
    assert.deepEqual(discord.reactions.at(-1), { channelId: 'discord:g1:c1', messageId: 'm1', emoji: '👍' });
    // The malformed update was logged, naming what was wrong.
    const failure = errors.mock.calls.find((c) => /notification featureSets\/update failed/.test(String(c.arguments[0])));
    assert.ok(failure, 'the malformed update was logged');
    assert.match(String((failure!.arguments[1] as Error).message), /disabled must be a list of feature-set names/);
  });

  it("a line that isn't JSON leaves the server serving requests", async (t) => {
    const { client, clientSocket, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);
    let answered = false;
    let errors: ReturnType<typeof t.mock.method>;
    try {
      await mcpHandshake(client);
      errors = t.mock.method(console, 'error', () => {});
      clientSocket.write('this is not JSON\n');
      answered = await answeredWithin(client.sendRequest('tools/list', {}), 5_000);
    } finally {
      client.close();
      await serverPromise;
    }

    assert.equal(answered, true, 'tools/list was answered after the bad line');
    const lines = errors!.mock.calls.map((c) => c.arguments.map(String).join(' '));
    assert.ok(
      lines.some((l) => /^\[discord-mcpl\] Connection error: Malformed JSON-RPC message/.test(l)),
      `the bad line was logged: ${JSON.stringify(lines)}`,
    );
  });

  it('a client that leaves before initialize ends only its connection', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const log = t.mock.method(console, 'error', () => {});
    const serverPromise = server.serve(serverConn);
    client.close();
    // serve() resolving is what lets the TCP transport accept the next client;
    // a rejection reached main()'s catch, which exits the process.
    const outcome = await Promise.race([
      serverPromise.then(() => 'returned', (err) => `rejected: ${String(err)}`),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('still serving'), 5_000);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);

    assert.equal(outcome, 'returned');
    assert.ok(log.mock.calls.some((c) => /Client disconnected/.test(String(c.arguments[0]))), 'the disconnect was logged');
  });

  it('a request sent before notifications/initialized is answered, not dropped', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const log = t.mock.method(console, 'error', () => {});
    const serverPromise = server.serve(serverConn);
    let early = false;
    let after = false;
    try {
      await client.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-early-client', version: '0.1.0' },
      });
      early = await answeredWithin(client.sendRequest('tools/list', {}), 5_000);
      client.sendNotification('notifications/initialized');
      // Answered after the notification, so the notification has been read.
      after = await answeredWithin(client.sendRequest('tools/list', {}), 5_000);
    } finally {
      client.close();
      await serverPromise;
    }

    assert.equal(early, true, 'the request before notifications/initialized was answered');
    assert.equal(after, true);
    assert.ok(
      log.mock.calls.some((c) => String(c.arguments[0]) === '[discord-mcpl] Client initialized (MCP mode)'),
      'notifications/initialized is still read and logged, by the main loop',
    );
  });

  it("an MCPL host's policy sent before notifications/initialized is answered, and still holds after it", async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    t.mock.method(console, 'error', () => {});
    const serverPromise = server.serve(serverConn);
    let receipt: { accepted?: boolean } | undefined;
    let history: { content: Array<{ text?: string }>; isError?: boolean } | undefined;
    try {
      await client.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true, channels: true, rollback: true } } },
        clientInfo: { name: 'test-early-policy', version: '0.1.0' },
      });
      // The policy comes before notifications/initialized: the handshake used
      // to read it in that slot and drop it.
      receipt = (await client.sendRequest('featureSets/update', { disabled: ['discord.history'] }, 5_000)) as typeof receipt;
      client.sendNotification('notifications/initialized');
      // Answer the server's own requests (channel registration) as they come.
      void (async () => {
        try {
          for (;;) {
            const m = await client.nextMessage();
            if (m.type === 'request') client.sendResponse(m.request.id, {});
          }
        } catch { /* closed */ }
      })();
      history = (await client.sendRequest(
        'tools/call',
        { name: 'fetch_history', arguments: { channelId: 'discord:g1:c1' } },
        5_000,
      )) as typeof history;
    } finally {
      client.close();
      await serverPromise;
    }

    assert.equal(receipt?.accepted, true, 'the early policy was answered');
    assert.equal(history?.isError, true, "the policy's disable held past notifications/initialized");
    assert.match(history?.content[0]?.text ?? '', /Feature set 'discord\.history' is not enabled/);
  });

  it("a request whose handler throws something that isn't an Error is answered, and serving goes on", async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    (server as unknown as { handleChannelClose: () => never }).handleChannelClose = () => {
      throw undefined;
    };
    const serverPromise = server.serve(serverConn);
    let refusal: unknown;
    let answered = false;
    try {
      await mcpHandshake(client);
      t.mock.method(console, 'error', () => {});
      refusal = await client
        .sendRequest('channels/close', { channelId: 'discord:g1:c1' }, 5_000)
        .then(() => 'answered with a result', (err: unknown) => err);
      answered = await answeredWithin(client.sendRequest('tools/list', {}), 5_000);
    } finally {
      client.close();
      await serverPromise;
    }

    const { code, message } = refusal as { code?: number; message?: string };
    assert.equal(code, -32603, `answered with an internal error: ${String(message)}`);
    // mcpl-core's RpcError prefixes the code to the server's message.
    assert.match(String(message), /-32603: undefined$/, 'the thrown value as text');
    assert.equal(answered, true, 'the next request was answered');
  });

  it('a request the server fails to answer leaves the loop reading', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const internals = server as unknown as { handleRequest: (req: { method: string }) => Promise<void> };
    const answer = internals.handleRequest.bind(server);
    let failed = false;
    // handleRequest answers its own errors; this stands in for a failure in that answering.
    internals.handleRequest = async (req) => {
      if (!failed && req.method === 'tools/list') {
        failed = true;
        throw new Error('could not answer');
      }
      return answer(req);
    };
    const serverPromise = server.serve(serverConn);
    let first: unknown;
    let second = false;
    let errors: ReturnType<typeof t.mock.method>;
    try {
      await mcpHandshake(client);
      errors = t.mock.method(console, 'error', () => {});
      first = await client.sendRequest('tools/list', {}, 1_000).then(() => 'answered', (err: unknown) => err);
      second = await answeredWithin(client.sendRequest('tools/list', {}), 5_000);
    } finally {
      client.close();
      await serverPromise;
    }

    assert.match(String((first as { message?: string }).message), /timed out/, 'the failed request went unanswered');
    assert.equal(second, true, 'the next request was answered');
    assert.ok(
      errors!.mock.calls.some((c) => /request tools\/list was not answered/.test(String(c.arguments[0]))),
      'the failure was logged',
    );
  });

  it('start-up work that fails outside its own catches is logged, not left unhandled', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    // The policy gate never rejects; this stands in for anything that could
    // fail outside the registration's and the sweep's own catches.
    const rejected = Promise.reject(Object.create(null));
    rejected.catch(() => {});
    (server as unknown as { policyAnswered: Promise<void> }).policyAnswered = rejected;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const errors = t.mock.method(console, 'error', () => {});
    const lines = () => errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
    const serverPromise = server.serve(serverConn);
    try {
      await mcpHandshake(client);
      for (let i = 0; i < 100 && !lines().some((l) => /start-up work failed/.test(l)); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      client.close();
      await serverPromise;
    }

    assert.ok(lines().includes('[discord-mcpl] Background start-up work failed: [an unprintable object]'), JSON.stringify(lines()));
    assert.deepEqual(unhandled, [], 'no rejection was left unhandled');
  });

  it("start-up registration and sweep failures that aren't Errors are logged, not left unhandled", async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const internals = server as unknown as {
      registerDiscordChannels: () => Promise<void>;
      runReconnectSweep: () => Promise<void>;
    };
    internals.registerDiscordChannels = async () => {
      throw undefined;
    };
    // An object with no prototype can't even be turned into a string.
    internals.runReconnectSweep = async () => {
      throw Object.create(null);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const errors = t.mock.method(console, 'error', () => {});
    const lines = () => errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
    const serverPromise = server.serve(serverConn);
    try {
      // Its featureSets/update answers the policy, which releases the start-up work.
      await mcplHandshake(client);
      for (let i = 0; i < 100 && !lines().some((l) => /sweep failed/.test(l)); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // A turn more, for a rejection nothing handled to be reported.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      client.close();
      await serverPromise;
    }

    assert.ok(lines().includes('[discord-mcpl] Channel registration failed: undefined'), JSON.stringify(lines()));
    assert.ok(lines().includes('[discord-mcpl] Reconnect catch-up sweep failed: [an unprintable object]'), JSON.stringify(lines()));
    assert.deepEqual(unhandled, [], 'no rejection was left unhandled');
  });

  it("non-Error failures inside the start-up work are logged, and the sweep goes on to its next channel", async (t) => {
    const wmPath = join(tmpdir(), `discord-mcpl-wm-${process.pid}-sweep-nonerror.json`);
    writeFileSync(wmPath, JSON.stringify({ watermarks: { c1: '100', c2: '100' }, dmChannels: [] }));
    process.env.DISCORD_WATERMARK_FILE = wmPath;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    try {
      const { client, serverConn, discord } = await createTestPair();
      const mention = { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> ping', cleanContent: '@bot ping', attachments: [], mentionsBot: true, timestamp: new Date(), reactions: [] };
      // The sweep takes c1 first. Its fetch rejects with undefined, so its
      // catch, and not a stub around the sweep, meets the value.
      (discord as unknown as { fetchHistory: (channelId: string) => Promise<unknown> }).fetchHistory = (channelId) =>
        channelId === 'c1' ? Promise.reject(undefined) : Promise.resolve([mention]);
      // Registration's own request rejects with undefined too.
      const send = serverConn.sendRequest.bind(serverConn);
      serverConn.sendRequest = ((m: string, p?: unknown, timeout?: number) =>
        m === method.CHANNELS_REGISTER ? Promise.reject(undefined) : send(m as never, p as never, timeout)) as typeof serverConn.sendRequest;
      const errors = t.mock.method(console, 'error', () => {});
      const lines = () => errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      let pushed: unknown;
      try {
        await mcplHandshake(client);
        const missed = await nextWithin(client);
        if (missed.type === 'request') {
          pushed = (missed.request.params as PushEventParams).eventId;
          client.sendResponse(missed.request.id, {});
        }
        // A turn more, for a rejection nothing handled to be reported.
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        client.close();
        await serverPromise;
      }

      assert.equal(pushed, 'discord_missed_c2_102', "c2's missed mention is delivered after c1's fetch failed");
      assert.ok(lines().includes('[discord-mcpl] Failed to register channels: undefined'), JSON.stringify(lines()));
      assert.ok(!lines().some((l) => /failed:|TypeError/.test(l) && !/Failed to register channels/.test(l)), JSON.stringify(lines()));
      assert.deepEqual(unhandled, [], 'no rejection was left unhandled');
    } finally {
      delete process.env.DISCORD_WATERMARK_FILE;
      if (existsSync(wmPath)) unlinkSync(wmPath);
    }
  });

  it('an error on the connection after serve() returns is logged, not thrown', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const errors = t.mock.method(console, 'error', () => {});
    const serverPromise = server.serve(serverConn);
    await mcpHandshake(client);
    client.close();
    await serverPromise;
    // mcpl-core forwards its streams' errors to the connection for as long as
    // the streams exist, after serve() has returned too. An 'error' nothing
    // listens for is thrown, and from a stream's callback it ends the process.
    assert.doesNotThrow(() => serverConn.emit('error', new Error('write EPIPE')));
    const lines = errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
    assert.ok(lines.includes('[discord-mcpl] Connection error: write EPIPE'), JSON.stringify(lines));
  });

  it('a connection serve() ends unexpectedly is closed, not left open', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    // Whatever the assertions find, an open socket would keep the runner from exiting.
    t.after(() => client.close());
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    (server as unknown as { handleInitialize: () => Promise<void> }).handleInitialize = async () => {
      throw new Error('a fault in the handshake');
    };
    t.mock.method(console, 'error', () => {});
    const clientClosed = new Promise<boolean>((resolve) => {
      client.once('close', () => resolve(true));
      const timer = setTimeout(() => resolve(false), 5_000);
      (timer as { unref?: () => void }).unref?.();
    });
    await server.serve(serverConn);

    assert.equal(serverConn.isClosed, true, "serve() closed its connection");
    assert.equal(await clientClosed, true, 'the client saw its connection end');
  });

  it('serveStdio exits 0 once the host closes stdin, mid-session', async (t) => {
    // The host's side writes to the server's stdin and reads its stdout.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const serverConn = McplConnection.fromStreams(stdin, stdout);
    const host = McplConnection.fromStreams(stdout, stdin);
    const server = new DiscordMcplServer(new MockDiscordAdapter() as unknown as DiscordAdapter);
    const errors = t.mock.method(console, 'error', () => {});
    const exits: number[] = [];
    const served = serveStdio(server, serverConn, (code) => exits.push(code));
    try {
      await mcpHandshake(host);
      assert.equal(await answeredWithin(host.sendRequest('tools/list', {}), 5_000), true);
      assert.deepEqual(exits, [], 'no exit while the host is there');
      stdin.end(); // the host closes the server's stdin
      const ended = await Promise.race([
        served.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      assert.equal(ended, true, 'serveStdio returned once stdin ended');
    } finally {
      host.close();
    }

    assert.deepEqual(exits, [0]);
    const lines = errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
    assert.ok(lines.includes('[discord-mcpl] stdio connection ended; exiting'), JSON.stringify(lines));
  });

  it('before initialize, a ping is answered, another request is refused, a notification is dropped, and the session still starts', async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    let registered = false;
    (server as unknown as { registerDiscordChannels: () => Promise<void> }).registerDiscordChannels = async () => {
      registered = true;
    };
    const errors = t.mock.method(console, 'error', () => {});
    const lines = () => errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
    const serverPromise = server.serve(serverConn);
    let pong: unknown;
    let refusal: unknown;
    let registeredBeforeInitialize: boolean | undefined;
    let pongAfter: unknown;
    try {
      client.sendNotification('notifications/cancelled', { requestId: 1 });
      pong = await client.sendRequest('ping', {}, 5_000);
      refusal = await client.sendRequest('tools/list', {}, 5_000).then(() => 'answered with a result', (err: unknown) => err);
      registeredBeforeInitialize = registered;
      // Its featureSets/update answers the policy, which releases the start-up work.
      await mcplHandshake(client);
      for (let i = 0; i < 100 && !registered; i++) await new Promise((r) => setTimeout(r, 20));
      pongAfter = await client.sendRequest('ping', {}, 5_000);
    } finally {
      client.close();
      await serverPromise;
    }

    assert.deepEqual(pong, {}, 'a ping before initialize gets an empty result');
    const { code, message } = refusal as { code?: number; message?: string };
    assert.equal(code, -32002, `a request before initialize is refused: ${String(message)}`);
    assert.match(String(message), /send initialize before tools\/list/);
    assert.equal(registeredBeforeInitialize, false, 'no start-up work before initialize');
    assert.equal(registered, true, 'the start-up work ran once the session started');
    assert.deepEqual(pongAfter, {}, 'a ping after initialize gets an empty result too');
    assert.ok(lines().includes('[discord-mcpl] notifications/cancelled before initialize: dropped'), JSON.stringify(lines()));
    assert.ok(lines().includes('[discord-mcpl] tools/list before initialize: refused'), JSON.stringify(lines()));
  });

  it("a handler that throws an Error with no message is answered with the Error's name", async (t) => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    (server as unknown as { handleChannelClose: () => never }).handleChannelClose = () => {
      throw new Error('');
    };
    const serverPromise = server.serve(serverConn);
    let refusal: unknown;
    try {
      await mcpHandshake(client);
      t.mock.method(console, 'error', () => {});
      refusal = await client
        .sendRequest('channels/close', { channelId: 'discord:g1:c1' }, 5_000)
        .then(() => 'answered with a result', (err: unknown) => err);
    } finally {
      client.close();
      await serverPromise;
    }

    const { code, message } = refusal as { code?: number; message?: string };
    assert.equal(code, -32603);
    // mcpl-core's RpcError prefixes the code to the server's message.
    assert.match(String(message), /-32603: Error$/, 'an empty message falls back to the value as text');
  });

  it('tools/list returns tool definitions', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/list', {})) as { tools: Array<{ name: string }> };
    assert.ok(result.tools.length > 0);
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('send_message'));
    assert.ok(names.includes('list_channels'));
    assert.ok(names.includes('fetch_history'));

    client.close();
    await serverPromise;
  });

  it('tools/list carries MCPL RFC-008 classes in _meta on every classed tool', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/list', {})) as {
      tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
    };
    for (const tool of result.tools) {
      if (Object.hasOwn(TOOL_CLASSES, tool.name)) {
        assert.deepEqual(tool._meta?.['mcpl/class'], [...TOOL_CLASSES[tool.name]], tool.name);
      } else {
        assert.equal(tool._meta?.['mcpl/class'], undefined, tool.name);
      }
    }
    const send = result.tools.find((t) => t.name === 'send_message');
    assert.deepEqual(send?._meta?.['mcpl/class'], ['comms', 'files']);

    client.close();
    await serverPromise;
  });

  it('tools/call list_channel_members returns the membership snapshot', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'list_channel_members',
      arguments: { channelId: 'c1' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    assert.ok(!result.isError);
    const payload = JSON.parse(result.content[0]?.text ?? 'null');
    assert.equal(payload.channelId, 'c1');
    assert.equal(payload.scope, 'guild-channel');
    assert.equal(payload.total, 3);
    assert.equal(payload.members.length, 3);
    assert.equal(payload.members[0].username, 'ra');
    assert.equal(payload.truncated, false);

    client.close();
    await serverPromise;
  });

  it('tools/call send_message works', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'send_message',
      arguments: { channelId: 'c1', content: 'Hello from test!' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    assert.ok(!result.isError);
    assert.equal(discord.sentMessages.length, 1);
    assert.equal(discord.sentMessages[0].channelId, 'c1');
    assert.equal(discord.sentMessages[0].content, 'Hello from test!');

    client.close();
    await serverPromise;
  });

  it('tools/call remove_reaction removes only this bot reaction through the adapter', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'remove_reaction',
      arguments: { channelId: 'c1', messageId: 'm1', emoji: '🫥' },
    })) as { isError?: boolean };

    assert.ok(!result.isError);
    assert.deepEqual(discord.removedReactions, [
      { channelId: 'c1', messageId: 'm1', emoji: '🫥' },
    ]);

    client.close();
    await serverPromise;
  });

  it('/undo leaves awareness reactions to the host durable ledger', async () => {
    const discord = new MockDiscordAdapter();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter) as any;
    server.conn = {
      sendRequest: async () => ({
        ok: true,
        messagesRemoved: 1,
        removedRefs: [
          { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
        ],
        lastVisible: null,
      }),
    };
    let reply = '';
    const interaction = {
      commandName: 'undo',
      user: { id: 'admin-1', username: 'Admin' },
      channelId: 'c1',
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async (content: string) => { reply = content; },
      reply: async () => {},
    };
    const previousAdmins = process.env.DISCORD_ADMIN_USERS;
    process.env.DISCORD_ADMIN_USERS = 'admin-1';
    try {
      await server.handleSlashCommand(interaction);
    } finally {
      if (previousAdmins === undefined) delete process.env.DISCORD_ADMIN_USERS;
      else process.env.DISCORD_ADMIN_USERS = previousAdmins;
    }

    assert.equal(discord.reactions.length, 0);
    assert.match(reply, /old branch preserved/);
  });

  it('tools/call list_guilds works', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'list_guilds',
      arguments: {},
    })) as { content: Array<{ type: string; text?: string }> };

    const text = result.content[0]?.text ?? '';
    assert.ok(text.includes('Test Guild'));

    client.close();
    await serverPromise;
  });

  it('push event from Discord message (non-open channel)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Simulate a Discord message (mentioning the bot so it passes the filter)
    discord.simulateMessage({
      id: 'dm1',
      content: 'Hello agent!',
      cleanContent: 'Hello agent!',
      authorId: 'u1',
      authorName: 'Alice',
      isBot: false,
      channelId: 'c1',
      channelName: 'general',
      guildId: 'g1',
      guildName: 'Test Server',
      mentions: ['bot_123'],
      replyToId: 'parent-closed-42',
      replyToUserId: 'u_fable',
      replyToUserName: 'Fable',
      attachments: [],
      timestamp: new Date(),
    });

    // Should receive push/event (channel not open)
    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      assert.equal(pushMsg.request.method, 'push/event');
      const p = pushMsg.request.params as PushEventParams;
      assert.equal(p.featureSet, 'discord.messaging');
      assert.ok(p.payload.content[0].type === 'text');
      const rendered = (p.payload.content[0] as { text?: string }).text ?? '';
      assert.ok(!rendered.includes('<backscroll'), 'a closed-channel mention must not auto-fetch history');
      assert.ok(rendered.includes('[replying to @Fable]'));
      const origin = p.origin as Record<string, unknown>;
      assert.equal(origin.replyTo, 'parent-closed-42');
      assert.equal(origin.replyToAuthorId, 'u_fable');
      assert.equal(origin.replyToAuthorName, 'Fable');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('first inbound DM carries a reply affordance (send_dm by sender name/id)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Simulate an inbound DM (guildId null → DM; needs no mention to forward).
    discord.simulateMessage({
      id: 'dmmsg1',
      content: 'hey, can you help?',
      cleanContent: 'hey, can you help?',
      authorId: 'u_alice',
      authorName: 'Alice',
      isBot: false,
      channelId: 'dmchan1',
      channelName: undefined,
      guildId: null,
      guildName: undefined,
      mentions: [],
      attachments: [],
      timestamp: new Date(),
    } as unknown as DiscordMessageData);

    // The first inbound DM registers the channel as a real descriptor and
    // announces it via channels/changed BEFORE the push/event — that's what
    // lets channel_open/isOpen resolve DM ids so open state sticks
    // (the Mythos reopen-every-message complaint, 2026-07-18/24).
    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string; label?: string }> };
      assert.ok(p.added?.some((d) => d.id === 'discord:dm:dmchan1'), 'DM channel should be announced');
      assert.ok(
        p.added?.some((d) => d.id === 'discord:dm:dmchan1' && d.label === 'DM: Alice'),
        'DM descriptor should be labeled with the sender',
      );
    }

    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      assert.equal(pushMsg.request.method, 'push/event');
      const p = pushMsg.request.params as PushEventParams;
      const text = (p.payload.content[0] as { text?: string }).text ?? '';
      // The bare body is still there…
      assert.ok(text.includes('Alice: hey, can you help?'), 'DM body should render the sender');
      // …plus an explicit, in-context reply affordance so the agent knows it can
      // reply by name/id rather than needing the bot's own user id (the complaint).
      assert.ok(text.includes('Direct message from @Alice'), 'DM should announce the sender');
      assert.ok(text.includes('send_dm("Alice")'), 'DM should suggest replying by sender name');
      assert.ok(text.includes('send_dm("u_alice")'), 'DM should offer the id fallback');
      // The chat:dm tags still ride along for the host gate.
      assert.ok(p.tags?.includes('chat:dm'), 'DM should carry the chat:dm tag');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('first-DM backscroll lines carry current reaction state (issue #31)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    // One earlier message in the DM, with a live reaction on it.
    discord.historyToReturn = [
      {
        id: 'old1', authorId: 'u_bob', authorName: 'Bob', isBot: false,
        content: 'earlier note', cleanContent: 'earlier note', attachments: [],
        mentionsBot: false, timestamp: new Date(1700000000000),
        reactions: [{ emoji: '😀', emojiId: null, token: '😀', count: 3, me: false }],
      },
    ];
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    discord.simulateMessage({
      id: 'dmmsg2', content: 'hi again', cleanContent: 'hi again',
      authorId: 'u_bob', authorName: 'Bob', isBot: false,
      channelId: 'dmchan2', channelName: undefined, guildId: null, guildName: undefined,
      mentions: [], attachments: [], timestamp: new Date(),
    } as unknown as DiscordMessageData);

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');

    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      const p = pushMsg.request.params as PushEventParams;
      const text = (p.payload.content[0] as { text?: string }).text ?? '';
      assert.ok(text.includes('<backscroll'), 'first DM renders backscroll');
      const line = text.split('\n').find((l) => l.includes('earlier note'));
      assert.ok(line?.includes('[reactions: 😀 x3]'), `backscroll line shows current reaction state: ${line}`);
      // The triggering message itself has no fetched reaction state and no
      // suffix — absence must honestly mean "none", not "unknown".
      const trigger = text.split('\n').find((l) => l.includes('hi again'));
      assert.ok(trigger && !trigger.includes('[reactions:'), 'no suffix on the live triggering message');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('channels/incoming from Discord message (open channel)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Open a channel
    const openResult = (await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'discord',
      address: { guildId: 'g1', channelId: 'c1' },
    })) as ChannelsOpenResult;
    assert.ok(openResult.channel.id.includes('c1'));

    // Simulate a Discord message on the open channel (mentioning bot)
    discord.simulateMessage({
      id: 'dm2',
      content: 'Message on open channel',
      cleanContent: 'Message on open channel',
      authorId: 'u1',
      authorName: 'Bob',
      isBot: false,
      channelId: 'c1',
      channelName: 'general',
      guildId: 'g1',
      guildName: 'Test Server',
      mentions: ['bot_123'],
      attachments: [],
      timestamp: new Date(),
    });

    // Should receive channels/incoming (not push/event)
    const inMsg = await client.nextMessage();
    assert.equal(inMsg.type, 'request');
    if (inMsg.type === 'request') {
      assert.equal(inMsg.request.method, 'channels/incoming');
      const p = inMsg.request.params as ChannelsIncomingParams;
      assert.equal(p.messages.length, 1);
      assert.equal(p.messages[0].author.name, 'Bob');
      client.sendResponse(inMsg.request.id, { results: [{ messageId: 'dm2', accepted: true }] });
    }

    client.close();
    await serverPromise;
  });

  /** A server whose channel list registers a thread, th1, as its own channel
   *  under #general (c1), so a host can open it. Every wait here is bounded,
   *  so a message the server never sends fails the test instead of hanging
   *  the run, and the pair is closed when the test ends, whatever it asserted. */
  async function threadServer(t: TestContext) {
    const { client, serverConn, discord } = await createTestPair();
    discord.getTextChannels = () => [
      { guildId: 'g1', guildName: 'Test Server', channel: { id: 'c1', name: 'general', type: 'text', label: '#general (Test Server)' } },
      { guildId: 'g1', guildName: 'Test Server', channel: { id: 'th1', name: 'design-chat', type: 'thread', parentId: 'c1', label: '#design-chat (Test Server)' } },
    ];
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);
    t.after(async () => {
      client.close();
      await serverPromise;
    });
    await mcplHandshake(client);
    const reg = await nextWithin(client);
    if (reg.type === 'request') client.sendResponse(reg.request.id, {});
    /** The server's next message, which must be a request of this method. */
    const nextRequest = async (expected: string) => {
      const m = await nextWithin(client);
      if (m.type !== 'request') assert.fail(`expected a ${expected} request, got a ${m.type}`);
      assert.equal(m.request.method, expected);
      return m.request;
    };
    return { client, discord, nextRequest };
  }

  /** A message as convertMessage reports one posted IN thread th1: Discord
   *  threads are channels, so its channel is the thread. */
  const inThread = (id: string, extra: Partial<DiscordMessageData> = {}): DiscordMessageData => ({
    id, content: 'in the thread', cleanContent: 'in the thread',
    authorId: 'u1', authorName: 'Bob', isBot: false,
    channelId: 'th1', channelName: 'design-chat', guildId: 'g1', guildName: 'Test Server',
    threadId: 'th1', threadName: 'design-chat', threadParentName: 'general',
    mentions: ['bot_123'], attachments: [], timestamp: new Date(),
    ...extra,
  });

  it("delivers a thread's message under the thread's own channel on both lanes, with the same thread fields", async (t) => {
    const { client, discord, nextRequest } = await threadServer(t);
    // The parent stays open throughout, so a message routed by its parent
    // would show as the parent's.
    await client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    await client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'th1' } });
    const expected = { threadName: 'design-chat', threadParentName: 'general' };

    // The thread is open: channels/incoming.
    discord.simulateMessage(inThread('th-open'));
    const incoming = await nextRequest('channels/incoming');
    client.sendResponse(incoming.id, { results: [{ messageId: 'th-open', accepted: true }] });
    const m = (incoming.params as ChannelsIncomingParams).messages[0] as unknown as Record<string, unknown>;
    assert.equal(m.channelId, 'discord:g1:th1', "the thread's own channel, not its open parent's");
    assert.equal('threadId' in m, false, 'a Discord thread is its own channel: no MCPL threadId');
    const metadata = m.metadata as Record<string, unknown>;
    assert.deepEqual({ threadName: metadata.threadName, threadParentName: metadata.threadParentName }, expected);
    assert.ok((m.tags as string[]).includes('chat:thread'));
    const text = (m.content as Array<{ text: string }>)[0].text;
    assert.ok(text.startsWith('[#general thread "design-chat" in Test Server] Bob:'), text);

    // The thread is closed and its parent still open: a mention is pushed.
    await client.sendRequest('channels/close', { channelId: 'discord:g1:th1' });
    discord.simulateMessage(inThread('th-closed'));
    const push = await nextRequest('push/event');
    client.sendResponse(push.id, { accepted: true });
    const p = push.params as PushEventParams;
    const origin = p.origin as Record<string, unknown>;
    assert.equal(origin.mcplChannelId, 'discord:g1:th1', "the thread's own channel, not its open parent's");
    assert.equal('threadId' in origin, false, 'a Discord thread is its own channel: no MCPL threadId');
    assert.deepEqual({ threadName: origin.threadName, threadParentName: origin.threadParentName }, expected);
    assert.ok(p.tags?.includes('chat:thread'));
  });

  it('gives a channel message no thread tag, threadId or thread location', async (t) => {
    // A message that started a thread is such a message: the adapter's test
    // (thread-semantics.test.ts) checks that convertMessage reports it with no
    // thread fields. This checks what the server makes of one.
    const { client, discord, nextRequest } = await threadServer(t);
    await client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    discord.simulateMessage({
      id: 'starter', content: 'kick off', cleanContent: 'kick off',
      authorId: 'u1', authorName: 'Bob', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: ['bot_123'], attachments: [], timestamp: new Date(),
    });
    const incoming = await nextRequest('channels/incoming');
    client.sendResponse(incoming.id, { results: [{ messageId: 'starter', accepted: true }] });
    const m = (incoming.params as ChannelsIncomingParams).messages[0] as unknown as Record<string, unknown>;
    assert.equal('threadId' in m, false);
    assert.equal((m.tags as string[]).includes('chat:thread'), false);
    const metadata = m.metadata as Record<string, unknown>;
    assert.equal('threadName' in metadata || 'threadParentName' in metadata, false);
    const text = (m.content as Array<{ text: string }>)[0].text;
    assert.ok(text.startsWith('[#general in Test Server] Bob:'), text);
  });

  it("locates a thread's message when its parent or its name isn't known", async (t) => {
    const { client, discord, nextRequest } = await threadServer(t);
    // Nothing is open, so both are pushed; each is in a new channel, so each
    // carries the location.
    discord.simulateMessage(inThread('no-parent', { threadParentName: null }));
    const first = await nextRequest('push/event');
    client.sendResponse(first.id, { accepted: true });
    discord.simulateMessage(inThread('no-name', { channelId: 'th2', threadId: 'th2', channelName: null, threadName: undefined }));
    const second = await nextRequest('push/event');
    client.sendResponse(second.id, { accepted: true });
    const textOf = (r: { params?: unknown }) => ((r.params as PushEventParams).payload.content[0] as { text: string }).text;
    assert.ok(textOf(first).startsWith('[thread "design-chat" in Test Server] Bob:'), textOf(first));
    assert.ok(textOf(second).startsWith('[#general thread "th2" in Test Server] Bob:'), textOf(second));
    const firstOrigin = (first.params as PushEventParams).origin as Record<string, unknown>;
    const secondOrigin = (second.params as PushEventParams).origin as Record<string, unknown>;
    assert.equal('threadParentName' in firstOrigin, false, 'an unknown parent is left out');
    assert.equal('threadName' in secondOrigin, false, 'an unknown name is left out');
  });

  it("carries a thread message's tag and thread fields on its edit and its delete", async (t) => {
    const { client, discord, nextRequest } = await threadServer(t);
    await client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'th1' } });
    // As the adapter reports an edit or delete of a message posted in th1.
    const info = { guildId: 'g1', authorName: 'Bob', threadId: 'th1', threadName: 'design-chat', threadParentName: 'general' };
    discord.simulateEdit('th1', 'm1', 'second version', false, { ...info, editedAt: '2026-10-02T00:00:01.000Z' });
    const edit = await nextRequest('push/event');
    client.sendResponse(edit.id, { accepted: true });
    discord.simulateDelete('th1', 'm1', false, info);
    const del = await nextRequest('push/event');
    client.sendResponse(del.id, { accepted: true });
    for (const [request, tag] of [[edit, 'chat:edited'], [del, 'chat:deleted']] as const) {
      const p = request.params as PushEventParams;
      assert.deepEqual(p.tags, [tag, 'chat:thread']);
      const origin = p.origin as Record<string, unknown>;
      assert.equal(origin.mcplChannelId, 'discord:g1:th1');
      assert.equal('threadId' in origin, false);
      assert.equal(origin.threadName, 'design-chat', tag);
      assert.equal(origin.threadParentName, 'general', tag);
    }
  });

  /** One reconnect sweep over a channel with one missed mention, the channel
   *  described as the adapter's cache gives it; returns the sweep's push. */
  async function sweepOne(channelId: string, meta: ChannelMeta): Promise<PushEventParams> {
    const wmPath = join(tmpdir(), `discord-mcpl-wm-${process.pid}-sweep-${channelId}.json`);
    writeFileSync(wmPath, JSON.stringify({ watermarks: { [channelId]: '100' }, dmChannels: [] }));
    process.env.DISCORD_WATERMARK_FILE = wmPath;
    try {
      const { client, serverConn, discord } = await createTestPair();
      discord.historyToReturn = [
        { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> ping', cleanContent: '@bot ping', attachments: [], mentionsBot: true, timestamp: new Date(), reactions: [] },
      ];
      discord.cachedChannelMeta = { [channelId]: meta };
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      try {
        await mcplHandshake(client);
        const reg = await nextWithin(client);
        if (reg.type === 'request') client.sendResponse(reg.request.id, {});
        const missed = await nextWithin(client);
        if (missed.type !== 'request') assert.fail(`expected the sweep's push, got a ${missed.type}`);
        client.sendResponse(missed.request.id, {});
        assert.equal(missed.request.method, method.PUSH_EVENT);
        return missed.request.params as PushEventParams;
      } finally {
        client.close();
        await serverPromise;
      }
    } finally {
      delete process.env.DISCORD_WATERMARK_FILE;
      if (existsSync(wmPath)) unlinkSync(wmPath);
    }
  }

  it("the reconnect sweep names a thread's missed messages as the live path does", async () => {
    // As the adapter reads a thread from the channel cache.
    const p = await sweepOne('th1', {
      name: 'design-chat', guildId: 'g1', guildName: 'Test Guild', isDM: false,
      threadId: 'th1', threadName: 'design-chat', threadParentName: 'general',
    });
    const origin = p.origin as Record<string, unknown>;
    assert.equal(origin.mcplChannelId, 'discord:g1:th1');
    assert.equal('threadId' in origin, false);
    assert.equal(origin.threadName, 'design-chat');
    assert.equal(origin.threadParentName, 'general');
    assert.deepEqual(p.tags, ['chat:thread']);
    const text = (p.payload.content[0] as { text: string }).text;
    assert.ok(text.startsWith('<missed channel="#general" thread="design-chat" channelId="th1" guild="Test Guild"'), text);
  });

  it("the reconnect sweep's header quotes a name that holds a quote", async () => {
    // A voice channel's name may hold quotes, and its text chat is swept like
    // any channel; so may a thread's.
    const voice = await sweepOne('vc1', { name: 'Movie "night"', guildId: 'g1', guildName: 'Test Guild', isDM: false });
    const voiceText = (voice.payload.content[0] as { text: string }).text;
    assert.ok(voiceText.startsWith('<missed channel="#Movie \\"night\\"" channelId="vc1" guild="Test Guild"'), voiceText);
    const thread = await sweepOne('th2', {
      name: 'the "plan"', guildId: 'g1', guildName: 'Test Guild', isDM: false,
      threadId: 'th2', threadName: 'the "plan"', threadParentName: 'general',
    });
    const threadText = (thread.payload.content[0] as { text: string }).text;
    assert.ok(threadText.startsWith('<missed channel="#general" thread="the \\"plan\\"" channelId="th2" guild="Test Guild"'), threadText);
  });

  it('renders reply target visibly and carries standard metadata on open channels', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});
    await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'discord',
      address: { guildId: 'g1', channelId: 'c1' },
    });

    discord.simulateMessage({
      id: 'reply1', content: 'go ahead', cleanContent: 'go ahead',
      authorId: 'u_antra', authorName: 'Antra', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      replyToId: 'parent42', replyToUserId: 'u_fable', replyToUserName: 'Fable',
      mentions: [], attachments: [], timestamp: new Date(),
    });

    const incoming = await client.nextMessage();
    assert.equal(incoming.type, 'request');
    if (incoming.type === 'request') {
      const p = incoming.request.params as ChannelsIncomingParams;
      const msg = p.messages[0];
      const text = (msg.content[0] as { text?: string }).text ?? '';
      assert.ok(text.includes('[replying to @Fable]'));
      assert.ok(text.includes('Antra: go ahead'));
      const metadata = (msg.metadata ?? {}) as Record<string, unknown>;
      assert.equal(metadata.replyTo, 'parent42');
      assert.equal(metadata.replyToAuthorId, 'u_fable');
      assert.equal(metadata.replyToAuthorName, 'Fable');
      client.sendResponse(incoming.request.id, { results: [{ messageId: 'reply1', accepted: true }] });
    }

    client.close();
    await serverPromise;
  });

  it('open/close own Discord subscription lifecycle, history, and acknowledgment', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    discord.historyToReturn = [{
      id: 'old1', authorId: 'u1', authorName: 'Alice', isBot: false,
      content: 'prior context', cleanContent: 'prior context', attachments: [],
      mentionsBot: false, timestamp: new Date('2026-01-01T00:00:00Z'),
    }];
    const opened = await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1',
      type: 'discord',
      address: { guildId: 'g1', channelId: 'c1' },
      history: { limit: 10, beforeMessageId: 'trigger1' },
    }) as ChannelsOpenResult & { history?: ChannelsIncomingParams['messages'] };
    assert.equal(opened.channel.id, 'discord:g1:c1');
    assert.equal(opened.history?.length, 1);
    assert.equal(opened.history?.[0].messageId, 'old1');

    const ack = await client.sendRequest('channels/acknowledge', {
      channelId: 'discord:g1:c1',
      messageId: 'trigger1',
      intent: 'seen-not-opening',
      value: '👀',
    }) as { acknowledged: boolean; representation?: string };
    assert.equal(ack.acknowledged, true);
    assert.equal(ack.representation, '👀');
    assert.deepEqual(discord.reactions, [{ channelId: 'c1', messageId: 'trigger1', emoji: '👀' }]);

    const closed = await client.sendRequest('channels/close', {
      channelId: 'discord:g1:c1',
    }) as { closed: boolean };
    assert.equal(closed.closed, true);

    discord.simulateMessage({
      id: 'after-close', content: 'still there?', cleanContent: 'still there?',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Guild',
      mentions: ['bot_123'], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    const pushed = await client.nextMessage();
    assert.equal(pushed.type, 'request');
    if (pushed.type === 'request') {
      assert.equal(pushed.request.method, 'push/event');
      client.sendResponse(pushed.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('channels/publish sends Discord message', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    const pubResult = (await client.sendRequest(method.CHANNELS_PUBLISH, {
      conversationId: 'conv_1',
      channelId: 'discord:g1:c1',
      content: [{ type: 'text', text: 'Published message!' }],
    })) as ChannelsPublishResult;

    assert.ok(pubResult.delivered);
    assert.equal(discord.sentMessages.length, 1);
    assert.equal(discord.sentMessages[0].content, 'Published message!');

    client.close();
    await serverPromise;
  });

  it('guildCreate registers new guild channels via channels/changed', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept the initial channel registration.
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // Bot joins a new guild after startup.
    discord.simulateGuildCreate('g2', 'Second Guild', [
      { id: 'c10', name: 'lobby', type: 'text', label: '#lobby (TestGuild)' },
      { id: 'c11', name: 'random', type: 'text', label: '#random (TestGuild)' },
    ]);

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 2);
      assert.ok(p.added!.some((d) => d.id === 'discord:g2:c10'));
      assert.ok(p.added!.some((d) => d.id === 'discord:g2:c11'));
    }

    client.close();
    await serverPromise;
  });

  it('channelAvailable registers a newly-permitted channel', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // Bot granted access to a pre-existing private channel in g1.
    discord.simulateChannelAvailable('g1', { id: 'c-private', name: 'secret', type: 'text', label: '#secret (TestGuild)' });

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 1);
      assert.equal(p.added![0].id, 'discord:g1:c-private');
    }

    client.close();
    await serverPromise;
  });

  it('refresh_channels registers channels visible after startup', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // The bot's view now includes a channel not present at boot.
    discord.getTextChannels = () => [
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c1', name: 'general', type: 'text', label: '#general (TestGuild)' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c2', name: 'dev', type: 'text', label: '#dev (TestGuild)' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c3', name: 'new-room', type: 'text', label: '#new-room (TestGuild)' } },
    ];

    const callP = client.sendRequest('tools/call', {
      name: 'refresh_channels',
      arguments: {},
    });

    // The refresh emits a channels/changed notification for the new channel.
    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 1);
      assert.equal(p.added![0].id, 'discord:g1:c3');
    }

    const result = (await callP) as { content: Array<{ type: string; text?: string }> };
    const payload = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(payload.visible, 3);
    assert.equal(payload.added.length, 1);
    assert.equal(payload.added[0].id, 'discord:g1:c3');

    client.close();
    await serverPromise;
  });

  it('reconnect sweep delivers missed mentions with nearby context from a non-subscribed channel', async () => {
    const wmPath = join(tmpdir(), `discord-mcpl-wm-${process.pid}-sweep.json`);
    writeFileSync(wmPath, JSON.stringify({ watermarks: { c1: '100' }, dmChannels: [] }));
    process.env.DISCORD_WATERMARK_FILE = wmPath;
    try {
      const { client, serverConn, discord } = await createTestPair();
      // Two messages arrived while offline: one plain, one @mentioning the bot.
      // Channel c1 is NOT subscribed, so the mention and its bounded vicinity
      // should be delivered, while the mention count remains one.
      const t = new Date();
      discord.historyToReturn = [
        { id: '101', authorId: 'u1', authorName: 'Alice', isBot: false, content: 'just chatting', cleanContent: 'just chatting', attachments: [], mentionsBot: false, timestamp: t, reactions: [] },
        { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> ping', cleanContent: '@bot ping', attachments: [], mentionsBot: true, timestamp: t, reactions: [
          { emoji: '👍', emojiId: null, token: '👍', count: 2, me: true },
          { emoji: ':blob:', emojiId: '333444555666777888', token: '<:blob:333444555666777888>', count: 1, me: false },
        ] },
      ];
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);

      await mcplHandshake(client);

      // Accept channel registration.
      const regMsg = await client.nextMessage();
      assert.equal(regMsg.type, 'request');
      if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

      // Next: the catch-up push/event for the missed mention.
      const missed = await client.nextMessage();
      assert.equal(missed.type, 'request');
      if (missed.type === 'request') {
        assert.equal(missed.request.method, method.PUSH_EVENT);
        const p = missed.request.params as PushEventParams;
        assert.equal(p.eventId, 'discord_missed_c1_102');
        const origin = p.origin as Record<string, unknown>;
        assert.equal(origin.isMention, true);
        assert.equal(origin.isDM, false);
        const text = (p.payload.content[0] as { text: string }).text;
        assert.ok(text.includes('count="1"'), 'only one delivered line is a mention');
        assert.ok(text.includes('lines="2"'), 'the nearby context line is included');
        assert.ok(text.includes('reason="mention"'));
        assert.ok(text.includes('Bob'), 'mention author present');
        assert.ok(text.includes('just chatting'), 'nearby non-mention context included');
        // Current NET reaction state rides along on missed lines (issue #31):
        // aggregate + count (+ bot-self), never an add/remove event replay.
        assert.ok(text.includes('[reactions: 👍 x2 (incl. me), :blob: x1]'), 'current reaction state on the mention line');
        const contextLine = text.split('\n').find((l) => l.includes('just chatting'));
        assert.ok(contextLine && !contextLine.includes('[reactions:'), 'no suffix on a reaction-less message — absence means none');
        client.sendResponse(missed.request.id, {});
      }

      client.close();
      await serverPromise;
    } finally {
      delete process.env.DISCORD_WATERMARK_FILE;
      if (existsSync(wmPath)) unlinkSync(wmPath);
    }
  });

  it("the reconnect sweep saves each channel's watermark as its block is accepted, so an exit mid-sweep can't replay it", async () => {
    const wmPath = join(tmpdir(), `discord-mcpl-wm-${process.pid}-sweep-progress.json`);
    writeFileSync(wmPath, JSON.stringify({ watermarks: { c1: '100', c2: '100' }, dmChannels: [] }));
    process.env.DISCORD_WATERMARK_FILE = wmPath;
    try {
      const { client, serverConn, discord } = await createTestPair();
      const t = new Date();
      const mention = { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> ping', cleanContent: '@bot ping', attachments: [], mentionsBot: true, timestamp: t, reactions: [] };
      // c1 has a missed mention; c2's fetch never finishes, as if the process
      // ended (the host closing stdio) while the sweep was still running.
      (discord as unknown as { fetchHistory: (channelId: string) => Promise<unknown> }).fetchHistory = (channelId) =>
        channelId === 'c2' ? new Promise(() => {}) : Promise.resolve([mention]);
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      try {
        await mcplHandshake(client);
        const reg = await nextWithin(client);
        if (reg.type === 'request') client.sendResponse(reg.request.id, {});
        const missed = await nextWithin(client);
        assert.equal(missed.type === 'request' && missed.request.method, method.PUSH_EVENT);
        if (missed.type === 'request') client.sendResponse(missed.request.id, {});
        // The push is answered; the save follows it synchronously. Give the
        // server a turn to read the answer.
        for (let i = 0; i < 50 && JSON.parse(readFileSync(wmPath, 'utf8')).watermarks.c1 !== '102'; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        client.close();
        await serverPromise;
      }
      const saved = JSON.parse(readFileSync(wmPath, 'utf8'));
      assert.equal(saved.watermarks.c1, '102', 'c1 is saved past its delivered block while the sweep is still on c2');
      assert.equal(saved.watermarks.c2, '100', 'c2 is untouched');
    } finally {
      delete process.env.DISCORD_WATERMARK_FILE;
      if (existsSync(wmPath)) unlinkSync(wmPath);
    }
  });

  it('reconnect sweep delivers nothing from a muted channel, its missed mentions included', async () => {
    const wmPath = join(tmpdir(), `discord-mcpl-wm-${process.pid}-sweep-muted.json`);
    const mutedPath = join(tmpdir(), `discord-mcpl-muted-${process.pid}-sweep-muted.json`);
    writeFileSync(wmPath, JSON.stringify({ watermarks: { c1: '100' }, dmChannels: [] }));
    writeFileSync(mutedPath, JSON.stringify(['c1']));
    process.env.DISCORD_WATERMARK_FILE = wmPath;
    process.env.DISCORD_MUTED_CHANNELS_FILE = mutedPath;
    try {
      const { client, serverConn, discord } = await createTestPair();
      const t = new Date();
      // The same missed mention the sweep delivers from an unmuted channel.
      discord.historyToReturn = [
        { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> ping', cleanContent: '@bot ping', attachments: [], mentionsBot: true, timestamp: t, reactions: [] },
      ];
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client);
      const regMsg = await client.nextMessage();
      if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

      // Nothing more arrives: the sweep skips the muted channel.
      const next = await Promise.race([
        // The read still pending at close() rejects; that rejection means nothing came.
        client.nextMessage().catch(() => null),
        new Promise<null>((resolve) => { const timer = setTimeout(() => resolve(null), 500); (timer as { unref?: () => void }).unref?.(); }),
      ]);
      client.close();
      await serverPromise;
      assert.equal(next, null, `no push from a muted channel, got ${JSON.stringify(next)?.slice(0, 200)}`);
    } finally {
      delete process.env.DISCORD_WATERMARK_FILE;
      delete process.env.DISCORD_MUTED_CHANNELS_FILE;
      for (const p of [wmPath, mutedPath]) if (existsSync(p)) unlinkSync(p);
    }
  });

  it('tracks missed ambient after unsubscribe and reports via channel_missed', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.sendRequest('tools/call', { name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = r.content[0]?.text ?? '';
      // Object-returning tools (channel_missed) serialize as JSON; string-
      // returning tools (subscribe/unsubscribe) come through as plain text.
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };

    // Open then close c1 — this anchors a missed-ambient tally.
    await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1', type: 'discord', address: { guildId: 'g1', channelId: 'c1' },
    });
    await client.sendRequest('channels/close', { channelId: 'discord:g1:c1' });

    // Ambient message in c1 (not a mention, not a DM, now unsubscribed) → dropped + tallied.
    discord.simulateMessage({
      id: 'm100', content: 'hello world', cleanContent: 'hello world',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: [], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    // Let the floating async message handler run.
    await new Promise((r) => setTimeout(r, 20));

    const missed = await call('channel_missed', { channelId: 'c1' });
    assert.equal(missed.subscribed, false);
    assert.equal(missed.tracked, true);
    assert.equal(missed.missedMessages, 1);
    assert.equal(missed.missedCharacters, 'hello world'.length);
    // Issue #28: raw id stays load-bearing, labels + composite id resolved
    // from local metadata (registered descriptor here — no REST).
    assert.equal(missed.channelId, 'c1');
    assert.equal(missed.mcplChannelId, 'discord:g1:c1');
    assert.equal(missed.channelName, 'general');
    assert.equal(missed.guildName, 'Test Guild');
    assert.equal(missed.metadataResolved, true);

    // A mention while closed+tracked: the push/event origin must carry the
    // tally, so the host's closed-channel invitation can show the agent what
    // staying out has cost (2026-08-05 — informed reply-without-joining).
    discord.simulateMessage({
      id: 'm101', content: '<@bot_123> you there?', cleanContent: '@bot you there?',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: ['bot_123'], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    const mentionPush = await client.nextMessage();
    assert.equal(mentionPush.type, 'request');
    if (mentionPush.type === 'request') {
      assert.equal(mentionPush.request.method, 'push/event');
      const p = mentionPush.request.params as PushEventParams;
      const origin = p.origin as Record<string, unknown>;
      assert.equal(origin.missedMessages, 1);
      assert.equal(origin.missedCharacters, 'hello world'.length);
      client.sendResponse(mentionPush.request.id, { accepted: true });
    }
    // The mention itself is delivered, never "missed" — tally unchanged.
    const still = await call('channel_missed', { channelId: 'c1' });
    assert.equal(still.missedMessages, 1);

    // Reopening clears the tally.
    await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1', type: 'discord', address: { guildId: 'g1', channelId: 'c1' },
    });
    const after = await call('channel_missed', { channelId: 'c1' });
    assert.equal(after.subscribed, true);
    assert.equal(after.missedMessages, 0);

    client.close();
    await serverPromise;
  });

  it('labels list_subscriptions backlog rows and flags unresolvable lookups (issue #28)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.sendRequest('tools/call', { name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      return JSON.parse(r.content[0]?.text ?? '{}');
    };

    // Anchor a tally on c1, then let an ambient message accrue.
    await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1', type: 'discord', address: { guildId: 'g1', channelId: 'c1' },
    });
    await client.sendRequest('channels/close', { channelId: 'discord:g1:c1' });
    discord.simulateMessage({
      id: 'm200', content: 'ambient', cleanContent: 'ambient',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: [], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    await new Promise((r) => setTimeout(r, 20));

    const subs = await call('list_subscriptions', {});
    assert.equal(subs.unsubscribedWithBacklog.length, 1);
    const row = subs.unsubscribedWithBacklog[0];
    assert.equal(row.channelId, 'c1');
    assert.equal(row.mcplChannelId, 'discord:g1:c1');
    assert.equal(row.channelName, 'general');
    assert.equal(row.guildId, 'g1');
    assert.equal(row.guildName, 'Test Guild');
    assert.equal(row.metadataResolved, true);
    assert.equal(row.missedMessages, 1);

    // The gateway cache wins over the descriptor when present (fresher name).
    discord.cachedChannelMeta['c1'] = {
      name: 'general-renamed', guildId: 'g1', guildName: 'Test Guild', isDM: false,
    };
    const renamed = await call('channel_missed', { channelId: 'c1' });
    assert.equal(renamed.channelName, 'general-renamed');
    assert.equal(renamed.metadataResolved, true);

    // Unknown channel: failure is explicit, not an indistinguishable omission,
    // and the raw id survives.
    const unknown = await call('channel_missed', { channelId: 'c_ghost' });
    assert.equal(unknown.tracked, false);
    assert.equal(unknown.channelId, 'c_ghost');
    assert.equal(unknown.mcplChannelId, null);
    assert.equal(unknown.channelName, null);
    assert.equal(unknown.metadataResolved, false);

    client.close();
    await serverPromise;
  });
});

describe('applyMentionCandidates', () => {
  const cands: MentionCandidate[] = [
    { id: 'u_alice', aliases: ['Alice', 'alice_g'], kind: 'user' },
    { id: 'r_mods', aliases: ['Moderators'], kind: 'role' },
    { id: 'u_mods', aliases: ['Moderators'], kind: 'user' }, // name collision w/ role
    { id: 'r_team', aliases: ['Team'], kind: 'role' },
  ];

  it('resolves a role mention to <@&id>', () => {
    assert.equal(applyMentionCandidates('ping @Team please', cands), 'ping <@&r_team> please');
  });

  it('resolves a user mention to <@id>', () => {
    assert.equal(applyMentionCandidates('hi @Alice', cands), 'hi <@u_alice>');
  });

  it('is case-insensitive for roles', () => {
    assert.equal(applyMentionCandidates('@team', cands), '<@&r_team>');
  });

  it('prefers a user over a role on a name collision', () => {
    // Both u_mods (user) and r_mods (role) are named "Moderators" → user wins.
    assert.equal(applyMentionCandidates('@Moderators', cands), '<@u_mods>');
  });

  it('leaves @everyone / @here untouched', () => {
    assert.equal(applyMentionCandidates('@everyone @here', cands), '@everyone @here');
  });

  it('leaves unknown handles untouched', () => {
    assert.equal(applyMentionCandidates('@nobody', cands), '@nobody');
  });

  it('falls through to a role only when no user matches', () => {
    const roleOnly: MentionCandidate[] = [{ id: 'r_x', aliases: ['Ops'], kind: 'role' }];
    assert.equal(applyMentionCandidates('@Ops', roleOnly), '<@&r_x>');
  });

  it('does not resolve when a role name is ambiguous', () => {
    const ambiguous: MentionCandidate[] = [
      { id: 'r_a', aliases: ['Dup'], kind: 'role' },
      { id: 'r_b', aliases: ['Dup'], kind: 'role' },
    ];
    assert.equal(applyMentionCandidates('@Dup', ambiguous), '@Dup');
  });
});

// ── RFC-006 event coalescing ──

describe('RFC-006 coalescing', () => {
  type Coalesce = { key: string; channelId?: string; retract?: boolean; initial?: boolean };
  type Push = PushEventParams & { coalesce?: Coalesce };
  type Incoming = ChannelsIncomingParams['messages'][number] & { eventId?: string; coalesce?: Coalesce };

  async function boot(hostExtras: Record<string, unknown>) {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);
    await mcplHandshake(client, hostExtras);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});
    const nextRequest = async (): Promise<{ method: string; params: unknown; id: string | number }> => {
      for (;;) {
        const m = await nextWithin(client);
        if (m.type === 'request') return { method: m.request.method, params: m.request.params, id: m.request.id };
      }
    };
    // Once only, so a test can both finish early and register it with t.after.
    let finished: Promise<void> | undefined;
    const finish = (): Promise<void> => (finished ??= (async () => { client.close(); await serverPromise; })());
    return { client, discord, serverPromise, nextRequest, finish };
  }
  const guildMessage = (id: string, text: string): DiscordMessageData => ({
    id, content: text, cleanContent: text, authorId: 'u1', authorName: 'Bob', isBot: false,
    channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
    mentions: ['bot_123'], attachments: [], timestamp: new Date(),
  } as unknown as DiscordMessageData);

  it('open channel: create carries its identity; edits and deletes address the same channel-scoped subject', async () => {
    const h = await boot({ eventCoalescing: true });
    await h.client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    h.discord.simulateMessage(guildMessage('m1', 'first version'));
    const create = await h.nextRequest();
    assert.equal(create.method, 'channels/incoming');
    const msg = (create.params as ChannelsIncomingParams).messages[0] as Incoming;
    assert.equal(msg.eventId, 'discord_msg_m1');
    assert.deepEqual(msg.coalesce, { key: 'message:m1', initial: true });
    h.client.sendResponse(create.id, { results: [{ messageId: 'm1', accepted: true, coalesce: { outcome: 'first' } }] });

    h.discord.simulateEdit('c1', 'm1', 'second version', false, { guildId: 'g1', editedAt: '2026-10-02T00:00:01.000Z', authorName: 'Bob' });
    const edit1 = await h.nextRequest();
    assert.equal(edit1.method, 'push/event');
    const e1 = edit1.params as Push;
    assert.deepEqual(e1.coalesce, { key: 'message:m1', channelId: 'discord:g1:c1' });
    assert.match(e1.eventId, /^discord_edit_m1_2026-10-02T00:00:01\.000Z_\d+$/);
    assert.ok(e1.tags?.includes('chat:edited'));
    assert.equal((e1.origin as { mcplChannelId?: string }).mcplChannelId, 'discord:g1:c1');
    assert.equal((e1.payload.content[0] as { text?: string }).text, '[#general in Test Server] Bob: second version [edited]', 'replacement re-renders as the create did');
    h.client.sendResponse(edit1.id, { accepted: true, coalesce: { outcome: 'replaced' } });

    h.discord.simulateEdit('c1', 'm1', 'third version', false, { guildId: 'g1', editedAt: '2026-10-02T00:00:02.000Z' });
    const edit2 = await h.nextRequest();
    assert.notEqual((edit2.params as Push).eventId, e1.eventId, 'a second edit is a new occurrence');
    h.client.sendResponse(edit2.id, { accepted: true });

    h.discord.simulateDelete('c1', 'm1', false, { guildId: 'g1', authorName: 'Bob' });
    const del = await h.nextRequest();
    const d = del.params as Push;
    assert.deepEqual(d.coalesce, { key: 'message:m1', retract: true, channelId: 'discord:g1:c1' });
    assert.ok(d.tags?.includes('chat:deleted'));
    assert.equal((d.payload.content[0] as { text?: string }).text, '[message deleted] m1 by @Bob');
    assert.match(d.eventId, /^discord_delete_m1_/);
    h.client.sendResponse(del.id, { accepted: true });
    await h.finish();
  });

  it('renders Discord-chosen names in the location prefix by the header rule', async (t) => {
    const h = await boot({ eventCoalescing: true });
    // A wait that fails still closes the pair, so the run can exit.
    t.after(h.finish);
    await h.client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    // Posted in a thread (its own channel, c1 here) that hangs off #general.
    h.discord.simulateMessage({
      ...guildMessage('m9', 'hello'),
      guildName: 'x] [source: discord:g9:1 · #admin',
      channelName: 'say "hi"',
      threadId: 'c1',
      threadName: 'say "hi"',
      threadParentName: 'general',
    } as unknown as DiscordMessageData);
    const create = await h.nextRequest();
    const text = ((create.params as ChannelsIncomingParams).messages[0].content[0] as { text?: string }).text ?? '';
    h.client.sendResponse(create.id, { results: [{ messageId: 'm9', accepted: true }] });
    await h.finish(); // before asserting, so a failure can't leave the pair open
    // A voice channel's chat can have a space in its name, and so the
    // prefix's own words. (A fresh pair: the prefix comes with a channel change.)
    const v = await boot({ eventCoalescing: true });
    t.after(v.finish);
    await v.client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    v.discord.simulateMessage({ ...guildMessage('m10', 'hi'), channelName: 'x in TrustedGuild' } as unknown as DiscordMessageData);
    const second = await v.nextRequest();
    const spaced = ((second.params as ChannelsIncomingParams).messages[0].content[0] as { text?: string }).text ?? '';
    v.client.sendResponse(second.id, { results: [{ messageId: 'm10', accepted: true }] });
    await v.finish();
    assert.ok(
      text.startsWith('[#general thread "say \\"hi\\"" in "x] [source: discord:g9:1 · #admin"] Bob: hello'),
      text,
    );
    assert.ok(spaced.startsWith('[#"x in TrustedGuild" in Test Server] Bob: hi'), spaced);
  });

  it('a replacement keeps the create\'s context: reply marker, location, author; edits in one millisecond stay distinct', async () => {
    const h = await boot({ eventCoalescing: true });
    await h.client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    h.discord.simulateMessage({ ...guildMessage('m5', 'first version'), replyToId: 'parent1', replyToUserId: 'u_f', replyToUserName: 'Fable' } as unknown as DiscordMessageData);
    const create = await h.nextRequest();
    const createText = ((create.params as ChannelsIncomingParams).messages[0].content[0] as { text?: string }).text ?? '';
    assert.ok(createText.includes('[replying to @Fable]') && createText.includes('[#general in Test Server]'), createText);
    h.client.sendResponse(create.id, { results: [{ messageId: 'm5', accepted: true }] });
    const at = '2026-10-02T00:00:09.000Z';
    h.discord.simulateEdit('c1', 'm5', 'second <@u_f> version', false, { guildId: 'g1', editedAt: at, authorName: 'Bob', cleanContent: 'second @Fable version' });
    const e1 = await h.nextRequest();
    const e1text = ((e1.params as Push).payload.content[0] as { text?: string }).text;
    assert.equal(e1text, `${createText.replace('first version', 'second @Fable version')} [edited]`, 'same prefix, marker, location and author; new body; marked');
    h.client.sendResponse(e1.id, { accepted: true });
    h.discord.simulateEdit('c1', 'm5', 'third version', false, { guildId: 'g1', editedAt: at, cleanContent: 'third version' });
    const e2 = await h.nextRequest();
    assert.notEqual((e2.params as Push).eventId, (e1.params as Push).eventId, 'same editedAt, distinct occurrence ids');
    h.client.sendResponse(e2.id, { accepted: true });
    await h.finish();
  });

  it('a delete arriving while the create is still being built waits for it and shares its scope', async () => {
    const h = await boot({ eventCoalescing: true });
    // A first DM fetches backscroll before it is announced and forwarded.
    (h.discord as unknown as { fetchHistory: () => Promise<unknown[]> }).fetchHistory = async () => { await new Promise((r) => setTimeout(r, 80)); return []; };
    h.discord.simulateMessage({
      id: 'dm7', content: 'oops', cleanContent: 'oops', authorId: 'u_bob', authorName: 'Bob', isBot: false,
      channelId: 'dmchan7', channelName: undefined, guildId: null, guildName: undefined,
      mentions: [], attachments: [], timestamp: new Date(),
    } as unknown as DiscordMessageData);
    h.discord.simulateDelete('dmchan7', 'dm7', true, { guildId: null, authorName: 'Bob' });
    const first = await h.nextRequest();
    assert.equal((first.params as Push).eventId, 'discord_msg_dm7', 'the create goes first');
    assert.deepEqual((first.params as Push).coalesce, { key: 'message:dm7', initial: true, channelId: 'discord:dm:dmchan7' });
    h.client.sendResponse(first.id, { accepted: true });
    const second = await h.nextRequest();
    assert.deepEqual((second.params as Push).coalesce, { key: 'message:dm7', retract: true, channelId: 'discord:dm:dmchan7' }, 'the delete follows, in the same scope');
    h.client.sendResponse(second.id, { accepted: true });
    await h.finish();
  });

  it('an edit uses the scope its create used, even after the channel became registered', async () => {
    const h = await boot({ eventCoalescing: true });
    // g2/c9 is not registered at startup: the create goes out in feature-set scope.
    h.discord.simulateMessage({ ...guildMessage('m8', 'before registration'), channelId: 'c9', guildId: 'g2', guildName: 'Late Guild', channelName: 'late' } as unknown as DiscordMessageData);
    const create = await h.nextRequest();
    assert.deepEqual((create.params as Push).coalesce, { key: 'message:m8', initial: true });
    h.client.sendResponse(create.id, { accepted: true });
    h.discord.simulateGuildCreate('g2', 'Late Guild', [{ id: 'c9', name: 'late', type: 'text' } as unknown as DiscordChannelInfo]);
    // Registered AND opened now (an edit in an unsubscribed closed channel is
    // dropped by the ingestion gate, as a create would be).
    await h.client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g2', channelId: 'c9' } });
    h.discord.simulateEdit('c9', 'm8', 'after registration', false, { guildId: 'g2', editedAt: '2026-10-02T00:00:10.000Z', cleanContent: 'after registration' });
    const edit = await h.nextRequest();
    assert.deepEqual((edit.params as Push).coalesce, { key: 'message:m8' }, 'still feature-set scope: the subject the create opened');
    h.client.sendResponse(edit.id, { accepted: true });
    await h.finish();
  });

  it('closed guild channel: the push create is channel-scoped because the channel is registered', async () => {
    const h = await boot({ eventCoalescing: { pushEvents: true, channelsIncoming: true, channelScopedPush: true } });
    h.discord.simulateMessage(guildMessage('m2', 'mention while closed'));
    const create = await h.nextRequest();
    assert.equal(create.method, 'push/event');
    assert.deepEqual((create.params as Push).coalesce, { key: 'message:m2', initial: true, channelId: 'discord:g1:c1' });
    h.client.sendResponse(create.id, { accepted: true });
    await h.finish();
  });

  it('DM: announced first, then the create and its edit share the DM channel scope', async () => {
    const h = await boot({ eventCoalescing: true });
    h.discord.simulateMessage({
      id: 'dm9', content: 'hello', cleanContent: 'hello', authorId: 'u_bob', authorName: 'Bob', isBot: false,
      channelId: 'dmchan9', channelName: undefined, guildId: null, guildName: undefined,
      mentions: [], attachments: [], timestamp: new Date(),
    } as unknown as DiscordMessageData);
    const create = await h.nextRequest(); // channels/changed is a notification; skipped
    assert.equal(create.method, 'push/event');
    assert.deepEqual((create.params as Push).coalesce, { key: 'message:dm9', initial: true, channelId: 'discord:dm:dmchan9' });
    h.client.sendResponse(create.id, { accepted: true });
    h.discord.simulateEdit('dmchan9', 'dm9', 'hello (edited)', true, { guildId: null, editedAt: '2026-10-02T00:00:03.000Z' });
    const edit = await h.nextRequest();
    assert.deepEqual((edit.params as Push).coalesce, { key: 'message:dm9', channelId: 'discord:dm:dmchan9' });
    h.client.sendResponse(edit.id, { accepted: true });
    await h.finish();
  });

  it('host without channelScopedPush: subjects stay in feature-set scope', async () => {
    const h = await boot({ eventCoalescing: { pushEvents: true, channelsIncoming: true, channelScopedPush: false } });
    h.discord.simulateMessage(guildMessage('m3', 'closed, no channel scope'));
    const create = await h.nextRequest();
    assert.deepEqual((create.params as Push).coalesce, { key: 'message:m3', initial: true });
    h.client.sendResponse(create.id, { accepted: true });
    await h.finish();
  });

  it('host without eventCoalescing: no coalesce member, but occurrence ids are still distinct', async () => {
    const h = await boot({});
    await h.client.sendRequest(method.CHANNELS_OPEN, { type: 'discord', address: { guildId: 'g1', channelId: 'c1' } });
    h.discord.simulateMessage(guildMessage('m4', 'plain host'));
    const create = await h.nextRequest();
    const msg = (create.params as ChannelsIncomingParams).messages[0] as Incoming;
    assert.equal(msg.eventId, undefined);
    assert.equal(msg.coalesce, undefined);
    h.client.sendResponse(create.id, { results: [{ messageId: 'm4', accepted: true }] });
    h.discord.simulateEdit('c1', 'm4', 'v2', false, { guildId: 'g1', editedAt: '2026-10-02T00:00:04.000Z' });
    const e1 = (await h.nextRequest());
    h.client.sendResponse(e1.id, { accepted: true });
    h.discord.simulateEdit('c1', 'm4', 'v3', false, { guildId: 'g1', editedAt: '2026-10-02T00:00:05.000Z' });
    const e2 = (await h.nextRequest());
    h.client.sendResponse(e2.id, { accepted: true });
    assert.equal((e1.params as Push).coalesce, undefined);
    assert.notEqual((e1.params as Push).eventId, (e2.params as Push).eventId);
    await h.finish();
  });
});
