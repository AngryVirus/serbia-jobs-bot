import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handle,message,callback,job} from './fixtures.js';
import {OWNER_ID} from '../tgcloud/lib/permissions.js';
import {submitReview,decideReview,reviewNoticeTick,ratingsAdmin} from '../tgcloud/lib/ratings.js';
import {ratingSummary,ratingLine} from '../tgcloud/lib/rating-data.js';
import {translatedCard} from '../tgcloud/lib/ui.js';
import {Store} from '../tgcloud/lib/store.js';
const last=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const bot=(f,uid)=>({store:f.store,api:f.api,uid,chat:uid,actor:{id:uid,name:'Сотрудник',username:'VerifiedActor'}});
async function seed(){const f=await fixture();await f.store.putJob(job(1),true);for(const uid of [77,78,OWNER_ID,2,3])await f.store.ensure(uid,uid);await f.store.record('staff_role',2,{role:'moderator'});await f.store.record('staff_role',3,{role:'administrator'});return f;}
async function add(f,uid=77,stars=2,id=1){assert(await submitReview(bot(f,uid),{job_id:id,stars,token:'drafttoken12'},'Реальный опыт отклика.'));return (await f.store.records('vacancy_review')).find(r=>r.uid===uid);}
test('authenticated author, moderation, public privacy and a single review action',async()=>{
 const f=await seed();await handle(f,callback(77,'actions:1:-1:s'));assert.equal(last(f).reply_markup.inline_keyboard.flat().filter(b=>b.callback_data==='ratings:1:list').length,1);
 await handle(f,callback(77,'ratings:1:start'));assert.match(last(f).text,/Команда увидит/);
 await handle(f,callback(77,'ratings:1:2'));const update=message(77,'Мой опыт <b>важен</b>');Object.assign(update.message.from,{first_name:'Иван',username:'ActualUser'});
 await handle(f,update);await handle(f,update);
 const [r]=await f.store.records('vacancy_review');assert.equal(r.stars,2);assert.equal(r.author.username,'ActualUser');assert.equal(r.state,'pending');assert.equal((await ratingSummary(f.store,[1])).count,0);
 await handle(f,callback(2,`admin:ratings:view:${r.key}`));assert.match(last(f).text,/ActualUser/);assert.match(last(f).text,/Мой опыт &lt;b&gt;/);assert(last(f).reply_markup.inline_keyboard.flat().some(b=>b.url==='tg://user?id=77'));
 await handle(f,callback(3,`admin:ratings:p:${r.key}:${r.version}`));assert.equal((await ratingSummary(f.store,[1])).average,2);
 await handle(f,callback(78,'ratings:1:list'));assert.match(last(f).text,/Низкий рейтинг/);assert.doesNotMatch(last(f).text,/ActualUser|ID: 77/);
 const card=await translatedCard(await f.store.job(1),'s',f.fetch,f.store);assert.match(card.text,/Низкий рейтинг/);assert.match(card.text,/2,0\/5/);
 await handle(f,callback(77,'ratings:1:start'));assert.match(last(f).text,/уже оставили/);
});
test('only approved scores, honest decimals and warning boundary',async()=>{
 const f=await seed(),r=await add(f);assert.match(ratingLine(await ratingSummary(f.store,[1])),/пока нет/);
 await decideReview(bot(f,2),r.key,r.version,'published');const second=await add(f,78,5);await decideReview(bot(f,3),second.key,second.version,'published');
 const summary=await ratingSummary(f.store,[1]);assert.equal(summary.average,3.5);assert.equal(summary.count,2);assert.doesNotMatch(ratingLine(summary),/Низкий/);
 for(const average of [1,1.9,2])assert.match(ratingLine({count:1,average}),/Низкий/);
 assert.doesNotMatch(ratingLine({count:1,average:2.1}),/Низкий/);
});
test('duplicate copies cannot create another vote and later merging deduplicates authors',async()=>{
 const f=await seed();await f.store.putJob(job(2,{url:job(1).url+'?utm_source=test'}),true);const r=await add(f);
 assert.equal(await submitReview(bot(f,77),{job_id:2,stars:5,token:'otherdraft12'},'Другой отзыв.'),false);
 await decideReview(bot(f,2),r.key,r.version,'published');
 await f.store.record('vacancy_review','2:77',{...r,key:'2:77',job_id:2,state:'published',stars:4,at:'2099-01-01T00:00:00Z'});
 const summary=await ratingSummary(f.store,[1,2]);assert.equal(summary.count,1);assert.equal(summary.average,4);
});
test('two moderators racing and repeated callbacks commit only one decision, audit and author notice',async()=>{
 const f=await seed(),r=await add(f);const decisions=await Promise.all([decideReview(bot(f,2),r.key,r.version,'published'),decideReview(bot(f,3),r.key,r.version,'deleted')]);
 assert.equal(decisions.filter(Boolean).length,1);assert.equal((await f.store.records('staff_audit')).length,1);assert.equal((await f.store.records('review_notice')).filter(n=>n.type!=='pending').length,1);
 assert.equal(await decideReview(bot(f,OWNER_ID),r.key,r.version,'deleted'),false);
 const current=(await f.store.records('vacancy_review'))[0];if(current.state==='published')assert(await decideReview(bot(f,3),r.key,current.version,'deleted'));
 assert.equal((await ratingSummary(f.store,[1])).count,0);
});
test('a failed audit insert rolls back the decision and notification together',async()=>{
 const f=await seed(),r=await add(f);
 await f.db.run("CREATE TRIGGER reject_audit BEFORE INSERT ON sjc_records WHEN NEW.kind='staff_audit' BEGIN SELECT RAISE(ABORT,'test interruption'); END");
 await assert.rejects(decideReview(bot(f,2),r.key,r.version,'published'));
 assert.equal((await f.store.records('vacancy_review'))[0].state,'pending');assert.equal((await f.store.records('review_notice')).filter(n=>n.type==='published').length,0);
});
test('numeric roles, bans, mismatched chat and self-review are enforced',async()=>{
 const f=await seed(),r=await add(f);
 for(const uid of [77,78])assert.equal(await decideReview(bot(f,uid),r.key,r.version,'published'),false);
 assert.equal(await decideReview({...bot(f,OWNER_ID),chat:77},r.key,r.version,'published'),false);
 await f.store.record('staff_role',2,{role:'user'});assert.equal(await decideReview(bot(f,2),r.key,r.version,'published'),false);
 await f.store.record('user_ban',3,{active:true});assert.equal(await decideReview(bot(f,3),r.key,r.version,'published'),false);
 await f.store.record('staff_role',77,{role:'moderator'});assert.equal(await decideReview(bot(f,77),r.key,r.version,'published'),false);
 await handle(f,callback(78,`admin:ratings:view:${r.key}`));assert.doesNotMatch(last(f).text,/Реальный опыт|VerifiedActor/);
 assert.equal((await f.store.records('staff_audit')).length,0);
});
test('role revocation between preliminary validation and SQL denies the mutation',async()=>{
 const f=await seed(),r=await add(f),original=f.store.pruneStaffAudit.bind(f.store);
 f.store.pruneStaffAudit=async()=>{await original();await f.store.record('staff_role',2,{role:'user'});};
 assert.equal(await decideReview(bot(f,2),r.key,r.version,'published'),false);assert.equal((await f.store.records('staff_audit')).length,0);
});
test('durable team and author notices survive restart without repeats',async()=>{
 const f=await seed(),r=await add(f);await Promise.all([reviewNoticeTick(f.store,f.api),reviewNoticeTick(new Store(f.db),f.api)]);
 assert.equal(f.api.sent.length,3);assert.deepEqual(f.api.sent.map(p=>p.chat_id).sort((a,b)=>a-b),[2,3,OWNER_ID]);
 await decideReview(bot(f,2),r.key,r.version,'published');await reviewNoticeTick(new Store(f.db),f.api);await reviewNoticeTick(f.store,f.api);
 assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);assert.match(f.api.sent.find(p=>p.chat_id===77).text,/опубликован/);
 const published=(await f.store.records('vacancy_review'))[0];await decideReview(bot(f,3),r.key,published.version,'deleted');await reviewNoticeTick(f.store,f.api);
 assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,2);assert.match(f.api.sent.at(-1).text,/удалён/);
});
test('a submitted review notifies every active staff member across bounded batches, once',async()=>{
 const f=await seed(),recipients=[2,3,OWNER_ID,100,101,102,103,104,105];
 for(const uid of recipients.slice(3)){await f.store.ensure(uid,uid);await f.store.record('staff_role',uid,{role:uid%2?'administrator':'moderator'});}
 await handle(f,callback(77,'ratings:1:4'));
 const update=message(77,'Проходил собеседование, делюсь личным опытом.');
 await handle(f,update);await handle(f,update);
 assert.equal(f.api.sent.filter(p=>p.chat_id!==77).length,5);
 await reviewNoticeTick(new Store(f.db),f.api);await reviewNoticeTick(f.store,f.api);
 const notices=f.api.sent.filter(p=>p.chat_id!==77);
 assert.deepEqual(notices.map(p=>p.chat_id).sort((a,b)=>a-b),recipients.sort((a,b)=>a-b));
 for(const p of notices){assert.match(p.text,/Новый отзыв на проверке/);assert.match(p.text,/ID 77/);assert.match(p.text,/Проходил собеседование/);assert.equal(p.reply_markup.inline_keyboard[0][0].callback_data,'admin:ratings:view:1:77');}
});
test('notices recheck staff access, honor 429 and never repeat uncertain sends',async()=>{
 for(const code of [429,500,403]){
  const f=await seed(),r=await add(f);await decideReview(bot(f,2),r.key,r.version,'published');let calls=0;
  f.api.sendMessage=async()=>{calls++;throw {code,parameters:{retry_after:10}};};
  await reviewNoticeTick(f.store,f.api);await reviewNoticeTick(f.store,f.api);assert.equal(calls,1);
  if(code===429){await reviewNoticeTick(f.store,f.api,Date.now()+11000);assert.equal(calls,2);}
 }
 const f=await seed();await add(f);await f.store.record('staff_role',2,{role:'user'});await f.store.record('user_ban',3,{active:true});await reviewNoticeTick(f.store,f.api);assert.deepEqual(f.api.sent.map(p=>p.chat_id),[OWNER_ID]);
});
test('invalid stars/text, review flood, cancellation and profile deletion',async()=>{
 const f=await seed();for(const stars of [0,6,'5',1.2])assert.equal(await submitReview(bot(f,77),{job_id:1,stars,token:'drafttoken12'},'Хороший отзыв'),false);
 await handle(f,callback(77,'ratings:1:4'));await handle(f,message(77,'ab'));assert.equal((await f.store.records('vacancy_review')).length,0);
 await handle(f,message(77,'/cancel'));await handle(f,message(77,'Не публиковать отзыв'));assert.equal((await f.store.records('vacancy_review')).length,0);
 await f.store.rate('77:review',1,3600);for(let i=0;i<4;i++)await f.store.rate('77:review',5,3600);
 await handle(f,callback(77,'ratings:1:4'));await handle(f,message(77,'Отзыв слишком рано'));assert.match(f.api.sent.at(-1).text,/Повторите через/);
 const r=await add(f);await decideReview(bot(f,2),r.key,r.version,'published');await f.store.deleteUser(77);
 assert.equal((await ratingSummary(f.store,[1])).count,0);assert.equal((await f.store.records('review_notice')).length,0);assert.equal((await f.store.records('vacancy_review')).length,0);
});
test('owner log is private JSONL with ten-day retention, actual actor and no review text',async()=>{
 const f=await seed(),r=await add(f);await decideReview(bot(f,2),r.key,r.version,'published');
 await f.store.record('staff_audit','old',{at:new Date(Date.now()-11*86400000).toISOString(),action:'review_delete'});
 const files=[],panels=[];class InputFile{constructor(bytes,name){this.bytes=bytes;this.name=name;}}
 f.api.sendDocument=async p=>{files.push(p);return {message_id:1};};
 await ratingsAdmin({...bot(f,2),InputFile,panel:async text=>panels.push(text)},'admin:ratings:log:0');assert.equal(files.length,0);
 await ratingsAdmin({...bot(f,OWNER_ID),InputFile,panel:async text=>panels.push(text)},'admin:ratings:log:0');assert.equal(files.length,1);
 const event=JSON.parse(new TextDecoder().decode(files[0].document.bytes).trim());assert.equal(event.actor.id,2);assert.equal(event.action,'review_publish');assert.equal(event.target,77);assert.equal(event.text,undefined);assert.equal((await f.store.records('staff_audit')).length,1);
});
