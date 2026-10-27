import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handle,message,callback,job} from './fixtures.js';
import {savedSearches} from '../tgcloud/lib/searches.js';
const panel=f=>f.api.edited.at(-1)||f.api.sent.filter(p=>p.chat_id===1).at(-1);
const buttons=f=>panel(f).reply_markup.inline_keyboard.flat();
const action=(f,part)=>buttons(f).find(b=>b.text.includes(part))?.callback_data;
async function save(f,name){await handle(f,callback(1,'plans'));await handle(f,callback(1,'plans:create'));await handle(f,message(1,name));return savedSearches((await f.store.user(1)).settings).at(-1);}

test('ordinary entry stays simple and saving a named search survives a failed response without duplication',async()=>{
 const f=await fixture();await handle(f,message(1,'/start'));
 assert.equal(f.api.sent.at(-1).reply_markup.inline_keyboard.flat().length,4);assert(!JSON.stringify(f.api.sent.at(-1)).includes('plans'));
 await f.store.patch(1,{keywords:['повар']});await handle(f,callback(1,'library'));assert(buttons(f).some(b=>b.callback_data==='plans'));
 await handle(f,callback(1,'plans'));await handle(f,callback(1,'plans:create'));
 const update=message(1,'Кухня Белграда'),send=f.api.sendMessage;let fail=true;
 f.api.sendMessage=async p=>{if(fail&&p.chat_id===1&&p.text.includes('Кухня Белграда')){fail=false;throw {code:429};}return send(p);};
 await assert.rejects(handle(f,update));const first=savedSearches((await f.store.user(1)).settings)[0];assert(first);
 await handle(f,update);const plans=savedSearches((await f.store.user(1)).settings);assert.equal(plans.length,1);assert.equal(plans[0].id,first.id);assert.deepEqual(plans[0].filters.keywords,['повар']);
 assert.equal((await f.store.user(1)).settings.pending_input,null);
});

test('saved result news and complaint navigation keep the saved scope independently from current filters',async()=>{
 const f=await fixture();await handle(f,message(1,'/start'));await f.store.putJob(job(1,{title:'Повар'}),true);await f.store.putJob(job(2,{title:'Водитель',description:'Нужен водитель для доставки'}),true);
 await f.store.patch(1,{keywords:['повар']});const plan=await save(f,'Кухня');await f.store.patch(1,{keywords:['водитель']});
 await handle(f,callback(1,`plans:open:${plan.id}`));assert.match(panel(f).text,/Поиск: Кухня/);assert(!buttons(f).some(b=>b.text.includes('С прошлого просмотра')));
 await handle(f,callback(1,'search:0'));assert.match(panel(f).text,/Водитель/);
 await f.store.putJob(job(3,{title:'Повар новой кухни'}),true);await f.store.putJob(job(4,{title:'Водитель новой смены',description:'Нужен водитель для доставки'}),true);
 await handle(f,callback(1,`plans:open:${plan.id}`));await handle(f,callback(1,action(f,'С прошлого просмотра')));assert.match(panel(f).text,/Повар новой кухни/);assert.match(panel(f).text,/Новое с прошлого просмотра/);
 await handle(f,callback(1,action(f,'Действия')));await handle(f,callback(1,action(f,'Проблема')));const report=action(f,'Пожаловаться');assert.match(report,/:s:[a-z0-9]{8}$/);
 const token=report.split(':').at(-1);await handle(f,callback(1,report));assert(buttons(f).some(b=>b.callback_data.startsWith(`discover:${token}:`)));
 await handle(f,callback(1,buttons(f).find(b=>b.callback_data.includes(':outdated:')).callback_data));
 const proceed=action(f,'Продолжить поиск');assert(proceed.startsWith(`discover:${token}:`));await handle(f,callback(1,proceed));assert.match(panel(f).text,/Новых вакансий с прошлого просмотра нет/);
 assert.deepEqual((await f.store.user(1)).settings.keywords,['водитель']);
});

test('leaving deletion confirmation invalidates it, and deleted searches cannot reopen from old result buttons',async()=>{
 const f=await fixture();await handle(f,message(1,'/start'));await f.store.putJob(job(1),true);const plan=await save(f,'Работа');
 await handle(f,callback(1,`plans:open:${plan.id}`));const old=action(f,'Действия');
 await handle(f,callback(1,`plans:delete:${plan.id}`));let confirm=action(f,'Подтвердить');await handle(f,callback(1,'menu'));await handle(f,callback(1,confirm));assert.equal(savedSearches((await f.store.user(1)).settings).length,1);
 await handle(f,callback(1,`plans:delete:${plan.id}`));confirm=action(f,'Подтвердить');await handle(f,callback(1,confirm));assert.equal(savedSearches((await f.store.user(1)).settings).length,0);
 await handle(f,callback(1,old));assert.match(panel(f).text,/подборка устарела/);
});

test('saved search panels edit PNG in place and result cards remain text',async()=>{
 const f=await fixture();class InputFile{constructor(bytes,name){this.bytes=bytes;this.name=name;}}f.InputFile=InputFile;
 let next=100,photos=0,edits=0;f.api.sendPhoto=async p=>{photos++;assert(p.photo instanceof InputFile);assert.deepEqual([...p.photo.bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);return {message_id:++next,photo:[{file_id:'png-'+next}]};};
 f.api.editMessageMedia=async p=>{edits++;return {message_id:p.message_id,photo:[{file_id:'edited-png'}]};};f.api.deleteMessage=async()=>{};
 await handle(f,message(1,'/start'));await handle(f,callback(1,'filters'));await handle(f,callback(1,'plans'));await handle(f,callback(1,'plans:create'));
 const before=photos;await handle(f,message(1,'Поиск в Сербии'));assert.equal(photos,before);assert(edits>=4);assert.equal((await f.store.user(1)).settings.ui_panel_kind,'photo');
 await f.store.putJob(job(1),true);const id=savedSearches((await f.store.user(1)).settings)[0].id;const open=callback(1,`plans:open:${id}`);open.callback_query.message.photo=[{file_id:'edited-png'}];open.callback_query.message.message_id=(await f.store.user(1)).settings.ui_panel_id;await handle(f,open);assert.equal((await f.store.user(1)).settings.ui_panel_kind,'text');assert.match(f.api.sent.at(-1).text,/Вакансия 1 из 1/);
});
