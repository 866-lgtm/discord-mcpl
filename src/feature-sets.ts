/**
 * Feature set declarations for the Discord MCPL server.
 */

import type { FeatureSetDeclaration } from '@connectome/mcpl-core';

export const featureSets: FeatureSetDeclaration[] = [
  {
    name: 'discord.messaging',
    description: 'Send, read, react to messages in Discord channels',
    uses: ['tools', 'channels.publish'],
    rollback: true,
    hostState: false,
  },
  {
    name: 'discord.channels',
    description: 'Create, delete, and manage Discord channels',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'discord.history',
    description: 'Fetch message history from Discord channels',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
];

/** Check if a feature set is in a given enabled list. */
export function isEnabled(name: string, enabledSets: Set<string>): boolean {
  // Check exact match
  if (enabledSets.has(name)) return true;
  // Check wildcard (e.g., "discord.*")
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.') + '.*';
    if (enabledSets.has(prefix)) return true;
  }
  return false;
}

/** Get the feature set that owns a given tool. Returns undefined for always-available tools. */
export function featureSetForTool(toolName: string): string | undefined {
  switch (toolName) {
    case 'send_message':
    case 'reply_message':
    case 'send_dm':
    case 'add_reaction':
    case 'edit_message':
    case 'delete_message':
      return 'discord.messaging';
    case 'create_text_channel':
    case 'delete_channel':
      return 'discord.channels';
    case 'fetch_history':
      return 'discord.history';
    case 'list_guilds':
    case 'list_channels':
      return undefined; // Always available
    default:
      return undefined;
  }
}
