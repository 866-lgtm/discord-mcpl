/**
 * The admin slash commands and the host's 💤 awareness marks
 * (agent-framework#250's `marks` host command).
 *
 * - /undo takes an optional `marks` choice (none, addressed, all), passed to
 *   a host that has the `marks` verb, which places the marks and returns a
 *   `markers` receipt. A host without the verb places branch-following marks
 *   on undo that no option can make a one-shot act, so /undo is refused there.
 * - /hide takes an optional choice of none or all. Its 💤 is this server's
 *   own, added to the hidden messages when all is chosen, outside the host's
 *   awareness ledger, on any host.
 * - /marks lists the ledger and cancels or retracts.
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
  describeRetract,
  detailText,
  isView,
  paginate,
  renderListPage,
  REPLY_LIMIT,
  summaryLine,
  type AwarenessView,
} from '../src/awareness-marks.js';

type Sent = Record<string, unknown>;

/** The probe: a `marks` request naming no action. */
const isProbe = (p: Sent): boolean => p.command === 'marks' && p.action === undefined;

/** How agent-framework#250 answers the probe, and how every older framework
 *  with host/command answers a verb it lacks. */
const VERB_ANSWER = { ok: false, error: 'marks needs action list, cancel or retract' };
const NO_VERB_ANSWER = { ok: false, error: 'Unknown host command: marks' };
/** What a refusal after a failed probe ends with, at /undo and /marks. */
const PROBE_AGAIN = 'Running it again can work after a timeout, or once the host is back if it was restarting. ' +
  'If the host refuses host commands, whoever runs it has to allow them for this server (`allowHostCommands`).';

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

/** A server over `conn`, recording the reactions it places itself, which only
 *  a /hide with marks chosen does. `refuse` names messages whose reaction
 *  Discord refuses; `hold` keeps every reaction waiting until its gate opens,
 *  calling `onCall` as each one starts. */
function serverWith(conn: unknown, refuse: string[] = [], hold?: { gate: Promise<void>; onCall: () => void }) {
  const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  const discord = {
    addReaction: async (channelId: string, messageId: string, emoji: string) => {
      if (hold) {
        hold.onCall();
        await hold.gate;
      }
      if (refuse.includes(messageId)) throw new Error('Unknown Message');
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
 *  `rejectEdits` refuses that many edits first, standing for any refusal of
 *  a full reply; `acceptEdits` accepts that many and refuses every one after,
 *  as Discord does once an interaction has expired. */
function interaction(
  commandName: string,
  options: Record<string, string | number | undefined>,
  opts: { rejectEdits?: number; acceptEdits?: number } = {},
) {
  let toReject = opts.rejectEdits ?? 0;
  let toAccept = opts.acceptEdits ?? Infinity;
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
        if (toReject > 0 || toAccept <= 0 || content.length > REPLY_LIMIT) {
          if (toReject > 0) toReject--;
          throw new Error(content.length > REPLY_LIMIT ? 'Invalid Form Body: content too long' : 'Unknown interaction');
        }
        toAccept--;
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
    assert.match(first.out.replies.at(-1)!, /^⚠️ Undo not sent: couldn't learn .*\(request timed out\)\. Nothing was changed\. /);
    assert.ok(first.out.replies.at(-1)!.endsWith(` ${PROBE_AGAIN}`));
    const second = interaction('undo', {});
    await asAdmin(() => server.handleSlashCommand(second.value));
    assert.equal(h.probes().length, 2, 'an unproven answer is not kept');
    assert.equal(h.commands().length, 0);
  });

  it('sends no marks when none are chosen, and probes for each command', async () => {
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
    assert.equal(h.probes().length, 2, 'one probe per command');
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

  it('reads any answer but "Unknown host command" as the verb, and asks for each command', async () => {
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
      assert.equal(conn.sent.filter(isProbe).length, 2, `${JSON.stringify(answer)}: asked for each command`);
    }
    const old = host({ marksVerb: 'no' });
    const { server } = serverWith(old.conn);
    for (let n = 0; n < 2; n++) await asAdmin(() => server.handleSlashCommand(interaction('undo', {}).value));
    assert.equal(old.probes().length, 2, 'an older host is asked for each command too');
  });

  it('refuses when its request fails, saying when running it again can work and what a host refusing host commands needs', async () => {
    const refusal = new Error('host/command requires host-owned authority (McplServerConfig.allowHostCommands)');
    for (const fails of [refusal, new Error('request timed out')]) {
      const h = host({ marksVerb: { fails } });
      const { server } = serverWith(h.conn);
      const cases: Array<[string, Record<string, string>, RegExp]> = [
        ['undo', {}, /^⚠️ Undo not sent: couldn't learn whether this host makes awareness marks a choice/],
        ['marks', { action: 'list' }, /^Couldn't learn whether this host has awareness-mark controls/],
        ['marks', { action: 'retract', target: 'all' }, /^Couldn't learn whether this host has awareness-mark controls/],
      ];
      for (const [name, options, refused] of cases) {
        const i = interaction(name, options);
        await asAdmin(() => server.handleSlashCommand(i.value));
        const reply = i.out.replies.at(-1)!;
        assert.match(reply, refused, `${name} ${JSON.stringify(options)}`);
        assert.ok(reply.includes(fails.message), reply);
        assert.ok(reply.endsWith(` ${PROBE_AGAIN}`), reply);
      }
      assert.equal(h.commands().length, 0, `${fails.message}: nothing sent`);
    }
  });

  it('is never asked by /hide, which sends the plain hide to any host, whatever the choice', async () => {
    for (const marksVerb of ['yes', 'no', { fails: new Error('request timed out') }] as const) {
      for (const marks of [undefined, 'none', 'all']) {
        const h = host({ marksVerb, answer: (p) => (p.command === 'hide' ? { ok: true, hidden: 1, hiddenRefs: [{ channelId: 'c1', messageId: 'm1' }] } : { ok: true }) });
        const { server } = serverWith(h.conn);
        const i = interaction('hide', { message: '111111111111111111', marks });
        await asAdmin(() => server.handleSlashCommand(i.value));
        const what = `${JSON.stringify(marksVerb)}, marks=${marks}`;
        assert.equal(h.probes().length, 0, `${what}: no probe`);
        assert.equal(h.commands().length, 1, what);
        assert.equal('marks' in h.commands()[0]!, false, `${what}: no marks field`);
        assert.match(i.out.replies.at(-1)!, /^🙈 Removed \*\*1\*\* message from the agent's context \(redacted in place\)\./, what);
      }
    }
  });

  it('is asked by each command, two that arrive together included', async () => {
    const h = gatedHost();
    const { server } = serverWith(h.conn);
    const a = interaction('undo', {});
    const b = interaction('undo', {});
    const both = asAdmin(() => Promise.all([server.handleSlashCommand(a.value), server.handleSlashCommand(b.value)]));
    await settle();
    assert.equal(h.probes.length, 2, 'a probe for each command');
    for (const probe of h.probes) probe.resolve(VERB_ANSWER);
    await both;
    assert.equal(h.undos(), 2);
    for (const i of [a, b]) assert.match(i.out.replies.at(-1)!, /Removed the last \*\*1\*\*/);
  });
});

describe('replies stay within one message, and never misreport an applied surgery', () => {
  it('bounds a refusal carrying a long error, from a failed probe or from the host', async () => {
    const longError = 'e'.repeat(2300);
    const probed: Array<[string, Record<string, string>]> = [['marks', { action: 'list' }], ['undo', {}]];
    const failedProbe = { sendRequest: async () => { throw new Error(longError); } };
    const refusing = { sendRequest: async (_m: string, p: Sent) => (isProbe(p) ? VERB_ANSWER : { ok: false, error: longError }) };
    // /hide asks no probe, so only the host's own refusal reaches it.
    const cases = [
      [failedProbe, /couldn't learn whether/i, probed],
      [refusing, /failed: e/, [...probed, ['hide', { message: '111111111111111111', marks: 'all' }]]],
    ] as const;
    for (const [conn, refused, commands] of cases) {
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
    const markers = { scope: 'all', unmarked: 0, notRemoved: 0, status: 'not-scheduled', queued: 0, error: 'j'.repeat(500) + ' / ' + 'k'.repeat(500) };
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
      : p.command === 'hide' ? { ok: true, hidden: 1, hiddenRefs: [] } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const u = interaction('undo', { messages: 2 }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(u.value));
    assert.equal(u.out.replies.at(-1), "🗑️ Undo applied: removed 2 context messages. Marks: none. (The full reply couldn't be shown: Unknown interaction.)");
    const hd = interaction('hide', { message: '111111111111111111' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(hd.value));
    assert.equal(hd.out.replies.at(-1), "🙈 Hide applied: removed 1 message from the agent's context. (The full reply couldn't be shown: Unknown interaction.)");
    const marked = interaction('hide', { message: '111111111111111111', marks: 'all' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(marked.value));
    assert.equal(marked.out.replies.at(-1), "🙈 Hide applied: removed 1 message from the agent's context. " +
      "Marks: the host named no hidden messages, so none was marked with 💤. (The full reply couldn't be shown: Unknown interaction.)");
  });

  it("names an applied undo's marks in its short account: the batch it scheduled", async () => {
    const receipts: Array<[unknown, string]> = [
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 3, batchId: 'b-7' }, 'Marks: 3 💤 marks requested (batch `b-7`).'],
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'not-scheduled', queued: 0, error: 'ledger full' }, 'Marks: not scheduled — ledger full.'],
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'not-scheduled', queued: 0, error: 'e'.repeat(300) }, `Marks: not scheduled — ${'e'.repeat(99)}….`],
      [{ scope: 'all', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 }, 'Marks: none placed.'],
      [{ scope: 'all', status: 'deferred' }, "Marks: the host's receipt couldn't be read; `/marks action:list` shows the ledger."],
      [undefined, 'Marks: the host reported nothing about them; `/marks action:list` shows whether it scheduled any.'],
      [{ scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 1, batchId: 'b'.repeat(300) }, `Marks: 1 💤 mark requested (batch \`${'b'.repeat(99)}…\`).`],
    ];
    for (const [markers, short] of receipts) {
      const h = host({ marksVerb: 'yes', answer: undoAnswer(markers) });
      const { server } = serverWith(h.conn);
      const i = interaction('undo', { messages: 2, marks: 'all' }, { rejectEdits: 1 });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.equal(i.out.replies.at(-1), `🗑️ Undo applied: removed 2 context messages. ${short} (The full reply couldn't be shown: Unknown interaction.)`, JSON.stringify(markers));
    }
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

  it("calls a surgery whose request failed in transit unknown, not failed, pointing at the ledger when an undo's marks were chosen", async () => {
    const failing = (marksVerb: 'yes' | 'no') => ({
      sendRequest: async (_m: string, p: Sent) => {
        if (isProbe(p)) return marksVerb === 'yes' ? VERB_ANSWER : NO_VERB_ANSWER;
        throw new Error('request timed out');
      },
    });
    const ledger = ', and `/marks action:list` for a 💤 batch it may have scheduled,';
    const notAdded = "Marks: no 💤 was added, since this server adds them only once it has read the host's answer.";
    // [marksVerb, command, options, the ledger pointer, the line that no 💤 was added]
    const cases: Array<['yes' | 'no', string, Record<string, string>, boolean, boolean]> = [
      ['yes', 'undo', {}, false, false],
      ['yes', 'undo', { marks: 'none' }, false, false],
      ['yes', 'undo', { marks: 'addressed' }, true, false],
      // A hide's marks are this server's own, added only after the host's answer, so no batch.
      ['yes', 'hide', { message: '111111111111111111', marks: 'all' }, false, true],
      ['no', 'hide', { message: '111111111111111111', marks: 'all' }, false, true],
      ['yes', 'hide', { message: '111111111111111111' }, false, false],
      ['no', 'hide', { message: '111111111111111111', marks: 'none' }, false, false],
    ];
    for (const [marksVerb, name, options, pointer, marked] of cases) {
      const command = name === 'undo' ? 'Undo' : 'Hide';
      const check = `Check the agent's context${pointer ? ledger : ''} before trying again.`;
      const { server } = serverWith(failing(marksVerb));
      const i = interaction(name, options);
      await asAdmin(() => server.handleSlashCommand(i.value));
      const what = `${marksVerb} ${name} ${JSON.stringify(options)}`;
      assert.equal(i.out.replies.at(-1), `⚠️ ${command} outcome unknown (request timed out): the host may or may not have applied it. ${check}` +
        (marked ? `\n${notAdded}` : ''), what);
      const refused = interaction(name, options, { rejectEdits: 1 });
      await asAdmin(() => server.handleSlashCommand(refused.value));
      assert.equal(refused.out.replies.at(-1), `⚠️ ${command} outcome unknown: the host may or may not have applied it. ${check}` +
        `${marked ? ` ${notAdded}` : ''} (The full reply couldn't be shown: Unknown interaction.)`, what);
    }
  });

  it('still answers when the host request rejects with something that is not an Error', async () => {
    for (const thrown of [undefined, null, 'down']) {
      const conn = { sendRequest: async (_m: string, p: Sent) => { if (isProbe(p)) return VERB_ANSWER; throw thrown; } };
      const { server } = serverWith(conn);
      const cases: Array<[string, Record<string, string>, RegExp]> = [
        ['undo', {}, /^⚠️ Undo outcome unknown \(/],
        ['hide', { message: '111111111111111111' }, /^⚠️ Hide outcome unknown \(/],
        ['marks', { action: 'retract', target: 'b-1' }, /^⚠️ \/marks action:retract outcome unknown \(/],
        ['marks', { action: 'list' }, /^⚠️ \/marks action:list failed: /],
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
    assert.equal(i.out.replies.at(-1), `⚠️ Undo not sent: couldn't learn whether this host makes awareness marks a choice (undefined). Nothing was changed. ${PROBE_AGAIN}`);
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
      ['marks', { action: 'retract', target: 'b-1' }, '⚠️ /marks action:retract outcome unknown: the host may already have queued the removals. Check `/marks action:list` before trying again: a retract it queued is listed first.'],
      ['marks', { action: 'cancel', target: 'r-1' }, '⚠️ /marks action:cancel outcome unknown: the host may already have cancelled it. Check `/marks action:list target:r-1` before trying again.'],
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
        ['undo', { marks: 'all' }, "Check the agent's context, and `/marks action:list` for a 💤 batch it may have scheduled, before trying again."],
        ['hide', { message: '111111111111111111' }, "Check the agent's context before trying again."],
        ['hide', { message: '111111111111111111', marks: 'all' }, "Check the agent's context before trying again.\nMarks: no 💤 was added, since this server adds them only once it has read the host's answer."],
        ['marks', { action: 'retract', target: 'b-1' }, 'Check `/marks action:list` before trying again: a retract it queued is listed first.'],
        ['marks', { action: 'cancel', target: 'b-1' }, 'Check `/marks action:list target:b-1` before trying again.'],
      ];
      for (const [name, options, check] of cases) {
        const shown = name === 'marks' ? `/marks action:${options.action}` : `/${name}`;
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
      assert.equal(list.out.replies.at(-1), `The host answered /marks action:list in a shape this server can't read; here it is as sent:\n\`\`\`json\n${JSON.stringify(odd)}\n\`\`\``);
    }
  });

  it('reports a count the host gives as anything but a number as not given, never as zero', async () => {
    for (const count of [undefined, '2', null, -1]) {
      const h = host({
        marksVerb: 'yes',
        answer: (p) => p.command === 'undo'
          ? { ok: true, messagesRemoved: count, markers: { scope: 'none', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }, lastVisible: null }
          : { ok: true, hidden: count },
      });
      const { server } = serverWith(h.conn);
      const u = interaction('undo', {});
      await asAdmin(() => server.handleSlashCommand(u.value));
      assert.match(u.out.replies.at(-1)!, /^🗑️ Undo applied \(branched; old branch preserved\); the number of context messages removed was not given\.\n/, String(count));
      const hd = interaction('hide', { message: '111111111111111111' });
      await asAdmin(() => server.handleSlashCommand(hd.value));
      assert.match(hd.out.replies.at(-1)!, /^🙈 Hide applied \(redacted in place\); the number of messages removed from the agent's context was not given\.$/, String(count));
      for (const [name, options, short] of [
        ['undo', {}, '🗑️ Undo applied: the number of context messages removed was not given. Marks: none.'],
        ['hide', { message: '111111111111111111' }, '🙈 Hide applied: the number of messages removed was not given.'],
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
    const cases: Array<[string, ReturnType<typeof host>, Record<string, string>, RegExp]> = [
      ['a preview that is not text', verbHost({ ok: true, messagesRemoved: 1, markers: null, lastVisible: { participant: 'Lena', preview: 42 } }),
        { name: 'undo' }, /\nLast message now visible to the agent — \*\*Lena\*\*: \*\(a preview this server can't read\)\*$/],
      ['a speaker that is not text', verbHost({ ok: true, messagesRemoved: 1, markers: null, lastVisible: { participant: { id: 1 }, role: 7, preview: 'hi' } }),
        { name: 'undo' }, /\nLast message now visible to the agent — \*\*\?\*\*:\n> hi$/],
      ['a hide whose preview is not text', verbHost({ ok: true, hidden: 2, markers: null, lastVisible: { participant: 'Lena', preview: [] } }),
        { name: 'hide' }, /\nLast message now visible to the agent — \*\*Lena\*\*: \*\(a preview this server can't read\)\*$/],
    ];
    for (const [what, h, { name, ...options }, expected] of cases) {
      const { server } = serverWith(h.conn);
      const i = interaction(name!, name === 'hide' ? { message: '111111111111111111', ...options } : options);
      await asAdmin(() => server.handleSlashCommand(i.value));
      const reply = i.out.replies.at(-1) ?? '(no reply)';
      assert.match(reply, name === 'undo' ? /^🗑️ Removed the last \*\*1\*\*/ : /^🙈 Removed \*\*2\*\*/, what);
      assert.match(reply, expected, what);
    }
  });
});

describe('/hide and its 💤', () => {
  const hidden = [{ channelId: 'discord:g1:c1', messageId: 'm1' }, { channelId: 'c1', messageId: 'm2' }];
  const hiding = (answer: Sent, marksVerb: 'yes' | 'no' = 'yes') => host({ marksVerb, answer: (p) => (p.command === 'hide' ? answer : { ok: true }) });
  const own = "They're this server's own, outside the host's awareness ledger: `/marks` doesn't list them, " +
    'and a retract reaches one only where a batch marked the same message.';
  const removed = (n: number) => `🙈 Removed **${n}** message${n === 1 ? '' : 's'} from the agent's context (redacted in place).`;

  it("adds 💤 itself to each hidden message when all is chosen, on any host, and says where /marks reaches them", async () => {
    for (const marksVerb of ['yes', 'no'] as const) {
      const h = hiding({ ok: true, hidden: 2, hiddenRefs: hidden }, marksVerb);
      const { server, reactions } = serverWith(h.conn);
      const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.equal('marks' in h.commands()[0]!, false, marksVerb);
      // The composite channel id is read as its channel.
      assert.deepEqual(reactions, [{ channelId: 'c1', messageId: 'm1', emoji: '💤' }, { channelId: 'c1', messageId: 'm2', emoji: '💤' }], marksVerb);
      assert.deepEqual(i.out.replies, [
        `${removed(2)}\nMarks: adding 💤 to 2 hidden messages…`,
        `${removed(2)}\nMarks: Discord confirmed 💤 on 2 of 2 hidden messages. ${own}`,
      ], marksVerb);
    }
  });

  it('replies as soon as the hide is applied, before any 💤 settles, then edits in what Discord confirmed', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let started!: () => void;
    const first = new Promise<void>((resolve) => { started = resolve; });
    const h = hiding({ ok: true, hidden: 2, hiddenRefs: hidden });
    const { server, reactions } = serverWith(h.conn, [], { gate, onCall: () => started() });
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
    const done = asAdmin(() => server.handleSlashCommand(i.value));
    await first;
    assert.deepEqual(i.out.replies, [`${removed(2)}\nMarks: adding 💤 to 2 hidden messages…`]);
    assert.deepEqual(reactions, []);
    open();
    await done;
    assert.equal(i.out.replies.at(-1), `${removed(2)}\nMarks: Discord confirmed 💤 on 2 of 2 hidden messages. ${own}`);
  });

  it('keeps what Discord confirmed on stderr when the edit that would show it is refused', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const h = hiding({ ok: true, hidden: 2, hiddenRefs: hidden });
    const { server } = serverWith(h.conn);
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' }, { acceptEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.deepEqual(i.out.replies, [`${removed(2)}\nMarks: adding 💤 to 2 hidden messages…`]);
    assert.deepEqual(logged.mock.calls.map((c) => c.arguments.join(' ')), [
      "[discord-mcpl] /hide: Discord refused its reply twice (Unknown interaction), so the operator wasn't told: " +
        `🙈 Hide applied: removed 2 messages from the agent's context. Marks: Discord confirmed 💤 on 2 of 2 hidden messages. ${own}`,
    ]);
  });

  it('places no 💤 and says nothing of marks when none is chosen or the option is left out', async () => {
    for (const marks of [undefined, 'none']) {
      const h = hiding({ ok: true, hidden: 2, hiddenRefs: hidden });
      const { server, reactions } = serverWith(h.conn);
      const i = interaction('hide', { message: '111111111111111111', marks });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.deepEqual(reactions, [], String(marks));
      assert.deepEqual(i.out.replies, [removed(2)], String(marks));
    }
  });

  it("counts only what Discord confirmed, naming the first error, since a failed request may still have landed", async () => {
    const h = hiding({ ok: true, hidden: 2, hiddenRefs: hidden });
    const { server, reactions } = serverWith(h.conn, ['m2']);
    const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.deepEqual(reactions.map((r) => r.messageId), ['m1']);
    assert.equal(i.out.replies.at(-1), `${removed(2)}\nMarks: Discord confirmed 💤 on 1 of 2 hidden messages. ` +
      `The rest weren't confirmed (first error: Unknown Message). ${own}`);
  });

  it('says none was marked when the host named no hidden messages', async () => {
    for (const hiddenRefs of [undefined, null, []]) {
      const h = hiding({ ok: true, hidden: 1, hiddenRefs });
      const { server, reactions } = serverWith(h.conn);
      const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.deepEqual(reactions, [], JSON.stringify(hiddenRefs));
      assert.deepEqual(i.out.replies, [`${removed(1)}\nMarks: the host named no hidden messages, so none was marked with 💤.`], JSON.stringify(hiddenRefs));
    }
  });

  it("marks nothing from a list of hidden messages it can't read whole: one that isn't a list, or any entry that isn't a message", async () => {
    const lists: unknown[] = [
      'm1',
      { channelId: 'c1', messageId: 'm1' },
      [...hidden, { channelId: 'c1' }],
      [...hidden, { channelId: 7, messageId: 'm3' }],
      [...hidden, { channelId: 'c1', messageId: 3 }],
      [...hidden, null],
      [...hidden, 'm3'],
    ];
    for (const hiddenRefs of lists) {
      const h = hiding({ ok: true, hidden: 3, hiddenRefs });
      const { server, reactions } = serverWith(h.conn);
      const i = interaction('hide', { message: '111111111111111111', marks: 'all' });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.deepEqual(reactions, [], JSON.stringify(hiddenRefs));
      assert.deepEqual(i.out.replies, [`${removed(3)}\nMarks: the host's list of hidden messages couldn't be read, so none was marked with 💤.`],
        JSON.stringify(hiddenRefs));
    }
  });

  it("marks nothing when the host refuses the hide, even one naming messages, or answers in a shape it can't read", async () => {
    const refused = hiding({ ok: false, error: 'no such message', hiddenRefs: hidden } as Sent);
    const a = serverWith(refused.conn);
    const ia = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => a.server.handleSlashCommand(ia.value));
    assert.deepEqual(a.reactions, []);
    assert.deepEqual(ia.out.replies, ['⚠️ Hide failed: no such message']);
    const odd = hiding({ hidden: 2, hiddenRefs: hidden } as Sent);
    const b = serverWith(odd.conn);
    const ib = interaction('hide', { message: '111111111111111111', marks: 'all' });
    await asAdmin(() => b.server.handleSlashCommand(ib.value));
    assert.deepEqual(b.reactions, []);
  });
});

// Shapes as agent-framework#250's own outbox gives them as merged, run at e0f40cd9:
// DiscordAwarenessBatchView / RetractView, and each action's receipt.
const none = { queued: 0, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 };
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
  reactions: { ...none, queued: 1, present: 2 },
  mayStillLand: 0,
  ...extra,
} as AwarenessView);
const retractView = (at: number): AwarenessView => ({
  kind: 'retract',
  id: 'retract-9f8e7d6c-5b4a-4321-8fed-cba987654321',
  target: 'all',
  at,
  by: 'Admin',
  keys: 7,
  reactions: { ...none, queued: 2, absent: 4, unknown: 1 },
  mayStillLand: 1,
});

/** agent-framework#250's own answers as merged (e0f40cd9), run: a version 2 ledger shaped as in #250's own
 *  import test, rewritten at a start; a batch with one add confirmed, one on the wire and one still owed,
 *  cancelled; a batch with one add answered unknown, retracted, and that retract cancelled; the imported
 *  batch retracted; then a retract of all. */
const AF250 = {
  cancel: { target: 'b897e6cb-25af-4485-8f94-0c8e39d4f23a', kind: 'batch', cancelled: 1, confirmed: 1, mayStillLand: 1 },
  cancelRetract: { target: '4d103eee-13c6-4c81-a6fc-3306b0e2c794', kind: 'retract', cancelled: 2, confirmed: 0, mayStillLand: 1 },
  retract: { requestId: '4d103eee-13c6-4c81-a6fc-3306b0e2c794', removalsQueued: 2, addsSuperseded: 2, keysWithUnresolvedAdds: 1 },
  retractImported: { requestId: 'db51e704-4a98-440c-90eb-2b688d61c1e4', removalsQueued: 3, addsSuperseded: 0, keysWithUnresolvedAdds: 0 },
  view: [
    {
      kind: 'batch', id: 'dd34b043', status: 'active', scope: 'legacy', agentName: 'resident', sourceBranch: 'main',
      targetBranch: 'rollback/resident/1791358473307', emoji: '💤', createdAt: 1791358473400, refs: 3,
      reactions: { queued: 3, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 }, mayStillLand: 0,
      legacyAdded: 1,
    },
    {
      kind: 'batch', id: 'pending-batch', status: 'active', scope: 'legacy', agentName: 'resident', sourceBranch: 'main',
      targetBranch: 'rollback/resident/2', emoji: '💤', createdAt: 1791358473500, refs: 1,
      reactions: { queued: 1, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 }, mayStillLand: 0,
      legacyAdded: 0,
    },
    {
      kind: 'batch', id: 'b897e6cb-25af-4485-8f94-0c8e39d4f23a', status: 'active', scope: 'all', agentName: 'cairn',
      sourceBranch: 'main', targetBranch: 'rollback/cairn/1', emoji: '💤', createdAt: 1792482283146, refs: 3,
      cancelled: { at: 1792482283269, by: 'probe' },
      reactions: { queued: 3, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 }, mayStillLand: 1,
    },
    {
      kind: 'batch', id: 'b6066d07-997a-4bb3-84fe-240fd6cb4d13', status: 'active', scope: 'addressed', agentName: 'cairn',
      sourceBranch: 'main', targetBranch: 'rollback/cairn/2', emoji: '💤', createdAt: 1792482283286, refs: 2,
      reactions: { queued: 2, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 }, mayStillLand: 1,
    },
    {
      kind: 'retract', id: '4d103eee-13c6-4c81-a6fc-3306b0e2c794', target: 'b6066d07-997a-4bb3-84fe-240fd6cb4d13',
      at: 1792482283398, by: 'probe', cancelled: { at: 1792482283422, by: 'probe' }, keys: 2,
      reactions: { queued: 0, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 }, mayStillLand: 0,
    },
    {
      kind: 'retract', id: 'db51e704-4a98-440c-90eb-2b688d61c1e4', target: 'dd34b043', at: 1792482283445, by: 'probe', keys: 3,
      reactions: { queued: 3, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 }, mayStillLand: 0,
    },
    {
      kind: 'retract', id: '110ae4cf-fdb6-4526-b122-9dcd6a002e27', target: 'all', at: 1792482283479, by: 'probe', keys: 9,
      reactions: { queued: 9, sending: 0, present: 0, absent: 0, unknown: 0, failed: 0, untouched: 0 }, mayStillLand: 2,
    },
  ] as AwarenessView[],
};

describe('/marks', () => {
  const listing = (views: AwarenessView[]) => (p: Sent) => (p.action === 'list' ? { ok: true, awareness: views } : { ok: true });

  it('lists the ledger newest first, ephemerally, keeping what 0.22.x recorded of an imported batch', async () => {
    const views = [
      // An imported batch: scope legacy, its reactions never asked about, and
      // the marks 0.22.x recorded as added.
      batch(1, { scope: 'legacy', reactions: { ...none, untouched: 3 }, legacyAdded: 1 }),
      batch(2, { status: 'retired', cancelled: { at: 1760000006000, by: 'Admin' } }),
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
    assert.match(lines[1]!, /retract `retract-9f8e.*` → all: 7 removals; reactions queued 2, absent 4, unknown 1; 1 may still land$/);
    assert.match(lines[2]!, /batch `batch-0002.*` — retired, cancelled, all, 3 messages \(lena\): reactions queued 1, present 2$/);
    assert.match(lines[3]!, /batch `batch-0001.*` — active, legacy, 3 messages \(lena\): reactions untouched 3; 0\.22\.x recorded 1 mark as added$/);
    assert.ok(reply.length <= REPLY_LIMIT);
  });

  it('pages a long ledger within one reply each, every entry reachable', async () => {
    const agentName = 'x'.repeat(600);
    const views = [
      ...Array.from({ length: 13 }, (_, n) => batch(n + 1, { agentName })),
      retractView(1),
    ];
    const pages = paginate(views);
    assert.ok(pages.length > 1);
    const shown = new Set<string>();
    for (let p = 1; p <= pages.length; p++) {
      const page = renderListPage(views, p);
      assert.ok(page.length <= REPLY_LIMIT, `page ${p}: ${page.length} chars`);
      for (const v of views) if (page.includes(`\`${v.id}\``)) shown.add(v.id);
      assert.match(page, p < pages.length ? /`\/marks action:list page:\d+` for the next page/ : /for the first page/);
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
      agentName: 'r'.repeat(2500),
      legacyAdded: 2,
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
    assert.equal(attached[0].agentName.length, 2500);
    assert.equal(attached[0].legacyAdded, 2);

    const missing = interaction('marks', { action: 'list', target: 'nope' });
    await asAdmin(() => server.handleSlashCommand(missing.value));
    assert.match(missing.out.replies.at(-1)!, /No batch or retract `nope` in the ledger/);
  });

  it("renders cancel's receipt, keeping what cancel can't undo", async () => {
    const receipt = { target: 'batch-1', kind: 'batch', cancelled: 2, confirmed: 0, mayStillLand: 2 };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: receipt } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const missing = interaction('marks', { action: 'cancel' });
    await asAdmin(() => server.handleSlashCommand(missing.value));
    assert.equal(missing.out.replies.at(-1), '`/marks action:cancel` needs a target: a batch id or a retract request id.');
    assert.equal(h.commands().length, 0);
    const i = interaction('marks', { action: 'cancel', target: 'batch-1' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(h.commands()[0]!.target, 'batch-1');
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /Cancelled batch `batch-1`: 2 reactions will now never be requested\./);
    assert.match(reply, /\nCancel removes nothing from Discord: 2 reactions with a request on the wire or one never answered may land\.\n/);
    assert.match(reply, /\nIf any of its marks are on Discord, `\/marks action:retract target:batch-1` queues their removal\.$/);
  });

  it("points every batch cancel to retract, an imported batch's all-zero receipt included, and never a retract's cancel", async () => {
    // An imported batch owes nothing of its own, so its receipt can count
    // nothing, though marks 0.22.x placed may be on its messages.
    const imported = { target: 'dd34b043', kind: 'batch', cancelled: 0, confirmed: 0, mayStillLand: 0 };
    // A retract's cancel: retract takes a batch id or all, never a retract's.
    const retractCancel = { target: 'r-5', kind: 'retract', cancelled: 1, confirmed: 2, mayStillLand: 3 };
    const replyTo = async (receipt: { target: string }) => {
      const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: receipt } : { ok: true }) });
      const { server } = serverWith(h.conn);
      const i = interaction('marks', { action: 'cancel', target: receipt.target });
      await asAdmin(() => server.handleSlashCommand(i.value));
      return i.out.replies.at(-1)!;
    };
    assert.equal(
      await replyTo(imported),
      '✅ Cancelled batch `dd34b043`: nothing it asked for was still waiting to be sent.\nCancel removes nothing from Discord.\n' +
        'If any of its marks are on Discord, `/marks action:retract target:dd34b043` queues their removal.',
    );
    assert.equal(
      await replyTo(retractCancel),
      '✅ Cancelled retract `r-5`: 1 reaction will now never be requested.\n' +
        'Cancel removes nothing from Discord: 2 already confirmed on Discord stay as they are; 3 reactions with a request on the wire or one never ' +
        'answered may land.',
    );
  });

  it('says so when a cancel found nothing still waiting to be sent, keeping its heading', async () => {
    // Everything the batch asked for had already gone out.
    const receipt = { target: 'batch-2', kind: 'batch', cancelled: 0, confirmed: 3, mayStillLand: 0 };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: receipt } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'cancel', target: 'batch-2' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    assert.equal(
      i.out.replies.at(-1),
      '✅ Cancelled batch `batch-2`: nothing it asked for was still waiting to be sent.\n' +
        'Cancel removes nothing from Discord: 3 already confirmed on Discord stay as they are.\n' +
        'If any of its marks are on Discord, `/marks action:retract target:batch-2` queues their removal.',
    );
  });

  it("renders retract's receipt as requested, not confirmed", async () => {
    const retract = { requestId: 'r-1', removalsQueued: 4, addsSuperseded: 1, keysWithUnresolvedAdds: 2 };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'retract' ? { ok: true, awareness: retract } : { ok: true }) });
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
    assert.match(rr, /\n2 messages have an add on the wire or one never answered: such an add may land after its removal\.\n/);
  });

  it('shows a shape it cannot read as sent, bounded, never misread', async () => {
    const odd = { batchId: 'b-1', something: 'new'.repeat(900) };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'cancel' ? { ok: true, awareness: odd } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const i = interaction('marks', { action: 'cancel', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(i.value));
    const reply = i.out.replies.at(-1)!;
    assert.match(reply, /answered \/marks action:cancel in a shape this server can't read/);
    assert.ok(reply.length <= REPLY_LIMIT);
    assert.deepEqual(JSON.parse(i.out.files.at(-1)![0]!.attachment.toString('utf8')), odd);
  });

  it('shows a cancel or retract receipt missing a count it reads as sent, never reading the count as zero', async () => {
    const cases: Array<['cancel' | 'retract', Record<string, unknown>, string[]]> = [
      ['cancel', AF250.cancel, ['cancelled', 'confirmed', 'mayStillLand']],
      ['retract', AF250.retract, ['removalsQueued', 'addsSuperseded', 'keysWithUnresolvedAdds']],
    ];
    for (const [action, whole, counts] of cases) {
      for (const left of counts) {
        const receipt = Object.fromEntries(Object.entries(whole).filter(([k]) => k !== left));
        const h = host({ marksVerb: 'yes', answer: (p) => (p.action === action ? { ok: true, awareness: receipt } : { ok: true }) });
        const { server } = serverWith(h.conn);
        const i = interaction('marks', { action, target: 'b-1' });
        await asAdmin(() => server.handleSlashCommand(i.value));
        assert.match(i.out.replies.at(-1)!, new RegExp(`answered /marks action:${action} in a shape this server can't read`), `${action} without ${left}`);
      }
    }
  });

  it("reads agent-framework#250's own answers as merged (e0f40cd9): cancels, retracts and the ledger, imported batches included", async () => {
    const replyTo = async (opts: Record<string, string | number | undefined>) => {
      const h = host({
        marksVerb: 'yes',
        answer: (p) => ({
          ok: true,
          awareness: p.action === 'list' ? AF250.view
            : p.action === 'cancel' ? (p.target === AF250.cancel.target ? AF250.cancel : AF250.cancelRetract)
              : p.target === 'dd34b043' ? AF250.retractImported : AF250.retract,
        }),
      });
      const { server } = serverWith(h.conn);
      const i = interaction('marks', opts);
      await asAdmin(() => server.handleSlashCommand(i.value));
      return i.out.replies.at(-1)!;
    };
    const a = AF250.cancel.target;
    assert.equal(
      await replyTo({ action: 'cancel', target: a }),
      `✅ Cancelled batch \`${a}\`: 1 reaction will now never be requested.\n` +
        'Cancel removes nothing from Discord: 1 already confirmed on Discord stays as it is; 1 reaction with a request on the wire or one ' +
        `never answered may land.\nIf any of its marks are on Discord, \`/marks action:retract target:${a}\` queues their removal.`,
    );
    const r = AF250.retract.requestId;
    assert.equal(
      await replyTo({ action: 'cancel', target: r }),
      `✅ Cancelled retract \`${r}\`: 2 reactions will now never be requested.\n` +
        'Cancel removes nothing from Discord: 1 reaction with a request on the wire or one never answered may land.',
    );
    assert.equal(
      await replyTo({ action: 'retract', target: AF250.view[3]!.id }),
      `✅ Retract \`${r}\`: 2 💤 removals requested — not yet confirmed on Discord; 2 unsent adds superseded.\n` +
        '1 message has an add on the wire or one never answered: such an add may land after its removal.\n' +
        `\`/marks action:list target:${r}\` shows progress; \`/marks action:cancel target:${r}\` stops what hasn't been sent.`,
    );
    const ri = AF250.retractImported.requestId;
    assert.equal(
      await replyTo({ action: 'retract', target: 'dd34b043' }),
      `✅ Retract \`${ri}\`: 3 💤 removals requested — not yet confirmed on Discord.\n` +
        `\`/marks action:list target:${ri}\` shows progress; \`/marks action:cancel target:${ri}\` stops what hasn't been sent.`,
    );
    const list = await replyTo({ action: 'list' });
    assert.match(list, /\n• batch `dd34b043` — active, legacy, 3 messages \(resident\): reactions queued 3; 0\.22\.x recorded 1 mark as added\n/);
    assert.match(list, /\n• batch `pending-batch` — active, legacy, 1 message \(resident\): reactions queued 1; 0\.22\.x recorded 0 marks as added\n/);
    assert.match(list, /\n• retract `110ae4cf-fdb6-4526-b122-9dcd6a002e27` → all: 9 removals; reactions queued 9; 2 may still land\n/);
    assert.match(list, /\n• batch `b897e6cb-25af-4485-8f94-0c8e39d4f23a` — active, cancelled, all, 3 messages \(cairn\): reactions queued 3; 1 may still land\n/);
    assert.match(
      await replyTo({ action: 'list', target: 'dd34b043' }),
      /\nIts messages' reactions: queued 3\.\nImported from agent-framework 0\.22\.x, which recorded 1 mark on these messages as added\. Marks it placed may still be on Discord: `\/marks action:retract target:dd34b043` queues their removal\.\nStates: queued, /,
    );
    assert.match(
      await replyTo({ action: 'list', target: 'b897e6cb-25af-4485-8f94-0c8e39d4f23a' }),
      /\nIts messages' reactions: queued 3\.\n1 reaction with a request on the wire or one never answered — any may land\.\nStates: /,
    );
    assert.match(
      await replyTo({ action: 'list', target: '110ae4cf-fdb6-4526-b122-9dcd6a002e27' }),
      /\n9 removals queued\. The reactions it still wants absent: queued 9\.\n2 reactions with a request on the wire or one never answered — any may land\.\nStates: /,
    );
  });

  it('shows an accepted answer that left out its ledger or receipt whole, never as "undefined"', async () => {
    for (const [action, target, what] of [['list', undefined, '/marks action:list'], ['cancel', 'b-1', '/marks action:cancel'], ['retract', 'all', '/marks action:retract']] as const) {
      const h = host({ marksVerb: 'yes', answer: (p) => (p.action === action ? { ok: true, note: 'moved' } : { ok: true }) });
      const { server } = serverWith(h.conn);
      const i = interaction('marks', target === undefined ? { action } : { action, target });
      await asAdmin(() => server.handleSlashCommand(i.value));
      const reply = i.out.replies.at(-1)!;
      assert.equal(reply, `The host answered ${what} in a shape this server can't read; here it is as sent:\n\`\`\`json\n{"ok":true,"note":"moved"}\n\`\`\``, action);
    }
  });

  it('shows a ledger with an entry it cannot read as sent, listed or opened', async () => {
    // A cancel stamp with no time: rendering it would have shown "unknown
    // time" for a field the host does send, so it's shown as sent instead.
    const partial = batch(2, { cancelled: {} });
    const h = host({ marksVerb: 'yes', answer: listing([batch(1), partial]) });
    const { server } = serverWith(h.conn);
    for (const options of [{ action: 'list' }, { action: 'list', target: partial.id }]) {
      const i = interaction('marks', options);
      await asAdmin(() => server.handleSlashCommand(i.value));
      const reply = i.out.replies.at(-1)!;
      assert.match(reply, /^The host answered the ledger in a shape this server can't read; here it is as sent:\n```json\n/, JSON.stringify(options));
      assert.match(reply, /"cancelled":\{\}/);
    }
  });

  it('calls a control whose request failed in transit unknown, pointing at the ledger', async () => {
    const conn = {
      sendRequest: async (_m: string, p: Sent) => {
        if (!p.requesterId) return { ok: true, awareness: [] };
        throw new Error('connection lost');
      },
    };
    const { server } = serverWith(conn);
    const r = interaction('marks', { action: 'retract', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(r.value));
    // A retract the host queued is an entry of its own, listed first: the batch's entry doesn't show it.
    assert.equal(r.out.replies.at(-1), '⚠️ /marks action:retract outcome unknown (connection lost): the host may already have queued the removals. Check `/marks action:list` before trying again: a retract it queued is listed first.');
    const all = interaction('marks', { action: 'retract', target: 'all' });
    await asAdmin(() => server.handleSlashCommand(all.value));
    assert.equal(all.out.replies.at(-1), '⚠️ /marks action:retract outcome unknown (connection lost): the host may already have queued the removals. Check `/marks action:list` before trying again: a retract it queued is listed first.');
    const c = interaction('marks', { action: 'cancel', target: 'b-1' });
    await asAdmin(() => server.handleSlashCommand(c.value));
    assert.equal(c.out.replies.at(-1), '⚠️ /marks action:cancel outcome unknown (connection lost): the host may already have cancelled it. Check `/marks action:list target:b-1` before trying again.');
    const list = interaction('marks', { action: 'list' });
    await asAdmin(() => server.handleSlashCommand(list.value));
    assert.match(list.out.replies.at(-1)!, /^⚠️ \/marks action:list failed: connection lost$/);
  });

  it('keeps what an accepted control requested when its reply is refused', async () => {
    const retract = { requestId: 'r-1', removalsQueued: 4, addsSuperseded: 0, keysWithUnresolvedAdds: 0 };
    const cancel = { target: 'b-2', kind: 'batch', cancelled: 3, confirmed: 1, mayStillLand: 0 };
    const h = host({ marksVerb: 'yes', answer: (p) => (p.action === 'retract' ? { ok: true, awareness: retract } : p.action === 'cancel' ? { ok: true, awareness: cancel } : { ok: true }) });
    const { server } = serverWith(h.conn);
    const r = interaction('marks', { action: 'retract', target: 'b-1' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(r.value));
    assert.match(r.out.replies.at(-1)!, /^✅ Retract `r-1`: 4 removals requested, not yet confirmed on Discord\. \(The full reply couldn't be shown/);
    const c = interaction('marks', { action: 'cancel', target: 'b-2' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(c.value));
    assert.equal(c.out.replies.at(-1), '✅ Cancelled batch `b-2`: 3 reactions will never be requested; cancel removes nothing from Discord. ' +
      "If any of its marks are on Discord, `/marks action:retract target:b-2` queues their removal. (The full reply couldn't be shown: Unknown interaction.)");
  });

  it("keeps a retract's caveats in its short account, and says when a cancel found nothing still waiting", async () => {
    const receipts: Array<[string, unknown, string]> = [
      ['retract', { requestId: 'r-2', removalsQueued: 3, addsSuperseded: 0, keysWithUnresolvedAdds: 1 },
        '✅ Retract `r-2`: 3 removals requested, not yet confirmed on Discord; 1 message has an add on the wire or never answered, which may land after its removal.'],
      ['retract', { requestId: 'r-3', removalsQueued: 5, addsSuperseded: 1, keysWithUnresolvedAdds: 2 },
        '✅ Retract `r-3`: 5 removals requested, not yet confirmed on Discord; 2 messages have adds on the wire or never answered, which may land ' +
          'after their removal.'],
      ['cancel', { target: 'b-4', kind: 'batch', cancelled: 0, confirmed: 2, mayStillLand: 1 },
        '✅ Cancelled batch `b-4`: nothing it asked for was still waiting to be sent; cancel removes nothing from Discord: 1 reaction with a ' +
          'request on the wire or one never answered may land. If any of its marks are on Discord, `/marks action:retract target:b-4` queues their removal.'],
      // A retract's cancel: no pointer, since retract takes a batch id or all.
      ['cancel', { target: 'r-5', kind: 'retract', cancelled: 1, confirmed: 0, mayStillLand: 0 },
        '✅ Cancelled retract `r-5`: 1 reaction will never be requested; cancel removes nothing from Discord.'],
      // A retract whose target names no message queued nothing.
      ['retract', { requestId: 'r-6', removalsQueued: 0, addsSuperseded: 0, keysWithUnresolvedAdds: 0 },
        '✅ Retract `r-6` queued no removal: its target names no message.'],
      // An accepted control whose receipt can't be read.
      ['retract', { requestId: 'r-7' }, "✅ The host accepted /marks action:retract `b-1` (its receipt couldn't be read)."],
    ];
    for (const [action, receipt, short] of receipts) {
      const h = host({ marksVerb: 'yes', answer: () => ({ ok: true, awareness: receipt }) });
      const { server } = serverWith(h.conn);
      const i = interaction('marks', { action, target: 'b-1' }, { rejectEdits: 1 });
      await asAdmin(() => server.handleSlashCommand(i.value));
      assert.equal(i.out.replies.at(-1), `${short} (The full reply couldn't be shown: Unknown interaction.)`, short);
    }
  });

  it("keeps a cancel's limits in its short account: what may still land, or may have landed", async () => {
    const cancel = { target: 'b-3', kind: 'batch', cancelled: 2, confirmed: 1, mayStillLand: 3 };
    const h = host({ marksVerb: 'yes', answer: () => ({ ok: true, awareness: cancel }) });
    const { server } = serverWith(h.conn);
    const c = interaction('marks', { action: 'cancel', target: 'b-3' }, { rejectEdits: 1 });
    await asAdmin(() => server.handleSlashCommand(c.value));
    assert.equal(
      c.out.replies.at(-1),
      '✅ Cancelled batch `b-3`: 2 reactions will never be requested; cancel removes nothing from Discord: 3 reactions with a request on ' +
        'the wire or one never answered may land. If any of its marks are on Discord, `/marks action:retract target:b-3` queues their removal. ' +
        "(The full reply couldn't be shown: Unknown interaction.)",
    );
  });

  it("reports the host's refusal with its code, and explains an older host", async () => {
    const busy = host({ marksVerb: 'yes', answer: () => ({ ok: false, error: 'an agent sharing the store is mid-turn', code: 'agent-busy' }) });
    const a = serverWith(busy.conn);
    const ia = interaction('marks', { action: 'cancel', target: 'b-1' });
    await asAdmin(() => a.server.handleSlashCommand(ia.value));
    assert.match(ia.out.replies.at(-1)!, /\/marks action:cancel failed \(agent-busy\): an agent sharing the store is mid-turn/);

    const old = host({ marksVerb: 'no' });
    const b = serverWith(old.conn);
    const ib = interaction('marks', { action: 'list' });
    await asAdmin(() => b.server.handleSlashCommand(ib.value));
    assert.match(ib.out.replies.at(-1)!, /doesn't have awareness-mark controls/);
  });
});

describe('rendering', () => {
  it('describes every receipt status without claiming delivery', () => {
    assert.equal(describeMarkers(undefined), 'Marks: this host reported nothing about 💤 marks; `/marks action:list` shows whether it scheduled any.');
    assert.equal(describeMarkers({ scope: 'none', unmarked: 2, notRemoved: 0, status: 'none', queued: 0 }), 'Marks: none.');
    assert.match(describeMarkers({ scope: 'addressed', unmarked: 0, notRemoved: 0, status: 'none', queued: 0 }), /nothing removed fell within "addressed"/);
    assert.equal(
      describeMarkers({ scope: 'all', unmarked: 0, notRemoved: 0, status: 'queued', queued: 2, batchId: 'b-1' }),
      'Marks: 2 💤 marks requested (all; batch `b-1`) — not yet confirmed on Discord; `/marks action:list` shows progress.',
    );
    assert.match(describeMarkers({ scope: 'all', unmarked: 0, notRemoved: 2, status: 'not-scheduled', queued: 0, error: 'ledger full' }), /not scheduled — ledger full\. None will be placed\. \(2 chosen messages not removed, so not marked\)/);
  });

  it("reads a batch's left-unmarked counts as #250 keeps them: a count left out is zero", () => {
    // agent-framework#250 as merged keeps unmarked and notRemoved only when
    // each isn't zero, and its view carries only what it kept.
    assert.match(detailText(batch(1, { unmarked: 2 })), /\nLeft unmarked: 2 outside the scope; 0 chosen but not removed\.\n/);
    assert.match(detailText(batch(1, { notRemoved: 1 })), /\nLeft unmarked: 0 outside the scope; 1 chosen but not removed\.\n/);
    assert.doesNotMatch(detailText(batch(1)), /Left unmarked/);
  });

  it('ends an entry in full with what each reaction state means, and names what a retract of all covers', () => {
    const states = 'States: queued, a request owed and not yet sent; sending, on the wire; present or absent, ' +
      "Discord's last answer, with nothing owed; unknown, the last request went unanswered; failed, it ended unconfirmed; untouched, never asked.";
    for (const v of [batch(1), retractView(1)]) assert.ok(detailText(v).endsWith(`\n${states}`), v.kind);
    assert.match(detailText(retractView(1)), /^\*\*Retract `retract-9f8e[^`]*`\*\* of every message in the ledger, /);
  });

  it('says a retract whose target names no message queued nothing, rather than a removal not yet confirmed', () => {
    assert.equal(describeRetract({ requestId: 'r-0', removalsQueued: 0, addsSuperseded: 0, keysWithUnresolvedAdds: 0 }),
      '✅ Retract `r-0` queued no removal: its target names no message.');
  });

  it('says how many marks 0.22.x recorded as added for an imported batch, none included, and nothing for a ledger batch', () => {
    const imported = (legacyAdded: number) => detailText(batch(1, { scope: 'legacy', legacyAdded }));
    const id = batch(1).id;
    const takeDown = ` Marks it placed may still be on Discord: \`/marks action:retract target:${id}\` queues their removal.`;
    assert.ok(imported(2).includes(`\nImported from agent-framework 0.22.x, which recorded 2 marks on these messages as added.${takeDown}\n`));
    assert.ok(imported(1).includes(`\nImported from agent-framework 0.22.x, which recorded 1 mark on these messages as added.${takeDown}\n`));
    assert.ok(imported(0).includes(`\nImported from agent-framework 0.22.x, which recorded 0 marks on these messages as added.${takeDown}\n`));
    assert.doesNotMatch(detailText(batch(1)), /Imported|0\.22\.x/);
    assert.match(summaryLine(batch(1, { scope: 'legacy', legacyAdded: 0 })), /; 0\.22\.x recorded 0 marks as added$/);
    assert.match(summaryLine(batch(1, { scope: 'legacy', legacyAdded: 1 })), /; 0\.22\.x recorded 1 mark as added$/);
    assert.doesNotMatch(summaryLine(batch(1)), /0\.22\.x/);
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
      ['unresolved, which the merged host no longer sends', { scope: 'all', unmarked: 0, notRemoved: 0, status: 'unresolved', queued: 0, batchId: 'b-2', error: 'disk' }],
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

  it("reads a ledger entry only when every field it shows has the type it's read as", () => {
    assert.ok(isView(batch(1)));
    assert.ok(isView(retractView(1)));
    // Shown as the host names them: a later host's batch state, AF's legacy
    // scope, a reaction state this server doesn't know.
    const later = batch(1, { status: 'staged', scope: 'legacy', reactions: { queued: 1, superseded: 2 } });
    assert.ok(isView(later));
    assert.match(renderListPage([later], 1), /— staged, legacy, 3 messages \(lena\): reactions queued 1, superseded 2\n/);
    const entries: Array<[string, unknown]> = [
      ['an imported count that is not a number', batch(1, { legacyAdded: '1' })],
      ['a reaction count that is not a number', batch(1, { reactions: { queued: '3' } })],
      ['reactions that are not counts', batch(1, { reactions: [] })],
      ['no may-still-land count', batch(1, { mayStillLand: undefined })],
      ['a cancellation with no time', batch(1, { cancelled: { by: 'Admin' } })],
      ['no creation time', batch(1, { createdAt: undefined })],
      ['no agent', batch(1, { agentName: undefined })],
      ['branches that are not text', batch(1, { sourceBranch: 3 })],
      ['an unmarked count that is not a number', batch(1, { unmarked: 'two' })],
      ['a retract with no removal count', { ...retractView(1), keys: undefined }],
      ['a retract with no time', { ...retractView(1), at: 'yesterday' }],
      ['a retract by someone not named in text', { ...retractView(1), by: 7 }],
      ['a retract with no target', { ...retractView(1), target: undefined }],
      ['an entry of another kind', { ...retractView(1), kind: 'note' }],
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
  it("offers /undo's three marks choices and /hide's two, and registers /marks", async () => {
    let registered: Array<{ name: string; options?: Array<{ name: string; required?: boolean; choices?: Array<{ value: string }> }> }> = [];
    const discord = {
      onSlashCommand: () => undefined,
      registerGuildCommands: async (commands: typeof registered) => { registered = commands; },
    };
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    await server.setupSlashCommands();
    for (const [name, choices] of [['undo', ['none', 'addressed', 'all']], ['hide', ['none', 'all']]] as const) {
      const marks = registered.find((c) => c.name === name)?.options?.find((o) => o.name === 'marks');
      assert.deepEqual(marks?.choices?.map((c) => c.value), choices, name);
      assert.equal(marks?.required, false, `${name}: marks is optional`);
    }
    const marksCommand = registered.find((c) => c.name === 'marks');
    assert.deepEqual(marksCommand?.options?.find((o) => o.name === 'action')?.choices?.map((c) => c.value), ['list', 'cancel', 'retract']);
    assert.ok(marksCommand?.options?.some((o) => o.name === 'target'));
    assert.ok(marksCommand?.options?.some((o) => o.name === 'page'));
  });
});
