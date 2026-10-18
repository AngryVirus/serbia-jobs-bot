import { positive } from './store.js';
export const OWNER_ID=340780041;
export const ROLE_NAMES={owner:'Владелец',administrator:'Администратор',moderator:'Модератор',user:'Пользователь'};
export const rank=role=>({owner:3,administrator:2,moderator:1,user:0})[role]||0;
export const nonce=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,12);
export async function roleRecord(store,uid){const r=await store.db.get("SELECT payload FROM sjc_records WHERE kind='staff_role' AND record_key=:uid",{':uid':String(uid)});return r?JSON.parse(r.payload):null;}
export async function rawRole(store,uid){if(uid===OWNER_ID)return 'owner';const row=await roleRecord(store,uid);return ['administrator','moderator'].includes(row?.role)?row.role:'user';}
export async function accessRole(bot){
 if(!positive(bot.uid)||bot.uid!==bot.chat)return 'user';
 if(bot.uid===OWNER_ID)return 'owner';
 if(await bot.store.isBanned(bot.uid))return 'user';
 return rawRole(bot.store,bot.uid);
}
export async function mayBan(bot,uid){const role=await accessRole(bot);return uid!==bot.uid && uid!==OWNER_ID && rank(role)>0 && rank(role)>rank(await rawRole(bot.store,uid));}
export function mayManage(actorRole,currentRole,nextRole){
 if(actorRole==='owner')return ['user','moderator','administrator'].includes(currentRole)&&['user','moderator','administrator'].includes(nextRole);
 return actorRole==='administrator'&&['user','moderator'].includes(currentRole)&&['user','moderator'].includes(nextRole);
}
// Decision and audit event commit in one SQLite statement; replay uses the same version.
export async function staffDecision(store,kind,uid,next,event){
 await store.pruneStaffAudit();
 const key=`${kind}:${uid}:${next.version}`;
 await store.db.run("INSERT INTO sjc_records(kind,record_key,payload) VALUES(:kind,:uid,:payload),('staff_audit',:event,:audit) ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload",{':kind':kind,':uid':String(uid),':payload':JSON.stringify(next),':event':key,':audit':JSON.stringify(event)});
}
