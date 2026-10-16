import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,job } from './fixtures.js';
import { translatedCard } from '../tgcloud/lib/ui.js';
import { chunks,sourceLanguage } from '../tgcloud/lib/translation.js';

const foreign=()=>job(1,{title:'Sales manager',description:'We are hiring a manager with experience in sales.'});
test('429 uses a working fallback, caches the result and invalidates changed text',async()=>{
  const f=await fixture(),requests=[];
  const fetch=async url=>{requests.push(url);return url.includes('googleapis')?{ok:false,status:429}:{ok:true,json:async()=>({responseStatus:200,responseData:{translatedText:'Менеджер по продажам'}})};};
  const first=await translatedCard(foreign(),'rf',fetch,f.store);
  assert.equal(first.failed,false); assert(first.text.includes('Менеджер по продажам'));
  assert.equal(requests.filter(u=>u.includes('googleapis')).length,1);
  assert(requests.some(u=>u.includes('langpair=en%7Cru')));
  const count=requests.length;
  await translatedCard(foreign(),'rs',fetch,f.store); assert.equal(requests.length,count);
  await translatedCard({...foreign(),description:'We are hiring a new sales manager.'},'rf',fetch,f.store);
  assert(requests.length>count); assert.equal(requests.filter(u=>u.includes('googleapis')).length,1);
});
test('fallback quota/error text is never cached or displayed as a translation',async()=>{
  const f=await fixture(); let requests=0;
  const fetch=async url=>{requests++;return url.includes('googleapis')?{ok:false,status:429}:{ok:true,json:async()=>({responseStatus:403,quotaFinished:true,responseData:{translatedText:'QUOTA ERROR'}})};};
  const result=await translatedCard(foreign(),'rf',fetch,f.store);
  assert.equal(result.failed,true); assert(!result.text.includes('QUOTA ERROR'));
  assert.equal(await f.store.meta('translation:ru:1'),null);
  await translatedCard(foreign(),'rf',fetch,f.store); assert.equal(requests,2);
});
test('fallback language is detected from text, not employer language requirements; UTF-8 limits hold',()=>{
  assert.equal(sourceLanguage('Potreban radnik za rad u prodavnici. Potrebno iskustvo.'),'sr');
  assert.equal(sourceLanguage('We are looking for a manager with experience. Russian required.'),'en');
  assert.equal(sourceLanguage('Требуется повар. Работа и зарплата для вас.'),'ru');
  assert.equal(sourceLanguage('123 Unknown'),null);
  const text=('Требуется 👩‍💻 čovek za posao. ').repeat(100), parts=chunks(text);
  assert.equal(parts.join(''),text); assert(parts.every(p=>Buffer.byteLength(p)<=500));
});
