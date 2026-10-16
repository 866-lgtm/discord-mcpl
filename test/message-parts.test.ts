/**
 * A message longer than 1,900 UTF-16 units is sent in parts, cut at a line
 * break or a space late enough in the first 1,900 units, or else hard at
 * 1,900. A hard cut falls at the last character boundary at or before 1,900
 * (a grapheme's, as Intl.Segmenter finds them), so no part ends with part of
 * a character the next one finishes: half a surrogate pair, part of an
 * emoji's ZWJ sequence, one of a flag's two regional indicators, or a letter
 * without its combining mark. Only a single character longer than 1,900
 * units is cut inside, and then never between the halves of a pair.
 *
 * Run: node --import tsx --test test/message-parts.test.ts
 */
import { describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordAdapter } from '../src/discord-adapter.js';

const CHANNEL = '444444444444444444';

/** The parts the real sendMessage sends for `text`, to a channel that takes them all. */
async function partsOf(t: TestContext, text: string): Promise<string[]> {
  const adapter = new DiscordAdapter({ token: 'unused' });
  const client = (adapter as unknown as { client: { channels: { fetch: unknown }; destroy(): void } }).client;
  t.after(() => client.destroy());
  const parts: string[] = [];
  client.channels.fetch = async () => ({
    id: CHANNEL,
    guildId: '555555555555555555',
    isDMBased: () => false,
    send: async (payload: { content?: string }) => {
      parts.push(payload.content ?? '');
      return { id: `90000000000000000${parts.length}` };
    },
  });
  await adapter.sendMessage(CHANNEL, text);
  return parts;
}

const high = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

describe('a message sent in parts', () => {
  it('is never cut between the two halves of a surrogate pair', async (t) => {
    // No line break or space, so the cut is hard: at 1,900 units, which here
    // falls between the halves of the emoji at units 1,899 and 1,900.
    const inside = `${'a'.repeat(1899)}🙂${'b'.repeat(100)}`;
    assert.deepEqual(await partsOf(t, inside), ['a'.repeat(1899), `🙂${'b'.repeat(100)}`]);
    // A pair that ends at the cut stays whole in the first part.
    const before = `${'a'.repeat(1898)}🙂${'b'.repeat(100)}`;
    assert.deepEqual(await partsOf(t, before), [`${'a'.repeat(1898)}🙂`, 'b'.repeat(100)]);
    // Emoji throughout, after one letter: each pair starts at an odd unit, so
    // a hard cut at 1,900 would fall inside one.
    const emoji = `a${'🙂'.repeat(2000)}`;
    const parts = await partsOf(t, emoji);
    assert.equal(parts.join(''), emoji);
    for (const part of parts) {
      assert.ok(!high(part.charCodeAt(part.length - 1)), 'no part ends with the first half of a pair');
      assert.ok(!low(part.charCodeAt(0)), 'no part begins with the second half of a pair');
    }
  });

  it('is never cut inside a character a reader sees as one: a ZWJ sequence, a flag, a letter and its mark', async (t) => {
    // The family emoji is three emoji joined by two ZWJs, 8 units from 1,896:
    // a cut at 1,900 falls inside it, and the surrogate guard alone would
    // leave the man and a ZWJ at the end of the first part.
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    assert.deepEqual(await partsOf(t, `${'a'.repeat(1896)}${family}${'b'.repeat(100)}`),
      ['a'.repeat(1896), `${family}${'b'.repeat(100)}`]);
    // A flag is two regional indicators, 4 units from 1,898: a cut at 1,900
    // falls between them, a code point boundary the surrogate guard keeps.
    const flag = '\u{1F1EF}\u{1F1F5}';
    assert.deepEqual(await partsOf(t, `${'a'.repeat(1898)}${flag}${'b'.repeat(100)}`),
      ['a'.repeat(1898), `${flag}${'b'.repeat(100)}`]);
    // An e and its combining acute accent, at 1,899 and 1,900.
    assert.deepEqual(await partsOf(t, `${'a'.repeat(1899)}e\u0301${'b'.repeat(100)}`),
      ['a'.repeat(1899), `e\u0301${'b'.repeat(100)}`]);
  });

  it('cuts a single character longer than 1,900 units inside, never between the halves of a pair', async (t) => {
    // A letter with 2,000 combining marks is one grapheme: no boundary to cut
    // at, so the cut falls at 1,900.
    const marks = `a${'\u0301'.repeat(2000)}`;
    const parts = await partsOf(t, marks);
    assert.equal(parts.join(''), marks);
    assert.equal(parts[0].length, 1900);
    // Skin-tone modifiers extend the letter before them into one grapheme, and
    // each is a surrogate pair from an odd unit: the one at 1,899 is kept
    // whole, so the first part ends at 1,899.
    const tones = `a${'\u{1F3FB}'.repeat(1000)}`;
    const toned = await partsOf(t, tones);
    assert.equal(toned.join(''), tones);
    assert.equal(toned[0].length, 1899);
    for (const part of toned) {
      assert.ok(!high(part.charCodeAt(part.length - 1)), 'no part ends with the first half of a pair');
      assert.ok(!low(part.charCodeAt(0)), 'no part begins with the second half of a pair');
    }
  });
});
