import { Store, TABLES, assert, positive } from './store.js';
import { settings, contains, belgradeDay } from './filters.js';
import { groupJobs, visibleJobs, hiddenGroups } from './catalog.js';
import { SOURCE_NAMES } from './config.js';
import { sourceEnabled } from './source-policy.js';
import { ownerReport, OWNER_ID, notifyReports } from './owner.js';
import { card, jobButtons, menu, translatedCard } from './ui.js';
export async function notifyOne(store, api, uid) {
  assert(positive(uid), 'Invalid subscriber');
  const cooldown = await store.meta('notification_cooldown');
  if (cooldown > Date.now()) return { sent: 0, retry_after: Math.ceil((cooldown-Date.now())/1000) };
  const owner = `${Date.now()}:${Math.random()}`, key = `user:${uid}`;
  if (!await store.lock(key, owner, 180)) return { busy: true, sent: 0 };
  try {
    const user = await store.user(uid);
    if (!user) return { sent: 0, done: true };
    const s = settings(user.settings);
    if (s.notifications === 'off') return { sent: 0, done: true };
    if (s.notifications_after_id == null) { await store.patch(uid,{ notifications_after_id: await store.latest() }); return { sent: 0, done: true }; }
    const delivered = new Set((await store.db.all('SELECT job_id FROM sjc_deliveries WHERE user_id=:uid', { ':uid': uid })).map(r => r.job_id));
    const groups = groupJobs(await store.jobs());
    const j = visibleJobs(groups, s).reverse().find(j => j._duplicate_ids.every(id => id > s.notifications_after_id && !delivered.has(id)));
    if (!j) return { sent: 0, done: true };
    const params = { ':uid': uid, ':jid': j.id }, payload = { user_id: uid, job_id: j.id, delivered_at: new Date().toISOString() };
    const result = await store.db.run("INSERT INTO sjc_deliveries(user_id,job_id,state,payload) VALUES(:uid,:jid,'sending',:payload) ON CONFLICT(user_id,job_id) DO NOTHING", { ...params, ':payload': JSON.stringify(payload) });
    if (result.rowsAffected !== 1) return { sent: 0 };
    try {
      const message = await api.sendMessage({ chat_id: user.chat_id, text: card(j), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: jobButtons(j) } });
      assert(positive(message?.message_id), 'Unconfirmed delivery');
      await store.db.run("UPDATE sjc_deliveries SET state='sent' WHERE user_id=:uid AND job_id=:jid", params);
      user.last_notified_at = payload.delivered_at; await store.saveUser(user);
      return { sent: 1 };
    } catch (error) {
      if (error.code === 429) {
        await store.db.run('DELETE FROM sjc_deliveries WHERE user_id=:uid AND job_id=:jid',params);
        const retry = Math.min(3600, Math.max(5, Number(error.parameters?.retry_after) || 60));
        await store.setMeta('notification_cooldown',Date.now()+retry*1000);
        return { sent: 0, retry_after: retry };
      }
      if (error.code === 403) {
        await store.patch(uid, { notifications: 'off' });
        await store.db.run("UPDATE sjc_deliveries SET state='blocked' WHERE user_id=:uid AND job_id=:jid",params);
        return { sent: 0, done: true, blocked: true };
      }
      // A timeout may follow a successful send. Never automatically resend it.
      await store.db.run("UPDATE sjc_deliveries SET state='uncertain' WHERE user_id=:uid AND job_id=:jid",params);
      return { sent: 0, uncertain: true };
    }
  } finally { await store.unlock(key,owner); }
}
export async function administer(input, ctx, deps) {
  assert(ctx?.ownerRun === true && !ctx.initData && !ctx.update, 'Owner CLI context required');
  const me = await deps.api.getMe();
  assert(me.is_bot && me.id === 8802394224 && me.username?.toLowerCase() === 'serbiajobsbot', 'Wrong bot; stopped');
  const store = new Store(deps.db), op = input?.operation;
  if (op === 'init') {
    await store.init();
    assert(contains('Русский повар','повар') && !contains('повариха','повар'), 'Runtime Unicode mismatch');
    assert(belgradeDay(Date.UTC(2026,9,25,23,30)) === Math.floor(Date.UTC(2026,9,26)/86400000), 'Runtime date mismatch');
    return { ready: true, active: Boolean(await store.meta('active')), sources: Object.keys(SOURCE_NAMES).filter(sourceEnabled).length, counts: await store.stats() };
  }
  if (op === 'status') return { active: Boolean(await store.meta('active')), ever_active: Boolean(await store.meta('ever_active')), counts: await store.stats(), migration: await store.meta('migration') };
  if (op === 'owner_report') {
    const report=await ownerReport(store), jobs=(await store.jobs()).filter(j=>j.source==='halooglasi'), groups=groupJobs(jobs);
    return {text:report.text,halo:{stored:jobs.length,available:visibleJobs(groups,settings()).length,owner_matching:visibleJobs(groups,settings((await store.user(OWNER_ID))?.settings)).length,status:report.sources.find(s=>s.id==='halooglasi')}};
  }
  if (op === 'translation_check') {
    const jobs=await store.jobs(), sample=jobs.find(j=>j.source==='halooglasi') || jobs.find(j=>j.source==='klikdoposla') || jobs[0];
    const requests=[];
    const fetch=async url=>{
      try { const response=await deps.fetch(url); requests.push({status:response.status,ok:response.ok}); return response; }
      catch(error) { requests.push({error:String(error.message || '').slice(0,180)}); throw error; }
    };
    const result=sample ? await translatedCard(sample,'rf',fetch,store) : null;
    return {sample_source:sample?.source,requests,failed:result?.failed ?? true,preview:result&&!result.failed?result.text.slice(0,250):null};
  }
  if (op === 'audit') {
    const start = Date.now(), jobs = await store.jobs(), groups = groupJobs(jobs);
    const visible = visibleJobs(groups, settings());
    for (const job of jobs) {
      assert(typeof card(job, true) === 'string', 'Invalid vacancy card');
      assert(jobButtons(job).flat().every(b => !b.callback_data || b.callback_data.length <= 64), 'Invalid callback length');
    }
    return { records: jobs.length, unique: groups.length, duplicates: jobs.length-groups.length, visible: visible.length, elapsed_ms: Date.now()-start };
  }
  if (op === 'export') return { rows: await store.rows(input.table,input.offset,input.limit) };
  if (op === 'refresh_facts') {
    assert(Array.isArray(input.rows) && input.rows.length <= 25 && input.rows.every(r=>positive(r.id) && r._cloud?.quality?.version===1), 'Invalid facts batch');
    let updated=0;
    for(const row of input.rows) if(await store.refreshFacts(row)) updated++;
    return {updated,skipped:input.rows.length-updated};
  }
  if (op === 'reset_stage') {
    assert(!await store.meta('active') && !await store.meta('ever_active'), 'Cannot erase an activated bot');
    for (const table of ['sjc_users','sjc_jobs','sjc_deliveries','sjc_records']) await deps.db.run(`DELETE FROM ${table}`);
    await store.setMeta('migration', { state: 'importing' });
    return { reset: true };
  }
  if (op === 'import') {
    assert(!await store.meta('active') && !await store.meta('ever_active'), 'Migration only before first activation');
    assert((await store.meta('migration'))?.state === 'importing', 'Begin staging first');
    await store.importRows(input.table,input.rows);
    return { imported: input.rows.length };
  }
  if (op === 'verified') {
    assert(!await store.meta('active') && !await store.meta('ever_active'), 'Already activated');
    assert(/^[a-f0-9]{64}$/.test(input.digest), 'Snapshot digest required');
    const stats = await store.stats();
    for (const table of TABLES) assert(stats[table] === input.counts?.[table], 'Migration count mismatch');
    await store.setMeta('migration', { state: 'verified', digest: input.digest, counts: input.counts, verified_at: new Date().toISOString() });
    return { verified: true };
  }
  if (op === 'activate') {
    const migration = await store.meta('migration');
    assert(migration?.state === 'verified' && input.digest === migration.digest && input.legacyStopped === true, 'Verified snapshot and stopped old service required');
    await store.setMeta('ever_active',true); await store.setMeta('active',true);
    return { active: true };
  }
  if (op === 'pause') { await store.setMeta('active',false); return { active: false }; }
  if (op === 'owner_preview') {
    const chat = await deps.api.getChat({ chat_id: 340780041 });
    assert(chat.type === 'private' && chat.username?.toLowerCase() === 'angryvirus', 'Owner chat mismatch');
    const s = settings((await store.user(340780041))?.settings), [text, rows] = menu(s, hiddenGroups(groupJobs(await store.jobs()), s).length);
    await deps.api.sendMessage({ chat_id: 340780041, text: '<i>Проверка переноса в Telegram Serverless</i>\n\n'+text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
    return { sent: 1 };
  }
  // Cron and delivery are inert until cutover; no baseline import can send mail.
  assert(await store.meta('active'), 'Cloud bot not active');
  if (op === 'collection_begin' || op === 'collect' || op === 'collection_end') {
    assert(typeof input.owner === 'string' && /^[a-f0-9-]{36}$/.test(input.owner), 'Collection owner required');
    if (op === 'collection_end') {
      const run=await store.meta('collection_run');
      assert(run?.owner===input.owner,'Collection owner mismatch');
      const jobs=await store.jobs(), groups=groupJobs(jobs), now=new Date().toISOString();
      const newRows=jobs.filter(j=>j.id>run.baseline);
      const newGroups=groups.filter(g=>g.members.every(j=>j.id>run.baseline)).length;
      const blocked=(await store.db.get("SELECT COUNT(*) AS n FROM sjc_deliveries WHERE state='blocked'")).n;
      const result={...run,state:input.failed?'error':'finished',failed:Boolean(input.failed),finished_at:now,totals:{...(input.totals || {}),blocked:Math.max(0,blocked-(run.blocked_baseline ?? blocked))},new_unique:visibleJobs(groups,settings()).filter(j=>j._duplicate_ids.every(id=>id>run.baseline)).length,new_duplicates:newRows.length-newGroups};
      await store.setMeta('last_collection',result); await store.setMeta('collection_run',result);
      await store.sourceStatus('_collection', { state: result.state, checked_at: now }); await store.unlock('collection',input.owner); return { released: true };
    }
    assert(await store.lock('collection',input.owner,900), 'Collection in progress');
    if (op === 'collection_begin') {
      const now=new Date().toISOString();
      const blocked=(await store.db.get("SELECT COUNT(*) AS n FROM sjc_deliveries WHERE state='blocked'")).n;
      await store.setMeta('collection_run',{owner:input.owner,state:'running',started_at:now,baseline:await store.latest(),blocked_baseline:blocked});
      await store.sourceStatus('_collection', { state: 'running', checked_at: now });
      await notifyReports(store,deps.api);
      return { claimed: true };
    }
    assert(Object.hasOwn(SOURCE_NAMES,input.source) && Array.isArray(input.jobs) && input.jobs.length <= 50 && input.jobs.every(j => j.source === input.source), 'Invalid source batch');
    let added = 0;
    for (const j of input.jobs) if (await store.putJob(j)) added++;
    const withdrawn=input.status?.withdrawn_urls || [];
    assert(Array.isArray(withdrawn) && withdrawn.length<=120 && withdrawn.every(url=>typeof url==='string' && /^https:\/\/t\.me\/[A-Za-z0-9_]+\/\d+$/.test(url)), 'Invalid withdrawn links');
    await store.withdraw(input.source,withdrawn);
    if (input.status) await store.sourceStatus(input.source,input.status);
    return { added };
  }
  if (op === 'subscribers') {
    const rows = await store.rows('users',input.offset || 0,50);
    return { ids: rows.filter(u => settings(u.settings).notifications !== 'off').map(u => u.user_id), next: rows.length === 50 ? (input.offset || 0)+50 : null };
  }
  if (op === 'notify') return notifyOne(store,deps.api,input.user_id);
  throw new Error('Unknown owner operation');
}
