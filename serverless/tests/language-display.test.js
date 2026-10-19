import test from 'node:test';
import assert from 'node:assert/strict';
import { displayLanguages } from '../tgcloud/lib/language-display.js';
import { card,translatedCard } from '../tgcloud/lib/ui.js';
import { fixture,job } from './fixtures.js';
const nsz='Језик:\nЕнглески: Читање: Почетни(A1); Писање: Почетни(A1); Говор: Почетни(A1); - Пожељно';
test('NSZ 104197 language row shows A1 and preferred without inventing Serbian',()=>{
 const j=job(1,{description:nsz,_cloud:{...job(1)._cloud,languages:['en'],required_languages:[]}});
 assert.equal(displayLanguages(j),'Английский — A1 (желателен)');
 assert.match(card(j),/Языки: Английский — A1 \(желателен\)/);
 assert.doesNotMatch(card(j),/Сербский|обяз\./);
});
test('levels and preference stay local to the named language',()=>{
 const j=job(1,{description:'Russian A2 required; English C1 preferred.\nSerbian B1 required.',_cloud:{...job(1)._cloud,languages:['ru','en','sr'],required_languages:['ru','sr']}});
 assert.equal(displayLanguages(j),'Русский — A2 (обяз.), Английский — C1 (желателен), Сербский — B1 (обяз.)');
 assert.equal(displayLanguages({...j,description:'English C1 preferred, Serbian B1.',_cloud:{languages:['en','sr'],required_languages:[]}}),'Английский — C1 (желателен), Сербский — B1');
});
test('unknown levels, skill-specific differences, background mentions and absent languages are preserved',()=>{
 const j=job(1,{description:'Russian company, English: Reading A1; Speaking B2; Preferred. Serbian company model C2.',_cloud:{...job(1)._cloud,languages:['en'],required_languages:[]}});
 assert.equal(displayLanguages(j),'Английский — A1 / B2 (желателен)');
 assert.equal(displayLanguages({...j,description:'English knowledge welcome'}),'Английский');
 assert.equal(displayLanguages({...j,title:'English B2 support',description:'Работа в офисе'}),'Английский — B2');
 assert.equal(displayLanguages({...j,_cloud:{languages:[]}}),'не указаны');
});
test('translation retains original language facts, levels and preference',async()=>{
 const f=await fixture(),j=job(1,{description:nsz,_cloud:{...job(1)._cloud,languages:['en'],required_languages:[]}});
 const result=await translatedCard(j,'rf',async()=>({ok:true,json:async()=>[[['Переведённое описание без языков']]]}),f.store);
 assert.equal(result.failed,false);assert.match(result.text,/Английский — A1 \(желателен\)/);
});
