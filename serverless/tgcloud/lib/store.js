import { defaults, settings } from './filters.js';
import { availabilityTarget } from './catalog.js';
import { sourceEnabled } from './source-policy.js';
export const TABLES = ['users', 'jobs', 'deliveries', 'favorites', 'source_status'];
const SCHEMA = [

  `CREATE TABLE IF NOT EXISTS sjc_meta (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_users (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_deliveries (user_id INTEGER NOT NULL, job_id INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id,job_id))`,
  `CREATE TABLE IF NOT EXISTS sjc_records (kind TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,record_key))`,
  `CREATE TABLE IF NOT EXISTS sjc_locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sjc_updates (key TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sjc_review_job ON sjc_records(json_extract(payload,'$.job_id'),json_extract(payload,'$.uid')) WHERE kind='vacancy_review'`,
  `CREATE INDEX IF NOT EXISTS sjc_review_queue ON sjc_records(json_extract(payload,'$.state'),record_key) WHERE kind='vacancy_review'`,
  `CREATE INDEX IF NOT EXISTS sjc_review_notices ON sjc_records(json_extract(payload,'$.state'),record_key) WHERE kind='review_notice'`,
  `CREATE INDEX IF NOT EXISTS sjc_updates_expires ON sjc_updates(expires)`,
  `CREATE INDEX IF NOT EXISTS sjc_rate_expires ON sjc_records(json_extract(payload,'$.end')) WHERE kind='rate'`,
  `CREATE INDEX IF NOT EXISTS sjc_input_effect_expires ON sjc_records(json_extract(payload,'$.expires')) WHERE kind='input_effect'`,
  `CREATE INDEX IF NOT EXISTS sjc_favorite_action_expires ON sjc_records(json_extract(payload,'$.expires')) WHERE kind='favorite_action'`,
];
export function assert(value, message) { if (!value) throw new Error(message); }
export const positive = x => Number.isSafeInteger(x) && x > 0;
export class Store {
  constructor(db) { this.db = db; }
  async init() {
    for (const sql of SCHEMA) await this.db.run(sql);
    await this.db.run("INSERT INTO sjc_meta(key,payload) VALUES('availability_started_at',:at) ON CONFLICT(key) DO NOTHING",{':at':JSON.stringify(new Date().toISOString())});
  }
  async pruneStaffAudit(now=Date.now()) {
    await this.db.run("DELETE FROM sjc_records WHERE kind='review_notice' AND json_extract(payload,'$.state')!='pending' AND json_extract(payload,'$.at')<:cutoff",{':cutoff':new Date(now-10*86400000).toISOString()});
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
    if(!row)return this.rate(key,limit,seconds,Math.max(now,Date.now()));
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
    assert(positive(uid) && chat===uid, 'Private chat must match its user');
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
  async favoriteIds(uid) {
    const ids=[];let after='';
    while(true){
      const rows=await this.db.all("SELECT record_key,json_extract(payload,'$.job_id') AS id FROM sjc_records WHERE kind='favorites' AND record_key LIKE :prefix AND record_key>:after AND COALESCE(json_extract(payload,'$.active'),1)!=0 ORDER BY record_key LIMIT 100",{':prefix':uid+':%',':after':after});
      for(const row of rows)if(positive(row.id))ids.push(row.id);
      if(rows.length<100)return ids;after=rows.at(-1).record_key;
    }
  }
  async setFavorite(uid,ids,enabled,event) {
    assert(positive(uid)&&ids.length&&ids.every(positive)&&typeof enabled==='boolean'&&typeof event==='string','Invalid favorite');
    const key=uid+':'+event;
    // Favorite state and replay receipt are one SQLite statement. A delayed
    // retry after removal cannot resurrect the previous save operation.
    const written=await this.db.run(`INSERT INTO sjc_records(kind,record_key,payload)
      SELECT kind,record_key,payload FROM (
       SELECT 'favorites' AS kind,:prefix||value AS record_key,json_object('user_id',:uid,'job_id',value,'active',:active,'created_at',:at) AS payload
       FROM json_each(:ids) WHERE :active=0 OR value=:canonical
       UNION ALL SELECT 'favorite_action',:event,json_object('expires',:expires)
      ) WHERE NOT EXISTS(SELECT 1 FROM sjc_records WHERE kind='favorite_action' AND record_key=:event)
      AND (:active=0 OR (SELECT COUNT(*) FROM sjc_records WHERE kind='favorites' AND record_key LIKE :like AND COALESCE(json_extract(payload,'$.active'),1)!=0)<200
       OR EXISTS(SELECT 1 FROM sjc_records WHERE kind='favorites' AND record_key LIKE :like AND COALESCE(json_extract(payload,'$.active'),1)!=0 AND json_extract(payload,'$.job_id') IN (SELECT value FROM json_each(:ids))))
      ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload`,{':prefix':uid+':',':like':uid+':%',':uid':uid,':active':enabled?1:0,':at':new Date().toISOString(),':ids':JSON.stringify(ids),':canonical':Math.min(...ids),':event':key,':expires':Date.now()+172800000});
    await this.db.run("DELETE FROM sjc_records WHERE kind='favorites' AND record_key LIKE :prefix AND json_extract(payload,'$.active')=0",{':prefix':uid+':%'});
    return written.rowsAffected>0||Boolean(await this.db.get("SELECT 1 AS done FROM sjc_records WHERE kind='favorite_action' AND record_key=:key",{':key':key}));
  }
  async saveUser(user) { await this.db.run('UPDATE sjc_users SET payload=:payload WHERE id=:id', { ':id': user.user_id, ':payload': JSON.stringify(user) }); }
  async patch(uid, fields) { const user = await this.user(uid); assert(user, 'Missing user'); user.settings = { ...settings(user.settings), ...fields }; user.updated_at = new Date().toISOString(); await this.saveUser(user); return user.settings; }
  // A receipt contains no input text. The user-row revision makes the state
  // change atomic without relying on transactions spanning SDK calls.
  async inputEffect(uid,key,screen='menu') {
    const recordKey=`${uid}:${key}`;
    const read=async()=>{const r=await this.db.get("SELECT payload FROM sjc_records WHERE kind='input_effect' AND record_key=:key",{':key':recordKey});return r?JSON.parse(r.payload):null;};
    const previous=await read();if(previous)return previous;
    const generation=Date.now().toString(36)+Math.random().toString(36).slice(2);
    const allocated=await this.db.run("UPDATE sjc_users SET payload=json_set(payload,'$.input_generation',COALESCE(json_extract(payload,'$.input_generation'),:generation),'$.input_clock',MAX(COALESCE(json_extract(payload,'$.input_clock'),0),COALESCE(json_extract(payload,'$.input_applied'),0))+1) WHERE id=:uid",{':uid':uid,':generation':generation});
    assert(allocated.rowsAffected===1,'Missing user');
    const user=await this.user(uid),effect={uid,generation:user.input_generation,revision:user.input_clock,screen,expires:Date.now()+172800000};
    await this.db.run("INSERT INTO sjc_records(kind,record_key,payload) VALUES('input_effect',:key,:payload) ON CONFLICT(kind,record_key) DO NOTHING",{':key':recordKey,':payload':JSON.stringify(effect)});
    return read();
  }
  async inputEffectStatus(uid,key) {
    const row=await this.db.get("SELECT payload FROM sjc_records WHERE kind='input_effect' AND record_key=:key",{':key':`${uid}:${key}`});
    if(!row)return null;
    const effect=JSON.parse(row.payload),user=await this.user(uid);
    if(!user)return {effect,user,status:effect.screen==='deleted'?'applied':'superseded'};
    if(user.input_generation!==effect.generation || (user.input_applied||0)>effect.revision)return {effect,user,status:'superseded'};
    return {effect,user,status:user.input_applied===effect.revision?'applied':'planned'};
  }
  async patchInput(uid,fields,key,screen='menu') {
    if(!key)return this.patch(uid,fields);
    const effect=await this.inputEffect(uid,key,screen),user=await this.user(uid);
    assert(user,'Missing user');
    if(user.input_generation===effect.generation && (user.input_applied||0)<effect.revision) {
      user.settings=settings({...settings(user.settings),...fields});user.updated_at=new Date().toISOString();user.input_applied=effect.revision;
      await this.db.run("UPDATE sjc_users SET payload=:payload WHERE id=:uid AND json_extract(payload,'$.input_generation')=:generation AND COALESCE(json_extract(payload,'$.input_applied'),0)<:revision",{':uid':uid,':payload':JSON.stringify(user),':generation':effect.generation,':revision':effect.revision});
    }
    return settings((await this.user(uid)).settings);
  }
  async pruneTransient(now=Date.now()) {
    // Each indexed deletion has a fixed upper bound, including after long downtime.
    await this.db.run('DELETE FROM sjc_updates WHERE key IN (SELECT key FROM sjc_updates WHERE expires<=:now ORDER BY expires LIMIT 100)',{':now':now});
    await this.db.run("DELETE FROM sjc_records WHERE kind='rate' AND record_key IN (SELECT record_key FROM sjc_records WHERE kind='rate' AND json_extract(payload,'$.end')<=:now ORDER BY json_extract(payload,'$.end') LIMIT 100)",{':now':now});
    await this.db.run("DELETE FROM sjc_records WHERE kind='input_effect' AND record_key IN (SELECT record_key FROM sjc_records WHERE kind='input_effect' AND json_extract(payload,'$.expires')<=:now ORDER BY json_extract(payload,'$.expires') LIMIT 100)",{':now':now});
    await this.db.run("DELETE FROM sjc_records WHERE kind='favorite_action' AND record_key IN (SELECT record_key FROM sjc_records WHERE kind='favorite_action' AND json_extract(payload,'$.expires')<=:now ORDER BY json_extract(payload,'$.expires') LIMIT 100)",{':now':now});
    await this.db.run("DELETE FROM sjc_records WHERE kind='source_idea' AND json_extract(payload,'$.state')!='pending' AND json_extract(payload,'$.updated_at')<:cutoff",{':cutoff':new Date(now-90*86400000).toISOString()});
  }
  async deleteUser(uid,key=null) {
    let effect;
    if(key){
      effect=await this.inputEffect(uid,key,'deleted');const user=await this.user(uid);
      if(!user || user.input_generation!==effect.generation || (user.input_applied||0)>=effect.revision)return false;
    }
    await this.db.run("DELETE FROM sjc_records WHERE kind='user_ban' AND record_key=:uid AND json_extract(payload,'$.active')=0",{':uid':String(uid)});
    await this.db.run("DELETE FROM sjc_records WHERE kind='menu_image' AND record_key LIKE :prefix",{':prefix':uid+':%'});
    // Active abuse counters and minimal replay receipts outlive profile deletion.
    await this.db.run("DELETE FROM sjc_records WHERE kind='rate' AND record_key LIKE :prefix AND json_extract(payload,'$.end')<=:now",{':prefix':uid+':%',':now':Date.now()});
    await this.db.run("DELETE FROM sjc_records WHERE kind='ad_delivery' AND record_key LIKE :suffix",{':suffix': '%:'+uid});
    await this.db.run("DELETE FROM sjc_records WHERE kind='ad_target' AND record_key LIKE :suffix",{':suffix': '%:'+String(uid).padStart(20,'0')});
    // Callers hold the same user lease as notification delivery.
    await this.db.run('DELETE FROM sjc_deliveries WHERE user_id=:id', { ':id': uid });
    await this.db.run("DELETE FROM sjc_records WHERE kind='favorites' AND record_key LIKE :prefix", { ':prefix': uid + ':' + '%' });
    await this.db.run("DELETE FROM sjc_records WHERE kind='report' AND record_key LIKE :prefix", { ':prefix': uid + ':' + '%' });
    await this.db.run("DELETE FROM sjc_records WHERE kind='review_notice' AND (json_extract(payload,'$.uid')=:uid OR json_extract(payload,'$.key') IN (SELECT record_key FROM sjc_records WHERE kind='vacancy_review' AND json_extract(payload,'$.uid')=:uid))",{':uid':uid});
    await this.db.run("DELETE FROM sjc_records WHERE kind='vacancy_review' AND json_extract(payload,'$.uid')=:uid",{':uid':uid});
    await this.db.run('DELETE FROM sjc_users WHERE id=:id', { ':id': uid });
    return true;
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
    const jobs=rows.map(r => ({ ...JSON.parse(r.payload), id: r.id, ...(blocked.has(r.id) ? { _moderated: true } : {}) }));
    await this.decorateJobs(jobs);
    return jobs.sort((a,b) => (Date.parse(b.created_at) - Date.parse(a.created_at) || b.id-a.id));
  }
  async decorateJobs(jobs){
    const keys=[...new Set(jobs.map(j=>availabilityTarget(j).key))],states=new Map(),baseline=await this.meta('availability_started_at');
    for(let i=0;i<keys.length;i+=250){
      const rows=await this.db.all("SELECT record_key,payload FROM sjc_records WHERE kind='availability' AND record_key IN (SELECT value FROM json_each(:keys))",{':keys':JSON.stringify(keys.slice(i,i+250))});
      for(const row of rows)states.set(row.record_key,JSON.parse(row.payload));
    }
    for(const job of jobs){
      if(typeof job._cloud?.display_title==='string'&&job._cloud.display_title.length<=140)job.title=job._cloud.display_title;
      const state=states.get(availabilityTarget(job).key);job._availability_baseline=baseline;
      if(state){
        job._availability=state;
        if(state.state!=='closed'&&Number.isFinite(state.verified_at))job._cloud={...job._cloud,expires_ms:state.expires_ms??null,quality:job._cloud?.quality?.reason==='closed'?{...job._cloud.quality,reason:null}:job._cloud?.quality};
      }
    }
  }
  async availabilityBatch(now=Date.now()){
    const after=await this.meta('availability_cursor')||0;
    const rows=await this.db.all("SELECT id,json_extract(payload,'$.source') AS source,json_extract(payload,'$.url') AS url FROM sjc_jobs WHERE id>:after ORDER BY id LIMIT 12",{':after':after});
    const candidates=[],seen=new Set();
    for(const row of rows){
      if(!sourceEnabled(row.source))continue;
      if(['tg_radim_serbia','tg_rabotavserbii'].includes(row.source))row.description=(await this.db.get("SELECT json_extract(payload,'$.description') AS description FROM sjc_jobs WHERE id=:id",{':id':row.id}))?.description;
      const target=availabilityTarget(row);
      if(!target.key||seen.has(target.key))continue;seen.add(target.key);
      const saved=await this.db.get("SELECT payload FROM sjc_records WHERE kind='availability' AND record_key=:key",{':key':target.key});
      if(saved&&JSON.parse(saved.payload).next_at>now)continue;
      candidates.push({id:row.id,...target});
    }
    return {after,cursor:rows.length===12?rows.at(-1).id:0,started_at:now,candidates,scanned:rows.length};
  }
  async applyAvailability(input,now=Date.now()){
    const last=await this.meta('availability_batch');
    if(last?.probe===input.probe)return {replayed:true};
    assert((await this.meta('availability_cursor')||0)===input.after,'Availability cursor changed');
    const rows=await this.db.all('SELECT id FROM sjc_jobs WHERE id>:after ORDER BY id LIMIT 12',{':after':input.after});
    assert(input.cursor===(rows.length===12?rows.at(-1).id:0)&&input.results.every(r=>rows.some(row=>row.id===r.id)),'Invalid availability batch');
    const fence="EXISTS(SELECT 1 FROM sjc_locks WHERE key='collection' AND owner=:owner AND expires>:now) AND EXISTS(SELECT 1 FROM sjc_meta WHERE key='collection_run' AND json_extract(payload,'$.owner')=:owner AND json_extract(payload,'$.state')='running')";
    let closed=0,verified=0;
    for(const result of input.results){
      const row=await this.db.get('SELECT payload FROM sjc_jobs WHERE id=:id',{':id':result.id});if(!row)continue;
      const target=availabilityTarget(JSON.parse(row.payload));
      assert(result.key===target.key,'Availability target changed');
      const saved=await this.db.get("SELECT payload FROM sjc_records WHERE kind='availability' AND record_key=:key",{':key':target.key}),old=saved?JSON.parse(saved.payload):{};
      if(old.probe===input.probe||old.checked_at>input.started_at)continue;
      let state=result.state;
      const next={...old,state:old.state==='closed'?'closed':'unknown',reason:result.reason,checked_at:now,next_at:now+86400000,probe:input.probe};
      if(state==='missing'){
        if(Number.isFinite(old.missing_at)&&now-old.missing_at>=6*3600000)state='closed';
        else if(!Number.isFinite(old.missing_at))next.missing_at=now;
      }
      if(state==='active'){next.state='active';next.verified_at=now;next.expires_ms=result.expires_ms??null;delete next.missing_at;verified++;}
      if(state==='closed'){next.state='closed';next.next_at=now+7*86400000;closed++;}
      const written=await this.db.run("INSERT INTO sjc_records(kind,record_key,payload) SELECT 'availability',:key,:payload WHERE "+fence+' ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload',{':key':target.key,':payload':JSON.stringify(next),':owner':input.owner,':now':now});
      assert(written.rowsAffected===1,'Availability owner changed');
    }
    const advanced=await this.db.run("INSERT INTO sjc_meta(key,payload) SELECT key,payload FROM (SELECT 'availability_cursor' AS key,:cursor AS payload UNION ALL SELECT 'availability_batch',:batch) WHERE "+fence+' ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',{':cursor':JSON.stringify(input.cursor),':batch':JSON.stringify({probe:input.probe,cursor:input.cursor}),':owner':input.owner,':now':now});
    assert(advanced.rowsAffected===2,'Availability owner changed');
    return {closed,verified};
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
      await this.record('availability',availabilityTarget(job).key,{state:'closed',reason:'publisher_notice',checked_at:Date.now(),next_at:Date.now()+7*86400000});
    }
  }
  async refreshFacts(row) {
    const saved = await this.db.get('SELECT payload FROM sjc_jobs WHERE id=:id', { ':id': row.id });
    if (!saved) return false;
    const job = JSON.parse(saved.payload);
    if (['title','description','updated_at','_withdrawn_at'].some(k => (job[k] ?? null) !== (row[k] ?? null))) return false;
    assert(row._cloud?.version===1,'Invalid derived facts');
    job._cloud={...row._cloud};
    return (await this.db.run('UPDATE sjc_jobs SET payload=:payload WHERE id=:id AND payload=:old', { ':id': row.id, ':old': saved.payload, ':payload': JSON.stringify(job) })).rowsAffected === 1;
  }
  async job(id) { const row = await this.db.get('SELECT id,payload FROM sjc_jobs WHERE id=:id', { ':id': id });if(!row)return null;const jobs=[{...JSON.parse(row.payload),id:row.id}];await this.decorateJobs(jobs);return jobs[0]; }
  async latest() { return (await this.db.get('SELECT COALESCE(MAX(id),0) AS id FROM sjc_jobs')).id; }
  async putJob(raw, migration = false) {
    assert(raw && typeof raw.source === 'string' && typeof raw.url === 'string' && raw.title && raw._cloud?.version === 1, 'Invalid enriched job');
    const job = { ...raw,_cloud:{...raw._cloud,...(raw._cloud.quality?{quality:{...raw._cloud.quality}}:{})} }, key = JSON.stringify([job.source, job.url]);
    if (migration) {
      assert(positive(job.id), 'Invalid job ID');
      await this.db.run('INSERT INTO sjc_jobs(id,source_key,payload) VALUES(:id,:key,:payload)', { ':id': job.id, ':key': key, ':payload': JSON.stringify(job) });
      return true;
    }
    const old = await this.db.get('SELECT payload FROM sjc_jobs WHERE source_key=:key', { ':key': key });
    const previous = old ? JSON.parse(old.payload) : null;
    delete job.id;
    delete job._availability;delete job._availability_baseline;
    if (previous?.published_at) {
      job.published_at = previous.published_at; job.publication_date_only = previous.publication_date_only;
      for (const field of ['published_ms', 'published_day', 'date_only', 'date_label']) job._cloud[field] = previous._cloud[field];
    }
    job.created_at = previous?.created_at || new Date().toISOString();
    job.updated_at = new Date().toISOString();
    if(previous?._withdrawn_at){job._withdrawn_at=previous._withdrawn_at;job._cloud.quality={...job._cloud.quality,reason:'closed'};}
    if (old) await this.db.run('UPDATE sjc_jobs SET payload=:payload WHERE source_key=:key', { ':key': key, ':payload': JSON.stringify(job) });
    else await this.db.run('INSERT INTO sjc_jobs(source_key,payload) VALUES(:key,:payload)', { ':key': key, ':payload': JSON.stringify(job) });
    const target=availabilityTarget(job);
    if(raw._cloud?.quality?.reason==='closed'||raw._cloud?.expires_ms!=null&&raw._cloud.expires_ms<=Date.now())await this.record('availability',target.key,{state:'closed',reason:raw._cloud?.quality?.reason==='closed'?'publisher_notice':'expired',checked_at:Date.now(),next_at:Date.now()+7*86400000});
    else if(!/^(tg_|telegram_)/.test(job.source)&&!raw._cloud?.quality?.reason){
      // A current original feed/detail confirms an open web publication. A
      // known closure still needs a direct probe; stale listings cannot reopen it.
      const row=await this.db.get("SELECT payload FROM sjc_records WHERE kind='availability' AND record_key=:key",{':key':target.key});
      if(!row||JSON.parse(row.payload).state!=='closed')await this.record('availability',target.key,{state:'active',reason:'parsed',checked_at:Date.now(),verified_at:Date.now(),expires_ms:raw._cloud?.expires_ms??null,next_at:Date.now()+86400000});
    }
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
    await this.pruneTransient();
    return (await this.db.run("INSERT INTO sjc_updates(key,state,expires) VALUES(:key,'processing',:expires) ON CONFLICT(key) DO NOTHING", { ':key': key, ':expires': Date.now() + 180000 })).rowsAffected === 1;
  }
  async releaseUpdate(key) { await this.db.run("DELETE FROM sjc_updates WHERE key=:key AND state='processing'", { ':key': key }); }
  async finishUpdate(key) { await this.db.run("UPDATE sjc_updates SET state='done',expires=:expires WHERE key=:key", { ':key': key, ':expires': Date.now()+172800000 }); }
}
