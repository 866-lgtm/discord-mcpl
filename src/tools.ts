/**
 * MCP tool definitions and input types for Discord operations.
 * These tools work in both MCP and MCPL mode.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Reusable schema for the optional `files` attachment parameter on send tools. */
const FILES_PROP = {
  type: 'array',
  description:
    'Optional file attachments to upload with the message. Each entry is read ' +
    'from a local filesystem path on the host (e.g. a file you created in your ' +
    'workspace or sandbox). Up to 10 files per message; size limits are enforced ' +
    'by Discord.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute local filesystem path to the file to upload' },
      name: { type: 'string', description: 'Optional display filename (defaults to the basename of path)' },
      description: { type: 'string', description: 'Optional alt-text / description shown for accessibility' },
    },
    required: ['path'],
  },
};

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a message to a Discord channel, optionally with file attachments',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        content: { type: 'string', description: 'Message content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['channelId'],
    },
  },
  {
    name: 'reply_message',
    description: 'Reply to a specific message in a Discord channel, optionally with file attachments',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to reply to' },
        content: { type: 'string', description: 'Reply content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'send_dm',
    description: "Send a direct message to a Discord user, identified by @username / display name (of someone in a shared server or who has DMed the bot) or by numeric user ID. To reply to a DM you received, pass the sender's name or id. Optionally include file attachments.",
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Discord @username / display name (of a member in a shared server or someone who has DMed the bot), or a numeric user ID (snowflake)' },
        content: { type: 'string', description: 'Message content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['userId'],
    },
  },
  {
    name: 'add_reaction',
    description: 'Add a reaction (emoji) to a message',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to react to' },
        emoji: { type: 'string', description: 'Emoji (unicode or custom :name:)' },
      },
      required: ['channelId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to edit' },
        content: { type: 'string', description: 'New message content' },
      },
      required: ['channelId', 'messageId', 'content'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: { type: 'string', description: 'Message ID to delete' },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'list_guilds',
    description: 'List Discord guilds (servers) the bot is in',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_channels',
    description: 'List channels in a Discord guild',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Discord guild ID' },
      },
      required: ['guildId'],
    },
  },
  {
    name: 'refresh_channels',
    description:
      'Re-scan every Discord channel the bot can currently see and register any ' +
      'that the host does not yet know about. Use this if you were added to a new ' +
      'server or channel after startup and it is not showing up in your channel ' +
      'list. Returns the count of visible channels and any newly-registered ones.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'fetch_history',
    description:
      'Fetch message history from a channel. By default returns the most recent ' +
      'messages. Use `before` (a message ID) to scroll further back — pass the ID ' +
      'of the oldest message you have seen to page backwards through older history. ' +
      'Use `after` (a message ID) to fetch only messages newer than a given point. ' +
      'Pagination is automatic, so `limit` may exceed Discord\'s 100-per-request cap.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        limit: { type: 'number', description: 'Max messages to fetch (default 50)' },
        before: {
          type: 'string',
          description:
            'Only fetch messages older than this message ID (exclusive). ' +
            'Use the oldest ID you already have to page further back.',
        },
        after: {
          type: 'string',
          description:
            'Only fetch messages newer than this message ID (exclusive). ' +
            'Use the newest ID you already have to fetch what is new.',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'fetch_around',
    description:
      'Scroll to a specific message and fetch the surrounding context. Returns a ' +
      'window of messages centred on `messageId` (the message itself plus roughly ' +
      'half the window on either side). Single request, so `limit` is capped at 100.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        messageId: {
          type: 'string',
          description: 'The message ID to centre the window on',
        },
        limit: {
          type: 'number',
          description: 'Total window size, centred on the message (default 50, max 100)',
        },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'create_text_channel',
    description: 'Create a new text channel in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Discord guild ID' },
        name: { type: 'string', description: 'Channel name' },
        categoryId: { type: 'string', description: 'Parent category ID (optional)' },
      },
      required: ['guildId', 'name'],
    },
  },
  {
    name: 'delete_channel',
    description: 'Delete a Discord channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID to delete' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'subscribe_channel',
    description:
      'Subscribe to ambient (non-mention) messages from a Discord channel. ' +
      'Direct mentions and DMs always come through regardless of subscriptions; ' +
      'this only controls passive awareness of channel chatter. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID to subscribe to' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'unsubscribe_channel',
    description:
      'Stop receiving ambient messages from a Discord channel. Mentions and DMs ' +
      'from that channel will still arrive. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID to unsubscribe from' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'list_subscriptions',
    description:
      'List the Discord channels currently subscribed for ambient message ' +
      'delivery. Also reports `unsubscribedWithBacklog`: channels you have ' +
      'unsubscribed from that have since accumulated missed ambient messages.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'channel_missed',
    description:
      'Report how much ambient (non-mention, non-DM) traffic you have missed in ' +
      'a channel since you unsubscribed from it — returns missed message and ' +
      'character counts. Mentions and DMs are always delivered and are not ' +
      'counted. Useful for deciding whether to resubscribe. Counts are durable ' +
      'across restarts and backfill downtime gaps on reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID to check' },
      },
      required: ['channelId'],
    },
  },
];
