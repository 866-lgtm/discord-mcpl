/**
 * What Discord's answer means for the id a tool was given.
 *
 * An id Discord doesn't know comes back as two words, "Unknown Channel",
 * which says nothing about what went wrong or what to do instead. A name has
 * the resolver's own answers (channel-names.ts); an id has no candidates to
 * list, so the explanation names what the answer means for the id that was
 * passed and how to get a real one. Ids get misremembered: one recalled
 * rather than copied is the commonest way to reach this.
 *
 * The explanation is appended after the error's own text, so the error's
 * words stay as they were. Errors other than these five pass through
 * unchanged.
 */
import { isSnowflake } from './channel-names.js';
import { parseMcplChannelId } from './channels.js';

/** Discord's JSON error codes for an id it can't resolve, or can't reach. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_GUILD = 10004;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_USER = 10013;
const MISSING_ACCESS = 50001;

/** What the tool chokepoint knows that the args no longer show. */
export interface ExplainContext {
  /** The channel the model named, when it was a name or a composite that
   *  handleToolCall resolved to the id now in args.channelId. */
  channelGiven?: string;
}

export function explainDiscordError(err: unknown, args: Record<string, unknown>, ctx: ExplainContext = {}): string {
  const carried = (err as { message?: unknown } | null)?.message;
  const message = typeof carried === 'string' ? carried : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  const given = (key: string): string | undefined =>
    typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
  const channel = given('channelId');
  const guild = given('guildId');
  const user = given('userId');
  // A name (not a composite, which carries its id) resolved to `channel`.
  const named = ctx.channelGiven && !parseMcplChannelId(ctx.channelGiven) ? ctx.channelGiven : undefined;
  const recalled = 'the id may be mistyped or remembered rather than copied';
  let why: string | undefined;
  switch (code) {
    case UNKNOWN_CHANNEL:
      if (named && channel) {
        // The name already resolved: sending it again would reach the same id.
        why =
          `${named} resolved to channel ${channel}, which Discord doesn't know: it may have been deleted ` +
          "since this connection last saw it. list_channels shows a server's channels now, with their ids.";
      } else if (!channel && given('categoryId')) {
        why =
          `No category ${given('categoryId')} is visible to this connection: ${recalled}, or the category deleted. ` +
          "list_channels shows a server's channels, categories included, with their ids.";
      } else {
        // The name route covers text, announcement and voice channels only
        // (resolveChannelRef leaves out threads, forums, categories and DMs),
        // so a thread or DM isn't sent back to a name that could match
        // another channel.
        why =
          `${channel ? `No channel ${channel}` : 'No such channel'} is visible to this connection: ${recalled}, ` +
          'or the channel deleted. For a text, announcement or voice channel, re-send with its name instead ' +
          "(#name, or #name (Server)), or take its id from list_channels, which shows a server's channels. " +
          "A thread or DM has no name route: its id has to be copied from where it was shown, not recalled.";
      }
      break;
    case UNKNOWN_GUILD:
      why =
        `${guild ? `No server ${guild}` : 'No such server'} is visible to this connection: ${recalled}, or the ` +
        'bot is no longer in it. list_guilds shows the servers this bot is in, with their ids.';
      break;
    case UNKNOWN_MESSAGE:
      why =
        `${given('messageId') ? `No message ${given('messageId')}` : 'No such message'} is visible` +
        `${channel ? ` in channel ${channel}` : ''}: ${recalled}, ` +
        'the message deleted, or in another channel. Copy the message id from fetch_history or from the ' +
        'message as it arrived, with the channel it arrived in.';
      break;
    case UNKNOWN_USER:
      why = !user
        ? 'A user this call needed is gone from Discord.'
        : isSnowflake(user)
          ? `No user ${user} is known to Discord: ${recalled}. A message's author and list_channel_members ` +
            'show real ids, and a name works for someone who shares a server with this bot or has DMed it ' +
            '(@username or display name).'
          // A name the adapter resolved: sending it again would reach the same account.
          : `${user} matched an account Discord no longer knows: it may have been deleted. A message's author ` +
            'and list_channel_members show the ids of accounts that exist.';
      break;
    case MISSING_ACCESS:
      // Named by what the call was aimed at: a channel, else a server.
      why = channel
        ? `This bot can't reach channel ${channel}: the channel's permissions or its server leave this bot ` +
          "out, or it's a DM this bot isn't in. For a server channel, list_channels shows the channels this bot " +
          "can see there, within the configured filters; threads and DMs aren't listed."
        : guild
          ? `This bot can't reach server ${guild}: it isn't in it, or can't see what this call needs there. ` +
            'list_guilds shows the servers it is in.'
          : "This bot can't reach what this call needs: permissions leave it out.";
      break;
  }
  return why ? `${message}\n\n${why}` : message;
}
