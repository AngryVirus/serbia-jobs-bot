import { DatabaseSync } from 'node:sqlite';
import { Store } from '../tgcloud/lib/store.js';
import { Bot } from '../tgcloud/lib/bot.js';
export function sqlite() {
  const connection = new DatabaseSync(':memory:');
  return { connection,
    async run(sql, params = {}) { const r = connection.prepare(sql).run(params); return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    async get(sql, params = {}) { return connection.prepare(sql).get(params); },
    async all(sql, params = {}) { return connection.prepare(sql).all(params); } };
}
export function telegram() {
  const sent = [], edited = [];
  return { sent, edited, async getMe() { return { id: 8802394224, is_bot:true, username:'SerbiaJobsBot' }; }, async getChat() { return { id:340780041, type:'private', username:'AngryVirus' }; },
    async sendMessage(p) { sent.push(p); return { message_id:sent.length }; }, async editMessageText(p) { edited.push(p); }, async answerCallbackQuery() {} };
}
export const job = (id, extra = {}) => ({ id,source:'tg_rabotavserbii',url:`https://t.me/rabotavserbii/${id}`,title:'Повар <&>',description:'Нужен повар. Адрес: Knez Mihailova 12',location:'Beograd',salary_min:1200,salary_currency:'EUR',salary_period:'month',remote:false,
  _cloud:{ version:1,serbia:true,languages:['ru'],required_languages:[],permit:null,published_ms:null,published_day:null,date_only:false,expires_ms:null,date_label:null,address:'Knez Mihailova 12',map_url:'https://www.google.com/maps/search/?api=1&query=Knez+Mihailova+12',location_url:null }, ...extra });
export async function fixture() { const db=sqlite(), api=telegram(), store=new Store(db); await store.init(); await store.setMeta('active',true); return {db,api,store,fetch:async()=>{ throw new Error('offline'); }}; }
let updateId=100;
export const message = (uid,text) => ({update_id:++updateId,message:{message_id:updateId,chat:{id:uid,type:'private'},from:{id:uid},text}});
export const callback = (uid,data) => ({update_id:++updateId,callback_query:{id:String(updateId),from:{id:uid},message:{message_id:1,chat:{id:uid,type:'private'}},data}});
export async function handle(f,u) { await new Bot(f).handle(u); }

