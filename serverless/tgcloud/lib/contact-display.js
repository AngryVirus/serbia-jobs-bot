// Presentation only: keep source data intact and routes available in buttons.
import { validUrl } from './filters.js';
import { canonicalUrl } from './catalog.js';
const EMAIL=/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi;
const URL=/(?:https?:\/\/|www\.|(?:t|telegram)\.me\/)[^\s<>"']+/gi;
const HANDLE=/(?<![\w@])@[A-Z0-9_]{5,32}\b/gi;
const DOMAIN=/(?<![\w@])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
// Job-source validation requires a listing path; employer contacts may be homepages.
const validContactUrl=url=>url.length<=2048&&/^https?:\/\/[^\s/@<>"\\?#]+(?:[/?#][^\s<>"\\]*)?$/i.test(url);
const unique=values=>[...new Set(values)];
export function withoutWebLinks(value) {
 const emails=[];
 return String(value||'').replace(EMAIL,m=>`\uE000${emails.push(m)-1}\uE001`)
  .replace(URL,'').replace(HANDLE,'').replace(DOMAIN,'')
  .replace(/\uE000(\d+)\uE001/g,(_,i)=>emails[Number(i)])
  .split('\n').map(line=>line.replace(/[ \t]+/g,' ').trim()).join('\n').trim();
}
export function contactDetails(job) {
 const text=(job.contacts||[]).join('\n'),emails=unique(text.match(EMAIL)||[]);
 const clean=withoutWebLinks(text).replace(EMAIL,'');
 const phones=unique((clean.match(/(?<![\p{L}\p{N}])\+?\d[\d ()/.-]{5,}\d(?![\p{L}\p{N}])/gu)||[])
  .map(x=>x.trim()).filter(x=>{const n=x.replace(/\D/g,'').length;return n>=7&&n<=15&&!/^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/.test(x);}));
 return {phones,emails};
}
export function contactButtons(job) {
 const text=(job.contacts||[]).join('\n').replace(EMAIL,'');
 const remaining=text.replace(URL,'');
 const candidates=[...(text.match(URL)||[]),...(remaining.match(HANDLE)||[]).map(x=>'https://t.me/'+x.slice(1)),...(remaining.replace(HANDLE,'').match(DOMAIN)||[])];
 const sources=[job.url,...(job._sources||[]).map(s=>s.url)].filter(validUrl).map(canonicalUrl);
 const channel=url=>/^t\.me\/(?:s\/)?([^/?#]+)/i.exec(url)?.[1]?.toLowerCase();
 const seen=new Set(),rows=[];
 for(let url of candidates) {
  url=url.replace(/[.,;!?)]+$/,'');if(!/^https?:\/\//i.test(url))url='https://'+url;
  if(!validContactUrl(url))continue;
  const key=canonicalUrl(url),name=channel(key);
  if(seen.has(key)||sources.some(s=>s===key||(name&&name===channel(s))))continue;
  seen.add(key);rows.push([{text:name?'💬 Контакт в Telegram':'🌐 Сайт для связи',url}]);
 }
 const {phones,emails}=contactDetails(job),values=[...phones,...emails];
 const copy=values.join('\n');
 if(copy&&copy.length<=256)rows.push([{text:'📋 Скопировать контакты',copy_text:{text:copy}}]);
 return rows;
}
export function vacancyDescription(job) {
 const lines=String(job.description||'').split(/\r?\n/);
 const key=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
 const first=lines.findIndex(s=>s.trim());
 if(first>=0&&key(lines[first])===key(job.title||''))lines.splice(first,1);
 return withoutWebLinks(lines.join('\n'));
}
