/**
 * Live voice conversation harness: humans talk in a Discord voice channel,
 * Claude (Sonnet 4.5) answers in voice — under the physics rules — and the
 * whole exchange leaves a text trail in the voice channel's built-in chat.
 *
 * The transcript-ordering protocol (per Antra's design):
 *  - When a human starts speaking, the bot POSTS a message to the voice
 *    channel's text chat immediately ("🎙️ name: …") — so Discord's message
 *    ORDER reflects utterance START order — then EDITS it as the STT
 *    transcript grows/revises, finalizing when they stop. Revision-friendly,
 *    matching voice-kit's "revision is normal" transcript contract.
 *  - The bot's own speech gets the same treatment: message posted when it
 *    starts speaking, edited at the end to reflect what was ACTUALLY heard —
 *    an interrupted utterance shows the voiced prefix, the unvoiced tail
 *    struck through, and so does one the player couldn't play, with why.
 *    Other models read this channel and know exactly what was said, by whom,
 *    in what order.
 *
 * Conversation loop: utterance ends → (debounce for follow-ons) → history →
 * Claude streaming → deltas feed TTS (physics gates playback; barge-in
 * aborts both playback AND the model stream, and so does a reply the player
 * can't play) → interruption and failure reports edit the message and
 * annotate history so the model knows what the room heard.
 *
 * Usage (from discord-mcpl/):
 *   env $(grep -v '^#' .env.voice-test | xargs) ./node_modules/.bin/tsx \
 *     scripts/voice-chat.ts --guild <id> --vc <id> [--voice Opus4] [--model claude-sonnet-4-5]
 */
import Anthropic from '@anthropic-ai/sdk';
import { Client, GatewayIntentBits, type TextBasedChannel } from 'discord.js';
import {
  ElevenLabsTtsProvider, ScribeSttProvider, downmixStereoToMono,
  loadRegistry, resolveVoice, type SttSession,
} from '@animalabs/voice-kit';
import { DiscordVoiceSink, VoiceOutput, type SpeakerInfo } from '../src/voice.js';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const TOKEN = process.env.DISCORD_TOKEN!;
const ELEVEN = process.env.ELEVENLABS_API_KEY!;
const REGISTRY = process.env.DISCORD_VOICE_REGISTRY_FILE!;
const GUILD = arg('guild')!;
const VC = arg('vc')!;
const MODEL = arg('model', 'claude-sonnet-4-5')!;
const VOICE_NAME = arg('voice', 'Opus4')!;
if (!TOKEN || !ELEVEN || !REGISTRY || !GUILD || !VC) {
  console.error('missing env/args'); process.exit(1);
}

/** Silence gap that ends a spoken utterance (audio-flow based). */
const UTTERANCE_END_MS = 900;
/** Wait after an utterance ends before responding (follow-on grace). */
const TURN_DEBOUNCE_MS = 1200;
/** Min interval between Discord message edits (rate-limit hygiene). */
const EDIT_INTERVAL_MS = 1500;

const SYSTEM = `You are ${VOICE_NAME}, speaking OUT LOUD in a Discord voice channel via TTS, \
in the first live test of connectome's voice physics layer (carrier-sense, human barge-in, \
interruption accounting) built today with Antra. Your words are heard, not read.

Speak accordingly: conversational, brief (a few sentences unless asked for more), no markdown, \
no lists, no emoji — punctuation and sentence rhythm are your only formatting. It's fine to be \
playful and to have opinions.

Turn-taking physics you live under: you never talk over a human; if someone speaks while you \
are speaking, you are cut off mid-word and a report tells you exactly which of your words were \
voiced and which were lost. User turns may note "[interrupted you after: ...]" — that means the \
rest of that sentence was never heard; don't refer to unvoiced content as if it was said. A note \
that playback of your last reply failed, or that it couldn't be played, means the same: the room \
heard your reply up to where the note's quote ends, or nothing.`;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from env

client.once('ready', async () => {
  console.log(`[chat] logged in as ${client.user?.tag}, model ${MODEL}`);
  const registry = loadRegistry(REGISTRY);
  const voice = resolveVoice(registry, VOICE_NAME);
  if (!voice) { console.error(`no registry voice "${VOICE_NAME}"`); process.exit(1); }

  const sink = new DiscordVoiceSink(Number(process.env.DISCORD_VOICE_VAD_DB) || undefined);
  await sink.connect(client, GUILD, VC);
  const tts = new ElevenLabsTtsProvider(ELEVEN, registry.ttsModel ?? 'eleven_multilingual_v2');
  const out = new VoiceOutput({ textChannels: null }, tts, voice, sink);
  const stt = new ScribeSttProvider(ELEVEN);

  // Voice channels ARE text channels — post the transcript trail right there.
  const chat = (await client.channels.fetch(VC)) as TextBasedChannel & { send: (m: string) => Promise<import('discord.js').Message> };

  // ── Rate-limited message editor ─────────────────────────────────────────
  function makeEditor(msg: import('discord.js').Message) {
    let last = 0; let pending: string | null = null; let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (pending === null) return;
      const text = pending; pending = null; last = Date.now();
      msg.edit(text.slice(0, 1900)).catch(() => {});
    };
    return {
      edit(text: string) {
        pending = text;
        const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - last));
        if (!timer) timer = setTimeout(() => { timer = null; flush(); }, wait);
      },
      final(text: string) {
        if (timer) { clearTimeout(timer); timer = null; }
        pending = text; flush();
      },
    };
  }

  // ── Conversation state ──────────────────────────────────────────────────
  const history: Anthropic.MessageParam[] = [];
  let pendingUserLines: string[] = [];
  // Notes for the model's next turn that don't start one: a turn prompted by
  // "your reply couldn't be played" would likely fail the same way, and the
  // harness would loop on model calls.
  let pendingNotes: string[] = [];
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  let respNum = 0;
  let activeStream: { abort: () => void; id: string } | null = null;
  // Bot utterance accounting: id → { editor, fullText }
  const botMsgs = new Map<string, { editor: ReturnType<typeof makeEditor>; fullText: string }>();
  // History keeps what the room heard. A reply that ends short (interrupted,
  // or couldn't be played) while the model is still generating it leaves
  // the heard part here, for respond() to write instead of the whole reply;
  // one that ends short after its turn is written rewrites that turn.
  const heardOnly = new Map<string, string>();
  const turns = new Map<string, Anthropic.MessageParam>();

  // ── Listening leg: per-speaker Scribe sessions, transmission-bounded ────
  interface Listener {
    stt: SttSession;
    editor: ReturnType<typeof makeEditor> | null;
    texts: Map<string, string>; // utteranceId → latest text
    lastAudio: number;
    closer: ReturnType<typeof setInterval>;
    speaker: SpeakerInfo;
  }
  const listeners = new Map<string, Listener>();

  function utteranceText(l: Listener): string {
    return [...l.texts.values()].join(' ').replace(/\s+/g, ' ').trim();
  }

  function openListener(speaker: SpeakerInfo): Listener {
    const session = stt.openSession({ sampleRateHz: 48000 });
    const l: Listener = { stt: session, editor: null, texts: new Map(), lastAudio: Date.now(), closer: null as never, speaker };
    session.onTranscript((t) => {
      l.texts.set(t.utteranceId, t.text);
      const text = utteranceText(l);
      if (!text) return;
      if (!l.editor) {
        // Post-on-start: ordering anchor for the room.
        chat.send(`🎙️ **${speaker.username ?? speaker.userId}**: …`)
          .then((m) => { l.editor = makeEditor(m); l.editor.edit(`🎙️ **${speaker.username ?? speaker.userId}**: ${text}`); })
          .catch(() => {});
      } else {
        l.editor.edit(`🎙️ **${speaker.username ?? speaker.userId}**: ${text}`);
      }
    });
    session.onError((e) => console.error(`[stt] ${speaker.username}: ${e.message}`));
    l.closer = setInterval(() => {
      if (Date.now() - l.lastAudio > UTTERANCE_END_MS) closeListener(speaker.userId);
    }, 200);
    listeners.set(speaker.userId, l);
    return l;
  }

  function closeListener(userId: string): void {
    const l = listeners.get(userId);
    if (!l) return;
    clearInterval(l.closer);
    listeners.delete(userId);
    l.stt.commit();
    // Give Scribe a beat to flush the final commit before closing + turn-taking.
    setTimeout(() => {
      l.stt.close();
      const text = utteranceText(l);
      const name = l.speaker.username ?? l.speaker.userId;
      if (l.editor) l.editor.final(`🎙️ **${name}**: ${text || '*(unintelligible)*'}`);
      if (!text) return;
      console.log(`[heard] ${name}: ${text}`);
      pendingUserLines.push(`${name}: ${text}`);
      scheduleTurn();
    }, 600);
  }

  sink.onSpeakerAudio((speaker, pcm48kStereo) => {
    if (speaker.bot) return; // v1: transcribe humans; bots post their own text
    const l = listeners.get(speaker.userId) ?? openListener(speaker);
    l.lastAudio = Date.now();
    l.stt.sendAudio(downmixStereoToMono(pcm48kStereo));
  });

  // ── Speaking leg: Claude streaming → TTS under physics ─────────────────
  function scheduleTurn(): void {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => { turnTimer = null; void respond(); }, TURN_DEBOUNCE_MS);
  }

  async function respond(): Promise<void> {
    if (pendingUserLines.length === 0) return;
    if (activeStream) return; // still talking; new speech will barge in and re-schedule
    const userText = [...pendingNotes, ...pendingUserLines].join('\n');
    pendingNotes = [];
    pendingUserLines = [];
    history.push({ role: 'user', content: userText });

    const id = `resp${++respNum}`;
    let full = '';
    let completed = false;
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: history,
    });
    activeStream = { abort: () => stream.abort(), id };

    const msg = await chat.send(`🔊 **${VOICE_NAME}**: …`).catch(() => null);
    const editor = msg ? makeEditor(msg) : null;
    if (editor) botMsgs.set(id, { editor, fullText: '' });

    stream.on('text', (delta) => {
      full += delta;
      const entry = botMsgs.get(id);
      if (entry) { entry.fullText = full; entry.editor.edit(`🔊 **${VOICE_NAME}**: ${full}`); }
      out.handleChunk(id, `discord:${GUILD}:${VC}`, delta);
    });

    try {
      const final = await stream.finalMessage();
      completed = true;
      if (final.stop_reason === 'refusal') console.log('[chat] model refused');
      console.log(`[said→queue] ${full.slice(0, 100)}…`);
    } catch (err) {
      // Aborted (barge-in, or a reply that couldn't be played) or API error.
      if (!(err as Error).message?.includes('abort')) console.error('[chat] stream error:', (err as Error).message);
    } finally {
      // History gets what the room heard: the heard part if the utterance
      // has already ended short, else the whole reply, which the utterance
      // report below rewrites if it ends short later. A stream that failed
      // before any text leaves no turn.
      const heard = heardOnly.get(id);
      heardOnly.delete(id);
      if (heard !== undefined) {
        history.push({ role: 'assistant', content: heard || '…' });
      } else if (full || completed) {
        const turn: Anthropic.MessageParam = { role: 'assistant', content: full || '…' };
        history.push(turn);
        if (full) turns.set(id, turn);
      }
      out.handleComplete(id);
      activeStream = null;
      // Anything said while we were generating gets answered now.
      if (pendingUserLines.length) scheduleTurn();
    }
  }

  // ── Utterance accounting → chat message + history truth ────────────────
  out.onReport((r) => {
    const entry = botMsgs.get(r.inferenceId);
    botMsgs.delete(r.inferenceId);
    const turn = turns.get(r.inferenceId);
    turns.delete(r.inferenceId);
    if (r.status === 'spoken') {
      if (entry) entry.editor.final(`🔊 **${VOICE_NAME}**: ${entry.fullText}`);
      return;
    }
    // Interrupted, or the player couldn't play it ('expired' needs a
    // maxHoldMs, which this harness doesn't set): the room heard only
    // r.voicedText. Rewrite history so the model knows that.
    if (activeStream?.id === r.inferenceId) {
      // Still generating: stop the model; respond() writes what was heard.
      heardOnly.set(r.inferenceId, r.voicedText);
      activeStream.abort();
    } else if (turn) {
      turn.content = r.voicedText || '…';
    }
    const who = r.interruptedBy?.username ?? 'someone';
    const reason = r.failure ?? 'playback failed';
    const why = r.status === 'interrupted' ? `interrupted by ${who}` : `couldn't be played: ${reason}`;
    if (entry) {
      const cut = r.unvoicedText ? ` ~~${r.unvoicedText.slice(0, 500)}~~` : '';
      const mark = r.status === 'interrupted' ? '✂️' : '⚠️';
      entry.editor.final(`🔊 **${VOICE_NAME}**: ${r.voicedText}${cut}\n-# ${mark} ${why}${r.estimated && r.playedMs > 0 ? ' (approx.)' : ''}`);
    }
    if (r.status === 'interrupted') {
      pendingUserLines.push(`[you were interrupted by ${who} after: "${r.voicedText.slice(-120)}"]`);
    } else {
      pendingNotes.push(r.voicedText
        ? `[playback of your last reply failed (${reason}) after: "${r.voicedText.slice(-120)}"]`
        : `[your last reply couldn't be played (${reason}); nobody heard it]`);
    }
    console.log(`[report] ${why}; voiced ${r.voicedText.length}/${r.voicedText.length + r.unvoicedText.length} chars`);
  });

  console.log('[chat] live — speak in the channel');
});

void client.login(TOKEN);
