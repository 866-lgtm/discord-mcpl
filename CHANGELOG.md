# Changelog

Notable operator-facing changes. Started 2026-07-29; earlier history lives
in the git log and PR descriptions.

## Unreleased

### Upgrade notes

- **discord-mcpl now needs Node.js 22.12.0 or later.** If you run it on
  Node 20, 21, or 22 before 22.12, upgrade Node first. Its `engines` said
  `>=20.0.0`, but `@discordjs/voice` 0.19, a dependency since #28 and first
  released in discord-mcpl 0.2.0, declares `>=22.12.0`, so those versions
  have been outside what that dependency supports since then, and Node 20
  reached end of life on 2026-04-30. Apart from the Node version it needs,
  this change alters nothing about the server. On an older Node, npm warns
  with `EBADENGINE` and installs anyway; with `engine-strict` set, it
  refuses to install. CI builds on Node 22.12.0 and the newest release on
  Linux and macOS, and on Node 24 on Linux, and runs the tests on Linux.
- **`chat:thread` now marks messages posted in a thread, and no longer marks
  a message that started one.** A host gate or filter rule keyed on the tag
  will match different messages after this upgrade: messages inside threads
  now carry it, forum posts included (a forum post is a thread), and so do
  their edits, their deletions and the reconnect sweep's blocks of them,
  while a channel message that spawned a thread no longer does. The old
  matches were the wrong ones (see "Thread fields name the thread a message
  was posted in" under Fixed), but a rule tuned to them is worth checking.
- **The host's channel list now follows Discord's.** Voice and stage
  channels (their text chat), and each thread a message comes from, are
  registered beside text and announcement channels. An archived thread
  leaves the list until a message brings it back, and a renamed channel,
  thread or server is announced as `updated`. A host rule keyed on the
  list, or on a label's `#name (Guild)` shape, is worth checking: a channel
  whose name doesn't resolve back to it is labelled by its id,
  `discord:<guild>:<channel>` (see "Every channel messages are posted in is
  registered" under Fixed).
- **A message that started a thread no longer carries that thread's id as
  its MCPL `threadId`, and no message carries one now.** A host that keys
  conversations by channel and thread filed such a message under the thread
  it started; it now files it under its channel alone, with the channel's
  other messages. This change doesn't move what a host filed before the
  upgrade. A message posted in a thread was already filed under the
  thread's own channel id and stays there.

### Added

- **An attachment's URL says when it stops working.** Discord signs each CDN
  URL with the time it stops working, in the URL's `ex` parameter. An
  attachment marker whose URL has one now follows it with `(link expires
  <date> <time> UTC)`, and a message with such markers adds one line saying
  that fetching the message again gives fresh links. In `fetch_history` and
  `fetch_around` results, and in `channels/open` history, such an attachment
  carries `expiresAt` beside its `url`, and both tools' descriptions say
  what it means. A URL without a readable `ex` gets neither.

### Fixed

- **`channels/open` opens exactly the channel it was asked for.** A stale or
  unknown `channelId` used to fall through to the first registered channel of
  the same type, so a host could open, subscribe to, and receive history from
  a different channel than it named. Now `channelId` is the exact selector.
  agent-framework's `ChannelsOpenParams` gives it as the exact registered id,
  preferred over type and address matching (MCPL's SPEC gives `channels/open`
  no `channelId`), and this server reads it strictly: a `channelId` alone
  selects, and an `address` beside it isn't read; without a `channelId`, an
  `address` naming a guildId and a channelId selects. Either names exactly one
  channel or is refused: an id the registry doesn't hold is looked up in
  Discord, and opened when it's a channel messages are posted in (text,
  announcement, voice or stage), a thread, or a DM, that the filters admit,
  so a DM or thread after a restart still opens. It's registered, by the rule
  every other path registers by, only when the open succeeds, so a refused
  open leaves nothing registered or announced for the host to act on. An
  archived thread opens too, since the host named it, and is forgotten as any
  archived thread is: when it's reported archived again, or a sync of its
  channel's threads doesn't list it. Any other id is refused, a lately
  deleted channel, a thread of one, and a channel of a guild the bot has left
  included, whatever an address beside it says, and so is a lookup that
  finds a different channel. A channel outlives its deleted category. A
  request with no selector (`channelId` absent or null, and `address` absent,
  null or `{}`) opens the one registered channel of its type, DMs and threads
  counted, and is refused when there are none or several; a refusal over
  several lists the first ten and points to `channels/list` for the rest.
  `type`, which MCPL requires, must be a non-empty string on every request and
  must match the channel opened, so a registered `channelId` with a different
  `type` is refused too. An empty-string `channelId`, which used to be read as
  absent, is refused, and address ids must be strings. Refusals carry MCPL's
  codes: unknown channel (`-32023`), invalid params (`-32602`), or open failed
  (`-32024`, when the lookup can't get the channel's current facts, the
  history fetch fails, the channel filters refuse reading its history or can't
  be checked, or a `channels/close` or `mute_channel` for the channel arrives
  while the open is in progress, its lookup included). No history is fetched,
  and nothing is opened or subscribed, before a request names its channel. A
  channel unregistered while the open is in progress isn't opened, and neither
  is one looked up that's deleted, or whose server the bot leaves, meanwhile.
  History items carry the label the open commits to. `sinceLastSeen` reads the
  persisted watermark even on the first open after a restart, before anything
  else has loaded it. An id the registry doesn't hold is looked up as every
  fetch past the cache is: Discord's Unknown Channel there is a deletion, and
  an id Discord refuses (Missing Access, a malformed id's Invalid Form Body,
  or any other 403 or 404) is unknown. An id whose current facts can't be had
  (Discord gives no answer, or refuses for a reason that isn't the id, such as
  a 401 after the bot's token changed; every try is overtaken by a change; or
  a thread's stale channel can't be fetched fresh) is refused as an open that
  failed, and another open looks it up again.
- **`channels/open` returns no backscroll from a channel the filters stop
  admitting while its history is fetched (#94).** The filters file is
  reloaded on a timer, so it can narrow during the fetch. The open checked the
  filters only before fetching, and returned what it fetched. It now checks
  them again after the fetch and refuses as an open that failed (`-32024`),
  with nothing returned, opened or subscribed.
- **Thread fields name the thread a message was posted in.** They were read
  from discord.js `message.thread`, which is the thread a message *started*,
  so a message that had spawned a thread was tagged `chat:thread`, rendered
  as `thread "…"`, and sent to the host with that thread's id as its MCPL
  `threadId`, while messages actually posted in a thread carried none. Now a
  message posted in a thread is tagged `chat:thread` and located as
  `[#parent thread "name" …]`, and a message that started a thread, in a
  text or announcement channel, carries no thread fields. A forum post's
  first message is posted in the post itself, which is a thread, so it is
  marked as in that thread like the replies under it. MCPL `threadId` (a
  thread *within* a channel) is no longer sent: a Discord thread is its own
  channel, already named by `channelId`, so a host keying conversations by
  thread no longer splits one channel in two. Instead a thread message
  carries `threadName` (the thread's name) and `threadParentName` (the
  channel it hangs off, new), each left out when it isn't known: in the
  `channels/incoming` metadata, in a push's origin, and in the origins of
  its edits and deletions, which are tagged `chat:thread` too, and of
  reactions to it, which keep their own tags only, so a gate rule keyed on
  `chat:thread` doesn't start matching them. A thread the client knew only
  partly is looked up first, past discord.js's cache, so its messages, and
  their edits, deletions and reactions, are named as any other thread's;
  each waits for that lookup before it is delivered, as a create already
  did. If the lookup fails, the channel filters decide on what is known,
  and what they let through goes unnamed (a message or an edit or deletion
  still tagged `chat:thread`).
- **The reconnect sweep names a thread as the live path does.** A thread's
  missed messages were headed `<missed channel="#<thread name>" …>`, as if
  the thread were a channel of its own name, and pushed without tags. The
  header now reads `<missed channel="#<parent>" thread="<name>" …>`, or
  `thread="<name>"` alone when the parent isn't known, with the thread's id
  for a name it lacks. Each name is quoted and escaped by `quotedValue`, as
  the live location escapes a name it quotes. The push carries `chat:thread`
  and the thread's fields, a thread the client knew only partly is looked up
  first, and every sweep push, a DM's included, now carries the
  `mcplChannelId` a live push's origin carries. The sweep's failed lookup of
  any channel now reaches stderr, where before only the debug log had it.
- **Every channel messages are posted in is registered, threads included,
  by one rule, and the host is told of each change.** Boot and channel
  events registered guild text channels only: never a thread (a Discord
  thread is its own channel), an announcement channel or a voice channel's
  text chat. Such a channel couldn't be opened, and a host that routes
  speech by a channel's declaration (MCPL RFC-011) held a resident's
  plain-speech replies in it as drafts.
  - **Listing** (boot, a channel's creation or change, a server joined,
    `refresh_channels`) registers the text, announcement, voice and stage
    channels the filters admit; never a category or forum, which hold no
    messages of their own. A stage channel, which had no kind of its own, is
    now `stage`: its text chat takes messages, and a name resolves to it as
    to a voice channel.
  - **A thread is registered by its messages:** before its first message
    reaches the host, live or caught up by the reconnect sweep, or before an
    edit or deletion there does. discord.js delivers no edit or deletion
    from a thread its cache doesn't hold, such as one archived before a
    restart, as before. An archived thread is forgotten, and a
    message posted after the archive, which unarchives it, registers it
    again, so the host holds the live threads. A message posted before the
    archive, still on its way when the archive came, doesn't.
  - **Removals are followed.** A deleted thread is forgotten, and so is a
    deleted channel with the threads it's known to hold, registered or
    cached. So is a channel Discord answers with Unknown Channel, when a
    thread is looked up or the reconnect sweep fetches it. Every channel of a
    server the bot leaves or is removed from is forgotten too; if the bot
    rejoins, the server's channels are registered again, as at boot, and its
    threads by their messages. An outage removes nothing while it lasts, and
    a server back from one, or from a gap in the gateway connection, is
    reconciled with what it has then: what was deleted, or a thread archived,
    meanwhile is forgotten, and a new or renamed channel is registered or
    re-derived. A sync of a server's threads, which Discord sends when the
    bot gains access to a channel, covers the channels in its `channel_ids`,
    or the whole server when it has none. A registered thread under a covered
    channel that the sync doesn't list is forgotten, since it's archived,
    deleted or no longer visible to the bot, and so is one the sync drops
    from discord.js's cache. A thread whose channel neither the cache nor its
    registration knows, such as one registered from a message whose lookup
    failed, is under no covered channel, so only a sync of the whole server
    forgets it. A registered thread the sync lists counts as updated, so one
    whose channel is stale stays as it is until that channel's fresh fetch or
    update. What the server no longer lists, on its return or when the bot
    joins it again, may have changed unseen: a message, edit, deletion or
    reaction from it, a tool, or the reconnect sweep, looks it up from
    Discord again before deciding, and a delivery that decided on facts from
    before the return doesn't register it. A lookup that Discord overtook
    with a report on its channel, such as an archive or a rename, is made
    again, so what a delivery waiting on it registers is no older than that
    report. The fresh facts count as an update of the channel, so what was
    registered from the older ones meanwhile is registered again, or
    forgotten when they show a thread archived or a channel outside the
    filters. A guild channel the cache holds that Discord says doesn't exist,
    to a lookup or to a tool, is handled as deleted, and dropped from
    discord.js's cache with its threads. A channel that `create_text_channel`
    makes is fetched again after the POST, so the cache keeps what the
    gateway reported of it meanwhile; if that fetch fails, or every try is
    overtaken, the channel becomes stale and the tool reports the name it
    made it with, and if Discord says it's gone already the tool says so. A
    stale channel's facts decide no registration or name until a fresh fetch
    or an update clears its mark, or, for a thread, a sync that lists it.
    Meanwhile a delivery from a stale channel, or from a thread in it,
    carries no name for that channel in its fields, and its label is the
    registered one: a stale channel's or thread's is its id, while a
    registered thread that isn't stale itself, under a stale channel, keeps
    its display-only label, with the names it was registered with. Its
    current name isn't known, so while a server the guild filter admits lists
    a stale channel of a kind a name addresses, no name in that server
    resolves, and no name given without a server resolves anywhere. The label
    of every channel a name addresses there is its id meanwhile, as is a
    stale thread's; a thread that isn't stale keeps its display-only label. A
    stale channel's threads aren't admitted through its category, and a
    registered thread whose channel is stale stays registered, as far as the
    filters go, until that channel's fresh fetch or update decides. The
    registration listings leave a stale channel out. Before a name-addressed
    tool resolves a name, and before `refresh_channels` lists, the stale
    channels their servers still list are fetched again, threads aside, in
    every server; `list_channels` fetches those of the server it lists. A
    delivery from a thread fetches its stale channel first. If that lookup
    fails, the filters decide the delivery on what the cache holds. A channel
    that Discord moves out of what the channel filters admit is forgotten,
    with the threads admitted through it, as on a server's return, and a
    delivery on its way from it doesn't register it again. Editing the
    filters, through the file or `filters_update`, registers the channels of
    a server they newly admit; a channel newly listed in a server already
    admitted is registered by its next message or `refresh_channels`. Neither
    edit forgets what the filters stop admitting: that goes at a restart, at
    its server's return, or when an update, a fresh fetch or a sync that
    lists it shows it outside them. Only what was registered is announced as
    removed.
  - **`list_channels` reads a server's channels from the gateway's cache**
    instead of fetching them from Discord, so it can't leave older facts in
    the cache than an update brought meanwhile. It lists the same channels as
    before, threads still excluded. It refuses a server in an outage rather
    than listing what it held before: before fetching anything for it, and
    again after, since an outage can begin while its stale channels are
    fetched. Otherwise it fetches that server's stale channels first, and
    leaves out one still stale, whether its fetch failed or every try was
    overtaken.
  - **A reaction in a server the guild filter leaves out is dropped,** as
    its messages are. It used to pass when the server had no channel
    filter of its own.
  - **A channel's label, its address, is made one way on every path,**
    `list_channels`, `create_text_channel` and send receipts included. A
    channel's is its address, `#name (Guild)`. A
    thread's is `#parent › thread (Guild)`, or `› thread (Guild)` when its
    channel's name isn't known, display-only either way, since
    `#thread (Guild)` would paste back as a same-named channel; a tool given
    one refuses it, even where a voice channel has that name. Where a name
    isn't known (a server the client hasn't cached), or wouldn't resolve
    back to the channel, the label is the channel's id,
    `discord:<guild>:<channel>`, never a bare `#name` that another channel
    could answer to. A name doesn't resolve back for a kind no name resolves
    to, a channel named like a thread label, a voice or stage channel
    beside a same-named text channel (Discord's stock "General" pair, where
    the name reaches the text channel), and two channels of one name and
    kind. A rename of a channel (hidden from the bot or not, and a forum or
    media channel's, whose posts are threads), a thread or a server, a name
    learned since, or a channel taking or freeing a name, re-derives the
    labels it's in, announced as `updated`.
  - **Every host connection is given the whole registry,** whatever was
    registered while another host, or none, was connected, and is told of
    the channels removed while no host was connected. A restart starts
    afresh: threads and DMs come back as they're active. Nothing announces
    the removal of a thread deleted or archived while discord-mcpl was
    down, so a host that keeps a Discord server's channels across a
    reconnect keeps such a thread.
  - **A push names its channel (`mcplChannelId`) once it's registered,**
    which is every channel a message is delivered from except a thread
    archived since its missed messages (the sweep delivers them without
    it), and a channel deleted, a thread archived, a channel left out when
    its server came back or moved out of what the channel filters admit,
    or one in a server the bot left, while the message was on its way. A
    stale channel, whose lookup failed while it was stale or whose every
    try was overtaken, and one discord.js doesn't hold, are delivered
    without it too, unless they're registered already. A DM's edit or
    deletion names its DM too, registered under its other party's name
    when that's known; one whose other party isn't known, in a DM not
    registered yet, goes without it.
  - **A deleted channel's watermark and missed tally go,** with those of the
    threads it's known to hold, as do those of a channel the reconnect sweep
    finds Discord no longer knows (deleted while discord-mcpl was down,
    say), so later starts stop fetching it. A message
    or catch-up delivered from a channel after its deletion doesn't bring
    the watermark back. A server the bot leaves keeps its channels'
    watermarks, since they still exist.
- **Every live push's origin names its registered channel by its composite
  id.** A reaction's origin, and a DM edit's or deletion's, now carry
  `mcplChannelId` (`discord:<guild>:<channel>`, or `discord:dm:<channel>` in
  a DM) when the channel is registered, as a message's own origin and a
  guild channel's edits and deletions already did, so a host can place each
  one under the id it registered the channel by. "A push names its channel
  (`mcplChannelId`) once it's registered", above, says which channels that
  leaves out.
- **An inlined image or text attachment's marker now carries the file's URL,
  as the markers of files that aren't inlined already do.** An inlined image
  may be resized or re-encoded, and inlined text is decoded as UTF-8, so the
  URL is the way to the exact bytes. A forwarded attachment that can't be
  fetched is now marked as forwarded too, as the live path's other markers
  of a forwarded attachment are.
- **A channel a tool can't use is no longer reported as not found.** A
  channel that exists but holds no messages of its own (a category, a
  directory channel, a forum or a media channel) was reported as not found
  by `send_message`, `reply_message`, `edit_message`, `delete_message`,
  `add_reaction`, `remove_reaction`, `fetch_history` and `fetch_around`, by
  a reply's or a reaction's `latestFrom`, and to a host by
  `channels/publish`, `channels/acknowledge` and a `channels/open` that asks
  for backscroll. Each now names the channel's kind and says what didn't
  happen, then where its messages are: for a category, the `list_channels`
  call that shows the channels in it; for a forum or a media channel, that
  its posts are threads, which no tool lists, so a post's id comes from a
  message posted in it or a link to it. A directory channel's error says
  that nothing here can read it or send to it, and a kind the adapter
  doesn't name is named by its type number as one this adapter can't read or
  send to, which only an operator updating the adapter can change. A `#name`
  reaches only text, announcement, voice and stage channels. When none of
  those that the filters allow had the name, the `#name` was answered "No
  visible channel named #…", or "No channel #… in a guild named …", though a
  category or a forum may have it. The answer now says that no text,
  announcement, voice or stage channel the filters allow has the name and
  that a `#name` reaches only those, and that `list_channels` shows a
  server's channels with their ids, by which a channel of any other kind,
  such as a category or a forum, is given instead. A channel discord.js
  returns nothing for, which Discord answered for but discord.js can't
  build, was reported as not found too, by the same calls and by
  `list_channel_members` and `delete_channel`. Each now says that the
  channel exists but this adapter can't use it, and names both causes: a
  kind this version of the adapter can't handle, which only an operator
  updating the adapter changes, or a server still loading on this
  connection, in which case the same call may work in a moment. The
  automatic DM notice's failure, in the operator log, now names the
  channel's kind, or says that this version can't handle it, where it said
  `not found or not a text channel`.

## 0.2.0 — 2026-10-13

### Upgrade notes

- **`fetch_history` and `fetch_around` now refuse a channel id that the
  configured channel list (`guildChannels`) excludes, and so does a host's
  `channels/open` that asks for backscroll from such a channel.** An open
  without backscroll still opens it, since it reads nothing. A resident
  that reads such a channel by its numeric id today (following a pasted
  message link, say) will get a refusal naming the channel filters, and
  nothing is read. The refusal is deliberate: it is the boundary
  `list_channels` and `list_channel_members` already apply (see the
  `fetch_history` entry under Fixed). To let a residence read the channel,
  admit it in `guildChannels`, directly or through its parent (a thread's
  channel, a channel's category). The same list bounds delivery, so that
  admits it for delivery too. Guilds without a `guildChannels` entry, and
  DMs, are unaffected.

### Added

- **Self-contained channel provenance on Discord's own renderings** (the
  Discord side of the host's message-provenance work). `fetch_history` and
  `fetch_around` items each carry `source` (`[source: <canonical id> ·
  <label>]`, the host's inbound header grammar minus its host-only server
  segment), `channelId` (canonical `discord:<guild|dm>:<channel>`) and
  `channelLabel`, so any message names its channel when read alone. A
  channel the server can't place has `channelId` null and a header id of
  `discord:?:<channel>`. `channels/open` history items add `channelLabel`
  (the label at fetch, raw) for the host's header, which the host quotes by
  the same rule. `send_message`, `reply_message` and `send_dm` receipts add
  the channel the send targeted, as fields rather than a header: canonical
  `channelId`, `discordChannelId` and `channelLabel`; for `send_dm`, the DM
  channel the send resolved. A failed or uncertain send keeps whatever text
  its error carries and adds `Attempted destination: …`, including a DM
  resolved before the failure. DMs are named from the registry, inbound DM
  state or the channel cache, so a fresh outgoing DM has its canonical id
  too, and a DM's label is `DM: <username>` on every path. An unknown label
  is left out, and the canonical id is authoritative when a label differs.
  A value that could read as header structure is quoted, as the host quotes
  it: a label holding brackets, `·`, ` / `, quotes, backslashes, control or
  line-separator characters, or anything invisible, or beginning with
  `thread`, `reply to` or `unscoped`, becomes an escaped string literal, so a
  guild, thread or display name can't forge a second attribution, and the
  header stays one line. The same rule renders the attempted destination,
  a `send_dm` target that didn't resolve, and the location prefix
  (`[#channel thread "name" in Guild]`) before message bodies, where a
  channel name with a space (a voice or stage channel's can have one) is
  quoted too, so it can't carry the prefix's own words. `channelLabel`
  keeps the raw label.

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
- **A refused DM's sender can be told** (issue #60). Once the agent turns
  notices on (`filters_update {setDmNotice: true}`; they're off by default, so
  upgrading starts no messages to anyone), when the DM whitelist refuses a DM,
  the connector posts one plain notice in that DM channel, with mentions
  disabled: "Automatic delivery notice: this connection did not forward your
  DM because this sender is outside its configured contacts. It sends this
  notice at most once per 24 hours." The DM itself is still never forwarded
  and never wakes the agent. A notice can go to a DM refused live, from the
  moment Discord connects, or to one the reconnect catch-up finds in a DM
  channel the bot already knows; a DM from a sender the bot has never seen,
  sent while it's offline, is never seen and gets none. Each refused message
  notifies at most once (duplicates and catch-up included), each sender at
  most once per 24 hours, and all senders together at most 10 times an hour
  (past that, a refused DM gets none and is logged `ceiling-reached`), so a
  wave of new accounts can't become a burst of outbound DMs. Past the
  ceiling, a sender the state doesn't hold yet isn't recorded either, so such
  a wave costs no writes, and a later sight of their message can still
  notify. A message older than the notice state never notifies, whether it
  arrives live or through catch-up. Each attempt is reserved durably before
  sending and never retried; its outcome (sent, failed, unknown) is recorded
  after, and an attempt interrupted in between is reported as unknown at the
  next start. A reservation that can't be made durable sends nothing and is
  withdrawn. State lives in
  `$XDG_STATE_HOME/discord-mcpl/<bot user id>/dm-notices.json`, or under
  `~/.local/state` when `XDG_STATE_HOME` is unset (override:
  `DISCORD_DM_NOTICES_FILE`), and holds no message bodies. It keeps each
  sender for 7 days after their latest refusal or notice, dropping them when
  it next changes while notices are on; a refusal while notices are off
  writes nothing, and turning them on starts from that moment, so nothing
  refused while they were off is notified later. If it can't be read or
  written, notices are suspended, and a refusal decided meanwhile gets no
  notice; nothing retries it, though a later sight of the same message
  (a duplicate event, or the next start's catch-up in a DM channel the bot
  knows) decides it afresh. The agent turns notices on and off with
  `filters_update {setDmNotice}`, which works with or without a filters
  file; turning them off stops every notice not yet reserved, while one
  already being sent still goes out. `filters_get` shows the setting and
  whether the state is persisted. Every refused DM leaves one operator log
  line (sender id, message id, notice outcome) without its body.

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

- **`@animalabs/voice-kit` comes from npm (`^0.1.0`)** instead of a
  `file:../voice-kit` link, so a deploy no longer needs a voice-kit checkout
  beside this one, and the package can be installed from npm (#83). A
  checkout that already links `../voice-kit` keeps working: the link
  resolves the same code until the next `npm install`.

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

- **With `--tcp`, the server serves one client at a time and keeps serving
  through what it can survive.** An error the TCP server emits once it's
  listening (an accept that fails, say) is logged whenever it comes, whether
  a client is being served or not; before, one that came while no client was
  served ended the process. A failure to listen still ends it. A client that
  connects while another is served is refused at once; before, it was left
  connected and never read, holding its connection open until the process
  exited, and a reset on it ended the process. A client whose serving fails
  ends only its own connection, and the next client is served. A read error
  on the served client's own socket, such as a reset, still ends the process,
  through mcpl-core's readline interface, which has no listener for it.
- **A refused DM's deletion no longer reaches the agent.** With a DM
  allowlist set, a refused sender's DM was never forwarded, but its deletion
  was: discord.js caches every DM it receives, so the tombstone carried the
  sender's id and username ("[message deleted] <id> by @name"). A host
  without event coalescing showed it. Deletes now apply the allowlist too.
  Creates and edits are judged by their author; a delete, which may name no
  author, by the DM's other party: the author unless the message is the
  bot's own, else the DM channel's recipient other than the bot, asked of
  Discord once if the cache can't name it. If Discord can't confirm the
  party (the lookup fails, or names no one), the deletion is withheld, as a
  create from an unknown user is, and the operator log says so with its
  channel and message. An allowed user's deletion of a message no longer
  cached still arrives while discord.js holds the DM channel; a deletion in
  a DM channel it doesn't hold (say, just after a restart) never reaches the
  adapter, as before. The list as it is when the deletion arrives decides,
  as for edits, so a sender removed from it is out for the deletion of a
  message delivered before the removal too. A refused user's DM channel now
  sends the agent no events: the deletion of the bot's own message there
  (one sent with `send_dm`) no longer arrives either.
- **The reconnect catch-up sweep bypassed the ingress filters** (issue #60).
  It delivered every missed message in a known DM channel, including DMs from a
  sender since removed from the DM whitelist, and kept sweeping channels of
  guilds removed from the guild filter. The sweep now applies the same ingress
  decision as live delivery (guild, channel and thread parent, DM author),
  evaluated after the history fetch, so a filter change made while the fetch
  was pending applies. A channel whose identity can't be resolved isn't
  delivered on a guess. It's held back, its watermark untouched, and tried
  again at the next start (the sweep runs once per process), unless a
  message forwarded live in it moves its watermark past what was held first.
  Withheld messages are never rendered, and a withheld DM goes through the
  refusal notice rule: its channel's watermark moves past it once it's
  decided, or after 30 seconds if the notice state's disk hasn't answered by
  then, and only ever forward.

- **Ghost "[message edited]" events.** Discord emits `messageUpdate` for more
  than content edits: link-preview / embed refreshes re-send old messages with
  `edited_timestamp` still null. Those reached the agent as fresh edits of
  weeks-old, never-edited messages. Updates are now forwarded only when
  `editedTimestamp` is set and the content actually changed (when the old
  message is cached). Real edits are unaffected.
- **A muted channel's reactions no longer reach the agent.** `mute_channel`
  promises "no ambient", and closes the channel, but the reaction
  visibility that opening it turned on outlived the mute, so reactions there
  kept landing in context. A mute now drops that visibility, as a close
  does, and both now save the drop, so a restart can't bring it back. After
  `unmute_channel`, reactions return with `channel_open`, along with the rest
  of ambient traffic, as the tools' descriptions now say. While a channel is
  muted, no reaction gets through, even where visibility is turned on again;
  `set_reaction_visibility` says so, and that opt-in takes effect once the
  mute is lifted. The reconnect catch-up sweep now skips a muted channel
  too, where it used to push its missed mentions after a restart.
- **An unreadable state file no longer loses everything in it at the next
  save.** The muted channels, the reaction channels and the watermarks are
  each read once and rewritten whole after every change. When a file
  couldn't be read, its store started empty, and the next save (one
  `mute_channel`, one `set_reaction_visibility`, or the next forwarded
  message for watermarks) overwrote it with only the new entry. Now:
  - A file that isn't exactly what its store writes (not JSON, the wrong
    shape, or entries the store doesn't write, such as the `null` a
    missing `channelId` left in the reaction list) is first copied to
    `<file>.unreadable-<hash>`, named by its content so the same content
    is kept once, and flushed to disk. Then the file itself is rewritten
    with the entries its store can use, or emptied when there are none,
    and the store starts with those. The error log names the copy. The
    file keeps its mode, owner, group and links. A leading byte-order mark
    is no longer a reason, in the filters file too.
  - A file that can't be read at all, say for its permissions, stays as it
    is, and nothing is saved over it until the next start reads it. So does
    one whose copy or rewrite fails. The store runs in memory meanwhile.
  - The server owns these files while it runs, and every save writes the
    whole store over the file, so to edit one or restore a copy, stop the
    server first.
  - `mute_channel`, `unmute_channel` and `set_reaction_visibility` save when
    the call changes their store, or when its file may not hold it (an earlier
    save failed, or the file couldn't be read). When that save fails, the
    reply says so, and that as it stands the store wouldn't survive a restart.
    `mute_channel` also saves the reaction list when it drops the channel's
    visibility, and its reply says so when that save fails.
    `set_reaction_visibility` now refuses a missing `channelId`, as the other
    two do. A watermark save that keeps failing is logged when it starts, when
    its reason changes and when it succeeds again, rather than for every
    forwarded message.
  - A save replaces a plain file the server owns by renaming a temp file
    over it, given the file's mode and group before any content goes in,
    so a process crash partway through can't leave a torn file. Extended
    attributes and an ACL on the file itself don't carry over. A symlink,
    a file with other hard links or another owner, a group the server
    isn't in, and a path that won't take the rename (a directory the
    server can't write, a read-only filesystem around a bind-mounted file,
    a filesystem without permissions) are written in place, as before,
    where a crash partway through can still tear the file; the log says
    so the first time a path is written in place for an error. A file the
    server can't write is left as it is, and a full disk fails the save
    rather than writing in place, so the file keeps what was last saved.
  - The filters file is saved the same way. So a private one now stays
    private, a symlinked or hard-linked one is written through rather than
    replaced, and a read-only one is refused rather than replaced.
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
- **A thread in a channel admitted through its category is admitted too.**
  `guildChannels` admits a listed channel with its threads, and a listed
  category admits the channels under it, but the check looked only one
  parent level up. A thread's parent is its channel, so threads in a channel
  admitted only through its category were dropped at ingress (messages,
  edits, deletes, reactions) and refused by `list_channel_members`, and a
  forum admitted through its category lost every post. A thread now counts
  as its channel wherever that channel's admission comes from: the check
  reads the channel's own category from the channel cache. A thread the
  client knows only partly, without its channel, is now fetched before the
  filters decide, for every event, and new messages in it wait for that
  fetch and arrive in order. Before, such a thread was dropped even under a
  listed channel. A thread whose channel isn't cached stays excluded, as
  before.
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
- **`fetch_history` and `fetch_around` respect the channel filters for
  numeric ids.** Names already resolved only among allowed channels, but a
  numeric channel id went straight to Discord, so either tool could read a
  channel the configured channel list (`guildChannels`) excludes. Both now
  refuse such a channel before any message is read, by the rule
  `list_channels` and `list_channel_members` already apply (a thread or a
  categorized channel admitted by its parent). A `channelId` that isn't a
  string, and a channel the lookup can't find, are refused before any read
  too. The guild filter
  (registration, name resolution, delivery) and the DM contact list
  (incoming DMs) keep their meaning and don't restrict deliberate reads; the
  config docs now say what each filter bounds.
- **`channels/open` backscroll respects the channel filters too.** A
  channel registered before `guildChannels` narrowed stays registered until
  restart (`filters_update` and hot reload only add channels), and opening
  it with `history.limit > 0` read its backscroll with no filter check. That
  read now gets the same refusal as `fetch_history`, and the open fails
  before anything is read or subscribed. An open without history is
  unchanged.
