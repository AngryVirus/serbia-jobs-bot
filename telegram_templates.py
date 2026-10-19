"""Read bounded public Telegram previews for the two verified job channels.

No Telegram account, Bot API history access, private channels or media downloads.
Only observed single-vacancy templates are accepted; unknown posts stay out.
"""
from datetime import datetime, timedelta, timezone
from html import unescape
from html.parser import HTMLParser
import re
from urllib.parse import parse_qsl, urljoin, urlsplit

from filters import active, parse_datetime, serbia_eligible
from job_metadata import enrich, remote_fact
from location_links import google_maps_url
from sources import FetchError, Job, PageParser, _status, canonical_url
from job_quality import quality_reason
from source_policy import validate_channel_page
from telegram_sources import MAX_HISTORY_DAYS, MAX_POSTS, PostHistory, _preview_url


VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


class ChannelPage(HTMLParser):
    def __init__(self, channel):
        super().__init__(convert_charrefs=True)
        self.channel = channel
        self.posts = {}
        self.older = []
        self.stack = []
        self.current = None
        self.post_depth = None
        self.body = None
        self.body_depth = None

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        classes = (attr.get('class') or '').split()
        depth = len(self.stack)
        if tag == 'div' and 'tgme_widget_message' in classes:
            post = attr.get('data-post') or ''
            if re.fullmatch(re.escape(self.channel) + r'/[1-9]\d*', post):
                self.current = {'post': post, 'date': None, 'map': ''}
                self.post_depth = depth
        if tag == 'a' and 'tme_messages_more' in classes:
            self.older.append(attr.get('href') or '')
        if self.current is not None:
            if tag == 'div' and 'tgme_widget_message_text' in classes:
                self.body = PageParser()
                self.body_depth = depth
            elif self.body is not None:
                self.body.handle_starttag(tag, attrs)
            if tag == 'time' and self.body is None:
                self.current['date'] = attr.get('datetime')
            if tag == 'a' and 'tgme_widget_message_location_wrap' in classes:
                self.current['map'] = google_maps_url(attr.get('href'))
        if tag not in VOID:
            self.stack.append(tag)

    def handle_data(self, data):
        if self.body is not None:
            self.body.handle_data(data)

    def handle_endtag(self, tag):
        if tag in VOID or tag not in self.stack:
            return
        depth = len(self.stack) - 1 - self.stack[::-1].index(tag)
        if self.body is not None:
            if depth <= self.body_depth:
                self.body.close()
                self.current['body'] = self.body
                self.body = self.body_depth = None
            else:
                self.body.handle_endtag(tag)
        if self.current is not None and depth <= self.post_depth:
            # A duplicated widget/media overlay does not create another job.
            self.posts.setdefault(self.current['post'], self.current)
            self.current = self.post_depth = None
        del self.stack[depth:]


def _application_url(channel, href):
    try:
        href = unescape(href)
        parts = urlsplit(href)
        if parts.scheme != 'https' or parts.username or parts.port not in (None, 443):
            return ''
        host = (parts.hostname or '').removeprefix('www.')
        if channel == 'radim_serbia' and host == 'radim.rs' and re.fullmatch(r'/jobs/[^/]+/?', parts.path):
            return canonical_url(href)
        if channel == 'rabotavserbii' and host == 'ovdejobs.com':
            if re.fullmatch(r'/jobs/[^/]+/?', parts.path):
                return canonical_url(href)
            params = dict(parse_qsl(parts.query))
            if parts.path in ('', '/') and re.fullmatch(r'[1-9]\d*', params.get('p', '')) and not params.get('post_type'):
                return 'https://ovdejobs.com/?p=' + params['p']
    except ValueError:
        pass
    return ''


def _job(source, post):
    body = post.get('body')
    if body is None:
        return None
    lines = []
    for line in body.lines:
        if re.fullmatch(r'[_—-]{2,}', line) or line.startswith('🚀 Ищете сотрудников?'):
            break
        if line.strip(' \u2800'):
            lines.append(line)
    if not lines:
        return None
    if quality_reason('\n'.join(lines)):
        return None
    title = lines[0].strip()
    if len(title) > 180 or re.search(r'(?i)ищу работу|ищу подработку|резюме|дайджест|подборка|свежие вакансии|интенсив|вебинар|#ad', title):
        return None
    applications = list(dict.fromkeys(url for href, label in body.links
                        if re.search(r'(?i)подробнее.*отклик|узнать подробнее', label)
                        if (url := _application_url(source.telegram_channel, href))))
    places = [line for line in lines if line.startswith('📍')]
    location_line = places[0] if len(places) == 1 else ''
    # Some Radim cards omit the pin emoji but retain the unambiguous
    # "company · city/work model" second line.
    if not location_line and source.telegram_channel == 'radim_serbia' and len(lines) > 1 and ' · ' in lines[1]:
        location_line = lines[1]
    if len(applications) != 1 or not location_line:
        return None
    place = location_line.removeprefix('📍').strip()
    company = ''
    if source.telegram_channel == 'radim_serbia':
        if ' · ' in place:
            company, place = place.rsplit(' · ', 1)
    elif source.telegram_channel == 'rabotavserbii':
        if lines.index(location_line) == 2:
            company = lines[1]
    description = [line for line in lines[1:] if line not in {company, location_line}
                   and not line.startswith(('💰', '🔗', '👉'))]
    # Preserve public contact/map links whose anchor label is not the URL.
    links = []
    for href, label in body.links:
        if label not in '\n'.join(lines):
            continue
        href = unescape(href)
        if google_maps_url(href):
            links.append(href)
        elif href.startswith(('mailto:', 'tel:')):
            links.append(href.split(':', 1)[1])
        elif re.fullmatch(r'https://t\.me/[A-Za-z][A-Za-z0-9_]{4,31}', href):
            links.append(href)
    if post['map']:
        links.append(post['map'])
    description += list(dict.fromkeys(links))
    description.append('Подробнее и откликнуться: ' + applications[0])
    published = post.get('date')
    if not parse_datetime(published):
        published = None
    salary = next((line.removeprefix('💰').split(' · ')[0].strip() for line in lines if line.startswith('💰')), None)
    # Preserve raw salary, but do not turn an unspecified period into a month.
    job = enrich(Job(source.id, 'https://t.me/' + post['post'], title, company, place,
                     '\n'.join(description), published_at=published, salary_display=salary))
    if salary:
        from job_metadata import text_salary
        job.salary_min, job.salary_currency, job.salary_period = text_salary(salary)
    job.remote = remote_fact(title + '\n' + job.description + '\n' + place.replace('|', '\n'))
    if job.remote is None and re.fullmatch(r'\s*(?:remote|удалённо|удаленно|rad od kuće|rad od kuce)\s*', place, re.I):
        job.remote = True
    for handle in re.findall(r'(?<![\w@])@([A-Za-z][A-Za-z0-9_]{4,31})\b', job.description):
        contact = 'https://t.me/' + handle
        if contact not in job.contacts:
            job.contacts.append(contact)
    return job


def collect_telegram(source, fetcher, *, include_expired=False, crawl_state=None, page_limit=2):
    jobs, seen_posts, seen_pages = {}, set(), set()
    withdrawn, rejected = [], {}
    history = PostHistory(source, crawl_state)
    url = source.listing_url
    skipped = parsed = 0
    limit = max(1, min(int(page_limit), 4))
    # Production imports expired records to correct existing jobs; it must
    # still stop the durable initial traversal at the advertised age bound.
    bounded_history = crawl_state is not None or not include_expired
    truncated, state, detail = False, None, None
    try:
        while url and len(seen_pages) < limit and url not in seen_pages:
            if not _preview_url(source, url):
                raise FetchError('unsupported', 'Неподдерживаемая ссылка публичной ленты Telegram.')
            html, final_url = fetcher.get(url)
            if not seen_pages:
                validate_channel_page(html)
            seen_pages.add(url)
            if not _preview_url(source, final_url):
                raise FetchError('unsupported', 'Публичная лента канала недоступна; вход не выполняется.')
            page = ChannelPage(source.telegram_channel)
            page.feed(html)
            page.close()
            if not page.posts:
                if seen_posts:
                    history.next_page(None, head=False, overlap=False)
                    break
                raise FetchError('unsupported', 'Посты публичного канала не доступны или изменилась разметка.')
            overlap = any(history.known(post_id.split('/')[1]) for post_id in page.posts)
            dated = [parse_datetime(post.get('date')) for post in page.posts.values()]
            cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_HISTORY_DAYS)
            stale = bool(bounded_history and dated and all(stamp and stamp < cutoff for stamp in dated))
            for post_id, post in page.posts.items():
                if post_id in seen_posts:
                    continue
                if len(seen_posts) >= MAX_POSTS:
                    truncated = True
                    break
                seen_posts.add(post_id)
                number = post_id.split('/')[1]
                if len(seen_pages) > 1 and not history.due(number):
                    skipped += 1
                    continue
                reason = quality_reason('\n'.join(post['body'].lines)) if post.get('body') else 'unrecognized'
                if reason == 'closed':
                    withdrawn.append('https://t.me/' + post_id)
                job = _job(source, post)
                history.mark(number)
                recent = not (bounded_history and (stamp := parse_datetime(post.get('date'))) and stamp < cutoff)
                if job and recent and (include_expired or active(job.__dict__)) and serbia_eligible(job.__dict__):
                    jobs[job.url] = job
                    parsed += 1
                else:
                    key = reason or ('outdated' if not recent else 'unrecognized_or_non_serbian')
                    rejected[key] = rejected.get(key, 0) + 1
            oldest = min(int(post.split('/')[1]) for post in page.posts)
            older = next((candidate for href in page.older
                        if (candidate := _preview_url(source, urljoin(final_url, href)))
                        and (params := dict(parse_qsl(urlsplit(candidate).query)))
                        and int(params.get('before', '0')) <= oldest), None)
            url = history.next_page(older, head=len(seen_pages) == 1, overlap=overlap, stale=stale)
            if len(seen_posts) >= MAX_POSTS:
                truncated = truncated or bool(url)
                break
        truncated = truncated or bool(url and len(seen_pages) >= limit)
    except FetchError as exc:
        state, detail = ('partial' if jobs else exc.state), exc.detail
    return list(jobs.values()), _status(source, state or ('ok' if jobs or skipped else 'empty'), len(jobs),
        detail or 'Публичная Telegram-лента: новые посты и ограниченный обход истории до 90 дней. Только распознанные вакансии; реклама и подборки исключаются.',
        discovered=len(seen_posts), inspected=len(seen_posts) - skipped, parsed_count=parsed,
        rejected=rejected, skipped_known=skipped, listing_pages=len(seen_pages), truncated=truncated,
        withdrawn_urls=withdrawn, **history.metrics())
