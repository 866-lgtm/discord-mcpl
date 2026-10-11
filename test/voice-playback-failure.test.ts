// A voice item that can't be played is settled as 'failed': the sink resets
// what it was playing and goes on to the next item, without clearing (and so
// billing) the refused one; VoiceOutput ends the utterance (stopping
// synthesis) and reports it; and the server tells the model it couldn't be
// played. Before, the throw escaped the sink's fire-and-forget pump() as an
// unhandled rejection, which ends the process, and left the utterance waiting
// for an outcome that never came. slimepriestess's #69 review note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, type Readable } from 'node:stream';
import { createAudioPlayer, NoSubscriberBehavior, type AudioResource } from '@discordjs/voice';
import {
  DiscordVoiceSink, PlaybackFailure, VoiceOutput,
  type PcmSink, type SinkEvent, type SinkItem, type SpeakerInfo, type UtteranceReport,
} from '../src/voice.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';
import type { TtsAlignment, TtsProvider, TtsStream, TtsVoice } from '@animalabs/voice-kit';

type SinkInternals = {
  player: unknown;
  gate: { waitClear: () => Promise<void> };
  current: unknown;
  playing: boolean;
};

/** A DiscordVoiceSink with a stand-in player and carrier gate: no Discord. */
function sinkWith(player: unknown, waitClear: () => Promise<void> = async () => {}) {
  const sink = new DiscordVoiceSink();
  const internals = sink as unknown as SinkInternals;
  internals.player = player;
  internals.gate = { waitClear };
  const events: SinkEvent[] = [];
  sink.onEvent((ev) => events.push(ev));
  return { sink, internals, events };
}

const item = (id: string): SinkItem => ({ id, stream: new PassThrough() });

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Fails the test if anything rejects unhandled while it runs. */
function noUnhandledRejections(t: { after: (fn: () => void) => void }): unknown[] {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    process.off('unhandledRejection', onRejection);
    assert.deepEqual(seen, [], 'no unhandled rejection');
  });
  return seen;
}

const summary = (events: SinkEvent[]) =>
  events.map((e) => (e.type === 'failed' ? `${e.type}:${e.id}:${e.playedMs}:${e.reason}` : `${e.type}:${e.id}`));

test('a player that refuses an item settles it as failed, uncleared, and the next item still reaches the player', async (t) => {
  noUnhandledRejections(t);
  // @discordjs/voice's AudioPlayer.play throws this for an ended resource.
  const refusal = 'Cannot play a resource that has already ended.';
  const played: unknown[] = [];
  const player = {
    play(resource: unknown) { played.push(resource); throw new Error(refusal); },
    stop() {},
  };
  const { sink, internals, events } = sinkWith(player);
  sink.play(item('u1'));
  sink.play(item('u2'));
  await until(() => events.filter((e) => e.type === 'failed').length === 2, 'both items to settle');
  // Never 'cleared': the billing gate stays shut for an item the player refused.
  assert.deepEqual(summary(events), [`failed:u1:0:${PlaybackFailure.refused}`, `failed:u2:0:${PlaybackFailure.refused}`]);
  assert.equal(played.length, 2, 'the second item reached the player after the first failed');
  for (const resource of played as AudioResource[]) {
    assert.equal(resource.playStream.destroyed, true, "a refused item's resource is released");
  }
  assert.equal(internals.current, null, 'nothing is left marked as playing');
  await until(() => internals.playing === false, 'the pump to finish');
});

test('after a refusal, a real AudioPlayer plays the next item: cleared, started, finished', async (t) => {
  noUnhandledRejections(t);
  // As connect() makes it, without a voice connection: with noSubscriber
  // Play, @discordjs/voice's audio cycle reads its frames with no one
  // subscribed. A real player can't be made to refuse a resource the sink
  // creates fresh, so this one throws on its first play() and is real after.
  const refusal = 'Cannot play a resource that has already ended.';
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const realPlay = player.play.bind(player);
  let refusals = 1;
  player.play = <T>(resource: AudioResource<T>): void => {
    if (refusals-- > 0) throw new Error(refusal);
    realPlay(resource);
  };
  const { sink, internals, events } = sinkWith(player);
  // 200 ms of 48 kHz stereo s16le silence: ten 20 ms frames, all written
  // before the item plays.
  const pcm = new PassThrough();
  pcm.end(Buffer.alloc(48_000 * 2 * 2 / 5));
  sink.play(item('u1'));
  sink.play({ id: 'u2', stream: pcm });
  await until(() => events.some((e) => e.type === 'finished'), 'the second item to finish');
  // The order the billing gate relies on: 'cleared' only once the player
  // has accepted the item, then the real player's Playing and Idle.
  assert.deepEqual(summary(events), [`failed:u1:0:${PlaybackFailure.refused}`, 'cleared:u2', 'started:u2', 'finished:u2']);
  const finished = events[3] as Extract<SinkEvent, { type: 'finished' }>;
  assert.equal(finished.playedMs, 200, 'all ten frames played');
  assert.equal(internals.current, null);
  await until(() => internals.playing === false, 'the pump to finish');
});

test('when nothing more can play, every queued item is settled as failed, and a later item is pumped again', async (t) => {
  noUnhandledRejections(t);
  let broken = true;
  const played: unknown[] = [];
  const player = {
    play(resource: unknown) { played.push(resource); throw new Error('player refused'); },
    stop() {},
  };
  const { sink, internals, events } = sinkWith(player, async () => {
    if (broken) throw new Error('gate broke');
  });
  sink.play(item('u1'));
  sink.play(item('u2'));
  await until(() => events.filter((e) => e.type === 'failed').length === 2, 'both queued items to settle');
  assert.deepEqual(summary(events), [`failed:u1:0:${PlaybackFailure.stopped}`, `failed:u2:0:${PlaybackFailure.stopped}`]);
  assert.equal(played.length, 0);
  await until(() => internals.playing === false, 'the pump to stop');

  // The sink isn't wedged: the next item is pumped again.
  broken = false;
  sink.play(item('u3'));
  await until(() => events.length >= 3, 'the later item to settle');
  assert.deepEqual(summary(events).slice(2), [`failed:u3:0:${PlaybackFailure.refused}`]);
  assert.equal(played.length, 1);
});

test('an item a failed listener queues while the queue is being settled is still pumped', async (t) => {
  noUnhandledRejections(t);
  let breaks = 1;
  const played: unknown[] = [];
  const player = {
    play(resource: unknown) { played.push(resource); throw new Error('player refused'); },
    stop() {},
  };
  const { sink, internals, events } = sinkWith(player, async () => {
    if (breaks-- > 0) throw new Error('gate broke');
  });
  // Queues a replacement from u1's failure, which the drain emits while the
  // pump is still marked as playing. Only once: this gate has no hold-off to
  // pace a listener that re-queued on every failure.
  sink.onEvent((ev) => { if (ev.type === 'failed' && ev.id === 'u1') sink.play(item('u1-again')); });
  sink.play(item('u1'));
  await until(() => events.length >= 2, 'the replacement to settle');
  assert.deepEqual(summary(events), [`failed:u1:0:${PlaybackFailure.stopped}`, `failed:u1-again:0:${PlaybackFailure.refused}`]);
  assert.equal(played.length, 1, 'the replacement reached the player without another play()');
  await until(() => internals.playing === false, 'the pump to finish');
});

type PlayerInternals = SinkInternals & {
  playingTimeoutMs: number;
  idleTimeoutMs: number;
  current: { interruptedBy: unknown } | null;
  maybeYield(s: SpeakerInfo): void;
};

/** A real AudioPlayer, as connect() makes it, but with no voice connection. */
const realPlayer = () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

test('an accepted item that never gets audio fails when the wait for Playing runs out, instead of being reported spoken', async (t) => {
  noUnhandledRejections(t);
  const player = realPlayer();
  const { sink, internals, events } = sinkWith(player);
  (internals as PlayerInternals).playingTimeoutMs = 100;
  // As when the TTS provider is unavailable at clearance: no audio ever comes.
  sink.play({ id: 'u1', stream: new PassThrough() });
  await until(() => events.some((e) => e.type === 'failed'), 'the item to fail');
  assert.deepEqual(summary(events), ['cleared:u1', 'failed:u1:0:no audio reached the player within 0.1s']);
  assert.equal(internals.current, null);
  await until(() => internals.playing === false, 'the pump to finish');
});

test("the player's error for the playing stream fails the item with that error, where it was reported finished", async (t) => {
  noUnhandledRejections(t);
  const player = realPlayer();
  const { sink, internals, events } = sinkWith(player);
  // 200 ms of silence, and the stream left open, so the item is still playing.
  const pcm = new PassThrough();
  pcm.write(Buffer.alloc(48_000 * 2 * 2 / 5));
  sink.play({ id: 'u1', stream: pcm });
  await until(() => events.some((e) => e.type === 'started'), 'the item to start');
  pcm.destroy(new Error('stream broke'));
  await until(() => events.some((e) => e.type === 'failed'), 'the item to fail');
  const last = summary(events).at(-1)!;
  assert.equal(last.replace(/:\d+:/, ':N:'), `failed:u1:N:${PlaybackFailure.streamFailed}`);
  await until(() => internals.playing === false, 'the pump to finish');
});

test('a throw while an item plays settles it, with what was queued, and a barge-in before it still reads as interrupted', async (t) => {
  noUnhandledRejections(t);
  const player = realPlayer();
  const realStop = player.stop.bind(player);
  t.after(() => realStop(true));
  // The stop after the Playing wait runs out throws, so the pump's outer
  // catch settles the item still current, and the one queued behind it.
  player.stop = () => { throw new Error('stop broke'); };
  const { sink, internals, events } = sinkWith(player);
  (internals as PlayerInternals).playingTimeoutMs = 100;
  // A listener queues a replacement when u1 fails. The queue was taken before
  // u1 was settled, so the replacement isn't swept up with u2: it is played.
  let requeued = false;
  sink.onEvent((ev) => {
    if (ev.type === 'failed' && ev.id === 'u1' && !requeued) { requeued = true; sink.play({ id: 'u1-again', stream: new PassThrough() }); }
  });
  sink.play({ id: 'u1', stream: new PassThrough() });
  sink.play({ id: 'u2', stream: new PassThrough() });
  await until(() => events.filter((e) => e.type === 'failed').length === 3, 'all three items to settle');
  assert.deepEqual(summary(events), [
    'cleared:u1', `failed:u1:0:${PlaybackFailure.stopped}`, `failed:u2:0:${PlaybackFailure.stopped}`,
    'cleared:u1-again', `failed:u1-again:0:${PlaybackFailure.stopped}`,
  ]);
  await until(() => internals.playing === false, 'the pump to stop');

  // Someone barges in on the next item just before the same throw.
  const by = { userId: 'h1', username: 'human', bot: false };
  sink.play({ id: 'u3', stream: new PassThrough() });
  await until(() => events.some((e) => e.type === 'cleared' && e.id === 'u3'), 'u3 to clear');
  (internals as PlayerInternals).current!.interruptedBy = by;
  await until(() => events.length >= 7, 'u3 to settle');
  const settled = events.at(-1)!;
  assert.equal(settled.type, 'interrupted');
  assert.deepEqual((settled as Extract<SinkEvent, { type: 'interrupted' }>).by, by);
});

// ── VoiceOutput and the server: what a failed item becomes ─────────────────

class FakeStream implements TtsStream {
  sent: string[] = [];
  ended = false;
  aborted = false;
  private audioFns: Array<(b: Buffer) => void> = [];
  sendText(d: string): void { this.sent.push(d); }
  end(): void { this.ended = true; }
  abort(): void { this.aborted = true; }
  /** Deliver audio as the provider would, even after an abort (a late chunk). */
  audio(b: Buffer): void { for (const f of this.audioFns) f(b); }
  onAudio(f: (b: Buffer) => void): void { this.audioFns.push(f); }
  onAlignment(_f: (a: TtsAlignment) => void): void {}
  onEnd(_f: () => void): void {}
  onError(_f: (e: Error) => void): void {}
}

class FakeProvider implements TtsProvider {
  readonly name = 'fake';
  readonly outputRateHz = 44100;
  streams: FakeStream[] = [];
  openStream(_v: TtsVoice): TtsStream {
    const s = new FakeStream();
    this.streams.push(s);
    return s;
  }
}

class FakeSink implements PcmSink {
  played: SinkItem[] = [];
  private fns: Array<(ev: SinkEvent) => void> = [];
  play(i: SinkItem): void { this.played.push(i); }
  cancel(): boolean { return false; }
  onEvent(fn: (ev: SinkEvent) => void): void { this.fns.push(fn); }
  emit(ev: SinkEvent): void { for (const f of this.fns) f(ev); }
}

test('VoiceOutput ends a failed utterance, stops its synthesis and reports it as failed', () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null }, provider, { voiceId: 'v1' }, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));

  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  sink.emit({ type: 'cleared', id: 'inf1' });
  assert.deepEqual(provider.streams[0]!.sent, ['Hello there.']);
  const reason = 'Cannot play a resource that has already ended.';
  sink.emit({ type: 'failed', id: 'inf1', playedMs: 0, reason });

  assert.equal(provider.streams[0]!.aborted, true, 'synthesis stops: no more billing for audio nobody hears');
  assert.equal(reports.length, 1);
  const r = reports[0]!;
  assert.equal(r.status, 'failed');
  assert.equal(r.failure, reason);
  assert.equal(r.interruptedBy, undefined);
  assert.equal(r.voicedText, '');
  assert.equal(r.unvoicedText, 'Hello there.');
  assert.equal(r.restUnvoiced, true, 'the reply was still streaming, and the report says the rest goes unvoiced');

  // The rest of that inference isn't voiced: the model re-decides.
  out.handleChunk('inf1', 'discord:g:100', ' More.');
  assert.equal(provider.streams.length, 1);
  assert.equal(sink.played.length, 1);
});

test('an item refused before clearance bills nothing and reports how long it was queued', async () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null }, provider, { voiceId: 'v1' }, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));

  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  await new Promise((r) => setTimeout(r, 25));
  sink.emit({ type: 'failed', id: 'inf1', playedMs: 0, reason: 'refused' });

  assert.deepEqual(provider.streams[0]!.sent, [], 'no text went to the provider');
  assert.equal(provider.streams[0]!.aborted, true, 'the pre-opened socket is closed');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.status, 'failed');
  assert.equal(reports[0]!.billedChars, 0);
  assert.equal(reports[0]!.unvoicedText, 'Hello there.');
  assert.ok(reports[0]!.queuedMs >= 15, `queued until it failed (${reports[0]!.queuedMs} ms)`);
});

test('a finished utterance that never had audio is not counted as fully played, and nothing heard is exact', () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null }, provider, { voiceId: 'v1' }, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));

  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  out.handleComplete('inf1');
  sink.emit({ type: 'cleared', id: 'inf1' });
  // The fake provider sends no audio, so audioMs stays 0.
  sink.emit({ type: 'finished', id: 'inf1', playedMs: 0 });

  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.status, 'spoken');
  assert.equal(reports[0]!.voicedText, '', 'nothing is counted as voiced');
  assert.equal(reports[0]!.unvoicedText, 'Hello there.');
  assert.equal(reports[0]!.estimated, false, 'nothing heard is an exact boundary');
});

test('the server tells the model a failed utterance could not be played, tagged voice:failed', () => {
  const server = new DiscordMcplServer({} as unknown as DiscordAdapter);
  const sent: Array<{ method: string; params: Record<string, any> }> = [];
  const internals = server as unknown as {
    conn: unknown;
    mcplEnabled: boolean;
    handleVoiceReport(r: UtteranceReport): void;
  };
  internals.conn = {
    sendRequest: async (method: string, params: Record<string, any>) => { sent.push({ method, params }); return {}; },
  };
  internals.mcplEnabled = true;

  const base = {
    inferenceId: 'inf1', channelId: 'discord:g1:100', status: 'failed' as const,
    queuedMs: 40, billedChars: 12, voicedText: '', unvoicedText: 'Hello there.', estimated: true,
    failure: 'Cannot play a resource that has already ended.',
  };
  internals.handleVoiceReport({ ...base, playedMs: 0 });
  assert.equal(sent.length, 1);
  const p = sent[0]!.params;
  assert.deepEqual(p.tags, ['voice:failed']);
  assert.equal(p.eventId, 'discord_voice_failed_inf1');
  const text: string = p.payload.content[0].text;
  assert.equal(
    text,
    "[voice] Your spoken message couldn't be played (Cannot play a resource that has already ended.) — nothing was heard.\n" +
      'NOT heard: "Hello there."\n(The text was still delivered in the text channel as usual.)',
  );

  // Part-way through: say how much was heard.
  internals.handleVoiceReport({ ...base, playedMs: 1500, voicedText: 'Hello', unvoicedText: ' there.', estimated: false });
  const partial: string = sent[1]!.params.payload.content[0].text;
  assert.equal(
    partial,
    '[voice] Your spoken message was stopped after 1.5s (Cannot play a resource that has already ended.).\n' +
      'Heard up to: "Hello"\nNOT heard: " there."\n(The text was still delivered in the text channel as usual.)',
  );

  // An estimated boundary says so.
  internals.handleVoiceReport({ ...base, playedMs: 1500, voicedText: 'Hello', unvoicedText: ' there.', estimated: true });
  assert.match(sent[2]!.params.payload.content[0].text, /^\[voice\] Your spoken message was stopped after 1\.5s \(boundary approximate\) \(.*\)\.\nHeard up to: "Hello"\n/);

  // An empty side is left out rather than quoted empty: audio played, but no
  // character of it counts as heard; and everything heard, then a failure.
  internals.handleVoiceReport({ ...base, playedMs: 200, voicedText: '', unvoicedText: 'Hello there.', estimated: false });
  assert.equal(
    sent[3]!.params.payload.content[0].text,
    '[voice] Your spoken message was stopped after 0.2s (Cannot play a resource that has already ended.).\n' +
      'NOT heard: "Hello there."\n(The text was still delivered in the text channel as usual.)',
  );
  internals.handleVoiceReport({ ...base, playedMs: 2000, voicedText: 'Hello there.', unvoicedText: '', estimated: false });
  assert.equal(
    sent[4]!.params.payload.content[0].text,
    '[voice] Your spoken message was stopped after 2.0s (Cannot play a resource that has already ended.).\n' +
      'Heard up to: "Hello there."\n(The text was still delivered in the text channel as usual.)',
  );

  // A reply still streaming when it ended short: the rest wasn't voiced either.
  internals.handleVoiceReport({ ...base, playedMs: 0, restUnvoiced: true });
  assert.equal(
    sent[5]!.params.payload.content[0].text,
    "[voice] Your spoken message couldn't be played (Cannot play a resource that has already ended.) — nothing was heard.\n" +
      'NOT heard: "Hello there."\nWhat you went on to say in that reply wasn\'t voiced either.\n' +
      '(The text was still delivered in the text channel as usual.)',
  );
  internals.handleVoiceReport({
    ...base, status: 'interrupted', failure: undefined, playedMs: 1500, voicedText: 'Hello', unvoicedText: ' there.',
    estimated: false, interruptedBy: { userId: 'h1', username: 'human', bot: false }, restUnvoiced: true,
  });
  assert.equal(
    sent[6]!.params.payload.content[0].text,
    '[voice] Your spoken message was interrupted by @human after 1.5s.\n' +
      'Heard up to: "Hello"\nNOT heard: " there."\nWhat you went on to say in that reply wasn\'t voiced either.',
  );
});

// ── The review's further cases (sw-dm71b) ──────────────────────────────────

test('a barge-in before the item starts playing settles it as interrupted at once, not after the wait for Playing', async (t) => {
  noUnhandledRejections(t);
  const { sink, internals, events } = sinkWith(realPlayer());
  const sinkInternals = internals as unknown as PlayerInternals;
  sinkInternals.playingTimeoutMs = 10_000;
  // No audio yet: the player is buffering when the barge-in comes.
  sink.play({ id: 'u1', stream: new PassThrough() });
  await until(() => events.some((e) => e.type === 'cleared'), 'u1 to clear');
  const by = { userId: 'h1', username: 'human', bot: false };
  const at = Date.now();
  sinkInternals.maybeYield(by);
  await until(() => events.some((e) => e.type === 'interrupted'), 'u1 to settle', 2000);
  assert.ok(Date.now() - at < 1000, `settled in ${Date.now() - at} ms, not at the 10 s wait`);
  const settled = events.at(-1) as Extract<SinkEvent, { type: 'interrupted' }>;
  assert.deepEqual(summary(events), ['cleared:u1', 'interrupted:u1']);
  assert.deepEqual(settled.by, by, 'an interruption, with who, not a failure');
  assert.equal(settled.playedMs, 0);
  await until(() => internals.playing === false, 'the pump to finish');
});

test('playback that runs past the limit on one reply is stopped and fails, naming the limit, with what played', async (t) => {
  noUnhandledRejections(t);
  const { sink, internals, events } = sinkWith(realPlayer());
  (internals as unknown as PlayerInternals).idleTimeoutMs = 300;
  // 20 ms frames of silence, written as fast as they play, for longer than the limit.
  const pcm = new PassThrough();
  const frame = Buffer.alloc(48_000 * 2 * 2 / 50);
  const feeder = setInterval(() => { if (!pcm.writableEnded) pcm.write(frame); }, 20);
  t.after(() => clearInterval(feeder));
  sink.play({ id: 'u1', stream: pcm });
  await until(() => events.some((e) => e.type === 'failed'), 'u1 to fail');
  clearInterval(feeder);
  pcm.end();
  const failed = events.at(-1) as Extract<SinkEvent, { type: 'failed' }>;
  assert.equal(failed.reason, PlaybackFailure.tooLong(300));
  assert.equal(failed.reason, 'it reached the 0.3s limit on one reply');
  assert.ok(failed.playedMs > 0, `the room heard ${failed.playedMs} ms of it`);
  assert.deepEqual(summary(events).slice(0, 2), ['cleared:u1', 'started:u1']);
  await until(() => internals.playing === false, 'the pump to finish');
});

test("a stream the player can't take fails at once, uncleared, and the next item still plays", async (t) => {
  noUnhandledRejections(t);
  const { sink, internals, events } = sinkWith(realPlayer());
  // createAudioResource throws for something that isn't a stream at all.
  sink.play({ id: 'u1', stream: {} as unknown as Readable });
  const pcm = new PassThrough();
  pcm.end(Buffer.alloc(48_000 * 2 * 2 / 5));
  sink.play({ id: 'u2', stream: pcm });
  await until(() => events.some((e) => e.type === 'finished'), 'u2 to finish');
  assert.deepEqual(summary(events), [`failed:u1:0:${PlaybackFailure.refused}`, 'cleared:u2', 'started:u2', 'finished:u2']);
  await until(() => internals.playing === false, 'the pump to finish');
});

test('a failed utterance ends its stream, and audio that comes after is dropped rather than written after the end', async () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null }, provider, { voiceId: 'v1' }, sink, () => {});
  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  sink.emit({ type: 'cleared', id: 'inf1' });
  const stream = sink.played[0]!.stream as PassThrough;
  const errors: unknown[] = [];
  stream.on('error', (e) => errors.push(e));
  sink.emit({ type: 'failed', id: 'inf1', playedMs: 0, reason: PlaybackFailure.refused });
  assert.equal(stream.writableEnded, true, "the failed branch ends the item's stream");
  provider.streams[0]!.audio(Buffer.alloc(882)); // a late chunk from the aborted synthesis
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, [], 'nothing was written after the end');
});

test('a reply whose provider is unavailable at clearance plays nothing and is reported spoken, nothing heard', async (t) => {
  noUnhandledRejections(t);
  // As the review found with a real player: the item's stream is ended empty,
  // so the player starts and ends it at once, and the report is a 'spoken'
  // one with nothing voiced, which the server words as cut short by a
  // synthesis error (its cause).
  class DownProvider implements TtsProvider {
    readonly name = 'down';
    readonly outputRateHz = 44100;
    openStream(_v: TtsVoice): TtsStream { throw new Error('provider down'); }
  }
  const { sink, internals } = sinkWith(realPlayer());
  const out = new VoiceOutput({ textChannels: null }, new DownProvider(), { voiceId: 'v1' }, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  out.handleComplete('inf1');
  await until(() => reports.length === 1, 'the report');
  const r = reports[0]!;
  assert.equal(r.status, 'spoken');
  assert.equal(r.playedMs, 0);
  assert.equal(r.voicedText, '');
  assert.equal(r.unvoicedText, 'Hello there.');
  assert.equal(r.billedChars, 0);
  await until(() => internals.playing === false, 'the pump to finish');
});

test('a failed reply that played to its end is reported in full, as a finished one is', () => {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const out = new VoiceOutput({ textChannels: null }, provider, { voiceId: 'v1' }, sink, () => {});
  const reports: UtteranceReport[] = [];
  out.onReport((r) => reports.push(r));
  out.handleChunk('inf1', 'discord:g:100', 'Hello there.');
  out.handleComplete('inf1');
  sink.emit({ type: 'cleared', id: 'inf1' });
  // One second of audio at 44.1 kHz mono PCM16, all of it played but for alignment jitter.
  provider.streams[0]!.audio(Buffer.alloc(44_100 * 2));
  sink.emit({ type: 'failed', id: 'inf1', playedMs: 900, reason: PlaybackFailure.streamFailed });
  const r = reports[0]!;
  assert.equal(r.status, 'failed');
  assert.equal(r.voicedText, 'Hello there.', 'within the slack of the whole: snapped to the full text');
  assert.equal(r.unvoicedText, '');
  assert.equal(r.restUnvoiced, undefined, 'the reply was complete');
});
