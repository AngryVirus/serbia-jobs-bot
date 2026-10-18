import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handle,message,callback} from './fixtures.js';
import {OWNER_ID} from '../tgcloud/lib/permissions.js';

test('accepted commands and ban input are deleted only after the result is committed; preview has no contact link',async()=>{
 const f=await fixture(),deleted=[];
 f.api.deleteMessage=async p=>{const row=await f.db.get('SELECT state FROM sjc_updates WHERE key=:key',{':key':'u:'+p.message_id});assert.equal(row.state,'done');deleted.push(p.message_id);};
 const start=message(OWNER_ID,'/start');await handle(f,start);
 await handle(f,callback(OWNER_ID,'admin:bans:new'));
 const id=message(OWNER_ID,'77'),reason=message(OWNER_ID,'Спам');await handle(f,id);await handle(f,reason);
 assert.deepEqual(deleted,[start.update_id,id.update_id,reason.update_id]);
 assert.equal((await f.store.user(OWNER_ID)).settings.ban_draft.reason,'Спам');
 const preview=f.api.sent.at(-1);assert(!preview.reply_markup.inline_keyboard.flat().some(b=>b.url));
 assert(preview.reply_markup.inline_keyboard.flat().some(b=>b.callback_data?.startsWith('admin:bans:confirm:')));
});
test('photo draft and caption remain usable after incoming photo deletion; no campaign is started',async()=>{
 const f=await fixture();await handle(f,callback(OWNER_ID,'ads:new'));
 const u=message(OWNER_ID,'');delete u.message.text;u.message.photo=[{file_id:'saved-photo'}];u.message.caption='Сохранённая подпись';
 let deleted=0;f.api.deleteMessage=async()=>{const draft=await f.store.meta('ad_draft');assert.equal(draft.photo,'saved-photo');assert.equal(draft.text,'Сохранённая подпись');deleted++;};
 await handle(f,u);assert.equal(deleted,1);assert.equal((await f.store.records('ad_campaign')).length,0);
});
test('cleanup failure leaves completed action intact; duplicate retries only deletion',async()=>{
 const f=await fixture(),u=message(77,'/start');let attempts=0;
 f.api.deleteMessage=async()=>{attempts++;throw {code:403};};await handle(f,u);
 const responses=f.api.sent.length;assert.equal((await f.db.get('SELECT state FROM sjc_updates WHERE key=:key',{':key':'u:'+u.update_id})).state,'done');
 await handle(f,u);assert.equal(attempts,2);assert.equal(f.api.sent.length,responses);
});
test('failed processing, callbacks, group messages and muted banned messages are not deleted',async()=>{
 const f=await fixture();let deleted=0;f.api.deleteMessage=async()=>{deleted++;};
 const send=f.api.sendMessage;f.api.sendMessage=async()=>{throw Error('transport failed');};await assert.rejects(handle(f,message(77,'/start')),/transport failed/);assert.equal(deleted,0);f.api.sendMessage=send;
 await handle(f,callback(77,'menu'));const group=message(77,'/start');group.message.chat.type='group';await handle(f,group);
 await f.store.record('user_ban','78',{uid:78,at:'2026-10-18'});await handle(f,message(78,'hello'));assert.equal(deleted,0);
});
