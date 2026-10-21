import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture as baseFixture,handle,callback,message} from './fixtures.js';
import {OWNER_ID,rawRole} from '../tgcloud/lib/permissions.js';
import {usersPanel,usersInput} from '../tgcloud/lib/staff.js';
import {renderImage} from '../tgcloud/lib/image-renderer.js';

async function fixture(){
 const f=await baseFixture();
 for(const name of ['sendMessage','sendPhoto','editMessageText']){const call=f.api[name];f.api[name]=async p=>{const result=await call(p);f.latestPanel=p;return result;};}
 return f;
}
const last=f=>f.latestPanel;
const buttons=f=>last(f).reply_markup.inline_keyboard.flat();
const actions=f=>buttons(f).map(b=>b.callback_data);
async function seed(f,uid,role='user'){
 await f.store.ensure(uid,uid);await f.store.captureUsername(uid,'person'+uid);
 if(role!=='user')await f.store.record('staff_role',uid,{uid,role,version:'seed'+uid});
}
test('one list entry, bounded pages, deterministic navigation and no catalog/API scans',async()=>{
 const f=await fixture();for(let uid=1;uid<=12;uid++)await seed(f,uid);
 f.api.getChat=async()=>{throw Error('Browsing must not contact Telegram');};
 f.store.jobs=async()=>{throw Error('Browsing must not load the catalog');};
 await handle(f,callback(OWNER_ID,'admin:users'));
 assert.equal(actions(f).filter(a=>a==='admin:people:0').length,1);
 for(const page of [0,1,2,999999]){
  await handle(f,callback(OWNER_ID,'admin:people:'+page));
  const shown=actions(f).filter(a=>a.startsWith('admin:people:view:'));
  assert.equal(shown.length,page<2?5:3); // Owner profile is also included.
  assert(shown.every(a=>a.endsWith(':'+Math.min(2,page))));
  assert.equal(new Set(actions(f)).size,actions(f).length);
  assert(actions(f).includes('admin:users'));assert(!actions(f).includes('admin'));
 }
 assert.deepEqual(actions(f).filter(a=>a.startsWith('admin:people:view:')),['admin:people:view:11:2','admin:people:view:12:2',`admin:people:view:${OWNER_ID}:2`]);
 await f.store.deleteUser(12);await handle(f,callback(OWNER_ID,'admin:people:view:12:2'));
 assert.match(last(f).text,/больше не найден/);assert.deepEqual(actions(f),['admin:people:2']);
});
test('forged user-list routes and persisted input cannot reveal profiles or grant privileges',async()=>{
 const f=await fixture();await seed(f,1,'moderator');await seed(f,2,'administrator');await seed(f,77);
 for(const uid of [3,1,2]){
  for(const action of ['admin:people:0','admin:people:find','admin:people:view:77:0','admin:people:ban:77','admin:people:role:77:administrator']){
   await handle(f,callback(uid,action));assert.doesNotMatch(last(f).text,/@person77/);
   assert(!actions(f).some(a=>a.startsWith('admin:people:')));
  }
  await f.store.patch(uid,{pending_input:'owner_user_find'});await handle(f,message(uid,'77'));
  assert.equal((await f.store.user(uid)).settings.pending_input,null);
 }
 for(const [uid,chat] of [[OWNER_ID,77],[77,OWNER_ID],[OWNER_ID,-100]]){
  const before=f.api.edited.length,c=callback(uid,'admin:people:view:77:0');c.callback_query.message.chat.id=chat;await handle(f,c);assert.equal(f.api.edited.length,before);
 }
 assert.equal(await rawRole(f.store,77),'user');assert(!await f.store.isBanned(77));assert.equal((await f.store.records('staff_audit')).length,0);
 assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,0);
});
test('find accepts known numeric IDs and verified usernames, rejects stale tags and supports cancel',async()=>{
 const f=await fixture();await seed(f,77);
 let lookups=0;f.api.getChat=async p=>{lookups++;return {id:p.chat_id,type:'private',username:p.chat_id===77?'person77':'other'};};
 for(const query of ['77','@person77']){
  await handle(f,callback(OWNER_ID,'admin:people:find'));await handle(f,message(OWNER_ID,query));assert.match(last(f).text,/@person77/);assert.equal((await f.store.user(OWNER_ID)).settings.pending_input,null);
 }
 assert(lookups>0);
 await handle(f,callback(OWNER_ID,'admin:people:find'));await handle(f,message(OWNER_ID,'999'));assert.match(last(f).text,/не найден/);
 f.api.getChat=async p=>({id:p.chat_id,type:'private',username:'reassigned'});
 await handle(f,message(OWNER_ID,'@person77'));assert.match(last(f).text,/не найден/);
 await handle(f,message(OWNER_ID,'1 OR 1=1'));assert.match(last(f).text,/не найден/);
 await handle(f,message(OWNER_ID,'/cancel'));assert.equal((await f.store.user(OWNER_ID)).settings.pending_input,null);
});
test('profile links reuse ban reason, confirmation, audit and exactly one user notice',async()=>{
 const f=await fixture();await seed(f,77);
 await handle(f,callback(OWNER_ID,'admin:people:view:77:0'));
 assert.equal(actions(f).filter(a=>a==='admin:people:ban:77').length,1);
 await handle(f,callback(OWNER_ID,'admin:people:ban:77'));assert.equal((await f.store.user(OWNER_ID)).settings.pending_input,'owner_ban_reason');
 assert.equal(await f.store.isBanned(77),false);
 await handle(f,message(OWNER_ID,'Спам'));const draft=(await f.store.user(OWNER_ID)).settings.ban_draft;
 assert(draft);assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,0);
 const confirmation='admin:bans:confirm:'+draft.token;
 const InputFile=class {constructor(bytes,name,options){Object.assign(this,{bytes,name,options});}};
 f.InputFile=InputFile;
 f.api.editMessageMedia=async p=>({message_id:p.message_id});
 const concurrent=await Promise.allSettled([handle(f,callback(OWNER_ID,confirmation)),handle(f,callback(OWNER_ID,confirmation))]);
 assert(concurrent.some(r=>r.status==='fulfilled'));
 assert(concurrent.filter(r=>r.status==='rejected').every(r=>/busy/.test(r.reason.message)));
 await handle(f,callback(OWNER_ID,confirmation));
 assert(await f.store.isBanned(77));assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);
 delete f.InputFile;
 await handle(f,callback(OWNER_ID,'admin:people:view:77:0'));
 assert.match(last(f).text,/Спам/);assert(!actions(f).some(a=>a.startsWith('admin:people:role:')));
 const unban=actions(f).find(a=>a.startsWith('admin:bans:remove:77:'));assert(unban);
 f.InputFile=InputFile;
 await handle(f,callback(OWNER_ID,unban));await handle(f,callback(OWNER_ID,unban));
 assert(!await f.store.isBanned(77));assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,2);
 assert.equal((await f.store.records('staff_audit')).length,2);
});
test('role links require confirmation and refresh existing team management without duplicate controls',async()=>{
 const f=await fixture();await seed(f,77);
 await handle(f,callback(OWNER_ID,'admin:people:role:77:moderator'));
 assert.equal(await rawRole(f.store,77),'user');const draft=(await f.store.user(OWNER_ID)).settings.staff_draft;assert(draft);
 const confirm='admin:team:confirm:'+draft.token;await handle(f,callback(OWNER_ID,confirm));await handle(f,callback(OWNER_ID,confirm));
 assert.equal(await rawRole(f.store,77),'moderator');assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);
 await handle(f,callback(OWNER_ID,'admin:people:view:77:0'));
 assert.equal(actions(f).filter(a=>a==='admin:team:view:77').length,1);assert(!actions(f).some(a=>a.startsWith('admin:people:role:')));
 await handle(f,callback(OWNER_ID,'admin:people:role:77:administrator'));assert.match(last(f).text,/изменились/);assert.equal(await rawRole(f.store,77),'moderator');
 await handle(f,callback(OWNER_ID,`admin:people:view:${OWNER_ID}:0`));assert(!actions(f).some(a=>/ban|role|team/.test(a)));
});
test('changed target state still prevents a pending role grant from bypassing a ban',async()=>{
 const f=await fixture();await seed(f,77);
 await handle(f,callback(OWNER_ID,'admin:people:role:77:administrator'));const draft=(await f.store.user(OWNER_ID)).settings.staff_draft;
 await f.store.record('user_ban',77,{uid:77,active:true,version:'race',reason:'Проверка'});
 await handle(f,callback(OWNER_ID,'admin:team:confirm:'+draft.token));assert.equal(await rawRole(f.store,77),'user');assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,0);
});
test('empty/deleted users, malformed callbacks and image rendering remain bounded and read only',async()=>{
 const f=await fixture(),panels=[],bot={store:f.store,uid:OWNER_ID,chat:OWNER_ID,readOnly:true,s:{},panel:async(text,rows)=>{panels.push({text,rows});}};
 await usersPanel(bot,'admin:people:0');assert.match(panels.at(-1).text,/пока нет/);
 await seed(f,77);await f.store.captureUsername(77,'a'.repeat(32));
 await f.store.record('user_ban',77,{active:true,reason:'<script>& '.repeat(35)});
 const before=await f.db.all('SELECT * FROM sjc_users');
 for(const action of ['admin:people:0','admin:people:view:77:0','admin:people:-1','admin:people:view:9007199254740993:0'])await usersPanel(bot,action);
 assert.deepEqual(await f.db.all('SELECT * FROM sjc_users'),before);
 for(const p of panels){assert(p.text.length<4096);assert(p.rows.flat().every(b=>b.callback_data.length<=64));const image=renderImage(p.text);assert(image.bytes.length<10000000);assert(image.width+image.height<=10000);}
 assert.equal(await usersInput(bot,{text:'/menu'}),false);
});
