import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,message,callback } from './fixtures.js';
import { OWNER_ID,rawRole,roleRecord } from '../tgcloud/lib/permissions.js';
import { banRecord,banVersion } from '../tgcloud/lib/bans.js';
import { Store } from '../tgcloud/lib/store.js';
import { deliverRoleNotice,roleNoticeTick } from '../tgcloud/lib/staff.js';
async function seed(f,uid,role){await f.store.ensure(uid,uid);await f.store.record('staff_role',String(uid),{uid,role,version:'seed'+uid});}
async function grantDraft(f,actor,target,role){await handle(f,callback(actor,'admin:team:add:'+role));await handle(f,message(actor,String(target)));return 'admin:team:confirm:'+(await f.store.user(actor)).settings.staff_draft.token;}
async function grant(f,actor,target,role){const action=await grantDraft(f,actor,target,role);await handle(f,callback(actor,action));return action;}
async function revoke(f,actor,target){const row=await roleRecord(f.store,target);const action=`admin:team:remove:${target}:${row.version}`;await handle(f,callback(actor,action));const draft=(await f.store.user(actor)).settings.staff_draft;if(!draft)return action;const confirm="admin:team:confirm:"+draft.token;await handle(f,callback(actor,confirm));return confirm;}
async function banDraft(f,actor,target){await handle(f,callback(actor,'admin:bans:new'));await handle(f,message(actor,String(target)));await handle(f,message(actor,'Спам'));return 'admin:bans:confirm:'+(await f.store.user(actor)).settings.ban_draft.token;}
async function ban(f,actor,target){const action=await banDraft(f,actor,target);await handle(f,callback(actor,action));return action;}
const last=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const callbacks=p=>p.reply_markup.inline_keyboard.flat().map(b=>b.callback_data).filter(Boolean);

test('role-specific panels hide every unavailable owner, team and unban function',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');
 await handle(f,callback(1,'admin'));assert.deepEqual(callbacks(last(f)),['admin:bans:new','menu']);
 await handle(f,callback(1,'admin:bans:0'));assert(!callbacks(last(f)).some(x=>x.includes('remove')||x.includes('team')||x.includes('audit')));
 await handle(f,callback(2,'admin'));assert.deepEqual(callbacks(last(f)),['admin:bans:new','admin:bans:0','admin:team:0','menu']);
 await handle(f,callback(2,'admin:team:0'));assert(callbacks(last(f)).includes('admin:team:add:moderator'));assert(!JSON.stringify(last(f)).includes('admin:team:add:administrator'));
 for(const uid of [1,2])for(const action of ['admin:stats','admin:quality','admin:details','admin:reports:0','admin:audit:0','admin:vacancies','admin:users','admin:staff','admin:collection','admin:refresh','admin:details:refresh','ads']){await handle(f,callback(uid,action));assert(!callbacks(last(f)).some(x=>/^ads:(new|start)|admin:(stats|quality|reports|audit|vacancies|users|staff|collection|refresh|details)/.test(x)));}
 await handle(f,callback(OWNER_ID,'admin'));assert(callbacks(last(f)).includes('admin:staff'));
 await handle(f,callback(OWNER_ID,'admin:staff'));assert(callbacks(last(f)).includes('admin:team:0'));assert(callbacks(last(f)).includes('admin:audit:0'));
});
test('owner assigns administrators, administrators manage only moderators; roles survive restart',async()=>{
 const f=await fixture();await grant(f,OWNER_ID,2,'administrator');assert.equal(await rawRole(new Store(f.db),2),'administrator');
 const action=await grant(f,2,1,'moderator');assert.equal(await rawRole(f.store,1),'moderator');await handle(f,callback(2,action));assert.equal((await f.store.records('staff_audit')).filter(e=>e.action==='grant_moderator').length,1);
 await handle(f,callback(2,'admin:team:add:administrator'));assert.equal((await f.store.user(2)).settings.pending_input,null);
 await revoke(f,2,1);assert.equal(await rawRole(f.store,1),'user');
 await revoke(f,OWNER_ID,2);assert.equal(await rawRole(f.store,2),'user');
 assert.deepEqual((await f.store.records('staff_audit')).map(e=>e.action).sort(),['grant_administrator','grant_moderator','revoke_administrator','revoke_moderator'].sort());
});
test('moderator bans but cannot unban; administrator unbans and actual actor is audited',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');await f.store.ensure(77,77);
 const action=await banDraft(f,1,77),u=callback(1,action);u.callback_query.from.username='RealModerator';await handle(f,u);assert.equal(await f.store.isBanned(77),true);
 const row=await banRecord(f.store,77),remove=`admin:bans:remove:77:${banVersion(row)}`;
 await handle(f,callback(1,remove));assert.equal(await f.store.isBanned(77),true);
 await handle(f,callback(2,remove));assert.equal(await f.store.isBanned(77),false);
 const events=await f.store.records('staff_audit');assert.equal(events.length,2);assert.deepEqual(events.find(e=>e.action==='ban').actor,{id:1,username:'RealModerator'});assert.equal(events.find(e=>e.action==='unban').actor.id,2);
});
test('hierarchy prevents peer/owner bans and disguised administrator demotions',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');await seed(f,3,'administrator');await seed(f,4,'moderator');
 for(const [actor,target] of [[1,2],[1,4],[1,OWNER_ID],[2,3],[2,OWNER_ID],[2,2]]){await handle(f,callback(actor,'admin:bans:new'));await handle(f,message(actor,String(target)));assert.equal((await f.store.user(actor)).settings.ban_draft??null,null);assert.equal(await f.store.isBanned(target),false);}
 await handle(f,callback(2,'admin:team:add:moderator'));await handle(f,message(2,'3'));assert.equal((await f.store.user(2)).settings.staff_draft??null,null);assert.equal(await rawRole(f.store,3),'administrator');
 await revoke(f,2,3);assert.equal(await rawRole(f.store,3),'administrator');
 await grant(f,OWNER_ID,3,'moderator');assert.equal(await rawRole(f.store,3),'moderator');
});
test('revocation invalidates saved ban drafts, direct callbacks and forged private chat identities',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');const action=await banDraft(f,1,77);
 await revoke(f,2,1);await handle(f,callback(1,action));assert.equal(await f.store.isBanned(77),false);
 for(const [uid,chat] of [[1,OWNER_ID],[2,OWNER_ID],[OWNER_ID,2]]){const u=callback(uid,'admin:team:add:administrator');u.callback_query.message.chat.id=chat;await handle(f,u);assert.equal(await rawRole(f.store,77),'user');}
 await f.store.patch(1,{pending_input:'staff_target',staff_desired:'administrator'});await handle(f,message(1,'77'));assert.equal(await rawRole(f.store,77),'user');
});
test('target promotion after ban preview and target ban after role preview are checked at confirmation',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');let action=await banDraft(f,1,77);
 await grant(f,OWNER_ID,77,'administrator');await handle(f,callback(1,action));assert.equal(await f.store.isBanned(77),false);
 action=await grantDraft(f,2,78,'moderator');await ban(f,OWNER_ID,78);await handle(f,callback(2,action));assert.equal(await rawRole(f.store,78),'user');
});
test('stale revoke cannot remove a newly reassigned role and staff lists do not reveal administrators to administrators',async()=>{
 const f=await fixture();await seed(f,2,'administrator');await seed(f,3,'administrator');await seed(f,1,'moderator');const stale=`admin:team:remove:1:${(await roleRecord(f.store,1)).version}`;
 await grant(f,OWNER_ID,1,'administrator');await handle(f,callback(2,stale));assert.equal(await rawRole(f.store,1),'administrator');
 await handle(f,callback(2,'admin:team:0'));assert(!last(f).text.includes('3 · Администратор'));assert(!callbacks(last(f)).some(x=>x.startsWith('admin:team:remove:3:')));
 await handle(f,callback(2,'admin:audit:0'));assert(!last(f).text.includes('grant_'));await handle(f,callback(OWNER_ID,'admin:audit:0'));assert.match(last(f).text,/Повышен до администратора/);
});
test('failed audit insert rolls back the moderation decision and does not silently grant privilege',async()=>{
 const f=await fixture();await seed(f,1,'moderator');const action=await banDraft(f,1,77);
 await f.db.run("CREATE TRIGGER reject_staff_audit BEFORE INSERT ON sjc_records WHEN NEW.kind='staff_audit' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 await assert.rejects(handle(f,callback(1,action)),/audit unavailable/);assert.equal(await f.store.isBanned(77),false);assert.equal((await f.store.records('staff_audit')).length,0);
 const grantAction=await grantDraft(f,OWNER_ID,2,'administrator');await assert.rejects(handle(f,callback(OWNER_ID,grantAction)),/audit unavailable/);assert.equal(await rawRole(f.store,2),'user');
 await f.db.run('DROP TRIGGER reject_staff_audit');await handle(f,callback(OWNER_ID,grantAction));assert.equal(await rawRole(f.store,2),'administrator');
});
test('role changes share the target lease and cannot race an in-flight staff action',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');await f.store.lock('user:1','inflight',180);
 await revoke(f,2,1);assert.equal(await rawRole(f.store,1),'moderator');assert.match(last(f).text,/сейчас обрабатывается/);
 await f.store.unlock('user:1','inflight');await revoke(f,2,1);assert.equal(await rawRole(f.store,1),'user');
});

test('administrator ban list hides unban controls for protected administrators',async()=>{
 const f=await fixture();await seed(f,2,'administrator');await seed(f,3,'administrator');await ban(f,OWNER_ID,3);await ban(f,OWNER_ID,77);
 await handle(f,callback(2,'admin:bans:0'));assert(!callbacks(last(f)).some(x=>x.startsWith('admin:bans:remove:3:')));assert(callbacks(last(f)).some(x=>x.startsWith('admin:bans:remove:77:')));
});

test('role changes notify the target once, explain both roles on promotion, and revoke each role explicitly',async()=>{
 const f=await fixture();await f.store.ensure(77,77);
 const notices=()=>f.api.sent.filter(p=>p.chat_id===77);
 const first=await grant(f,OWNER_ID,77,'moderator');assert.equal(notices().length,1);assert.match(notices()[0].text,/назначены модератором/);assert.equal(callbacks(notices()[0])[0],'admin');
 await handle(f,callback(OWNER_ID,first));assert.equal(notices().length,1);
 await grant(f,OWNER_ID,77,'administrator');assert.equal(notices().length,2);assert.match(notices()[1].text,/повышены с модератора до администратора/);
 const remove=await revoke(f,OWNER_ID,77);assert.equal(notices().length,3);assert.match(notices()[2].text,/сняты полномочия администратора/);assert.equal(callbacks(notices()[2])[0],'menu');
 await handle(f,callback(OWNER_ID,remove));assert.equal(notices().length,3);
 await grant(f,OWNER_ID,77,'moderator');await revoke(f,OWNER_ID,77);assert.match(notices().at(-1).text,/сняты полномочия модератора/);
});
test('ambiguous role notification failure cannot undo or repeat the decision or delivery',async()=>{
 const f=await fixture();let attempts=0;const send=f.api.sendMessage;
 f.api.sendMessage=async p=>{if(p.chat_id===77){attempts++;assert.equal(await rawRole(f.store,77),'moderator');assert.equal((await roleRecord(f.store,77)).notice.state,'sending');throw Error('private transport details');}return send(p);};
 const action=await grant(f,OWNER_ID,77,'moderator');assert.equal(attempts,1);assert.equal(await rawRole(f.store,77),'moderator');assert.equal((await roleRecord(f.store,77)).notice.state,'unconfirmed');assert.match(last(f).text,/Доставка уведомления не подтверждена/);assert(!JSON.stringify(await roleRecord(f.store,77)).includes('private transport'));
 await handle(f,callback(OWNER_ID,action));assert.equal(attempts,1);assert.equal((await f.store.records('staff_audit')).filter(e=>e.target===77).length,1);
});

test('employee cards promote, demote and revoke with confirmation, actual actor and fresh version checks',async()=>{
 const f=await fixture();await seed(f,77,'moderator');await f.store.captureUsername(77,'KnownMember');
 await handle(f,callback(OWNER_ID,'admin:team:0'));assert(callbacks(last(f)).includes('admin:team:view:77'));assert.match(last(f).text,/@KnownMember/);
 await handle(f,callback(OWNER_ID,'admin:team:view:77'));let change=callbacks(last(f)).find(x=>x.endsWith(':administrator'));assert(change);assert(callbacks(last(f)).some(x=>x.endsWith(':user')));
 await handle(f,callback(OWNER_ID,change));assert.equal(await rawRole(f.store,77),'moderator');let confirm=callbacks(last(f))[0];
 let u=callback(OWNER_ID,confirm);u.callback_query.from={id:OWNER_ID,first_name:'Владелец',username:'ActualOwner'};await handle(f,u);
 assert.equal(await rawRole(f.store,77),'administrator');let notice=f.api.sent.filter(p=>p.chat_id===77).at(-1);assert.match(notice.text,/повышены/);assert.match(notice.text,/@ActualOwner/);assert.match(notice.text,/Владелец/);assert.match(notice.text,/340780041/);
 await handle(f,callback(OWNER_ID,change));assert.equal((await f.store.user(OWNER_ID)).settings.staff_draft,null);
 await handle(f,callback(OWNER_ID,'admin:team:view:77'));change=callbacks(last(f)).find(x=>x.endsWith(':moderator'));await handle(f,callback(OWNER_ID,change));confirm=callbacks(last(f))[0];assert.equal(await rawRole(f.store,77),'administrator');await handle(f,callback(OWNER_ID,confirm));assert.equal(await rawRole(f.store,77),'moderator');assert.match(f.api.sent.filter(p=>p.chat_id===77).at(-1).text,/понижены с администратора до модератора/);
 await handle(f,callback(OWNER_ID,'admin:team:view:77'));change=callbacks(last(f)).find(x=>x.endsWith(':user'));await handle(f,callback(OWNER_ID,change));assert.equal(await rawRole(f.store,77),'moderator');await handle(f,callback(OWNER_ID,callbacks(last(f))[0]));assert.equal(await rawRole(f.store,77),'user');
 const notices=f.api.sent.filter(p=>p.chat_id===77);assert.equal(notices.length,3);await handle(f,callback(OWNER_ID,confirm));assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,3);
 assert.deepEqual((await f.store.records('staff_audit')).map(e=>e.action).sort(),['promote','demote','revoke_moderator'].sort());
});
test('administrator employee cards expose only moderator removal; forged promotions and protected targets are denied',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');await seed(f,3,'administrator');
 await handle(f,callback(2,'admin:team:view:1'));assert(!callbacks(last(f)).some(x=>x.endsWith(':administrator')||x.endsWith(':moderator')));assert(callbacks(last(f)).some(x=>x.endsWith(':user')));
 for(const [uid,action] of [[2,'admin:team:set:1:seed1:administrator'],[2,'admin:team:view:3'],[1,'admin:team:view:2'],[OWNER_ID,'admin:team:view:'+OWNER_ID]]){await handle(f,callback(uid,action));assert(!callbacks(last(f)).some(x=>x.startsWith('admin:team:confirm:')));}
 const forged=callback(OWNER_ID,'admin:team:set:1:seed1:administrator');forged.callback_query.message.chat.id=2;await handle(f,forged);assert.equal(await rawRole(f.store,1),'moderator');
});
test('team audit expires after ten days, including scheduled health cleanup, without deleting decisions or other audit records',async()=>{
 const f=await fixture(),now=Date.now()-1000,cutoff=now-10*86400000;
 for(const [key,at] of [['old',cutoff-1],['boundary',cutoff],['recent',now]])await f.store.record('staff_audit',key,{at:new Date(at).toISOString(),actor:{id:OWNER_ID},actor_role:'owner',action:'ban',target:77});
 await seed(f,77,'moderator');await f.store.record('ad_audit','old',{at:new Date(cutoff-1).toISOString()});
 const {healthTick}=await import('../tgcloud/lib/health.js');await f.store.setMeta('active',false);await healthTick(f.store,f.api,now);
 assert.equal((await f.store.records('staff_audit')).length,2);assert.equal(await rawRole(f.store,77),'moderator');assert.equal((await f.store.records('ad_audit')).length,1);
 await f.store.record('staff_audit','expired',{at:new Date(cutoff-10000).toISOString()});await f.store.setMeta('active',true);await handle(f,callback(OWNER_ID,'admin:audit:0'));assert.equal((await f.store.records('staff_audit')).length,1);assert.match(last(f).text,/последние 10 дней/);
 await f.store.record('staff_audit','expired',{at:new Date(cutoff-10000).toISOString()});await grant(f,OWNER_ID,88,'moderator');assert(!(await f.db.get("SELECT payload FROM sjc_records WHERE kind='staff_audit' AND record_key='expired'")));
});

test('explicit 429 role notices retry durably after retry_after and concurrent workers send once',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const send=f.api.sendMessage;let attempts=0;
 f.api.sendMessage=async p=>{if(p.chat_id===77){attempts++;if(attempts===1)throw {code:429,parameters:{retry_after:10}};}return send(p);};
 await grant(f,OWNER_ID,77,'moderator');let row=await roleRecord(f.store,77);
 assert.equal(row.notice.state,'pending');assert.equal(row.notice.before,'user');assert.match(last(f).text,/будет отправлено позже/);
 await roleNoticeTick(new Store(f.db),f.api,row.notice.retry_at-1);assert.equal(attempts,1);
 await Promise.all([roleNoticeTick(new Store(f.db),f.api,row.notice.retry_at),roleNoticeTick(new Store(f.db),f.api,row.notice.retry_at)]);
 row=await roleRecord(f.store,77);assert.equal(attempts,2);assert.equal(row.notice.state,'sent');assert.equal(await rawRole(f.store,77),'moderator');
 assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);assert.equal((await f.store.records('staff_audit')).length,1);
 await roleNoticeTick(f.store,f.api,row.notice.retry_at||Date.now());assert.equal(attempts,2);
});

test('a role committed before a process interruption keeps a resumable unattempted notice',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const action=await grantDraft(f,OWNER_ID,77,'moderator');
 await f.db.run("CREATE TRIGGER fail_input_cleanup BEFORE UPDATE ON sjc_users WHEN OLD.id=77 BEGIN SELECT RAISE(ABORT,'interrupted after role commit'); END");
 await assert.rejects(handle(f,callback(OWNER_ID,action)),/interrupted after role commit/);
 assert.equal(await rawRole(f.store,77),'moderator');assert.equal((await roleRecord(f.store,77)).notice.state,'pending');assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,0);
 await f.db.run('DROP TRIGGER fail_input_cleanup');await roleNoticeTick(new Store(f.db),f.api);
 assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);assert.equal((await roleRecord(f.store,77)).notice.state,'sent');
 await handle(f,callback(OWNER_ID,action));assert.equal((await f.store.records('staff_audit')).length,1);assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);
});

test('unconfirmed role responses and interrupted sending claims never repeat; receipts cannot overwrite a newer role',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const send=f.api.sendMessage;let attempts=0;
 f.api.sendMessage=async p=>{if(p.chat_id===77){attempts++;return {};}return send(p);};
 await grant(f,OWNER_ID,77,'moderator');assert.equal((await roleRecord(f.store,77)).notice.state,'unconfirmed');
 await roleNoticeTick(f.store,f.api);assert.equal(attempts,1);
 await f.store.record('staff_role','77',{uid:77,role:'administrator',version:'interrupted',actor:{id:OWNER_ID},notice:{state:'sending',before:'moderator'}});
 await roleNoticeTick(f.store,f.api);assert.equal(attempts,1);
 await f.store.record('staff_role','77',{uid:77,role:'moderator',version:'old',actor:{id:OWNER_ID},notice:{state:'pending',before:'user'}});
 f.api.sendMessage=async p=>{if(p.chat_id===77){await f.store.record('staff_role','77',{uid:77,role:'administrator',version:'new',notice:{state:'pending',before:'moderator'}});return {message_id:999};}return send(p);};
 await deliverRoleNotice(f.store,f.api,77);const newer=await roleRecord(f.store,77);assert.equal(newer.role,'administrator');assert.equal(newer.version,'new');assert.equal(newer.notice.state,'pending');
});
