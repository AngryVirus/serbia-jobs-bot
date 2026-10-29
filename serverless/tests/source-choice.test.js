import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job,handle,message,callback} from './fixtures.js';
import {openingLinks,links,sourceChoice,vacancyPresentation,vacancyVisual} from '../tgcloud/lib/ui.js';
import {imageDocument,renderImage} from '../tgcloud/lib/image-renderer.js';
const panel=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const buttons=f=>panel(f).reply_markup.inline_keyboard.flat();
const dual=()=>job(1,{source:'tg_radim_serbia',url:'https://t.me/radim_serbia/42',description:'Подробнее и откликнуться: https://radim.rs/jobs/chef/'});

test('date, address, position and status live in the image; only employer contacts remain in the caption',()=>{
 const j=job(1,{contacts:['person@example.com'],_cloud:{...job(1)._cloud,date_label:'28.10.2026'}});
 const result=vacancyPresentation(j,'s');
 const visual=vacancyVisual(result,'Последнее обновление — 2 ч назад.\nВакансия 2 из 205\n');
 assert.equal(visual.caption,'✉️ person@example.com');
 for(const expected of ['28.10.2026','Knez Mihailova 12','Вакансия 2 из 205','Последнее обновление'])assert(visual.text.includes(expected));
 assert.doesNotMatch(visual.caption,/href=|Beograd|28\.10\.2026|Вакансия|обновление/);
 assert(imageDocument(visual.text).title.includes('Повар'));assert(renderImage(visual.text).height<1800);
 assert.equal(vacancyVisual(vacancyPresentation(job(1),'s')).caption,'');
});

test('one source opens directly; website and Telegram offer exactly two validated destinations',()=>{
 for(const url of ['https://nsz.gov.rs/employee/jobs/preview/104197','https://t.me/channel/123']){
  const rows=links({...job(1),url});assert.equal(rows.length,1);assert.equal(rows[0][0].url,url);assert(!rows[0][0].callback_data);
 }
 const j={...dual(),_sources:[{url:'https://radim.rs/jobs/chef/'},{url:'https://t.me/radim_serbia/42'},{url:'javascript:bad()'},{url:'https://other.rs/job'}]};
 assert.deepEqual(openingLinks(j),{telegram:'https://t.me/radim_serbia/42',site:'https://radim.rs/jobs/chef/'});
 const trigger=links(j,false,'open:1:2:rf')[0][0];assert.equal(trigger.callback_data,'open:1:2:rf');assert(!trigger.url);
 const [,rows]=sourceChoice(j,'job:1:short');assert.equal(rows[0].length,2);assert(rows[0].every(b=>b.url));assert.equal(rows[1][0].callback_data,'job:1:short');
 assert.equal(openingLinks({...job(1),url:'https://telegram.me/s/MixedChannel/123'}).telegram,'https://t.me/MixedChannel/123');
 assert.equal(openingLinks({...job(1),url:'https://t.me.attacker.example/post'}).telegram,undefined);
 assert.deepEqual(links({...job(1),url:'javascript:bad()'}),[]);
});

test('source choice preserves a saved-search position and mode, respects stale and private sessions',async()=>{
 const f=await fixture();await f.store.putJob(dual(),true);await handle(f,message(1,'/start'));
 await f.store.patch(1,{saved_searches:[{id:'chef',name:'Кухня',filters:{},notifications:'off'}]});
 await handle(f,callback(1,'plans:open:chef'));
 let current=(await f.store.user(1)).settings.discovery_current;
 await handle(f,callback(1,`discover:${current}:1:0:details:s`));
 const open=buttons(f).find(b=>b.text==='🔗 Открыть объявление').callback_data;assert(open.endsWith(':open:f'));
 await handle(f,callback(1,open));assert.match(panel(f).text,/Где открыть объявление/);assert.equal(buttons(f).filter(b=>b.url).length,2);
 let s=(await f.store.user(1)).settings;assert.equal(s.discovery_current,current);assert.equal(s.discovery_sessions.find(x=>x.token===current).view,'open');
 await handle(f,callback(1,buttons(f).find(b=>b.text.includes('К вакансии')).callback_data));assert.match(panel(f).text,/Поиск: Кухня/);assert.match(panel(f).text,/Вакансия 1 из 1/);
 assert(buttons(f).some(b=>b.callback_data?.endsWith(':details:f')));
 await handle(f,message(2,'/start'));await handle(f,callback(2,open));assert.match(panel(f).text,/подборка устарела/);assert(!buttons(f).some(b=>b.url));
 await f.store.patch(1,{saved_searches:[]});await handle(f,callback(1,open));assert.match(panel(f).text,/подборка устарела/);
});

test('standalone and legacy viewers use the same chooser and blocked jobs disclose no source choices',async()=>{
 const f=await fixture();await f.store.putJob(dual(),true);await handle(f,message(1,'/start'));
 await handle(f,callback(1,'job:1:full'));const open=buttons(f).find(b=>b.text==='🔗 Открыть объявление').callback_data;
 assert.equal(open,'open:1:-1:f');await handle(f,callback(1,open));assert.equal(buttons(f).filter(b=>b.url).length,2);
 assert.equal(buttons(f).find(b=>b.text.includes('К вакансии')).callback_data,'job:1:full');
 await handle(f,callback(1,'open:1:0:s'));assert.equal(buttons(f).filter(b=>b.url).length,2);assert.equal(buttons(f).at(-1).callback_data,'view:1:0:show:s');
 await f.store.record('moderation','1',{ids:[1],blocked:true});await handle(f,callback(1,open));assert.match(panel(f).text,/снято/);assert(!buttons(f).some(b=>b.url));
});
