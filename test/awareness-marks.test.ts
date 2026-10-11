/**
 * The admin slash commands and the host's 💤 awareness marks
 * (agent-framework#250's `marks` host command).
 *
 * - /undo and /hide take an optional `marks` choice (none, addressed, all),
 *   passed to a host that has the `marks` verb, which places the marks and
 *   returns a `markers` receipt.
 * - A host without the verb places branch-following marks on undo that no
 *   option can make a one-shot act, so /undo is refused there. /hide there
 *   reacts 💤 itself only for `all`, and refuses `addressed`.
 * - /marks lists the journal and cancels, retracts or releases.
 *
 * The host is a stub answering host/command; Discord is a stub adapter.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';
import {
  boundedReply,
  clip,
  describeMarkers,
  detailText,
  isView,
  paginate,
  renderListPage,
  REPLY_LIMIT,
  type AwarenessView,
} from '../src/awareness-marks.js';

type Sent = Record<string, unknown>;

/** The probe: a `marks` request naming no action. */
const isProbe = (p: Sent): boolean => p.command === 'marks' && p.action === undefined;

/** How agent-framework#250 answers the probe, and how every older framework
 *  with host/command answers a verb it lacks. */
const VERB_ANSWER = { ok: false, error: 'marks needs action list, cancel, retract or release' };
const NO_VERB_ANSWER = { ok: false, error: 'Unknown host command: marks' };

/** A host whose host/command answers are scripted; `marksVerb` decides how
 *  it answers the probe, `{ fails }` making the probe's request fail. */
function host(opts: {
  marksVerb: 'yes' | 'no' | { fails: unknown };
  answer?: (params: Sent) => unknown;
}) {
  const sent: Sent[] = [];
  const conn = {
    sendRequest: async (method: string, params: Sent) => {
      assert.equal(method, 'host/command');
      sent.push(params);
      if (isProbe(params)) {
        if (typeof opts.marksVerb === 'object') throw opts.marksVerb.fails;
        return opts.marksVerb === 'yes' ? VERB_ANSWER : NO_VERB_ANSWER;
      }
      return opts.answer ? opts.answer(params) : { ok: true };
    },
  };
  return { conn, sent, probes: () => sent.filter(isProbe), commands: () => sent.filter((p) => !isProbe(p)) };
}

function serverWith(conn: unknown, opts: { failReaction?: (messageId: string) => Error | undefined } = {}) {
  const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  const discord = {
    addReaction: async (channelId: string, messageId: string, emoji: string) => {
      const failure = opts.failReaction?.(messageId);
      if (failure) throw failure;
      reactions.push({ channelId, messageId, emoji });
    },
  };
  const server = new DiscordMcplServer(discord as unknown as DiscordAdapter) as unknown as {
    conn: unknown;
    handleSlashCommand(i: unknown): Promise<void>;
  };
  server.conn = conn;
  return { server, reactions };
}

/** A slash interaction from an admin, recording what it was answered.
 *  `rejectEdits` refuses that many edits first, as Discord does once an
 *  interaction has expired. */
function interaction(commandName: string, options: Record<string, string | number | undefined>, opts: { rejectEdits?: number } = {}) {
  let toReject = opts.rejectEdits ?? 0;
  const out: { replies: string[]; files: Array<{ attachment: Buffer; name: string }[]>; deferred?: unknown; ephemeral: boolean[] } = {
    replies: [],
    files: [],
    ephemeral: [],
  };
  return {
    out,
    value: {
      commandName,
      user: { id: 'admin-1', username: 'Admin' },
      channelId: 'c1',
      options: {
        getInteger: (name: string) => (typeof options[name] === 'number' ? options[name] : null),
        getString: (name: string, required?: boolean) => {
          const v = options[name];
          if (v === undefined && required) throw new Error(`missing ${name}`);
          return typeof v === 'string' ? v : null;
        },
      },
      deferReply: async (o?: { flags?: unknown }) => { out.deferred = o ?? {}; },
      editReply: async (o: string | { content: string; files: Array<{ attachment: Buffer; name: string }> }) => {
        const content = typeof o === 'string' ? o : o.content;
        // Discord refuses a reply over its limit; a test can also refuse edits outright.
        if (toReject > 0 || content.length > REPLY_LIMIT) {
          if (toReject > 0) toReject--;
          throw new Error(content.length > REPLY_LIMIT ? 'Invalid Form Body: content too long' : 'Unknown interaction');
        }
        if (typeof o === 'string') out.replies.push(o);
        else { out.replies.push(o.content); out.files.push(o.files); }
      },
      reply: async (o: { content: string; flags?: unknown }) => {
        if (o.content.length > REPLY_LIMIT) throw new Error('Invalid Form Body: content too long');
        out.replies.push(o.content);
        out.ephemeral.push(o.flags !== undefined);
      },
    },
  };
}

async function asAdmin<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DISCORD_ADMIN_USERS;
  process.env.DISCORD_ADMIN_USERS = 'admin-1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DISCORD_ADMIN_USERS;
    else process.env.DISCORD_ADMIN_USERS = previous;
  }
}

const undoAnswer = (markers: unknown) => (p: Sent) =>
  p.command === 'undo' ? { ok: true, messagesRemoved: 2, markers, lastVisible: null } : { ok: true };

describe('/undo and the marks choice', () => {
  it('is refused on a host without the marks verb, whatever the option, and nothing is undone', async () => {
    for (const marks of [undefined, 'none', 'addressed', 'all']) {
      const h = host({ marksVerb: 'no' });
      const { server } = serverWith(h.conn);
      const i = interaction('undo', { messages: 2, marks });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.equal(h.commands().length, 0, `marks=${marks}: no undo sent`);
      assert.match(i.out.replies.at(-1)!, /Undo refused: this host can't make awareness marks a choice/);
    }
  });

  it('is not sent when the probe proves nothing, and asks again next time', async () => {
    const h = host({ marksVerb: { fails: new Error('request timed out') } });
    const { server } = serverWith(h.conn);
    const first = interaction('undo', {});
    await asAdmin(() => server.handleSlashCommand(first.value));
    assert.match(first.out.replies.at(-1)!, /^⚠️ Undo not sent: couldn't learn .*\(request timed out\)\. Nothing was changed\.$/);
    const second = interaction('undo', {});
    await asAdmin(() => server.handleSlashCommand(second.value));
    assert.equal(h.probes().length, 2, 'an unproven answer is not kept');
    assert.equal(h.commands().length, 0);
  });

  it('sends no marks when none are chosen, and probes once per connection', async () => {
    const h = host({ marksVerb: 'yes', answer: undoAnswer({ scope: 'none', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 }) });
    const { server } = serverWith(h.conn);
    for (let n = 0; n < 2; n++) {
      const i = interaction('undo', { messages: 2 });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.match(i.out.replies.at(-1)!, /Removed the last \*\*2\*\*/);
      assert.match(i.out.replies.at(-1)!, /\nMarks: none\.\n/);
    }
    const undos = h.commands();
    assert.equal(undos.length, 2);
    for (const u of undos) assert.equal('marks' in u, false);
    assert.equal(h.probes().length, 1, 'one probe per connection');
  });

  it('reads an explicit none as none, the same as one left out', async () => {
    const h = host({ marksVerb: 'yes', answer: undoAnswer({ scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }) });
    const { server } = serverWith(h.conn);
    const i = interaction('undo', { messages: 2, marks: 'none' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0]!.marks, 'none');
    assert.match(i.out.replies.at(-1)!, /\nMarks: none\.\n/);
  });

  it('passes a chosen scope and reports what the receipt says, no more', async () => {
    const h = host({ marksVerb: 'yes', answer: undoAnswer({ scope: 'addressed', unmarked: 1, notRemoved: 0, status: 'queued', queued: 3, batchId: 'b-7' }) });
    const { server } = serverWith(h.conn);
    const i = interaction('undo', { messages: 4, marks: 'addressed' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0].marks, 'addressed');
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /3 💤 marks requested \(addressed; batch `b-7`\) — not yet confirmed on Discord/);
    assert.match(reply, /1 removed message outside that scope left unmarked/);
  });

  it('shows a markers receipt it cannot read as sent, beside the applied undo', async () => {
    const markers = { scope: 'all', unmarked: 0, notRemoved: 0, status: 'deferred', queued: 0, until: 'resume' };
    const h = host({ marksVerb: 'yes', answer: undoAnswer(markers) });
    const { server } = serverWith(h.conn);
    const i = interaction('undo', { messages: 2, marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /^🗑️ Removed the last \*\*2\*\*/);
    assert.match(reply, /\nMarks: the host's receipt is in a shape this server can't read; here it is as sent:\n```json\n/);
    assert.ok(reply.includes(JSON.stringify(markers)), reply);
  });
});

describe('the marks probe', () => {
  /** A host whose probes wait until the test answers them, in order. */
  function gatedHost() {
    const sent: Sent[] = [];
    const probes: Array<{ resolve: (answer: unknown) => void; reject: (err: Error) => void }> = [];
    const conn = {
      sendRequest: (_m: string, params: Sent): Promise<unknown> => {
        sent.push(params);
        if (isProbe(params)) {
          return new Promise((resolve, reject) => probes.push({ resolve, reject }));
        }
        return Promise.resolve({ ok: true, messagesRemoved: 1, markers: { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }, lastVisible: null });
      },
    };
    return { conn, sent, probes, undos: () => sent.filter((p) => p.command === 'undo').length };
  }
  /** Let the commands in flight run until they wait on the host. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('names no action, so the host reads nothing to answer it', async () => {
    const h = host({ marksVerb: 'yes', answer: undoAnswer({ scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }) });
    const { server } = serverWith(h.conn);
    await asAdmin(() => server.handleSlashCommand(interaction('undo', {}).value));
    assert.deepEqual(h.probes(), [{ command: 'marks' }]);
  });

  it('keeps any answer the host gives: only "Unknown host command" means an older host', async () => {
    // agent-framework#250 refuses the probe for its missing action; any other
    // answer that isn't "Unknown host command" proves the verb as well.
    for (const answer of [VERB_ANSWER, { ok: false, error: 'marks is busy' }, { ok: true, awareness: [] }]) {
      const conn = {
        sent: [] as Sent[],
        sendRequest: async (_m: string, p: Sent) => {
          conn.sent.push(p);
          return isProbe(p) ? answer : { ok: true, messagesRemoved: 1, markers: { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 } };
        },
      };
      const { server } = serverWith(conn);
      for (let n = 0; n < 2; n++) {
        const i = interaction('undo', {});
        await asAdmin(() => server.handleSlashCommand(i.value));
        assert.match(i.out.replies.at(-1)!, /^🗑️ Removed the last \*\*1\*\*/, JSON.stringify(answer));
      }
      assert.equal(conn.sent.filter(isProbe).length, 1, `${JSON.stringify(answer)}: kept`);
    }
    const old = host({ marksVerb: 'no' });
    const { server } = serverWith(old.conn);
    for (let n = 0; n < 2; n++) await asAdmin(() => server.handleSlashCommand(interaction('undo', {}).value));
    assert.equal(old.probes().length, 1, 'an older host is known for the connection too');
  });

  it('refuses without promising that a retry will help when its request fails', async () => {
    const refusal = new Error('host/command requires host-owned authority (McplServerConfig.allowHostCommands)');
    for (const fails of [refusal, new Error('request timed out')]) {
      const h = host({ marksVerb: { fails } });
      const { server } = serverWith(h.conn);
      const cases: Array<[string, Record<string, string>, RegExp]> = [
        ['undo', {}, /^⚠️ Undo not sent: couldn't learn whether this host makes awareness marks a choice/],
        ['hide', { message: '111111111111111111', marks: 'all' }, /^⚠️ Hide not sent: couldn't learn whether/],
        ['hide', { message: '111111111111111111', marks: 'addressed' }, /^⚠️ Hide not sent: couldn't learn whether/],
        ['marks', { action: 'list' }, /^Couldn't learn whether this host has awareness-mark controls/],
        ['marks', { action: 'retract', target: 'all' }, /^Couldn't learn whether this host has awareness-mark controls/],
      ];
      for (const [name, options, refused] of cases) {
        const i = interaction(name, options);
        await asAdmin(() => server.handleSlashCommand(i.value));
        const reply = i.out.replies.at(-1)!;
        assert.match(reply, refused, `${name} ${JSON.stringify(options)}`);
        assert.ok(reply.includes(fails.message), reply);
        assert.doesNotMatch(reply, /try again/i, reply);
      }
      assert.equal(h.commands().length, 0, `${fails.message}: nothing sent`);
    }
  });

  it('is not asked by a /hide with no marks chosen, which sends the plain hide to any host', async () => {
    for (const marksVerb of ['yes', 'no', { fails: new Error('request timed out') }] as const) {
      for (const marks of [undefined, 'none']) {
        const h = host({ marksVerb, answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 1, hiddenRefs: [{ channelId: 'c1', messageId: 'm1' }] } : { ok: true }) });
        const { server, reactions } = serverWith(h.conn);
        const i = interaction('hide', { message: '111111111111111111', marks });
        await asAdmin(() => server.handleSlashCommand(i.value));
        const what = `${JSON.stringify(marksVerb)}, marks=${marks}`;
        assert.equal(h.probes().length, 0, `${what}: no probe`);
        assert.equal(h.commands().length, 1, what);
        assert.equal('marks' in h.commands()[0]!, false, `${what}: no marks field`);
        assert.deepEqual(reactions, [], what);
        assert.match(i.out.replies.at(-1)!, /^🙈 Removed \*\*1\*\* message from the agent's context \(redacted in place\)\.\nMarks: none\.$/, what);
      }
    }
  });

  it('is shared by commands that arrive while it is out', async () => {
    const h = gatedHost();
    const { server } = serverWith(h.conn);
    const a = interaction('undo', {});
    const b = interaction('undo', {});
    const both = asAdmin(() => Promise.all([server.handleSlashCommand(a.value), server.handleSlashCommand(b.value)]));
    await settle();
    assert.equal(h.probes.length, 1, 'one probe for both commands');
    h.probes[0]!.resolve(VERB_ANSWER);
    await both;
    assert.equal(h.probes.length, 1);
    assert.equal(h.undos(), 2);
    for (const i of [a, b]) assert.match(i.out.replies.at(-1)!, /Removed the last \*\*1\*\*/);
  });

  it('forgets an unproven answer once it settles, so the next command asks again', async () => {
    const h = gatedHost();
    const { server } = serverWith(h.conn);
    const a = interaction('undo', {});
    const b = interaction('undo', {});
    const both = asAdmin(() => Promise.all([server.handleSlashCommand(a.value), server.handleSlashCommand(b.value)]));
    await settle();
    assert.equal(h.probes.length, 1);
    h.probes[0]!.reject(new Error('request timed out'));
    await both;
    for (const i of [a, b]) assert.match(i.out.replies.at(-1)!, /Undo not sent: couldn't learn .*request timed out/);
    assert.equal(h.undos(), 0);

    const c = interaction('undo', {});
    const third = asAdmin(() => server.handleSlashCommand(c.value));
    await settle();
    assert.equal(h.probes.length, 2, 'asked again');
    h.probes[1]!.resolve(VERB_ANSWER);
    await third;
    assert.match(c.out.replies.at(-1)!, /Removed the last \*\*1\*\*/);
  });

  it("probes a replaced connection afresh, and the old probe's late answer leaves the new one's kept", async () => {
    const old = gatedHost();
    const fresh = gatedHost();
    const { server } = serverWith(old.conn);
    const a = interaction('undo', {});
    const first = asAdmin(() => server.handleSlashCommand(a.value));
    await settle();
    server.conn = fresh.conn; // the host reconnected while the old probe was out
    const b = interaction('undo', {});
    const second = asAdmin(() => server.handleSlashCommand(b.value));
    await settle();
    assert.equal(fresh.probes.length, 1, 'the new connection is probed');
    fresh.probes[0]!.resolve(VERB_ANSWER);
    await second;
    // The old connection's host answers last, and definitely: it's an older one.
    old.probes[0]!.resolve(NO_VERB_ANSWER);
    await first;
    assert.match(a.out.replies.at(-1)!, /Undo refused: this host can't make awareness marks a choice/);

    const c = interaction('undo', {});
    const third = asAdmin(() => server.handleSlashCommand(c.value));
    await settle();
    assert.equal(fresh.probes.length, 1, "the new connection's answer is still kept");
    await third;
    assert.equal(fresh.undos(), 2);
    assert.equal(old.undos(), 0);
  });
});

describe('replies stay within one message, and never misreport an applied surgery', () => {
  it('bounds a refusal carrying a long error, from a failed probe or from the host', async () => {
    const longError = 'e'.repeat(2300);
    const commands: Array<[string, Record<string, string>]> = [
      ['marks', { action: 'list' }],
      ['undo', {}],
      ['hide', { message: '111111111111111111', marks: 'all' }],
    ];
    const failedProbe = { sendRequest: async () => { throw new Error(longError); } };
    const refusing = { sendRequest: async (_m: string, p: Sent) => (isProbe(p) ? VERB_ANSWER : { ok: false, error: longError }) };
    for (const [conn, refused] of [[failedProbe, /couldn't learn whether/i], [refusing, /failed: e/]] as const) {
      const { server } = serverWith(conn);
      for (const [name, options] of commands) {
        const i = interaction(name, options);
        await asAdmin(() => server.handleSlashCommand(i.value));
        const reply = i.out.replies.at(-1)!;
        assert.ok(reply.length <= REPLY_LIMIT, `${name}: ${reply.length}`);
        assert.match(reply, refused, name);
        assert.match(reply, /cut to fit one message/, name);
      }
    }
  });

  it('shows a long successful undo receipt bounded, with the result attached', async () => {
    const markers = { scope: 'all', unmarked: 0, notRemoved: 0, status: 'unresolved', queued: 0, batchId: 'b-1', error: 'j'.repeat(500) + ' / ' + 'k'.repeat(500) };
    const preview = Array.from({ length: 8 }, (_, n) => `line ${n} ${'p'.repeat(40)}`).join('\n');
    const h = host({ marksVerb: 'yes', answer: (p) => (p.command === 'undo' ? { ok: true, messagesRemoved: 3, markers, lastVisible: { participant: 'Lena', preview: preview + 'q'.repeat(600) } } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('undo', { messages: 3, marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    const reply = i.out.replies.at(-1)!;
    assert.ok(reply.length <= REPLY_LIMIT, `${reply.length}`);
    assert.match(reply, /^🗑️ Removed the last \*\*3\*\*/);
    assert.doesNotMatch(reply, /Undo failed/);
    assert.equal(JSON.parse(i.out.files.at(-1)![0]!.attachment.toString('utf8')).markers.error, markers.error);
  });

  it('says an applied undo or hide happened when Discord refuses its reply, marks included', async () => {
    const h = host({ marksVerb: 'yes', answer: (p) => (p.command === 'undo'
      ? { ok: true, messagesRemoved: 2, markers: { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }, lastVisible: null }
      : p.command === 'hide' ? { ok: true, hidden: 1, hiddenRefs: [], markers: { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 } } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const u = interaction('undo', { messages: 2 }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(u.value));
    assert.equal(u.out.replies.at(-1), "🗑️ Undo applied: removed 2 context messages. Marks: none. (The full reply couldn't be shown: Unknown interaction.)");
    const hd = interaction('hide', { message: '111111111111111111' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(hd.value));
    assert.equal(hd.out.replies.at(-1), "🙈 Hide applied: removed 1 message from the agent's context. Marks: none. (The full reply couldn't be shown: Unknown interaction.)");
  });

  it("names an applied surgery's marks in its short account: the batch, or this server's own reactions", async () => {
    const receipts: Array<[unknown, string]> = [
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 3, batchId: 'b-7' }, 'Marks: 3 💤 marks requested (batch `b-7`).'],
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'unresolved', queued: 0, batchId: 'b-8', error: 'disk' }, 'Marks: unresolved (batch `b-8`); check `/marks list`.'],
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'not-scheduled', queued: 0, error: 'journal full' }, 'Marks: not scheduled.'],
      [{ scope: 'all', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 }, 'Marks: none placed.'],
      [{ scope: 'all', status: 'deferred' }, "Marks: the host's receipt couldn't be read; `/marks list` shows the journal."],
      [undefined, 'Marks: the host reported nothing about them.'],
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 1, batchId: 'b'.repeat(300) }, `Marks: 1 💤 mark requested (batch \`${'b'.repeat(99)}…\`).`],
    ];
    for (const [markers, short] of receipts) {
      const h = host({ marksVerb: 'yes', answer: undoAnswer(markers) });
      const { server } = serverWith(h.conn);
      const i = interaction('undo', { messages: 2, marks: 'all' }, { rejectEdits: 1 });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.equal(i.out.replies.at(-1), `🗑️ Undo applied: removed 2 context messages. ${short} (The full reply couldn't be shown: Unknown interaction.)`, JSON.stringify(markers));
    }
    const older = host({ marksVerb: 'no', answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: [{ channelId: 'c1', messageId: 'm1' }, { channelId: 'c1', messageId: 'm2' }] } : { ok: true }) });
    const { server } = serverWith(older.conn);
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(i.out.replies.at(-1), "🙈 Hide applied: removed 2 messages from the agent's context. Marks: this server reacted 💤 itself on 2 of 2; these have no cancel. (The full reply couldn't be shown: Unknown interaction.)");
  });

  it('logs what the command did to stderr when Discord refuses both replies', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const h = host({ marksVerb: 'yes', answer: undoAnswer({ scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 3, batchId: 'b-7' }) });
    const { server } = serverWith(h.conn);
    const i = interaction('undo', { messages: 2, marks: 'all' }, { rejectEdits: 2 });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.deepEqual(i.out.replies, []);
    const lines = logged.mock.calls.map((c) => c.arguments.join(' '));
    assert.deepEqual(lines, [
      "[discord-mcpl] /undo: Discord refused its reply twice (Unknown interaction), so the operator wasn't told: " +
        '🗑️ Undo applied: removed 2 context messages. Marks: 3 💤 marks requested (batch `b-7`).',
    ]);
  });

  it('calls a surgery whose request failed in transit unknown, not failed, pointing at the journal when marks were chosen', async () => {
    const failing = (marksVerb: 'yes' | 'no') => ({
      sendRequest: async (_m: string, p: Sent) => {
        if (isProbe(p)) return marksVerb === 'yes' ? VERB_ANSWER : NO_VERB_ANSWER;
        throw new Error('request timed out');
      },
    });
    const journal = ', and `/marks list` for a 💤 batch it may have scheduled,';
    const cases: Array<['yes' | 'no', string, Record<string, string>, boolean]> = [
      ['yes', 'undo', {}, false],
      ['yes', 'undo', { marks: 'none' }, false],
      ['yes', 'undo', { marks: 'addressed' }, true],
      ['yes', 'hide', { message: '111111111111111111', marks: 'all' }, true],
      ['yes', 'hide', { message: '111111111111111111' }, false],
      // An older host was sent no choice, so it can have scheduled no batch.
      ['no', 'hide', { message: '111111111111111111', marks: 'all' }, false],
    ];
    for (const [marksVerb, name, options, pointer] of cases) {
      const command = name === 'undo' ? 'Undo' : 'Hide';
      const check = `Check the agent's context${pointer ? journal : ''} before trying again.`;
      const { server } = serverWith(failing(marksVerb));
      const i = interaction(name, options);
      await asAdmin(() => server.handleSlashCommand(i.value));
      const what = `${marksVerb} ${name} ${JSON.stringify(options)}`;
      assert.equal(i.out.replies.at(-1), `⚠️ ${command} outcome unknown (request timed out): the host may or may not have applied it. ${check}`, what);
      const refused = interaction(name, options, { rejectEdits: 1 });
      await asAdmin(() => server.handleSlashCommand(refused.value));
      assert.equal(refused.out.replies.at(-1), `⚠️ ${command} outcome unknown: the host may or may not have applied it. ${check} (The full reply couldn't be shown: Unknown interaction.)`, what);
    }
  });

  it('still answers when the host request rejects with something that is not an Error', async () => {
    for (const thrown of [undefined, null, 'down']) {
      const conn = { sendRequest: async (_m: string, p: Sent) => { if (isProbe(p)) return VERB_ANSWER; throw thrown; } };
      const { server } = serverWith(conn);
      const cases: Array<[string, Record<string, string>, RegExp]> = [
        ['undo', {}, /^⚠️ Undo outcome unknown \(/],
        ['hide', { message: '111111111111111111' }, /^⚠️ Hide outcome unknown \(/],
        ['marks', { action: 'retract', target: 'b-1' }, /^⚠️ \/marks retract outcome unknown \(/],
        ['marks', { action: 'list' }, /^⚠️ \/marks list failed: /],
      ];
      for (const [name, options, answered] of cases) {
        const i = interaction(name, options);
        await asAdmin(() => server.handleSlashCommand(i.value));
        assert.match(i.out.replies.at(-1) ?? '(no reply)', answered, `${String(thrown)}: ${name}`);
        assert.ok(i.out.replies.at(-1)!.includes(String(thrown)), `${String(thrown)}: ${name}`);
      }
    }
    const probeThrows = { sendRequest: async () => { throw undefined; } };
    const { server } = serverWith(probeThrows);
    const i = interaction('undo', {});
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(i.out.replies.at(-1), "⚠️ Undo not sent: couldn't learn whether this host makes awareness marks a choice (undefined). Nothing was changed.");
  });

  it('keeps an unknown outcome and its check-before-retry when Discord also refuses the reply', async () => {
    const conn = {
      sendRequest: async (_m: string, p: Sent) => {
        if (isProbe(p)) return VERB_ANSWER;
        throw new Error('request timed out');
      },
    };
    const { server } = serverWith(conn);
    const refused = " (The full reply couldn't be shown: Unknown interaction.)";
    const cases: Array<[string, Record<string, string>, string]> = [
      ['undo', {}, "⚠️ Undo outcome unknown: the host may or may not have applied it. Check the agent's context before trying again."],
      ['hide', { message: '111111111111111111' }, "⚠️ Hide outcome unknown: the host may or may not have applied it. Check the agent's context before trying again."],
      ['marks', { action: 'retract', target: 'b-1' }, '⚠️ /marks retract outcome unknown: the host may already have queued the removals. Check `/marks list target:b-1` before trying again.'],
      ['marks', { action: 'cancel', target: 'r-1' }, '⚠️ /marks cancel outcome unknown: the host may already have cancelled it. Check `/marks list target:r-1` before trying again.'],
    ];
    for (const [name, options, outcome] of cases) {
      const i = interaction(name, options, { rejectEdits: 1 });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.deepEqual(i.out.replies, [outcome + refused], name);
    }
  });
});

describe('an answer only `ok: false` makes a failure', () => {
  it('shows an /undo, /hide or control answer without a boolean ok as sent, warning that it may have been applied', async () => {
    for (const odd of [{ messagesRemoved: 2, hidden: 2, awareness: { requestId: 'r-1' } }, { ok: 'yes' }, null, 'done']) {
      const h = host({ marksVerb: 'yes', answer: () => odd });
      const { server } = serverWith(h.conn);
      const cases: Array<[string, Record<string, string>, string]> = [
        ['undo', { marks: 'all' }, "Check the agent's context, and `/marks list` for a 💤 batch it may have scheduled, before trying again."],
        ['hide', { message: '111111111111111111' }, "Check the agent's context before trying again."],
        ['marks', { action: 'retract', target: 'b-1' }, 'Check `/marks list target:b-1` before trying again.'],
      ];
      for (const [name, options, check] of cases) {
        const shown = name === 'marks' ? '/marks retract' : `/${name}`;
        const i = interaction(name, options);
        await asAdmin(() => server.handleSlashCommand(i.value));
        assert.equal(
          i.out.replies.at(-1),
          `⚠️ The host answered ${shown} in a shape this server can't read, so it may have been applied; here it is as sent:\n\`\`\`json\n${JSON.stringify(odd)}\n\`\`\`\n${check}`,
          `${JSON.stringify(odd)}: ${name}`,
        );
      }
      const list = interaction('marks', { action: 'list' });
      await asAdmin(() => server.handleSlashCommand(list.value));
      assert.equal(list.out.replies.at(-1), `The host answered /marks list in a shape this server can't read; here it is as sent:\n\`\`\`json\n${JSON.stringify(odd)}\n\`\`\``);
    }
  });

  it('reports a count the host gives as anything but a number as not given, never as zero', async () => {
    for (const count of [undefined, '2', null, -1]) {
      const h = host({
        marksVerb: 'yes',
        answer: (p) => p.command === 'undo'
          ? { ok: true, messagesRemoved: count, markers: { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }, lastVisible: null }
          : { ok: true, hidden: count, markers: { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 } },
      });
      const { server } = serverWith(h.conn);
      const u = interaction('undo', {});
      await asAdmin(() => server.handleSlashCommand(u.value));
      assert.match(u.out.replies.at(-1)!, /^🗑️ Undo applied \(branched; old branch preserved\); the number of context messages removed was not given\.\n/, String(count));
      const hd = interaction('hide', { message: '111111111111111111' });
      await asAdmin(() => server.handleSlashCommand(hd.value));
      assert.match(hd.out.replies.at(-1)!, /^🙈 Hide applied \(redacted in place\); the number of messages removed from the agent's context was not given\.\n/, String(count));
      for (const [name, options, short] of [
        ['undo', {}, '🗑️ Undo applied: the number of context messages removed was not given. Marks: none.'],
        ['hide', { message: '111111111111111111' }, '🙈 Hide applied: the number of messages removed was not given. Marks: none.'],
      ] as const) {
        const i = interaction(name, options, { rejectEdits: 1 });
        await asAdmin(() => server.handleSlashCommand(i.value));
        assert.equal(i.out.replies.at(-1), `${short} (The full reply couldn't be shown: Unknown interaction.)`, `${String(count)}: ${name}`);
        assert.doesNotMatch(i.out.replies.at(-1)!, /removed 0/);
      }
    }
  });

  it('still replies to an applied undo or hide whose fields it cannot read', async () => {
    const verbHost = (answer: Sent) => host({ marksVerb: 'yes', answer: () => answer });
    const oldHost = (answer: Sent) => host({ marksVerb: 'no', answer: () => answer });
    const cases: Array<[string, ReturnType<typeof host>, Record<string, string>, RegExp]> = [
      ['a preview that is not text', verbHost({ ok: true, messagesRemoved: 1, markers: null, lastVisible: { participant: 'Lena', preview: 42 } }),
        { name: 'undo' }, /\nLast message now visible to the agent — \*\*Lena\*\*: \*\(a preview this server can't read\)\*$/],
      ['a speaker that is not text', verbHost({ ok: true, messagesRemoved: 1, markers: null, lastVisible: { participant: { id: 1 }, role: 7, preview: 'hi' } }),
        { name: 'undo' }, /\nLast message now visible to the agent — \*\*\?\*\*:\n> hi$/],
      ['hidden refs that are not a list', oldHost({ ok: true, hidden: 2, hiddenRefs: { m1: 'c1' } }),
        { name: 'hide', marks: 'all' }, /\nMarks: this host doesn't place them, and it gave no list of hidden messages this server can read, so this server placed none\.$/],
      ['a null ref beside a good one', oldHost({ ok: true, hidden: 2, hiddenRefs: [null, { channelId: 'c1', messageId: 'm2' }] }),
        { name: 'hide', marks: 'all' }, /\nMarks: this host doesn't place them, so this server reacted 💤 itself on 1 of 2 \(the first failure: the host's reference to a hidden message couldn't be read\)\.$/],
    ];
    for (const [what, h, { name, ...options }, expected] of cases) {
      const { server, reactions } = serverWith(h.conn);
      const i = interaction(name!, name === 'hide' ? { message: '111111111111111111', ...options } : options);
      await asAdmin(() => server.handleSlashCommand(i.value));
      const reply = i.out.replies.at(-1) ?? '(no reply)';
      assert.match(reply, name === 'undo' ? /^🗑️ Removed the last \*\*1\*\*/ : /^🙈 Removed \*\*2\*\*/, what);
      assert.match(reply, expected, what);
      if (what === 'a null ref beside a good one') assert.deepEqual(reactions.map((r) => r.messageId), ['m2']);
    }
  });
});

describe('/hide and the marks choice', () => {
  const hidden = [{ channelId: 'discord:g1:c1', messageId: 'm1' }, { channelId: 'c1', messageId: 'm2' }];

  it('on a host with the verb, passes the choice and never reacts itself', async () => {
    const h = host({
      marksVerb: 'yes',
      answer: (p) => p.command === 'hide'
        ? { ok: true, hidden: 2, hiddenRefs: hidden, markers: { scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 2, batchId: 'b-9' } }
        : { ok: true },
    });
    const { server, reactions } = serverWith(h.conn);
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0].marks, 'all');
    assert.deepEqual(reactions, []);
    assert.match(i.out.replies.at(-1)!, /2 💤 marks requested \(all; batch `b-9`\)/);
  });

  it('on a host with the verb that omits its receipt, reports marks unreported and never supplements them', async () => {
    const h = host({ marksVerb: 'yes', answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: hidden } : { ok: true }) });
    const { server, reactions } = serverWith(h.conn);
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.deepEqual(reactions, []);
    assert.match(i.out.replies.at(-1)!, /Marks: this host reported nothing about 💤 marks\./);
  });

  it('on an older host, reacts itself only for `all`, refuses `addressed`, and marks nothing otherwise', async () => {
    const answer = (p: Sent) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: hidden } : { ok: true });

    const all = host({ marksVerb: 'no', answer });
    const a = serverWith(all.conn);
    const ia = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => a.server.handleSlashCommand(ia.value));
    assert.equal('marks' in all.commands()[0], false, 'an older host is not sent a choice it cannot read');
    assert.deepEqual(a.reactions.map((r) => [r.channelId, r.messageId, r.emoji]), [['c1', 'm1', '💤'], ['c1', 'm2', '💤']]);
    assert.match(ia.out.replies.at(-1)!, /reacted 💤 itself on 2 of 2/);

    const addressed = host({ marksVerb: 'no', answer });
    const b = serverWith(addressed.conn);
    const ib = interaction('hide', { message: '111111111111111111', marks: 'addressed' });
    await asAdmin(() => b.server.handleSlashCommand(ib.value));
    assert.equal(addressed.commands().length, 0, 'nothing hidden');
    assert.match(ib.out.replies.at(-1)!, /`marks: addressed` isn't available here/);

    const none = host({ marksVerb: 'no', answer });
    const c = serverWith(none.conn);
    const ic = interaction('hide', { message: '111111111111111111' });
    await asAdmin(() => c.server.handleSlashCommand(ic.value));
    assert.deepEqual(c.reactions, []);
    assert.match(ic.out.replies.at(-1)!, /\nMarks: none\.$/);
  });

  it('on a host with the verb, sends no marks field when none is chosen', async () => {
    const h = host({ marksVerb: 'yes', answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: hidden, markers: { scope: 'none', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 } } : { ok: true }) });
    const { server, reactions } = serverWith(h.conn);
    const i = interaction('hide', { message: '111111111111111111' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands().length, 1);
    assert.equal('marks' in h.commands()[0]!, false);
    assert.deepEqual(reactions, []);
    assert.match(i.out.replies.at(-1)!, /\nMarks: none\.$/);
  });

  it("on an older host, still replies when a reaction fails, with the count and the first failure's reason", async () => {
    const h = host({ marksVerb: 'no', answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: hidden } : { ok: true }) });
    const { server, reactions } = serverWith(h.conn, { failReaction: (id) => (id === 'm1' ? new Error('Missing Permissions') : undefined) });
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.deepEqual(reactions.map((r) => r.messageId), ['m2']);
    assert.match(
      i.out.replies.at(-1)!,
      /\nMarks: this host doesn't place them, so this server reacted 💤 itself on 1 of 2 \(the first failure: Missing Permissions\)\.$/,
    );
  });

  it('on an older host, reacts itself only when the host sent no receipt at all, and shows any it did send', async () => {
    const hiding = (markers: unknown) => host({
      marksVerb: 'no',
      answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 2, hiddenRefs: hidden, markers } : { ok: true }),
    });
    for (const markers of [false, 0, '', {}, 'queued']) {
      const { server, reactions } = serverWith(hiding(markers).conn);
      const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
      await asAdmin(() => server.handleSlashCommand(i.value));
      const what = JSON.stringify(markers);
      assert.deepEqual(reactions, [], `${what}: never supplemented`);
      const reply = i.out.replies.at(-1)!;
      assert.match(reply, /\nMarks: the host's receipt is in a shape this server can't read; here it is as sent:\n```json\n/, what);
      assert.ok(reply.includes(`\n${what}\n`), what);
    }
    for (const markers of [undefined, null]) {
      const { server, reactions } = serverWith(hiding(markers).conn);
      const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.equal(reactions.length, 2, String(markers));
      assert.match(i.out.replies.at(-1)!, /reacted 💤 itself on 2 of 2/, String(markers));
    }
  });
});

// Shapes as agent-framework#250 (dc2928c, unchanged at 763c932b) produces them:
// DiscordAwarenessBatchView / RetractView, and each action's receipt.
const batch = (n: number, extra: Partial<Record<string, unknown>> = {}): AwarenessView => ({
  kind: 'batch',
  id: `batch-${String(n).padStart(4, '0')}-1f2e3d4c-5b6a-4789-9abc-def012345678`,
  status: 'active',
  scope: 'all',
  agentName: 'lena',
  sourceBranch: 'main',
  targetBranch: `undo-msgs/lena/${1760000000000 + n}`,
  emoji: '💤',
  createdAt: 1760000000000 + n * 1000,
  refs: 3,
  adds: { requested: 1, dispatching: 0, confirmed: 2, failed: 0, unknown: 0, cancelled: 0 },
  removals: { requested: 0, dispatching: 0, confirmed: 0, failed: 0, unknown: 0, cancelled: 0 },
  unresolvedAttempts: 0,
  ...extra,
} as AwarenessView);
const retractView = (at: number): AwarenessView => ({
  kind: 'retract',
  id: 'retract-9f8e7d6c-5b4a-4321-8fed-cba987654321',
  target: 'all',
  at,
  by: 'Admin',
  removals: { requested: 2, dispatching: 0, confirmed: 4, failed: 0, unknown: 1, cancelled: 0 },
  unresolvedAttempts: 1,
});

describe('/marks', () => {
  const listing = (views: AwarenessView[]) => (p: Sent) => (p.action === 'list' ? { ok: true, awareness: views } : { ok: true });

  it('lists the journal newest first, ephemerally, keeping imported evidence', async () => {
    const views = [
      batch(1, { legacy: { entries: 2, lastAddConfirmed: 1, lastRemoveConfirmed: 0, outcomesUnrecorded: 3 } }),
      batch(2, { status: 'held', held: { reason: 'branch switched while prepared', at: 1760000005000, releaseActions: 2 } }),
      retractView(1760000009000),
    ];
    const h = host({ marksVerb: 'yes', answer: listing(views) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'list' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.ok(i.out.deferred && (i.out.deferred as { flags?: unknown }).flags !== undefined, 'deferred ephemerally');
    const reply = i.out.replies.at(-1)!;
    const lines = reply.split('\n');
    assert.match(lines[0]!, /page 1 of 1, 3 entries, newest first/);
    assert.match(lines[1]!, /retract `retract-9f8e.*` → all: removals requested 2, confirmed 4, unknown 1; 1 unresolved/);
    assert.match(lines[2]!, /batch `batch-0002.*` — held, all, 3 messages \(lena\): adds requested 1, confirmed 2; removals none; held: branch switched/);
    assert.match(lines[3]!, /batch `batch-0001.*imported history \(3 unrecorded outcomes\)/);
    assert.ok(reply.length <= REPLY_LIMIT);
  });

  it('pages a long journal within one reply each, every entry reachable', async () => {
    const reason = 'x'.repeat(600);
    const views = [
      ...Array.from({ length: 13 }, (_, n) => batch(n + 1, { status: 'held', held: { reason, at: 1, releaseActions: 1 } })),
      retractView(1),
    ];
    const pages = paginate(views);
    assert.ok(pages.length > 1);
    const shown = new Set<string>();
    for (let p = 1; p <= pages.length; p++) {
      const page = renderListPage(views, p);
      assert.ok(page.length <= REPLY_LIMIT, `page ${p}: ${page.length} chars`);
      for (const v of views) if (page.includes(`\`${v.id}\``)) shown.add(v.id);
      assert.match(page, p < pages.length ? /`\/marks list page:\d+` for the next page/ : /for the first page/);
    }
    assert.equal(shown.size, views.length, 'every batch and the retract appear on some page');
    assert.match(renderListPage(views, 1), /batch-0013/, 'the newest batch leads');
    assert.match(renderListPage(views, pages.length + 1), /there is no page/);

    const h = host({ marksVerb: 'yes', answer: listing(views) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'list', page: 2 });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.match(i.out.replies.at(-1)!, /page 2 of/);
    assert.equal('target' in h.commands()[0]!, false, 'the host lists everything; paging is here');
  });

  it('shows one entry in full by id, cutting a long one visibly with the record attached', async () => {
    const long = batch(5, {
      status: 'held',
      held: { reason: 'r'.repeat(2500), at: 1760000005000, releaseActions: 2 },
      legacy: { entries: 1, lastAddConfirmed: 1, lastRemoveConfirmed: 0, outcomesUnrecorded: 2 },
    });
    const views = [batch(4), long];
    const h = host({ marksVerb: 'yes', answer: listing(views) });
    const { server } = serverWith(h.conn);

    const short = interaction('marks', { action: 'list', target: views[0]!.id });
    await asAdmin(() => server.handleSlashCommand(short.value));
    assert.match(short.out.replies.at(-1)!, /\*\*Batch `batch-0004.*`\*\* — active; all for lena; 3 messages/);
    assert.equal(short.out.files.length, 0);

    const i = interaction('marks', { action: 'list', target: long.id });
    await asAdmin(() => server.handleSlashCommand(i.value));
    const reply = i.out.replies.at(-1)!;
    assert.ok(reply.length <= REPLY_LIMIT, `${reply.length} chars`);
    assert.match(reply, /cut to fit one message; the whole answer is attached as JSON/);
    const attached = JSON.parse(i.out.files.at(-1)![0]!.attachment.toString('utf8'));
    assert.equal(attached[0].held.reason.length, 2500);
    assert.deepEqual(attached[0].legacy, { entries: 1, lastAddConfirmed: 1, lastRemoveConfirmed: 0, outcomesUnrecorded: 2 });

    const missing = interaction('marks', { action: 'list', target: 'nope' });
    await asAdmin(() => server.handleSlashCommand(missing.value));
    assert.match(missing.out.replies.at(-1)!, /No batch or retract `nope` in the journal/);
  });

  it("renders cancel's receipt, keeping what cancel can't undo", async () => {
    const receipt = { target: 'batch-1', kind: 'batch', cancelled: 2, heldDropped: 1, inFlight: 1, unknown: 1, confirmed: 3, unresolvedAttempts: 2, legacyOutcomesUnrecorded: 1 };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: receipt } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'cancel', target: 'batch-1' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0]!.target, 'batch-1');
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /Cancelled batch `batch-1`: 2 requests will now never be sent, and 1 held release action dropped\./);
    assert.match(reply, /Cancel removes nothing from Discord: 3 already confirmed on Discord stay as they are; 1 on the wire may still land; 1 with unknown outcome may have landed; 2 unresolved attempts in all; 1 imported attempt with unrecorded outcomes may have landed\./);
    assert.match(reply, /`\/marks retract target:batch-1`/);
  });

  it("renders retract's and release's receipts as requested, not confirmed", async () => {
    const retract = { requestId: 'r-1', removalsQueued: 4, addsSuperseded: 1, keysWithUnresolvedAdds: 2, unresolvedAddAttempts: 3, keysWithLegacyUncertainty: 1 };
    const release = { batchId: 'b-1', addsQueued: 2, removalsQueued: 0 };
    const h = host({
      marksVerb: 'yes',
      answer: (p) => (p.action === 'retract' ? { ok: true, awareness: retract } : p.action === 'release' ? { ok: true, awareness: release } : { ok: true }),
    });
    const { server } = serverWith(h.conn);

    const missing = interaction('marks', { action: 'retract' });
    await asAdmin(() => server.handleSlashCommand(missing.value));
    assert.match(missing.out.replies.at(-1)!, /needs a target: a batch id, or `all`/);
    assert.equal(h.commands().length, 0);

    const r = interaction('marks', { action: 'retract', target: 'all' });
    await asAdmin(() => server.handleSlashCommand(r.value));
    assert.deepEqual(
      { command: h.commands()[0]!.command, action: h.commands()[0]!.action, target: h.commands()[0]!.target },
      { command: 'marks', action: 'retract', target: 'all' },
    );
    const rr = r.out.replies.at(-1)!;
    assert.match(rr, /Retract `r-1`: 4 💤 removals requested — not yet confirmed on Discord; 1 unsent add superseded\./);
    assert.match(rr, /2 messages have earlier add attempts still unresolved \(3 attempts\): such an add may land after its removal\./);
    assert.match(rr, /1 message has imported history with unrecorded outcomes\./);

    const l = interaction('marks', { action: 'release', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(l.value));
    assert.match(l.out.replies.at(-1)!, /Released held batch `b-1`: 2 adds and 0 removals requested — not yet confirmed on Discord\./);
  });

  it('shows a shape it cannot read as sent, bounded, never misread', async () => {
    const odd = { batchId: 'b-1', something: 'new'.repeat(900) };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: odd } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'cancel', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /answered \/marks cancel in a shape this server can't read/);
    assert.ok(reply.length <= REPLY_LIMIT);
    assert.deepEqual(JSON.parse(i.out.files.at(-1)![0]!.attachment.toString('utf8')), odd);
  });

  it('shows a journal with an entry it cannot read as sent, listed or opened', async () => {
    // A hold with no reason: rendering it would have thrown, and the
    // fire-and-forget command with it.
    const partial = batch(2, { status: 'held', held: {} });
    const h = host({ marksVerb: 'yes', answer: listing([batch(1), partial]) });
    const { server } = serverWith(h.conn);
    for (const options of [{ action: 'list' }, { action: 'list', target: partial.id }]) {
      const i = interaction('marks', options);
      await asAdmin(() => server.handleSlashCommand(i.value));
      const reply = i.out.replies.at(-1)!;
      assert.match(reply, /^The host answered the journal in a shape this server can't read; here it is as sent:\n```json\n/, JSON.stringify(options));
      assert.match(reply, /"held":\{\}/);
    }
  });

  it('calls a control whose request failed in transit unknown, pointing at the journal', async () => {
    const conn = {
      sendRequest: async (_m: string, p: Sent) => {
        if (!p.requesterId) return { ok: true, awareness: [] };
        throw new Error('connection lost');
      },
    };
    const { server } = serverWith(conn);
    const r = interaction('marks', { action: 'retract', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(r.value));
    assert.match(r.out.replies.at(-1)!, /^⚠️ \/marks retract outcome unknown \(connection lost\): the host may already have queued the removals\. Check `\/marks list target:b-1` before trying again\.$/);
    const all = interaction('marks', { action: 'retract', target: 'all' });
    await asAdmin(() => server.handleSlashCommand(all.value));
    assert.match(all.out.replies.at(-1)!, /Check `\/marks list` before trying again/);
    const list = interaction('marks', { action: 'list' });
    await asAdmin(() => server.handleSlashCommand(list.value));
    assert.match(list.out.replies.at(-1)!, /^⚠️ \/marks list failed: connection lost$/);
  });

  it('keeps what an accepted control requested when its reply is refused', async () => {
    const retract = { requestId: 'r-1', removalsQueued: 4, addsSuperseded: 0, keysWithUnresolvedAdds: 0, unresolvedAddAttempts: 0, keysWithLegacyUncertainty: 0 };
    const cancel = { target: 'b-2', kind: 'batch', cancelled: 3, heldDropped: 0, inFlight: 0, unknown: 0, confirmed: 1, unresolvedAttempts: 0, legacyOutcomesUnrecorded: 0 };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'retract' ? { ok: true, awareness: retract } : p.action === 'cancel' ? { ok: true, awareness: cancel } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const r = interaction('marks', { action: 'retract', target: 'b-1' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(r.value));
    assert.match(r.out.replies.at(-1)!, /^✅ Retract `r-1`: 4 removals requested, not yet confirmed on Discord\. \(The full reply couldn't be shown/);
    const c = interaction('marks', { action: 'cancel', target: 'b-2' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(c.value));
    assert.match(c.out.replies.at(-1)!, /^✅ Cancelled batch `b-2`: 3 requests will never be sent; cancel removes nothing from Discord\. \(The full reply/);
  });

  it("keeps a cancel's limits in its short account: what may still land, or may have landed", async () => {
    const cancel = { target: 'b-3', kind: 'batch', cancelled: 2, heldDropped: 0, inFlight: 1, unknown: 2, confirmed: 1, unresolvedAttempts: 3, legacyOutcomesUnrecorded: 1 };
    const h = host({ marksVerb: 'yes', answer: () => ({ ok: true, awareness: cancel }) });
    const { server } = serverWith(h.conn);
    const c = interaction('marks', { action: 'cancel', target: 'b-3' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(c.value));
    assert.equal(
      c.out.replies.at(-1),
      '✅ Cancelled batch `b-3`: 2 requests will never be sent; cancel removes nothing from Discord: 1 on the wire may still land; ' +
        "2 with unknown outcome may have landed; 1 imported attempt with unrecorded outcomes may have landed. (The full reply couldn't be shown: Unknown interaction.)",
    );
  });

  it("reports the host's refusal with its code, and explains an older host", async () => {
    const busy = host({ marksVerb: 'yes', answer: () => ({ ok: false, error: 'an agent sharing the store is mid-turn', code: 'agent-busy' }) });
    const a = serverWith(busy.conn);
    const ia = interaction('marks', { action: 'release', target: 'b-1' });
    await asAdmin(() => a.server.handleSlashCommand(ia.value));
    assert.match(ia.out.replies.at(-1)!, /\/marks release failed \(agent-busy\): an agent sharing the store is mid-turn/);

    const old = host({ marksVerb: 'no' });
    const b = serverWith(old.conn);
    const ib = interaction('marks', { action: 'list' });
    await asAdmin(() => b.server.handleSlashCommand(ib.value));
    assert.match(ib.out.replies.at(-1)!, /doesn't have awareness-mark controls/);
  });
});

describe('rendering', () => {
  it('describes every receipt status without claiming delivery', () => {
    assert.match(describeMarkers(undefined), /reported nothing/);
    assert.equal(describeMarkers({ scope: 'none', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 }), 'Marks: none.');
    assert.match(describeMarkers({ scope: 'addressed', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }), /nothing removed fell within "addressed"/);
    assert.equal(
      describeMarkers({ scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 2, batchId: 'b-1' }),
      'Marks: 2 💤 marks requested (all; batch `b-1`) — not yet confirmed on Discord; `/marks list` shows progress.',
    );
    assert.match(describeMarkers({ scope: 'all', unmarked: 0, notRemoved: 2, status: 'not-scheduled', queued: 0, error: 'journal full' }), /not scheduled — journal full\. None will be placed\. \(2 chosen messages not removed, so not marked\)/);
    assert.match(describeMarkers({ scope: 'all', unmarked: 0, notRemoved: 0, status: 'unresolved', queued: 0, batchId: 'b-2', error: 'disk' }), /may still be delivered later/);
  });

  it("reads imported history's confirmations as the counts they are, and says what may have landed only when some outcome is unrecorded", () => {
    const legacy = (outcomesUnrecorded: number) => detailText(batch(1, { legacy: { entries: 3, lastAddConfirmed: 2, lastRemoveConfirmed: 1, outcomesUnrecorded } }));
    assert.match(legacy(4), /\nImported history: 3 entries, of which 2 last had an add confirmed and 1 a removal confirmed; 4 attempts with unrecorded outcomes — any may have landed\.$/);
    assert.match(legacy(0), /\nImported history: 3 entries, of which 2 last had an add confirmed and 1 a removal confirmed\.$/);
  });

  it('cuts between code points, never through an emoji', () => {
    assert.equal(clip('ab💤cd', 4), 'ab…');
    assert.equal(clip('💤💤', 3), '💤…');
    const text = '💤 asleep '.repeat(30);
    for (let max = 1; max < text.length; max++) {
      const cut = clip(text, max);
      assert.ok(cut.length <= max, `max ${max}`);
      assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `max ${max}: half a pair`);
    }
  });

  it('answers a page below 1 as no page, as it does one past the end', () => {
    const views = [batch(1), batch(2)];
    for (const page of [0, -1]) assert.match(renderListPage(views, page), new RegExp(`there is no page ${page}\\.$`));
  });

  it('shows a markers receipt it cannot describe as sent, never as something else or nothing', () => {
    assert.match(describeMarkers(null), /reported nothing/);
    const receipts: Array<[string, unknown]> = [
      ['a status this server does not know', { scope: 'all', unmarked: 0, notRemoved: 0, status: 'deferred', queued: 0 }],
      ['queued with no batch', { scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 2 }],
      ['queued with no count', { scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', batchId: 'b-1' }],
      ['not scheduled with no reason', { scope: 'all', unmarked: 0, notRemoved: 0, status: 'not-scheduled', queued: 0 }],
      ['unresolved with no batch', { scope: 'all', unmarked: 0, notRemoved: 0, status: 'unresolved', queued: 0, error: 'disk' }],
      ['a scope that is no marks choice', { scope: 'everyone', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }],
      ['a count that is not a number', { scope: 'all', unmarked: '1', notRemoved: 0, status: 'none', queued: 0 }],
      ['no record at all', 'queued'],
      ['false', false],
      ['zero', 0],
      ['empty text', ''],
    ];
    for (const [what, receipt] of receipts) {
      const text = describeMarkers(receipt);
      assert.match(text, /^Marks: the host's receipt is in a shape this server can't read; here it is as sent:\n```json\n/, what);
      assert.ok(text.includes(JSON.stringify(receipt)), what);
    }
  });

  it("reads a journal entry only when every field it shows has the type it's read as", () => {
    assert.ok(isView(batch(1)));
    assert.ok(isView(retractView(1)));
    // Shown as the host names them: a later host's batch state, AF's legacy
    // scope, an operation status this server doesn't know.
    const later = batch(1, { status: 'staged', scope: 'legacy', adds: { requested: 1, superseded: 2 } });
    assert.ok(isView(later));
    assert.match(renderListPage([later], 1), /— staged, legacy, 3 messages \(lena\): adds requested 1, superseded 2;/);
    const entries: Array<[string, unknown]> = [
      ['an empty hold', batch(1, { held: {} })],
      ['a hold whose reason is not text', batch(1, { held: { reason: 7, at: 1, releaseActions: 1 } })],
      ['a hold with no release-action count', batch(1, { held: { reason: 'r', at: 1 } })],
      ['imported history missing its counts', batch(1, { legacy: { entries: 1 } })],
      ['a count that is not a number', batch(1, { adds: { requested: '3' } })],
      ['removals that are not counts', batch(1, { removals: [] })],
      ['a cancellation with no time', batch(1, { cancelled: { by: 'Admin' } })],
      ['a release by someone not named in text', batch(1, { released: { at: 1, by: { id: 'u1' } } })],
      ['no creation time', batch(1, { createdAt: undefined })],
      ['no agent', batch(1, { agentName: undefined })],
      ['branches that are not text', batch(1, { sourceBranch: 3 })],
      ['an unmarked count that is not a number', batch(1, { unmarked: 'two' })],
      ['no unresolved-attempt count', batch(1, { unresolvedAttempts: undefined })],
      ['a retract with no time', { ...retractView(1), at: 'yesterday' }],
      ['a retract by someone not named in text', { ...retractView(1), by: 7 }],
      ['a retract with no target', { ...retractView(1), target: undefined }],
      ['an entry of another kind', { ...retractView(1), kind: 'release' }],
    ];
    for (const [what, entry] of entries) assert.equal(isView(entry), false, what);
  });

  it('fits a long reply into one message, cut visibly with the whole text attached', () => {
    assert.equal(boundedReply('short'), 'short');
    const long = boundedReply('y'.repeat(5000));
    assert.ok(typeof long !== 'string');
    assert.ok(long.content.length <= REPLY_LIMIT);
    assert.match(long.content, /cut to fit one message; the whole reply is attached\)$/);
    assert.equal(long.files[0]!.attachment.toString('utf8').length, 5000);
  });
});

describe('registration', () => {
  it('offers the marks choice on /undo and /hide, and registers /marks', async () => {
    let registered: Array<{ name: string; options?: Array<{ name: string; choices?: Array<{ value: string }> }> }> = [];
    const discord = {
      onSlashCommand: () => undefined,
      registerGuildCommands: async (commands: typeof registered) => { registered = commands; },
    };
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    await server.setupSlashCommands();
    for (const name of ['undo', 'hide']) {
      const marks = registered.find((c) => c.name === name)?.options?.find((o) => o.name === 'marks');
      assert.deepEqual(marks?.choices?.map((c) => c.value), ['none', 'addressed', 'all'], name);
    }
    const marksCommand = registered.find((c) => c.name === 'marks');
    assert.deepEqual(marksCommand?.options?.find((o) => o.name === 'action')?.choices?.map((c) => c.value), ['list', 'cancel', 'retract', 'release']);
    assert.ok(marksCommand?.options?.some((o) => o.name === 'target'));
    assert.ok(marksCommand?.options?.some((o) => o.name === 'page'));
  });
});
