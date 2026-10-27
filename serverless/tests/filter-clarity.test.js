import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, settings, matches, keywordContains } from '../tgcloud/lib/filters.js';
import { summary, choicePanel, filtersPanel, menu } from '../tgcloud/lib/ui.js';
import { job } from './fixtures.js';

test('city case forms and positive profession keywords retain precise boundaries',()=>{
 for(const [city,location] of [['belgrade','В Белграде'],['novi_sad','В Новом Саду'],['nis','В Нишу'],['subotica','В Суботице'],['kragujevac','В Крагуевце']])assert(matches(job(1,{location}),{...defaults(),city}));
 assert(!matches(job(1,{location:'Ниша рынка'}),{...defaults(),city:'nis'}));
 for(const [term,text] of [['повар','Ищем повара'],['официант','Нужны официанты'],['курьер','Работа курьером'],['водитель','Ищем водителя']])assert(keywordContains(text,term));
 for(const [term,text] of [['повар','Повариха'],['водитель','Путеводитель'],['курьер','Курьерский сервис']])assert(!keywordContains(text,term));
 assert(matches(job(1,{title:'Ищем повара'}),{...defaults(),keywords:['повар']}));
 assert(matches(job(1,{title:'Ищем повара',description:'Работа на кухне'}),{...defaults(),exclusions:['повар']}));
 assert(!matches(job(1,{title:'Повар'}),{...defaults(),exclusions:['повар']}));
});

test('permit labels describe the employer requirement and preserve stored yes/no values',()=>{
 const [text,rows]=choicePanel({...defaults(),residence_permit:'no'},'residence_permit');
 assert(text.includes('требование работодателя'));
 assert(rows.flat().some(b=>b.text==='✅ Не требуется'&&b.callback_data==='choose:residence_permit:no:1'));
 assert(summary({...defaults(),residence_permit:'yes'}).includes('Требование ВНЖ:</b> Обязателен'));
 assert(filtersPanel(defaults())[0].includes('действуют одновременно'));
 assert.equal(menu(defaults())[1].flat().length,4);
});

test('legacy no_serbian is visible and removable without silently changing its meaning',()=>{
 const s=settings({language:'no_serbian'}),[text,rows]=choicePanel(s,'language');
 assert(summary(s).includes('Без обязательного сербского (прежний фильтр)'));
 assert(!summary(s).includes('no_serbian'));
 assert(text.includes('Сохранён прежний фильтр'));
 assert(rows.flat().some(b=>b.callback_data==='choose:language:any:1'));
 assert(!matches(job(1,{serbian_required:null}),s));
 assert(matches(job(1,{serbian_required:false}),s));
});
