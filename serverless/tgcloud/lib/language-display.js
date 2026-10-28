// Original text only; the shared extractor decides which languages are stated.
import { normalize } from './filters.js';
const LANGUAGES={ru:['Русский','russian|ruski|русск\\p{L}*|руск\\p{L}*'],sr:['Сербский','serbian|srpsk\\p{L}*|сербск\\p{L}*|српск\\p{L}*'],en:['Английский','english|englesk\\p{L}*|английск\\p{L}*|енглеск\\p{L}*'],de:['Немецкий','german|nemack\\p{L}*|немецк\\p{L}*|немачк\\p{L}*']};
const word=new RegExp('(?<![\\p{L}\\p{N}_])(?:'+Object.values(LANGUAGES).map(x=>x[1]).join('|')+')(?![\\p{L}\\p{N}_])','gu');
const optional=/optional|preferred|nice to have|желател|преимуществ|pozeljn|prednost|пожељн|предност/u;
const background=/^\s*(?:[- ]speaking\s+)?(?:compan\p{L}*|citizenship|passport|market|компани\p{L}*|гражданств\p{L}*|паспорт\p{L}*|рын\p{L}*|kompanij\p{L}*|drzavljan\p{L}*)(?!\p{L})/u;
export function displayLanguages(job) {
 const facts=job._cloud||{},details={};
 const original=[job._language_title??job.title??'',job._language_original??job.description??''].join('\n');
 for(const line of original.split(/\r?\n/)) {
  const text=normalize(line),mentions=[...text.matchAll(word)];
  for(let i=0;i<mentions.length;i++) {
   const mention=mentions[i],entry=Object.entries(LANGUAGES).find(([,v])=>new RegExp('^(?:'+v[1]+')$','u').test(mention[0]));
   if(!entry||background.test(text.slice(mention.index+mention[0].length)))continue;
   const tail=text.slice(mention.index+mention[0].length,mentions[i+1]?.index).slice(0,400).split(/[.!?]/)[0];
   const between=text.slice(i?mentions[i-1].index+mentions[i-1][0].length:0,mention.index);
   const before=i===0||/[;,.!?]/.test(between)?between.split(/[;,.!?]/).at(-1):'';
   const levels=[...tail.matchAll(/(?<![\p{L}\p{N}_])([aаbвcс][12]\+?)(?![\p{L}\p{N}_])/gu)].map(m=>m[1].replace(/^[авс]/u,c=>({'а':'a','в':'b','с':'c'}[c]||c)).toUpperCase());
   const preceding=/(?<![\p{L}\p{N}_])([aаbвcс][12]\+?)\s*$/u.exec(before);
   if(preceding)levels.unshift(preceding[1].replace(/^[авс]/u,c=>({'а':'a','в':'b','с':'c'}[c])).toUpperCase());
   const current=details[entry[0]]||{levels:new Set(),preferred:false,minimum:false};
   levels.forEach(level=>current.levels.add(level));
   current.minimum=current.minimum||/(?:не ниже|не менее|at least|minimum)\s+(?:(?:уровн\p{L}*|level)\s+)?[aаbвcс][12](?![\p{L}\p{N}_])/u.test(tail+before);
   current.preferred=current.preferred||optional.test(tail)||optional.test(before.slice(-45));
   details[entry[0]]=current;
  }
 }
 return (facts.languages||[]).map(code=>{
  const d=details[code],levels=d?[...d.levels].sort().slice(0,4):[];
  const requirement=(facts.required_languages||[]).includes(code)?' (обяз.)':d?.preferred?' (желателен)':'';
  return (LANGUAGES[code]?.[0]||code)+(levels.length?' — '+(d.minimum?'не ниже ':'')+levels.join(' / '):'')+requirement;
 }).join(', ')||'не указаны';
}
