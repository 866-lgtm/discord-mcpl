# Changelog

Notable operator-facing changes. Started 2026-07-29; earlier history lives
in the git log and PR descriptions.

## Unreleased

### Added

- **`latestFrom` for replies and reactions.** `reply_message`, `add_reaction`
  and `remove_reaction` accept `latestFrom` (an @username, display name,
  numeric user ID, `<@id>` or `@id`, bots included) as the exclusive
  alternative to `messageId`. It targets that author's newest message among
  the 100 most recent in the channel, resolved once when the call runs and
  frozen for the action. Only a message someone wrote counts: a system
  notice (a pin, a join, a thread start) is never their latest message,
  though a bot's reply to a slash command is the bot's.
  - **The filters bound it, before and after its reads.** Like
    `list_channels` and `list_channel_members`, it reads only what the
    configured filters admit: a channel in a guild `guildIds` lists, admitted
    by `guildChannels` (a thread by its parent's entry), and for a DM, one
    whose other party `dmUsers` lists. When the cache can't name a DM's
    other party (a channel known only from the bot's own message), Discord
    is asked once, and a party it still can't name is refused. Anything else
    is refused, by ID or by name, before its history or members are read,
    and the filters are checked again after the reads, so a change made
    meanwhile refuses the action.
  - **A name must match one identity.** That is among everyone who can read
    the channel (for a public thread, its parent's viewers as well as its
    joined members; for a private thread, its members and the parent's
    viewers who can manage threads) plus the window's authors, by username or
    display name: a member's server nickname or global display name, and for
    an author no longer there, the account's. A collision returns choices,
    and no match in the window is refused rather than guessed. A name that
    can't be checked against the channel's members is refused in favor of
    the numeric ID: when the member list fails, lists members it couldn't
    name, or is a thread's listing of exactly one page (100), which may be
    cut short. A guild whose member-cache warm-up failed is remembered for 10
    minutes, so names there are refused at once rather than each waiting out
    another download, and a warm-up is skipped when the cache already holds
    every member. A `latestFrom` of `@` alone names no one and is refused
    before anything is read, and an empty channel is refused as having
    nothing to choose from.
  - **The result echoes the chosen message:** its ID, author (by display
    name), channel, time, and an excerpt of at most 80 characters, cut by
    code points so no emoji is split. `add_reaction` and `remove_reaction`
    return `{ result, target }` for a `latestFrom` selection.
  - **A reply to a message that's gone fails** instead of posting
    unthreaded. Today discord.js's default (`fail_if_not_exists`) does that
    for every reply. A `latestFrom` reply also asks for it explicitly, since
    its target was chosen for it, so it keeps failing if the default for
    other replies changes (#58 makes them post unthreaded instead).
  - **Selectors:** both are nullable and neither is required, so sparse
    calls and all-properties calls with the unused one null both work. Only
    omission and null mean absent: a string is a selector given, blank
    included, so two given are refused, and a blank one alone names nothing.
    Each of the three tools now refuses a call with no `messageId` or
    `latestFrom`, or with a non-string one; a `reply_message` without
    `messageId` used to post unthreaded.
  - **`list_channel_members`** reports, for a thread, `unresolved` (members
    listed by ID only, whose names couldn't be read) and
    `possiblyIncomplete` (Discord returned exactly one page of members).

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

### Fixed

- **Ghost "[message edited]" events.** Discord emits `messageUpdate` for more
  than content edits: link-preview / embed refreshes re-send old messages with
  `edited_timestamp` still null. Those reached the agent as fresh edits of
  weeks-old, never-edited messages. Updates are now forwarded only when
  `editedTimestamp` is set and the content actually changed (when the old
  message is cached). Real edits are unaffected.
- **Edits and deletes carry their author and location.** The push-event
  origin now includes `guildId`, the composite `mcplChannelId`, `messageId`
  and (when known) `authorId`/`authorName`, and an edit reads
  `[message edited] <username>: <text>` like a create. Previously the host
  reconstructed a guild channel's edit as `discord:dm:<channelId>` and the
  agent could only guess who had edited.
- **DM whitelist fails closed on edits.** With `DISCORD_DM_USERS` set, a DM
  edit whose author is unknown (uncached message) was forwarded because the
  check required an author; it is now dropped, like creates.
