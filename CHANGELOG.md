# Changelog

Notable operator-facing changes. Started 2026-07-29; earlier history lives
in the git log and PR descriptions.

## Unreleased

### Added

- **RFC-006 event coalescing** (agent-framework #197, mcpl #5). When the host
  advertises `eventCoalescing`, a message create carries its stable subject
  (`coalesce: { key: "message:<id>", initial: true }`, plus an occurrence
  `eventId` on `channels/incoming`), and edits/deletes are `push/event`s
  addressing that same subject in the channel's scope (`coalesce.channelId`,
  when the host accepts channel-scoped pushes and the channel is declared —
  guild channels at registration, DMs when first seen). An edit of a message
  the agent has not read yet replaces it in place of a second copy; a delete
  of an unread message withdraws it without trace and of a read one appends
  the `[message deleted]` notice; a replacing edit is rendered as the create
  was (backscroll, reply marker, location, attachments) with an `[edited]`
  mark. Edits and deletes wait for an in-flight create of the same message
  and reuse its scope. Hosts without the capability see the old shape, with
  one unconditional change: edit and delete occurrence ids are now unique
  per occurrence (`discord_edit_<id>_<editedAt>_<n>`); the old
  `discord_edit_<id>` made every edit after the first vanish at the host's
  dedup.

- **MCPL RFC-008 tool classes.** Every tool in `tools/list` now carries
  `_meta["mcpl/class"]`, e.g. `["comms", "files"]` on the send tools, so
  hosts can decide what tool-lifecycle observers may see; `comms` arguments
  (people's messages) are never shared. Classes live in
  `src/tool-classes.ts` and are merged into any existing `_meta` keys. A test
  fails until any new tool, listed or merely callable, is classed or
  deliberately left unclassed (which hosts treat as most restrictive).
- **Voice zero-cost-loser: TTS billing gated on carrier-clear.** The
  provider socket still pre-opens at first prose delta (a connection is
  free — only characters bill), but text now banks locally and flushes
  into synthesis only when the sink clears the utterance to play
  (carrier-clear + hold-off). An utterance dropped while queued bills
  zero characters, and the banked text means the model never re-runs
  inference or resends because it had to wait. A provider socket that
  dies while queued (idle timeout) is reopened at clearance and the bank
  resent. Reports gain `queuedMs` (staleness signal) and `billedChars`
  (the zero-cost receipt).
- **Optional max-hold (`DISCORD_VOICE_MAX_HOLD_MS`)**: an utterance that
  waits longer than this for the floor is dropped UNSPOKEN with a new
  `'expired'` report — nothing heard, nothing billed, and the model
  decides whether re-saying is worth a turn (the text was delivered in
  the text channel regardless). Off by default: words wait patiently and
  cost nothing while queued.
- **Wake-semantics tag contract on voice receipts** (ball-in-your-court
  rule): `voice:interrupted` and the new `voice:expired` mark events the
  model must act on (re-decide what to say) — hosts should gate them
  waking, like a reply. `voice:truncated` stays context-only. Receipt
  origins carry `queuedMs`/`billedChars`.

- **Host-injectable protective baseline for reaction suppression**
  (`DISCORD_SUPPRESSED_REACTIONS_BASELINE`): new deployments and
  never-configured installations default to the house classifier markers
  when host composition injects them. Precedence is strict and never
  unioned: a filters-file key (including an explicit `[]` = operator chose
  none) beats everything; the deprecated operator env beats the baseline;
  the baseline applies only when no operator configuration exists. The
  legacy env's PRESENCE wins even when its parsed list is empty or
  separator-only — the emergency filter treated an explicitly-empty env as
  OFF, and the baseline never reappears underneath an operator's off
  switch. This is a stated choice: the alternative (only a file `[]` can
  express none) would have changed existing emergency deployments'
  semantics.
  First materialization of the filters file writes the winning seed
  durably — including a present-but-empty legacy env, which is written as
  an explicit `[]` key so the operator's off survives env cleanup and
  future baseline injection. Lost configuration keeps the reviewed stale-LKG / fail-closed
  postures and never silently degrades back to the baseline — it is for
  never-configured, not for lost configuration. `filters_get` reports
  `source: "baseline-default"` (count/digest only, not deprecated). The
  Agent Framework owns the refusal-category→reaction map; host composition
  derives and injects the concrete set below the model line — standalone
  Discord deployments inject nothing and honestly report no protection.
- **Current reaction state on line-formatted transcripts** (issue #31): the
  reconnect `<missed>` sweep and the first-interaction backscroll now append
  a compact suffix — `[reactions: 😀 x2 (incl. me)]` — showing each
  message's current NET reaction aggregate, after the suppression
  projection, independent of the live `set_reaction_visibility` toggle
  (that opt-in governs ambient add/remove events; historical rendering is a
  current-state snapshot). No suffix means no visible reactions; state the
  adapter doesn't actually have (no resolver data, or a withhold-everything
  filters posture) renders an explicit `[reactions: unavailable]` marker
  rather than a false "none". Structured surfaces (`fetch_history` /
  `fetch_around` / backscroll metadata) are unchanged.

- **Reaction suppression on the filters plane** (issue #21):
  `suppressedReactionEmojis` in `DISCORD_FILTERS_FILE` names reaction
  markers that are filtered out of every model-visible surface — live
  reaction events (including their event ids), `fetch_history` /
  `fetch_around` results, and channel-open backscroll metadata — before any
  text or token is produced. Raw Discord state is untouched: projection, not
  deletion. The key is **operator-maintained**: `filters_update` has no
  parameter that can carry it (in either direction — configured markers
  never transit an agent turn), and resident guild/DM updates round-trip it
  unchanged. `filters_get` reports redacted state only: status
  (`not-configured` / `configured-empty` / `active` / `stale` /
  `unavailable`), entry count, full `sha256:` digest of the normalized set,
  source, and load time — never the entries. Matching is the emergency
  filter's semantics (VS-16/colon differences ignored; numeric snowflake
  entries also match custom emojis by id). A wrong-typed
  `suppressedReactionEmojis` (anything but a string array) invalidates the
  whole file load — a typo'd safety field must never silently degrade to
  "key absent".
  Desired-vs-effective state is reported for the WHOLE plane, not per key:
  `filters_get` gains a `plane` block (`live` / `stale` / `unavailable`,
  `desiredState: ok|invalid|missing`, full `sha256:` digest of the
  normalized effective filters, load time) because guild/DM whitelists go
  stale under exactly the same failures as suppression. Failure posture: a
  bad rewrite or file deletion after a good load keeps enforcing the
  last-known-good filters (process-lifetime only — a restart into a broken
  file does not resurrect them); a filters file that is configured but was
  never readable withholds ALL reactions (`unavailable`, history messages
  marked `reactionsUnavailable: true`) until repaired. The poller detects
  real file deletion (one poll of grace for non-atomic editors) and
  force-reloads a reappearing file even under a preserved mtime. A
  malformed filters file is never overwritten — not by the env seed at
  startup, and not by `filters_update`, which refuses to write when the
  desired state on disk is missing or unparseable instead of
  reconstructing it from process memory.
  The `DISCORD_SUPPRESS_REACTION_EMOJIS` emergency containment (2026-08-03)
  is now a **deprecated compatibility source**: on first materialization of
  the filters file it seeds the key (its one-time migration into the
  plane); an existing filters file without the key keeps using the env
  exactly as shipped — no surprise rewrite; once a file carries the key the
  env is ignored outright — never merged — with a glyph-free warning. The
  env is process-static: it is read once at startup and changing it
  requires a restart (hot reload belongs to the file plane — a running
  process's environment cannot be edited from outside, so no hot-apply is
  claimed for it). Migration: write the key (or let first materialization
  seed it), unset the env, verify `source: "file"`; the alias retires per
  issue #16 once fleet inventory shows migrated files.

### Changed

- **Text attachments now inline into context only up to
  `DISCORD_ATTACHMENT_INLINE_MAX_BYTES` (default 5120 bytes)** — previously
  live delivery inlined text attachments up to 256KiB. Over the cap, the
  agent gets a name+size+URL note instead. The bound is enforced on actual
  received bytes, not Discord's declared attachment size. `0` disables text
  auto-inlining; values clamp to the 262144-byte (256KiB) absolute ceiling;
  malformed or negative values log an error and fall back to the default.
  Raising the cap intentionally restores the prior always-inline behavior.
  Images are unaffected: they inline as native image blocks under their own
  ceilings. (issue #30, PR #12)

- **A tool given an id Discord doesn't know says what that means.** Discord
  answers an unknown or unreachable id with two words ("Unknown Channel",
  "Unknown Guild", "Unknown Message", "Unknown User", "Missing Access"). The
  tool error now keeps them and adds what they mean for what the model sent,
  and the cure. For an id, it says the id may be mistyped or remembered
  rather than copied, or the thing deleted or out of the bot's reach, and
  where real ids show (`list_channels`, `list_guilds`, `fetch_history`, a
  message's author, `list_channel_members`). A text, announcement or voice
  channel can be re-sent by `#name` instead, and a user by `@username` if
  they share a server with the bot or have DMed it. A thread or DM has no
  name route, so its id has to be copied from where it was shown. A `#name`
  that resolved to an id Discord doesn't know is explained as a channel gone
  since it was seen, not with advice to send the name again. A
  `create_text_channel` category is explained as a category. `list_emojis`
  with a `guildId` now lets the guild lookup's own error through, Discord's or
  not, as `list_channels` does, where every failure there used to read "Guild
  <id> not found". Other errors pass through unchanged.

### Fixed

- **Ghost "[message edited]" events.** Discord emits `messageUpdate` for more
  than content edits: link-preview / embed refreshes re-send old messages with
  `edited_timestamp` still null. Those reached the agent as fresh edits of
  weeks-old, never-edited messages. Updates are now forwarded only when
  `editedTimestamp` is set and the content actually changed (when the old
  message is cached). Real edits are unaffected.
- **A slash command that fails no longer ends the process.** Slash handlers
  run without being awaited, and their rejections were unhandled. On Node
  15 and later, an unhandled rejection exits the process, so a single late
  reply, which Discord refuses with "Unknown interaction" once its
  3-second window has passed, took the whole server down. The dispatch now
  catches and logs a handler's failure.
- **A notification whose handler throws synchronously no longer stops the
  server.** The main loop read each message and dispatched notifications
  without a guard, so a synchronous throw in one, such as a notification
  whose params are missing or malformed, ended the loop. The server then read
  nothing more, and every later request went unanswered until the host timed
  it out. The throw is now logged and the loop goes on. A `featureSets/update`
  is checked whole before it changes anything, so a malformed one leaves the
  grants as they were, where before it could apply its enables and skip its
  disables.
- **The rest of what ended the serve loop or the process.** None of these
  ends either now:
  - **A line on the connection that isn't JSON.** The connection emitted an
    error that nothing listened for, which ends a Node process. It's now
    logged, and the loop reads on. The listener stays on the connection
    after `serve()` returns, so a late stream error is logged too.
  - **A client that leaves before `initialize`.** The handshake read sat
    outside the loop's catch, so `serve()` rejected and the process exited.
    Over TCP, the server now goes on to its next client.
  - **Anything else a client sends before `initialize`.** It ended the
    session. Now a `ping` is answered, any other request is answered with
    an error (-32002), a notification is dropped with a log line, and the
    handshake waits on for `initialize`. A `ping` after it is answered too,
    where it got -32601.
  - **A request handler that throws something other than an Error**, such
    as `undefined`. The error answer read `.stack` off the value and threw
    itself, which ended the loop with the request unanswered. The request is
    now answered -32603 with the value as text, and the loop reads on. (A
    value with no prototype can't be made text, so it's answered with a
    placeholder; an Error with an empty message, with its name.) A request
    the server still fails to answer no longer ends the loop either.
  - **The same kind of value in the start-up work** (channel registration
    and the reconnect sweep). It escaped their catches as an unhandled
    rejection, which ends the process. It's now logged, and the sweep goes
    on to its next channel.

  The handshake no longer reads past `initialize`. A request a host sends
  before `notifications/initialized` used to be read there and dropped. Now
  it's answered. The "Client initialized" and "Client disconnected" lines go
  to stderr, where they went to stdout, the stdio transport's protocol
  channel. `serve()` closes its connection when it returns, whatever ended
  it. The stdio transport exits with status 0 when its connection ends, as
  MCP's stdio shutdown expects, rather than stay logged in to Discord with
  no host. A host that leaves before `initialize` ends it that way too,
  where it exited 1 with "Fatal error". A read error on a TCP socket or on
  stdin still ends the process: it also reaches mcpl-core's readline
  interface, which listens for none.
- **Edits and deletes carry their author and location.** The push-event
  origin now includes `guildId`, the composite `mcplChannelId`, `messageId`
  and (when known) `authorId`/`authorName`, and an edit reads
  `[message edited] <username>: <text>` like a create. Previously the host
  reconstructed a guild channel's edit as `discord:dm:<channelId>` and the
  agent could only guess who had edited.
- **DM whitelist fails closed on edits.** With `DISCORD_DM_USERS` set, a DM
  edit whose author is unknown (uncached message) was forwarded because the
  check required an author; it is now dropped, like creates.
- **A voice item that can't be played no longer ends the process.** The
  playback sink's fire-and-forget `pump()` had no `catch`: if
  `createAudioResource` or `AudioPlayer.play` threw (it throws for a resource
  that has already ended, or one another player is playing), the rejection
  went unhandled, which ends a Node process. It also left the item marked as
  playing and its utterance waiting for an outcome. Such an item is now
  settled with a new terminal sink event, `failed`, and the sink goes on to
  the next one. A refused item is never `cleared`, so its text is never
  billed.
  - **Playback that stalls or runs on fails too.** An item the player accepts
    fails when no audio reaches it within 10 s, or when it plays past 300 s,
    and the reason names the limit. Before, both were reported as spoken, and
    the model was told the message was "cut short by a synthesis error", with
    what wasn't heard. A 10 s stall on a reply already complete even counted
    as spoken in full, so the model wasn't told at all. Such a reply now fails, synthesis stops, and the rest of it isn't voiced, where
    a later part used to be voiced as a new utterance. When the TTS provider
    is unavailable at clearance, or ends the stream before any audio, the
    stream ends empty and the player starts and ends it at once: that is
    still reported as spoken, nothing heard, cut short by a synthesis error.
  - **A stream error fails the item,** where it was reported as finished.
  - **A barge-in, or a bot's yield, still reports `interrupted`,** and now at
    once even before the item starts playing, where it waited out the 10 s.
  - **Any other throw in playback** settles the playing and queued items the
    same way, and nothing a `failed` listener queues meanwhile waits for the
    next `play()`.
- **What the model is told.** `VoiceOutput` ends a failed utterance as it
  does an interrupted one: it stops synthesis and drops the rest of that
  inference. It reports status `failed` with a reason from a fixed set
  (`PlaybackFailure`); the raw error, which can carry library text, goes to
  the log only. The model is told the message couldn't be played, when
  nothing was heard, or was stopped after so many seconds, with what was
  heard. When the reply was still streaming, the report says so
  (`restUnvoiced`), and the model is told that what it went on to say wasn't
  voiced either, after an interruption too. The note is tagged
  `voice:failed`. Like `voice:truncated`, that tag is context, not a wake:
  the text landed in the text channel, and the model sees the note on its
  next turn and can say the line again then if it still needs saying.
- **The voice-chat harness** (`scripts/voice-chat.ts`) treats `failed` like
  an interruption. It stops the model's stream, and its history keeps only
  what was heard, while its transcript shows the rest struck through. The
  model is told on its next turn, without one being started for it. An
  interruption that came while the model was still generating used to
  overwrite the previous turn's history and then keep everything generated so
  far, heard or not; it now keeps only what was heard. Raised in #69's
  review, the same class as #70's slash-command fix.
