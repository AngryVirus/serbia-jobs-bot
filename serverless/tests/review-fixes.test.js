import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,callback,job } from './fixtures.js';
import { Bot } from '../tgcloud/lib/bot.js';
import { clip,safe } from '../tgcloud/lib/ui.js';
import { contains,keywordContains,matches,settings } from '../tgcloud/lib/filters.js';
import { groupJobs,visibleJobs } from '../tgcloud/lib/catalog.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';

test('text without a length limit is cleaned but never marked as shortened', () => {
 assert.equal(clip('  2026-11-10T10:00:00.000Z  '),'2026-11-10T10:00:00.000Z');
 assert.equal(safe('create <b>'),'create &lt;b&gt;');
 assert.equal(clip('abcdef',4),'abc…');
});

test('advertising journal shows stored values without a false ellipsis', async () => {
 const f=await fixture();
 await f.store.ensure(OWNER_ID,OWNER_ID);
 await f.store.record('ad_audit','a1',{owner:OWNER_ID,action:'create',id:'abc123',at:'2026-11-10T10:00:00.000Z'});
 await new Bot(f).handle(callback(OWNER_ID,'ads:audit'));
 const text=[...f.api.sent,...f.api.edited].at(-1).text;
 assert.match(text,/2026-11-10T10:00:00\.000Z · create · abc123/);
 assert.doesNotMatch(text,/…/);
});

test('review list buttons never split an emoji in a long vacancy title', async () => {
 const f=await fixture(),title='x'.repeat(34)+'😀 повар';
 await f.store.ensure(OWNER_ID,OWNER_ID);
 await f.store.record('vacancy_review','1:5',{key:'1:5',job_id:1,uid:5,author:{id:5},title,stars:4,text:'Хороший работодатель',state:'pending',version:'abcdefgh1234',at:new Date().toISOString()});
 await new Bot(f).handle(callback(OWNER_ID,'admin:ratings:pending:0'));
 const sent=[...f.api.sent,...f.api.edited].at(-1),label=sent.reply_markup.inline_keyboard[0][0].text;
 assert.ok(label.startsWith('4 ⭐ · '+'x'.repeat(34)));
 assert.equal(label.isWellFormed?label.isWellFormed():!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(label),true);
});

test('cached search text follows the record and keeps exact word boundaries', () => {
 const now=Date.now(),record=job(1,{title:'Повар',description:'Ресторан в центре',location:'Beograd'});
 const cook=settings({keywords:['повар']}),driver=settings({keywords:['водитель']});
 assert.equal(matches(record,cook,now),true);
 assert.equal(matches(record,driver,now),false);
 record.title='Водитель';
 assert.equal(matches(record,cook,now),false);
 assert.equal(matches(record,driver,now),true);
 record.location='Niš';
 assert.equal(matches(record,settings({city:['belgrade']}),now),false);
 assert.equal(matches(record,settings({city:['nis']}),now),true);
 assert.equal(matches(record,settings({hidden_jobs:[1]}),now),false);
 assert.equal(contains('повариха','повар'),false);
 assert.equal(contains('Нужен ПОВАР.','повар'),true);
 assert.equal(keywordContains('ищем повара','повар'),true);
 assert.equal(contains('c++ developer','c++'),true);
});

test('repeated filtering of one catalogue returns the same selection', () => {
 const jobs=[job(1,{title:'Повар',location:'Beograd'}),job(2,{title:'Официант',description:'Кафе, Нови-Сад',location:'Novi Sad'}),job(3,{title:'Курьер',description:'Доставка',location:'Zemun'})];
 const groups=groupJobs(jobs),s=settings({keywords:['повар','официант'],exclusions:['доставка'],city:['belgrade','novi_sad']});
 const first=visibleJobs(groups,s).map(j=>j.id);
 assert.deepEqual(first,[1,2]);
 assert.deepEqual(visibleJobs(groups,s).map(j=>j.id),first);
 assert.deepEqual(visibleJobs(groups,settings({exclusions:['повар']})).map(j=>j.id),[2,3]);
});

test('an in-place panel update does not rewrite the unchanged panel pointer', async () => {
 const f=await fixture();let message=0;
 class InputFile {constructor(bytes){this.bytes=bytes;}}
 f.InputFile=InputFile;
 f.api.sendPhoto=async()=>({message_id:++message+500,photo:[{file_id:'file'+message}]});
 f.api.editMessageMedia=async p=>({message_id:p.message_id,photo:[{file_id:'edited'}]});
 f.api.deleteMessage=async()=>{};f.api.editMessageReplyMarkup=async()=>{};
 await new Bot(f).handle(callback(77,'menu'));
 const saved=async()=>(await f.store.user(77));
 const first=await saved();
 const id=first.settings.ui_panel_id;
 assert.ok(id>0);assert.equal(first.settings.ui_panel_kind,'photo');
 const update=callback(77,'filters');update.callback_query.message.message_id=id;update.callback_query.message.photo=[{file_id:'file1'}];
 const run=f.db.run;let rewrites=0;
 f.db.run=async(sql,params)=>{if(/^UPDATE sjc_users SET payload=:payload WHERE id=:id$/.test(sql))rewrites++;return run(sql,params);};
 await new Bot(f).handle(update);
 f.db.run=run;
 const second=await saved();
 assert.equal(second.settings.ui_panel_id,id);assert.equal(second.settings.ui_panel_kind,'photo');
 assert.equal(rewrites,0);
});

test('profession keywords cover every case form and reviewed Serbian and English names', async () => {
 const {KEYWORD_FORMS,KEYWORD_TRANSLATIONS}=await import('../tgcloud/lib/config.js');
 const {normalize}=await import('../tgcloud/lib/filters.js');
 assert.deepEqual(Object.keys(KEYWORD_TRANSLATIONS),Object.keys(KEYWORD_FORMS));
 const owners=new Map();
 for(const [word,forms] of Object.entries(KEYWORD_FORMS)){
  // Every listed form is found, including those containing «й».
  for(const form of forms)assert.equal(keywordContains('Ищем: '+form+'.',word),true,form);
  for(const name of KEYWORD_TRANSLATIONS[word]){
   assert.equal(normalize(name),name,name);
   assert.equal(owners.has(name),false,name);owners.set(name,word);
   assert.equal(keywordContains('Oglas: '+name+', Beograd',word),true,name);
   assert.equal(keywordContains('Нужен '+word,name),true,name);
  }
 }
 assert.equal(keywordContains('Ищем водителей категории B','водитель'),true);
 assert.equal(keywordContains('Potreban kuvar u restoranu','повар'),true);
 assert.equal(keywordContains('Потребна куварица','повар'),true);
 assert.equal(keywordContains('Vozač B kategorije','водитель'),true);
 assert.equal(keywordContains('Građevinski radnici','строитель'),true);
 assert.equal(keywordContains('Нужен повар','cook'),true);
 // Whole words only, and an inflected or unknown keyword stays literal.
 assert.equal(keywordContains('cookie factory','повар'),false);
 assert.equal(keywordContains('повариха','повар'),false);
 assert.equal(keywordContains('Potreban kuvar','повара'),false);
 assert.equal(keywordContains('Potreban kuvar','программист'),false);
 // Exclusions never expand.
 assert.equal(contains('Potreban kuvar','повар'),false);
 const record=job(9,{title:'Kuvar',description:'Restoran traži kuvara',location:'Beograd'});
 assert.equal(matches(record,settings({keywords:['повар']})),true);
 assert.equal(matches(record,settings({exclusions:['повар']})),true);
});

test('an expired update receipt is reclaimed without background cleanup, a live one is not', async () => {
 const f=await fixture();
 assert.equal(await f.store.claimUpdate('u:1'),true);
 assert.equal(await f.store.claimUpdate('u:1'),false);
 await f.store.finishUpdate('u:1');
 assert.equal(await f.store.claimUpdate('u:1'),false);
 await f.db.run("UPDATE sjc_updates SET expires=:past WHERE key='u:1'",{':past':Date.now()-1});
 assert.equal(await f.store.claimUpdate('u:1'),true);
 assert.equal((await f.db.get("SELECT state FROM sjc_updates WHERE key='u:1'")).state,'processing');
 assert.equal(await f.store.claimUpdate('u:1'),false);
});

test('user updates leave expired receipts to the background tick, which clears a backlog in pages', async () => {
 const f=await fixture(),now=Date.now();
 for(let i=0;i<250;i++)await f.db.run("INSERT INTO sjc_updates(key,state,expires) VALUES(:key,'done',:expires)",{':key':'old:'+i,':expires':now-1});
 await f.store.record('rate','old',{n:1,end:now-1});
 await new Bot(f).handle(callback(77,'menu'));
 assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM sjc_updates WHERE key LIKE 'old:%'")).n,250);
 await f.store.pruneBacklog();
 assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM sjc_updates WHERE key LIKE 'old:%'")).n,0);
 assert.equal((await f.store.records('rate')).filter(r=>r.end===now-1).length,0);
});

test('collector writes store a body fingerprint and grouping is the same with or without it', async () => {
 const {bodyFacts,DEDUPE_VERSION}=await import('../tgcloud/lib/catalog.js');
 const f=await fixture(),long='Ресторан в центре ищет повара на полный день. '.repeat(8),published=Date.now()-86400000;
 const cloud={version:1,serbia:true,languages:['ru'],published_ms:published,expires_ms:null};
 const make=(n,description,extra={})=>({source:'tg_rabotavserbii',url:'https://t.me/rabotavserbii/'+n,title:'Повар',description,location:'Beograd',company:'Acme',contacts:['+381601'],_cloud:{...cloud},...extra});
 await f.store.putJob(make(1,long));
 await f.store.putJob(make(2,long.toUpperCase()+'  '));
 await f.store.putJob(make(3,long+' Другой текст объявления.'));
 const saved=await f.store.jobs();
 for(const j of saved)assert.deepEqual(j._dedupe,bodyFacts(j.description));
 assert.equal(saved[0]._dedupe.v,DEDUPE_VERSION);
 const shape=list=>groupJobs(list).map(g=>g.members.map(j=>j.id).sort()).sort();
 const bare=saved.map(({_dedupe,...j})=>j);
 assert.deepEqual(shape(saved),[[1,2],[3]]);
 assert.deepEqual(shape(bare),shape(saved));
 // A fingerprint that no longer describes the text is ignored, not trusted.
 const stale=saved.map(j=>j.id===3?{...j,_dedupe:saved.find(x=>x.id===1)._dedupe}:j);
 assert.deepEqual(shape(stale),shape(saved));
 // An edited description gets a new fingerprint on the next collector write.
 await f.store.putJob(make(2,long+' Совсем другое объявление, не копия первого.'));
 assert.deepEqual(shape(await f.store.jobs()),[[1],[2],[3]]);
});

test('older records receive fingerprints in bounded background pages exactly once', async () => {
 const {bodyFacts,DEDUPE_VERSION}=await import('../tgcloud/lib/catalog.js');
 const f=await fixture();
 for(let i=1;i<=7;i++)await f.db.run('INSERT INTO sjc_jobs(id,source_key,payload) VALUES(:id,:key,:payload)',{':id':i,':key':'k'+i,':payload':JSON.stringify(job(i,{description:'Описание '+i}))});
 assert.deepEqual(await f.store.backfillDedupe(3),{done:false,updated:3});
 assert.deepEqual(await f.store.backfillDedupe(3),{done:false,updated:3});
 assert.deepEqual(await f.store.backfillDedupe(3),{done:true,updated:1});
 for(const row of await f.db.all('SELECT payload FROM sjc_jobs')){const j=JSON.parse(row.payload);assert.deepEqual(j._dedupe,bodyFacts(j.description));assert.equal(j._dedupe.v,DEDUPE_VERSION);assert.equal(j.title,'Повар <&>');}
 let reads=0;const all=f.db.all;f.db.all=async(sql,params)=>{if(/FROM sjc_jobs/.test(sql))reads++;return all(sql,params);};
 assert.deepEqual(await f.store.backfillDedupe(3),{done:true,updated:0});
 f.db.all=all;assert.equal(reads,0);
});

test('keyword search reads look-alike Latin letters inside Cyrillic words', async () => {
 const {withoutLookalikes,normalize}=await import('../tgcloud/lib/filters.js');
 const fix=text=>withoutLookalikes(normalize(text));
 assert.equal(fix('Специaлист по зaкупкaм'),'специалист по закупкам');
 assert.equal(fix('ВAKAHCИЯ: Mенеджер'),'вакансия: менеджер');
 // Ordinary Latin words, brand names and words with other Latin letters stay.
 for(const text of ['cook and chef','it-специалист','smm-менеджер','wi-fi роутер','HRам и PRщикам','ITшник','Xа','node.js разработчик','vozač kamiona','1c программист'])assert.equal(fix(text),normalize(text),text);
 const record=job(21,{title:'Вакансия: Специaлист по зaкупкaм',description:'Менеджер по продaжaм со знaнием сербского языкa',location:'Beograd'});
 assert.equal(matches(record,settings({keywords:['специалист']})),true);
 assert.equal(matches(record,settings({keywords:['менеджер']})),true);
 assert.equal(matches(record,settings({exclusions:['продажам']})),false);
 assert.equal(matches(record,settings({keywords:['водитель']})),false);
 assert.equal(record.title,'Вакансия: Специaлист по зaкупкaм');
});
