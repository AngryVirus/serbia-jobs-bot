import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fixture,callback,message,job } from './fixtures.js';
import { Bot } from '../tgcloud/lib/bot.js';
import { renderImage,imageHash,imageDocument,categoryIcon } from '../tgcloud/lib/image-renderer.js';
import { CODEC_SOURCE } from '../tgcloud/lib/image-codec.js';
import { defaults } from '../tgcloud/lib/filters.js';
import { filtersPanel,choicePanel,summary,vacancyPresentation,vacancyVisual } from '../tgcloud/lib/ui.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { administer,notifyOne } from '../tgcloud/lib/admin.js';

class InputFile {constructor(bytes,name,options){this.bytes=bytes;this.name=name;this.options=options;}}
async function graphics(){
 const f=await fixture(),state={next:100,sends:[],edits:[],deleted:[],messages:new Map(),last:null};
 f.InputFile=InputFile;f.graphics=state;
 const photo=p=>({message_id:p.message_id,caption:p.caption || '',reply_markup:p.reply_markup,chat:{id:p.chat_id,type:'private'},photo:[{file_id:typeof p.photo==='string'?p.photo:'file-'+imageHash(String(p.photo.bytes.length)+':'+imageHash([...p.photo.bytes.slice(-1000)].join(',')))}]});
 f.api.sendPhoto=async p=>{assert.equal(p.parse_mode,'HTML');state.sends.push({...p,kind:'photo'});const m=photo({...p,message_id:++state.next});state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.editMessageMedia=async p=>{assert.equal(p.media.type,'photo');assert.equal(p.media.parse_mode,'HTML');state.edits.push(p);const m=photo({...p,caption:p.media.caption,photo:p.media.media});state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.sendMessage=async p=>{state.sends.push({...p,kind:'text'});const m={message_id:++state.next,text:p.text,reply_markup:p.reply_markup,chat:{id:p.chat_id,type:'private'}};state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.editMessageText=async p=>{if(state.messages.get(p.message_id)?.photo)throw {code:400,description:'There is no text in the message to edit'};state.edits.push(p);const m={message_id:p.message_id,text:p.text,reply_markup:p.reply_markup,chat:{id:p.chat_id,type:'private'}};state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.deleteMessage=async p=>{state.deleted.push(p.message_id);state.messages.delete(p.message_id);};
 f.api.editMessageReplyMarkup=async()=>{};
 return f;
}
async function click(f,uid,data){const update=callback(uid,data);if(f.graphics.last)update.callback_query.message={...f.graphics.last};await new Bot(f).handle(update);return update;}
async function text(f,uid,value){await new Bot(f).handle(message(uid,value));}

test('experience has a vector icon and NEW is an image badge, never a duplicate text heading',()=>{
 const j=job(1,{_is_new:true,_cloud:{...job(1)._cloud,experience:true}});
 const visual=vacancyVisual(vacancyPresentation(j,'s'),'Вакансия 2 из 5\n');
 assert.equal(categoryIcon('Опыт: требуется'),'briefcase');
 const doc=imageDocument(visual.text);assert(doc.badge);assert(doc.title.includes('Повар'));
 assert(!doc.lines.some(x=>x.text==='NEW'));assert.equal(renderImage(visual.text).badge,true);
 assert(!visual.caption.includes('NEW'));
 const old=vacancyPresentation({...j,_is_new:false},'s');assert.equal(renderImage(old.image).badge,false);
 assert(renderImage(visual.text).icons>renderImage(vacancyPresentation({...j,_cloud:{...j._cloud,experience:null}},'s').image).icons);
});

test('PNG is valid, Cyrillic text is local, hashes are SHA-256 and codec matches the lock',()=>{
 for(const s of ['','abc','Белград 🪪'])assert.equal(imageHash(s),createHash('sha256').update(s).digest('hex'));
 const result=renderImage(filtersPanel({...defaults(),city:['belgrade']})[0]);
 assert.deepEqual([...result.bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);
 let offset=8,data=[];while(offset<result.bytes.length){const n=(result.bytes[offset]*2**24+result.bytes[offset+1]*65536+result.bytes[offset+2]*256+result.bytes[offset+3]);const type=String.fromCharCode(...result.bytes.slice(offset+4,offset+8));if(type==='IDAT')data.push(result.bytes.slice(offset+8,offset+8+n));offset+=12+n;}
 assert.equal(inflateSync(Buffer.concat(data)).length,(result.width*3+1)*result.height);
 assert(imageDocument('<b>⚙️ Фильтры</b>\n&lt;Повар&gt; &amp; Šef').lines[0].text.includes('<Повар> & Šef'));
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
 assert.equal(CODEC_SOURCE,'pako@'+pkg.devDependencies.pako);
 assert(result.bytes.length<500000);
});
test('image changes with settings, handles maximum valid keyword lists and multi-selection',()=>{
 const a=filtersPanel(defaults())[0],b=filtersPanel({...defaults(),city:['belgrade','novi_sad'],language:['russian','serbian']})[0];
 assert.notEqual(imageHash(a),imageHash(b));assert.notDeepEqual(renderImage(a).bytes,renderImage(b).bytes);
 const words=Array.from({length:15},()=> 'W'.repeat(60));
 const large=renderImage(filtersPanel({...defaults(),keywords:words,exclusions:words})[0]);
 assert(large.width+large.height<=10000);assert(large.bytes.length<10000000);
 for(const field of ['city','remote','language','freshness','residence_permit'])assert(renderImage(choicePanel(defaults(),field)[0]).bytes.length>0);
});
test('start, settings choices, reset and persisted text input are image-only and edit the same message',async()=>{
 const f=await graphics();await text(f,1,'/start');const id=f.graphics.last.message_id;
 assert.equal(f.graphics.sends.length,1);assert.equal(f.graphics.sends[0].kind,'photo');
 await click(f,1,'filters');await click(f,1,'city');await click(f,1,'choose:city:belgrade:1');
 assert.equal(f.graphics.last.message_id,id);assert((await f.store.user(1)).settings.city.includes('belgrade'));
 await click(f,1,'input:keywords');await text(f,1,'повар, chef');
 assert.equal(f.graphics.last.message_id,id);assert.deepEqual((await f.store.user(1)).settings.keywords,['повар','chef']);
 await click(f,1,'reset');assert.deepEqual((await f.store.user(1)).settings.keywords,[]);
 assert.equal(f.graphics.sends.length,1);assert(f.graphics.edits.every(p=>p.media && !p.text));
});
test('short vacancies are images with contact-only captions; full details are text and replace the panel',async()=>{
 const f=await graphics();await f.store.putJob(job(1,{contacts:['contact@example.com']}),true);await text(f,1,'/start');const imageId=f.graphics.last.message_id;
 await click(f,1,'search:0');assert(f.graphics.last.photo);assert.equal(f.graphics.last.caption,'✉️ contact@example.com');assert.doesNotMatch(f.graphics.last.caption,/href=|Повар|Вакансия/);
 assert.equal(f.graphics.last.message_id,imageId);
 await click(f,1,'job:1:full');assert(f.graphics.last.text.includes('Нужен повар'));assert(f.graphics.deleted.includes(imageId));
 const textId=f.graphics.last.message_id;
 await click(f,1,'job:1:short');assert(f.graphics.last.photo);assert.equal(f.graphics.last.message_id,textId);
 await click(f,1,'menu');assert.equal(f.graphics.last.caption,'');assert.equal(f.graphics.messages.size,1);
});
test('file_id cache is private, bounded, does not contain text, and invalid files are regenerated',async()=>{
 const f=await graphics();await text(f,1,'/start');await click(f,1,'filters');await click(f,1,'menu');
 assert.equal(typeof f.graphics.edits.at(-1).media.media,'string');
 const records=await f.store.records('menu_image');assert(records.every(r=>!r.text && r.file_id && r.expires));
 const edit=f.api.editMessageMedia;let failed=false;
 f.api.editMessageMedia=async p=>{if(typeof p.media.media==='string'&&!failed){failed=true;throw {code:400,description:'Wrong file identifier/HTTP URL specified'};}return edit(p);};
 await click(f,1,'menu');assert(failed);assert(f.graphics.edits.at(-1).media.media instanceof InputFile);
 f.graphics.last=null;await text(f,2,'/start');assert(f.graphics.sends.at(-1).photo instanceof InputFile);
 for(let i=0;i<32;i++){const bot=new Bot(f);bot.uid=1;bot.chat=1;bot.s=(await f.store.user(1)).settings;bot.mid=f.graphics.last.message_id;await bot.panel('Тест экрана '+i,[]);}
 const n=await f.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='menu_image' AND record_key LIKE '1:%'");assert.equal(n.n,30);
});
test('duplicate callbacks are suppressed and ambiguous/429 image edits never send a fallback message',async()=>{
 const f=await graphics();await text(f,1,'/start');const update=await click(f,1,'filters'),before=f.graphics.edits.length;
 await new Bot(f).handle(update);assert.equal(f.graphics.edits.length,before);
 for(const error of [{code:429,parameters:{retry_after:5}},new Error('Timeout')]) {
  f.api.editMessageMedia=async()=>{throw error;};const sent=f.graphics.sends.length;
  await assert.rejects(click(f,1,'menu'));assert.equal(f.graphics.sends.length,sent);
 }
});
test('deleting a user removes image cache and does not recreate their record while acknowledging',async()=>{
 const f=await graphics();await text(f,1,'/start');await click(f,1,'delete');await click(f,1,'delete_confirm');
 assert.equal(await f.store.user(1),null);
 assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='menu_image' AND record_key LIKE '1:%'")).n,0);
});
test('production audit and owner-only preview render and edit without changing filters',async()=>{
 const f=await graphics();await f.store.ensure(OWNER_ID,OWNER_ID);await f.store.patch(OWNER_ID,{city:['novi_sad'],keywords:['chef']});
 const before=(await f.store.user(OWNER_ID)).settings;
 await assert.rejects(administer({operation:'menu_image_preview'},{initData:'forged'},f),/Owner CLI/);
 const audit=await administer({operation:'menu_image_audit'},{ownerRun:true},f);assert.equal(audit.rendered,3);assert.equal(audit.home_buttons,4);assert.equal(audit.filter_buttons,6);
 const preview=await administer({operation:'menu_image_preview'},{ownerRun:true},f);assert.equal(preview.edited_in_place,3);
 assert(f.graphics.sends.every(p=>p.chat_id===OWNER_ID));
 const after=(await f.store.user(OWNER_ID)).settings;assert.deepEqual(after.city,before.city);assert.deepEqual(after.keywords,before.keywords);
});

test('all reachable user menu and vacancy controls remain usable with image transport',async()=>{
 const f=await graphics();await f.store.putJob(job(1),true);await f.store.putJob(job(2),true);
 f.fetch=async()=>({ok:true,json:async()=>[[['Переведённый текст']]]});
 await text(f,1,'/start');const queue=['menu','notifications','delete'],seen=new Set();
 while(queue.length){
  const action=queue.shift(),route=action.replace(/:[a-z0-9]{8}(?=:|$)/g,':TOKEN');if(seen.has(route))continue;seen.add(route);
  await f.db.run("DELETE FROM sjc_records WHERE kind='rate'");
  await click(f,1,action);
  const last=f.graphics.last;assert(last?.photo || last?.text,action);
  for(const b of last.reply_markup?.inline_keyboard.flat() || [])if(b.callback_data && b.callback_data!=='delete_confirm')queue.push(b.callback_data);
  assert(seen.size<200);
 }
 assert(seen.size>40);
});

test('filter categories have distinct local vector icons and retain readable wrapped values',async()=>{
 const {categoryIcon,IMAGE_VERSION}=await import('../tgcloud/lib/image-renderer.js');
 const content='<b>Условия</b>\n'+summary(defaults()),document=imageDocument(content);
 const labels=document.lines.filter(l=>l.bold&&l.text.includes(':'));
 assert.equal(labels.length,9);assert(labels.every(l=>categoryIcon(l.text)));
 assert.equal(new Set(labels.map(l=>categoryIcon(l.text))).size,8);
 assert.equal(categoryIcon('Произвольный текст: значение'),null);
 assert.match(IMAGE_VERSION,/v3/);assert.equal(renderImage(content).icons,9);
});

test('commands replace the previous screen; older buttons use the current screen without deleting notices',async()=>{
 const f=await graphics();await text(f,1,'/start');const first=f.graphics.last;
 for(const command of ['/menu','/start','/strat','/help']){
  const before=f.graphics.last.message_id;await text(f,1,command);assert.notEqual(f.graphics.last.message_id,before);assert(f.graphics.deleted.includes(before));assert.equal(f.graphics.messages.size,1);
 }
 const current=f.graphics.last.message_id,u=callback(1,'filters');u.callback_query.message=first;await new Bot(f).handle(u);assert.equal(f.graphics.last.message_id,current);assert.equal(f.graphics.messages.size,1);
 const notice=await f.api.sendMessage({chat_id:1,text:'Найдены новые вакансии',reply_markup:{inline_keyboard:[]}});
 await text(f,1,'/menu');assert(f.graphics.messages.has(notice.message_id));assert(!f.graphics.messages.has(current));
});
test('View in a notification opens at the tapped message, not in the old menu above it',async()=>{
 const f=await graphics();await text(f,1,'/start');const old=f.graphics.last.message_id;
 await f.store.patch(1,{notifications:'instant',notifications_after_id:0});await f.store.putJob(job(1),true);
 await notifyOne(f.store,f.api,1);const notice=f.graphics.last;
 const action=notice.reply_markup.inline_keyboard[0][0].callback_data;
 await click(f,1,action);
 assert.equal(f.graphics.last.message_id,notice.message_id);
 assert(f.graphics.last.photo);assert(f.graphics.deleted.includes(old));
 assert(f.graphics.last.reply_markup.inline_keyboard.flat().some(b=>b.callback_data?.startsWith('discover:')));
 assert.equal(f.graphics.messages.size,1);
});
test('notification retry after 429 keeps its target and selection without deleting either message early',async()=>{
 const f=await graphics();await text(f,1,'/start');const old=f.graphics.last.message_id;
 await f.store.patch(1,{notifications:'instant',notifications_after_id:0});await f.store.putJob(job(1),true);
 await notifyOne(f.store,f.api,1);const notice=f.graphics.last,update=callback(1,notice.reply_markup.inline_keyboard[0][0].callback_data);
 update.callback_query.message=notice;
 const edit=f.api.editMessageMedia;let once=true;
 f.api.editMessageMedia=async p=>{if(once){once=false;throw {code:429,parameters:{retry_after:1}};}return edit(p);};
 await assert.rejects(new Bot(f).handle(update));
 assert(f.graphics.messages.has(old));assert(f.graphics.messages.has(notice.message_id));
 const token=(await f.store.user(1)).settings.discovery_current;
 await new Bot(f).handle(update);
 assert.equal(f.graphics.last.message_id,notice.message_id);assert.equal((await f.store.user(1)).settings.discovery_current,token);
 assert.equal(f.graphics.messages.size,1);
 const sends=f.graphics.sends.length;await new Bot(f).handle(update);assert.equal(f.graphics.sends.length,sends);
});
test('a notification that cannot be edited gets a visible replacement and unrelated notices survive',async()=>{
 const f=await graphics();await text(f,1,'/start');const old=f.graphics.last.message_id;
 const unrelated=await f.api.sendMessage({chat_id:1,text:'Другое уведомление'});
 await f.store.patch(1,{notifications:'instant',notifications_after_id:0});await f.store.putJob(job(1),true);
 await notifyOne(f.store,f.api,1);const notice=f.graphics.last;
 f.api.editMessageMedia=async()=>{throw {code:400,description:"message can't be edited"};};
 await click(f,1,notice.reply_markup.inline_keyboard[0][0].callback_data);
 assert(f.graphics.last.message_id>notice.message_id);assert(f.graphics.last.photo);
 assert(!f.graphics.messages.has(old));assert(!f.graphics.messages.has(notice.message_id));assert(f.graphics.messages.has(unrelated.message_id));
});
test('expired View and notification stop both respond on the tapped notification',async()=>{
 for(const action of ['notice:missingnotice123','notify:stop']){
  const f=await graphics();await text(f,1,'/start');const old=f.graphics.last.message_id;
  await f.store.patch(1,{notifications:'instant'});
  const notice=await f.api.sendMessage({chat_id:1,text:'Новые вакансии',reply_markup:{inline_keyboard:[[{text:'Кнопка',callback_data:action}]]}});
  await click(f,1,action);assert.equal(f.graphics.last.message_id,notice.message_id);assert(!f.graphics.messages.has(old));
  if(action==='notify:stop')assert.equal((await f.store.user(1)).settings.notifications,'off');
  else assert(f.graphics.last.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='search:0'));
 }
});
test('review screens render stars locally, hide public author details and keep publication controls',async()=>{
 const {submitReview,decideReview}=await import('../tgcloud/lib/ratings.js');
 const f=await graphics();await f.store.putJob(job(1),true);await f.store.ensure(77,77);
 const actor={store:f.store,api:f.api,uid:77,chat:77,actor:{id:77,name:'Автор',username:'PrivateAuthor'}};
 assert(await submitReview(actor,{job_id:1,stars:2,token:'drafttoken12'},'Мой опыт собеседования.'));
 const [review]=await f.store.records('vacancy_review');
 await text(f,OWNER_ID,'/admin');await click(f,OWNER_ID,`admin:ratings:view:${review.key}`);
 assert(f.graphics.last.photo);assert(f.graphics.last.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`admin:ratings:p:${review.key}:${review.version}`));
 assert(await decideReview({...actor,uid:OWNER_ID,chat:OWNER_ID,actor:{id:OWNER_ID}},review.key,review.version,'published'));
 await text(f,77,'/menu');await click(f,77,'ratings:1:list');assert(f.graphics.last.photo);
 const image=renderImage('<b>Отзывы о вакансии</b>\n<b>Низкий рейтинг</b>\n★★☆☆☆\nМой опыт собеседования.');
 assert.deepEqual(image.starRows,['★★☆☆☆']);assert(image.height<1400);
});
test('failed deletion leaves old controls inert and never removes the replacement',async()=>{
 const f=await graphics();await text(f,1,'/start');const id=f.graphics.last.message_id,disabled=[];
 f.api.deleteMessage=async()=>{throw {code:400};};f.api.editMessageReplyMarkup=async p=>disabled.push(p);
 await text(f,1,'/menu');assert.notEqual(f.graphics.last.message_id,id);assert(disabled.some(p=>p.message_id===id&&p.reply_markup.inline_keyboard.length===0));
 assert(!disabled.some(p=>p.message_id===f.graphics.last.message_id));
});

test('reviews open directly from a vacancy, show the list first and explain rules before stars',async()=>{
 const f=await graphics();await f.store.putJob(job(1),true);await text(f,1,'/start');await click(f,1,'search:0');
 const controls=()=>f.graphics.last.reply_markup.inline_keyboard.flat();
 assert.equal(controls().filter(b=>b.callback_data==='ratings:1:list').length,1);
 const actions=controls().find(b=>b.text==='☰ Ещё').callback_data;
 await click(f,1,actions);assert(!controls().some(b=>b.callback_data?.startsWith('ratings:')));
 await click(f,1,controls().find(b=>b.text==='↩️ К вакансии').callback_data);
 await click(f,1,'ratings:1:list');assert(f.graphics.last.photo);
 assert(controls().some(b=>b.callback_data==='ratings:1:start'));
 assert(!controls().some(b=>/^ratings:1:[1-5]$/.test(b.callback_data)));
 await click(f,1,'ratings:1:start');assert(f.graphics.last.photo);
 assert.equal(controls().filter(b=>/^ratings:1:[1-5]$/.test(b.callback_data)).length,5);
 assert(!((await f.store.user(1)).settings.review_draft));
 await click(f,1,'ratings:1:4');assert.equal((await f.store.user(1)).settings.review_draft.stars,4);
 assert.equal((await f.store.records('vacancy_review')).length,0);
});
