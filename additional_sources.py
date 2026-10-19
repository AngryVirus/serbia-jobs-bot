"""Four reviewed Serbian public inventories, with bounded resumable discovery.

Only published listing/detail routes are fetched; no application forms, cookies,
JavaScript, internal APIs or third-party recommendation cards are collected.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json
import re
from urllib.parse import parse_qsl, urljoin, urlsplit
from xml.etree import ElementTree

from crawl_state import CrawlState
from filters import active, normalize, serbia_eligible
from job_metadata import enrich
from sources import (MAX_BYTES, FetchError, Job, PageParser, _job_nodes,
                     _label_value, _status, _structured_job, canonical_url,
                     discover_links, infer_flags, is_detail_url, parse_page,
                     safe_date)

ADDITIONAL_SOURCES = frozenset({'nsz', 'manpower', 'boxposlovi', 'delhaize'})


def _url(source, value, *, detail=False):
    if not isinstance(value, str) or len(value) > 1000 or any(ord(c) < 33 for c in value) or '\\' in value:
        return False
    try:
        parsed, origin = urlsplit(value), urlsplit(source.url)
        return (parsed.scheme == 'https' and parsed.hostname == origin.hostname
                and not parsed.username and not parsed.password and parsed.port in (None, 443)
                and not parsed.fragment and (not detail or (not parsed.query and is_detail_url(source, value))))
    except ValueError:
        return False


def _listing_url(source, value):
    if not _url(source, value):
        return False
    parsed, base = urlsplit(value), urlsplit(source.listing_url)
    if source.id == 'boxposlovi':
        return not parsed.query and bool(re.fullmatch(r'/studenti/(?:page/[1-9]\d{0,4}/)?', parsed.path))
    if source.id == 'delhaize':
        return parsed.path == base.path and not parsed.query
    if parsed.path.rstrip('/') != base.path.rstrip('/'):
        return False
    return all(key == 'page' and re.fullmatch(r'\d{1,5}', number)
               for key, number in parse_qsl(parsed.query, keep_blank_values=True))


class _Section(PageParser):
    """One identified div; adjoining advertisements cannot contribute facts."""
    def __init__(self, html, css_class, *, exclude=()):
        super().__init__()
        self.depth, self.done, self.css_class = 0, False, css_class
        self.exclude, self.skip_depth = set(exclude), 0
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag == 'div':
            if self.depth:
                self.depth += 1
            elif not self.done and self.css_class in (dict(attrs).get('class') or '').split():
                self.depth = 1
        if self.depth and tag == 'div' and not self.skip_depth and self.exclude.intersection((dict(attrs).get('class') or '').split()):
            self.skip_depth = self.depth
        if self.depth and not self.skip_depth:
            super().handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.depth:
            if not self.skip_depth:
                super().handle_endtag(tag)
            if tag == 'div':
                if self.depth == self.skip_depth:
                    self.skip_depth = 0
                self.depth -= 1
                self.done = not self.depth

    def handle_data(self, value):
        if self.depth and not self.skip_depth:
            super().handle_data(value)


class _NSZListing(PageParser):
    def __init__(self):
        super().__init__()
        self.preview_urls = []
        self.pagination_links = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a' and dict(attrs).get('href'):
            self.pagination_links.append(dict(attrs)['href'])
        super().handle_starttag(tag, attrs)
        # Parse a literal public preview URL, never evaluate the onclick code.
        onclick = dict(attrs).get('onclick') or ''
        match = re.fullmatch(r"\s*document\.location\.href\s*=\s*(['\"])(https://nsz\.gov\.rs/employee/jobs/preview/\d+)\1\s*;?\s*", onclick)
        if match:
            self.preview_urls.append(match[2])


def _bounded(body):
    if not isinstance(body, str) or len(body.encode('utf-8')) > MAX_BYTES:
        raise FetchError('error', 'Страница превышает ограничение размера или имеет неверный формат.')


def discover_additional(source, body, page_url):
    """Return detail URLs and one forward pagination cursor, never external links."""
    _bounded(body)
    if not _listing_url(source, page_url):
        raise FetchError('error', 'Источник перенаправил список на неподдерживаемую страницу.')
    if source.id == 'delhaize':
        if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', body, re.I):
            raise FetchError('error', 'Sitemap содержит неподдерживаемые XML-объявления.')
        try:
            root = ElementTree.fromstring(body)
        except ElementTree.ParseError as exc:
            raise FetchError('error', 'Изменился формат sitemap вакансий Delhaize.') from exc
        if root.tag.rsplit('}', 1)[-1] != 'urlset':
            raise FetchError('error', 'Sitemap не содержит список вакансий Delhaize.')
        urls = []
        for entry in list(root)[:2000]:
            if entry.tag.rsplit('}', 1)[-1] != 'url':
                continue
            location = next((child.text for child in entry if child.tag.rsplit('}', 1)[-1] == 'loc'), '')
            if _url(source, location, detail=True) and location not in urls:
                urls.append(location)
        return urls, None
    page = _NSZListing()
    page.feed(body)
    page.close()
    if source.id == 'nsz':
        urls = list(dict.fromkeys(url for url in page.preview_urls if _url(source, url, detail=True)))
    else:
        urls = [url for url in discover_links(source, page, page_url) if _url(source, url, detail=True)]
    parsed = urlsplit(page_url)
    current = (int(dict(parse_qsl(parsed.query)).get('page', '0')) if source.id == 'manpower'
               else int(dict(parse_qsl(parsed.query)).get('page', '1')) if source.id == 'nsz'
               else int((re.search(r'/page/(\d+)/', parsed.path) or [None, '1'])[1]))
    candidates = []
    for href in page.pagination_links:
        candidate = canonical_url(urljoin(page_url, href))
        if not _listing_url(source, candidate):
            continue
        parts = urlsplit(candidate)
        number = (int(dict(parse_qsl(parts.query)).get('page', '0')) if source.id == 'manpower'
                  else int(dict(parse_qsl(parts.query)).get('page', '1')) if source.id == 'nsz'
                  else int((re.search(r'/page/(\d+)/', parts.path) or [None, '1'])[1]))
        if number > current:
            candidates.append((number, candidate))
    return urls[:2000], min(candidates)[1] if candidates else None


class _ManpowerDates(PageParser):
    def __init__(self):
        super().__init__()
        self.depth, self.date, self.urls, self.dates = 0, None, [], {}

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == 'div':
            if self.depth:
                self.depth += 1
            elif 'card' in (attr.get('class') or '').split():
                self.depth, self.date, self.urls = 1, None, []
        if self.depth and tag == 'a' and attr.get('href'):
            self.urls.append(attr['href'])
        super().handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        super().handle_endtag(tag)
        if self.depth and tag == 'div':
            self.depth -= 1
            if not self.depth and self.date:
                for url in self.urls:
                    self.dates[url] = self.date

    def handle_data(self, value):
        if self.depth and not self._ignored and re.fullmatch(r'\s*\d{2}/\d{2}/\d{4}\s*', value):
            try:
                self.date = datetime.strptime(value.strip(), '%d/%m/%Y').date().isoformat()
            except ValueError:
                pass
        super().handle_data(value)


def _manpower_dates(source, body, base):
    page = _ManpowerDates()
    page.feed(body)
    page.close()
    return {canonical_url(urljoin(base, url)): value for url, value in page.dates.items()
            if _url(source, canonical_url(urljoin(base, url)), detail=True)}


def _date(value):
    try:
        return datetime.strptime(value.strip(), '%d.%m.%Y').date().isoformat()
    except (ValueError, AttributeError):
        return None


def _nsz(source, body, url):
    preview = _Section(body, 'job-preview')
    content, requirements = _Section(body, 'job-content'), _Section(body, 'job-requirements')
    title = next((value for tag, value in preview.headings if tag == 'h3'), '')
    if not title or not content.lines or not requirements.lines:
        return []
    # Company and location come from this vacancy's own header/table, not footer.
    company = _Section(body, 'single-job').lines
    company = company[1] if len(company) > 1 and company[0] == title else ''
    location = _label_value(requirements.lines, ('место рада', 'mesto rada')).rstrip('; ')
    dates = _label_value(requirements.lines, ('временско трајање огласа за посао', 'vremensko trajanje oglasa za posao'))
    period = re.fullmatch(r'(\d{2}\.\d{2}\.\d{4})\.?\s*-\s*(\d{2}\.\d{2}\.\d{4})\.?', dates)
    description = '\n'.join(content.lines + requirements.lines)
    job = Job(source.id, canonical_url(url), title, company, location, description[:16000],
              published_at=_date(period[1]) if period else None,
              expires_at=_date(period[2]) if period else None)
    return [enrich(job)]


def _manpower(source, body, url):
    section = _Section(body, 'job-posts-page', exclude=('talent-db-cta',))
    title = next((value for tag, value in section.headings if tag == 'h1'), '')
    if not title or not any(value in {'Opis', 'Zahtevi', 'Description', 'Requirements'} for _, value in section.headings):
        return []
    location = ' '.join(_Section(body, 'job-city').lines)
    # The agency also advertises work abroad. The geography field is decisive;
    # employer history mentioning another country is not a location restriction.
    description = '\n'.join(section.lines[1:])
    remote, russian, serbian = infer_flags(title + '\n' + description)
    if re.search(r'\bna licu mesta\b', normalize(description)):
        remote = False
    job = enrich(Job(source.id, canonical_url(url), title, location=location, description=description[:16000],
                     remote=remote, russian=russian, serbian_required=serbian))
    return [job]


def _webpage_date(page, url):
    for script in page.json_scripts:
        try:
            data = json.loads(script)
        except (ValueError, RecursionError):
            continue
        nodes = data.get('@graph', []) if isinstance(data, dict) else []
        if not isinstance(nodes, list):
            continue
        for node in nodes[:100]:
            if (isinstance(node, dict) and node.get('@type') == 'WebPage'
                    and canonical_url(str(node.get('url', ''))) == canonical_url(url)):
                return safe_date(node.get('datePublished'))
    return None


def _box(source, body, url):
    title = ' '.join(_Section(body, 'sj_banner-title').lines)
    description = '\n'.join(_Section(body, 'sj_description-text').lines)
    tags = _Section(body, 'sj_tags').lines
    if not title or not description or not tags:
        return []
    location = tags[0]
    if len(tags) > 1:
        description += '\n' + '\n'.join(tags[1:])
    salary = re.search(r'(?i)\bSatnica\s*:\s*([\d., ]+\s*(?:RSD|EUR|USD))', description)
    job = enrich(Job(source.id, canonical_url(url), title, location=location, description=description[:16000],
                     published_at=_webpage_date(parse_page(body), url)))
    if salary:
        # Hourly pay never becomes the monthly minimum used by user filters.
        job.salary_min, job.salary_period = None, 'hour'
        job.salary_currency = salary[1].strip().rsplit(' ', 1)[-1].upper()
        job.salary_display = salary[1].strip() + ' / sat'
    return [job]


def _delhaize(source, body, url):
    page, jobs = parse_page(body), []
    for script in page.json_scripts:
        try:
            value = json.loads(script)
            nodes = list(_job_nodes(value))
        except (ValueError, RecursionError):
            continue
        for original in nodes[:50]:
            node = deepcopy(original)
            location = node.get('jobLocation')
            address = location.get('address') if isinstance(location, dict) else None
            if isinstance(address, dict) and normalize(str(address.get('addressCountry', ''))) in {'република србија', 'republika srbija', 'republic of serbia'}:
                address['addressCountry'] = 'RS'
            # This ATS publishes a zero-hourly salary template on unpaid-unknown
            # listings. Zero is not a usable advertised wage.
            salary = node.get('baseSalary')
            if isinstance(salary, dict) and isinstance(salary.get('value'), dict) and str(salary['value'].get('value')) in {'0', '0.0', '0.00'}:
                node.pop('baseSalary', None)
            job = _structured_job(source, node, url)
            if job:
                job.description = '\n'.join(parse_page(str(node.get('description') or '')).lines)[:16000]
                jobs.append(enrich(job, node))
    return jobs


def extract_additional_jobs(source, body, page_url):
    _bounded(body)
    if source.id not in ADDITIONAL_SOURCES or not _url(source, page_url, detail=True):
        return []
    return {'nsz': _nsz, 'manpower': _manpower, 'boxposlovi': _box,
            'delhaize': _delhaize}[source.id](source, body, page_url)


def collect_additional(source, fetcher, detail_limit=8, *, include_expired=False, crawl_state=None, page_limit=2):
    state = CrawlState(source, crawl_state, cursor_validator=lambda value: _listing_url(source, value),
                       pending_validator=lambda value: _url(source, value, detail=True))
    jobs, errors, inspected, discovered, pages, parsed = {}, [], 0, set(), 0, 0
    rejected, publication_dates = {'expired': 0, 'foreign': 0, 'unrecognized': 0}, {}
    failure = None
    try:
        target, visited = source.listing_url, set()
        resume = state.cursor
        for _ in range(max(1, min(int(page_limit), 4))):
            if not target or target in visited:
                break
            visited.add(target)
            body, final_url = fetcher.get(target)
            urls, next_url = discover_additional(source, body, final_url)
            pages += 1
            if source.id == 'manpower':
                publication_dates.update(_manpower_dates(source, body, final_url))
            discovered.update(urls)
            if not urls:
                raise FetchError('error', 'Список не содержит распознанных вакансий; пустая HTML-оболочка не подтверждает исправность источника.')
            fresh = [url for url in urls if not state.seen(url)]
            overflow = state.enqueue(fresh, priority=True)
            overflow = state.enqueue([url for url in urls if state.seen(url)]) or overflow
            state.cursor = target if overflow else next_url
            if overflow:
                break
            target = resume if resume and resume not in visited else next_url
            resume = None
        for url in state.take(detail_limit):
            inspected += 1
            try:
                body, final_url = fetcher.get(url)
                found = extract_additional_jobs(source, body, final_url)
                if not found:
                    # Unrecognized/closed pages are not successful refreshes;
                    # retain the URL for retry rather than inventing closure.
                    errors.append('Карточка не содержит распознанной вакансии.')
                    rejected['unrecognized'] += 1
                    state.defer(url)
                    continue
                state.mark(url)
                for job in found:
                    parsed += 1
                    if not job.published_at and url in publication_dates:
                        job.published_at = publication_dates[url]
                        job.publication_date_only = True
                    if (not serbia_eligible(job.__dict__) or (source.id == 'manpower'
                            and re.search(r'\binostranstv\w*|\babroad\b|\bforeign\b', normalize(job.location)))):
                        rejected['foreign'] += 1
                        continue
                    if not include_expired and not active(job.__dict__):
                        rejected['expired'] += 1
                        continue
                    jobs[job.url] = job
            except FetchError as exc:
                state.defer(url)
                if exc.state in {'blocked', 'robots_disallowed', 'robots_unavailable', 'timeout'}:
                    raise
                errors.append(exc.detail)
    except FetchError as exc:
        failure = exc
    detail = 'Публичный список и ограниченный обход очереди; позиция сохраняется между сборами.'
    if failure:
        detail += ' ' + failure.detail
    elif errors:
        detail += ' ' + errors[0]
    truncated = bool(state.pending or state.cursor)
    status = ('partial' if jobs else failure.state) if failure else ('partial' if jobs else 'error') if errors else 'partial' if truncated else 'ok' if jobs or inspected or pages else 'empty'
    return list(jobs.values()), _status(source, status, len(jobs), detail, inspected=inspected,
        discovered=len(discovered), listing_pages=pages, parsed_count=parsed, rejected=rejected, skipped_known=state.skipped_known,
        backlog=len(state.pending), truncated=truncated, healthy=bool(pages and not errors and not failure),
        crawl_state=state.checkpoint())
