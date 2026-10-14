from datetime import datetime, timedelta, timezone
from html import escape
import unittest

from sources import SOURCES, Fetcher, FetchError, collect_source, collect_all, is_detail_url
from telegram_sources import ChannelPage, hiring_post, post_job
from test_sources import FakeFetcher, Opener


SOURCE = SOURCES['telegram_serbia_jobs']
DATE = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()


def post(number, text, channel='serbia_jobs', date=DATE):
    return (f'<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="{channel}/{number}">'
            '<div class="tgme_widget_message_text js-message_text">' + escape(text).replace('\n', '<br/>') +
            f'</div><a class="tgme_widget_message_date"><time datetime="{date}">Today</time></a></div></div>')


class TelegramSourceTests(unittest.TestCase):
    def test_public_posts_keep_identity_text_dates_and_only_serbian_hiring(self):
        html = post(20, 'Вакансия\nPython developer\nBeograd\nEnglish required\nАдрес: Knez Mihailova 12\n1500 EUR / month')
        html += post(19, 'Ищу работу программистом в Сербии. Резюме.')
        html += post(18, 'Hiring developer\nLocation: Germany')
        html += post(17, 'Предлагаю услуги электрика в Белграде')
        html += post(16, 'Hiring developer in Serbia', channel='foreign_channel')
        parser = ChannelPage('serbia_jobs'); parser.feed(html)
        self.assertEqual(len(parser.posts), 4)
        jobs = [job for entry in parser.posts if (job := post_job(SOURCE, entry))]
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(job.url, 'https://t.me/serbia_jobs/20')
        self.assertEqual(job.title, 'Python developer')
        self.assertEqual(job.published_at, DATE)
        self.assertEqual(job.location, 'Beograd')
        self.assertEqual(job.salary_min, 1500)
        self.assertEqual(job.salary_display, '1500 EUR / month')
        self.assertIn('en', job.required_languages)
        self.assertIn('\nАдрес:', job.description)

    def test_hiring_is_distinct_from_cv_services_and_closed_vacancies(self):
        for text in ['Ищу работу в Сербии', 'Looking for a job in Serbia', 'Tražim posao u Srbiji',
                     'Предлагаю услуги: ремонт в Сербии', '#резюме Python developer Serbia',
                     'Вакансия закрыта: инженер в Сербии', 'Реклама курсов для работы в Сербии',
                     'Подписывайтесь на канал: вакансии в Сербии', '#ищуработу Вакансия разработчика Сербия']:
            with self.subTest(text=text): self.assertFalse(hiring_post(text))
        for text in ['Требуется повар в Белграде', 'Ищу сотрудника в Сербии',
                     'Tražimo konobara u Srbiji', 'We are hiring an engineer in Serbia']:
            with self.subTest(text=text): self.assertTrue(hiring_post(text))

    def test_unknown_location_missing_date_and_future_posts_are_excluded(self):
        for text, date in [('Hiring developer worldwide', DATE), ('Hiring in Serbia', None),
                           ('Hiring in Serbia', '2099-01-01'), ('Hiring in Serbia', 'not a date'),
                           ('Hiring developer. Serbia team. Location: Germany', DATE)]:
            with self.subTest(text=text, date=date):
                self.assertIsNone(post_job(SOURCE, {'id': 10, 'text': text, 'date': date}))

    def test_market_niche_and_multijob_digests_are_not_serbian_vacancies(self):
        for text in ['Вакансия: Product Manager\nПерспективная ниша рынка, удалённо',
                     'Вакансия: Product Manager\nОпыт в нише B2B SaaS',
                     'Вакансии на сегодня:\nPython developer Beograd\nQA Berlin',
                     'Вакансии Akvelon в Сербии и Польше:\n— Java Developer\n— Python Developer',
                     'Собрали подборки компаний в Сербии. Ещё больше вакансий',
                     '#top_vacancies_inGameJob\nQA Belgrade\nMore vacancies in Telegram',
                     '❤️ Они уже здесь\nMiddle Product Engineer, Сербия\nРазместить вакансию',
                     'Navigating the job market takes effort. Vacancies in Belgrade and Berlin.']:
            self.assertIsNone(post_job(SOURCE, {'id': 10, 'text': text, 'date': DATE}))
        for text in ['Вакансия: повар\nНиш', 'Hiring engineer in Niš', 'Hiring engineer. Location: nis']:
            self.assertEqual(post_job(SOURCE, {'id': 10, 'text': text, 'date': DATE}).location, 'Nis')

    def test_end_of_short_public_history_is_not_an_access_error(self):
        first = SOURCE.listing_url
        jobs, status = collect_source(SOURCE, fetcher=FakeFetcher({
            first: post(1, 'Ищу работу в Сербии'), first + '?before=1': '<html>No earlier posts</html>'}))
        self.assertEqual(jobs, [])
        self.assertEqual(status['state'], 'empty')

    def test_two_pages_deduplicate_and_follow_only_channel_history(self):
        first = SOURCE.listing_url
        routes = {first: post(30, 'Hiring developer in Serbia') + post(29, 'Требуется повар в Белграде'),
                  first + '?before=29': post(29, 'Требуется повар в Белграде') + post(28, 'Tražimo radnika u Srbiji')}
        fetcher = FakeFetcher(routes)
        jobs, status = collect_source(SOURCE, fetcher=fetcher)
        self.assertEqual(len(jobs), 3)
        self.assertEqual(fetcher.calls, list(routes))
        self.assertEqual(status['listing_pages'], 2)
        self.assertEqual(status['state'], 'ok')

    def test_partial_failure_retains_posts_and_private_channel_is_unavailable(self):
        first = SOURCE.listing_url
        jobs, status = collect_source(SOURCE, fetcher=FakeFetcher({
            first: post(30, 'Hiring developer in Serbia'),
            first + '?before=30': FetchError('blocked', 'HTTP 403')}))
        self.assertEqual(len(jobs), 1)
        self.assertEqual(status['state'], 'partial')
        jobs, status = collect_source(SOURCE, fetcher=FakeFetcher({first: '<html>Join Telegram</html>'}))
        self.assertEqual(jobs, [])
        self.assertEqual(status['state'], 'unsupported')

    def test_robots_and_channel_boundaries_are_enforced(self):
        fetcher = Fetcher(SOURCE, delay=0)
        fetcher.opener = Opener({'https://t.me/robots.txt': 'User-agent: *\nDisallow: /s/'})
        with self.assertRaises(FetchError) as error: fetcher.get(SOURCE.listing_url)
        self.assertEqual(error.exception.state, 'robots_disallowed')
        self.assertFalse(is_detail_url(SOURCE, 'https://t.me/another_channel/10'))
        with self.assertRaises(FetchError): fetcher.get('https://t.me/+privateinvite')

    def test_all_catalog_sources_are_default_and_callbacks_preserve_results(self):
        from unittest.mock import patch
        from channel_catalog import CHANNELS
        from store import SOURCE_IDS
        self.assertEqual(set(SOURCES), set(SOURCE_IDS))
        self.assertGreaterEqual(len(CHANNELS), 80)
        seen = []
        with patch('sources.collect_source', return_value=([], {'state': 'empty'})) as collect:
            _, statuses = collect_all(on_source=lambda key, jobs, status: seen.append(key))
        self.assertEqual(collect.call_count, len(SOURCES))
        self.assertEqual(set(seen), set(statuses))
