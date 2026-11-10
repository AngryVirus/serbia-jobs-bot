import { OPTIONS, CITIES, DEFAULTS, KEYWORD_FORMS, KEYWORD_TRANSLATIONS } from './config.js';
import { sourceEnabled } from './source-policy.js';
import { availabilityAllows } from './availability.js';
export const defaults = () => JSON.parse(JSON.stringify(DEFAULTS));
export function settings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const s = { ...defaults(), ...raw };
  // Historical Python-only preferences do not affect the centralized runtime.
  for (const field of ['sources','daily_hour','webhook_update_ids']) delete s[field];
  if (!Object.hasOwn(raw, 'notifications_after_id') && s.notifications !== 'off') s.notifications_after_id = null;
  s.freshness = selected(s, 'freshness');
  return s;
}
export function selected(s, field) {
  const raw = s[field], values = [...new Set((typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []).filter(x => typeof x === 'string' && x))];
  if (field === 'freshness') {
    if (!values.length || values.includes('any')) return ['any'];
    if (values.includes('30')) return ['30'];
    if (values.some(x => ['7','today','yesterday'].includes(x))) return ['7'];
    return ['any'];
  }
  return !values.length || values.includes('any') ? ['any'] : values;
}
export function choose(s, field, value, enabled) {
  if (field === 'freshness' && ['today','yesterday'].includes(value)) value = '7';
  if (!OPTIONS[field] || !Object.hasOwn(OPTIONS[field], value)) throw new Error('Invalid filter');
  if (field === 'residence_permit') return enabled ? [value] : ['any'];
  if (field === 'freshness') return [value];
  if (value === 'any') return ['any'];
  const values = new Set(selected(s, field));
  if (enabled) values.add(value); else values.delete(value);
  const result = Object.keys(OPTIONS[field]).filter(x => x !== 'any' && values.has(x));
  return result.length ? result : ['any'];
}
export const hidden = s => new Set((s.hidden_jobs || []).filter(x => Number.isSafeInteger(x) && x > 0));
export const normalize = s => String(s ?? '').toLowerCase().replace(/ß/g, 'ss').replace(/đ/g, 'dj').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim();
// Compiled whole-word patterns are reused: one search checks every vacancy
// against the same few terms. The cache is bounded and holds no vacancy text.
const termPatterns = new Map();
function termPattern(term) {
  const value = normalize(term);
  let pattern = termPatterns.get(value);
  if (!pattern) {
    if (termPatterns.size >= 500) termPatterns.clear();
    pattern = new RegExp('(?<![\\p{L}\\p{N}_])' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_])', 'u');
    termPatterns.set(value, pattern);
  }
  return pattern;
}
export function contains(text, term) {
  return termPattern(term).test(normalize(text));
}
// One pattern per profession: its Russian case forms plus reviewed Serbian and
// English names. The Russian base word and every translated name select the
// whole group. Forms are normalized like vacancy text («водителей» is compared
// as «водителеи»), otherwise a form containing «й» could never match.
const keywordPatterns = new Map();
for (const [word, forms] of Object.entries(KEYWORD_FORMS)) {
  const translations = KEYWORD_TRANSLATIONS[word] || [];
  const all = [...new Set([...forms, ...translations].map(normalize).filter(Boolean))];
  const pattern = new RegExp('(?<![\\p{L}\\p{N}_])(?:' + all.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![\\p{L}\\p{N}_])', 'u');
  for (const key of [word, ...translations].map(normalize)) if (key && !keywordPatterns.has(key)) keywordPatterns.set(key, pattern);
}
const keywordPattern=term=>{const value=normalize(term);return keywordPatterns.get(value)||termPattern(value);};
export function keywordContains(text,term) {
  return keywordPattern(term).test(normalize(text));
}
// Normalizing a long description is the dominant cost of filtering. Do it once
// per vacancy record rather than once per keyword, exclusion and city alias.
// Entries die with their record and are rebuilt if its public text changes.
const searchTexts = new WeakMap();
function searchText(j) {
  let entry = searchTexts.get(j);
  if (!entry || entry.title !== j.title || entry.description !== j.description || entry.location !== j.location) {
    entry = { title: j.title, description: j.description, location: j.location, text: null, place: null };
    searchTexts.set(j, entry);
  }
  return entry;
}
// Some posts replace Cyrillic letters with identical-looking Latin ones
// («Специaлист» with a Latin «a»), which hides them from keyword search.
// Only a word that mixes both scripts, has at least two Cyrillic letters and
// whose every Latin letter is a look-alike is read as Cyrillic. Search only:
// the stored and displayed text is untouched.
const LOOKALIKES = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const MIXED_WORD = /[a-z\u0400-\u04ff]*(?:[a-z][\u0400-\u04ff]|[\u0400-\u04ff][a-z])[a-z\u0400-\u04ff]*/g;
export function withoutLookalikes(normalized) {
  return normalized.replace(MIXED_WORD, word => {
    if ((word.match(/[\u0400-\u04ff]/g) || []).length < 2 || /[^a-z\u0400-\u04ff]|[dfgijlnqrsuvwz]/.test(word)) return word;
    return word.replace(/[a-z]/g, letter => LOOKALIKES[letter]);
  });
}
const jobText = j => { const entry = searchText(j); if (entry.text === null) entry.text = withoutLookalikes(normalize(`${j.title || ''} ${j.description || ''}`)); return entry.text; };
const jobPlace = j => { const entry = searchText(j); if (entry.place === null) entry.place = normalize(j.location); return entry.place; };
const cityPatterns = new Map();
function cityPattern(city) {
  let patterns = cityPatterns.get(city);
  if (!patterns) {
    if (cityPatterns.size >= 500) cityPatterns.clear();
    patterns = (CITIES[city] || [city]).map(termPattern);
    cityPatterns.set(city, patterns);
  }
  return patterns;
}
// EU daylight-saving transitions, 01:00 UTC on the last Sunday of March/October.
// No dependency on Intl/time-zone data in the platform's JavaScript isolate.
export function belgradeOffset(ms) {
  const year = new Date(ms).getUTCFullYear();
  const transition = month => { const last = new Date(Date.UTC(year, month + 1, 0)); return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1); };
  return ms >= transition(2) && ms < transition(9) ? 7200000 : 3600000;
}
export const belgradeDay = ms => Math.floor((ms + belgradeOffset(ms)) / 86400000);
export const validUrl = url => typeof url === 'string' && url.length <= 2048 && /^https?:\/\/[^\s/@<>"\\]+\/[^\s<>"\\]+$/i.test(url);
export const contactable = j => validUrl(j.url) || Boolean(j.contacts?.length);
export function matches(j, s, now = Date.now()) {
  if(!availabilityAllows(j,now))return false;
  if (!sourceEnabled(j.source)) return false;
  const f = j._cloud;
  if (!f || f.quality?.reason || j._moderated || !f.serbia) return false;
  if (Number.isSafeInteger(j.id) && j.id > 0 && Array.isArray(s.hidden_jobs) && s.hidden_jobs.includes(j.id)) return false;
  const periods = selected(s, 'freshness'), age = f.published_day == null ? null : belgradeDay(now) - f.published_day;
  if (age !== null && (age < 0 || (!f.date_only && f.published_ms > now))) return false;
  if (!periods.some(p => p === 'any' || age !== null && ({ today: age === 0, yesterday: age === 1, 7: age >= 0 && age < 7, 30: age >= 0 && age < 30 })[p])) return false;
  if (s.keywords?.length && !s.keywords.some(x => keywordPattern(x).test(jobText(j)))) return false;
  if (s.exclusions?.some(x => termPattern(x).test(jobText(j)))) return false;
  const cities = selected(s, 'city');
  if (!cities.includes('any') && !cities.some(c => cityPattern(c).some(x => x.test(jobPlace(j))))) return false;
  const remote = selected(s, 'remote');
  const workFormat = Object.hasOwn(f, 'remote') ? f.remote : j.remote;
  if (!remote.includes('any') && !(remote.includes('only') && workFormat === true || remote.includes('office') && workFormat === false)) return false;
  const facts = Array.isArray(f.languages) ? f.languages : j.languages;
  const languages = { any: true, russian: facts?.includes('ru') || facts == null && j.russian === true,
    serbian: facts?.includes('sr') || facts == null && j.serbian_required === true,
    english: facts?.includes('en'), no_serbian: j.serbian_required === false };
  if (!selected(s, 'language').some(x => languages[x])) return false;
  const permits = selected(s, 'residence_permit');
  if (!permits.includes('any') && (f.permit == null || !permits.includes(f.permit ? 'yes' : 'no'))) return false;
  const salary = f.salary;
  if (salary && typeof salary.known === 'boolean') {
    const unknown = s.include_unknown_salary !== false;
    if (!salary.known) return unknown;
    if (s.min_salary == null) return true;
    if (salary.period !== 'month') return false;
    if (salary.currency == null) return unknown;
    if (salary.currency !== (s.currency || 'EUR')) return false;
    if (salary.max != null && salary.max < s.min_salary) return false;
    return salary.min != null ? salary.min >= s.min_salary : unknown;
  }
  // Old fixture/import records without facts retain their previous contract
  // until the additive facts refresh has prepared the public salary data.
  if (j.salary_min == null && s.include_unknown_salary === false) return false;
  if (s.min_salary != null) {
    if (j.salary_min == null || j.salary_currency == null) return s.include_unknown_salary !== false;
    if ((Object.hasOwn(j, 'salary_period') ? j.salary_period : 'month') !== 'month' || j.salary_currency !== (s.currency || 'EUR') || j.salary_min < s.min_salary) return false;
  }
  return true;
}
export const RESETS = { freshness: { freshness: 'any' }, language: { language: 'any' }, remote: { remote: 'any' }, residence_permit: { residence_permit: 'any' }, city: { city: 'any' }, keywords: { keywords: [] }, exclusions: { exclusions: [] }, salary: { min_salary: null, include_unknown_salary: true } };
