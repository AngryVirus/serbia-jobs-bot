"""Read public Telegram channel previews; accept explicit Serbian hiring posts."""
from datetime import datetime, timezone
from html.parser import HTMLParser
import re

from filters import CITY_NAMES, active, freshness_matches, normalize, serbia_eligible
from job_metadata import enrich, remote_fact, text_salary
from sources import FetchError, Job, _status, safe_date
from job_quality import quality_reason
from source_policy import validate_channel_page

MAX_PAGES = 2
MAX_POSTS = 60
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
            self.post = {'id': int(identity.split('/')[1]), 'text': [], 'date': None}
        if self.post is None:
            return
        if 'tgme_widget_message_text' in classes:
            self.text_root = self.depth
        if self.text_root and tag in {'br', 'p'}:
            self.post['text'].append('\n')
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


def hiring_post(text):
    if quality_reason(text):
        return False
    value = normalize(text)
    # Publisher footers offer advertising, not employment.
    value = re.sub(r'(?:разместить|опубликовать)\s+вакансию|post (?:a |your )?vacancy', '', value)
    return bool(re.search(
        r'\b(?:ваканси[яиюи]|требуется|требуются|нанимаем|ищем|hiring|vacancy|vacancies)\b|'
        r'\bищу\s+(?:сотрудника|работника|специалиста)\b|\bwe(?: are|’re|\x27re)? looking for\b|'
        r'\b(?:trazimo|potreban|potrebna|potrebni|zaposljavamo)\b|'
        r'\b(?:тражимо|потребан|потребна|потребни|запошљавамо)\b', value))


def post_job(source, post):
    text = post['text'][:16000]
    if not hiring_post(text):
        return None
    # Company roundups can mix roles and countries; they are not one vacancy.
    if (re.search(r'(?im)^\s*вакансии\s+[^\n]+:', text)
            and len(re.findall(r'(?m)^\s*[—–•-]\s+\S', text)) >= 2):
        return None
    normalized = normalize(text)
    cities = []
    for key, names in CITY_NAMES.items():
        if key == 'nis' and not re.search(r'\b(?:Niš|NIŠ|Nis|NIS|Ниш(?:е|у)?)\b|'
                                         r'(?i:(?:location|lokacija|локация|город|📍)\s*:?\s*(?:nis|niš|ниш)\b)', text):
            continue
        if any(re.search(r'(?<!\w)' + re.escape(normalize(name)) + r'(?:[аеу]|[au])?(?!\w)', normalized) for name in names):
            cities.append({'belgrade': 'Beograd', 'novi_sad': 'Novi Sad', 'nis': 'Nis',
                           'subotica': 'Subotica', 'kragujevac': 'Kragujevac'}[key])
    if not cities and not re.search(r'\b(?:serbia|srbija|srbiji|серби[яию]|србија|србији)\b', normalized):
        return None
    # A global/foreign post is not Serbian merely because the channel is.
    if re.search(r'(?:локация|страна|location|country)\s*:\s*(?:россия|russia|германия|germany|кипр|cyprus|montenegro|черногория)\b', normalized):
        return None
    published = safe_date(post['date'])
    if not published:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    title = next((line for line in lines if not re.fullmatch(r'(?:#\w+\s*)+|вакансия\s*[:!]*', line, re.I)), lines[0])[:140]
    job = Job(source.id, f'https://t.me/{source.telegram_channel}/{post["id"]}', title,
              location=', '.join(cities) or 'Serbia', description=text, published_at=published,
              country='RS', remote=remote_fact(text))
    job.salary_min, job.salary_currency, job.salary_period = text_salary(text)
    job = enrich(job)
    now = datetime.now(timezone.utc)
    return job if active(job.__dict__, now) and freshness_matches(job.__dict__, 'any', now) and serbia_eligible(job.__dict__) else None


def collect_channel(source, fetcher):
    jobs, seen = {}, set()
    withdrawn = []
    url = source.listing_url
    pages = rejected = 0
    try:
        for _ in range(MAX_PAGES):
            html, _ = fetcher.get(url)
            if not pages:
                validate_channel_page(html)
            parser = ChannelPage(source.telegram_channel)
            parser.feed(html)
            pages += 1
            if not parser.posts:
                if seen:
                    break
                raise FetchError('unsupported', 'Публичная история канала недоступна или разметка Telegram изменилась.')
            new = [post for post in parser.posts if post['id'] not in seen][:MAX_POSTS - len(seen)]
            if not new:
                break
            for post in new:
                seen.add(post['id'])
                if quality_reason(post['text']) == 'closed':
                    withdrawn.append(f'https://t.me/{source.telegram_channel}/{post["id"]}')
                job = post_job(source, post)
                if job:
                    jobs[job.url] = job
                else:
                    rejected += 1
            if len(seen) >= MAX_POSTS:
                break
            url = source.listing_url + '?before=' + str(min(post['id'] for post in new))
    except FetchError as error:
        return list(jobs.values()), _status(source, 'partial' if jobs else error.state, len(jobs), error.detail,
                                            inspected=len(seen), rejected=rejected, listing_pages=pages, withdrawn_urls=withdrawn)
    return list(jobs.values()), _status(source, 'ok' if jobs else 'empty', len(jobs),
        'Публичные сообщения о найме в Сербии; до двух страниц и 60 постов. Резюме и услуги исключаются.',
        inspected=len(seen), rejected=rejected, listing_pages=pages, withdrawn_urls=withdrawn)
