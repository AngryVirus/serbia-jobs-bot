import test from 'node:test';
import assert from 'node:assert/strict';
import { vacancyWarnings } from '../tgcloud/lib/risks.js';

const warnings = description => vacancyWarnings({ title:'Вакансия', description });
const codes = description => warnings(description).map(item => item.code);
const positive = {
  job_advance_payment: [
    'Для трудоустройства внесите залог 100 евро.',
    'Для получения контактов работодателя необходимо оплатить 30 евро.',
    'До начала работы требуется предоплата за оформление.',
    'Предоплата за трудоустройство 50 евро.',
    'Обязательное платное обучение перед работой.',
    'Платный курс обязателен перед началом работы.',
    'You must pay a placement fee of 50 EUR to get the job.',
    'Pay a deposit before starting work.',
    'Application fee: 50 EUR.',
    'Paid training is mandatory to get the job.',
    'Za dobijanje posla uplatite depozit 50 EUR.',
    'За добијање посла уплатите депозит 50 EUR.',
    'Naknada za zaposlenje je obavezna.',
    'Naknada za zaposlenje 50 EUR.',
  ],
  bank_security_codes: [
    'Отправьте CVV вашей банковской карты.',
    'Для проверки предоставьте пароль от онлайн-банка.',
    'Пришлите СМС-код подтверждения из банка.',
    'Пришлите код из СМС от банка.',
    'Пришлите ПИН-код от вашей банковской карты.',
    'Please provide your banking password.',
    'Send your SMS code from the bank for verification.',
    'Share your bank card PIN with our recruiter.',
    'Pošaljite PIN kartice za proveru.',
    'Доставите лозинку вашег банковног рачуна.',
  ],
  personal_bank_account: [
    'Сдайте свой банковский счет в аренду другим людям.',
    'Арендуем ваш личный банковский счет.',
    'Передайте свой банковский счет в управление третьим лицам.',
    'Rent out your personal bank account.',
    'Give your bank account to us for use by our clients.',
    'Dajte svoj bankovni račun na korišćenje trećim licima.',
    'Iznajmite svoj bankovni račun.',
    'Дајте свој банковни рачун на коришћење трећим лицима.',
  ],
};
for (const [code, examples] of Object.entries(positive)) {
  test(`${code}: explicit RU/EN/Serbian public text produces a factual hint`, () => {
    for (const text of examples) assert(codes(text).includes(code), text);
  });
}

test('ordinary compensation, free hiring, employer-paid courses and salary accounts are not warnings', () => {
  for (const text of [
    'Работодатель оплачивает обучение. Внесение залога не требуется.',
    'Предоплата за трудоустройство не требуется.',
    'Плата за трудоустройство отсутствует.',
    'Комиссии за трудоустройство нет.',
    'Никаких комиссий за трудоустройство.',
    'Предоплату за трудоустройство не берём.',
    'Не надо вносить депозит для трудоустройства.',
    'Для трудоустройства не нужно платить. Все заявки бесплатны.',
    'Зарплата выплачивается авансом. Для работы нужен личный банковский счет.',
    'Внесите депозит за аренду квартиры после заключения договора, работа не требуется.',
    'The employer must pay a recruitment fee for employment.',
    'No application fee or deposit to get the job.',
    'A deposit is not required before starting work.',
    "You don't have to pay a placement fee to get the job.",
    'You are not required to pay a recruitment fee.',
    'Free training is mandatory before starting work.',
    'Provide your bank account number to receive your salary.',
    'Пришлите PIN доступа к офису.',
    'Send the device PIN.',
    'Pošaljite PIN za ulazak u kancelariju.',
    'Poslodavac plaća obuku za dobijanje posla.',
    'Za dobijanje posla nije potrebna naknada.',
    'Ne morate platiti naknadu za dobijanje posla.',
    'Bez naknade za zaposlenje, prijava je besplatna.',
    'За добијање посла није потребна накнада.',
  ]) assert.deepEqual(codes(text), [], text);
});

test('negated demands and quoted educational warnings do not accuse the vacancy', () => {
  for (const text of [
    'Не сообщайте PIN и никогда не присылайте CVV.',
    'Не передавайте свой банковский счет в аренду другим людям.',
    'Мы не просим сообщить PIN и не запрашиваем CVV.',
    'Осторожно: «Для трудоустройства внесите залог» — признак мошенничества.',
    'Если вас просят прислать CVV, это мошенники.',
    'Мошенники могут писать: «Пришлите CVV».',
    'Do not share your PIN. We never ask you to provide a banking password.',
    'Never rent your personal bank account to other people.',
    'Warning: "Pay a deposit to get the job" is a scam.',
    'If someone asks you to send a PIN, it is a scam.',
    'Scammers ask you to send your banking password.',
    'Ne delite PIN. Nikada ne šaljite CVV.',
    'Nemojte iznajmljujte svoj bankovni racun drugim ljudima.',
    'Upozorenje: "Za dobijanje posla uplatite depozit" je znak prevare.',
  ]) assert.deepEqual(codes(text), [], text);
});

test('warnings are bounded, stable, deduplicated, independent and do not store caller data', () => {
  const description = Object.values(positive).map(x=>x[0]).join('\n');
  const result = warnings(description.repeat(30));
  assert.deepEqual(result.map(x=>x.code), Object.keys(positive));
  assert.equal(result.length,3);
  for(const item of result){ assert.match(item.reason,/^В тексте/); assert(item.advice.length); assert(!/мошенник/i.test(item.reason)); }
  result[0].reason='mutated';
  assert.match(warnings(description)[0].reason,/^В тексте/);
  assert.deepEqual(vacancyWarnings(null),[]);
  assert.deepEqual(vacancyWarnings({ title:42, description:{}, private_input:description, settings:{keywords:[description]} }),[]);
  assert.deepEqual(vacancyWarnings({ description:'x'.repeat(20000)+'\n'+description }),[]);
});

test('normalization handles case, compatibility characters and Serbian diacritics', () => {
  assert.deepEqual(codes('ＯＴＰＲＡＶЬТЕ ＣＶＶ'),[]); // Similar-looking unrelated mixed-script words are not invented instructions.
  assert(codes('ОТПРАВЬТЕ ＣＶＶ вашей карты').includes('bank_security_codes'));
  assert(codes('ПОШАЉИТЕ PIN КАРТИЦЕ').includes('bank_security_codes'));
  assert(codes('Po\u200bšaljite PIN kartice').includes('bank_security_codes'));
  assert(codes('No application fee, but pay a deposit before starting work.').includes('job_advance_payment'));
  assert(codes('Комиссии за трудоустройство нет, но для получения работы внесите депозит 100 евро.').includes('job_advance_payment'));
  assert(codes('Никаких комиссий за трудоустройство. Для получения контактов работодателя оплатите 30 евро.').includes('job_advance_payment'));
  assert(codes('Ne tražimo novac. Za dobijanje posla uplatite depozit 50 EUR.').includes('job_advance_payment'));
});
