import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, groupJobs, visibleJobs, hiddenGroups, catalogDiagnostics } from '../tgcloud/lib/catalog.js';
import { defaults } from '../tgcloud/lib/filters.js';
import { card, links } from '../tgcloud/lib/ui.js';
import { notifyOne } from '../tgcloud/lib/admin.js';
import { job, fixture, message, callback, handle } from './fixtures.js';

const text = 'Ресторан ищет повара горячего цеха. Приготовление блюд по технологическим картам, контроль качества продуктов, работа с командой кухни. Сменный график, оформление и питание за счёт работодателя.';
const opening = (id, extra = {}) => job(id, { company: 'Lou Caffe', description: text, created_at: '2026-10-14T10:00:00Z', ...extra });
const copy = (id, extra = {}) => opening(id, { source: 'radim', url: `https://radim.rs/jobs/cook-${id}`, ...extra });

test('canonical URLs remove transport/tracking differences and retain job identifiers', () => {
  assert.equal(canonicalUrl('http://www.klikdoposla.com/oglasi/91942/?utm_source=tg#details'), canonicalUrl('https://klikdoposla.com/oglasi/91942'));
  assert.equal(canonicalUrl('https://telegram.me/s/Work/123'), canonicalUrl('https://t.me/work/123'));
  assert.notEqual(canonicalUrl('https://ovdejobs.com/?p=123'), canonicalUrl('https://ovdejobs.com/?p=124'));
  assert.notEqual(canonicalUrl('https://jobs.rs/?id=1'), canonicalUrl('https://jobs.rs/?id=2'));
  assert.notEqual(canonicalUrl('https://jobs.rs:80/a'), canonicalUrl('https://jobs.rs/a'));
  assert.notEqual(canonicalUrl('https://jobs.rs/?id=2&id=1'), canonicalUrl('https://jobs.rs/?id=1&id=2'));
  assert.notEqual(canonicalUrl('https://jobs.rs/Jobs/AbC'), canonicalUrl('https://jobs.rs/jobs/abc'));
  assert.equal(canonicalUrl('javascript:alert(1)'), '');
});

test('cross-source reposts merge; same role alone, different employers and template roles stay separate', () => {
  assert.equal(groupJobs([opening(1), copy(2, {location:'Београд'})]).length, 1);
  for (const extra of [{title:'Кассир'}, {company:'Another cafe'}, {location:'Novi Sad'}, {salary_min:1800}, {salary_period:'hour'}, {description:'Нужен повар'}, {created_at:'2026-01-01T00:00:00Z'}]) {
    assert.equal(groupJobs([opening(1), copy(2,extra)]).length, 2, JSON.stringify(extra));
  }
  // Actual failure pattern: one employer boilerplate reused for an electrician and cashier.
  assert.equal(groupJobs([opening(1,{title:'Električar',company:''}), copy(2,{title:'Prodavac',company:''})]).length, 2);
  assert.equal(groupJobs([opening(1,{created_at:null}), copy(2,{created_at:null})]).length, 2);
  assert.equal(groupJobs([opening(1,{contacts:['@a']}), copy(2,{contacts:['@b']})]).length, 2);
  const branch=copy(2); branch._cloud.address='Bulevar Oslobodjenja 18';
  assert.equal(groupJobs([opening(1),branch]).length,2);
});

test('newer copy of the same original wins before filtering salary or expiry', () => {
  const old=opening(1,{url:'http://www.jobs.rs/jobs/1',updated_at:'2026-10-14T10:00:00Z'});
  const current=opening(2,{url:'https://jobs.rs/jobs/1?utm_source=tg',salary_min:700,updated_at:'2026-10-15T10:00:00Z'});
  const groups=groupJobs([old,current]);
  assert.equal(visibleJobs(groups,{...defaults(),min_salary:1000}).length,0);
  current._cloud.expires_ms=1;
  assert.equal(visibleJobs(groups,defaults()).length,0);
});

test('publisher originals survive title edits; generic links cannot merge conflicting roles', () => {
  const site = copy(1,{url:'https://ovdejobs.com/?p=180496'});
  const post = opening(2,{description:'Подробнее и откликнуться: https://ovdejobs.com/?p=180496&utm_source=tg'});
  assert.equal(groupJobs([site,post]).length, 1);
  assert.equal(groupJobs([site,{...post,title:'Официант'}]).length, 1);
  assert.equal(groupJobs([site,{...post,title:'Официант',description:'https://ovdejobs.com/?p=180496'}]).length, 2);
  assert.equal(groupJobs([site,{...post,description:'https://ovdejobs.com/?p=180497'}]).length, 2);
  assert.equal(groupJobs([opening(1,{description:'https://cafe.rs/jobs'}), copy(2,{description:'https://cafe.rs/jobs'})]).length, 2);
});

test('Radim teaser and website share one vacancy and both source links despite different metadata',async()=>{
  const site=copy(1,{title:'Повар / Kuvar',url:'https://radim.rs/jobs/chef-42',location:'Beograd',salary_min:1300});
  const post=opening(2,{source:'tg_radim_serbia',url:'https://t.me/radim_serbia/87',title:'👨‍🍳 Повар',location:'Белград | на месте',salary_min:1200,description:'Короткое описание. Подробнее и откликнуться: https://radim.rs/jobs/chef-42?utm_source=telegram'});
  for(const jobs of [[site,post],[post,site]]) {
    const groups=groupJobs(jobs); assert.equal(groups.length,1);
    const visible=visibleJobs(groups,defaults()); assert.equal(visible.length,1);
    const text=card(visible[0]); assert(text.includes('https://radim.rs/jobs/chef-42')); assert(text.includes('https://t.me/radim_serbia/87')); assert(text.includes('Источники:'));
  }
  assert.equal(groupJobs([site,{...post,description:post.description.replace('chef-42','chef-43')}]).length,2);
  assert.equal(groupJobs([site,{...post,source:'telegram_youritjob',url:'https://t.me/youritjob/87'}]).length,2);
  const f=await fixture(); await f.store.ensure(1,1); await f.store.patch(1,{notifications:'instant',notifications_after_id:0});
  await f.store.putJob(site,true); assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
  await f.store.putJob(post,true); assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  assert.equal((await f.store.jobs()).length,2);
});

test('partial metadata cannot transitively merge contradictory employers', () => {
  const jobs = [opening(1,{company:'A'}), opening(2,{company:'',contacts:['@staff'],description:text.repeat(2)}), opening(3,{company:'B'})];
  jobs.forEach(j => {j.description=text.repeat(2);});
  for (const input of [jobs,[jobs[1],jobs[2],jobs[0]],[...jobs].reverse()]) {
    const groups = groupJobs(input);
    assert(groups.every(g => !(g.members.some(j=>j.id===1) && g.members.some(j=>j.id===3))));
  }
});

test('filters select a matching original; hidden groups and diagnostics count unique jobs', () => {
  const a=opening(1,{languages:['ru']}), b=copy(2,{languages:['en']}); b._cloud.languages=['en'];
  const groups=groupJobs([a,b]), s={...defaults(),language:'english'};
  assert.equal(visibleJobs(groups,s)[0].id,2);
  assert.equal(visibleJobs(groups,{...s,hidden_jobs:[1]}).length,0);
  assert.equal(hiddenGroups(groups,{hidden_jobs:[1,2,999]}).length,2);
  assert.equal(catalogDiagnostics(groups,{...s,keywords:['engineer']}).available,1);
  assert.equal(catalogDiagnostics(groups,{...s,keywords:['engineer']}).relaxed.find(r=>r.field==='keywords').count,1);
  assert.equal(catalogDiagnostics(groups,{...s,hidden_jobs:[1]}).available,0);
});

test('old anchors, hiding a copy, future reposts, unique hidden count and restoration', async () => {
  const f=await fixture(); await f.store.putJob(opening(1),true); await f.store.putJob(copy(2),true);
  await handle(f,message(1,'/start')); await handle(f,callback(1,'search:0'));
  assert(f.api.edited.at(-1).text.includes('1 из 1'));
  await handle(f,callback(1,'view:1:0:details:s')); assert(!f.api.edited.at(-1).text.includes('Подборка изменилась'));
  await handle(f,callback(1,'view:2:0:hide:f')); assert(f.api.edited.at(-1).text.includes('Подходящих вакансий нет'));
  await f.store.putJob(copy(3),true);
  await handle(f,callback(1,'job:3:full')); assert(f.api.edited.at(-1).text.includes('Вакансия скрыта'));
  await f.store.patch(1,{hidden_jobs:[1,2]}); await handle(f,callback(1,'menu')); assert(f.api.edited.at(-1).text.includes('Скрытые вакансии: 1'));
  await handle(f,callback(1,'hidden:0')); assert(f.api.edited.at(-1).text.includes('Скрытые вакансии · 1'));
  await handle(f,callback(1,'restore:3:0')); assert.deepEqual((await f.store.user(1)).settings.hidden_jobs,[]);
  await handle(f,callback(1,'search:0')); assert(f.api.edited.at(-1).text.includes('1 из 1'));
  assert.equal((await f.store.stats()).jobs,3);
});

test('notification baseline suppresses reposts of the old catalog; sent and uncertain copies suppress new ones', async () => {
  const f=await fixture(); await f.store.putJob(opening(1),true);
  await handle(f,message(1,'/start')); await handle(f,callback(1,'notify:instant'));
  await f.store.putJob(copy(2),true); assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  await f.store.putJob(opening(3,{title:'Пекарь'}),true); assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
  await f.store.putJob(copy(4,{title:'Пекарь'}),true); assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  await f.store.putJob(opening(5,{title:'Бариста'}),true); f.api.sendMessage=async()=>{throw new Error('timeout');};
  assert.equal((await notifyOne(f.store,f.api,1)).uncertain,true);
  await f.store.putJob(copy(6,{title:'Бариста'}),true); assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  assert.equal((await f.store.stats()).deliveries,2);
});

test('pre-existing historical delivery or hide of either copy suppresses the group', async () => {
  const f=await fixture(); await f.store.ensure(1,1); await f.store.patch(1,{notifications:'instant'});
  await f.store.putJob(opening(1),true); await f.store.putJob(copy(2),true);
  await f.store.importRows('deliveries',[{user_id:1,job_id:2}]); assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  await f.store.ensure(2,2); await f.store.patch(2,{notifications:'instant',hidden_jobs:[1]});
  assert.equal((await notifyOne(f.store,f.api,2)).sent,0);
});

test('old daily-hour input redirects to instant notifications; expired cards and maps are clear', async () => {
  const f=await fixture(); await handle(f,message(1,'/start'));
  await handle(f,callback(1,'input:hour')); assert(f.api.edited.at(-1).text.includes('после обнаружения'));
  assert.equal((await f.store.user(1)).settings.pending_input,null);
  await f.store.patch(1,{pending_input:'hour'}); await handle(f,message(1,'10'));
  assert.equal((await f.store.user(1)).settings.pending_input,null);
  const j=opening(1); j._cloud.expires_ms=1; j._cloud.location_url='https://www.google.com/maps/search/?api=1&query=Beograd';
  assert(card(j).includes('Срок публикации истёк'));
  assert.equal((card(j).match(/maps\/search/g)||[]).length,1);
  assert(!JSON.stringify(links(j)).includes('maps/search'));
  await f.store.putJob(j,true); await handle(f,callback(1,'job:1:full')); assert(f.api.edited.at(-1).text.includes('Срок публикации истёк'));
});

test('all current menu/card/filter callbacks produce a usable response; translation works', async () => {
  const f=await fixture(); await f.store.putJob(job(1),true); await f.store.putJob(job(2),true);
  f.fetch=async()=>({ok:true,json:async()=>[[['Переведённый текст']]]});
  const queue=['menu','notifications','delete'], seen=new Set();
  while(queue.length) {
    const action=queue.shift(); if(seen.has(action)) continue; seen.add(action);
    const before=f.api.edited.length+f.api.sent.length;
    await handle(f,callback(1,action));
    assert(f.api.edited.length+f.api.sent.length>before,action);
    const last=f.api.edited.at(-1);
    for(const b of last.reply_markup.inline_keyboard.flat()) if(b.callback_data && b.callback_data!=='delete_confirm') {
      assert(Buffer.byteLength(b.callback_data)<=64); queue.push(b.callback_data);
    }
    assert(seen.size<200,'bounded button graph');
  }
  assert(seen.size>40);
  await handle(f,callback(1,'restore:1')); await handle(f,callback(1,'job:1:ru_full')); assert(f.api.edited.at(-1).text.includes('Переведённый текст'));
});
