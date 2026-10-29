import test from 'node:test';
import assert from 'node:assert/strict';
import {contactDetails,contactButtons,withoutWebLinks,vacancyDescription} from '../tgcloud/lib/contact-display.js';
import {vacancyPresentation,cardActions,links,sourceChoice} from '../tgcloud/lib/ui.js';
import {job} from './fixtures.js';

test('publication links never masquerade as phone numbers, employer contact uses a button',()=>{
 const j=job(1,{url:'https://t.me/serbia_vacancies/1234567',contacts:['https://t.me/serbia_vacancies','https://t.me/MarinaBeograd','@MarinaBeograd']});
 assert.deepEqual(contactDetails(j),{phones:[],emails:[]});
 assert.equal(vacancyPresentation(j,'s').caption,'');
 assert.deepEqual(contactButtons(j),[[{text:'💬 Контакт в Telegram',url:'https://t.me/MarinaBeograd'}]]);
 assert.equal(links(j)[0][0].url,j.url);
 const choices=sourceChoice(j,'job:1:short')[1].flat();
 assert.deepEqual(choices.filter(x=>x.url).map(x=>x.url),[j.url]);
 assert.equal(cardActions(j,0,'s')[1].flat().filter(x=>x.url).length,0);
});
test('phones and emails stay plain clickable text without code blocks or copy buttons',()=>{
 const j=job(1,{contacts:['+381 11 3409 343','person@example.com','https://example.com/jobs/123456789','28.10.2026']});
 assert.deepEqual(contactDetails(j),{phones:['+381 11 3409 343'],emails:['person@example.com']});
 assert.equal(vacancyPresentation(j,'s').caption,'📞 +381 11 3409 343\n✉️ person@example.com');
 assert(!cardActions(j,0,'s')[1].flat().some(x=>x.copy_text||x.text.includes('Скопировать')));
 assert.doesNotMatch(vacancyPresentation(j,'s').caption,/<(?:pre|code|blockquote)/);
 assert.deepEqual(contactDetails(job(2,{contacts:['064/2649-375','https://t.me/channel/234567890']})).phones,['064/2649-375']);
});
test('expanded descriptions preserve phone/email but remove web and Telegram links without altering data',()=>{
 const description='💼 Администратор\nТребуется опыт работы.\nСвязь: person@example.com, +381 11 3409 343\nhttps://t.me/contact_user @contact_user\nwww.example.com example.rs/jobs\nУсловия: 2 выходных.';
 const j=job(1,{title:'Администратор',description,contacts:['https://t.me/contact_user']});
 const result=vacancyPresentation(j,'f').text;
 assert.equal(j.description,description);
 assert.equal((result.match(/Администратор/g)||[]).length,1);
 assert.doesNotMatch(result,/https?:\/\/|www\.|href=|@contact_user|example\.rs/);
 assert.match(result,/person@example.com/);assert.match(result,/\+381 11 3409 343/);assert.match(result,/Условия: 2 выходных/);
 assert.equal(vacancyDescription({...j,description:'В клинику требуется администратор'}),'В клинику требуется администратор');
 assert.equal(withoutWebLinks('почта hr+jobs@clinic.rs; сайт https://clinic.rs.'),'почта hr+jobs@clinic.rs; сайт');
});
test('oversized contact lists remain selectable without a partial copy; contact homepages are preserved',()=>{
 const j=job(1,{contacts:[...Array.from({length:30},(_,i)=>`person${i}@example.com`),'javascript:alert(1)']});
 assert.deepEqual(contactButtons(j),[]);assert.match(vacancyPresentation(j,'s').caption,/person29@example.com/);
 const rows=contactButtons(job(2,{contacts:['www.clinic.rs','https://clinic.rs/jobs?ref=other.rs']})).flat();
 assert.deepEqual(rows.map(x=>x.url),['https://www.clinic.rs','https://clinic.rs/jobs?ref=other.rs']);
});
