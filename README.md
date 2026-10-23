# discord-mcpl

discord-mcpl puts an AI agent on Discord through a bot account. It is an [MCPL](https://github.com/anima-research/mcpl) server. MCPL (MCP Live) extends the [Model Context Protocol](https://modelcontextprotocol.io/) so that a server can register channels with its host and push events to it, besides offering tools. Through discord-mcpl, the agent reads and posts in Discord channels and DMs, and messages that mention the bot, reply to it or DM it reach the agent's host even from channels the agent hasn't opened.

In the Connectome stack, [connectome-host](https://github.com/anima-research/connectome-host) runs agents on [agent-framework](https://github.com/anima-research/agent-framework), which starts discord-mcpl as a child process and talks to it over stdio. An MCP client can run it too, as a server that offers tools only. Its protocol code comes from [`@animalabs/mcpl-core`](https://github.com/anima-research/mcpl-core-ts), and [slack-mcpl](https://github.com/anima-research/slack-mcpl) and [telegram-mcpL](https://github.com/anima-research/telegram-mcpL) are its counterparts for Slack and Telegram.

## What it does

- **Channels.** discord-mcpl registers Discord channels with its host as MCPL [channels](https://github.com/anima-research/mcpl/blob/main/SPEC.md#14-channels-of-communication), with IDs of the form `discord:<guildId>:<channelId>`, or `discord:dm:<channelId>` for a DM. (A guild is what Discord's API calls a server.) The host opens and closes channels, and discord-mcpl delivers the messages posted in an open channel as they arrive.
- **Messages addressed to the bot.** discord-mcpl also delivers a message that mentions the bot or its own role, replies to one of the bot's messages, or comes as a DM, whether or not its channel is open, as long as the filters admit it and the agent hasn't muted that channel. Messages delivered as they arrive carry MCPL [event tags](https://github.com/anima-research/mcpl/blob/main/SPEC.md#16-event-tags), such as `chat:mention`, `chat:reply`, `chat:dm`, `chat:ambient` and `chat:from-bot`, which the host's wake policy can match.
- **Edits, deletions and reactions.** discord-mcpl delivers edits and deletions from DMs and open channels, and reactions from server channels where reaction visibility is on. Opening a channel turns its reaction visibility on and closing it turns it off, and the agent can also set it with `set_reaction_visibility`. discord-mcpl doesn't request Discord's DM reaction events, so reactions in DMs never arrive.
- **Attachments.** Images arrive inline, with still images scaled down to at most 1568 pixels on their longest side. Text files are inlined up to a size limit, 5 KiB by default. Other files, and images too large to inline, arrive as a note with the file's name, size and URL.
- **Catch-up after downtime.** With `DISCORD_WATERMARK_FILE` set, discord-mcpl saves a catch-up position for each channel it has delivered from, which is the newest message it has delivered or scanned there. After the first host connects, it reads up to `DISCORD_CATCHUP_LIMIT` messages after each saved position and delivers those the current filters admit. In DMs and open channels that's all of them, and in other channels it's each mention of the bot with up to seven messages on either side.
- **Filters.** Environment variables or a JSON filters file choose which Discord servers, channels and DM senders the agent hears from. Edits to the file take effect within seconds, and with the file configured, the agent can change the server and DM lists with `filters_update`. With no filters set, the agent hears from every server the bot is in and from anyone who DMs it.
- **Admin commands.** Discord users listed in `DISCORD_ADMIN_USERS` can run five slash commands. Each asks the host to act through a `host/command` request. agent-framework carries it out only for a server whose configuration sets `allowHostCommands: true`, and refuses it otherwise.
  - `/undo [messages] [marks]` removes the last messages from the agent's context (1 by default, at most 50).
  - `/hide message [to] [marks]` removes a message, or the range from it through `to`, from the agent's context. Both take a message link or ID.
  - `marks` on `/undo` chooses which removed messages get a 💤 awareness mark: `none`, the default, `addressed`, those that addressed the agent, or `all`. The host places those marks, so `/undo` needs a host whose agent framework has the `marks` host command (anima-research/agent-framework#250), and is refused on an older host.
  - `marks` on `/hide` is `none`, the default, or `all`, which adds 💤 to each hidden message. Those marks are discord-mcpl's own, on any host, and outside the host's ledger: `/marks` doesn't list them, and a retract reaches one only on a message the host's ledger also names, when the host's marks are 💤 too.
  - `/marks action:list [target:<id>] [page:<n>]` shows the host's awareness ledger of the marks it scheduled, `/marks action:cancel target:<id>` stops what it hasn't sent, and `/marks action:retract target:<id>` queues the removal of a batch's marks, or of every mark in the ledger with `target:all`. It needs the same host as `/undo`.
  - `/nudge` runs the agent on its current context, with no new event.
  - `/unstick [max]` rewinds the turns behind a refusal and runs the agent again until the model stops refusing, at most `max` times.
- **Voice.** Optionally, discord-mcpl joins a voice channel and speaks the agent's replies through ElevenLabs as the host streams them. It waits for silence before it speaks, stops when a person talks over it, and tells the agent what went unheard. It doesn't transcribe speech.
- **Rollback.** The `discord.messaging` feature set supports MCPL [rollback](https://github.com/anima-research/mcpl/blob/main/SPEC.md#8-state-management). Rolling back to a checkpoint deletes, best-effort, the messages discord-mcpl posted after it with `send_message`, `reply_message` or the host's `channels/publish`. discord-mcpl keeps checkpoints in memory, so they don't survive a restart.

## Tools

| Feature set | Tools |
|---|---|
| `discord.messaging` | `send_message`, `reply_message`, `send_dm`, `add_reaction`, `remove_reaction`, `edit_message`, `delete_message`, `list_emojis` |
| `discord.history` | `fetch_history`, `fetch_around` |
| `discord.channels` | `create_text_channel`, `delete_channel` |
| `discord.subscriptions` | `mute_channel`, `unmute_channel`, `set_reaction_visibility`, `list_subscriptions`, `channel_missed` |
| No feature set | `list_guilds`, `list_channels`, `list_channel_members`, `refresh_channels`, `filters_get`, `filters_update` |

In MCPL mode, the host decides which feature sets are enabled. discord-mcpl refuses a tool whose feature set is disabled, and disabling `discord.messaging` also stops Discord messages from reaching the host. Tools outside any feature set are always available. An MCP client gets every tool and no Discord messages.

[`docs/tool-reference.md`](docs/tool-reference.md) explains to agents how to name channels, choose the message to act on and attach files.

## Setup

### 1. Create the bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and copy the token from its Bot page. This is `DISCORD_TOKEN`.
2. On the same page, under Privileged Gateway Intents, turn on Server Members Intent and Message Content Intent. discord-mcpl asks Discord for both.
3. Invite the bot to your server with the `bot` and `applications.commands` scopes. The second lets discord-mcpl register the admin slash commands. In the channels where the bot should work, give it permission to view channels, read message history, send messages (in threads too), attach files and add reactions. Reacting with another server's emojis also needs Use External Emojis, `create_text_channel` and `delete_channel` need Manage Channels (Manage Threads to delete a thread), and voice needs Connect and Speak.

### 2. Install

discord-mcpl needs Node.js 22.12.0 or later.

npm has the tagged releases:

```sh
npm install @animalabs/discord-mcpl
```

The server is then `node_modules/@animalabs/discord-mcpl/dist/src/index.js`, which `npx @animalabs/discord-mcpl` runs.

To run `main` as it is, or to work on it, build it from source:

```sh
git clone https://github.com/anima-research/discord-mcpl.git
cd discord-mcpl
npm ci
npm run build
```

The server is then `dist/src/index.js`.

### 3. Run

```sh
DISCORD_TOKEN=... npx @animalabs/discord-mcpl --stdio
DISCORD_TOKEN=... npx @animalabs/discord-mcpl --tcp 9040
```

From a source checkout, run `node dist/src/index.js` with the same flags. `npm start -- --stdio` runs the TypeScript source through tsx without a build.

- With `--stdio`, a host starts discord-mcpl and talks to it over stdin and stdout. discord-mcpl exits when the host closes the connection.
- With `--tcp <port>`, discord-mcpl listens on 127.0.0.1 only and serves one host at a time, refusing any other that connects meanwhile. It stays logged in to Discord between hosts. A message that arrives while no host is connected is dropped, and only a later read of history, such as the catch-up after the first host connects, can bring it back. What was already on its way when a host went is held for the next one, for a minute at most and 64 messages at a time: a message that host answered nothing to, refused without a reason the spec defines, or refused for permission before its start-up had settled is sent again, as the same occurrence, to a host that has finished starting up, advertises event coalescing, and can take that occurrence as it was built; and an edit or delete that was waiting for its message goes to it too (see the CHANGELOG).

discord-mcpl writes its logs to stderr.

With connectome-host, add an entry to the recipe's `mcpServers`, as connectome-host's README describes under "MCP servers". The path in `args` is the server's `dist/src/index.js`, in your source checkout or under `node_modules/@animalabs/discord-mcpl/`:

```json
"mcpServers": {
  "discord": {
    "command": "node",
    "args": ["/absolute/path/to/dist/src/index.js", "--stdio"],
    "env": {
      "DISCORD_TOKEN": "${DISCORD_TOKEN}",
      "DISCORD_WATERMARK_FILE": "/absolute/path/to/data/discord-watermarks.json"
    },
    "allowHostCommands": true
  }
}
```

`allowHostCommands` lets agent-framework carry out the admin slash commands, and without it, agent-framework refuses them.

By default, connectome-host gives a stdio server agent-framework's allowlist of system variables (`PATH`, `HOME`, locale settings and the like), the variables its entry names in `env`, and two it sets itself. One is `AGENT_TIMEZONE`, which replaces any value in `env`. connectome-host takes it from the recipe's `agent.timezone`, else from its own `AGENT_TIMEZONE`, else from its system time zone (UTC if it has none). The other is `DISCORD_SUPPRESSED_REACTIONS_BASELINE`, set to agent-framework's refusal-reaction list, which a value in `env` replaces. Name every other variable discord-mcpl should see in `env`.

## Configuration

discord-mcpl reads its configuration from environment variables, and only `DISCORD_TOKEN` is required. It doesn't load a `.env` file itself. [`.env.example`](.env.example) gives more detail on the filter and reaction-suppression variables.

### Filters

| Variable | What it does | When unset |
|---|---|---|
| `DISCORD_GUILD_ID` | Comma-separated Discord servers the agent hears from. An entry is a server ID, which admits all its channels, or `serverId:channelId+channelId`, which admits only those channels and their threads. Listing a category admits the channels under it. | Every server the bot is in. |
| `DISCORD_DM_USERS` | Comma-separated IDs of the users who may DM the agent. discord-mcpl doesn't deliver a DM from anyone else. The list filters incoming DMs only, not reads. | Anyone. |
| `DISCORD_FILTERS_FILE` | A JSON file holding the same filters, plus the reaction-suppression list below. If the file is missing at startup, discord-mcpl creates it from the two variables above. If it exists, it replaces them. Edits take effect within about 3 seconds, and `filters_update` can change its server and DM lists. A file that can't be parsed at startup is left as it is, and the two variables apply until it's fixed. A bad edit later keeps the filters already in force. | The two variables above apply, and change only at a restart. |

A filters file that admits every channel of one server, one channel of another and DMs from one user:

```json
{
  "guildIds": ["111111111111111111", "222222222222222222"],
  "guildChannels": { "222222222222222222": ["333333333333333333"] },
  "dmUsers": ["444444444444444444"]
}
```

A server's channel list applies only when `guildIds` lists the server too.

The list of servers decides which servers' channels discord-mcpl registers and delivers messages from. A server's channel list also limits what the agent can read there: `list_channels` leaves out a channel outside it, `list_channel_members`, `fetch_history`, `fetch_around` and a host's open with backscroll refuse one, and a channel name resolves only to a channel inside it. `latestFrom`, which `reply_message`, `add_reaction` and `remove_reaction` take in place of a message ID, picks only messages in channels and DMs the filters admit. A send to a channel given by its numeric ID isn't filtered.

When the DM list refuses a DM, the agent can have the sender told so, by calling `filters_update` with `setDmNotice: true`. Notices are off by default. They go to each sender at most once per 24 hours, and to all senders together at most 10 times an hour.

### Stored state

These files let state outlive a restart. State whose file has no path stays in memory, and a restart loses it.

| Variable | What it holds | When unset |
|---|---|---|
| `DISCORD_WATERMARK_FILE` | Each channel's catch-up position (the newest message delivered or scanned there), the DM channels discord-mcpl knows, and the counts `channel_missed` reports. | Kept in memory, with no catch-up. |
| `DISCORD_SUBSCRIPTIONS_FILE` | Legacy. A JSON array of channel IDs that discord-mcpl delivers messages from as soon as it starts, registering them as initially open. It reads the file once and never writes it. The file's path also sets the default paths of the next two files. | No channels. |
| `DISCORD_MUTED_CHANNELS_FILE` | The channels muted with `mute_channel`. | Beside the subscriptions file (`subs.json` gives `subs.muted.json`), or in memory if that's unset too. |
| `DISCORD_REACTION_CHANNELS_FILE` | The channels where reaction visibility is on, as of its last save. `set_reaction_visibility`, `mute_channel` and closing a channel save it; opening a channel doesn't. | Beside the subscriptions file (`subs.json` gives `subs.reactions.json`), or in memory if that's unset too. |
| `DISCORD_DM_NOTICES_FILE` | Whether DM notices are on, and each sender's notice limits, with no message text. Notices stop while the file can't be read or written. | `$XDG_STATE_HOME/discord-mcpl/<bot user ID>/dm-notices.json`, with `~/.local/state` in place of `$XDG_STATE_HOME` when that's unset. |

### History and attachments

| Variable | What it does | When unset |
|---|---|---|
| `DISCORD_BACKSCROLL_LIMIT` | How many earlier messages (backscroll) come with the first message delivered from a DM channel, and the history size each registered channel offers the host (`capabilities.history.maxMessages`), though a host's open returns at most 500. From 1 to 10000. | 80 |
| `DISCORD_BACKSCROLL_CHANNELS` | Per-channel limits, as comma-separated `channelId:n` pairs, with `n` from 0 to 10000. For a listed channel, `n` replaces `DISCORD_BACKSCROLL_LIMIT`, and it also caps `fetch_history`, `fetch_around` (which always returns at least the message it's centred on) and the history a host asks for when it opens the channel. | No per-channel limits. |
| `DISCORD_CATCHUP_LIMIT` | The most messages the catch-up reads per channel. From 1 to 10000. | 3000 |
| `DISCORD_ATTACHMENT_INLINE_MAX_BYTES` | The largest text attachment to inline, in bytes. `0` turns text inlining off, a value above 262144 counts as 262144, and an invalid value logs an error and gives the default. Images aren't affected. | 5120 |

discord-mcpl reads the leading digits of `DISCORD_BACKSCROLL_LIMIT` and `DISCORD_CATCHUP_LIMIT`, and a value outside the range gives the default.

### Admin commands

| Variable | What it does | When unset |
|---|---|---|
| `DISCORD_ADMIN_USERS` | Comma-separated IDs of the users who may run `/undo`, `/hide`, `/marks`, `/nudge` and `/unstick`. | Nobody may. |

### Reaction suppression

Suppression keeps chosen reaction emojis out of what the agent sees: live reaction events, fetched history and backscroll. With `DISCORD_FILTERS_FILE` set, the list lives in that file as `suppressedReactionEmojis`, which only an edit to the file changes. When discord-mcpl creates the file, it writes the list that applies into it. A filters file that can't be parsed at startup withholds every reaction until it's fixed. Without the file, the variables below supply the list. discord-mcpl reads the two variables once, at startup.

| Variable | What it does | When unset |
|---|---|---|
| `DISCORD_SUPPRESSED_REACTIONS_BASELINE` | Comma-separated emojis to suppress when the filters file has no list and `DISCORD_SUPPRESS_REACTION_EMOJIS` isn't set at all. Set but empty, that variable turns the baseline off. | No baseline. |
| `DISCORD_SUPPRESS_REACTION_EMOJIS` | Deprecated. The list as a comma-separated variable, used while the filters file has no `suppressedReactionEmojis` key. | Not used. |

### Timestamps

| Variable | What it does | When unset |
|---|---|---|
| `AGENT_TIMEZONE` | The IANA time zone, such as `Europe/Berlin`, for the times written into catch-up and backscroll text. Protocol timestamps stay in UTC. An invalid zone logs a warning and gives the default. | The system time zone, or UTC. |
| `AGENT_TIMESTAMP_STYLE` | How those times look: `full` (`2026-01-15T04:34:56-08:00 [America/Los_Angeles]`), `compact` (`2026-01-15 04:34`), `time` (`04:34`) or `none`. An invalid value logs a warning and gives `full`. | `full` |

### Diagnostics

| Variable | What it does | When unset |
|---|---|---|
| `DISCORD_MCPL_DEBUG_LOG` | A writable absolute path, to which discord-mcpl appends timestamped diagnostic lines. They include excerpts of message text, up to 80 characters each. | No log. |

### Voice

Voice is off unless `DISCORD_VOICE_CHANNEL_ID` is set, and setting it requires the next four variables too. If any of them is missing, or voice setup fails, discord-mcpl logs why and runs without voice. With voice on, discord-mcpl tells the host that it takes streamed replies (`channels.streaming`), and it speaks the replies as they stream. The host still posts the text as usual.

| Variable | What it does | When unset |
|---|---|---|
| `DISCORD_VOICE_CHANNEL_ID` | The ID of the voice channel to speak in. Setting it turns voice on. | Voice is off. |
| `DISCORD_VOICE_GUILD_ID` | The ID of the Discord server that voice channel is in. | Required for voice. |
| `DISCORD_VOICE_REGISTRY_FILE` | A JSON file, in [voice-kit](https://github.com/anima-research/voice-kit)'s registry format, that maps names to ElevenLabs voices. | Required for voice. |
| `DISCORD_VOICE_NAME` | The registry voice to speak with, matched by its key or its `discordName`, ignoring case and skipping entries with `enabled: false`. When nothing matches, discord-mcpl uses the registry's `defaultBotVoice`. | Required for voice. |
| `ELEVENLABS_API_KEY` | The ElevenLabs API key for speech synthesis. | Required for voice. |
| `DISCORD_VOICE_TEXT_CHANNELS` | Comma-separated IDs of the text channels whose replies are spoken. | Every channel's replies, DMs included. |
| `DISCORD_VOICE_VAD_DB` | The loudness, in dBFS, at or above which someone in the voice channel counts as speaking. | -45 |
| `DISCORD_VOICE_MAX_HOLD_MS` | The longest a reply waits for silence. discord-mcpl drops a reply that waits longer, unspoken, and tells the agent it wasn't heard. | Replies wait as long as it takes. |

The smallest registry names one voice:

```json
{ "voices": { "my-agent": { "voiceId": "your-elevenlabs-voice-id" } } }
```

With it, set `DISCORD_VOICE_NAME=my-agent`.

## Development

```sh
npm run typecheck
npm test                              # test/*.test.ts with node --test, through tsx
npm run build
node --test dist/test/server.test.js  # the built server
```

CI runs these on Ubuntu with Node 22.12.0, 24 and the newest release, and builds on macOS with Node 22.12.0 and the newest release.

`scripts/voice-smoke.ts` tries voice output in a live voice channel without a host. With `DISCORD_TOKEN`, `ELEVENLABS_API_KEY` and `DISCORD_VOICE_REGISTRY_FILE` set, `npx tsx scripts/voice-smoke.ts --guild <serverId> --vc <voiceChannelId> --voice <registry name>` speaks each line you type, and you can talk over it to see it stop. `--list` prints the servers and channels the bot can see.

[CHANGELOG.md](CHANGELOG.md) records the changes operators notice, since 2026-07-29.
