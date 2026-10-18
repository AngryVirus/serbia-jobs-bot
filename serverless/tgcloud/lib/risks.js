// Factual, conservative hints about the public vacancy text, never a verdict
// about its author. No private inputs, requests, scoring or automatic hiding.
const MAX_TITLE = 500, MAX_DESCRIPTION = 20000, MAX_CLAUSE = 800;
const WARNING = Object.freeze({
  job_advance_payment: Object.freeze({
    code: 'job_advance_payment',
    reason: 'В тексте указана плата как условие получения работы или контактов работодателя.',
    advice: 'Не переводите деньги до проверки работодателя и условий трудоустройства.',
  }),
  bank_security_codes: Object.freeze({
    code: 'bank_security_codes',
    reason: 'В тексте запрашиваются защитные данные банковской карты или счёта.',
    advice: 'Не сообщайте CVV, PIN, банковские пароли и коды подтверждения.',
  }),
  personal_bank_account: Object.freeze({
    code: 'personal_bank_account',
    reason: 'В тексте предлагается передать личный банковский счёт или доступ к нему другим людям.',
    advice: 'Не передавайте доступ к личному счёту и не принимайте чужие переводы по поручению незнакомых людей.',
  }),
});
const SR_CYRILLIC = Object.freeze({ а:'a',б:'b',в:'v',г:'g',д:'d',ђ:'dj',е:'e',ж:'z',з:'z',и:'i',ј:'j',к:'k',л:'l',љ:'lj',м:'m',н:'n',њ:'nj',о:'o',п:'p',р:'r',с:'s',т:'t',ћ:'c',у:'u',ф:'f',х:'h',ц:'c',ч:'c',џ:'dz',ш:'s' });
const normalize = text => text.normalize('NFKC').toLowerCase()
  .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
  .replace(/[čć]/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'dj')
  .replace(/ё/g, 'е').replace(/[\t\r ]+/g, ' ');
const srLatin = text => text.replace(/[а-яђјљњћџ]/g, char => SR_CYRILLIC[char] || char);
const educational = text => /(?:остерегайтесь|осторожно|признак[\p{L} ]{0,20}мошеннич|это мошеннич|beware|warning[: ]|scam warning|sign of (?:a )?scam|upozorenje|cuvajte se|znak prevare)/u.test(text)
  || /(?:если|if|ako).{0,160}(?:мошенни|scam|fraud|prevar)/u.test(text)
  || /(?:мошенник[\p{L}]*|scammers?|fraudsters?|prevaranti)\s+(?:могут\s+)?(?:просят|просить|пишут|писать|требуют|требовать|ask|request|say|traze|pisu)/u.test(text);

// Negation is attached to the instruction/fee clause, not to the whole advert:
// “No application fee. Pay a deposit to get the job.” still produces a hint.
function payment(text) {
  if (/(?:никаких\s+(?:комисси[\p{L}]*|предоплат[\p{L}]*|платеж[\p{L}]*|взнос[\p{L}]*)|(?:предоплат[\p{L}]*|плат[ауы]|комисси[\p{L}]*|взнос[\p{L}]*).{0,55}(?:\sнет(?:$|[^\p{L}])|отсутству[\p{L}]*|не\s+(?:берем|берут|взимаем|взимают)))/u.test(text)) return false;
  if (/(?:отсутствует\s+(?:предоплата|плата|комиссия)|(?:предоплата|плата|комиссия)\s+отсутствует|без\s+(?:комисси[\p{L}]*|предоплат[\p{L}]*|плат[\p{L}]*)|не\s+(?:нужн[\p{L}]*|требу[\p{L}]*|взима[\p{L}]*|оплачива[\p{L}]*|платите|платить|надо|берем|берут)|(?:no|without)\s+(?:\w+\s+){0,3}(?:fee|fees|payment|deposit)|(?:fee|fees|payment|deposit)\s+(?:is\s+|are\s+)?not\s+(?:required|needed)|\b(?:not|never|don't|do not)\s+(?:\w+\s+){0,3}(?:pay|transfer|send|deposit|required)\b|\b(?:bez|nema)\s+(?:naknad[aeu]|provizij[aeu]|placanja|depozita)|\bne\s+(?:placate|placajte|trazimo|naplacujemo|morate platiti|treba platiti)|nije\s+(?:potrebn[ao]|obavezn[ao]))/u.test(text)) return false;
  if (/(?:работодатель|компания|фирма)\s+(?:сам[\p{L}]*\s+)?(?:оплачива[\p{L}]*|платит|вносит)|\b(?:employer|company)\s+(?:(?:will|must)\s+)?(?:pays?|covers?|provides?)\b|\b(?:poslodavac|kompanija)\s+(?:placa|snosi|uplacuje)\b/u.test(text)) return false;
  const ruContext = /(?:за|для|до|перед|чтобы).{0,55}(?:трудоустройств|получени[яе]\s+(?:работы|контактов)|начал[\p{L}]*\s+работы|контакт[ыоа]*\s+работодателя)|(?:обязательн[\p{L}]*|необходим[\p{L}]*)\s+(?:платн[\p{L}]*\s+)?(?:обучени[\p{L}]*|курс[\p{L}]*)\s+(?:перед|до|для).{0,25}работ/u.test(text);
  const ruDemand = /(?:внесите|внести|заплатите|заплатить|оплатите|оплатить|переведите|перевести).{0,55}(?:плат[\p{L}]*|сбор|взнос|залог|депозит|деньг[\p{L}]*|обучени[\p{L}]*|курс[\p{L}]*|\d)|(?:плат[\p{L}]*|сбор|взнос|залог|депозит).{0,30}(?:обязател[\p{L}]*|требуется)|(?:требуется|необходимо|нужно).{0,30}(?:оплат[\p{L}]*|предоплат[\p{L}]*|взнос|залог|депозит)/u.test(text);
  const enContext = /\b(?:to (?:get|obtain|secure|start) (?:the |a |your )?(?:job|work|position)|(?:before|for) (?:starting |getting |obtaining )?(?:the |a |your )?(?:job|work|employment)|(?:application|recruitment|placement|hiring|employer contact)(?:s)? fee|(?:paid|pay for) (?:training|course).{0,40}(?:required|mandatory|condition))/u.test(text);
  const enDemand = /\b(?:must|required to|need to|have to)\s+(?:\w+\s+){0,2}(?:pay|transfer|send|deposit)\b|\b(?:pay|transfer|send)\s+(?:\w+\s+){0,4}(?:fee|deposit|money|payment|eur|euros?|\d)|\b(?:fee|deposit|payment|paid training).{0,30}(?:required|mandatory|compulsory)|\b(?:required|mandatory|compulsory).{0,30}(?:fee|deposit|payment|paid training)/u.test(text);
  const srContext = /\b(?:za (?:dobijanje |dobivanje )?(?:posla|zaposlenj[ae]|kontakt[ae] poslodavca)|pre (?:pocetka |pocinjanja )?(?:rada|posla)|(?:placena obuka|placeni kurs).{0,35}(?:obavezn|uslov))/u.test(text);
  const srDemand = /\b(?:platite|uplatite|uplatiti|platiti|morate platiti|potrebno je platiti).{0,55}(?:naknad[au]|provizij[au]|depozit|novac|obuku|kurs|\d)|\b(?:naknada|provizija|depozit|uplata).{0,30}(?:obavezn|potrebn)|\b(?:obavezn|potrebn).{0,30}(?:naknad|depozit|uplata)/u.test(text);
  const explicitFee = /(?:^|[^\p{L}])(?:предоплат[\p{L}]*|плат[ауы]|депозит[\p{L}]*|залог[\p{L}]*|комисси[\p{L}]*|взнос[\p{L}]*)|\b(?:application|recruitment|placement|hiring|employer contacts?) fee\b|\b(?:naknad[aeu]|provizij[aeu]|depozit[au]?)\b/u.test(text);
  const paidTraining = /обязательн[\p{L}]*\s+платн[\p{L}]*\s+(?:обучени[\p{L}]*|курс[\p{L}]*)|платн[\p{L}]*\s+(?:обучени[\p{L}]*|курс[\p{L}]*).{0,35}обязательн/u.test(text);
  return ruContext && (ruDemand || explicitFee || paidTraining) || enContext && (enDemand || explicitFee) || srContext && (srDemand || explicitFee);
}
function securityCodes(text) {
  const sensitive = /(?:\b(?:cvv2?|cvc2?)\b|(?:смс|sms)[ -]?(?:код[\p{L}]*|code|kod).{0,35}(?:банк|bank)|(?:код[\p{L}]*|code|kod).{0,20}(?:смс|sms).{0,35}(?:банк|bank)|(?:банк[\p{L}]*|bank[\p{L}]*).{0,35}(?:смс|sms)[ -]?(?:код[\p{L}]*|code|kod)|парол[\p{L}]*.{0,25}(?:банк[\p{L}]*|онлайн[ -]?банк[\p{L}]*)|(?:bank|banking)\s+(?:login\s+)?password|lozink[au].{0,30}(?:bank|racun))/u;
  const request = /(?:сообщите|пришлите|отправьте|предоставьте|введите|запрашиваем|просим\s+(?:прислать|сообщить|отправить)|\b(?:send|provide|share|enter|tell us|we (?:ask for|require))\b|\b(?:posaljite|dostavite|unesite|podelite|trazimo)\b)/u;
  let value = sensitive.exec(text);
  // PIN also means an office/device access code: require explicit bank/card context.
  if (!value) {
    const pin = /\bpin\b|пин(?:-код)?/u.exec(text);
    const bank = /(?:банк|карт|\bbank|\bcard|\bracun|\bkartic)/u.exec(text);
    if (pin && bank && Math.abs(pin.index - bank.index) <= 55) value = pin;
  }
  if (!value || !request.test(text)) return false;
  if (/(?:не\s+(?:сообщайте|передавайте|отправляйте|присылайте|вводите|просим|запрашиваем)|никогда\s+не|\b(?:never|do not|don't|cannot|must not)\s+(?:\w+\s+){0,2}(?:send|provide|share|enter|ask)|\b(?:ne|nemojte|nikada ne)\s+(?:saljite|dostavljajte|delite|unosite|trazimo)|не\s+(?:нужен|нужны|требуется|требуются)|not\s+(?:required|needed)|nije\s+potreban)/u.test(text)) return false;
  // A request and its sensitive object must be near each other.
  const action = request.exec(text);
  return Math.abs(action.index - value.index) <= 100;
}
function personalAccount(text) {
  if (/(?:не\s+(?:передавайте|передайте|сдавайте|сдайте|отдавайте|отдайте)|\b(?:never|do not|don't)\s+(?:\w+\s+){0,2}(?:rent|share|transfer|give)|\b(?:ne|nemojte)\s+(?:dajete|davati|delite|iznajmljujte))/u.test(text)) return false;
  return /арендуем.{0,35}(?:ваш|личн[\p{L}]*).{0,20}(?:банковск[\p{L}]*\s+счет)|(?:аренда|аренду)\s+(?:вашего|личного)\s+банковского\s+счета/u.test(text)
    || /\biznajmite.{0,35}(?:svoj|vas|licni).{0,20}(?:bankovni|bankarski)\s+racun/u.test(text)
    || /(?:сдайте|сдать|передайте|передать|отдайте|отдать|арендуем).{0,65}(?:свой|ваш|личн[\p{L}]*).{0,20}(?:банковск[\p{L}]*\s+счет|счет\s+в\s+банке).{0,65}(?:аренд|другим|третьим|пользован|управлен)|(?:сдайте|сдать|передайте|передать).{0,35}(?:в\s+аренду|другим|третьим).{0,45}(?:свой|ваш|личн[\p{L}]*).{0,20}(?:счет|банковск)/u.test(text)
    || /\b(?:rent|lease|give|transfer|share).{0,30}(?:your|personal).{0,15}bank account.{0,60}(?:rent|lease|access|use|third part|clients|other people|to us)\b|\b(?:rent|lease)\s+(?:out\s+)?your\s+(?:personal\s+)?bank account\b/u.test(text)
    || /\b(?:dajte|ustupite|iznajmite|predajte).{0,35}(?:svoj|vas|licni).{0,20}(?:bankovni|bankarski)\s+racun.{0,60}(?:koriscenje|trecim|drugim|klijent|iznajm)/u.test(text);
}

export function vacancyWarnings(job) {
  const title = typeof job?.title === 'string' ? job.title.slice(0, MAX_TITLE) : '';
  const description = typeof job?.description === 'string' ? job.description.slice(0, MAX_DESCRIPTION) : '';
  const found = new Set();
  for (const raw of normalize(title + '\n' + description).split(/[.!?;\n]+|,\s*(?:но|однако|but|however|ali|medjutim)\s+/u)) {
    // Avoid joining unrelated sections or running unbounded expressions.
    for (let offset = 0; offset < raw.length; offset += MAX_CLAUSE) {
      const clause = raw.slice(offset, offset + MAX_CLAUSE), latin = srLatin(clause);
      for (const text of clause === latin ? [clause] : [clause, latin]) {
        if (educational(text)) continue;
        if (payment(text)) found.add('job_advance_payment');
        if (securityCodes(text)) found.add('bank_security_codes');
        if (personalAccount(text)) found.add('personal_bank_account');
      }
    }
  }
  return Object.keys(WARNING).filter(code => found.has(code)).map(code => ({ ...WARNING[code] }));
}
