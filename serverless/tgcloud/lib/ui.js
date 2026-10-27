import {ratingSummary,ratingLine} from './rating-data.js';
import { OPTIONS, TITLES, SOURCE_NAMES } from './config.js';
import { selected, hidden, validUrl } from './filters.js';
import { catalogDiagnostics } from './catalog.js';
import { translateVacancy } from './translation.js';
import { vacancyWarnings } from './risks.js';
import { displayLanguages } from './language-display.js';
export const button = (text, callback_data) => ({ text, callback_data });
export const BACK = [[button('🏠 Меню', 'menu')]];
const label = value => String(value).replace(/^[^\p{L}\p{N}]+/u, '');
const choiceLabel = (field,value) => OPTIONS[field][value] || (field==='language'&&value==='no_serbian'?'Без обязательного сербского (прежний фильтр)':value);
export const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
export function clip(value, limit, lines = false) {
  let text = String(value ?? '');
  text = lines ? text.split(/\r?\n/).map(x => x.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n') : text.replace(/\s+/gu, ' ').trim();
  if (text.length <= limit) return text;
  let result = '';
  for (const char of text) { if (result.length + char.length > limit - 1) break; result += char; }
  return result.trimEnd() + '…';
}
export const safe = (text, limit, lines = false) => escape(clip(text, limit, lines));
export function summary(s, compact = false) {
  const lines = [];
  for (const [field, title] of Object.entries(TITLES)) {
    const values = selected(s, field), active = !values.includes('any');
    if (active || !compact || ['city','residence_permit'].includes(field)) lines.push(`<b>${escape(title)}:</b> ${safe(values.map(x => label(choiceLabel(field,x))).join(' · '), 230)}`);
  }
  for (const [field, title] of [['keywords', '🔎 Ключевые слова'], ['exclusions', '🚫 Исключения']]) {
    if (s[field]?.length || !compact) lines.push(`<b>${title}:</b> ${safe(s[field]?.join(', ') || 'Нет', compact ? 90 : 950)}`);
  }
  if (s.min_salary != null || !compact) lines.push(`<b>💶 Зарплата:</b> ${s.min_salary != null ? safe(`от ${s.min_salary} ${s.currency} / месяц`, 100) : 'Любая'}`);
  if (s.include_unknown_salary === false || !compact) lines.push('<b>💶 Без зарплаты:</b> ' + (s.include_unknown_salary === false ? 'скрывать' : 'показывать'));
  return lines.join('\n');
}
export function menu(s) {
  return ['<b>Работа в Сербии</b>\n\nНайдите вакансию, настройте поиск или вернитесь к сохранённым объявлениям.\n\n<blockquote>'+summary(s,true)+'</blockquote>',
    [[button('🔎 Найти вакансии','search:0')],[button('⚙️ Настроить поиск','filters'),button('📂 Мои вакансии','library')],[button('☰ Настройки и помощь','preferences')]]];
}
export function filtersPanel(s,section='main') {
  const back=[button('⬅️ К условиям поиска','filters')];
  if(section==='pay')return ['<b>Оплата</b>\n\nМинимум в месяц: '+(s.min_salary!=null?safe(`${s.min_salary} ${s.currency}`,60):'любой')+'\nВакансии без указанной зарплаты: '+(s.include_unknown_salary?'показывать':'скрывать'),[[button('💶 Указать минимум','input:salary')],[button(s.include_unknown_salary?'Без зарплаты: показывать ✓':'Без зарплаты: скрывать','toggle_salary')],back]];
  if(section==='details')return ['<b>Другие условия поиска</b>\n\n'+summary(s,true)+'\n\nВсе параметры необязательны. Условия разных параметров действуют одновременно.',[[button('🗣 Языки','language'),button('💻 Формат работы','remote')],[button('🕒 Дата публикации','freshness'),button('🪪 ВНЖ','residence_permit')],[button('🚫 Исключить слова','input:exclusions')],[button('↩️ Сбросить все условия','reset')],back]];
  return ['<b>Настроить поиск</b>\n\nВыберите профессию и город. При необходимости добавьте зарплату и другие условия.\n\n<blockquote>'+summary(s,true)+'</blockquote>\n\nИзменения сохраняются сразу. Условия разных параметров действуют одновременно.',
    [[button('💼 Кем работать','input:keywords'),button('📍 Город','city')],[button('💶 Зарплата','filters:pay'),button('⚙️ Другие условия','filters:details')],[button('🔎 Показать вакансии','search:0')],[button('⬅️ Главное меню','menu')]]];
}
export function choicePanel(s, field) {
  const values = selected(s, field), single = ['residence_permit','freshness'].includes(field);
  let text = `<b>${label(TITLES[field])}</b>\n\n<blockquote>Выбрано: ${safe(values.map(x => label(choiceLabel(field,x))).join(' · '), 250)}</blockquote>\n\n` + (single ? 'Выберите один вариант. ' : 'Можно отметить несколько вариантов. Подойдёт любой из выбранных. ') + 'Изменения сохраняются сразу.';
  text += ({ freshness: '\nЗа неделю — последние 7 календарных дней; за месяц — 30 дней. «Все актуальные» снимает ограничение по возрасту и включает объявления без даты. Закрытые и просроченные вакансии исключаются во всех вариантах.\n\nУведомления сообщают о впервые найденных вакансиях, подходящих под ваши фильтры. Дата обнаружения может отличаться от даты публикации.', language: '\nУчитываются явно указанные рабочие или желательные языки, а не язык объявления. Другие обязательные языки проверяйте в карточке. Объявления без сведений о языке доступны при выборе «Не важно».', remote: '\nЕсли формат не указан, выберите «Любой формат».', residence_permit: '\n\nЭто требование работодателя к кандидату.\n<b>Обязателен</b> — ВНЖ прямо требуется.\n<b>Не требуется</b> — работодатель явно разрешает без ВНЖ.\n<b>Не важно</b> — включает объявления, где требование не указано. Помощь с оформлением сама по себе не означает, что можно работать без ВНЖ.' })[field] || '';
  if(field==='language'&&values.includes('no_serbian'))text+='\n\nСохранён прежний фильтр: только объявления, где явно не требуется сербский. «Не важно» снимает это ограничение.';
  const choices=Object.entries(OPTIONS[field]).map(([value, title]) => button((values.includes(value) ? '✅ ' : '') + title, `choose:${field}:${value}:${!single && values.includes(value) && value !== 'any' ? 0 : 1}`));
  const rows=[]; for(let i=0;i<choices.length;i+=2) rows.push(choices.slice(i,i+2));
  return [text, [...rows, [button('✅ Готово',field==='city'?'filters':'filters:details')]]];
}
export function emptyText(jobs, s) {
  const d = catalogDiagnostics(jobs, s);
  let text = '<b>Подходящих вакансий нет по выбранным условиям.</b>\n\n' + summary(s, true);
  if (!d.available) return text + '\n\nСейчас нет доступных действующих объявлений вне вашего списка скрытых. Попробуйте позже.';
  text += `\n\nБез ограничений ваших фильтров доступно: ${d.available}.`;
  const labels = { ...TITLES, keywords: 'Ключевые слова', exclusions: 'Исключения', salary: 'Зарплата' };
  text += d.relaxed.length ? '\nМожно изменить в фильтрах:' + d.relaxed.slice(0,2).map(x => `\n• Без ограничения «${labels[x.field]}» — ${x.count}.`).join('') : '\nНужно расширить несколько условий.';
  return text;
}
export function card(j, expanded = false) {
  const f = j._cloud, lines = ['<b>💼 ' + safe(j.title || 'Вакансия', expanded ? 140 : 90) + '</b>'];
  let place = safe(j.location || (j.remote === true ? 'Удалённо' : 'Место не указано'), expanded ? 110 : 55);
  if (validUrl(f.location_url) && !validUrl(f.map_url)) place = `<a href="${escape(f.location_url)}">${j.location ? place : 'На карте'}</a>`;
  if (j.company) lines.push('🏢 ' + safe(j.company, expanded ? 80 : 40));
  lines.push('📍 ' + place);
  if (validUrl(f.map_url)) lines.push(`🗺 <a href="${escape(f.map_url)}">${safe(f.address || 'На карте', 180)}</a>`);
  const periods = { month: 'месяц', hour: 'час', year: 'год' };
  const salary = j.salary_display || (j.salary_min != null ? `от ${j.salary_min} ${j.salary_currency || ''} / ${periods[j.salary_period || 'month'] || 'период не указан'}` : 'Зарплата не указана');
  lines.push('\n<b>💶 ' + safe(salary, expanded ? 120 : 80) + '</b>');
  lines.push('🗣 Языки: ' + safe(displayLanguages(j),260));
  lines.push('🪪 ВНЖ: ' + (f.permit === true ? 'нужен' : f.permit === false ? 'не нужен' : 'не указано'));
  if (f.experience === true || f.experience === false) lines.push('🛠 Опыт: ' + (f.experience ? 'требуется' : 'можно без опыта'));
  if (f.paperwork_assistance === true || f.paperwork_assistance === false) lines.push('📄 Помощь с документами: ' + (f.paperwork_assistance ? 'указана работодателем' : 'не предоставляется'));
  if ((j._warnings || vacancyWarnings(j)).length) lines.push('\n⚠️ В тексте есть условия, требующие осторожности. Подробнее — «Действия» → «Проблема с вакансией».');
  lines.push('\n'+ratingLine(j._rating));
  if (j.description) lines.push('\n<blockquote>' + safe(j.description, expanded ? 1800 : 150, expanded) + '</blockquote>');
  if (j.contacts?.length) lines.push('📞 Контакты: ' + safe(j.contacts.join(' · '), expanded ? 200 : 90));
  const sources = (j._sources || [{source:j.source,url:j.url}]).slice(0,4).map(s => {
    const name=safe(SOURCE_NAMES[s.source] || s.source || 'Источник',55);
    return validUrl(s.url) ? `<a href="${escape(s.url)}">${name}</a>` : name;
  });
  if(j._manual_closed)lines.push('<b>🔒 Вакансия закрыта командой бота</b>');
  if (f.expires_ms != null && f.expires_ms <= Date.now()) lines.push('<b>⌛ Срок публикации истёк</b>');
  if (f.quality?.reason === 'closed') lines.push('<b>⌛ Работодатель сообщил о закрытии набора</b>');
  else if (f.quality?.reason) lines.push('<i>Объявление исключено из поиска проверкой качества.</i>');
  lines.push('\n📅 <i>' + safe(f.date_label || 'Дата не указана',30) + '</i>');
  lines.push('🔗 ' + (sources.length>1?'Источники: ':'Источник: ') + sources.join(' · '));
  return lines.join('\n');
}
export function links(j, report = false) {
  const rows = validUrl(j.url) ? [[{ text: '🔗 Открыть объявление', url: j.url }]] : [];
  if (report) rows.push([button('🚩 Пожаловаться',`report:${j.id}`)]);
  return rows;
}
export const browserUrl = j => 'https://translate.google.com/translate?sl=auto&tl=ru&u=' + encodeURIComponent(j.url);
export function jobButtons(j, mode = 's') {
  return [...links(j), [button(mode.endsWith('f') ? '🔼 Свернуть' : '🔽 Подробнее', `job:${j.id}:${mode.startsWith('r') ? 'ru_' : ''}${mode.endsWith('f') ? 'short' : 'full'}`), button('☰ Действия',`actions:${j.id}:-1:${mode}`)], [button('🔎 Вакансии', 'search:0'), button('🏠 Меню', 'menu')]];
}
export function viewerButtons(j, index, count, mode, failed) {
  const b = (label, action) => button(label, `view:${j.id}:${index}:${action}:${mode}`);
  const rows = [...links(j), [b(mode.endsWith('f') ? '🔼 Свернуть' : '🔽 Подробнее', 'details'), button('☰ Действия',`actions:${j.id}:${index}:${mode}`)]];
  if (failed && validUrl(j.url)) rows.push([{ text: '🌐 Перевести в браузере', url: browserUrl(j) }]);
  const nav = [];
  if (index) nav.push(b('⬅️', 'prev'));
  if (index + 1 < count) nav.push(b('➡️', 'next'));
  if (nav.length) rows.push(nav);
  return rows;
}
export function cardActions(j, index, mode, context = null, favorite = false, problem = false, canClose = false) {
  const standalone=index===-1;
  const scoped=action=>`discover:${context.token}:${j.id}:${index}:${action}:${mode}`;
  const back=context ? scoped('show') : standalone ? `job:${j.id}:${mode.startsWith('r')?'ru_':''}${mode.endsWith('f')?'full':'short'}` : `view:${j.id}:${index}:show:${mode}`;
  const translate=context ? scoped('translate') : standalone ? `job:${j.id}:${mode.startsWith('r')?'':'ru_'}${mode.endsWith('f')?'full':'short'}` : `view:${j.id}:${index}:translate:${mode}`;
  const actions=context?scoped('actions'):`actions:${j.id}:${index}:${mode}`;
  if(problem)return ['<b>Проблема с вакансией</b>\n\n'+safe(j.title,100),[
    [button('🚩 Пожаловаться',`report:${j.id}:choose:${index}:${mode}${context?':'+context.token:''}`)],
    [button('🙈 Скрыть из моего поиска',context?scoped('hide'):standalone?`hide:${j.id}`:`view:${j.id}:${index}:hide:${mode}`)],
    ...(vacancyWarnings(j).length?[[button('⚠️ Почему осторожнее',`risk:${j.id}${context?`:${context.token}:${index}:${mode}`:''}`)]]:[]),
    [button('⬅️ К действиям',actions)],
  ]];
  return ['<b>Действия с вакансией</b>\n\n'+safe(j.title,100),[
    [button(favorite?'⭐ Убрать из избранного':'⭐ Сохранить',`favorite:${favorite?'remove':'add'}:${j.id}${context?':'+context.token+':'+index+':'+mode:''}`),button(mode.startsWith('r')?'🌐 Оригинал':'🇷🇺 Перевести',translate)],
    [button('⭐ Отзывы',`ratings:${j.id}:list`),button('🔎 Похожие',`similar:${j.id}${context?':'+context.token:''}`)],
    [button('⚠️ Проблема с вакансией',context?scoped('problem'):actions+':problem')],
    ...(canClose?[[button('🔒 Закрыть вакансию',`admin:close:${j.id}:${index}:${mode}${context?':'+context.token:''}`)]]:[]),
    [button('↩️ К вакансии',back)],
  ]];
}
export async function translatedCard(j, mode, fetch, store) {
  if(store?.db)j={...j,_rating:await ratingSummary(store,j._duplicate_ids||[j.id])};
  if (!mode.startsWith('r')) return { text: card(j, mode.endsWith('f')), mode, failed: false };
  try {
    const [title, description] = await translateVacancy(j.id,clip(j.title,140),clip(j.description,1800,true),fetch,store);
    return { text: '<i>🇷🇺 Перевод на русский</i>\n\n' + card({ ...j, title, description, _language_original:j.description, _language_title:j.title, _warnings: vacancyWarnings(j) }, mode.endsWith('f')), mode, failed: false };
  } catch {
    return { text: 'Перевод сейчас недоступен. Попробуйте ещё раз или откройте его в браузере.\n\n' + card(j, mode.endsWith('f')), mode: mode.slice(1), failed: true };
  }
}
