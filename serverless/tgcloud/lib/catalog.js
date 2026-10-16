// A read-time view: originals, historical IDs and delivery records stay intact.
// No Node/DOM globals: this also runs in Telegram's JavaScript isolate.
import { CITIES, OPTIONS } from './config.js';
import { normalize, hidden, contactable, matches, RESETS, selected } from './filters.js';

const decode = value => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; } };
export function canonicalUrl(value) {
  const m = /^https?:\/\/([^/?#\s]+)([^?#\s]*)(?:\?([^#\s]*))?(?:#[^\s]*)?$/i.exec(String(value || ''));
  if (!m || /[@<>"\\]/.test(m[1])) return '';
  let host = m[1].toLowerCase().replace(/^www\./, '').replace(/^https:/i.test(value) ? /:443$/ : /:80$/, '');
  let path = m[2].replace(/\/+$/, '').replace(/%[a-f0-9]{2}/gi, x => /[a-z0-9_.~-]/i.test(decode(x)) ? decode(x) : x.toUpperCase()) || '/';
  if (host === 'telegram.me') host = 't.me';
  if (host === 't.me') path = path.replace(/^\/s\//, '/').toLowerCase();
  const query = (m[3] || '').split('&').filter(Boolean).filter(part => !/^(utm_.+|fbclid|gclid|yclid|mc_cid|mc_eid|_ga|_gl|igshid)$/i.test(decode(part.split('=')[0])))
    .sort((a,b) => { const x = a.split('=')[0], y = b.split('=')[0]; return x < y ? -1 : x > y ? 1 : 0; }).join('&');
  return host + path + (query ? '?' + query : '');
}
const words = value => normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const city = value => {
  const text = words(value);
  return Object.entries(CITIES).find(([, aliases]) => aliases.some(x => words(x) === text))?.[0] || text;
};
const date = j => j._cloud?.published_ms ?? Date.parse(j.published_at || j.created_at);
function facts(j) {
  return { job: j, title: words(j.title), body: words(j.description), company: words(j.company), city: city(j.location),
    contacts: (j.contacts || []).map(x => normalize(x).replace(/[\s()-]/g, '')).filter(Boolean), date: date(j) };
}
function compatible(a, b) {
  if (!a.title || a.title !== b.title) return false;
  if (a.company && b.company && a.company !== b.company || a.city && b.city && a.city !== b.city) return false;
  const addressA = words(a.job._cloud?.address), addressB = words(b.job._cloud?.address);
  if (addressA && addressB && addressA !== addressB) return false;
  for (const key of ['salary_min', 'salary_max', 'salary_currency', 'salary_period', 'remote']) {
    if (a.job[key] != null && b.job[key] != null && a.job[key] !== b.job[key]) return false;
  }
  if (a.contacts.length && b.contacts.length && !a.contacts.some(x => b.contacts.includes(x))) return false;
  return true;
}
function sameContent(a, b) {
  if (!compatible(a, b) || a.body.length < 160 || a.body !== b.body) return false;
  // Old templates can represent a new opening months later. Missing dates do
  // not provide enough evidence for text-only merging.
  if (!Number.isFinite(a.date) || !Number.isFinite(b.date) || Math.abs(a.date - b.date) > 45 * 86400000) return false;
  return Boolean(a.company && a.company === b.company || a.contacts.some(x => b.contacts.includes(x)) || a.city && a.city === b.city && a.body.length >= 300);
}
function applicationLinks(j) {
  // Only explicit vacancy links, never a shared employer homepage/profile.
  return [...String(j.description || '').matchAll(/https?:\/\/[^\s<>"']+/gi)].map(m => canonicalUrl(m[0].replace(/[).,;!?]+$/, '')))
    .filter(url => /^(?:ovdejobs\.com\/(?:.*[?&]p=\d+|(?:job|jobs)\/[^?]+)|radim\.rs\/jobs\/[^?]+|(?:poslovi\.)?infostud\.com\/posao\/[^?]+|klikdoposla\.com\/oglasi\/\d+[^?]*|t\.me\/[^/]+\/\d+)(?:\?.*)?$/.test(url));
}

export function groupJobs(jobs) {
  const entries = jobs.map(facts), parent = entries.map((_, i) => i), members = entries.map((_, i) => [i]);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) { parent[b] = a; members[a].push(...members[b]); members[b] = []; } };
  const urls = new Map();
  entries.forEach((e, i) => {
    // Same original URL is authoritative even when a publisher edits its text.
    const url = canonicalUrl(e.job.url);
    if (url) { if (urls.has(url)) join(i, urls.get(url)); else urls.set(url, i); }
  });
  const linked = new Map();
  entries.forEach((e, i) => {
    for (const url of applicationLinks(e.job)) {
      const candidates = [...(linked.get(url) || []), ...(urls.has(url) ? [urls.get(url)] : [])];
      for (const k of candidates) if (root(i) !== root(k) && members[root(i)].every(a => members[root(k)].every(b => compatible(entries[a], entries[b])))) join(i, k);
      if (!linked.has(url)) linked.set(url, []);
      if (!linked.get(url).some(k => root(k) === root(i))) linked.get(url).push(i);
    }
  });
  const bodies = new Map();
  entries.forEach((e, i) => {
    if (e.body.length < 160) return;
    const key = e.title + '\n' + e.body, candidates = bodies.get(key) || [];
    // Check every member: a partial record must not bridge two conflicting jobs.
    let found = false;
    for (const k of candidates) {
      if (root(i) === root(k)) { found = true; break; }
      if (members[root(i)].every(a => members[root(k)].every(b => sameContent(entries[a], entries[b])))) { join(i, k); found = true; break; }
    }
    if (!found) candidates.push(i);
    bodies.set(key, candidates);
  });
  const groups = new Map();
  entries.forEach((e, i) => { const key = root(i); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(e.job); });
  return [...groups.values()].map(members => ({ id: Math.min(...members.map(j => j.id)), members }));
}
export const includesId = (group, id) => group.members.some(j => j.id === id);
export const decorate = (group, job) => ({ ...job, _duplicate_ids: group.members.map(j => j.id) });
function currentPublications(group) {
  const originals = new Map();
  for (const job of group.members) {
    const key = canonicalUrl(job.url) || job.id, previous = originals.get(key);
    // An old www/tracking copy must not override a later salary/expiry edit.
    const updated = j => Date.parse(j.updated_at || j.created_at) || 0;
    if (!previous || updated(job) > updated(previous) || updated(job) === updated(previous) && quality(job) > quality(previous)) originals.set(key, job);
  }
  return [...originals.values()];
}
export function visibleJobs(groups, s, now = Date.now()) {
  const ids = hidden(s), result = [];
  for (const group of groups) {
    if (group.members.some(j => ids.has(j.id))) continue;
    // Select only among records matching the user's complete filter. Do not
    // invent a composite salary/language/location from different publications.
    const choices = currentPublications(group).filter(j => contactable(j) && matches(j, s, now));
    choices.sort((a,b) => quality(b) - quality(a));
    if (choices.length) result.push(decorate(group, choices[0]));
  }
  return result;
}
const quality = j => Math.min(String(j.description || '').length, 3000) + (j.contacts?.length ? 500 : 0) + (j._cloud?.address ? 300 : 0);
export function hiddenGroups(groups, s) {
  const ids = hidden(s), result = [];
  for (const group of groups) if (group.members.some(j => ids.has(j.id))) {
    result.push(group); for (const j of group.members) ids.delete(j.id);
  }
  // Keep restoration possible even if an original is no longer in the database.
  return [...result, ...[...ids].map(id => ({ id, members: [{ id }] }))].sort((a,b) => b.id-a.id);
}
export function catalogDiagnostics(groups, s, now = Date.now()) {
  const count = settings => visibleJobs(groups, settings, now).length;
  const available = count(Object.assign({}, s, ...Object.values(RESETS)));
  const relaxed = Object.entries(RESETS).filter(([k]) => OPTIONS[k] ? !selected(s, k).includes('any') : k === 'salary' ? s.min_salary != null || s.include_unknown_salary === false : s[k]?.length)
    .map(([field, patch]) => ({ field, count: count({ ...s, ...patch }) })).filter(x => x.count).sort((a,b) => a.count-b.count);
  return { available, relaxed };
}
