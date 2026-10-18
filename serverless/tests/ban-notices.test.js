import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,message,callback } from './fixtures.js';
import { Store } from '../tgcloud/lib/store.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { banRecord,banVersion,banNoticeText,banNoticeTick,deliverBanNotice } from '../tgcloud/lib/bans.js';
class InputFile {constructor(bytes,name,options){Object.assign(this,{bytes,name,options});}}
async function graphics(){const f=await fixture();f.InputFile=InputFile;f.photos=[];f.api.editMessageMedia=async p=>({message_id:p.message_id});let mid=100;f.api.sendPhoto=async p=>{f.photos.push(p);return {message_id:++mid};};return f;}
const moderator={id:OWNER_ID,username:'ActualAdmin',first_name:'Иван',last_name:'<Тест>'};
function ownerCallback(action,actor=moderator){const u=callback(OWNER_ID,action);u.callback_query.from=actor;return u;}
async function draft(f,uid,reason='Спам и повторная публикация рекламы'){
 await handle(f,ownerCallback('admin:bans:new'));await handle(f,message(OWNER_ID,String(uid)));await handle(f,message(OWNER_ID,reason));
 return 'admin:bans:confirm:'+(await f.store.user(OWNER_ID)).settings.ban_draft.token;
}
async function ban(f,uid,reason,actor){const action=await draft(f,uid,reason);await handle(f,ownerCallback(action,actor));return action;}
async function unban(f,uid,actor=moderator){const row=await banRecord(f.store,uid),action=`admin:bans:remove:${uid}:${banVersion(row)}`;await handle(f,ownerCallback(action,actor));return action;}
const notices=f=>f.photos.filter(p=>p.photo?.name==='moderation.png');

test('ban and unban send one PNG each, escaped reason, actual moderator snapshots, and the fixed contact button',async()=>{
 const f=await graphics();await f.store.ensure(77,77);
 const reason='Спам <b>с рекламой</b> & повторы';const confirm=await ban(f,77,reason);
 let row=await banRecord(f.store,77);assert.equal(row.reason,reason);assert.deepEqual(row.actor,{id:OWNER_ID,username:'ActualAdmin',name:'Иван <Тест>'});assert.equal(row.by,OWNER_ID);
 let text=banNoticeText(row);assert.match(text,/@ActualAdmin/);assert.match(text,/Иван ·|Иван &lt;Тест&gt;/);assert.match(text,/&lt;b&gt;с рекламой&lt;\/b&gt; &amp;/);assert(!text.includes('@AngryVirus'));
 assert.equal(notices(f).length,1);const photo=notices(f)[0];assert.equal(photo.chat_id,77);assert(!photo.caption);assert.deepEqual([...photo.photo.bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(photo.reply_markup.inline_keyboard[0][0].url,'https://t.me/AngryVirus');
 await handle(f,ownerCallback(confirm));assert.equal(notices(f).length,1);
 const newActor={id:OWNER_ID,username:'DifferentAdmin',first_name:'Мария'};const remove=await unban(f,77,newActor);
 row=await banRecord(f.store,77);assert.equal(row.active,false);assert.deepEqual(row.ban_actor,{id:OWNER_ID,username:'ActualAdmin',name:'Иван <Тест>'});assert.deepEqual(row.actor,{id:OWNER_ID,username:'DifferentAdmin',name:'Мария'});text=banNoticeText(row);assert.match(text,/@ActualAdmin/);assert.match(text,/@DifferentAdmin/);assert.equal(notices(f).length,2);
 await handle(f,ownerCallback(remove,newActor));await handle(f,message(77,'/start'));await handle(f,message(77,'/start'));assert.equal(notices(f).length,2);assert.equal(await f.store.isBanned(77),false);
});
test('missing username falls back to the actual administrator name and numeric ID',async()=>{
 const f=await graphics();await f.store.ensure(77,77);await ban(f,77,'Нарушение правил',{id:OWNER_ID,first_name:'Админ без ника'});
 assert.match(banNoticeText(await banRecord(f.store,77)),/Админ без ника · ID 340780041/);
});
test('reason is mandatory, bounded and cancel invalidates the confirmation',async()=>{
 const f=await graphics();await handle(f,ownerCallback('admin:bans:new'));await handle(f,message(OWNER_ID,'77'));
 for(const reason of [' ','x'.repeat(301)]){await handle(f,message(OWNER_ID,reason));assert.equal(await banRecord(f.store,77),null);assert.equal((await f.store.user(OWNER_ID)).settings.pending_input,'owner_ban_reason');}
 await handle(f,message(OWNER_ID,'Спам'));const action='admin:bans:confirm:'+(await f.store.user(OWNER_ID)).settings.ban_draft.token;
 await handle(f,message(OWNER_ID,'/cancel'));await handle(f,ownerCallback(action));assert.equal(await f.store.isBanned(77),false);assert.equal(notices(f).length,0);
});
test('pre-ban waits for first private contact, delivers once and then ignores messages and callbacks',async()=>{
 const f=await graphics();await ban(f,77);assert.equal(notices(f).length,0);assert.equal(await f.store.user(77),null);
 let acknowledgements=0;f.api.answerCallbackQuery=async()=>{acknowledgements++;};
 await handle(f,message(77,'/start'));assert.equal(notices(f).length,1);assert.equal(await f.store.user(77),null);
 await handle(f,message(77,'hello'));await handle(f,callback(77,'menu'));assert.equal(notices(f).length,1);assert.equal(acknowledgements,0);
});
test('latest decision supersedes undelivered ban; first contact receives only the unban notice',async()=>{
 const f=await graphics();await ban(f,77);await unban(f,77);assert.equal(notices(f).length,0);
 await handle(f,message(77,'/start'));assert.equal(notices(f).length,1);assert.match(banNoticeText(await banRecord(f.store,77)),/Доступ к боту восстановлен/);
 await handle(f,message(77,'/start'));assert.equal(notices(f).length,1);
});
test('parallel workers and a restarted Store cannot send the same notice twice',async()=>{
 const f=await graphics();await ban(f,77);await f.store.ensure(77,77);
 await Promise.all([banNoticeTick(f.store,f.api,InputFile),banNoticeTick(new Store(f.db),f.api,InputFile)]);
 await banNoticeTick(new Store(f.db),f.api,InputFile);assert.equal(notices(f).length,1);assert.equal((await banRecord(f.store,77)).notice.state,'sent');
});
test('ambiguous timeout and interrupted sending claims are never replayed',async()=>{
 const f=await graphics();await f.store.ensure(77,77);let attempts=0;const send=f.api.sendPhoto;f.api.sendPhoto=async p=>{if(p.chat_id!==77)return send(p);attempts++;throw Error('Timeout with private contents');};
 await ban(f,77);assert.equal((await banRecord(f.store,77)).notice.state,'uncertain');
 await banNoticeTick(new Store(f.db),f.api,InputFile);await handle(f,message(77,'/start'));assert.equal(attempts,1);assert(!JSON.stringify(await banRecord(f.store,77)).includes('private contents'));
 const row=await banRecord(f.store,77);await f.store.record('user_ban','77',{...row,notice:{state:'sending'}});await banNoticeTick(f.store,f.api,InputFile);await handle(f,message(77,'/start'));assert.equal(attempts,1);
});
test('explicit 429 honors retry_after and latest state replaces queued notifications',async()=>{
 const f=await graphics();await f.store.ensure(77,77);const send=f.api.sendPhoto;let limited=true;
 f.api.sendPhoto=async p=>{if(p.chat_id===77&&limited)throw {code:429,parameters:{retry_after:120}};return send(p);};
 const now=Date.now();await ban(f,77);const row=await banRecord(f.store,77);assert(row.notice.retry_at>=now+120000);assert.equal(notices(f).length,0);
 limited=false;await banNoticeTick(f.store,f.api,InputFile,row.notice.retry_at-1);assert.equal(notices(f).length,0);
 await Promise.all([banNoticeTick(f.store,f.api,InputFile,row.notice.retry_at),banNoticeTick(f.store,f.api,InputFile,row.notice.retry_at)]);assert.equal(notices(f).length,1);
});
test('403 is retried only on genuine private contact; a forged chat cannot trigger delivery',async()=>{
 const f=await graphics();await f.store.ensure(77,77);let blocked=true,attempts=0;const send=f.api.sendPhoto;
 f.api.sendPhoto=async p=>{if(p.chat_id===77){attempts++;if(blocked)throw {code:403,description:'Forbidden: bot was blocked by the user'};}return send(p);};
 await ban(f,77);assert.equal((await banRecord(f.store,77)).notice.state,'blocked');await banNoticeTick(f.store,f.api,InputFile);assert.equal(attempts,1);
 blocked=false;const forged=callback(77,'menu');forged.callback_query.message.chat.id=OWNER_ID;await handle(f,forged);assert.equal(attempts,1);
 await handle(f,message(77,'/start'));await handle(f,message(77,'/start'));assert.equal(attempts,2);assert.equal(notices(f).length,1);
});
test('old unban and ban confirmations cannot change a newer decision or send stale notices',async()=>{
 const f=await graphics();await f.store.ensure(77,77);const oldConfirm=await ban(f,77,'Причина 1'),oldRemove=await unban(f,77);
 await ban(f,77,'Причина 2');const before=notices(f).length;
 await handle(f,ownerCallback(oldRemove));await handle(f,ownerCallback(oldConfirm));assert.equal(await f.store.isBanned(77),true);assert.equal((await banRecord(f.store,77)).reason,'Причина 2');assert.equal(notices(f).length,before);
});
test('legacy bans stay active without retroactive notices; unban uses a version and correct legacy author ID',async()=>{
 const f=await graphics();await f.store.ensure(77,77);await f.store.record('user_ban','77',{uid:77,at:'2026-10-18'});
 await handle(f,message(77,'/start'));assert.equal(notices(f).length,0);assert.equal(await f.store.isBanned(77),true);
 await unban(f,77);assert.equal(notices(f).length,1);assert.match(banNoticeText(await banRecord(f.store,77)),/ID 340780041/);
 await f.store.deleteUser(77);assert.equal(await banRecord(f.store,77),null);
});
test('forged owner identity cannot confirm an existing draft or deliver a moderation notice',async()=>{
 const f=await graphics();await f.store.ensure(77,77);const action=await draft(f,77);
 for(const [uid,chat] of [[1,1],[1,OWNER_ID],[OWNER_ID,1]]){const u=callback(uid,action);u.callback_query.message.chat.id=chat;await handle(f,u);assert.equal(await f.store.isBanned(77),false);}
 assert.equal(notices(f).length,0);
});

test('username lookup supports known and legacy profiles, case-insensitive tags and final ID verification',async()=>{
 const f=await graphics();await f.store.ensure(77,77);
 f.api.getChat=async({chat_id})=>({id:chat_id,type:'private',username:chat_id===77?'KnownPerson':'OtherPerson'});
 await handle(f,ownerCallback('admin:bans:new'));await handle(f,message(OWNER_ID,'@kNoWnPeRsOn'));
 assert.equal((await f.store.user(OWNER_ID)).settings.ban_target,77);
 await handle(f,message(OWNER_ID,'Спам'));const draft=(await f.store.user(OWNER_ID)).settings.ban_draft;assert.equal(draft.uid,77);
 await handle(f,ownerCallback('admin:bans:confirm:'+draft.token));assert.equal(await f.store.isBanned(77),true);assert.equal(notices(f).length,1);
});
test('changed, unknown or ambiguous usernames cannot silently ban the cached account',async()=>{
 const f=await graphics();await f.store.ensure(77,77);await f.store.captureUsername(77,'KnownPerson');
 let current='KnownPerson';f.api.getChat=async({chat_id})=>({id:chat_id,type:'private',username:chat_id===77?current:'OtherPerson'});
 await handle(f,ownerCallback('admin:bans:new'));await handle(f,message(OWNER_ID,'@KnownPerson'));await handle(f,message(OWNER_ID,'Спам'));
 const action='admin:bans:confirm:'+(await f.store.user(OWNER_ID)).settings.ban_draft.token;
 current='ChangedPerson';await handle(f,ownerCallback(action));assert.equal(await f.store.isBanned(77),false);assert.equal(notices(f).length,0);
 await handle(f,ownerCallback('admin:bans:new'));await handle(f,message(OWNER_ID,'@KnownPerson'));assert.equal((await f.store.user(OWNER_ID)).settings.pending_input,'owner_ban');
 await f.store.ensure(78,78);await f.store.captureUsername(78,'KnownPerson');f.api.getChat=async({chat_id})=>({id:chat_id,type:'private',username:'KnownPerson'});
 await handle(f,message(OWNER_ID,'@KnownPerson'));assert.equal((await f.store.user(OWNER_ID)).settings.pending_input,'owner_ban');
});
test('incoming verified Telegram metadata refreshes and clears a user username',async()=>{
 const f=await fixture();let u=message(77,'/start');u.message.from.username='KnownPerson';await handle(f,u);assert.equal((await f.store.user(77)).telegram_username,'KnownPerson');
 u=message(77,'/start');u.message.from.username='NewPerson';await handle(f,u);assert.equal((await f.store.user(77)).telegram_username,'NewPerson');
 await handle(f,message(77,'/start'));assert.equal((await f.store.user(77)).telegram_username,null);
});
