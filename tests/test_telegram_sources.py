"""Public Telegram preview parsing and location links."""
import unittest
from urllib.parse import parse_qs, urlsplit

from location_links import job_map_url
from presentation import job_text
from sources import SOURCES, Job, extract_jobs
from telegram_sources import collect_telegram


def post(channel, number, body, *, date='2026-10-14T12:00:00+00:00'):
    return f'''<div class="tgme_widget_message text_not_supported_wrap" data-post="{channel}/{number}">
    <div class="tgme_widget_message_bubble"><div class="tgme_widget_message_text">{body}</div>
    <div class="tgme_widget_message_footer"><time datetime="{date}">12:00</time></div></div></div>'''


def preview(channel, posts, before=None):
    more = f'<a class="tme_messages_more" href="/s/{channel}?before={before}">Older</a>' if before else ''
    return '<html><body>' + ''.join(posts) + more + '</body></html>'


class FakeFetcher:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        return self.routes[url], url


class TelegramSourceTests(unittest.TestCase):
    def test_channels_accept_job_cards_and_reject_ads_digests_and_jobseekers(self):
        source = SOURCES['tg_radim_serbia']
        listing = preview('radim_serbia', [
            post('radim_serbia', 12, '<b>QA engineer</b><br/>📍 Example · Белград<br/>💰 от 1 000 EUR<br/>'
                 'Требуется английский.<br/><a href="https://radim.rs/jobs/qa-engineer">Подробнее и откликнуться</a>'),
            post('radim_serbia', 13, '<b>Свежие вакансии в Сербии</b><br/>📍 Белград<br/>'
                 '<a href="https://radim.rs/jobs/one">Подробнее и откликнуться</a>'),
            post('radim_serbia', 14, '<b>Ищу работу тестировщиком</b><br/>📍 Белград<br/>'
                 '<a href="https://radim.rs/jobs/two">Подробнее и откликнуться</a>'),
            post('radim_serbia', 15, '<b>QA engineer</b><br/>📍 Белград<br/>Курс по поиску работы<br/>'
                 '<a href="https://radim.rs/courses/qa">Подробнее и откликнуться</a>'),
        ])
        jobs, status = collect_telegram(source, FakeFetcher({source.listing_url: listing}))
        self.assertEqual(status['state'], 'ok')
        self.assertEqual(status['count'], 1)
        job = jobs[0]
        self.assertEqual(job.url, 'https://t.me/radim_serbia/12')
        self.assertEqual(job.company, 'Example')
        self.assertEqual(job.location, 'Белград')
        self.assertEqual(job.published_at, '2026-10-14T12:00:00+00:00')
        self.assertIn('https://radim.rs/jobs/qa-engineer', job.description)
        self.assertEqual(job.salary_display, 'от 1 000 EUR')

    def test_radim_variant_without_pin_keeps_company_and_remote_fact(self):
        source = SOURCES['tg_radim_serbia']
        listing = preview('radim_serbia', [
            post('radim_serbia', 16, '<b>Partnership manager</b><br/>Fotool LTD · Удалённо<br/>💰 фриланс<br/>'
                 '<a href="https://radim.rs/jobs/partnership-manager">Подробнее и откликнуться</a>')
        ])
        jobs, status = collect_telegram(source, FakeFetcher({source.listing_url: listing}))
        self.assertEqual(status['count'], 1)
        self.assertEqual(jobs[0].company, 'Fotool LTD')
        self.assertEqual(jobs[0].location, 'Удалённо')
        self.assertTrue(jobs[0].remote)

    def test_ovde_template_strips_promotional_footer_and_follows_one_older_page(self):
        source = SOURCES['tg_rabotavserbii']
        first = preview('rabotavserbii', [
            post('rabotavserbii', 20, '<b>Пекарь</b><br/>Company<br/>📍 Belgrade | Serbia<br/>💰 500 RSD / час<br/>'
                 '<a href="https://ovdejobs.com/?p=123&amp;utm_source=tg">🔗 УЗНАТЬ ПОДРОБНЕЕ И ОТКЛИКНУТЬСЯ</a><br/>__<br/>'
                 '🚀 Ищете сотрудников? Разместите вакансию здесь - первая бесплатно!'),
            post('rabotavserbii', 21, '<b>Как найти работу</b><br/>Интенсив и реклама'),
        ], before=10)
        older = preview('rabotavserbii', [
            post('rabotavserbii', 9, '<b>Бариста</b><br/>Cafe<br/>📍 Novi Sad<br/>'
                 '<a href="https://ovdejobs.com/?p=124">УЗНАТЬ ПОДРОБНЕЕ И ОТКЛИКНУТЬСЯ</a>')
        ])
        fetcher = FakeFetcher({source.listing_url: first,
                               'https://t.me/s/rabotavserbii?before=10': older})
        jobs, status = collect_telegram(source, fetcher)
        self.assertEqual(status['count'], 2)
        self.assertEqual(status['listing_pages'], 2)
        self.assertIn('https://t.me/rabotavserbii/20', {job.url for job in jobs})
        baker = next(job for job in jobs if job.title == 'Пекарь')
        self.assertNotIn('Ищете сотрудников', baker.description)
        self.assertIn('https://ovdejobs.com/?p=123', baker.description)
        self.assertIsNone(baker.salary_min)
        self.assertEqual(baker.salary_period, 'hour')

    def test_tampered_next_preview_url_is_not_requested(self):
        source = SOURCES['tg_radim_serbia']
        html = preview('radim_serbia', [
            post('radim_serbia', 4, '<b>Вакансия</b><br/>📍 Белград<br/>'
                 '<a href="https://radim.rs/jobs/test">Подробнее и откликнуться</a>')
        ]) + '<a class="tme_messages_more" href="https://t.me/s/other?before=3">more</a>'
        fetcher = FakeFetcher({source.listing_url: html})
        jobs, status = collect_telegram(source, fetcher)
        self.assertEqual(status['count'], 1)
        self.assertEqual(fetcher.calls, [source.listing_url])


class LocationLinkTests(unittest.TestCase):
    def test_city_gets_a_serbia_google_maps_search_link(self):
        job = {'location': 'Белград', 'country': 'RS'}
        url = job_map_url(job)
        self.assertEqual(urlsplit(url).hostname, 'www.google.com')
        self.assertEqual(parse_qs(urlsplit(url).query)['query'], ['Белград, Serbia'])
        text = job_text(dict(job, title='Повар'))
        self.assertIn('href="https://www.google.com/maps/search/?api=1&amp;query=', text)
        self.assertIn('>Белград</a>', text)

    def test_explicit_map_is_kept_and_pure_remote_location_has_no_map(self):
        explicit = 'https://www.google.com/maps/place/Test/@44.8,20.4,12z'
        self.assertEqual(job_map_url({'location': 'Удалённо', 'description': explicit}), explicit)
        self.assertEqual(job_map_url({'location': 'Удалённо'}), '')
        self.assertNotIn('maps/search', job_text({'title': 'Support', 'location': 'Удалённо', 'remote': True}))

    def test_structured_street_address_is_preserved_for_the_map(self):
        html = '''<script type="application/ld+json">{"@type":"JobPosting","title":"Cook","url":"https://radim.rs/jobs/cook","description":"Work","jobLocation":{"address":{"streetAddress":"Knez Mihailova 1","addressLocality":"Beograd","addressCountry":"RS"}}}</script>'''
        job = extract_jobs(SOURCES['radim'], html, 'https://radim.rs/jobs/cook')[0]
        self.assertEqual(job.location, 'Knez Mihailova 1, Beograd')
        self.assertIn('Knez+Mihailova+1%2C+Beograd%2C+Serbia', job_map_url(job.__dict__))
