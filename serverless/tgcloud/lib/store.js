import { defaults, settings } from './filters.js';
export const TABLES = ['users', 'jobs', 'deliveries', 'favorites', 'source_status'];
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sjc_meta (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_users (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_deliveries (user_id INTEGER NOT NULL, job_id INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id,job_id))`,
  `CREATE TABLE IF NOT EXISTS sjc_records (kind TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,record_key))`,
  `CREATE TABLE IF NOT EXISTS sjc_locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_updates (key TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL)`,
];
export function assert(value, message) { if (!value) throw new Error(message); }
export const positive = x => Number.isSafeInteger(x) && x > 0;
export class Store {
  constructor(db) { this.db = db; }
  async init() { for (const sql of SCHEMA) await this.db.run(sql); }
  async pruneStaffAudit(now=Date.now()) {
    await this.db.run("DELETE FROM sjc_records WHERE kind='staff_audit' AND julianday(json_extract(payload,'$.at'))<julianday(:cutoff)",{':cutoff':new Date(now-10*86400000).toISOString()});
  }
  async meta(key) { const row = await this.db.get('SELECT payload FROM sjc_meta WHERE key=:key', { ':key': key }); return row ? JSON.parse(row.payload) : null; }
  async setMeta(key, value) { await this.db.run('INSERT INTO sjc_meta(key,payload) VALUES(:key,:payload) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload', { ':key': key, ':payload': JSON.stringify(value) }); }
  async rate(key, limit, seconds, now = Date.now()) {
    const end = now + seconds*1000;
    const result = await this.db.run(`INSERT INTO sjc_records(kind,record_key,payload) VALUES('rate',:key,json_object('n',1,'end',:end))
      ON CONFLICT(kind,record_key) DO UPDATE SET payload=json_object('n',CASE WHEN json_extract(payload,'$.end')<=:now THEN 1 ELSE json_extract(payload,'$.n')+1 END,'end',CASE WHEN json_extract(payload,'$.end')<=:now THEN :end ELSE json_extract(payload,'$.end') END)
      WHERE json_extract(payload,'$.end')<=:now OR json_extract(payload,'$.n')<:limit`, {':key':key,':end':end,':now':now,':limit':limit});
    if(result.rowsAffected===1) return 0;
    const row=await this.db.get("SELECT json_extract(payload,'$.end') AS until FROM sjc_records WHERE kind='rate' AND record_key=:key",{':key':key});
    return Math.max(1,Math.ceil((row.until-now)/1000));
  }
  async lock(key, owner, seconds = 120) {
    const result = await this.db.run(`INSERT INTO sjc_locks(key,owner,expires) VALUES(:key,:owner,:expires)
      ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE sjc_locks.expires<=:now OR sjc_locks.owner=:owner`,
    { ':key': key, ':owner': owner, ':expires': Date.now() + seconds*1000, ':now': Date.now() });
    return result.rowsAffected === 1;
  }
  async unlock(key, owner) { await this.db.run('DELETE FROM sjc_locks WHERE key=:key AND owner=:owner', { ':key': key, ':owner': owner }); }
  async ensure(uid, chat) {
    const now = new Date().toISOString();
    await this.db.run('INSERT INTO sjc_users(id,payload) VALUES(:id,:payload) ON CONFLICT(id) DO NOTHING', { ':id': uid, ':payload': JSON.stringify({ user_id: uid, chat_id: chat, settings: defaults(), created_at: now, updated_at: now, last_notified_at: null }) });
    const user = await this.user(uid);
    if (user.chat_id !== chat) { user.chat_id = chat; await this.saveUser(user); }
    return user;
  }
  async captureUsername(uid,username) {
    const value=typeof username==='string' && /^[A-Za-z0-9_]{1,32}$/.test(username)?username:null;
    await this.db.run("UPDATE sjc_users SET payload=json_set(payload,'$.telegram_username',:username,'$.username_seen_day',:day) WHERE id=:uid AND COALESCE(json_extract(payload,'$.telegram_username'),'')!=COALESCE(:username,'')",{':uid':uid,':username':value,':day':new Date().toISOString().slice(0,10)});
  }
  async isBanned(uid) { return Boolean(await this.db.get("SELECT 1 AS banned FROM sjc_records WHERE kind='user_ban' AND record_key=:uid AND COALESCE(json_extract(payload,'$.active'),1)!=0",{':uid':String(uid)})); }
  async user(uid) { const row = await this.db.get('SELECT payload FROM sjc_users WHERE id=:id', { ':id': uid }); return row ? JSON.parse(row.payload) : null; }
  async saveUser(user) { await this.db.run('UPDATE sjc_users SET payload=:payload WHERE id=:id', { ':id': user.user_id, ':payload': JSON.stringify(user) }); }
  async patch(uid, fields) { const user = await this.user(uid); assert(user, 'Missing user'); user.settings = { ...settings(user.settings), ...fields }; user.updated_at = new Date().toISOString(); await this.saveUser(user); return user.settings; }
  async deleteUser(uid) {
    await this.db.run("DELETE FROM sjc_records WHERE kind='user_ban' AND record_key=:uid AND json_extract(payload,'$.active')=0",{':uid':String(uid)});
    await this.db.run("DELETE FROM sjc_records WHERE kind='menu_image' AND record_key LIKE :prefix",{':prefix':uid+':%'});
    await this.db.run("DELETE FROM sjc_records WHERE kind='rate' AND record_key LIKE :prefix",{':prefix':uid+':%'});
    await this.db.run("DELETE FROM sjc_records WHERE kind='ad_delivery' AND record_key LIKE :suffix",{':suffix': '%:'+uid});
    await this.db.run("DELETE FROM sjc_records WHERE kind='ad_target' AND record_key LIKE :suffix",{':suffix': '%:'+String(uid).padStart(20,'0')});
    // Callers hold the same user lease as notification delivery.
    await this.db.run('DELETE FROM sjc_deliveries WHERE user_id=:id', { ':id': uid });
    await this.db.run("DELETE FROM sjc_records WHERE kind='favorites' AND record_key LIKE :prefix", { ':prefix': uid + ':' + '%' });
    await this.db.run("DELETE FROM sjc_records WHERE kind='report' AND record_key LIKE :prefix", { ':prefix': uid + ':' + '%' });
    await this.db.run('DELETE FROM sjc_users WHERE id=:id', { ':id': uid });
  }
  async jobs() {
    const blocked = new Set((await this.records('moderation')).filter(r => r.blocked).flatMap(r => r.ids));
    // Bound each SDK database response: the growing catalog can exceed the
    // platform's response size even though the isolate can process all jobs.
    const rows=[]; let before=Number.MAX_SAFE_INTEGER;
    while(true) {
      const page=await this.db.all('SELECT id,payload FROM sjc_jobs WHERE id<:before ORDER BY id DESC LIMIT 100',{':before':before});
      rows.push(...page);
      if(page.length<100) break;
      before=page[page.length-1].id;
    }
    return rows.map(r => ({ ...JSON.parse(r.payload), id: r.id, ...(blocked.has(r.id) ? { _moderated: true } : {}) })).sort((a,b) => (Date.parse(b.created_at) - Date.parse(a.created_at) || b.id-a.id));
  }
  async records(kind) { return (await this.db.all('SELECT payload FROM sjc_records WHERE kind=:kind ORDER BY record_key', { ':kind': kind })).map(r => JSON.parse(r.payload)); }
  async record(kind, key, value) { await this.db.run('INSERT INTO sjc_records(kind,record_key,payload) VALUES(:kind,:key,:payload) ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload', { ':kind': kind, ':key': String(key), ':payload': JSON.stringify(value) }); }
  async withdraw(source, urls) {
    for (const url of urls) {
      const row = await this.db.get('SELECT payload FROM sjc_jobs WHERE source_key=:key', { ':key': JSON.stringify([source,url]) });
      if (!row) continue;
      const job = JSON.parse(row.payload);
      job._withdrawn_at = new Date().toISOString(); job.updated_at = job._withdrawn_at;
      job._cloud.quality = { version: 1, reason: 'closed' };
      await this.db.run('UPDATE sjc_jobs SET payload=:payload WHERE source_key=:key AND payload=:old', { ':key': JSON.stringify([source,url]), ':old': row.payload, ':payload': JSON.stringify(job) });
    }
  }
  async refreshFacts(row) {
    const saved = await this.db.get('SELECT payload FROM sjc_jobs WHERE id=:id', { ':id': row.id });
    if (!saved) return false;
    const job = JSON.parse(saved.payload);
    if (['title','description','updated_at','_withdrawn_at'].some(k => (job[k] ?? null) !== (row[k] ?? null))) return false;
    for (const key of ['quality','experience','paperwork_assistance']) job._cloud[key] = row._cloud[key];
    return (await this.db.run('UPDATE sjc_jobs SET payload=:payload WHERE id=:id AND payload=:old', { ':id': row.id, ':old': saved.payload, ':payload': JSON.stringify(job) })).rowsAffected === 1;
  }
  async job(id) { const row = await this.db.get('SELECT id,payload FROM sjc_jobs WHERE id=:id', { ':id': id }); return row ? { ...JSON.parse(row.payload), id: row.id } : null; }
  async latest() { return (await this.db.get('SELECT COALESCE(MAX(id),0) AS id FROM sjc_jobs')).id; }
  async putJob(raw, migration = false) {
    assert(raw && typeof raw.source === 'string' && typeof raw.url === 'string' && raw.title && raw._cloud?.version === 1, 'Invalid enriched job');
    const job = { ...raw }, key = JSON.stringify([job.source, job.url]);
    if (migration) {
      assert(positive(job.id), 'Invalid job ID');
      await this.db.run('INSERT INTO sjc_jobs(id,source_key,payload) VALUES(:id,:key,:payload)', { ':id': job.id, ':key': key, ':payload': JSON.stringify(job) });
      return true;
    }
    const old = await this.db.get('SELECT payload FROM sjc_jobs WHERE source_key=:key', { ':key': key });
    const previous = old ? JSON.parse(old.payload) : null;
    delete job.id;
    if (previous?.published_at) {
      job.published_at = previous.published_at; job.publication_date_only = previous.publication_date_only;
      for (const field of ['published_ms', 'published_day', 'date_only', 'date_label']) job._cloud[field] = previous._cloud[field];
    }
    job.created_at = previous?.created_at || new Date().toISOString();
    job.updated_at = new Date().toISOString();
    if (old) await this.db.run('UPDATE sjc_jobs SET payload=:payload WHERE source_key=:key', { ':key': key, ':payload': JSON.stringify(job) });
    else await this.db.run('INSERT INTO sjc_jobs(source_key,payload) VALUES(:key,:payload)', { ':key': key, ':payload': JSON.stringify(job) });
    return !old;
  }
  async importRows(table, rows) {
    assert(TABLES.includes(table) && Array.isArray(rows) && rows.length <= 50, 'Invalid import batch');
    for (const row of rows) {
      if (table === 'jobs') await this.putJob(row, true);
      else if (table === 'users') {
        assert(positive(row.user_id) && positive(row.chat_id) && row.settings && typeof row.settings === 'object', 'Invalid user');
        await this.db.run('INSERT INTO sjc_users(id,payload) VALUES(:id,:payload)', { ':id': row.user_id, ':payload': JSON.stringify(row) });
      } else if (table === 'deliveries') {
        assert(positive(row.user_id) && positive(row.job_id), 'Invalid delivery');
        await this.db.run("INSERT INTO sjc_deliveries(user_id,job_id,state,payload) VALUES(:uid,:jid,'sent',:payload)", { ':uid': row.user_id, ':jid': row.job_id, ':payload': JSON.stringify(row) });
      } else {
        const key = table === 'favorites' ? `${row.user_id}:${row.job_id}` : row.source;
        assert(typeof key === 'string' && key.length > 0, 'Invalid record');
        await this.db.run('INSERT INTO sjc_records(kind,record_key,payload) VALUES(:kind,:key,:payload)', { ':kind': table, ':key': key, ':payload': JSON.stringify(row) });
      }
    }
  }
  async rows(table, offset = 0, limit = 50) {
    assert(TABLES.includes(table) && Number.isSafeInteger(offset) && offset >= 0, 'Invalid export');
    const params = { ':offset': offset, ':limit': Math.min(50, Math.max(1, limit)) };
    const query = table === 'jobs' ? 'SELECT id,payload FROM sjc_jobs ORDER BY id' : table === 'users' ? 'SELECT payload FROM sjc_users ORDER BY id' : table === 'deliveries' ? 'SELECT payload FROM sjc_deliveries ORDER BY user_id,job_id' : 'SELECT payload FROM sjc_records WHERE kind=:kind ORDER BY record_key';
    if (table === 'favorites' || table === 'source_status') params[':kind'] = table;
    return (await this.db.all(query + ' LIMIT :limit OFFSET :offset', params)).map(r => table === 'jobs' ? { ...JSON.parse(r.payload), id: r.id } : JSON.parse(r.payload));
  }
  async stats() {
    const result = {};
    for (const table of TABLES) {
      const sql = ['users', 'jobs', 'deliveries'].includes(table) ? `SELECT COUNT(*) AS n FROM sjc_${table}` : 'SELECT COUNT(*) AS n FROM sjc_records WHERE kind=:kind';
      result[table] = (await this.db.get(sql, ['users', 'jobs', 'deliveries'].includes(table) ? {} : { ':kind': table })).n;
    }
    result.uncertain = (await this.db.get("SELECT COUNT(*) AS n FROM sjc_deliveries WHERE state IN ('sending','uncertain')")).n;
    return result;
  }
  async sourceStatus(source, payload) { await this.db.run("INSERT INTO sjc_records(kind,record_key,payload) VALUES('source_status',:source,:payload) ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload", { ':source': source, ':payload': JSON.stringify({ source, payload }) }); }
  async claimUpdate(key) {
    await this.db.run('DELETE FROM sjc_updates WHERE expires<:now', { ':now': Date.now() });
    return (await this.db.run("INSERT INTO sjc_updates(key,state,expires) VALUES(:key,'processing',:expires) ON CONFLICT(key) DO NOTHING", { ':key': key, ':expires': Date.now() + 180000 })).rowsAffected === 1;
  }
  async releaseUpdate(key) { await this.db.run("DELETE FROM sjc_updates WHERE key=:key AND state='processing'", { ':key': key }); }
  async finishUpdate(key) { await this.db.run("UPDATE sjc_updates SET state='done',expires=:expires WHERE key=:key", { ':key': key, ':expires': Date.now()+172800000 }); }
}
