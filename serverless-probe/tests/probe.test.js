import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProbe, card, validateJobs } from '../tgcloud/lib/probe.js';

function sqlite(path = ':memory:') {
  const connection = new DatabaseSync(path);
  return {
    connection,
    async run(sql, params) {
      const result = params ? connection.prepare(sql).run(params) : connection.prepare(sql).run();
      return { rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    async get(sql, params) {
      return params ? connection.prepare(sql).get(params) : connection.prepare(sql).get();
    },
  };
}

const job = { source: 'radim', url: 'https://radim.rs/jobs/probe', title: 'Повар <&>',
  location: 'Beograd', description: 'Адрес: Knez Mihailova 12',
  map_url: 'https://www.google.com/maps/search/?api=1&query=Knez+Mihailova+12' };
const config = { chatId: 123, botUsername: 'SerbiaJobsBot', recipientUsername: 'AngryVirus', jobs: [job] };
const ctx = { probeRun: true };

function api() {
  const calls = [];
  return {
    calls,
    async getMe() { return { is_bot: true, username: 'SerbiaJobsBot' }; },
    async getChat({ chat_id }) { return { id: chat_id, type: 'private', username: 'AngryVirus' }; },
    async sendMessage(message) { calls.push(message); return { message_id: 10 + calls.length }; },
  };
}

test('separate invocations persist jobs and delivery state; repeat/update does not resend', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sj-probe-'));
  const path = join(directory, 'jobs.sqlite');
  const telegram = api();
  let db = sqlite(path);
  try {
    await runProbe({ ...config, operation: 'prepare' }, ctx, { db, api: telegram });
    const first = await runProbe({ ...config, operation: 'import' }, ctx, { db, api: telegram });
    assert.equal(first.sent, 1);
    assert.equal(first.rows[0].state, 'sent');
    assert.equal(first.rows[0].matches, true);
    assert.equal(telegram.calls[0].chat_id, 123);
    db.connection.close();
    db = sqlite(path);
    const verified = await runProbe({ ...config, operation: 'verify' }, ctx, { db, api: telegram });
    assert.equal(verified.rows[0].matches, true);
    const changed = { ...config, operation: 'import', jobs: [{ ...job, title: 'Обновлённая вакансия' }] };
    const second = await runProbe(changed, ctx, { db, api: telegram });
    assert.equal(second.sent, 0);
    assert.equal(second.rows[0].matches, true);
    assert.equal(telegram.calls.length, 1);
  } finally {
    db.connection.close();
    rmSync(directory, { recursive: true });
  }
});

test('concurrent imports claim a notification only once', async () => {
  const db = sqlite(), telegram = api();
  try {
    await runProbe({ ...config, operation: 'prepare' }, ctx, { db, api: telegram });
    await Promise.all([1, 2].map(() => runProbe({ ...config, operation: 'import' }, ctx, { db, api: telegram })));
    assert.equal(telegram.calls.length, 1);
  } finally { db.connection.close(); }
});

test('ambiguous send failure remains visible and never automatically retries', async () => {
  const db = sqlite(), telegram = api();
  let attempts = 0;
  telegram.sendMessage = async () => { attempts++; throw new Error('connection lost after send'); };
  try {
    await runProbe({ ...config, operation: 'prepare' }, ctx, { db, api: telegram });
    await assert.rejects(runProbe({ ...config, operation: 'import' }, ctx, { db, api: telegram }), /not confirmed/);
    const repeated = await runProbe({ ...config, operation: 'import' }, ctx, { db, api: telegram });
    assert.equal(attempts, 1);
    assert.equal(repeated.sent, 0);
    assert.equal(repeated.rows[0].state, 'uncertain');
  } finally { db.connection.close(); }
});

test('wrong bot, wrong person and group chat fail before table creation', async () => {
  for (const variation of ['bot', 'person', 'group']) {
    const db = sqlite(), telegram = api();
    if (variation === 'bot') telegram.getMe = async () => ({ is_bot: true, username: 'OtherBot' });
    else telegram.getChat = async () => ({ id: 123, type: variation === 'group' ? 'group' : 'private', username: 'OtherUser' });
    try {
      await assert.rejects(runProbe({ ...config, operation: 'prepare' }, ctx, { db, api: telegram }));
      assert.equal((await db.get("SELECT count(*) AS count FROM sqlite_master WHERE type='table'")).count, 0);
      assert.equal(telegram.calls.length, 0);
    } finally { db.connection.close(); }
  }
});

test('Mini App/update callers and malformed batches cannot write or send', async () => {
  const db = sqlite(), telegram = api();
  try {
    for (const context of [{}, { probeRun: true, initData: { user: { id: 123 } } }, { probeRun: true, update: {} }]) {
      await assert.rejects(runProbe({ ...config, operation: 'prepare' }, context, { db, api: telegram }));
    }
    for (const jobs of [[], [job, job], Array(4).fill(job), [job, { ...job, url: 'javascript:alert(1)' }]]) {
      await assert.rejects(runProbe({ ...config, operation: 'prepare', jobs }, ctx, { db, api: telegram }));
    }
    assert.equal((await db.get("SELECT count(*) AS count FROM sqlite_master WHERE type='table'")).count, 0);
    assert.equal(telegram.calls.length, 0);
  } finally { db.connection.close(); }
});

test('cards escape text and include only validated HTTPS links', () => {
  const [safe] = validateJobs([job]);
  const message = card(safe, 123);
  assert.match(message.text, /Повар &lt;&amp;&gt;/);
  assert.equal(message.reply_markup.inline_keyboard[1][0].url, job.map_url);
  for (const url of ['https://user:secret@radim.rs/jobs/1', 'http://radim.rs/jobs/1', 'https://radim.rs/\n<bad>']) {  // pragma: allowlist secret
    assert.throws(() => validateJobs([{ ...job, url }]));
  }
  assert.throws(() => validateJobs([{ ...job, map_url: 'https://evil.example/maps' }]));
});
