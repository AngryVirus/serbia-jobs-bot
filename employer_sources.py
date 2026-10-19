"""Anonymous, bounded Greenhouse job-board GETs for verified employers.

The compact public list is fetched once; descriptions are requested only for
Serbia-eligible jobs. Global ``content=true`` feeds can exceed the common 2 MB
response budget, so this adapter never requests them. No application endpoints,
recruiter metadata, candidate data or authentication are used.
"""
from html import unescape
import json
import re
from urllib.parse import parse_qsl, urlsplit

from crawl_state import CrawlState
from filters import active, normalize, serbia_eligible
from job_metadata import enrich
from serbian_geography import COUNTRY, has_serbian_location
from sources import FetchError, Job, MAX_BYTES, _status, clean_text, safe_date


EMPLOYER_BOARDS = {
    'gh_wolt': ('wolt', 'Wolt'),
    'gh_jetbrains': ('jetbrains', 'JetBrains'),
    'gh_nordeus': ('nordeus', 'Nordeus'),
    'gh_epicgames': ('epicgames', 'Epic Games'),
}
API_ROOT = 'https://boards-api.greenhouse.io/v1/boards/'
_FOREIGN = re.compile(r'\b(?:united states|united kingdom|usa|canada|germany|deutschland|'
    r'netherlands|france|finland|sweden|norway|denmark|poland|austria|australia|'
    r'czech republic|czechia|spain|portugal|italy|ireland|iceland|switzerland|'
    r'hungary|romania|bulgaria|greece|croatia|montenegro|bosnia|albania|'
    r'north macedonia|slovenia|slovakia|estonia|latvia|lithuania|cyprus|'
    r'malta|luxembourg|belgium|russia|ukraine|belarus|georgia|armenia|'
    r'turkey|israel|japan|china|india|brazil|mexico|argentina|south africa)\b')
_LOCATION_FIELDS = {'job location', 'location', 'country', 'eligible countries',
                    'applicant location requirements'}


def _text(value, limit=1000):
    return clean_text(value)[:limit] if isinstance(value, str) else ''


def _positive_location(value):
    text = normalize(value)
    if re.search(COUNTRY, text) or text in {'rs', 'srb'}:
        return True
    # Belgrade, Montana is not Serbia. Explicit Serbian country names take
    # precedence in genuine multi-location lists such as JetBrains' boards.
    return not _FOREIGN.search(text) and has_serbian_location(value)


def _location(node):
    location = node.get('location')
    primary = _text(location.get('name')) if isinstance(location, dict) else ''
    if primary and _positive_location(primary):
        return primary
    if primary and _FOREIGN.search(normalize(primary)):
        return None
    metadata = node.get('metadata')
    if isinstance(metadata, list):
        for field in metadata[:100]:
            if not isinstance(field, dict) or normalize(field.get('name', '')) not in _LOCATION_FIELDS:
                continue
            values = field.get('value')
            values = values[:30] if isinstance(values, list) else [values]
            value = ', '.join(_text(item) for item in values)
            if _positive_location(value):
                return primary + '; ' + value if primary else value
    # Assigned offices are useful when a board omits its display location, but
    # a company office alone must not qualify a generic global remote role.
    if not primary:
        offices = node.get('offices')
        if isinstance(offices, list):
            for office in offices[:100]:
                if not isinstance(office, dict):
                    continue
                value = _text(office.get('location')) or _text(office.get('name'))
                if _positive_location(value):
                    return value
        # Some boards put their sole location in the title, not a separate
        # field. An incidental Serbia mention in the description is ignored.
        title = _text(node.get('title'), 500)
        if _positive_location(title):
            return title
    return None


def _public_url(board, identity, value):
    """Allow only observed public job routes with the matching board and ID."""
    if not isinstance(value, str) or not 1 <= len(value) <= 2048 or any(ord(c) < 33 for c in value) or '\\' in value:
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {'https', 'http'} or parsed.username or parsed.password
                or parsed.port not in (None, 80, 443)):
            return None
        host = parsed.hostname
        path = parsed.path.rstrip('/')
        if board in {'wolt', 'jetbrains'}:
            hosts = {'job-boards.greenhouse.io', 'boards.greenhouse.io'} if board == 'wolt' else {
                'job-boards.eu.greenhouse.io', 'boards.eu.greenhouse.io'}
            if host in hosts and path == f'/{board}/jobs/{identity}':
                return f'https://{host}{path}'
        elif board == 'nordeus':
            if (host in {'nordeus.com', 'www.nordeus.com'} and path == '/careers'
                    and parse_qsl(parsed.query) == [('gh_jid', str(identity))]):
                return f'https://www.nordeus.com/careers?gh_jid={identity}'
        elif board == 'epicgames':
            if host in {'epicgames.com', 'www.epicgames.com'} and path == f'/careers/jobs/{identity}':
                return f'https://epicgames.com{path}'
    except ValueError:
        pass
    return None


def _json(body):
    if not isinstance(body, str) or len(body.encode('utf-8')) > MAX_BYTES:
        raise FetchError('error', 'Ответ публичной ленты превышает ограничение размера.')
    try:
        return json.loads(body)
    except (ValueError, RecursionError) as error:
        raise FetchError('error', 'Некорректный JSON публичной ленты работодателя.') from error


def collect_employer(source, fetcher, detail_limit=8, *, include_expired=False,
                     crawl_state=None, page_limit=2):
    """Inspect one complete compact board and a bounded durable detail queue."""
    config = EMPLOYER_BOARDS.get(source.id)
    if config is None:
        return [], _status(source, 'error', detail='Неизвестная публичная лента работодателя.', healthy=False)
    board, company = config
    listing = API_ROOT + board + '/jobs'
    detail_prefix = listing + '/'
    valid_detail = lambda value: isinstance(value, str) and bool(re.fullmatch(
        re.escape(detail_prefix) + r'[1-9]\d{0,15}', value))
    crawl = CrawlState(source, crawl_state, pending_validator=valid_detail,
                       cursor_validator=lambda value: False)
    jobs, errors = {}, []
    discovered = inspected = parsed_count = eligible = listing_pages = 0
    rejected = {}
    def reject(reason):
        rejected[reason] = rejected.get(reason, 0) + 1
    error_state = 'error'
    try:
        body, final_url = fetcher.get(listing)
        if final_url != listing:
            raise FetchError('error', 'Публичная лента перенаправлена на неподтверждённый адрес.')
        payload = _json(body)
        if not isinstance(payload, dict) or not isinstance(payload.get('jobs'), list):
            raise FetchError('error', 'Изменился формат публичной ленты работодателя.')
        listing_pages = 1
        nodes, identities = {}, set()
        # The list is already bounded by MAX_BYTES. Ignore non-public fields;
        # never persist full list entries in the crawl checkpoint or status.
        for node in payload['jobs']:
            if not isinstance(node, dict) or type(node.get('id')) is not int or not 0 < node['id'] < 10**16:
                reject('invalid')
                continue
            identity = node['id']
            if identity in identities:
                continue
            identities.add(identity)
            discovered += 1
            if not _location(node):
                reject('not_serbia')
                continue
            if not _text(node.get('title'), 500):
                reject('missing_title')
                continue
            if not _public_url(board, identity, node.get('absolute_url')):
                reject('missing_url')
                continue
            eligible += 1
            nodes[identity] = node
        candidates = [detail_prefix + str(identity) for identity in nodes]
        current = set(candidates)
        # A completed list supersedes old queued identities that were withdrawn
        # or moved abroad. Never request an identity absent from this board.
        crawl.pending = [url for url in crawl.pending if url in current]
        unseen = [url for url in candidates if not crawl.seen(url)]
        overflow = crawl.enqueue(unseen, priority=True)
        overflow = crawl.enqueue(url for url in candidates if crawl.seen(url)) or overflow
        for url in crawl.take(detail_limit):
            identity = int(url.rsplit('/', 1)[1])
            inspected += 1
            try:
                body, final_url = fetcher.get(url)
                if final_url != url:
                    raise FetchError('error', 'Карточка работодателя перенаправлена на неподтверждённый адрес.')
                node = _json(body)
                if not isinstance(node, dict) or type(node.get('id')) is not int or node['id'] != identity:
                    raise FetchError('error', 'Изменился формат карточки работодателя.')
                location = _location(node)
                public_url = _public_url(board, identity, node.get('absolute_url'))
                title = _text(node.get('title'), 500)
                description = _text(unescape(node.get('content', '')), 16000) if isinstance(node.get('content'), str) else ''
                if not location or not public_url:
                    reject('not_serbia' if not location else 'missing_url')
                    crawl.mark(url)
                    continue
                if not title or not description:
                    raise FetchError('error', 'В публичной карточке работодателя отсутствует название или описание.')
                summary = nodes[identity]
                job = Job(source.id, public_url, title, company, location, description,
                    country='RS', eligible_countries=['RS'],
                    published_at=safe_date(node.get('first_published') or summary.get('first_published')),
                    expires_at=safe_date(node.get('application_deadline') or summary.get('application_deadline')))
                job = enrich(job)
                if not job.eligible_countries:
                    job.eligible_countries = ['RS']
                # Multiple-office lists may include "Remote, Germany" alongside
                # an office in Serbia. That must not become remote from Serbia.
                if re.fullmatch(r'\s*(?:remote\s*[,;–-]\s*serbia|serbia\s*[,;–-]\s*remote)\s*', location, re.I):
                    job.remote = True
                parsed_count += 1
                if (include_expired or active(job.__dict__)) and serbia_eligible(job.__dict__):
                    jobs[public_url] = job
                else:
                    reject('expired' if not active(job.__dict__) else 'not_serbia')
                crawl.mark(url)
            except FetchError as error:
                errors.append(error.detail)
                error_state = error.state
                # One permanently broken card must not monopolize every run's
                # first slot and prevent other pending vacancies being checked.
                crawl.defer(url)
                if error.state in {'blocked', 'robots_disallowed', 'robots_unavailable', 'timeout'}:
                    break
    except FetchError as error:
        errors.append(error.detail)
        error_state = error.state
        overflow = False
    deferred = len(crawl.pending)
    truncated = bool(deferred or overflow)
    state = ('partial' if jobs else error_state) if errors else 'partial' if truncated else 'ok' if jobs or crawl.skipped_known else 'empty'
    detail = 'Публичная лента работодателя: компактный список и ограниченная очередь карточек Сербии; повторная проверка через 24 часа.'
    if errors:
        detail += ' ' + errors[0]
    return list(jobs.values()), _status(source, state, len(jobs), detail,
        public_api=True, listing_pages=listing_pages, healthy=bool(listing_pages and not errors),
        discovered=discovered, eligible=eligible, inspected=inspected,
        parsed_count=parsed_count, rejected=rejected, skipped_known=crawl.skipped_known,
        backlog=deferred, truncated=truncated,
        deferred=deferred, queue_overflow=overflow, crawl_state=crawl.checkpoint())
