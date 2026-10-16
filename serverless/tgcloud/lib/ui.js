import { OPTIONS, TITLES, SOURCE_NAMES } from './config.js';
import { selected, hidden, validUrl } from './filters.js';
import { catalogDiagnostics } from './catalog.js';
export const button = (text, callback_data) => ({ text, callback_data });
export const BACK = [[button('🏠 Главное меню', 'menu')]];
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
    if (active || !compact) lines.push(`${active ? '✅' : '▫️'} ${title}: ${safe(values.map(x => OPTIONS[field][x] || x).join(' · '), 230)}`);
  }
  for (const [field, title] of [['keywords', 'Ключевые слова'], ['exclusions', 'Исключения']]) {
    if (s[field]?.length || !compact) lines.push(`${s[field]?.length ? '✅' : '▫️'} ${title}: ${safe(s[field]?.join(', ') || 'Нет', compact ? 90 : 950)}`);
  }
  if (s.min_salary != null || !compact) lines.push(`${s.min_salary != null ? '✅' : '▫️'} 💶 Зарплата: ${s.min_salary != null ? safe(`от ${s.min_salary} ${s.currency} / месяц`, 100) : 'Любая'}`);
  if (s.include_unknown_salary === false || !compact) lines.push(s.include_unknown_salary === false ? '✅ Без зарплаты: скрывать' : '▫️ Без зарплаты: показывать');
  return lines.join('\n') || '🔎 Все вакансии · вся Сербия';
}
export function menu(s, hiddenCount = hidden(s).size) {
  const on = s.notifications !== 'off';
  return ['<b>🇷🇸 Работа в Сербии</b>\n<i>SERBIA JOBS</i>\n\n<b>Ваша подборка</b>\n<blockquote>' + summary(s, true) + '</blockquote>\n\n🔔 Уведомления: ' + (on ? 'включены — новые вакансии' : 'выключены') + `\n🙈 Скрытые вакансии: ${hiddenCount}\n\n<b>«Найти вакансии»</b> — листать предложения.\nВ <b>«Фильтрах»</b> выберите города, языки и условия работы.`,
    [[button('🔎 Найти вакансии', 'search:0')], [button('⚙️ Фильтры', 'filters'), button(on ? '🔔 Уведомления: вкл' : '🔕 Уведомления: выкл', on ? 'notify:off' : 'notify:instant')], [button('🙈 Скрытые вакансии', 'hidden:0'), button('💬 Помощь', 'help')]]];
}
export function filtersPanel(s) {
  return ['<b>⚙️ Фильтры поиска</b>\n\n<blockquote>' + summary(s) + '</blockquote>\n\n✅ — выбранные условия. Города, языки, формат и свежесть допускают несколько вариантов. Для ВНЖ выберите один вариант. Между группами условия действуют вместе.',
    [[button('🔎 Ключевые слова', 'input:keywords'), button('🚫 Исключения', 'input:exclusions')], [button('📍 Города', 'city'), button('💻 Формат работы', 'remote')], [button('🗣 Языки', 'language'), button('💶 Минимальная зарплата', 'input:salary')], [button('🕒 Свежесть вакансии', 'freshness'), button('🪪 Наличие ВНЖ', 'residence_permit')], [button('Без зарплаты: ' + (s.include_unknown_salary ? '✓' : '✕'), 'toggle_salary')], [button('🔎 Найти вакансии', 'search:0')], [button('↩ Сбросить фильтры', 'reset')], ...BACK]];
}
export function choicePanel(s, field) {
  const values = selected(s, field), single = field === 'residence_permit';
  let text = `<b>${TITLES[field]}</b>\n\n<blockquote>Выбрано: ${safe(values.map(x => OPTIONS[field][x] || x).join(' · '), 250)}</blockquote>\n\n` + (single ? 'Выберите один вариант. ' : 'Можно отметить несколько вариантов. Подойдёт любой из выбранных. ') + 'Изменения сохраняются сразу.';
  text += ({ freshness: '\n«7 дней» включает сегодня и вчера. Объявления без даты доступны при выборе «Не важно».', language: '\nУчитываются явно указанные языковые требования, а не язык объявления.', remote: '\nЕсли формат не указан, выберите «Любой формат».', residence_permit: '\n\n<b>Да</b> — ВНЖ обязателен.\n<b>Нет</b> — явно указано, что ВНЖ не требуется.\n<b>Не важно</b> — все вакансии. Помощь с оформлением сама по себе не означает, что можно работать без ВНЖ.' })[field] || '';
  return [text, [...Object.entries(OPTIONS[field]).map(([value, label]) => [button((values.includes(value) ? '✅ ' : '▫️ ') + label, `choose:${field}:${value}:${!single && values.includes(value) && value !== 'any' ? 0 : 1}`)]), [button('✓ Готово', 'filters')], ...BACK]];
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
  const f = j._cloud, lines = ['💼 <b>' + safe(j.title || 'Вакансия', expanded ? 140 : 90) + '</b>'];
  let place = safe(j.location || (j.remote === true ? 'Удалённо' : 'Место не указано'), expanded ? 110 : 55);
  if (validUrl(f.location_url) && !validUrl(f.map_url)) place = `<a href="${escape(f.location_url)}">${j.location ? place : 'На карте'}</a>`;
  lines.push((j.company ? '🏢 ' + safe(j.company, expanded ? 80 : 40) + ' · ' : '') + '📍 ' + place);
  if (validUrl(f.map_url)) lines.push(`<a href="${escape(f.map_url)}">🗺 ${safe(f.address, 180)}</a>`);
  const periods = { month: 'месяц', hour: 'час', year: 'год' };
  const salary = j.salary_display || (j.salary_min != null ? `от ${j.salary_min} ${j.salary_currency || ''} / ${periods[j.salary_period || 'month'] || 'период не указан'}` : 'Зарплата не указана');
  lines.push('💶 <b>' + safe(salary, expanded ? 120 : 80) + '</b>');
  const names = { ru: 'Русский', sr: 'Сербский', en: 'Английский', de: 'Немецкий' };
  lines.push('🗣 ' + safe(f.languages.map(x => (names[x] || x) + (f.required_languages.includes(x) ? ' (обяз.)' : '')).join(', ') || 'Языки не указаны', expanded ? 140 : 80));
  if (j.description) lines.push('<blockquote>' + safe(j.description, expanded ? 1800 : 150, expanded) + '</blockquote>');
  if (j.contacts?.length) lines.push('☎️ ' + safe(j.contacts.join(' · '), expanded ? 200 : 90));
  const source = safe(SOURCE_NAMES[j.source] || j.source || 'Источник', 55);
  if (f.expires_ms != null && f.expires_ms <= Date.now()) lines.push('<b>⌛ Срок публикации истёк</b>');
  lines.push('📅 ' + (f.date_label || 'Дата не указана') + ' · ' + source);
  return lines.join('\n');
}
export function links(j) {
  const rows = validUrl(j.url) ? [[{ text: '🔗 Открыть объявление', url: j.url }]] : [];
  return rows;
}
export const browserUrl = j => 'https://translate.google.com/translate?sl=auto&tl=ru&u=' + encodeURIComponent(j.url);
export function jobButtons(j, mode = 's') {
  return [...links(j), [button(mode.endsWith('f') ? 'Свернуть ↑' : 'Подробнее ↓', `job:${j.id}:${mode.startsWith('r') ? 'ru_' : ''}${mode.endsWith('f') ? 'short' : 'full'}`), button('🙈 Скрыть', `hide:${j.id}`)], [button(mode.startsWith('r') ? '🌐 Оригинал' : '🇷🇺 Перевести на русский', `job:${j.id}:${mode.startsWith('r') ? '' : 'ru_'}${mode.endsWith('f') ? 'full' : 'short'}`)], [button('🗂 Смотреть подборку', 'search:0'), button('🏠 Меню', 'menu')]];
}
export function viewerButtons(j, index, count, mode, failed) {
  const b = (label, action) => button(label, `view:${j.id}:${index}:${action}:${mode}`);
  const rows = [...links(j), [b(mode.endsWith('f') ? 'Свернуть ↑' : 'Подробнее ↓', 'details'), b('🙈 Скрыть', 'hide')], [b(mode.startsWith('r') ? '🌐 Оригинал' : '🇷🇺 Перевести на русский', 'translate')]];
  if (failed && validUrl(j.url)) rows.push([{ text: '🌐 Перевести в браузере', url: browserUrl(j) }]);
  const nav = [];
  if (index) nav.push(b('← Предыдущая', 'prev'));
  if (index + 1 < count) nav.push(b('Следующая →', 'next'));
  if (nav.length) rows.push(nav);
  rows.push([button('⚙️ Фильтры', 'filters'), button('🏠 Меню', 'menu')]);
  return rows;
}
export async function translatedCard(j, mode, fetch) {
  if (!mode.startsWith('r')) return { text: card(j, mode.endsWith('f')), mode, failed: false };
  try {
    const translate = async text => {
      let result = '';
      const chars = [...text];
      for (let i = 0; i < chars.length; i += 800) {
        const response = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=' + encodeURIComponent(chars.slice(i, i+800).join('')));
        if (!response.ok) throw new Error('Translation unavailable');
        const data = await response.json();
        if (!Array.isArray(data?.[0])) throw new Error('Invalid translation');
        for (const part of data[0]) { if (typeof part?.[0] !== 'string') throw new Error('Invalid translation'); result += part[0]; }
      }
      return result;
    };
    const [title, description] = await Promise.all([translate(clip(j.title,140)), translate(clip(j.description,1800,true))]);
    return { text: '<i>🇷🇺 Перевод на русский</i>\n\n' + card({ ...j, title, description }, mode.endsWith('f')), mode, failed: false };
  } catch {
    return { text: 'Перевод сейчас недоступен. Попробуйте ещё раз или откройте его в браузере.\n\n' + card(j, mode.endsWith('f')), mode: mode.slice(1), failed: true };
  }
}
