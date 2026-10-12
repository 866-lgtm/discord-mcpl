/**
 * Tests for the text-attachment inline cap (issue #30).
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

const ENV_KEY = 'DISCORD_ATTACHMENT_INLINE_MAX_BYTES';

type Block = { type: string; text?: string };

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
    // 1x1 transparent PNG — real bytes so the sharp normalization path runs.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    stubFetch(png);
    const blocks = await buildBlocks([
      makeAttachment({ name: 'pixel.png', contentType: 'image/png', size: png.length }),
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
});
