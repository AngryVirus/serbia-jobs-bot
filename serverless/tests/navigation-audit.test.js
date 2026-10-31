import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,callback,job} from './fixtures.js';
import {Bot} from '../tgcloud/lib/bot.js';
import {OWNER_ID} from '../tgcloud/lib/permissions.js';
import {defaults} from '../tgcloud/lib/filters.js';

// Walk actual rendered keyboards, with each branch isolated by a SQLite
// savepoint. Telegram and HTTP are fixture doubles; no live messages are sent.
const key=action=>action.replace(/discover:[a-z0-9]{8}:/g,'discover:SESSION:')
 .replace(/((?:favorite|report|risk|ratings|admin:close):.*:)[a-z0-9]{8}(?=:|$)/g,'$1SESSION')
 .replace(/(confirm:|replace:|remove:)([a-z0-9]{8,40})$/g,'$1TOKEN')
 .replace(/(plans:[a-z]+:)[a-z0-9]{8,12}/g,'$1PLAN');
async function seed(uid,role){
 const f=await fixture();
 for(const id of [1,2,3,4,5,6,7,8,77,78,OWNER_ID])await f.store.ensure(id,id);
 for(const [id,r] of [[2,'moderator'],[3,'administrator']])await f.store.record('staff_role',id,{uid:id,role:r,version:'staff12345'});
 if(role!=='user'&&role!=='owner')await f.store.record('staff_role',uid,{uid,role,version:'staff12345'});
 for(let id=1;id<=8;id++)await f.store.putJob(job(id,{title:id<3?'Повар':'Вакансия '+id,company:'Ресторан',description:('Нужен повар в ресторан. ').repeat(8)+' Смена '+id,url:`https://example.rs/jobs/${id}`,contacts:['https://t.me/hiring_person']}),true);
 await f.store.record('moderation',8,{ids:[8],blocked:true,updated_at:new Date().toISOString()});
 await f.store.record('user_ban',78,{uid:78,active:true,version:'ban123456',reason:'Проверка',at:new Date().toISOString()});
 await f.store.record('report','77:1',{user_id:77,job_id:1,group_id:1,state:'open',reason:'outdated',reporter:{id:77,name:'Автор'}});
 for(const [id,state] of [[1,'pending'],[2,'published'],[3,'deleted']])await f.store.record('vacancy_review',id+':77',{key:id+':77',job_id:id,uid:77,author:{id:77,name:'Автор'},title:'Повар',stars:2,text:'Личный опыт собеседования',state,version:'review123456',at:new Date().toISOString()});
 await f.store.record('source_idea','testjobs',{state:'pending',notice:'sent',created_at:new Date().toISOString()});
 await f.store.setFavorite(uid,[1],true,'seed');
 await f.store.patch(uid,{hidden_jobs:[7],saved_searches:[{id:'saved123',name:'Работа',filters:defaults(),notifications:'off',notifications_after_id:0,last_viewed_id:0}]});
 await f.store.setMeta('last_successful_collection',new Date().toISOString());
 return f;
}
for(const [role,uid] of [['user',1],['moderator',2],['administrator',3],['owner',OWNER_ID]])test(`all reachable ${role} buttons have unique targets, valid payloads and a working handler`,async t=>{
 const f=await seed(uid,role),visited=new Set(),failures=[];let output,homes=0;
 class CheckedBot extends Bot {
  async panel(text,rows=[]){output={text,rows};}
  async home(){homes++;return super.home();}
 }
 async function walk(action,path=[]){
  const signature=key(action);if(visited.has(signature))return;
  visited.add(signature);assert(visited.size<10000,'navigation must be bounded');
  const savepoint='walk'+path.length;f.db.connection.exec('SAVEPOINT '+savepoint);
  try{
   output=null;homes=0;
   // Rate limits are tested separately; a traversal is not a human click rate.
   await f.db.run("DELETE FROM sjc_records WHERE kind='rate'");
   await new CheckedBot(f).handle(callback(uid,action));
   if(!output){failures.push(`${action}: no response`);return;}
   if(homes&&!['menu','start','cancel'].includes(action))failures.push(`${action}: fell through to main menu`);
   if(/Недостаточно прав|раздел доступен только|Управление этим сотрудником недоступно/.test(output.text))failures.push(`${action}: exposed an unavailable action`);
   const buttons=output.rows.flat(),targets=new Set();
   for(const b of buttons){
    const target=b.callback_data||b.url;
    if(!target||targets.has(target))failures.push(`${action}: missing or duplicate target ${target}`);
    targets.add(target);
    if(b.callback_data&&Buffer.byteLength(b.callback_data)>64)failures.push(`${action}: callback exceeds Telegram limit ${b.callback_data}`);
   }
   for(const b of buttons)if(b.callback_data)await walk(b.callback_data,[...path,action]);
  }catch(e){failures.push(`${path.slice(-2).concat(action).join(' > ')}: ${e.message}`);}
  finally{f.db.connection.exec('ROLLBACK TO '+savepoint+'; RELEASE '+savepoint);}
 }
 await walk('menu');
 t.diagnostic(`${visited.size} distinct callbacks checked for ${role}`);
 assert.deepEqual(failures,[]);
 f.db.connection.close();
});
