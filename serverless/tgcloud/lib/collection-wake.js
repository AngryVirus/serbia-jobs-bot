import { successfulCollection } from './analytics.js';
import { assert } from './store.js';

const URL='https://api.github.com/repos/AngryVirus/serbia-jobs-bot/actions/workflows/catch-up.yml/dispatches';
const CONFIG='collection_wake_config',STATE='collection_wake_state';
const STATES=new Set(['requested','unconfirmed','denied','limited','unavailable']);

// Only the trusted owner CLI can call the configuration operation. A credential
// lives in private SQLite, never source, callbacks, public reports or logs.
// The existing encrypted database backup is the only backup of this setting.
export async function configureWake(store,input) {
  assert(typeof input.enabled==='boolean','Invalid wake configuration');
  if(input.enabled)assert(typeof input.credential==='string'&&/^[A-Za-z0-9_]{40,255}$/.test(input.credential),'Invalid wake credential');
  await store.setMeta(CONFIG,input.enabled?{enabled:true,credential:input.credential}:{enabled:false});
  await store.setMeta(STATE,null);
  return {enabled:input.enabled};
}
export async function wakeStatus(store) {
  const config=await store.meta(CONFIG),state=await store.meta(STATE);
  return {enabled:config?.enabled===true&&typeof config.credential==='string',
    state:STATES.has(state?.status)?state.status:null,
    requested_at:Number.isFinite(state?.at)?new Date(state.at).toISOString():null};
}
export async function requestCollectionWake(store,fetch,{manual=false,now=Date.now()}={}) {
  const config=await store.meta(CONFIG);
  if(config?.enabled!==true||typeof config.credential!=='string')return {status:'disabled'};
  if(!await store.meta('active'))return {status:'paused'};
  const last=Date.parse(await successfulCollection(store));
  if(Number.isFinite(last)&&now-last<(manual?1800000:3600000))return {status:'fresh'};
  const run=await store.meta('collection_run');
  const lease=await store.db.get("SELECT owner,expires FROM sjc_locks WHERE key='collection'");
  if(run?.state==='running'&&lease?.owner===run.owner&&lease.expires>now)return {status:'running'};
  const previous=await store.meta(STATE);
  if(previous?.status==='denied')return {status:'denied'};
  if(previous?.retry_at>now)return {status:'waiting',wait:Math.ceil((previous.retry_at-now)/1000)};
  // Atomic persistent limits apply to all users and owner clicks together.
  // Claim before the network call: an interrupted/ambiguous POST is never
  // immediately retried by another update or after a runtime restart.
  const wait=await store.rate('collection:wake:cooldown',1,900,now);
  if(wait)return {status:'waiting',wait};
  const daily=await store.rate('collection:wake:daily',12,86400,now);
  if(daily)return {status:'daily_limit',wait:daily};
  const current=await store.meta(CONFIG);
  if(current?.enabled!==true||current.credential!==config.credential)return {status:'disabled'};
  await store.setMeta(STATE,{status:'unconfirmed',at:now});
  let status='unconfirmed',retry_at=0;
  try {
    const response=await fetch(URL,{method:'POST',headers:{
      Authorization:'Bearer '+config.credential,Accept:'application/vnd.github+json',
      'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28',
      'User-Agent':'SerbiaJobsBot-collection-wake'},body:JSON.stringify({ref:'main'})});
    // Never read or log an error body: it may contain private request details.
    const header=name=>typeof response.headers?.get==='function'?response.headers.get(name):response.headers?.[name.toLowerCase()];
    const retry=Number(header('retry-after')),limited=response.status===429||response.status===403&&(retry>0||header('x-ratelimit-remaining')==='0');
    status=response.status===204?'requested':limited?'limited':response.status===401||response.status===403?'denied':'unavailable';
    if(limited)retry_at=now+Math.max(900,Number.isFinite(retry)&&retry>0?retry:3600)*1000;
  } catch {/* A timeout can follow an accepted dispatch. Preserve the claim. */}
  await store.db.run("UPDATE sjc_meta SET payload=:payload WHERE key=:key AND json_extract(payload,'$.at')=:at",{':key':STATE,':at':now,':payload':JSON.stringify({status,at:now,retry_at})});
  return {status};
}
export function wakeMessage(result) {
  return ({requested:'✅ Запрос на сбор передан GitHub. Выполнение может начаться с задержкой; это ещё не подтверждение обновления базы.',
    running:'⏳ Сбор уже выполняется.',fresh:'✅ База обновлялась недавно. Дополнительный сбор сейчас не нужен.',
    disabled:'Резервный запуск пока не подключён.',paused:'Бот приостановлен. Сбор не запущен.',
    denied:'⚠️ GitHub отклонил доступ. Проверьте настройку служебного ключа.',
    limited:'⏳ GitHub временно ограничил запросы. Автоматического повтора сейчас не будет.',
    unavailable:'GitHub сейчас не подтвердил запуск. Текущее расписание остаётся включённым.',
    unconfirmed:'Не удалось подтвердить приём запроса. Повторный запрос временно отложен, чтобы не создавать дубликаты.'})[result.status]||
    `⏳ Следующая попытка возможна через ${Math.max(1,Math.ceil((result.wait||900)/60))} мин.`;
}
