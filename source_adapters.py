"""Verified public page formats; no browser, login or script execution."""
from datetime import datetime
import json
import re
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from sources import (Job, PageParser, FetchError, _status, canonical_url, clean_text,
                     is_detail_url, parse_page, safe_date)
from job_metadata import enrich
from filters import active, serbia_eligible


class Section(PageParser):
    """Read one identified div, excluding navigation and other job cards."""
    def __init__(self, html, *, identity=None, css_class=None):
        super().__init__()
        self.depth = 0
        self.done = False
        self.identity, self.css_class = identity, css_class
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == 'div':
            if self.depth:
                self.depth += 1
            elif not self.done and ((self.identity and attr.get('id') == self.identity)
                                   or (self.css_class and self.css_class in (attr.get('class') or '').split())):
                self.depth = 1
        if self.depth:
            super().handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.depth:
            super().handle_endtag(tag)
            if tag == 'div':
                self.depth -= 1
                self.done = not self.depth

    def handle_data(self, data):
        if self.depth:
            super().handle_data(data)


def _date(value, fmt):
    try:
        return datetime.strptime(str(value).strip(), fmt).date().isoformat()
    except (ValueError, TypeError):
        return None


def _halo(source, html, url):
    # JSON-LD is stale on renewed listings. This exact public object drives the
    # site's current title, dates and description. Decode JSON, never execute JS.
    marker = re.search(r'\bQuidditaEnvironment\.CurrentClassified\s*=\s*', html)
    if not marker:
        return []
    try:
        node, _ = json.JSONDecoder().raw_decode(html[marker.end():])
    except ValueError:
        return []
    if not isinstance(node, dict) or str(node.get('Id')) != urlsplit(url).path.rstrip('/').rsplit('/', 1)[-1]:
        return []
    if node.get('StateId') not in (101, '101') or re.search(r'IsCurrentAdActive\s*=\s*false\b', html):
        return []
    fields = node.get('OtherFields') or {}
    if not isinstance(fields, dict):
        return []
    title = clean_text(node.get('Title'))
    if not title:
        return []
    cities = fields.get('gradovi_ss') or []
    location = ', '.join(clean_text(c) for c in cities if isinstance(c, str)) if isinstance(cities, list) else ''
    description = '\n'.join(clean_text(node.get(key)) for key in ('TextHtml',) if node.get(key))
    for key in ('opis_posla_s', 'znanje_i_vestine_s', 'radno_iskustvo_s', 'profil_kandidata_s', 'nudimo_s', 'napomena_s'):
        if fields.get(key):
            description += '\n' + clean_text(fields[key])
    url = urlunsplit((*urlsplit(url)[:3], '', ''))
    job = Job(source.id, url, title, clean_text(fields.get('naziv_poslodavca_s')), location,
              description[:16000], published_at=safe_date(node.get('ValidFromProlonged') or node.get('ValidFrom')),
              expires_at=safe_date(node.get('ValidToProlonged') or node.get('ValidTo')))
    return [enrich(job)]


def extract_special_jobs(source, html, url):
    if not is_detail_url(source, url):
        return []
    if source.id == 'halooglasi':
        return _halo(source, html, url)
    page = parse_page(html)
    title = next((text for tag, text in page.headings if tag == 'h1'), '')
    if not title:
        return []
    if source.id == 'startit':
        section = Section(html, identity='so-co-ad-wrap')
        description = '\n'.join(section.lines)
        if not description or not any(line.startswith('Prijavi se do ') for line in page.lines):
            return []
        location = next((re.sub(r'^Lokacija\s*[—–:-]\s*', '', line) for line in page.lines
                         if re.match(r'^Lokacija\s*[—–:-]', line)), '')
        deadline = next((line.removeprefix('Prijavi se do ') for line in page.lines if line.startswith('Prijavi se do ')), '')
        job = Job(source.id, canonical_url(url), title, location=location, description=description[:16000],
                  expires_at=_date(deadline, '%d/%m/%y'))
    else:
        section = Section(html, css_class='padding-right')
        description = '\n'.join(section.lines)
        if not re.search(r'Opis posla|Uslovi', description, re.I):
            return []
        location = next((line.split(':', 1)[1].strip() for line in section.lines if line.startswith('Mesto:')), '')
        company = next((text for tag, text in section.headings if tag == 'h4'), '')
        job = Job(source.id, canonical_url(url), title, company, location, description[:16000])
        # Preserve the ad's own pay wording; do not turn hourly pay into a monthly minimum.
        salary = next((line.split(':', 1)[1].strip() for line in section.lines if line.startswith('Zarada:')), '')
        if salary:
            job.salary_display = salary[:150]
    return [enrich(job)]


def collect_lako(source, fetcher, detail_limit, *, include_expired=False, crawl_state=None, page_limit=2):
    """Anonymous endpoints used by the site's published Next.js client."""
    if crawl_state is not None:
        return _collect_lako_state(source, fetcher, detail_limit, page_limit, crawl_state, include_expired)
    jobs, inspected, errors = {}, 0, []
    withdrawn = []
    base = 'https://prod.lakodoposla.net/api'

    def record_closed(node, identity):
        slug = node.get('slug')
        if not include_expired or not isinstance(slug, str) or len(slug) > 1900:
            return
        if re.fullmatch(r'[a-z0-9-]+-' + str(identity), slug):
            url = 'https://www.lakodoposla.com/oglasi/' + slug
            if len(withdrawn) < 100 and url not in withdrawn:
                withdrawn.append(url)

    try:
        body, _ = fetcher.get(base + '/postings?page=1')
        payload = json.loads(body)
        if not isinstance(payload, dict) or not isinstance(payload.get('data'), list):
            raise FetchError('error', 'Изменился формат списка Lako do posla.')
        seen = set()
        for item in payload['data']:
            if not isinstance(item, dict) or type(item.get('id')) is not int or item['id'] <= 0:
                continue
            if item['id'] in seen:
                continue
            if item.get('hasExpired') is True:
                # The public list already confirms closure; no detail request
                # or invented expiry date is needed to update a known URL.
                record_closed(item, item['id'])
                if include_expired:
                    seen.add(item['id'])
                continue
            if inspected >= max(0, min(detail_limit, 50)):
                break
            seen.add(item['id'])
            inspected += 1
            try:
                body, _ = fetcher.get(base + '/postings/' + str(item['id']))
                response = json.loads(body)
                node = response.get('data') if isinstance(response, dict) else None
                if not isinstance(node, dict) or node.get('id') != item['id']:
                    raise FetchError('error', 'Изменился формат карточки Lako do posla.')
                slug = str(node.get('slug') or '')
                if not re.fullmatch(r'[a-z0-9-]+-' + str(item['id']), slug):
                    continue
                if node.get('hasExpired') is True:
                    record_closed(node, item['id'])
                    continue
                title = clean_text(node.get('positionTitle'))
                # Whitelist public vacancy fields. Do not store employer account
                # objects, application state or arbitrary API response fields.
                description = '\n'.join(clean_text(node.get(key)) for key in (
                    'jobDescription', 'shortJobDescription', 'conditionsDescription',
                    'offersDescription', 'additionalDescription') if node.get(key))
                if not title or not description:
                    continue
                job = Job(source.id, 'https://www.lakodoposla.com/oglasi/' + slug, title,
                          clean_text(node.get('employerName')), clean_text(node.get('locationName')), description[:16000],
                          published_at=_date(node.get('date'), '%d.%m.%Y'), expires_at=_date(node.get('expiryDate'), '%d.%m.%Y'))
                job = enrich(job)
                if (include_expired or active(job.__dict__)) and serbia_eligible(job.__dict__):
                    jobs[job.url] = job
            except (FetchError, ValueError) as error:
                if isinstance(error, FetchError) and error.state in {'blocked', 'robots_disallowed', 'robots_unavailable', 'timeout'}:
                    raise
                errors.append(error.detail if isinstance(error, FetchError) else 'Некорректный JSON карточки.')
    except (FetchError, ValueError) as error:
        detail = error.detail if isinstance(error, FetchError) else 'Некорректный JSON публичного API.'
        state = 'partial' if jobs else error.state if isinstance(error, FetchError) else 'error'
        return list(jobs.values()), _status(source, state, len(jobs), detail, inspected=inspected, public_api=True,
                                            **({'withdrawn_urls': withdrawn} if include_expired else {}))
    detail = 'Публичный API Lako do posla: первая страница списка и ограниченная выборка подробных карточек.'
    if errors:
        detail += ' ' + errors[0]
    state = ('partial' if jobs else 'error') if errors else ('ok' if jobs else 'empty')
    return list(jobs.values()), _status(source, state, len(jobs),
                                        detail, inspected=inspected, public_api=True,
                                        **({'withdrawn_urls': withdrawn} if include_expired else {}))


def _collect_lako_state(source, fetcher, detail_limit, page_limit, raw, include_expired):
    from crawl_state import CrawlState
    base = 'https://prod.lakodoposla.net/api/postings'
    def cursor_valid(value):
        parsed = urlsplit(value)
        return (parsed.hostname == 'prod.lakodoposla.net' and parsed.path == '/api/postings'
                and bool(re.fullmatch(r'page=[1-9]\d{0,5}', parsed.query)))
    def detail_valid(value):
        return bool(re.fullmatch(re.escape(base) + r'/[1-9]\d{0,11}', value))
    crawl = CrawlState(source, raw, cursor_validator=cursor_valid, pending_validator=detail_valid)
    jobs, withdrawn, rejected, errors = {}, [], {}, []
    inspected = parsed_count = pages = 0
    discovered, visited = set(), set()
    resume, current = crawl.cursor, base + '?page=1'

    def closed(node, identity):
        slug = node.get('slug')
        if not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9-]{1,180}-' + str(identity), slug):
            return
        url = 'https://www.lakodoposla.com/oglasi/' + slug
        if include_expired and len(withdrawn) < 100 and url not in withdrawn:
            withdrawn.append(url)

    while current and current not in visited and pages < max(1, min(page_limit, 4)):
        visited.add(current)
        try:
            body, _ = fetcher.get(current)
            payload = json.loads(body)
            if not isinstance(payload, dict) or not isinstance(payload.get('data'), list):
                raise FetchError('error', 'Изменился формат списка Lako do posla.')
            pages += 1
            links = []
            for item in payload['data'][:100]:
                if not isinstance(item, dict) or type(item.get('id')) is not int or not 0 < item['id'] < 10**12:
                    continue
                url = base + '/' + str(item['id'])
                discovered.add(url)
                if item.get('hasExpired') is True:
                    closed(item, item['id'])
                    crawl.mark(url)
                    rejected['closed'] = rejected.get('closed', 0) + 1
                else:
                    links.append(url)
            overflow = crawl.enqueue(links, priority=pages == 1)
            meta = payload.get('meta') if isinstance(payload.get('meta'), dict) else {}
            number = int(dict(parse_qsl(urlsplit(current).query))['page'])
            # Follow only the API's explicit pagination metadata. Do not infer
            # a next page merely because the current list happens to be full.
            more = meta.get('hasMorePages') is True
            last = meta.get('lastPage')
            if type(last) is int and number >= last:
                more = False
            next_url = base + '?page=' + str(number + 1) if more else None
            if overflow:
                crawl.cursor = current
                break
            if pages == 1 and resume and resume != current:
                next_url = resume
            crawl.cursor = next_url
            current = next_url
        except (FetchError, ValueError) as error:
            errors.append(error if isinstance(error, FetchError) else FetchError('error', 'Некорректный JSON публичного API.'))
            if pages:
                crawl.cursor = current
            break
    blocked = errors and errors[0].state in {'blocked', 'robots_unavailable', 'robots_disallowed', 'timeout'}
    for url in ([] if blocked else crawl.take(detail_limit)):
        inspected += 1
        identity = int(url.rsplit('/', 1)[-1])
        try:
            body, _ = fetcher.get(url)
            response = json.loads(body)
            node = response.get('data') if isinstance(response, dict) else None
            if not isinstance(node, dict) or node.get('id') != identity:
                raise FetchError('error', 'Изменился формат карточки Lako do posla.')
            slug = str(node.get('slug') or '')
            if not re.fullmatch(r'[a-z0-9-]{1,180}-' + str(identity), slug):
                rejected['unrecognized'] = rejected.get('unrecognized', 0) + 1
                crawl.mark(url)
                continue
            if node.get('hasExpired') is True:
                closed(node, identity)
                crawl.mark(url)
                rejected['closed'] = rejected.get('closed', 0) + 1
                continue
            title = clean_text(node.get('positionTitle'))
            description = '\n'.join(clean_text(node.get(key)) for key in (
                'jobDescription', 'shortJobDescription', 'conditionsDescription',
                'offersDescription', 'additionalDescription') if node.get(key))
            if not title or not description:
                rejected['unrecognized'] = rejected.get('unrecognized', 0) + 1
                crawl.mark(url)
                continue
            job = enrich(Job(source.id, 'https://www.lakodoposla.com/oglasi/' + slug, title,
                clean_text(node.get('employerName')), clean_text(node.get('locationName')), description[:16000],
                published_at=_date(node.get('date'), '%d.%m.%Y'), expires_at=_date(node.get('expiryDate'), '%d.%m.%Y')))
            parsed_count += 1
            if not include_expired and not active(job.__dict__):
                rejected['expired'] = rejected.get('expired', 0) + 1
            elif not serbia_eligible(job.__dict__):
                rejected['outside_serbia'] = rejected.get('outside_serbia', 0) + 1
            else:
                jobs[job.url] = job
            crawl.mark(url)
        except (FetchError, ValueError) as error:
            error = error if isinstance(error, FetchError) else FetchError('error', 'Некорректный JSON карточки.')
            errors.append(error)
            crawl.defer(url)
            if error.state in {'blocked', 'robots_unavailable', 'robots_disallowed', 'timeout'}:
                break
    truncated = bool(crawl.pending or crawl.cursor)
    state = 'partial' if errors or truncated else 'ok' if jobs or crawl.skipped_known else 'empty'
    if errors and not jobs:
        state = errors[0].state
    return list(jobs.values()), _status(source, state, len(jobs),
        errors[0].detail if errors else 'Публичный API Lako do posla: свежая страница и сохранённое продолжение в пределах бюджета.',
        public_api=True, discovered=len(discovered), inspected=inspected, parsed_count=parsed_count,
        rejected=rejected, skipped_known=crawl.skipped_known, truncated=truncated, backlog=len(crawl.pending),
        listing_pages=pages, crawl_state=crawl.checkpoint(), healthy=not errors,
        **({'withdrawn_urls': withdrawn} if include_expired else {}))
