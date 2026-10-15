export const MAX_JOBS = 3;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sj_probe_jobs (
    job_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sj_probe_deliveries (
    chat_id INTEGER NOT NULL, job_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'uncertain')),
    message_id INTEGER, PRIMARY KEY (chat_id, job_key))`,
];

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function bounded(value, max, required = false) {
  requireThat(typeof value === 'string' && value.length <= max && (!required || value.trim()), 'Invalid job field');
  return value;
}

function https(value) {
  return /^https:\/\/[a-z0-9.-]+(?::443)?\/[^\s<>"\\]*$/i.test(value);
}

export function validateJobs(jobs) {
  requireThat(Array.isArray(jobs) && jobs.length > 0 && jobs.length <= MAX_JOBS, 'Expected 1–3 jobs');
  const keys = new Set();
  return jobs.map((raw) => {
    requireThat(raw && typeof raw === 'object', 'Invalid job');
    const job = {
      source: bounded(raw.source, 80, true), url: bounded(raw.url, 1000, true),
      title: bounded(raw.title, 180, true), location: bounded(raw.location || '', 250),
      description: bounded(raw.description || '', 800), company: bounded(raw.company || '', 150),
      published_at: bounded(raw.published_at || '', 60), map_url: bounded(raw.map_url || '', 2000),
    };
    requireThat(/^[a-z0-9_]+$/.test(job.source) && https(job.url), 'Invalid source or URL');
    requireThat(!job.map_url || /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=[^\s<>"\\]+$/.test(job.map_url), 'Invalid Maps URL');
    job.key = job.source + '|' + job.url;
    requireThat(!keys.has(job.key), 'Duplicate job in batch');
    keys.add(job.key);
    return job;
  });
}

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function card(job, chatId) {
  const rows = [[{ text: 'Открыть объявление', url: job.url }]];
  if (job.map_url) rows.push([{ text: '🗺 Google Maps', url: job.map_url }]);
  return {
    chat_id: chatId, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    text: '🧪 <b>Проверка Telegram Serverless</b>\n\n<b>' + escape(job.title) + '</b>\n' +
      escape([job.company, job.location].filter(Boolean).join(' · ')) + '\n\n' +
      escape(job.description) + '\n\nИсточник: ' + escape(job.source),
    reply_markup: { inline_keyboard: rows },
  };
}

async function storedRows(db, chatId, jobs) {
  const rows = [];
  for (const job of jobs) {
    const row = await db.get(`SELECT j.payload, d.state, d.message_id
      FROM sj_probe_jobs j LEFT JOIN sj_probe_deliveries d
      ON d.job_key = j.job_key AND d.chat_id = :chat
      WHERE j.job_key = :key`, { ':chat': chatId, ':key': job.key });
    rows.push({ key: job.key, stored: Boolean(row), state: row?.state || null,
      matches: Boolean(row) && row.payload === JSON.stringify(job) });
  }
  return rows;
}

export async function runProbe(input, ctx, { db, api }) {
  // An ordinary Mini App caller cannot supply this server-side context.
  requireThat(ctx?.probeRun === true && !ctx.initData && !ctx.update, 'Owner CLI run required');
  requireThat(input && ['prepare', 'import', 'verify'].includes(input.operation), 'Invalid operation');
  requireThat(input.botUsername === 'SerbiaJobsBot' && input.recipientUsername === 'AngryVirus', 'Unexpected probe target');
  requireThat(Number.isSafeInteger(input.chatId) && input.chatId > 0, 'Private chat ID required');
  const jobs = validateJobs(input.jobs); // Validate the whole batch before any writes.
  requireThat(input.operation !== 'import' || jobs.length === 1, 'Import one vacancy per invocation');
  const me = await api.getMe();
  requireThat(me.is_bot && me.username?.toLowerCase() === input.botUsername.toLowerCase(), 'Wrong bot: no changes made');
  const chat = await api.getChat({ chat_id: input.chatId });
  requireThat(chat.type === 'private' && chat.id === input.chatId &&
    chat.username?.toLowerCase() === input.recipientUsername.toLowerCase(), 'Recipient is not @AngryVirus in a private chat');
  if (input.operation === 'prepare') {
    for (const statement of SCHEMA) await db.run(statement);
    return { operation: 'prepare', botUsername: me.username, tables: 2, sent: 0 };
  }
  if (input.operation === 'verify') {
    return { operation: 'verify', rows: await storedRows(db, input.chatId, jobs), sent: 0 };
  }
  let sent = 0;
  for (const job of jobs) {
    const params = { ':key': job.key, ':payload': JSON.stringify(job), ':now': new Date().toISOString() };
    await db.run(`INSERT INTO sj_probe_jobs (job_key, payload, updated_at) VALUES (:key, :payload, :now)
      ON CONFLICT(job_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`, params);
    const delivery = { ':chat': input.chatId, ':key': job.key };
    const claim = await db.run(`INSERT INTO sj_probe_deliveries (chat_id, job_key, state)
      VALUES (:chat, :key, 'sending') ON CONFLICT(chat_id, job_key) DO NOTHING`, delivery);
    if (claim.rowsAffected !== 1) continue;
    try {
      // Read back from the database, so the smoke test exercises persistence.
      const row = await db.get('SELECT payload FROM sj_probe_jobs WHERE job_key = :key', { ':key': job.key });
      const message = await api.sendMessage(card(JSON.parse(row.payload), input.chatId));
      requireThat(Number.isSafeInteger(message?.message_id), 'Missing Telegram message ID');
      await db.run(`UPDATE sj_probe_deliveries SET state = 'sent', message_id = :message
        WHERE chat_id = :chat AND job_key = :key`, { ...delivery, ':message': message.message_id });
      sent += 1;
    } catch (error) {
      // A timeout may follow a successful send. Do not blindly send a duplicate.
      await db.run(`UPDATE sj_probe_deliveries SET state = 'uncertain'
        WHERE chat_id = :chat AND job_key = :key`, delivery);
      throw new Error('Delivery not confirmed; no automatic resend. Check the private chat and probe status.');
    }
  }
  return { operation: 'import', sent, rows: await storedRows(db, input.chatId, jobs) };
}
