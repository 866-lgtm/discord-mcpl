/**
 * MCPL RFC-008 tool classes. Every tool this server can list, and every tool
 * it dispatches without listing, must be in TOOL_CLASSES or UNCLASSED, so a
 * new tool fails here until someone decides its class.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toolDefinitions, type ToolDefinition } from '../src/tools.js';
import {
  TOOL_CLASSES,
  TOOL_CLASS_META_KEY,
  TOOL_CLASS_VOCABULARY,
  UNCLASSED,
  withToolClasses,
} from '../src/tool-classes.js';

const listed = toolDefinitions.map((t) => t.name);

/** Tool names the server dispatches: the `case '…':` labels in
 *  executeToolCall's switch, up to its `Unknown tool` default. This is what
 *  catches tools that are callable but not listed. */
function dispatchedToolNames(): string[] {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = src.indexOf('private async executeToolCall(');
  assert.ok(start >= 0, 'executeToolCall not found in src/server.ts');
  const end = src.indexOf('Unknown tool:', start);
  assert.ok(end > start, "executeToolCall's Unknown tool default not found");
  return [...src.slice(start, end).matchAll(/case '([^']+)':/g)].map((m) => m[1]);
}

const isClassed = (name: string): boolean => Object.hasOwn(TOOL_CLASSES, name);
const isAccountedFor = (name: string): boolean => isClassed(name) || UNCLASSED.has(name);

describe('MCPL RFC-008 tool classes', () => {
  it('every listed tool is classed or deliberately unclassed', () => {
    assert.ok(listed.length > 0);
    const missing = listed.filter((n) => !isAccountedFor(n));
    assert.deepEqual(missing, [], `add these to TOOL_CLASSES or UNCLASSED in src/tool-classes.ts: ${missing.join(', ')}`);
  });

  it('every dispatched tool, listed or not, is classed or deliberately unclassed', () => {
    const dispatched = dispatchedToolNames();
    // The scan must see the whole switch: every listed tool is dispatched
    // there, so a scan that misses one is reading the wrong span.
    const unseen = listed.filter((n) => !dispatched.includes(n));
    assert.deepEqual(unseen, [], 'dispatch scan missed listed tools; update dispatchedToolNames()');
    const missing = dispatched.filter((n) => !isAccountedFor(n));
    assert.deepEqual(missing, [], `add these to TOOL_CLASSES or UNCLASSED in src/tool-classes.ts: ${missing.join(', ')}`);
  });

  it('has no stale entries: every name is a tool the server lists or dispatches', () => {
    const known = new Set([...listed, ...dispatchedToolNames()]);
    const stale = [...Object.keys(TOOL_CLASSES), ...UNCLASSED].filter((n) => !known.has(n));
    assert.deepEqual(stale, []);
  });

  it('no tool is both classed and unclassed', () => {
    assert.deepEqual([...UNCLASSED].filter(isClassed), []);
  });

  it('every class is from the RFC-008 vocabulary, non-empty and without repeats', () => {
    const vocabulary = new Set<string>(TOOL_CLASS_VOCABULARY);
    for (const [name, classes] of Object.entries(TOOL_CLASSES)) {
      assert.ok(classes.length > 0, `${name}: empty class list (use UNCLASSED instead)`);
      assert.equal(new Set(classes).size, classes.length, `${name}: repeated class`);
      for (const c of classes) assert.ok(vocabulary.has(c), `${name}: '${c}' is not an RFC-008 class`);
    }
  });

  it("tools that carry or read people's messages are comms", () => {
    for (const name of [
      'send_message', 'reply_message', 'send_dm', 'edit_message', 'delete_message',
      'fetch_history', 'fetch_around',
    ]) {
      assert.ok(TOOL_CLASSES[name]?.includes('comms'), `${name} must be comms`);
    }
  });

  it('merges into existing _meta without overwriting or mutating it', () => {
    const tool: ToolDefinition = {
      name: 'send_message',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      _meta: { featureSet: 'discord.messaging' },
    };
    const out = withToolClasses(tool);
    assert.deepEqual(out._meta, {
      featureSet: 'discord.messaging',
      [TOOL_CLASS_META_KEY]: ['comms', 'files'],
    });
    assert.deepEqual(tool._meta, { featureSet: 'discord.messaging' }, 'input untouched');
  });

  it('an unclassed tool carries no mcpl/class key', () => {
    const tool: ToolDefinition = {
      name: 'not_a_real_tool',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
    };
    assert.equal(withToolClasses(tool), tool);
    // Names inherited from Object.prototype are not classes either.
    assert.equal(withToolClasses({ ...tool, name: 'constructor' })._meta, undefined);
  });
});
