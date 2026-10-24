/**
 * An id Discord doesn't know comes back as "Unknown Channel" and the like,
 * which says nothing about what to do. The tool chokepoint appends what the
 * answer means for the id that was passed, and how to get a real one, after
 * Discord's own words.
 *
 * Run: node --import tsx --test test/discord-errors.test.ts
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField } from 'discord.js';
import { explainDiscordError } from '../src/discord-errors.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';

/** Shaped as discord.js's DiscordAPIError: the message is Discord's, `code` its JSON error code. */
const discordError = (message: string, code: number, status: number) => Object.assign(new Error(message), { code, status });

describe('explainDiscordError', () => {
  it('says what an unknown channel id means, names the id, and gives the cures', () => {
    const text = explainDiscordError(discordError('Unknown Channel', 10003, 404), { channelId: '111111111111111111' });
    assert.match(text, /^Unknown Channel\n\n/, "Discord's own words come first");
    assert.match(text, /No channel 111111111111111111 is visible to this connection: the id may be mistyped or remembered rather than copied/);
    assert.match(text, /For a text, announcement, voice or stage channel, re-send with its name instead/,
      'the name cure is offered only for the kinds the name route resolves');
    assert.match(text, /or take its label from list_channels/, 'a route to a real address');
    assert.match(text, /a channel whose name reaches another channel, or has a thread label's shape, is listed by its id/,
      "the name cure isn't offered for a name the route refuses or sends elsewhere");
    assert.match(text, /A thread or DM has no name route: its id has to be copied from where it was shown, not recalled\./,
      'a thread or DM is never sent back to a name that could match another channel');
  });

  it('explains an unknown message, an unknown user and missing access the same way', () => {
    const msg = explainDiscordError(discordError('Unknown Message', 10008, 404), { channelId: '1', messageId: '222' });
    assert.match(msg, /No message 222 is visible in channel 1/);
    assert.match(msg, /fetch_history/);
    const user = explainDiscordError(discordError('Unknown User', 10013, 404), { userId: '333333333333333333' });
    assert.match(user, /No user 333333333333333333 is known to Discord: the id may be mistyped/);
    assert.match(user, /a name works for someone who shares a server with this bot or has DMed it/);
    const access = explainDiscordError(discordError('Missing Access', 50001, 403), { channelId: '444' });
    assert.match(access, /^Missing Access\n\nThis bot can't reach channel 444/);
  });

  it('names a server for an unknown guild id, and for missing access on a call aimed at a server', () => {
    const guild = explainDiscordError(discordError('Unknown Guild', 10004, 404), { guildId: '555' });
    assert.match(guild, /^Unknown Guild\n\nNo server 555 is visible to this connection/);
    assert.match(guild, /list_guilds/);
    const access = explainDiscordError(discordError('Missing Access', 50001, 403), { guildId: '666' });
    assert.match(access, /^Missing Access\n\nThis bot can't reach server 666/);
    assert.match(access, /list_guilds/);
  });

  it("keeps the error's own text as it is, and leaves every other error as it was", () => {
    const sent = discordError('Unknown Channel', 10003, 404);
    sent.message += '\n\nAttempted destination: discord:g1:555.';
    const text = explainDiscordError(sent, { channelId: '555' });
    assert.ok(text.startsWith('Unknown Channel\n\nAttempted destination: discord:g1:555.\n\nNo channel 555'), text);
    assert.equal(explainDiscordError(discordError('Invalid Form Body', 50035, 400), { channelId: '1' }), 'Invalid Form Body');
    assert.equal(explainDiscordError(new Error('socket hang up'), {}), 'socket hang up');
    assert.equal(explainDiscordError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), {}), 'read ECONNRESET');
    assert.match(explainDiscordError(discordError('Unknown Channel', 10003, 404), {}), /^Unknown Channel\n\nNo such channel is visible/);
  });
});

describe('explainDiscordError: refusals the agent can\'t change', () => {
  const permissions = () => discordError('Missing Permissions', 50013, 403);
  const noDm = (code = 50007) => discordError('Cannot send messages to this user', code, 403);

  it('missing permissions says what Discord refused, where, that calling again will be refused too, and who can change it', () => {
    assert.equal(explainDiscordError(permissions(), { channelId: '444' }),
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444. ' +
      'Calling again will be refused the same way until someone who manages this server\'s permissions grants that permission.');
    assert.match(explainDiscordError(permissions(), { guildId: '555' }), /^Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in server 555\. /);
    assert.match(explainDiscordError(permissions(), { channelId: '444', guildId: '555' }), /it needs in channel 444\. /,
      'a call aimed at a channel names the channel, not its server');
    assert.match(explainDiscordError(permissions(), {}), /^Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs\. /);
  });

  it("missing permissions after some of a send's parts posted speaks of what didn't post, and of the files when they were refused", () => {
    const partly = (files: boolean, of: number) => Object.assign(permissions(), {
      postedParts: { ids: ['900000000000000001'], of, failed: 'the rest', files },
    });
    const notTheFiles =
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444: Send ' +
      "Messages (Send Messages in Threads, in a thread). Sending what didn't post will be refused the same way until " +
      'someone who manages this server\'s permissions grants it.';
    assert.equal(explainDiscordError(partly(false, 2), { channelId: '444' }), notTheFiles);
    assert.equal(explainDiscordError(partly(true, 3), { channelId: '444' }), notTheFiles,
      'the files go with the last part, not the one refused');
    assert.equal(explainDiscordError(partly(true, 2), { channelId: '444' }),
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444, likely ' +
      'Attach Files, since the part it refused carried the files and the text before that part posted. The rest of the ' +
      'text may go through without the files; the files will be refused the same way until someone who manages this server\'s permissions grants that permission.');
    // The first of a split message's parts refused carried no files, which go with the last.
    const firstRefused = Object.assign(permissions(), {
      postedParts: { ids: [], of: 2, failed: 'the start', next: 'the rest', files: true },
    });
    assert.equal(explainDiscordError(firstRefused, { channelId: '444', content: 'x', files: [{ path: 'a.txt' }] }),
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444: Send ' +
      'Messages (Send Messages in Threads, in a thread). Calling again will be refused the same way until someone who ' +
      'manages this server\'s permissions grants it.');
  });

  it('missing permissions on a message sent in one part with files names both permissions it can be', () => {
    // The post's own postedParts: one part, which carried the files, and the text if any.
    const posted = (text: string, files: boolean) => Object.assign(permissions(), {
      postedParts: { ids: [], of: 1, failed: text, files },
    });
    const files = [{ path: 'a.txt' }];
    assert.equal(explainDiscordError(posted('hello', true), { channelId: '444', content: 'hello', files }),
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444: Send ' +
      'Messages (Send Messages in Threads, in a thread), or Attach Files, since this message carried files. If Attach ' +
      'Files is all that\'s missing, the text alone may go through. Calling again with the files will be refused the same way ' +
      'until someone who manages this server\'s permissions grants what\'s missing.');
    assert.equal(explainDiscordError(posted('', true), { channelId: '444', files }),
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444: Send ' +
      'Messages (Send Messages in Threads, in a thread), or Attach Files, since this message carried files. Calling again ' +
      'will be refused the same way until someone who manages this server\'s permissions grants what\'s missing.',
      'a message of files alone has no text to send without them');
    assert.equal(explainDiscordError(posted('hello', false), { channelId: '444', content: 'hello', files: [] }),
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444: Send ' +
      'Messages (Send Messages in Threads, in a thread). Calling again will be refused the same way until someone who ' +
      'manages this server\'s permissions grants it.', 'an empty files list carries no files: a post needs Send Messages');
    // Without postedParts the refused request wasn't the message post, such as a reply's lookup.
    assert.equal(explainDiscordError(permissions(), { channelId: '444', content: 'hello', files }),
      'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444. Calling ' +
      'again will be refused the same way until someone who manages this server\'s permissions grants that permission.',
      'a refusal of another request on a call with files');
  });

  it('missing permissions on a reply names Read Message History beside Send Messages, while its first part is the one refused', () => {
    const reply = (ids: string[], of: number, files: boolean) => Object.assign(permissions(), {
      postedParts: { ids, of, failed: 'x', files, reply: true },
    });
    const head = 'Missing Permissions\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444: ';
    assert.equal(explainDiscordError(reply([], 2, false), { channelId: '444' }),
      `${head}Send Messages (Send Messages in Threads, in a thread), or Read Message History, which a reply needs. ` +
      'Calling again will be refused the same way until someone who manages this server\'s permissions grants what\'s missing.');
    assert.equal(explainDiscordError(reply([], 1, true), { channelId: '444' }),
      `${head}Send Messages (Send Messages in Threads, in a thread); Read Message History, which a reply needs; or Attach ` +
      'Files, since this message carried files. If Attach Files is all that\'s missing, the text alone may go through. ' +
      'Calling again with the files will be refused the same way until someone who manages this server\'s permissions grants what\'s missing.');
    // A later part carries no reply.
    assert.equal(explainDiscordError(reply(['900000000000000001'], 3, false), { channelId: '444' }),
      `${head}Send Messages (Send Messages in Threads, in a thread). Sending what didn't post will be refused the same ` +
      'way until someone who manages this server\'s permissions grants it.');
  });

  it("a DM Discord won't deliver names the recipient the call named, each possible cause, and who can change each", () => {
    assert.equal(explainDiscordError(noDm(), { userId: 'ra' }),
      'Cannot send messages to this user\n\nDiscord won\'t deliver this DM to "ra": they may share no server with this bot, ' +
      'have turned off DMs from server members, or have blocked it. Sharing a server changes the first: they can join a ' +
      "server this bot is in, or this bot can be added to a server they're in. Only they can change the " +
      'other two. Until one of these changes, calling again will be refused the same way.');
    assert.equal(explainDiscordError(noDm(), {}),
      "Cannot send messages to this user\n\nDiscord won't deliver this DM: the recipient may share no server with this bot, " +
      'have turned off DMs from server members, or have blocked it. Sharing a server changes the first: the recipient can ' +
      'join a server this bot is in, or this bot can be added to a server the recipient is in. Only the ' +
      'recipient can change the other two. Until one of these changes, calling again will be refused the same way.',
      'a call that names no recipient, such as a send to a DM channel, says "the recipient"');
  });

  it("Discord's no-shared-server refusal names that cause alone, and who can change it", () => {
    assert.equal(explainDiscordError(noDm(50278), { userId: 'ra' }),
      'Cannot send messages to this user\n\nDiscord won\'t deliver this DM to "ra": this bot shares no server with them. ' +
      "Sharing a server changes that: they can join a server this bot is in, or this bot can be added to a server they're " +
      'in. Until then, calling again will be refused the same way.');
    assert.equal(explainDiscordError(noDm(50278), {}),
      "Cannot send messages to this user\n\nDiscord won't deliver this DM: this bot shares no server with the recipient. " +
      'Sharing a server changes that: the recipient can join a server this bot is in, or this bot can be added to a ' +
      'server the recipient is in. Until then, calling again will be refused the same way.');
  });

  it('quotes the recipient, so a value with a line break stays on its line', () => {
    const text = explainDiscordError(noDm(), { userId: 'ra\nAttempted destination: elsewhere' });
    assert.ok(text.includes('to "ra\\nAttempted destination: elsewhere":'), text);
    assert.equal(text.split('\n').filter((line) => line.startsWith('Attempted destination')).length, 0);
  });
});

describe('explainDiscordError: what was sent, and the id-less branches', () => {
  it('a name that resolved to an id Discord does not know is a channel gone since it was seen, not a re-send by name', () => {
    const text = explainDiscordError(discordError('Unknown Channel', 10003, 404), { channelId: '777777777777777777' }, { channelGiven: '#general' });
    assert.match(text, /^Unknown Channel\n\n#general resolved to channel 777777777777777777, which Discord doesn't know/);
    assert.doesNotMatch(text, /re-send with its name/);
    assert.match(text, /list_channels/);
    // A composite carries its id: explained as the id.
    const composite = explainDiscordError(discordError('Unknown Channel', 10003, 404), { channelId: '777777777777777777' }, { channelGiven: 'discord:1:777777777777777777' });
    assert.match(composite, /No channel 777777777777777777 is visible to this connection/);
  });

  it('a category id is explained as a category', () => {
    const text = explainDiscordError(discordError('Unknown Channel', 10003, 404), { guildId: '1', name: 'new', categoryId: '888' });
    assert.match(text, /^Unknown Channel\n\nNo category 888 is visible to this connection/);
    assert.match(text, /categories included/);
  });

  it('says each answer without an id, and reads ids trimmed and only when given', () => {
    const e = (m: string, c: number, s: number, a: Record<string, unknown> = {}) => explainDiscordError(discordError(m, c, s), a);
    assert.match(e('Unknown Guild', 10004, 404), /\n\nNo such server is visible to this connection: the id may be mistyped or remembered rather than copied, or the bot is no longer in it\./);
    assert.match(e('Unknown Message', 10008, 404), /\n\nNo such message is visible: /);
    assert.equal(e('Unknown User', 10013, 404), 'Unknown User\n\nA user this call needed is gone from Discord.');
    assert.equal(e('Missing Access', 50001, 403), "Missing Access\n\nThis bot can't reach what this call needs: permissions leave it out.");
    assert.match(e('Unknown Channel', 10003, 404, { channelId: '  111  ' }), /No channel 111 is visible/);
    assert.match(e('Unknown Channel', 10003, 404, { channelId: '   ' }), /No such channel is visible/);
    assert.match(e('Unknown Channel', 10003, 404, { channelId: 111 }), /No such channel is visible/);
  });

  it('a user name the adapter resolved is not sent back to the name route, and an @id is read as the id', () => {
    const text = explainDiscordError(discordError('Unknown User', 10013, 404), { userId: '@someone' });
    assert.match(text, /@someone matched an account Discord no longer knows/);
    assert.doesNotMatch(text, /a name works/);
    const id = explainDiscordError(discordError('Unknown User', 10013, 404), { userId: '@123456789012345678' });
    assert.match(id, /No user 123456789012345678 is known to Discord: the id may be mistyped/);
  });

  it('missing access on a channel does not assume a server, and points at list_channels with its limits', () => {
    const text = explainDiscordError(discordError('Missing Access', 50001, 403), { channelId: '444' });
    assert.match(text, /or it's a DM this bot isn't in/);
    assert.match(text, /within the configured filters; threads and DMs aren't listed/);
  });

  it("reads a message from any thrown value that carries one, not only an Error", () => {
    assert.equal(explainDiscordError({ message: 'cross-realm failure' }, {}), 'cross-realm failure');
    assert.equal(explainDiscordError('plain string', {}), 'plain string');
  });
});

describe('the tool chokepoint', () => {
  type ToolServer = {
    handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
  };
  const serverOver = (adapter: object) => new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as ToolServer;

  const CHANNEL = '444444444444444444';
  const DM_CHANNEL = '777777777777777777';
  const RECIPIENT = '333333333333333333';
  // Split after its first paragraph, where the second begins.
  const PARAGRAPH = 'a'.repeat(1800);
  const SECOND = `Section two: the rollout plan for next week, ${'b'.repeat(655)}`;
  const THIRD = `Section three: what we watch afterwards, ${'c'.repeat(659)}`;
  const LONG = `${PARAGRAPH}\n${SECOND}${'b'.repeat(1100)}\n${THIRD}`; // three parts: 1800, 1800 and 700
  // The text as sent: TWO is 2501 characters, its second part beginning after 1801;
  // LONG is 4302, its parts beginning after 0, 1801 and 3602.
  const TWO = `${PARAGRAPH}\n${SECOND}`;
  const asSent = 'Quoted words are from the text as sent, where a mention reads <@id>, or <@&id> for a role.';
  const unknownNext = "Whether the next part posted is unknown, since Discord didn't answer it with a refusal";
  const checkThen = "send only the rest, once the channel's latest messages (fetch_history) show whether the next part posted.";
  const unknownOne = "Whether this message posted is unknown, since Discord didn't answer it with a refusal. Calling again could " +
    "post it a second time, so check the channel's latest messages (fetch_history) before sending again.";

  /** The real adapter, its client's lookups answered by `fakes`, so the
   *  real sendMessage and sendDM split, send and carry what posted. */
  const realAdapter = async (t: TestContext, fakes: { channel?: object; user?: () => Promise<object>; config?: object }) => {
    const { DiscordAdapter } = await import('../src/discord-adapter.js');
    const adapter = new DiscordAdapter({ token: 'unused', ...fakes.config });
    const client = (adapter as unknown as {
      client: { channels: { fetch: unknown }; users: { fetch: unknown }; destroy(): void };
    }).client;
    t.after(() => client.destroy());
    if (fakes.channel) client.channels.fetch = async () => fakes.channel;
    if (fakes.user) client.users.fetch = fakes.user;
    return adapter;
  };
  /** A server channel whose sends answer in turn: an id, or a thrown error.
   *  This bot holds Read Message History there, as discord.js's cached
   *  permissions answer it for the bot's own member, so Discord would show
   *  the channel's messages. */
  const channelAnswering = (...answers: Array<string | Error>) => {
    const sends: Array<{ content?: string; files?: unknown[] }> = [];
    const me = { id: '666666666666666666' };
    const channel = {
      id: CHANNEL,
      guildId: '555555555555555555',
      isDMBased: () => false,
      guild: { members: { me: me as object | null, cache: new Map() }, roles: { cache: new Map() } },
      // Asked for anyone but this bot's member, it throws: the adapter asks for that member alone.
      permissionsFor: (member: unknown) => {
        if (member !== me) throw new Error(`permissionsFor asked for ${String(member)}`);
        return { has: (permission: bigint) => permission === PermissionsBitField.Flags.ReadMessageHistory };
      },
      send: async (payload: { content?: string; files?: unknown[] }) => {
        sends.push(payload);
        const answer = answers[sends.length - 1];
        if (answer instanceof Error) throw answer;
        return { id: answer };
      },
    };
    return { channel, sends };
  };
  const fileIn = (t: TestContext) => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-send-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hi');
    return file;
  };
  const cannotDm = () => discordError('Cannot send messages to this user', 50007, 403);

  it('a DM Discord refuses after its channel resolved names the DM channel, then explains', async (t) => {
    const user = { id: RECIPIENT, username: 'ra', createDM: async () => ({ id: DM_CHANNEL }), send: async () => { throw cannotDm(); } };
    const r = await serverOver(await realAdapter(t, { user: async () => user })).handleToolCall('send_dm', { userId: RECIPIENT, content: 'hi' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', new RegExp(
      `^Cannot send messages to this user\\n\\nAttempted destination: [^\\n]*\\(Discord channel ${DM_CHANNEL}\\)\\.\\n\\n` +
      `Discord won't deliver this DM to "${RECIPIENT}": they may share no server with this bot, `));
  });

  it('a DM that fails before its channel resolved says no message was sent, then explains', async (t) => {
    // users.fetch is the adapter's own step before the DM channel: an id Discord doesn't know.
    const adapter = await realAdapter(t, { user: async () => { throw discordError('Unknown User', 10013, 404); } });
    const r = await serverOver(adapter).handleToolCall('send_dm', { userId: RECIPIENT, content: 'hi' });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text,
      `Unknown User\n\nAttempted destination: a DM with "${RECIPIENT}"; no DM channel was resolved, so no message was sent.` +
      `\n\nNo user ${RECIPIENT} is known to Discord: the id may be mistyped or remembered rather than copied. A message's author ` +
      'and list_channel_members show real ids, and a name works for someone who shares a server with this bot or has DMed it ' +
      '(@username or display name).');
  });

  it('a reply Discord refuses for a missing permission names its channel and explains', async () => {
    const server = serverOver({ getCachedChannelMeta: () => null, sendMessage: async () => { throw discordError('Missing Permissions', 50013, 403); } });
    const r = await server.handleToolCall('reply_message', { channelId: CHANNEL, messageId: '1', content: 'hi' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '',
      /^Missing Permissions\n\nAttempted destination: [^\n]*444444444444444444\)?\.\n\nDiscord refused this request: this bot lacks a permission it needs in channel 444444444444444444\. /);
  });

  it('a message whose text posts and whose file part is refused says what posted and where the rest begins, and leaves the remedy to the explanation: Attach Files is likely missing, and the text may go through without the files', async (t) => {
    // The text posts; the last part, which carries the file, is refused (no Attach Files).
    const { channel, sends } = channelAnswering('900000000000000001', discordError('Missing Permissions', 50013, 403));
    const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', {
      channelId: CHANNEL,
      content: TWO,
      files: [{ path: fileIn(t) }],
    });
    assert.deepEqual(sends.map((s) => [s.content?.length, s.files?.length ?? 0]), [[1800, 0], [700, 1]]);
    assert.equal(r.isError, true);
    const [own, destination, ...rest] = (r.content[0].text ?? '').split('\n\n');
    assert.equal(own, 'Missing Permissions');
    assert.match(destination, /^Attempted destination: [^\n]*444444444444444444\)?\.$/);
    assert.deepEqual(rest, [
      'The first of the 2 parts this message was split into posted before this failure: 900000000000000001. Discord ' +
      `refused the next part, so the rest didn't post. The rest, files included, begins with "Section two: the ` +
      `rollout plan for next". ${asSent} Calling again with the whole message could post the first part a second time.`,
      'Discord refused this request: this bot lacks a permission it needs in channel 444444444444444444, likely Attach ' +
      'Files, since the part it refused carried the files and the text before that part posted. The rest of the text may ' +
      'go through without the files; the files will be refused the same way until someone who manages this server\'s permissions grants that permission.',
    ]);
    // Refused before the part with the files, the part refused carried none, so the note says to send only the rest.
    const before = channelAnswering('900000000000000001', discordError('Missing Permissions', 50013, 403));
    const early = await serverOver(await realAdapter(t, { channel: before.channel })).handleToolCall('send_message', {
      channelId: CHANNEL,
      content: LONG,
      files: [{ path: fileIn(t) }],
    });
    assert.deepEqual(before.sends.map((s) => [s.content?.length, s.files?.length ?? 0]), [[1800, 0], [1800, 0]]);
    assert.equal((early.content[0].text ?? '').split('\n\n')[2],
      'The first of the 3 parts this message was split into posted before this failure: 900000000000000001. Discord ' +
      `refused the next part, so the rest didn't post. The rest, files included, begins with "Section two: the ` +
      `rollout plan for next". ${asSent} Calling again with the whole message could post the first part a second time, so ` +
      'when you send again, send only the rest.');
  });

  it('a DM refused partway, through the real sendDM, names the DM channel and says what posted', async (t) => {
    const sends: unknown[] = [];
    const user = {
      id: RECIPIENT,
      username: 'ra',
      createDM: async () => ({ id: DM_CHANNEL }),
      send: async (payload: unknown) => {
        sends.push(payload);
        if (sends.length === 1) return { id: '900000000000000001' };
        throw cannotDm();
      },
    };
    const r = await serverOver(await realAdapter(t, { user: async () => user }))
      .handleToolCall('send_dm', { userId: RECIPIENT, content: `${PARAGRAPH}\n${SECOND}` });
    assert.equal(sends.length, 2);
    assert.equal(r.isError, true);
    const [own, destination, note, why, ...more] = (r.content[0].text ?? '').split('\n\n');
    assert.equal(own, 'Cannot send messages to this user');
    assert.match(destination, new RegExp(`^Attempted destination: [^\\n]*\\(Discord channel ${DM_CHANNEL}\\)\\.$`));
    assert.equal(note,
      'The first of the 2 parts this message was split into posted before this failure: 900000000000000001. Discord ' +
      `refused the next part, so the rest didn't post. The rest begins with "Section two: the rollout plan for ` +
      `next". ${asSent} Calling again with the whole message could post the first part a second time, so when you send ` +
      'again, send only the rest.');
    assert.match(why, new RegExp(`^Discord won't deliver this DM to "${RECIPIENT}": `));
    assert.deepEqual(more, []);
    // With files, which go with the last part, the rest holds them, and the part refused carried them, so the
    // note leaves the remedy to the explanation.
    sends.length = 0;
    const withFiles = await serverOver(await realAdapter(t, { user: async () => user }))
      .handleToolCall('send_dm', { userId: RECIPIENT, content: `${PARAGRAPH}\n${SECOND}`, files: [{ path: fileIn(t) }] });
    assert.equal((withFiles.content[0].text ?? '').split('\n\n')[2],
      'The first of the 2 parts this message was split into posted before this failure: 900000000000000001. Discord ' +
      `refused the next part, so the rest didn't post. The rest, files included, begins with "Section two: the ` +
      `rollout plan for next". ${asSent} Calling again with the whole message could post the first part a second time.`);
  });

  it('a part whose outcome is unknown is said to be unknown, with where the rest begins either way and what to check first', async (t) => {
    const noteOf = async (content: string, answers: Array<string | Error>, files?: unknown[]) => {
      const { channel } = channelAnswering(...answers);
      const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', {
        channelId: CHANNEL, content, ...(files ? { files } : {}),
      });
      assert.equal(r.isError, true);
      return (r.content[0].text ?? '').split('\n\n')[2];
    };
    const unavailable = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
    const unknowns: Array<[string, () => Error]> = [
      ['a server error', unavailable],
      ['a timeout', () => Object.assign(new Error('Request aborted'), { name: 'AbortError' })],
    ];
    for (const [what, failure] of unknowns) {
      // The last part's outcome unknown: if it posted, nothing is left.
      assert.equal(await noteOf(LONG, ['900000000000000001', '900000000000000002', failure()]),
        'The first 2 of the 3 parts this message was split into posted before this failure: 900000000000000001, ' +
        `900000000000000002. ${unknownNext}. If it didn't post, the rest begins with "Section three: what we ` +
        `watch"; if it did, the whole message posted. ${asSent} Calling again with the whole message could post those 2 ` +
        `parts a second time, so ${checkThen}`,
        what);
    }
    // One posted of three: the rest begins at the part that failed, or after it.
    assert.equal(await noteOf(LONG, ['900000000000000001', unavailable()]),
      'The first of the 3 parts this message was split into posted before this failure: 900000000000000001. ' +
      `${unknownNext}; nothing after it posted. If it didn't post, the rest begins with "Section two: the ` +
      `rollout plan for next"; if it did, the rest begins with "Section three: what we watch". ${asSent} Calling again ` +
      `with the whole message could post the first part a second time, so ${checkThen}`);
    // With files, both clauses say the rest holds them.
    assert.equal(await noteOf(LONG, ['900000000000000001', unavailable()], [{ path: fileIn(t) }]),
      'The first of the 3 parts this message was split into posted before this failure: 900000000000000001. ' +
      `${unknownNext}; nothing after it posted. If it didn't post, the rest, files included, begins with ` +
      '"Section two: the rollout plan for next"; if it did, the rest, files included, begins with "Section three: what we ' +
      `watch". ${asSent} Calling again with the whole message could post the first part a second time, so ${checkThen}`);
    // The last part, which carries the files: the rest that may not have posted holds them.
    assert.equal(await noteOf(TWO, ['900000000000000001', unavailable()], [{ path: fileIn(t) }]),
      'The first of the 2 parts this message was split into posted before this failure: 900000000000000001. ' +
      `${unknownNext}. If it didn't post, the rest, files included, begins with "Section two: the rollout plan ` +
      `for next"; if it did, the whole message posted. ${asSent} Calling again with the whole message could post the ` +
      `first part a second time, so ${checkThen}`);
    // The first part: it may have posted, and nothing after it did.
    assert.equal(await noteOf(LONG, [unavailable()]),
      "Whether the first of the 3 parts this message was split into posted is unknown, since Discord didn't answer it " +
      `with a refusal; nothing after it posted. If it didn't post, nothing did; if it did, the rest begins ` +
      `with "Section two: the rollout plan for next". ${asSent} Calling again with the whole message could post the first ` +
      "part a second time, so check the channel's latest messages (fetch_history) before sending again.");
    // A message sent in one part: whether it posted is unknown too.
    for (const [what, failure] of unknowns) {
      assert.equal(await noteOf('hi', [failure()]), unknownOne, `one part, ${what}`);
    }
  });

  it('names fetch_history as the way to check only while the host has the history tools on', async (t) => {
    const noteOf = async (content: string, answers: Array<string | Error>) => {
      const { channel } = channelAnswering(...answers);
      const server = serverOver(await realAdapter(t, { channel }));
      Object.assign(server, { mcplEnabled: true, enabledFeatureSets: new Set(['discord.messaging']) });
      const r = await server.handleToolCall('send_message', { channelId: CHANNEL, content });
      return (r.content[0].text ?? '').split('\n\n')[2];
    };
    const unavailable = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
    const tell = 'someone who can see the channel can tell.';
    assert.equal(await noteOf('hi', [unavailable()]),
      "Whether this message posted is unknown, since Discord didn't answer it with a refusal. That can't be checked " +
      `from here: sending it again risks a second copy, and not sending it risks it missing; ${tell}`);
    assert.equal(await noteOf(LONG, [unavailable()]),
      "Whether the first of the 3 parts this message was split into posted is unknown, since Discord didn't answer it " +
      `with a refusal; nothing after it posted. If it didn't post, nothing did; if it did, the rest begins ` +
      `with "Section two: the rollout plan for next". ${asSent} Whether the first part posted can't be checked from here: ` +
      `sending the whole message again could post it twice, and sending from the part after it could leave it out; ${tell}`);
    // The part that failed, the last or one with parts after it.
    assert.equal(await noteOf(TWO, ['900000000000000001', unavailable()]),
      'The first of the 2 parts this message was split into posted before this failure: 900000000000000001. ' +
      `${unknownNext}. If it didn't post, the rest begins with "Section two: the rollout plan for next"; if it ` +
      `did, the whole message posted. ${asSent} Calling again with the whole message could post the first part a second ` +
      'time. Whether the next part posted can\'t be checked from here: sending it again could post it twice, ' +
      `and not sending it could leave it out; ${tell}`);
    assert.equal(await noteOf(LONG, ['900000000000000001', unavailable()]),
      'The first of the 3 parts this message was split into posted before this failure: 900000000000000001. ' +
      `${unknownNext}; nothing after it posted. If it didn't post, the rest begins with "Section two: the ` +
      `rollout plan for next"; if it did, the rest begins with "Section three: what we watch". ${asSent} Calling again ` +
      'with the whole message could post the first part a second time. Whether the next part posted can\'t be checked ' +
      'from here: sending the rest from that part could post it twice, and sending from the one after it could leave it ' +
      `out; ${tell}`);
    // Four parts cut hard at 1,900 units, the third unknown after two posted.
    assert.match(await noteOf('x'.repeat(7000), ['900000000000000001', '900000000000000002', unavailable()]),
      /could post those 2 parts a second time\. Whether the next part posted can't be checked from here: sending the rest from that part could post it twice, and sending from the one after it could leave it out; someone who can see the channel can tell\.$/);
  });

  it('names fetch_history under a host that has its feature set on', async (t) => {
    const { channel } = channelAnswering(Object.assign(new Error('Service Unavailable'), { status: 503 }));
    const server = serverOver(await realAdapter(t, { channel }));
    Object.assign(server, { mcplEnabled: true, enabledFeatureSets: new Set(['discord.messaging', 'discord.history']) });
    const r = await server.handleToolCall('send_message', { channelId: CHANNEL, content: 'hi' });
    assert.equal((r.content[0].text ?? '').split('\n\n')[2], unknownOne);
  });

  it('names fetch_history only where it would read the channel: one the channel filters admit, found by its lookup', async (t) => {
    const unavailable = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
    const noteOf = async (adapterOver: (channel: object) => Promise<object>) => {
      const { channel } = channelAnswering(unavailable());
      const server = serverOver(await adapterOver(channel));
      Object.assign(server, { mcplEnabled: true, enabledFeatureSets: new Set(['discord.messaging', 'discord.history']) });
      const r = await server.handleToolCall('send_message', { channelId: CHANNEL, content: 'hi' });
      return (r.content[0].text ?? '').split('\n\n')[2];
    };
    const noCheck = "Whether this message posted is unknown, since Discord didn't answer it with a refusal. That can't be " +
      'checked from here: sending it again risks a second copy, and not sending it risks it missing; someone who can see ' +
      'the channel can tell.';
    const filters = (channels: string[]) => ({ guildChannels: { '555555555555555555': channels } });
    // The filters admit another of this server's channels, so fetch_history would refuse this one.
    assert.equal(await noteOf((channel) => realAdapter(t, { channel, config: filters(['111111111111111111']) })), noCheck);
    assert.equal(await noteOf((channel) => realAdapter(t, { channel, config: filters([CHANNEL]) })), unknownOne);
    // The send's lookup finds the channel; the lookup fetch_history would make fails.
    assert.equal(await noteOf(async (channel) => {
      const adapter = await realAdapter(t, { channel });
      let lookups = 0;
      (adapter as unknown as { client: { channels: { fetch: unknown } } }).client.channels.fetch = async () => {
        if (lookups++ === 0) return channel;
        throw unavailable();
      };
      return adapter;
    }), noCheck);
  });

  it("names fetch_history only where Discord would show this bot the channel's messages: Read Message History, or a DM", async (t) => {
    const unavailable = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
    const noCheck = "Whether this message posted is unknown, since Discord didn't answer it with a refusal. That can't be " +
      'checked from here: sending it again risks a second copy, and not sending it risks it missing; someone who can see ' +
      'the channel can tell.';
    const noteIn = async (alter: (channel: ReturnType<typeof channelAnswering>['channel']) => void) => {
      const { channel } = channelAnswering(unavailable());
      alter(channel);
      const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', { channelId: CHANNEL, content: 'hi' });
      return (r.content[0].text ?? '').split('\n\n')[2];
    };
    assert.equal(await noteIn(() => {}), unknownOne);
    // Without Read Message History, Discord answers a read of the channel's messages with none.
    assert.equal(await noteIn((channel) => { channel.permissionsFor = () => ({ has: () => false }); }), noCheck);
    // The cache doesn't hold this bot's member, so its permissions there can't be read.
    assert.equal(await noteIn((channel) => { channel.guild.members.me = null; }), noCheck);
    // A DM's messages are shown to both sides.
    const user = { id: RECIPIENT, username: 'ra', createDM: async () => ({ id: DM_CHANNEL }), send: async () => { throw unavailable(); } };
    const dm = await realAdapter(t, { user: async () => user, channel: { id: DM_CHANNEL, isDMBased: () => true } });
    const r = await serverOver(dm).handleToolCall('send_dm', { userId: RECIPIENT, content: 'hi' });
    assert.equal((r.content[0].text ?? '').split('\n\n')[2], unknownOne);
  });

  it("doesn't name fetch_history where the channel's history cap is 0, under which it reads no message", async (t) => {
    const unavailable = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
    const noCheck = "Whether this message posted is unknown, since Discord didn't answer it with a refusal. That can't be " +
      'checked from here: sending it again risks a second copy, and not sending it risks it missing; someone who can see ' +
      'the channel can tell.';
    const caps = process.env.DISCORD_BACKSCROLL_CHANNELS;
    t.after(() => {
      if (caps === undefined) delete process.env.DISCORD_BACKSCROLL_CHANNELS;
      else process.env.DISCORD_BACKSCROLL_CHANNELS = caps;
    });
    const noteUnder = async (channelCaps: string) => {
      process.env.DISCORD_BACKSCROLL_CHANNELS = channelCaps;
      const { channel } = channelAnswering(unavailable());
      const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', { channelId: CHANNEL, content: 'hi' });
      return (r.content[0].text ?? '').split('\n\n')[2];
    };
    assert.equal(await noteUnder(`${CHANNEL}:0`), noCheck);
    // A cap of 1 still shows the newest message, and another channel's cap is that channel's.
    assert.equal(await noteUnder(`${CHANNEL}:1`), unknownOne);
    assert.equal(await noteUnder('111111111111111111:0'), unknownOne);
  });

  it("answers no for a channel discord.js returns nothing for, or whose bot member the cache doesn't hold, rather than failing", async (t) => {
    const adapter = await realAdapter(t, {});
    const client = (adapter as unknown as { client: { channels: { fetch: unknown } } }).client;
    client.channels.fetch = async () => null;
    assert.equal(await adapter.readsMessageHistory(CHANNEL), false);
    const { channel } = channelAnswering();
    channel.guild.members.me = null;
    client.channels.fetch = async () => channel;
    assert.equal(await adapter.readsMessageHistory(CHANNEL), false);
  });

  it('reads a 500 as an unknown outcome, and a 400 or 404 as a refusal', async (t) => {
    for (const [status, says] of [[500, unknownNext], [400, 'Discord refused the next part'], [404, 'Discord refused the next part']] as const) {
      const { channel } = channelAnswering('900000000000000001', Object.assign(new Error(`status ${status}`), { status }));
      const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', { channelId: CHANNEL, content: TWO });
      assert.ok((r.content[0].text ?? '').split('\n\n')[2].includes(says), `${status}: ${r.content[0].text}`);
    }
  });

  it('quotes where the rest begins: a short rest whole, a long one cut at a late space, or at 40 characters', async (t) => {
    const quoted = async (second: string) => {
      const { channel } = channelAnswering('900000000000000001', discordError('Missing Permissions', 50013, 403));
      // A first line long enough that any second one splits off.
      const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', {
        channelId: CHANNEL, content: `${'a'.repeat(1890)}\n${second}`,
      });
      return /with ("(?:[^"\\]|\\.)*")\. Quoted words/.exec((r.content[0].text ?? '').split('\n\n')[2])?.[1];
    };
    assert.equal(await quoted('The closing line, and its final words.'), '"The closing line, and its final words."',
      'a rest of 40 characters or fewer, whole, though it has a late space');
    assert.equal(await quoted(`${'x'.repeat(60)} and more`), `"${'x'.repeat(40)}"`, 'no space in the first 40');
    assert.equal(await quoted(`ab ${'y'.repeat(60)}`), `"ab ${'y'.repeat(37)}"`, 'only an early space');
    assert.equal(await quoted(SECOND), '"Section two: the rollout plan for next"', 'a late space');
    assert.equal(await quoted(`${'x'.repeat(20)} ${'y'.repeat(60)}`), `"${'x'.repeat(20)}"`, 'a space at character 20');
    // Fifteen emoji, thirty UTF-16 units, then a space: the space is character 15, too early to cut at.
    assert.equal(await quoted(`${'🙂'.repeat(15)} ${'y'.repeat(60)}`), `"${'🙂'.repeat(15)} ${'y'.repeat(24)}"`,
      'an early space counted in characters, not UTF-16 units');
  });

  it('quotes in characters across a hard cut that falls before a character outside the BMP', async (t) => {
    // No line break or space, so the cut is hard, and it falls before the emoji rather than inside it.
    const { channel, sends } = channelAnswering('900000000000000001', discordError('Missing Permissions', 50013, 403));
    const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', {
      channelId: CHANNEL, content: `${'a'.repeat(1899)}🙂${'b'.repeat(100)}`,
    });
    assert.deepEqual(sends.map((s) => s.content), ['a'.repeat(1899), `🙂${'b'.repeat(100)}`]);
    assert.equal((r.content[0].text ?? '').split('\n\n')[2],
      'The first of the 2 parts this message was split into posted before this failure: 900000000000000001. Discord ' +
      `refused the next part, so the rest didn't post. The rest begins with "🙂${'b'.repeat(39)}". ${asSent} Calling ` +
      'again with the whole message could post the first part a second time, so when you send again, send only the rest.');
  });

  it('quotes the text as sent, where a mention reads <@id>, or <@&id> for a role', async (t) => {
    // "@ra" and "@ops", at the start of the rest, are rewritten as mentions of the member and the role they name.
    const member = { nickname: null, user: { id: '111111111111111111', username: 'ra', displayName: 'ra' } };
    const role = { id: '222222222222222222', name: 'ops' };
    const guild = { id: '555555555555555555', members: { cache: new Map([['m', member]]) }, roles: { cache: new Map([['r', role]]) } };
    for (const [handle, sent] of [['@ra', '<@111111111111111111>'], ['@ops', '<@&222222222222222222>']]) {
      const { channel } = channelAnswering('900000000000000001', discordError('Missing Permissions', 50013, 403));
      const r = await serverOver(await realAdapter(t, { channel: { ...channel, guild } })).handleToolCall('send_message', {
        channelId: CHANNEL,
        content: `${'a'.repeat(1890)}\n${handle} see section two`,
      });
      assert.equal((r.content[0].text ?? '').split('\n\n')[2],
        'The first of the 2 parts this message was split into posted before this failure: 900000000000000001. Discord ' +
        `refused the next part, so the rest didn't post. The rest begins with "${sent} see section two". ${asSent} ` +
        'Calling again with the whole message could post the first part a second time, so when you send again, send only ' +
        'the rest.');
    }
  });

  it("a reply_message whose post Discord refused with 50013 names Read Message History, since its first part carries the reply", async (t) => {
    const { channel, sends } = channelAnswering(discordError('Missing Permissions', 50013, 403));
    const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('reply_message', {
      channelId: CHANNEL, messageId: '900000000000000009', content: 'hi',
    });
    assert.equal(sends.length, 1);
    assert.equal(r.isError, true);
    assert.equal((r.content[0].text ?? '').split('\n\n').at(-1),
      'Discord refused this request: this bot lacks a permission it needs in channel 444444444444444444: Send Messages ' +
      '(Send Messages in Threads, in a thread), or Read Message History, which a reply needs. Calling again will be ' +
      'refused the same way until someone who manages this server\'s permissions grants what\'s missing.');
  });

  it('a message whose first part is refused says none of it posted; one sent in one part needs no note', async (t) => {
    const { channel, sends } = channelAnswering(discordError('Missing Permissions', 50013, 403));
    const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', {
      channelId: CHANNEL,
      content: TWO,
    });
    assert.equal(sends.length, 1);
    const [own, destination, note, why, ...more] = (r.content[0].text ?? '').split('\n\n');
    assert.equal(own, 'Missing Permissions');
    assert.match(destination, /^Attempted destination: /);
    assert.equal(note, 'Discord refused the first of the 2 parts this message was split into, so none of it posted.');
    assert.equal(why,
      'Discord refused this request: this bot lacks a permission it needs in channel 444444444444444444: Send Messages ' +
      '(Send Messages in Threads, in a thread). Calling again will be refused the same way until someone who manages this server\'s permissions grants it.');
    assert.deepEqual(more, []);
    // Sent in one part, refused: Discord's refusal means it made no message, and the error is that refusal.
    const one = channelAnswering(discordError('Missing Permissions', 50013, 403));
    const single = await serverOver(await realAdapter(t, { channel: one.channel })).handleToolCall('send_message', {
      channelId: CHANNEL, content: 'hi',
    });
    assert.equal((single.content[0].text ?? '').split('\n\n').length, 3, 'its words, the destination and the explanation');
  });

  it('a message sent in one part with files and refused names both permissions, and one of files alone isn\'t told its text may go through; a refusal of another request names neither', async (t) => {
    const { channel } = channelAnswering(discordError('Missing Permissions', 50013, 403));
    const r = await serverOver(await realAdapter(t, { channel })).handleToolCall('send_message', {
      channelId: CHANNEL, content: 'hi', files: [{ path: fileIn(t) }],
    });
    assert.match((r.content[0].text ?? '').split('\n\n')[2],
      /^Discord refused this request: this bot lacks a permission it needs in channel 444444444444444444: Send Messages \(Send Messages in Threads, in a thread\), or Attach Files, since this message carried files\. If Attach Files is all that's missing, the text alone may go through\./);
    // A message of files alone: its one part carried no text, so there's none to send without them.
    const filesOnly = channelAnswering(discordError('Missing Permissions', 50013, 403));
    const alone = await serverOver(await realAdapter(t, { channel: filesOnly.channel })).handleToolCall('send_message', {
      channelId: CHANNEL, files: [{ path: fileIn(t) }],
    });
    assert.deepEqual(filesOnly.sends.map((s) => [s.content, s.files?.length ?? 0]), [[undefined, 1]]);
    assert.equal((alone.content[0].text ?? '').split('\n\n')[2],
      'Discord refused this request: this bot lacks a permission it needs in channel 444444444444444444: Send Messages ' +
      '(Send Messages in Threads, in a thread), or Attach Files, since this message carried files. Calling again will be ' +
      "refused the same way until someone who manages this server's permissions grants what's missing.");
    // A reply whose 50013 came before its post, from a lookup: no postedParts, so no files text.
    const server = serverOver({ getCachedChannelMeta: () => null, sendMessage: async () => { throw discordError('Missing Permissions', 50013, 403); } });
    const reply = await server.handleToolCall('reply_message', { channelId: CHANNEL, messageId: '1', content: 'hi', files: [{ path: 'a.txt' }] });
    assert.match(reply.content[0].text ?? '', /needs in channel 444444444444444444\. Calling again will be refused/);
  });

  it('list_emojis with an unknown guild id passes Discord\'s error through to be explained', async (t) => {
    const { DiscordAdapter } = await import('../src/discord-adapter.js');
    const adapter = new DiscordAdapter({ token: 'unused' });
    const client = (adapter as unknown as { client: { guilds: { fetch: (id: string) => Promise<unknown> }; destroy(): void } }).client;
    t.after(() => client.destroy());
    client.guilds.fetch = async () => { throw discordError('Unknown Guild', 10004, 404); };
    const server = new DiscordMcplServer(adapter) as unknown as {
      handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const r = await server.handleToolCall('list_emojis', { guildId: '999999999999999999' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /^Unknown Guild\n\nNo server 999999999999999999 is visible to this connection/);
    assert.match(r.content[0].text ?? '', /list_guilds/);
  });

  it('a send addressed by name explains the name that was sent, not only the id it resolved to', async () => {
    const adapter = {
      resolveChannelRef: () => ({ ok: true as const, id: '777777777777777777', matched: undefined }),
      refreshStale: async () => {},
      // #63's send path reads the channel's cached metadata for its receipt.
      getCachedChannelMeta: () => null,
      sendMessage: async () => { throw discordError('Unknown Channel', 10003, 404); },
    };
    const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
      handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const r = await server.handleToolCall('send_message', { channelId: '#general', content: 'hi' });
    assert.equal(r.isError, true);
    // Discord's words, then the destination the send attempted (#63), then what they mean.
    assert.match(
      r.content[0].text ?? '',
      /^Unknown Channel\n\nAttempted destination: Discord channel 777777777777777777\.\n\n#general resolved to channel 777777777777777777, which Discord doesn't know/,
    );
  });

  it('create_text_channel with an unknown category explains the category', async () => {
    const adapter = {
      createTextChannel: async () => { throw discordError('Unknown Channel', 10003, 404); },
    };
    const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
      handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const r = await server.handleToolCall('create_text_channel', { guildId: '1', name: 'new', categoryId: '888' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /^Unknown Channel\n\nNo category 888 is visible/);
  });

  it('a send to an unknown channel id returns the explanation as the tool error', async () => {
    const adapter = {
      getCachedChannelMeta: () => null,
      sendMessage: async () => { throw discordError('Unknown Channel', 10003, 404); },
    };
    const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
      handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const r = await server.handleToolCall('send_message', { channelId: '123456789012345678', content: 'hi' });
    assert.equal(r.isError, true);
    assert.match(
      r.content[0].text ?? '',
      /^Unknown Channel\n\nAttempted destination: Discord channel 123456789012345678\.\n\nNo channel 123456789012345678 is visible to this connection/,
    );
  });
});
