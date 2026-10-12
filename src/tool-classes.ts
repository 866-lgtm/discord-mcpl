/**
 * MCPL RFC-008 tool classes for every tool this server exposes.
 * https://github.com/anima-research/mcpl/blob/main/RFC-008-tool-classes.md
 *
 * tools/list carries each tool's classes as `_meta["mcpl/class"]`. Hosts use
 * them to decide how a tool is handled, notably what tool-lifecycle observers
 * may see of its calls. A tool may name several classes; the host applies the
 * union of their restrictions, so adding a class can only make handling
 * stricter.
 *
 * The comms rule: a tool that sends people's messages, or reads them, is
 * `comms`, whichever direction the words travel. Classing such a tool as
 * anything else is the one dangerous mistake here, because comms arguments
 * are never shared with observers and other classes may be.
 *
 * An unclassed tool (no key) is treated as the most restrictive class, so
 * leaving a tool out is always safe. Deliberate omissions go in UNCLASSED;
 * test/tool-classes.test.ts fails until every tool the server lists or
 * dispatches is in one of the two.
 */

import type { ToolDefinition } from './tools.js';

/** RFC-008 §4 vocabulary. */
export const TOOL_CLASS_VOCABULARY = [
  'comms',
  'memory',
  'notes',
  'files',
  'shell',
  'web',
  'computer',
  'media',
  'body',
  'control',
] as const;

export type ToolClass = (typeof TOOL_CLASS_VOCABULARY)[number];

/** The `_meta` key RFC-008 §3 defines on a tool definition. */
export const TOOL_CLASS_META_KEY = 'mcpl/class';

export const TOOL_CLASSES: Record<string, readonly ToolClass[]> = {
  // Sending: these also upload `files[].path` from this host.
  send_message: ['comms', 'files'],
  reply_message: ['comms', 'files'],
  send_dm: ['comms', 'files'],

  // Acting on, or reading, people's messages, and the directory of who and
  // where they are.
  add_reaction: ['comms'],
  remove_reaction: ['comms'],
  edit_message: ['comms'],
  delete_message: ['comms'],
  fetch_history: ['comms'],
  fetch_around: ['comms'],
  list_channel_members: ['comms'],
  list_guilds: ['comms'],
  list_channels: ['comms'],
  list_emojis: ['comms'],

  // Channel administration: changes the spaces people talk in.
  create_text_channel: ['comms', 'control'],
  delete_channel: ['comms', 'control'],

  // Server settings and subscription state (ids and counts, no message content).
  filters_get: ['control'],
  filters_update: ['control'],
  refresh_channels: ['control'],
  set_reaction_visibility: ['control'],
  mute_channel: ['control'],
  unmute_channel: ['control'],
  list_subscriptions: ['control'],
  channel_missed: ['control'],

  // Retired: still callable (they point at the host's channel tools) but not listed.
  subscribe_channel: ['control'],
  unsubscribe_channel: ['control'],
};

/** Tools deliberately left unclassed. Hosts treat them as most restrictive. */
export const UNCLASSED: ReadonlySet<string> = new Set<string>([]);

/** The tool definition as tools/list should carry it: its RFC-008 classes
 *  merged into any `_meta` it already has. Unclassed tools are returned
 *  unchanged (no key). Never mutates the input. */
export function withToolClasses(tool: ToolDefinition): ToolDefinition {
  if (!Object.hasOwn(TOOL_CLASSES, tool.name)) return tool;
  return {
    ...tool,
    _meta: { ...tool._meta, [TOOL_CLASS_META_KEY]: [...TOOL_CLASSES[tool.name]] },
  };
}
