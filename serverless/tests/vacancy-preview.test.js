import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job} from './fixtures.js';
import {translatedCard} from '../tgcloud/lib/ui.js';
import {imageDocument,renderImage} from '../tgcloud/lib/image-renderer.js';

test('unrated card has five empty stars with no zero score',async()=>{
 const f=await fixture(),j=job(1),r=await translatedCard(j,'s',f.fetch,f.store);
 assert.match(r.image,/☆☆☆☆☆\nНет отзывов/);assert.doesNotMatch(r.image,/0[,.]0\/5|0\/5/);
 assert.deepEqual(renderImage(r.image).starRows,['☆☆☆☆☆']);
 assert.equal((await translatedCard(j,'f',f.fetch,f.store)).image,undefined);
});
test('preview uses only latest published distinct-author review, escapes and clips text, never exposes authors',async()=>{
 const f=await fixture(),j={...job(1),_duplicate_ids:[1,2]};
 const add=(key,extra)=>f.store.record('vacancy_review',key,{uid:77,job_id:1,stars:4,state:'published',at:'2026-10-01T10:00:00Z',text:'Хорошие условия',author:{name:'PrivateName',username:'PrivateUser'},...extra});
 await add('first',{});
 await add('latest',{job_id:2,stars:1,at:'2026-10-02T10:00:00Z',text:'<b>Собеседование</b> & '+ 'Подробности '.repeat(30)});
 await add('pending',{uid:78,state:'pending',at:'2026-10-03T10:00:00Z',text:'СЕКРЕТ pending'});
 await add('deleted',{uid:79,state:'deleted',at:'2026-10-04T10:00:00Z',text:'СЕКРЕТ deleted'});
 const r=await translatedCard(j,'s',f.fetch,f.store);
 assert.match(r.image,/★☆☆☆☆/);assert.match(r.image,/1,0\/5 · отзывов: 1/);assert.match(r.image,/Низкий рейтинг/);
 assert.match(r.image,/Последний отзыв · 1\/5/);assert.match(r.image,/&lt;b&gt;Собеседование&lt;\/b&gt; &amp;/);
 assert.doesNotMatch(r.image,/PrivateName|PrivateUser|СЕКРЕТ|Хорошие условия/);
 const excerpt=imageDocument(r.image).lines.find(l=>l.text.startsWith('«'));assert(excerpt.text.length<=162);assert(excerpt.text.endsWith('…»'));
 await f.db.run("UPDATE sjc_records SET payload=json_set(payload,'$.state','deleted') WHERE kind='vacancy_review'");
 const removed=await translatedCard(j,'s',f.fetch,f.store);assert.match(removed.image,/☆☆☆☆☆\nНет отзывов/);assert.doesNotMatch(removed.image,/Собеседование/);
});

test('location has a rendered map icon; reviews have one entry on each card and none in actions',async()=>{
 const {jobButtons,viewerButtons,cardActions}=await import('../tgcloud/lib/ui.js');
 const j=job(1),f=await fixture(),r=await translatedCard(j,'s',f.fetch,f.store);
 const location=imageDocument(r.image).lines.find(l=>l.text.startsWith('Beograd ·'));assert.equal(location.icon,'map');
 assert.equal(renderImage(r.image).icons,4);
 for(const rows of [jobButtons(j),viewerButtons(j,0,2,'s',false)]){
  assert.equal(rows.flat().filter(b=>b.callback_data==='ratings:1:list').length,1);
  assert(rows.flat().some(b=>b.callback_data?.startsWith('actions:')));
 }
 assert(!cardActions(j,0,'s')[1].flat().some(b=>b.callback_data?.startsWith('ratings:')));
});

test('overlong photo caption falls back to selectable text instead of losing links or failing delivery',async()=>{
 const {vacancyVisual}=await import('../tgcloud/lib/ui.js');
 const f=await fixture(),r=await translatedCard(job(1),'s',f.fetch,f.store);
 assert(vacancyVisual(r));
 assert.equal(vacancyVisual({...r,caption:'x'.repeat(1025)}),false);
 assert.match(vacancyVisual(r,'Вакансия 2 из 205').text,/Вакансия 2 из 205/);
 assert.doesNotMatch(vacancyVisual(r,'Вакансия 2 из 205').caption,/Вакансия/);
 assert.match(r.text,/href=/);
 assert.equal(vacancyVisual(await translatedCard(job(1),'f',f.fetch,f.store)),false);
});
