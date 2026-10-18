import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fixture,callback,message,job } from './fixtures.js';
import { Bot } from '../tgcloud/lib/bot.js';
import { renderImage,imageHash,imageDocument } from '../tgcloud/lib/image-renderer.js';
import { CODEC_SOURCE } from '../tgcloud/lib/image-codec.js';
import { defaults } from '../tgcloud/lib/filters.js';
import { filtersPanel,choicePanel } from '../tgcloud/lib/ui.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { administer } from '../tgcloud/lib/admin.js';

class InputFile {constructor(bytes,name,options){this.bytes=bytes;this.name=name;this.options=options;}}
async function graphics(){
 const f=await fixture(),state={next:100,sends:[],edits:[],deleted:[],messages:new Map(),last:null};
 f.InputFile=InputFile;f.graphics=state;
 const photo=p=>({message_id:p.message_id,reply_markup:p.reply_markup,chat:{id:p.chat_id,type:'private'},photo:[{file_id:typeof p.photo==='string'?p.photo:'file-'+imageHash(String(p.photo.bytes.length)+':'+imageHash([...p.photo.bytes.slice(-1000)].join(',')))}]});
 f.api.sendPhoto=async p=>{assert(!p.caption);state.sends.push({...p,kind:'photo'});const m=photo({...p,message_id:++state.next});state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.editMessageMedia=async p=>{assert.equal(p.media.type,'photo');assert.equal(p.media.caption,'');state.edits.push(p);const m=photo({...p,photo:p.media.media});state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.sendMessage=async p=>{state.sends.push({...p,kind:'text'});const m={message_id:++state.next,text:p.text,reply_markup:p.reply_markup,chat:{id:p.chat_id,type:'private'}};state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.editMessageText=async p=>{if(state.messages.get(p.message_id)?.photo)throw {code:400,description:'There is no text in the message to edit'};state.edits.push(p);const m={message_id:p.message_id,text:p.text,reply_markup:p.reply_markup,chat:{id:p.chat_id,type:'private'}};state.messages.set(m.message_id,m);state.last=m;return m;};
 f.api.deleteMessage=async p=>{state.deleted.push(p.message_id);state.messages.delete(p.message_id);};
 f.api.editMessageReplyMarkup=async()=>{};
 return f;
}
async function click(f,uid,data){const update=callback(uid,data);if(f.graphics.last)update.callback_query.message={...f.graphics.last};await new Bot(f).handle(update);return update;}
async function text(f,uid,value){await new Bot(f).handle(message(uid,value));}

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
test('vacancies remain text, returning to menus uses media, and old photo controls are removed',async()=>{
 const f=await graphics();await f.store.putJob(job(1),true);await text(f,1,'/start');const imageId=f.graphics.last.message_id;
 await click(f,1,'search:0');assert.equal(f.graphics.sends.at(-1).kind,'text');assert(f.graphics.last.text.includes('Повар'));
 assert(f.graphics.deleted.includes(imageId));const cardId=f.graphics.last.message_id;
 await click(f,1,'filters');assert.equal(f.graphics.last.message_id,cardId);assert(f.graphics.last.photo);
 await click(f,1,'job:1:full');assert(f.graphics.last.text.includes('Повар'));
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
 const audit=await administer({operation:'menu_image_audit'},{ownerRun:true},f);assert.equal(audit.rendered,3);
 const preview=await administer({operation:'menu_image_preview'},{ownerRun:true},f);assert.equal(preview.edited_in_place,3);
 assert(f.graphics.sends.every(p=>p.chat_id===OWNER_ID));
 const after=(await f.store.user(OWNER_ID)).settings;assert.deepEqual(after.city,before.city);assert.deepEqual(after.keywords,before.keywords);
});

test('all reachable user menu and vacancy controls remain usable with image transport',async()=>{
 const f=await graphics();await f.store.putJob(job(1),true);await f.store.putJob(job(2),true);
 f.fetch=async()=>({ok:true,json:async()=>[[['Переведённый текст']]]});
 await text(f,1,'/start');const queue=['menu','notifications','delete'],seen=new Set();
 while(queue.length){
  const action=queue.shift();if(seen.has(action))continue;seen.add(action);
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
 const document=imageDocument(filtersPanel(defaults())[0]);
 const labels=document.lines.filter(l=>l.bold&&l.text.includes(':'));
 assert.equal(labels.length,9);assert(labels.every(l=>categoryIcon(l.text)));
 assert.equal(new Set(labels.map(l=>categoryIcon(l.text))).size,8);
 assert.equal(categoryIcon('Произвольный текст: значение'),null);
 assert.match(IMAGE_VERSION,/v2/);assert.equal(renderImage(filtersPanel(defaults())[0]).icons,9);
});
