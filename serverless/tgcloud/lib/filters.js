import { OPTIONS, CITIES, DEFAULTS } from './config.js';
import { sourceEnabled } from './source-policy.js';
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
export function contains(text, term) {
  const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'u').test(normalize(text));
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
  if (!sourceEnabled(j.source)) return false;
  const f = j._cloud;
  if (!f || f.quality?.reason || j._moderated || hidden(s).has(j.id) || !f.serbia || (f.expires_ms != null && f.expires_ms <= now)) return false;
  const periods = selected(s, 'freshness'), age = f.published_day == null ? null : belgradeDay(now) - f.published_day;
  if (age !== null && (age < 0 || (!f.date_only && f.published_ms > now))) return false;
  if (!periods.some(p => p === 'any' || age !== null && ({ today: age === 0, yesterday: age === 1, 7: age >= 0 && age < 7, 30: age >= 0 && age < 30 })[p])) return false;
  const text = `${j.title || ''} ${j.description || ''}`;
  if (s.keywords?.length && !s.keywords.some(x => contains(text, x))) return false;
  if (s.exclusions?.some(x => contains(text, x))) return false;
  const cities = selected(s, 'city');
  if (!cities.includes('any') && !cities.some(c => (CITIES[c] || [c]).some(x => contains(j.location, x)))) return false;
  const remote = selected(s, 'remote');
  if (!remote.includes('any') && !(remote.includes('only') && j.remote === true || remote.includes('office') && j.remote === false)) return false;
  const languages = { any: true, russian: j.languages?.includes('ru') || j.languages == null && j.russian === true,
    serbian: j.languages?.includes('sr') || j.languages == null && j.serbian_required === true,
    english: f.languages.includes('en'), no_serbian: j.serbian_required === false };
  if (!selected(s, 'language').some(x => languages[x])) return false;
  const permits = selected(s, 'residence_permit');
  if (!permits.includes('any') && (f.permit == null || !permits.includes(f.permit ? 'yes' : 'no'))) return false;
  if (j.salary_min == null && s.include_unknown_salary === false) return false;
  if (s.min_salary != null) {
    if (j.salary_min == null || j.salary_currency == null) return s.include_unknown_salary !== false;
    if ((Object.hasOwn(j, 'salary_period') ? j.salary_period : 'month') !== 'month' || j.salary_currency !== (s.currency || 'EUR') || j.salary_min < s.min_salary) return false;
  }
  return true;
}
export const RESETS = { freshness: { freshness: 'any' }, language: { language: 'any' }, remote: { remote: 'any' }, residence_permit: { residence_permit: 'any' }, city: { city: 'any' }, keywords: { keywords: [] }, exclusions: { exclusions: [] }, salary: { min_salary: null, include_unknown_salary: true } };
