/**
 * Tests for the text-attachment inline cap (issue #30) and inlined attachment URLs.
 *
 * The invariant under test: no more than DISCORD_ATTACHMENT_INLINE_MAX_BYTES
 * of attachment text ever becomes a context block, and the bound holds on
 * ACTUAL bytes — Discord's declared attachment.size is advisory. Images are
 * out of scope by design (native image blocks, their own ceilings).
 *
 * buildAttachmentBlocks is private; tests reach it with the same cast-hack
 * precedent server.test.ts uses for private access. No Discord connection —
 * the adapter is a bare cast, globalThis.fetch is stubbed per test.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';

import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter, DiscordAttachment } from '../src/discord-adapter.js';
import { mapAllAttachments } from '../src/discord-adapter.js';
import { toolDefinitions } from '../src/tools.js';

const ENV_KEY = 'DISCORD_ATTACHMENT_INLINE_MAX_BYTES';

/** A 1x1 transparent PNG: real bytes, so the sharp normalization path runs. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type Block = { type: string; text?: string };

/** A signed CDN URL's expiry, as Discord writes it in `ex`: Unix seconds in hex. */
const EX = (Date.UTC(2026, 9, 16, 1, 12) / 1000).toString(16);
const EXPIRES = '(link expires 2026-10-16 01:12 UTC)';
const LINKS_NOTE: Block = {
  type: 'text',
  text: '[Attachment links expire as marked; fetching the message again gives fresh links.]',
};

function makeAttachment(over: Partial<DiscordAttachment> = {}): DiscordAttachment {
  return {
    id: 'a1',
    name: 'notes.txt',
    url: 'https://cdn.discordapp.example/a1/notes.txt',
    contentType: 'text/plain',
    size: 100,
    ...over,
  } as DiscordAttachment;
}

async function buildBlocks(attachments: DiscordAttachment[]): Promise<Block[]> {
  const server = new DiscordMcplServer({} as DiscordAdapter) as unknown as {
    buildAttachmentBlocks(atts: DiscordAttachment[]): Promise<Block[]>;
  };
  return server.buildAttachmentBlocks(attachments);
}

/** All inlined text across blocks, for asserting body bytes did/didn't land. */
function allText(blocks: Block[]): string {
  return blocks.map((b) => b.text ?? '').join('\n');
}

describe('attachment inline cap (issue #30)', () => {
  const realFetch = globalThis.fetch;
  let fetchCalls: string[];
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  function stubFetch(body: string | Uint8Array) {
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response(body);
    }) as typeof fetch;
  }

  it('keeps the original URL beside inlined text', async () => {
    const body = 'const value = 42;\n';
    const url = `https://cdn.discordapp.example/a1/code.ts?ex=${EX}&is=def&hm=123`;
    stubFetch(body);
    const blocks = await buildBlocks([
      makeAttachment({ name: 'code.ts', url, size: Buffer.byteLength(body) }),
    ]);
    assert.deepEqual(fetchCalls, [url]);
    assert.deepEqual(blocks, [
      { type: 'text', text: `[attachment: code.ts (18B) — ${url} ${EXPIRES}]\n${body}` },
      LINKS_NOTE,
    ]);
  });

  it('keeps the original URL beside an inlined forwarded image', async () => {
    const url = `https://cdn.discordapp.example/a1/pixel.png?ex=${EX}&is=def&hm=456`;
    stubFetch(PNG);
    const blocks = await buildBlocks([
      makeAttachment({
        name: 'pixel.png', url, contentType: 'image/png', size: PNG.length,
        forwardedSnapshotIndex: 1,
      }),
    ]);
    assert.deepEqual(fetchCalls, [url]);
    assert.deepEqual(blocks.map((block) => block.type), ['image', 'text', 'text']);
    assert.equal(blocks[1].text, `[image attachment: pixel.png (forwarded) — ${url} ${EXPIRES}]`);
    assert.deepEqual(blocks[2], LINKS_NOTE);
  });

  it('keeps the original URL beside an inlined image that was posted, not forwarded', async () => {
    const url = `https://cdn.discordapp.example/a1/pixel.png?ex=${EX}&is=def&hm=789`;
    stubFetch(PNG);
    const blocks = await buildBlocks([
      makeAttachment({ name: 'pixel.png', url, contentType: 'image/png', size: PNG.length }),
    ]);
    assert.deepEqual(blocks.map((block) => block.type), ['image', 'text', 'text']);
    assert.equal(blocks[1].text, `[image attachment: pixel.png — ${url} ${EXPIRES}]`);
    assert.deepEqual(blocks[2], LINKS_NOTE);
  });

  it('marks inlined forwarded text with its URL, numbering the snapshot when there are several', async () => {
    const body = 'hello\n';
    const first = `https://cdn.discordapp.example/a1/one.txt?ex=${EX}&is=def&hm=1`;
    const second = `https://cdn.discordapp.example/a2/two.txt?ex=${EX}&is=def&hm=2`;
    stubFetch(body);
    const single = await buildBlocks([
      makeAttachment({ name: 'one.txt', url: first, size: 6, forwardedSnapshotIndex: 1 }),
    ]);
    assert.deepEqual(single, [
      { type: 'text', text: `[attachment: one.txt (forwarded) (6B) — ${first} ${EXPIRES}]\n${body}` },
      LINKS_NOTE,
    ]);
    const several = await buildBlocks([
      makeAttachment({ id: 'a1', name: 'one.txt', url: first, size: 6, forwardedSnapshotIndex: 1 }),
      makeAttachment({ id: 'a2', name: 'two.txt', url: second, size: 6, forwardedSnapshotIndex: 2 }),
    ]);
    assert.deepEqual(several, [
      { type: 'text', text: `[attachment: one.txt (forwarded #1) (6B) — ${first} ${EXPIRES}]\n${body}` },
      { type: 'text', text: `[attachment: two.txt (forwarded #2) (6B) — ${second} ${EXPIRES}]\n${body}` },
      LINKS_NOTE,
    ]);
  });

  it('gives each attachment of one message its own URL', async () => {
    const imageUrl = `https://cdn.discordapp.example/a1/pixel.png?ex=${EX}&is=def&hm=3`;
    const textUrl = `https://cdn.discordapp.example/a2/notes.txt?ex=${EX}&is=def&hm=4`;
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response(String(url) === imageUrl ? PNG : 'note\n');
    }) as typeof fetch;
    const blocks = await buildBlocks([
      makeAttachment({ id: 'a1', name: 'pixel.png', url: imageUrl, contentType: 'image/png', size: PNG.length }),
      makeAttachment({ id: 'a2', name: 'notes.txt', url: textUrl, size: 5 }),
    ]);
    assert.deepEqual(fetchCalls, [imageUrl, textUrl]);
    // One note for the message, after all of its markers.
    assert.deepEqual(blocks.map((block) => block.type), ['image', 'text', 'text', 'text']);
    assert.equal(blocks[1].text, `[image attachment: pixel.png — ${imageUrl} ${EXPIRES}]`);
    assert.equal(blocks[2].text, `[attachment: notes.txt (5B) — ${textUrl} ${EXPIRES}]\nnote\n`);
    assert.deepEqual(blocks[3], LINKS_NOTE);
  });

  it('keeps the URL on the marker of an attachment that could not be fetched', async () => {
    const url = `https://cdn.discordapp.example/a1/notes.txt?ex=${EX}&is=def&hm=5`;
    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as typeof fetch;
    const blocks = await buildBlocks([makeAttachment({ url, size: 4 })]);
    assert.deepEqual(blocks, [
      { type: 'text', text: `[attachment: notes.txt — could not fetch (HTTP 404); ${url} ${EXPIRES}]` },
      LINKS_NOTE,
    ]);
  });

  it('marks a forwarded attachment that could not be fetched as forwarded', async () => {
    const url = `https://cdn.discordapp.example/a1/notes.txt?ex=${EX}&is=def&hm=6`;
    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as typeof fetch;
    const blocks = await buildBlocks([makeAttachment({ url, size: 4, forwardedSnapshotIndex: 1 })]);
    assert.deepEqual(blocks, [
      { type: 'text', text: `[attachment: notes.txt (forwarded) — could not fetch (HTTP 404); ${url} ${EXPIRES}]` },
      LINKS_NOTE,
    ]);
  });

  it('keeps the URL on the note of an attachment past the message budget', async () => {
    const url = `https://cdn.discordapp.example/a1/huge.png?ex=${EX}&is=def&hm=7`;
    stubFetch('should never be requested');
    const blocks = await buildBlocks([
      makeAttachment({ name: 'huge.png', url, contentType: 'image/png', size: 41 * 1024 * 1024 }),
    ]);
    assert.equal(fetchCalls.length, 0, 'an attachment past the budget is not fetched');
    assert.deepEqual(blocks, [
      { type: 'text', text: `[attachment: huge.png (41.0MB) not inlined — message attachment budget exhausted: ${url} ${EXPIRES}]` },
      LINKS_NOTE,
    ]);
  });

  it('inlines a text attachment exactly at the cap boundary', async () => {
    const body = 'x'.repeat(5120);
    stubFetch(body);
    const blocks = await buildBlocks([makeAttachment({ size: 5120 })]);
    assert.equal(fetchCalls.length, 1);
    assert.ok(allText(blocks).includes(body), 'exact-cap body should be inlined in full');
    assert.ok(!allText(blocks).includes('not inlined'));
  });

  it('degrades to a note at one declared byte over the cap, without fetching', async () => {
    stubFetch('should never be requested');
    const blocks = await buildBlocks([makeAttachment({ size: 5121 })]);
    assert.equal(fetchCalls.length, 0, 'declared-over-cap must skip the fetch entirely');
    const text = allText(blocks);
    assert.ok(text.includes('over the 5KB inline cap'), text);
    assert.ok(text.includes('not inlined'));
    assert.ok(text.includes('https://cdn.discordapp.example/a1/notes.txt'), 'note keeps the URL');
  });

  it('caps on actual bytes when the declared size lies small', async () => {
    const body = 'y'.repeat(6000); // declared 100, actually 6000
    stubFetch(body);
    const blocks = await buildBlocks([makeAttachment({ size: 100 })]);
    assert.equal(fetchCalls.length, 1);
    const text = allText(blocks);
    assert.ok(!text.includes('yyyy'), 'over-cap bytes must never become a text block');
    assert.ok(text.includes('inline cap'), text);
    assert.ok(text.includes('declared 100B'), 'note names the misdeclared size');
    assert.ok(text.includes('https://cdn.discordapp.example/a1/notes.txt'), 'note keeps the URL');
  });

  it('carries the forwarded provenance marker on over-cap notes', async () => {
    stubFetch('unused');
    const blocks = await buildBlocks([
      makeAttachment({ size: 9000, forwardedSnapshotIndex: 1 }),
    ]);
    const text = allText(blocks);
    assert.ok(text.includes('(forwarded)'), text);
    assert.ok(text.includes('not inlined'));
  });

  it('honors a raised cap, clamped to the 256KiB absolute ceiling', async () => {
    process.env[ENV_KEY] = String(10 * 1024 * 1024); // asks for 10MB
    const body = 'z'.repeat(300 * 1024); // 300KB > 256KiB ceiling
    stubFetch(body);
    const blocks = await buildBlocks([makeAttachment({ size: 300 * 1024, name: 'big.log' })]);
    const text = allText(blocks);
    assert.ok(!text.includes('zzzz'), 'ceiling holds no matter the knob');
    assert.ok(text.includes('not inlined'));
  });

  it('treats 0 as: never auto-inline text attachments', async () => {
    process.env[ENV_KEY] = '0';
    stubFetch('hi');
    const blocks = await buildBlocks([makeAttachment({ size: 2 })]);
    assert.equal(fetchCalls.length, 0);
    const text = allText(blocks);
    assert.ok(!text.includes('hi\n') && !/\bhi\b$/m.test(text), 'no body content inlined');
    assert.ok(text.includes('not inlined'));
  });

  it('rejects a malformed env value and falls back to the 5KiB default', async () => {
    process.env[ENV_KEY] = '5kb'; // parseInt would silently read 5 — must not
    const body = 'w'.repeat(4000); // under the default cap, over a bogus 5-byte cap
    stubFetch(body);
    const blocks = await buildBlocks([makeAttachment({ size: 4000 })]);
    assert.ok(allText(blocks).includes(body), 'falls back to default, inlines a 4KB file');
  });

  it('rejects a negative env value and falls back to the 5KiB default', async () => {
    process.env[ENV_KEY] = '-1';
    stubFetch('should never be requested');
    const blocks = await buildBlocks([makeAttachment({ size: 6000 })]);
    assert.equal(fetchCalls.length, 0, '6KB is over the default cap');
    assert.ok(allText(blocks).includes('not inlined'));
  });

  it('retains at most cap+1 bytes from one giant stream chunk and cancels immediately', async () => {
    // A reader may deliver far more than the remaining allowance in a single
    // chunk. The helper must slice retention to cap+1 and cancel — not hold
    // the whole chunk before noticing overflow.
    let pulls = 0;
    let cancelled = false;
    const giant = new Uint8Array(10 * 1024 * 1024).fill(0x79); // 10MB of 'y'
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(giant);
        },
        cancel() {
          cancelled = true;
        },
      },
      // highWaterMark 0: no internal prefetch, so each pull corresponds to
      // an actual reader.read() — making "one read, then cancel" assertable.
      { highWaterMark: 0 },
    );
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response(stream);
    }) as typeof fetch;

    const blocks = await buildBlocks([makeAttachment({ size: 100 })]); // declared small
    const text = allText(blocks);
    assert.ok(!text.includes('yyyy'), 'giant chunk must not become a text block');
    assert.ok(text.includes('inline cap'), text);
    assert.equal(pulls, 1, 'overflow must be decided on the first giant chunk');
    assert.ok(cancelled, 'reader must be cancelled immediately on overflow');
  });

  it('fails closed on a bodyless response instead of buffering unknown data', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response(null);
    }) as typeof fetch;
    const blocks = await buildBlocks([makeAttachment({ size: 100 })]);
    const text = allText(blocks);
    assert.ok(text.includes('not inlined'), text);
  });

  it('images are unaffected by the cap: a zero cap still yields an image block', async () => {
    process.env[ENV_KEY] = '0';
    stubFetch(PNG);
    const blocks = await buildBlocks([
      makeAttachment({ name: 'pixel.png', contentType: 'image/png', size: PNG.length }),
    ]);
    assert.equal(fetchCalls.length, 1, 'image is fetched despite cap 0');
    assert.ok(
      blocks.some((b) => b.type === 'image'),
      `expected a native image block, got: ${JSON.stringify(blocks.map((b) => b.type))}`,
    );
  });

  it('leaves non-text attachments on their existing note path', async () => {
    stubFetch('unused');
    const blocks = await buildBlocks([
      makeAttachment({ name: 'song.flac', contentType: 'audio/flac', size: 4_000_000 }),
    ]);
    assert.equal(fetchCalls.length, 0);
    assert.ok(allText(blocks).includes('not inlined'));
  });

  it("says when each marker's link expires, in every marker form, and how to refresh once", async () => {
    const at = (name: string) => `https://cdn.discordapp.example/${name}?ex=${EX}&is=def&hm=9`;
    const responses: Record<string, Response> = {
      [at('pixel.png')]: new Response(PNG),
      [at('broken.png')]: new Response('not an image'),
      [at('gone.png')]: new Response('gone', { status: 404 }),
      [at('liar.txt')]: new Response('z'.repeat(6000)),
      [at('small.txt')]: new Response('ok\n'),
    };
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return responses[String(url)] ?? new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    const blocks = await buildBlocks([
      makeAttachment({ id: 'b1', name: 'big.txt', url: at('big.txt'), size: 9000 }),
      makeAttachment({ id: 'b2', name: 'huge.png', url: at('huge.png'), contentType: 'image/png', size: 41 * 1024 * 1024 }),
      makeAttachment({ id: 'b3', name: 'large.png', url: at('large.png'), contentType: 'image/png', size: 30 * 1024 * 1024 }),
      makeAttachment({ id: 'b4', name: 'pixel.png', url: at('pixel.png'), contentType: 'image/png', size: PNG.length }),
      makeAttachment({ id: 'b5', name: 'broken.png', url: at('broken.png'), contentType: 'image/png', size: 12 }),
      makeAttachment({ id: 'b6', name: 'liar.txt', url: at('liar.txt'), size: 100 }),
      makeAttachment({ id: 'b7', name: 'small.txt', url: at('small.txt'), size: 3 }),
      makeAttachment({ id: 'b8', name: 'song.flac', url: at('song.flac'), contentType: 'audio/flac', size: 4_000_000 }),
      makeAttachment({ id: 'b9', name: 'gone.png', url: at('gone.png'), contentType: 'image/png', size: 10 }),
    ]);
    const markers = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '');
    const forms = [
      ['big.txt', 'over the 5KB inline cap'],
      ['huge.png', 'budget exhausted'],
      ['large.png', 'too large to fetch'],
      ['pixel.png', 'image attachment: pixel.png'],
      ['broken.png', 'could not be inlined'],
      ['liar.txt', 'declared 100B'],
      ['small.txt', 'small.txt (3B)'],
      ['song.flac', 'audio/flac'],
      ['gone.png', 'could not fetch'],
    ];
    for (const [name, form] of forms) {
      const marker = markers.find((text) => text.includes(at(name)) && text.includes(form));
      assert.ok(marker, `no marker for ${name} (${form}): ${markers.join(' | ')}`);
      assert.ok(marker.includes(`${at(name)} ${EXPIRES}]`), marker);
    }
    // The refresh note comes once, last, after every marker.
    assert.deepEqual(blocks.filter((block) => block.text === LINKS_NOTE.text).length, 1);
    assert.deepEqual(blocks[blocks.length - 1], LINKS_NOTE);
  });

  it('says nothing about expiry when a URL has no readable ex', async () => {
    stubFetch('ok\n');
    for (const url of [
      'https://cdn.discordapp.example/a1/notes.txt',
      'https://cdn.discordapp.example/a1/notes.txt?ex=&is=def',
      'https://cdn.discordapp.example/a1/notes.txt?ex=nothex&is=def',
      `https://cdn.discordapp.example/a1/notes.txt?ex=${EX}zz&is=def`,
      'https://cdn.discordapp.example/a1/notes.txt?ex=1234567890abcdef&is=def',
      'not a url at all',
    ]) {
      const blocks = await buildBlocks([makeAttachment({ url, size: 3 })]);
      assert.deepEqual(blocks, [{ type: 'text', text: `[attachment: notes.txt (3B) — ${url}]\nok\n` }], url);
    }
  });

  it('truncates the expiry to its minute, so the marker never says a link lasts longer than it does', async () => {
    const ex = (Date.UTC(2026, 9, 16, 1, 12, 59) / 1000).toString(16);
    const url = `https://cdn.discordapp.example/a1/notes.txt?ex=${ex}&is=def&hm=1`;
    stubFetch('ok\n');
    const blocks = await buildBlocks([makeAttachment({ url, size: 3 })]);
    assert.equal(blocks[0].text, `[attachment: notes.txt (3B) — ${url} (link expires 2026-10-16 01:12 UTC)]\nok\n`);
  });

  it('adds the refresh line when any marker of a message has an expiry, and dates only those', async () => {
    const signed = `https://cdn.discordapp.example/a1/one.txt?ex=${EX}&is=def&hm=1`;
    const unsigned = 'https://cdn.discordapp.example/a2/two.txt';
    stubFetch('ok\n');
    for (const order of [[signed, unsigned], [unsigned, signed]]) {
      const blocks = await buildBlocks(order.map((url, i) => makeAttachment({ id: `a${i}`, name: url.includes('one') ? 'one.txt' : 'two.txt', url, size: 3 })));
      assert.deepEqual(blocks.map((block) => block.text), [
        ...order.map((url) => url === signed
          ? `[attachment: one.txt (3B) — ${signed} ${EXPIRES}]\nok\n`
          : `[attachment: two.txt (3B) — ${unsigned}]\nok\n`),
        LINKS_NOTE.text,
      ], order.join(' then '));
    }
  });

  it('gives history results each attachment\'s expiry beside its url, forwarded ones too', () => {
    const signed = `https://cdn.discordapp.example/a1/notes.txt?ex=${EX}&is=def&hm=1`;
    const unsigned = 'https://cdn.discordapp.example/a2/old.txt';
    const forwarded = `https://cdn.discordapp.example/a3/fwd.txt?ex=${EX}&is=def&hm=3`;
    const attachments = new Map([
      ['a1', { id: 'a1', name: 'notes.txt', url: signed, contentType: 'text/plain', size: 3 }],
      ['a2', { id: 'a2', name: 'old.txt', url: unsigned, contentType: 'text/plain', size: 3 }],
    ]);
    const snapshot = { attachments: new Map([['a3', { id: 'a3', name: 'fwd.txt', url: forwarded, contentType: 'text/plain', size: 3 }]]) };
    const mapped = mapAllAttachments({ attachments, messageSnapshots: new Map([['s1', snapshot]]) as never });
    assert.equal(mapped[0].expiresAt, '2026-10-16T01:12:00.000Z');
    assert.equal('expiresAt' in mapped[1], false, 'no readable ex, no expiresAt');
    assert.equal(mapped[2].forwardedSnapshotIndex, 1);
    assert.equal(mapped[2].expiresAt, '2026-10-16T01:12:00.000Z');
  });

  it('tells the agent in both history tools what expiresAt means', () => {
    for (const name of ['fetch_history', 'fetch_around']) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, name);
      assert.ok(
        tool.description.includes("An attachment's url is signed by Discord and stops working at its expiresAt, when it has one; fetching the message again returns a fresh one."),
        `${name}: ${tool.description}`,
      );
    }
  });
});
