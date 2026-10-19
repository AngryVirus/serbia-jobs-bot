"""Read public Telegram channel previews; accept explicit Serbian hiring posts."""
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
import re
from urllib.parse import parse_qsl, urlsplit

from filters import active, freshness_matches, normalize, parse_datetime, serbia_eligible
from serbian_geography import serbian_cities, has_serbian_location
from job_metadata import enrich, remote_fact, text_salary
from sources import FetchError, Job, _status, safe_date
from job_quality import quality_reason
from source_policy import validate_channel_page

MAX_PAGES = 2
MAX_POSTS = 60
MAX_HISTORY_DAYS = 90
VOID = {'br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr'}


class ChannelPage(HTMLParser):
    def __init__(self, channel):
        super().__init__(convert_charrefs=True)
        self.channel = channel
        self.posts = []
        self.depth = 0
        self.root = self.text_root = None
        self.post = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get('class', '').split()
        if tag not in VOID:
            self.depth += 1
        identity = attrs.get('data-post', '')
        if self.post is None and re.fullmatch(re.escape(self.channel) + r'/[1-9]\d*', identity, re.I):
            self.root = self.depth
            self.post = {'id': int(identity.split('/')[1]), 'text': [], 'date': None, 'links': []}
        if self.post is None:
            return
        if 'tgme_widget_message_text' in classes:
            self.text_root = self.depth
        if self.text_root and tag in {'br', 'p'}:
            self.post['text'].append('\n')
        if self.text_root and tag == 'a' and (href := public_link(attrs.get('href', ''))):
            self.post['links'].append(href)
        if tag == 'time' and attrs.get('datetime'):
            self.post['date'] = attrs['datetime']

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.post is not None:
            if self.text_root == self.depth:
                self.text_root = None
            if self.root == self.depth:
                self.post['text'] = ''.join(self.post['text']).strip()
                self.posts.append(self.post)
                self.post = None
                self.root = self.text_root = None
        self.depth = max(0, self.depth - 1)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_data(self, data):
        if self.post is not None and self.text_root:
            self.post['text'].append(data)


def public_link(value):
    """Preserve labelled public application/contact links without fetching them."""
    if not isinstance(value, str) or len(value) > 2000 or any(ord(c) < 32 for c in value):
        return ''
    try:
        parts = urlsplit(value)
        if parts.scheme in {'mailto', 'tel'}:
            return value
        if parts.scheme == 'https' and parts.hostname and not parts.username and not parts.password and parts.port in (None, 443):
            from sources import canonical_url
            return canonical_url(value)
    except ValueError:
        pass
    return ''


def _ad_text(text):
    # A publisher footer is not evidence that a remote/global job is in Serbia.
    lines = text.splitlines()
    for index, line in enumerate(lines):
        value = normalize(line).strip(' ·—-🇷🇸')
        if (re.search(r'^(?:работа в сербии|поиск.{0,8}работа в сербии).{0,70}(?:наш|telegram|телеграм|канал)', value)
                or re.search(r'^(?:разместить|опубликовать)\s+вакансию|^post (?:a |your )?vacancy', value)):
            return '\n'.join(lines[:index]).strip()
    return text


ROLE = re.compile(
    r'\b(?:developer|engineer|manager|analyst|architect|designer|recruiter|accountant|counsel|'
    r'barista|bartender|cashier|driver|cook|chef|waiter|nurse|assistant|specialist|support|'
    r'разработчик\w*|инженер\w*|менеджер\w*|аналитик\w*|архитектор\w*|дизаинер\w*|'
    r'рекрутер\w*|бухгалтер\w*|юрист\w*|повар\w*|пекар\w*|кондитер\w*|бариста|бармен\w*|'
    r'кассир\w*|водител\w*|курьер\w*|официант\w*|работник\w*|разнорабоч\w*|'
    r'экскаваторщик\w*|электрик\w*|электромонтажник\w*|администратор\w*|'
    r'медицинская сестра|ассистент\w*|помощник\w*|специалист\w*|координатор\w*|'
    r'programer|inzenjer|konobar|kuvar|vozac|prodavac|radnik)\b')
DUTIES = re.compile(
    r'\b(?:обязанности|основные задачи|ключевые задачи|задачи|чем предстоит заниматься|'
    r'что предстоит делать|responsibilities|your (?:tasks|role)|what you(?: will|’ll|\x27ll) do|'
    r'for which tasks|duties|zaduzenja|odgovornosti|opis posla)\b')
REQUIREMENTS = re.compile(
    r'\b(?:требования|что важно|что для нас важно|мы предлагаем|условия|requirements|'
    r'qualifications|what we offer|what you(?: will|’ll|\x27ll) bring|benefits|uslovi|nudimo)\b')


def hiring_post(text):
    text = _ad_text(text)
    if quality_reason(text):
        return False
    value = normalize(text)
    lines = [normalize(line) for line in text.splitlines() if line.strip()]
    opening = ' '.join(lines[:2])[:350]
    # News about employment and editorial guides are not an employer's ad.
    if re.search(r'^(?:[^\w]*)(?:как |где |поиск работы|рынок труда|в сербии хватает вакансии|'
                 r'ошибка 404|404\b|страница не наидена|page not found|how to |job market)', opening):
        return False
    if re.search(
        r'\b(?:ваканси[яиюи]|требуется|требуются|нанимаем|ищем|hiring|vacancy|vacancies)\b|'
        r'\bищу\s+(?:сотрудника|работника|специалиста)\b|\bwe(?: are|’re|\x27re)? looking for\b|'
        r'\b(?:trazimo|potreban|potrebna|potrebni|zaposljavamo)\b|'
        r'\b(?:тражимо|потребан|потребна|потребни|запошљавамо)\b', value):
        return True
    # Observed English/Russian cards often state a role, duties and requirements
    # without using the word "vacancy". All three signals are required.
    return bool(lines and len(lines[0]) <= 200 and ROLE.search(lines[0])
                and DUTIES.search(value) and REQUIREMENTS.search(value))


def post_job(source, post, *, include_expired=False):
    text = _ad_text(post['text'][:16000])
    if not hiring_post(text):
        return None
    # Company roundups can mix roles and countries; they are not one vacancy.
    if (re.search(r'(?im)^\s*вакансии\s+[^\n]+:', text)
            and len(re.findall(r'(?m)^\s*[—–•-]\s+\S', text)) >= 2):
        return None
    cities = serbian_cities(text)
    if not cities and not has_serbian_location(text):
        return None
    # Explicit country/location fields outrank incidental office/team mentions.
    foreign = r'(?:россия|russia|германия|germany|кипр|cyprus|montenegro|черногория|польша|poland|турция|turkey|georgia|грузия|armenia|армения|kazakhstan|казахстан|usa|united states|uk|united kingdom)'
    for raw in text.splitlines():
        line = normalize(raw)
        field = re.search(r'(?:локация|страна|location|country|lokacija|drzava)\s*[:—-]\s*' + foreign + r'\b', line)
        if field and not has_serbian_location(line[field.start():]):
            return None
    published = safe_date(post['date'])
    if not published:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    title = next((line for line in lines if not re.fullmatch(r'(?:#\w+\s*)+|вакансия\s*[:!]*', line, re.I)), lines[0])[:140]
    links = [link for value in post.get('links', []) if (link := public_link(value)) and link not in text]
    description = text + ('\n' + '\n'.join(dict.fromkeys(links)) if links else '')
    job = Job(source.id, f'https://t.me/{source.telegram_channel}/{post["id"]}', title,
              location=', '.join(cities) or 'Serbia', description=description, published_at=published,
              country='RS', remote=remote_fact(text))
    job.salary_min, job.salary_currency, job.salary_period = text_salary(text)
    job = enrich(job)
    now = datetime.now(timezone.utc)
    if not include_expired and parse_datetime(published) < now - timedelta(days=MAX_HISTORY_DAYS):
        return None
    return job if (include_expired or active(job.__dict__, now)) and freshness_matches(job.__dict__, 'any', now) and serbia_eligible(job.__dict__) else None


def _preview_url(source, value):
    try:
        parts = urlsplit(value)
        params = parse_qsl(parts.query, keep_blank_values=True)
        valid = (parts.scheme == 'https' and parts.hostname == 't.me' and not parts.username
                 and parts.port in (None, 443) and parts.path == '/s/' + source.telegram_channel
                 and not parts.fragment and (not params or
                 len(params) == 1 and params[0][0] == 'before' and re.fullmatch(r'[1-9]\d*', params[0][1])))
        return value if valid else ''
    except (ValueError, TypeError):
        return ''


class PostHistory:
    """Always fetch the head; spend remaining pages on gaps then older history."""
    def __init__(self, source, raw):
        self.source = source
        self.crawl = None
        if raw is not None:
            from crawl_state import CrawlState
            self.crawl = CrawlState(source, raw,
                cursor_validator=lambda value: bool(_preview_url(source, value) and '?before=' in value),
                pending_validator=lambda value: bool(_preview_url(source, value)) or bool(
                    re.fullmatch(r'https://t\.me/' + re.escape(source.telegram_channel) + r'/[1-9]\d*', value)))

    def post_url(self, number):
        return 'https://t.me/' + self.source.telegram_channel + '/' + str(number)

    def known(self, number):
        return bool(self.crawl and self.crawl.seen(self.post_url(number)))

    def due(self, number):
        return not self.crawl or self.crawl.due(self.post_url(number))

    def mark(self, number):
        if self.crawl:
            self.crawl.mark(self.post_url(number))

    def next_page(self, older, *, head, overlap, stale=False):
        if not self.crawl:
            return None if stale else older
        crawl = self.crawl
        if stale:
            # Dates are publication dates: an older cursor cannot lead to a
            # newer original post. Do not preserve an archive cursor forever.
            crawl.cursor, crawl.pending = None, []
            return None
        if head:
            # A new head with no known posts means a missed interval. Catch it
            # before resuming the older cursor, rather than skipping the gap.
            if crawl.history and not overlap and older and crawl.cursor and crawl.cursor != older:
                if crawl.cursor not in crawl.pending:
                    crawl.pending = [crawl.cursor] + crawl.pending[:47]
                crawl.cursor = older
            else:
                crawl.cursor = crawl.cursor or (None if stale else older)
        elif not older or overlap and crawl.pending:
            crawl.cursor = crawl.pending.pop(0) if crawl.pending else None
        else:
            crawl.cursor = older
        return crawl.cursor

    def metrics(self):
        if not self.crawl:
            return {}
        return {'crawl_state': self.crawl.checkpoint(),
                'backlog': len(self.crawl.pending) + bool(self.crawl.cursor)}


def collect_channel(source, fetcher, *, include_expired=False, crawl_state=None, page_limit=MAX_PAGES):
    jobs, seen = {}, set()
    withdrawn, rejected = [], {}
    history = PostHistory(source, crawl_state)
    url = source.listing_url
    pages = skipped = parsed = 0
    truncated = False
    limit = max(1, min(int(page_limit), 4))
    # Durable production backfill is bounded even when expired records are
    # requested for corrections. This cutoff is not a vacancy expiry date.
    bounded_history = crawl_state is not None or not include_expired
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_HISTORY_DAYS)
    state, detail = None, None
    try:
        for _ in range(limit):
            if not _preview_url(source, url):
                raise FetchError('unsupported', 'Неподдерживаемая ссылка публичной ленты Telegram.')
            html, final_url = fetcher.get(url)
            if not pages:
                validate_channel_page(html)
            if not _preview_url(source, final_url):
                raise FetchError('unsupported', 'Публичная лента канала недоступна; вход не выполняется.')
            parser = ChannelPage(source.telegram_channel)
            parser.feed(html)
            parser.close()
            pages += 1
            if not parser.posts:
                if seen:
                    history.next_page(None, head=False, overlap=False)
                    break
                raise FetchError('unsupported', 'Публичная история канала недоступна или разметка Telegram изменилась.')
            overlap = any(history.known(post['id']) for post in parser.posts)
            new = [post for post in parser.posts if post['id'] not in seen][:MAX_POSTS - len(seen)]
            if not new:
                break
            dated = [parse_datetime(post.get('date')) for post in parser.posts]
            stale = bool(bounded_history and dated and all(stamp and stamp < cutoff for stamp in dated))
            for post in new:
                seen.add(post['id'])
                if pages > 1 and not history.due(post['id']):
                    skipped += 1
                    continue
                reason = quality_reason(post['text'])
                if reason == 'closed':
                    withdrawn.append(history.post_url(post['id']))
                job = post_job(source, post, include_expired=include_expired)
                history.mark(post['id'])
                stamp = parse_datetime(post.get('date'))
                recent = not (bounded_history and stamp and stamp < cutoff)
                if job and recent:
                    jobs[job.url] = job
                    parsed += 1
                else:
                    key = reason or ('outdated' if not recent else 'unrecognized_or_non_serbian')
                    rejected[key] = rejected.get(key, 0) + 1
            older = source.listing_url + '?before=' + str(min(post['id'] for post in parser.posts))
            url = history.next_page(older, head=pages == 1, overlap=overlap, stale=stale)
            if len(seen) >= MAX_POSTS:
                truncated = bool(url)
                break
            if not url:
                break
        truncated = truncated or bool(url and pages >= limit)
    except FetchError as error:
        state, detail = ('partial' if jobs else error.state), error.detail
    return list(jobs.values()), _status(source, state or ('ok' if jobs or skipped else 'empty'), len(jobs),
        detail or 'Публичные объявления о найме в Сербии; новые посты и ограниченный обход истории до 90 дней. Резюме и услуги исключаются.',
        discovered=len(seen), inspected=len(seen) - skipped, parsed_count=parsed, rejected=rejected,
        skipped_known=skipped, listing_pages=pages, truncated=truncated, withdrawn_urls=withdrawn, **history.metrics())
