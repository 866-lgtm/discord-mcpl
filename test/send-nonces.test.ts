/**
 * The REST client sends a request again after a 5xx, a timeout or a reset
 * connection, so a part of a message whose first attempt posted, and whose
 * answer was lost, would post twice. Each part carries a nonce of its own
 * that Discord enforces: Discord answers a repeat sent within a few minutes
 * with the message it already made. These tests send through discord.js's
 * own channel send and REST client, with the REST client's makeRequest
 * answering in Discord's place.
 *
 * Run: node --import tsx --test test/send-nonces.test.ts
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, ClientUser, type Client } from 'discord.js';
import { DiscordAdapter } from '../src/discord-adapter.js';

const DM = '777777777777777777';
const RECIPIENT = '333333333333333333';
const BOT = '222222222222222222';
const recipient = { id: RECIPIENT, username: 'ra', discriminator: '0' };
/** Long enough to be sent in two parts. */
const TWO_PARTS = `${'a'.repeat(1800)}\n${'b'.repeat(700)}`;

type Body = { content?: string; nonce?: string; enforce_nonce?: boolean; files?: number };

const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const messageData = (id: string, content: string) => ({
  id, channel_id: DM, content, type: 0, timestamp: new Date(0).toISOString(), edited_timestamp: null, tts: false,
  mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false,
  author: { id: BOT, username: 'bot', discriminator: '0', bot: true },
});

/** The real adapter, with a DM to RECIPIENT cached, over a stand-in for
 *  Discord: each request makes a message unless its nonce is enforced and
 *  already made one, which it returns instead, as Discord's enforce_nonce
 *  does. `lost` lists the requests (by their place, from 0) whose message is
 *  made but whose answer is a 503. */
function overStandIn(t: TestContext, lost: number[] = []) {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: Client }).client;
  t.after(() => client.destroy());
  // Logged in as BOT, as READY would leave it; a DM's recipient is read against it.
  const LoggedIn = ClientUser as unknown as new (c: Client, data: object) => ClientUser;
  client.user = new LoggedIn(client, { id: BOT, username: 'bot', discriminator: '0', bot: true });
  client.rest.setToken('unused');
  const requests: Body[] = [];
  const made = new Map<string, ReturnType<typeof messageData>>();
  (client.rest.options as { makeRequest: unknown }).makeRequest = async (_url: string, init: { body?: unknown }) => {
    // A part with files goes as multipart form data, its body in payload_json
    // and each file a field of its own; any other part, as JSON.
    const form = init.body as { get?: (name: string) => unknown; keys?: () => Iterable<string> };
    const multipart = typeof form?.get === 'function' && typeof form.keys === 'function';
    const body = (multipart ? JSON.parse(String(form.get!('payload_json'))) : JSON.parse(String(init.body))) as Body;
    body.files = multipart ? [...form.keys!()].filter((name) => name.startsWith('files[')).length : 0;
    requests.push(body);
    const key = body.enforce_nonce && body.nonce ? body.nonce : `unenforced ${requests.length}`;
    let message = made.get(key);
    if (!message) {
      message = messageData(`90000000000000000${made.size + 1}`, body.content ?? '');
      made.set(key, message);
    }
    return lost.includes(requests.length - 1) ? json(503, { message: 'upstream connect error' }) : json(200, message);
  };
  (client.users as unknown as { _add(data: object): unknown })._add(recipient);
  (client.channels as unknown as { _add(data: object): unknown })._add({
    id: DM, type: ChannelType.DM, recipients: [recipient], last_message_id: null,
  });
  return { adapter, requests, made };
}

describe('the parts of a message carry nonces Discord enforces', () => {
  it('a part sent again after a 503 carries the same nonce, so it posts once and the send returns it', async (t) => {
    const { adapter, requests, made } = overStandIn(t, [0]);
    const { messageId } = await adapter.sendMessage(DM, 'hello');
    assert.equal(requests.length, 2, 'the REST client sent the part again after the 503');
    assert.match(requests[0].nonce ?? '', /^\d{1,25}$/, 'a nonce Discord takes: up to 25 characters');
    assert.equal(requests[1].nonce, requests[0].nonce, 'the retry carries the same nonce');
    assert.deepEqual(requests.map((r) => r.enforce_nonce), [true, true]);
    assert.equal(made.size, 1, 'one message was made');
    assert.equal(messageId, '900000000000000001', 'the send returns the message the first attempt made');
  });

  it('each part of a message sent in parts, and each call, has a nonce of its own', async (t) => {
    const { adapter, requests, made } = overStandIn(t);
    await adapter.sendMessage(DM, TWO_PARTS);
    await adapter.sendMessage(DM, TWO_PARTS);
    assert.equal(requests.length, 4);
    assert.equal(new Set(requests.map((r) => r.nonce)).size, 4, 'four parts, four nonces');
    assert.ok(requests.every((r) => r.enforce_nonce === true));
    assert.equal(made.size, 4, 'sending the same text again posts it again');
  });

  it('a part that carries files, sent again after a 503, carries the same nonce as multipart form data', async (t) => {
    const { adapter, requests, made } = overStandIn(t, [1]);
    const dir = mkdtempSync(join(tmpdir(), 'send-nonces-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'x');
    const { messageId } = await adapter.sendMessage(DM, TWO_PARTS, { files: [{ path }] });
    assert.equal(requests.length, 3, 'two parts, the second sent again after its 503');
    assert.deepEqual(requests.map((r) => r.files), [0, 1, 1], 'the files ride the last part, as multipart form data');
    assert.notEqual(requests[0].nonce, requests[1].nonce);
    assert.equal(requests[2].nonce, requests[1].nonce, 'the retry of the part with the files carries its nonce');
    assert.ok(requests.every((r) => r.enforce_nonce === true));
    assert.equal(made.size, 2);
    assert.equal(messageId, '900000000000000002');
  });

  it("send_dm's parts carry them too, and a part sent again after a 503 posts once", async (t) => {
    const { adapter, requests, made } = overStandIn(t, [1]);
    const { messageId } = await adapter.sendDM(RECIPIENT, TWO_PARTS);
    assert.equal(requests.length, 3, 'two parts, the second sent again after its 503');
    assert.notEqual(requests[0].nonce, requests[1].nonce);
    assert.equal(requests[2].nonce, requests[1].nonce);
    assert.ok(requests.every((r) => r.enforce_nonce === true));
    assert.equal(made.size, 2);
    assert.equal(messageId, '900000000000000002');
  });
});
