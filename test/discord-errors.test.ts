/**
 * An id Discord doesn't know comes back as "Unknown Channel" and the like,
 * which says nothing about what to do. The tool chokepoint appends what the
 * answer means for the id that was passed, and how to get a real one, after
 * Discord's own words.
 *
 * Run: node --import tsx --test test/discord-errors.test.ts
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
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
    assert.equal(explainDiscordError(discordError('Missing Permissions', 50013, 403), { channelId: '1' }), 'Missing Permissions');
    assert.equal(explainDiscordError(new Error('socket hang up'), {}), 'socket hang up');
    assert.equal(explainDiscordError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), {}), 'read ECONNRESET');
    assert.match(explainDiscordError(discordError('Unknown Channel', 10003, 404), {}), /^Unknown Channel\n\nNo such channel is visible/);
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
