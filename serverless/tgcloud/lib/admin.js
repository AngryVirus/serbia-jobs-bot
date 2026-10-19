import { teamPanel,auditPanel,staffHomeDocument } from './staff.js';
import { roleNoticeTick } from './staff.js';
import { banPanel, banNoticeTick, banNoticeText } from './bans.js';
import { Bot } from './bot.js';
import { renderImage } from './image-renderer.js';
import { sourceHistory, analyticsPanel, freshness, successfulCollection, deliveryForbidden, SUBSCRIBED_SQL } from './analytics.js';
import { backupOperation } from './backup.js';
import { healthTick } from './health.js';
import { Store, TABLES, assert, positive } from './store.js';
import { settings, contains, belgradeDay, validUrl } from './filters.js';
import { groupJobs, visibleJobs, hiddenGroups } from './catalog.js';
import { notificationPlans, savedSearches } from './searches.js';
import { notificationState } from './notification-state.js';
import { notifySourceIdeas } from './source-ideas.js';
import { configureWake,wakeStatus } from './collection-wake.js';
import { libraryRoute } from './library.js';
import { SOURCE_NAMES } from './config.js';
import { sourceEnabled } from './source-policy.js';
import { adTick } from './ads.js';
import { ownerReport, ownerRoute, OWNER_ID, notifyReports } from './owner.js';
import { card, jobButtons, menu, filtersPanel, choicePanel, translatedCard, safe } from './ui.js';
// Crawl checkpoints contain only public source URLs and URL digests, never jobs or users.
function publicCrawlUrl(value) {
  if(typeof value!=='string'||value.length>1000||!/^https:\/\/[^\s/@<>"\\]+\/[^\s<>"\\]*$/i.test(value)||/[#\u0000-\u0020\u007f]/.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value))return false;
  const host=/^https:\/\/([a-z0-9.-]+)(?::443)?\//i.exec(value)?.[1];
  return Boolean(host&&/\.[a-z]{2,}$/i.test(host)&&!/(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(host)&&!/[?&](?:access_?token|api_?key|password|secret|authorization|session)=/i.test(value));
}
function validCrawlState(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||Object.keys(value).length!==5||!['version','updated_at','cursor','pending','seen'].every(k=>Object.hasOwn(value,k)))return false;
  const stamp=x=>Number.isSafeInteger(x)&&x>=0&&x<=Math.floor(Date.now()/1000)+300;
  if(!stamp(value.updated_at)||(value.cursor!==null&&!publicCrawlUrl(value.cursor))||!Array.isArray(value.pending)||value.pending.length>48||!value.pending.every(publicCrawlUrl)||!value.seen||typeof value.seen!=='object'||Array.isArray(value.seen))return false;
  const seen=Object.entries(value.seen);
  if(seen.length>1000||!seen.every(([key,at])=>/^[a-f0-9]{64}$/.test(key)&&stamp(at)))return false;
  const json=JSON.stringify(value);
  return json.length<=90*1024&&encodeURIComponent(json).replace(/%[0-9A-F]{2}/g,'x').length<=90*1024;
}
async function renewCollection(store,owner) {
  // Checking the run and renewing its existing lease in one statement prevents
  // a delayed worker from reclaiming a newer run after a lease takeover.
  const renewed=await store.db.run("UPDATE sjc_locks SET expires=:expires WHERE key='collection' AND owner=:owner AND EXISTS(SELECT 1 FROM sjc_meta WHERE key='collection_run' AND json_extract(payload,'$.owner')=:owner AND json_extract(payload,'$.state')='running')",{':owner':owner,':expires':Date.now()+900000});
  assert(renewed.rowsAffected===1,'Collection owner mismatch or run not active');
}
export async function notifyOne(store, api, uid, catalog) {
  assert(positive(uid), 'Invalid subscriber');
  const cooldown = await store.meta('notification_cooldown');
  if (cooldown > Date.now()) return { sent: 0, retry_after: Math.ceil((cooldown-Date.now())/1000) };
  const owner = `${Date.now()}:${Math.random()}`, key = `user:${uid}`;
  if (!await store.lock(key, owner, 180)) return { busy: true, sent: 0 };
  try {
    if(!await store.meta('active'))return {sent:0,done:true,paused:true};
    if(await store.isBanned(uid))return {sent:0,done:true,banned:true};
    const user = await store.user(uid);
    if (!user) return { sent: 0, done: true };
    let plans=notificationPlans(user.settings);
    if(!plans.length)return {sent:0,done:true};
    const uninitialized=plans.filter(plan=>plan.after_id==null);
    if(uninitialized.length){
      const baseline=await store.latest(),patch={};
      if(uninitialized.some(plan=>plan.id==='main'))patch.notifications_after_id=baseline;
      if(uninitialized.some(plan=>plan.id!=='main'))patch.saved_searches=savedSearches(user.settings).map(saved=>uninitialized.some(plan=>plan.id===saved.id)?{...saved,notifications_after_id:baseline}:saved);
      user.settings=await store.patch(uid,patch);
      // Initializing one new plan must not suppress another plan's ready jobs.
      plans=notificationPlans(user.settings).filter(plan=>!uninitialized.some(fresh=>fresh.id===plan.id));
    }
    if(!plans.length)return {sent:0,done:true};
    const delivered = new Set((await store.db.all('SELECT job_id FROM sjc_deliveries WHERE user_id=:uid', { ':uid': uid })).map(r => r.job_id));
    const groups = catalog ? await catalog() : groupJobs(await store.jobs());
    const eligible=new Map();
    for(const plan of plans)for(const j of visibleJobs(groups,plan.filters)){
      if(!j._duplicate_ids.every(id=>id>plan.after_id&&!delivered.has(id)))continue;
      const groupId=Math.min(...j._duplicate_ids),existing=eligible.get(groupId);
      if(existing)existing.plans.push(plan);else eligible.set(groupId,{job:j,plans:[plan]});
    }
    const next=[...eligible.entries()].sort((a,b)=>a[0]-b[0])[0]?.[1];
    if(!next)return {sent:0,done:true};
    const j=next.job,prefix=next.plans.some(plan=>plan.id==='main')?'':`<i>🔔 Поиск: ${next.plans.map(plan=>safe(plan.name||'Сохранённый поиск',40)).join(' · ')}</i>\n\n`;
    // A catalog is shared only within one bounded batch. Moderation remains fresh.
    const moderated=await store.db.get("SELECT 1 AS blocked FROM sjc_records,json_each(sjc_records.payload,'$.ids') AS ids WHERE kind='moderation' AND json_extract(sjc_records.payload,'$.blocked')=1 AND ids.value IN (SELECT value FROM json_each(:ids)) LIMIT 1",{':ids':JSON.stringify(j._duplicate_ids)});
    if(moderated)return {sent:0,done:false};
    const params = { ':uid': uid, ':jid': j.id }, payload = { user_id: uid, job_id: j.id, delivered_at: new Date().toISOString() };
    const result = await store.db.run("INSERT INTO sjc_deliveries(user_id,job_id,state,payload) VALUES(:uid,:jid,'sending',:payload) ON CONFLICT(user_id,job_id) DO NOTHING", { ...params, ':payload': JSON.stringify(payload) });
    if (result.rowsAffected !== 1) return { sent: 0 };
    try {
      const message = await api.sendMessage({ chat_id: user.chat_id, text: prefix+card(j), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: jobButtons(j) } });
      assert(positive(message?.message_id), 'Unconfirmed delivery');
      await store.db.run("UPDATE sjc_deliveries SET state='sent' WHERE user_id=:uid AND job_id=:jid", params);
      await store.db.run("UPDATE sjc_users SET payload=json_set(payload,'$.last_notified_at',:at) WHERE id=:uid",{':uid':uid,':at':payload.delivered_at});
      return { sent: 1 };
    } catch (error) {
      if (error.code === 429) {
        await store.db.run('DELETE FROM sjc_deliveries WHERE user_id=:uid AND job_id=:jid',params);
        const retry = Math.min(3600, Math.max(5, Number(error.parameters?.retry_after) || 60));
        await store.setMeta('notification_cooldown',Date.now()+retry*1000);
        return { sent: 0, retry_after: retry };
      }
      if (error.code === 403) {
        await deliveryForbidden(store,uid,error);
        await store.patch(uid, { notifications: 'off',saved_searches:savedSearches(user.settings).map(saved=>({...saved,notifications:'off'})) });
        await store.db.run("UPDATE sjc_deliveries SET state='blocked' WHERE user_id=:uid AND job_id=:jid",params);
        return { sent: 0, done: true, blocked: true };
      }
      // A timeout may follow a successful send. Never automatically resend it.
      await store.db.run("UPDATE sjc_deliveries SET state='uncertain' WHERE user_id=:uid AND job_id=:jid",params);
      return { sent: 0, uncertain: true };
    }
  } finally { await store.unlock(key,owner); }
}
export async function notifyBatch(store,api,limit=10) {
  assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=10,'Invalid notification batch');
  const lease=`${Date.now()}:${Math.random()}`;
  if(!await store.lock('notification_batch',lease,180))return {sent:0,uncertain:0,busy:true,done:false};
  try{
    let cursor=await store.meta('notification_cursor')||0,pending=Boolean(await store.meta('notification_round_pending')),groups;
    const catalog=async()=>groups||(groups=groupJobs(await store.jobs()));
    const ids=await store.db.all(`SELECT id FROM sjc_users WHERE id>:cursor AND ${SUBSCRIBED_SQL} ORDER BY id LIMIT :limit`,{':cursor':cursor,':limit':limit});
    let sent=0,uncertain=0;
    for(const {id} of ids){
      if(!await store.meta('active'))return {sent,uncertain,done:true,paused:true};
      const result=await notifyOne(store,api,id,catalog);
      sent+=result.sent||0;uncertain+=Number(Boolean(result.uncertain));
      if(result.retry_after)return {sent,uncertain,done:false,retry_after:result.retry_after};
      pending=pending||!result.done;
      // Progress follows each completed UID, so a restarted worker starts at the tail.
      await store.setMeta('notification_round_pending',pending);
      await store.setMeta('notification_cursor',id);cursor=id;
    }
    const more=await store.db.get(`SELECT 1 AS n FROM sjc_users WHERE id>:cursor AND ${SUBSCRIBED_SQL} LIMIT 1`,{':cursor':cursor});
    if(!more){await store.setMeta('notification_cursor',0);await store.setMeta('notification_round_pending',false);return {sent,uncertain,done:!pending};}
    return {sent,uncertain,done:false};
  }finally{await store.unlock('notification_batch',lease);}
}
export async function administer(input, ctx, deps) {
  assert(ctx?.ownerRun === true && !ctx.initData && !ctx.update, 'Owner CLI context required');
  const me = await deps.api.getMe();
  assert(me.is_bot && me.id === 8802394224 && me.username?.toLowerCase() === 'serbiajobsbot', 'Wrong bot; stopped');
  const store = new Store(deps.db), op = input?.operation;
  if(['backup_create','backup_page','backup_release'].includes(op)) return backupOperation(store,input);
  if(op==='menu_image_audit') {
    assert(typeof deps.InputFile==='function','Runtime image upload unsupported');
    const s=settings((await store.user(OWNER_ID))?.settings),start=Date.now(),panels=[menu(s)[0],filtersPanel(s)[0],choicePanel(s,'city')[0]];
    const sizes=panels.map(text=>{const image=renderImage(text);assert(image.bytes.length<10000000 && image.width+image.height<=10000,'Image exceeds Telegram limits');return {width:image.width,height:image.height,bytes:image.bytes.length,icons:image.icons};});
    return {rendered:sizes.length,elapsed_ms:Date.now()-start,images:sizes};
  }
  if(op==='menu_image_preview') {
    assert(typeof deps.InputFile==='function','Runtime image upload unsupported');
    const bot=new Bot(deps);bot.uid=OWNER_ID;bot.chat=OWNER_ID;bot.s=settings((await store.ensure(OWNER_ID,OWNER_ID)).settings);bot.mid=null;bot.isPhoto=false;
    await bot.home();const id=bot.mid;
    await bot.panel(...filtersPanel(bot.s));assert(bot.mid===id,'Image was not edited in place');
    await bot.panel(...choicePanel(bot.s,'city'));assert(bot.mid===id,'Choice image was not edited in place');
    await bot.home();assert(bot.mid===id,'Menu was not restored in place');
    return {sent:1,edited_in_place:3,owner_only:true};
  }
  if(op==='health_tick'){const result=await healthTick(store,deps.api);try{await notifySourceIdeas(store,deps.api);}catch{/* Proposal notices must not prevent independent health monitoring. */}return result;}
  if(op==='ads_tick') {const notices=await banNoticeTick(store,deps.api,deps.InputFile),roles=await roleNoticeTick(store,deps.api);return {...await adTick(store,deps.api),ban_notices:notices,role_notices:roles};}
  if (op === 'init') {
    await store.init();
    if(!await store.meta('analytics_started'))await store.setMeta('analytics_started',new Date().toISOString().slice(0,10));
    assert(contains('Русский повар','повар') && !contains('повариха','повар'), 'Runtime Unicode mismatch');
    assert(belgradeDay(Date.UTC(2026,9,25,23,30)) === Math.floor(Date.UTC(2026,9,26)/86400000), 'Runtime date mismatch');
    return { ready: true, active: Boolean(await store.meta('active')), sources: Object.keys(SOURCE_NAMES).filter(sourceEnabled).length, counts: await store.stats() };
  }
  if(op==='backup_status') {
    assert(input.verified===true && input.counts && Object.values(input.counts).every(n=>Number.isSafeInteger(n)&&n>=0),'Verified backup report required');
    await store.setMeta('last_backup',{verified_at:new Date().toISOString(),counts:input.counts});return {recorded:true};
  }
  if (op === 'status') return { active: Boolean(await store.meta('active')), ever_active: Boolean(await store.meta('ever_active')), counts: await store.stats(), migration: await store.meta('migration') };
  if(op==='owner_notification_check')return notificationState(store,OWNER_ID);
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
    assert(typeof deps.api.sendPhoto==='function','Photo sending is unavailable in this runtime');
    const sql=await store.db.get("SELECT json_extract(json_object('enabled',1),'$.enabled') AS enabled,printf('%020d',42) AS key");
    assert(sql.enabled===1 && sql.key==='00000000000000000042','Advertising queue SQL unsupported');
    const window=await store.db.get('SELECT SUM(n) OVER (ORDER BY n) AS total FROM (SELECT 1 AS n UNION ALL SELECT 2 AS n) ORDER BY n DESC LIMIT 1');
    assert(window.total===3,'Bounded maintenance pagination SQL unsupported');
    const start = Date.now(), jobs = await store.jobs(), groups = groupJobs(jobs);
    const visible = visibleJobs(groups, settings());
    for (const job of jobs) {
      assert(typeof card(job, true) === 'string', 'Invalid vacancy card');
      assert(jobButtons(job).flat().every(b => !b.callback_data || b.callback_data.length <= 64), 'Invalid callback length');
    }
    return { records: jobs.length, unique: groups.length, duplicates: jobs.length-groups.length, visible: visible.length, elapsed_ms: Date.now()-start };
  }
  if(op==='operations_check') {
    const section=input.section||'all';
    assert(['all','owner','analytics','personal','staff'].includes(section),'Unknown operations section');
    const panels=[];
    try {
    const report=section==='staff'?null:await ownerReport(store);
    const bot={store,readOnly:true,uid:OWNER_ID,chat:OWNER_ID,s:settings((await store.user(OWNER_ID))?.settings),panel:async(text,rows)=>{assert(typeof text==='string' && text.length<4096,'Invalid operations panel');assert(rows.flat().every(b=>!b.callback_data || b.callback_data.length<=64),'Invalid operations callback');const image=renderImage(text);assert(image.width+image.height<=10000 && image.bytes.length<10000000,'Invalid operations image');panels.push(true);}};
    if(section==='all'||section==='owner')for(const action of ['admin','admin:refresh','admin:vacancies','admin:users','admin:staff','admin:collection','admin:details:refresh'])await ownerRoute(bot,action,report);
    if(section==='all'||section==='personal') {
      for(const action of ['admin:ideas:pending:0','admin:ideas:reviewed:0'])await ownerRoute(bot,action,report);
      for(const action of ['library','favorites:0'])await libraryRoute(bot,action,report.groups);
    }
    if(section==='all'||section==='analytics')for(const action of ['admin:stats:refresh','admin:stats:delivery:refresh','admin:stats:usage:refresh','admin:quality:refresh','admin:quality:sources:0:refresh','admin:quality:duplicates:0'])await analyticsPanel(bot,action,report);
    if(section==='all'||section==='staff') {
    await banPanel(bot,'admin:bans:0');
    await teamPanel(bot,'admin:team:0');await auditPanel(bot,'admin:audit:0');
    for(const role of ['moderator','administrator'])await bot.panel(...staffHomeDocument(role));
    for(const active of [true,false])await bot.panel(banNoticeText({active,reason:'Проверка оформления служебного уведомления.',by:OWNER_ID}),[[{text:'Связаться с @AngryVirus',url:'https://t.me/AngryVirus'}]]);
    }
    return {section,panels:panels.length,failed:false,freshness_warning:Boolean(await freshness(store)),backup_verified:Boolean((await store.meta('last_backup'))?.verified_at)};
    } catch(error) {
      const message=String(error?.message||'');
      const reason=message==='Invalid operations panel'?'panel_size':message==='Invalid operations callback'?'callback_size':message==='Invalid operations image'?'image_size':/limit|budget|memory|timeout/i.test(message)?'execution_limit':'execution_error';
      return {section,panels:panels.length,failed:true,reason};
    }
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
    if(deps.InputFile){
      const bot=new Bot(deps);bot.uid=OWNER_ID;bot.chat=OWNER_ID;bot.s=settings((await store.ensure(OWNER_ID,OWNER_ID)).settings);bot.mid=null;bot.isPhoto=false;
      await bot.home();return {sent:1};
    }
    const s = settings((await store.user(340780041))?.settings), [text, rows] = menu(s, hiddenGroups(groupJobs(await store.jobs()), s).length);
    await deps.api.sendMessage({ chat_id: 340780041, text: '<i>Проверка переноса в Telegram Serverless</i>\n\n'+text, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
    return { sent: 1 };
  }
  if(op==='collection_wake_configure')return configureWake(store,input);
  if(op==='collection_wake_status')return wakeStatus(store);
  if(op==='collection_due') {
    const active=Boolean(await store.meta('active')),last=await successfulCollection(store),run=await store.meta('collection_run');
    const lease=await store.db.get("SELECT owner,expires FROM sjc_locks WHERE key='collection'");
    const running=Boolean(run?.state==='running'&&lease?.owner===run.owner&&lease.expires>Date.now());
    return {due:active&&!running&&(!Number.isFinite(Date.parse(last))||Date.now()-Date.parse(last)>=1800000),active,last_successful_collection:last,running};
  }
  // Cron and delivery are inert until cutover; no baseline import can send mail.
  assert(await store.meta('active'), 'Cloud bot not active');
  if(op==='facts_status')return {version:await store.meta('facts_version'),progress:await store.meta('facts_progress')};
  if(['facts_begin','facts_page','facts_apply','facts_finish','facts_release'].includes(op)){
    assert(typeof input.version==='string'&&/^[a-f0-9]{64}$/.test(input.version)&&typeof input.owner==='string'&&/^[a-f0-9-]{36}$/.test(input.owner),'Invalid facts migration');
    if(op==='facts_release'){await store.unlock('facts_refresh',input.owner);return {released:true};}
    assert(await store.lock('facts_refresh',input.owner,600),'Facts migration busy');
    let progress=await store.meta('facts_progress');
    if(op==='facts_begin'){
      if(!progress||progress.version!==input.version||input.force===true){progress={version:input.version,after:0,upper:await store.latest(),started_at:new Date().toISOString()};await store.setMeta('facts_progress',progress);}
      return progress;
    }
    assert(progress?.version===input.version,'Facts migration version changed');
    if(op==='facts_page'){
      const params={':after':progress.after,':upper':progress.upper,':bytes':100*1024};
      const rows=await store.db.all('SELECT id,payload FROM (SELECT id,payload,SUM(length(CAST(payload AS BLOB))+64) OVER (ORDER BY id) AS bytes FROM (SELECT id,payload FROM sjc_jobs WHERE id>:after AND id<=:upper ORDER BY id LIMIT 100)) WHERE bytes<=:bytes ORDER BY id',params);
      if(!rows.length)assert(!await store.db.get('SELECT 1 AS n FROM sjc_jobs WHERE id>:after AND id<=:upper LIMIT 1',{':after':progress.after,':upper':progress.upper}),'Job exceeds safe facts page size');
      return {rows:rows.map(r=>({...JSON.parse(r.payload),id:r.id})),after:progress.after,upper:progress.upper};
    }
    if(op==='facts_apply'){
      assert(Number.isSafeInteger(input.after)&&input.after>=progress.after&&input.after<=progress.upper&&Array.isArray(input.rows)&&input.rows.length<=100&&input.rows.every(r=>positive(r.id)&&r.id>progress.after&&r.id<=input.after&&r._cloud?.version===1),'Invalid facts batch');
      let updated=0;
      for(const row of input.rows)if(await store.refreshFacts(row))updated++;
      await store.setMeta('facts_progress',{...progress,after:input.after});
      return {updated,skipped:input.rows.length-updated};
    }
    assert(!await store.db.get('SELECT 1 AS n FROM sjc_jobs WHERE id>:after AND id<=:upper LIMIT 1',{':after':progress.after,':upper':progress.upper}),'Facts migration incomplete');
    await store.setMeta('facts_version',input.version);await store.setMeta('facts_progress',null);await store.unlock('facts_refresh',input.owner);return {complete:true};
  }
  if (['collection_begin','collection_state','collect','collection_end'].includes(op)) {
    assert(typeof input.owner === 'string' && /^[a-f0-9-]{36}$/.test(input.owner), 'Collection owner required');
    // Requests using one run owner can also overlap after transport retries.
    // Serialize individual RPCs as well as retaining the durable run lease.
    const requestOwner=`${input.owner}:${Date.now()}:${Math.random()}`;
    assert(await store.lock('collection_rpc',requestOwner,120),'Collection operation in progress');
    try {
    if (op === 'collection_begin') {
      let previous=await store.meta('collection_run');
      assert(previous?.owner!==input.owner||previous.state==='running','Collection owner already completed');
      assert(await store.lock('collection',input.owner,900), 'Collection in progress');
      // Read again after claiming: an earlier read may predate another owner's
      // completed run and must never reopen it or reset a running baseline.
      previous=await store.meta('collection_run');
      if(previous?.owner===input.owner){assert(previous.state==='running','Collection owner already completed');return {claimed:true};}
      const now=new Date().toISOString();
      const blocked=(await store.db.get("SELECT COUNT(*) AS n FROM sjc_deliveries WHERE state='blocked'")).n;
      await store.setMeta('collection_run',{owner:input.owner,state:'running',started_at:now,baseline:await store.latest(),blocked_baseline:blocked});
      await store.sourceStatus('_collection', { state: 'running', checked_at: now });
      await notifyReports(store,deps.api);
      return { claimed: true };
    }
    if (op === 'collection_end') {
      const run=await store.meta('collection_run');
      assert(run?.owner===input.owner,'Collection owner mismatch');
      // End retries do not rewrite totals, advance freshness or count a run twice.
      if(run.state!=='running'){await store.unlock('collection',input.owner);return {released:true};}
      await renewCollection(store,input.owner);
      const jobs=await store.jobs(), groups=groupJobs(jobs), now=new Date().toISOString();
      const newRows=jobs.filter(j=>j.id>run.baseline);
      const newGroups=groups.filter(g=>g.members.every(j=>j.id>run.baseline)).length;
      const blocked=(await store.db.get("SELECT COUNT(*) AS n FROM sjc_deliveries WHERE state='blocked'")).n;
      const result={...run,state:input.failed?'error':'finished',failed:Boolean(input.failed),finished_at:now,totals:{...(input.totals || {}),blocked:Math.max(0,blocked-(run.blocked_baseline ?? blocked))},new_unique:visibleJobs(groups,settings()).filter(j=>j._duplicate_ids.every(id=>id>run.baseline)).length,new_duplicates:newRows.length-newGroups};
      if(!input.failed && (input.totals?.healthy_sources || 0)>0) await store.setMeta('last_successful_collection',now);
      await sourceHistory(store,input.owner,run.started_at);
      await store.setMeta('last_collection',result); await store.setMeta('collection_run',result);
      await store.sourceStatus('_collection', { state: result.state, checked_at: now }); await store.unlock('collection',input.owner); return { released: true };
    }
    assert(Object.hasOwn(SOURCE_NAMES,input.source),'Invalid collection source');
    await renewCollection(store,input.owner);
    if(op==='collection_state') {
      const row=await store.db.get("SELECT payload FROM sjc_records WHERE kind='collection_crawl' AND record_key=:source",{':source':input.source});
      let state={};try{const value=row&&JSON.parse(row.payload);if(validCrawlState(value))state=value;}catch{/* A malformed old checkpoint restarts only its own source. */}
      return {state};
    }
    assert(Array.isArray(input.jobs) && input.jobs.length <= 50 && input.jobs.every(j => j.source === input.source), 'Invalid source batch');
    assert(input.status===undefined || input.status&&typeof input.status==='object'&&!Array.isArray(input.status),'Invalid source status');
    const {crawl_state,...status}=input.status||{};
    if(crawl_state!==undefined)assert(validCrawlState(crawl_state),'Invalid crawl checkpoint');
    const withdrawn=status.withdrawn_urls || [];
    assert(Array.isArray(withdrawn) && withdrawn.length<=120 && withdrawn.every(url=>/^(tg_|telegram_)/.test(input.source)?typeof url==='string' && /^https:\/\/t\.me\/[A-Za-z0-9_]+\/\d+$/.test(url):validUrl(url)&&url.startsWith('https://')), 'Invalid withdrawn links');
    let added = 0;
    for (const j of input.jobs) {
      // Closed/expired updates invalidate known records without importing source archives.
      if(j._cloud?.expires_ms!=null && j._cloud.expires_ms<=Date.now() && !await store.db.get('SELECT 1 AS n FROM sjc_jobs WHERE source_key=:key',{':key':JSON.stringify([j.source,j.url])}))continue;
      if(await store.putJob(j))added++;
    }
    await store.withdraw(input.source,withdrawn);
    if(input.status)await store.sourceStatus(input.source,status);
    // The caller supplies the checkpoint only on its final upload batch. Advance
    // it after every job/withdrawal in that batch has committed, so retries can
    // revisit jobs but never skip a partially uploaded page.
    if(crawl_state!==undefined){
      // Fence the final checkpoint in the write itself. Even a delayed RPC
      // cannot advance a newer owner's source position after lease takeover.
      const written=await store.db.run("INSERT INTO sjc_records(kind,record_key,payload) SELECT 'collection_crawl',:source,:payload WHERE EXISTS(SELECT 1 FROM sjc_locks WHERE key='collection' AND owner=:owner) AND EXISTS(SELECT 1 FROM sjc_meta WHERE key='collection_run' AND json_extract(payload,'$.owner')=:owner AND json_extract(payload,'$.state')='running') ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload",{':source':input.source,':payload':JSON.stringify(crawl_state),':owner':input.owner});
      assert(written.rowsAffected===1,'Collection owner mismatch or run not active');
    }
    return { added };
    } finally {await store.unlock('collection_rpc',requestOwner);}
  }
  if (op === 'subscribers') {
    const rows = await store.rows('users',input.offset || 0,50);
    return { ids: rows.filter(u => notificationPlans(u.settings).length).map(u => u.user_id), next: rows.length === 50 ? (input.offset || 0)+50 : null };
  }
  if (op === 'notify') return notifyOne(store,deps.api,input.user_id);
  if (op === 'notify_batch') return notifyBatch(store,deps.api,input.limit??10);
  throw new Error('Unknown owner operation');
}
