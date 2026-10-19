"""Regressions from reviewed public Serbia channel templates and crawl gaps."""
from datetime import datetime, timedelta, timezone
from html import escape
import unittest
from unittest.mock import patch

from filters import active
from serbian_geography import has_serbian_location, serbian_cities
from source_policy import ACTIVE_TELEGRAM, source_enabled, validate_channel_page
from sources import SOURCES, Fetcher, FetchError, collect_source
from telegram_sources import hiring_post, post_job, public_link
from telegram_post_quality import post_exclusion, without_editorial_posts
from test_sources import FakeFetcher


NOW = datetime.now(timezone.utc)
DATE = (NOW - timedelta(days=1)).isoformat()


def preview(source, numbers, *, text=None, date=DATE, before=None):
    channel = source.telegram_channel
    bodies = []
    for number in numbers:
        body = text or ('Требуется инженер\n📍 Beograd\nОбязанности: поддержка оборудования.\n'
                        'Требования: опыт работы.')
        body = escape(body).replace('\n', '<br/>')
        if source.id == 'tg_radim_serbia':
            body += '<br/><a href="https://radim.rs/jobs/engineer">Подробнее и откликнуться</a>'
        bodies.append(f'<div class="tgme_widget_message" data-post="{channel}/{number}">'
                      f'<div class="tgme_widget_message_text">{body}</div>'
                      f'<time datetime="{date}">Today</time></div>')
    older = f'<a class="tme_messages_more" href="/s/{channel}?before={before}">Older</a>' if before else ''
    return '<meta property="og:title" content="Работа в Сербии">' + ''.join(bodies) + older


class TelegramExpansionTests(unittest.TestCase):
    source = SOURCES['telegram_youritjob']

    def test_six_observed_role_templates_do_not_need_the_word_vacancy(self):
        # Reduced public examples reviewed on 2026-10-18, posts 8516, 8520,
        # 8525, 8526, 8528, 8530. Preserve the actual role/location/section labels.
        examples = [
            ('Legal Counsel / Licensing', 'Белград, Сербия', 'Что предстоит делать:', 'Что важно:'),
            ('System support (AnyKey)', 'Формат работы - офис Белград', 'Основные задачи:', 'Требования:'),
            ('Senior Project Manager (AI Hackathon Event)', 'NTT DATA Europe & Latam, Serbia', 'Responsibilities:', 'Requirements:'),
            ('Senior Product Analyst (Matchmaking)', 'Social Discovery Group, Serbia or remote', 'Responsibilities:', 'Requirements:'),
            ('Software Architect - Graphic Controller', 'NTT DATA Europe & Latam, Serbia', 'Responsibilities:', 'Requirements:'),
            ('Customer Success Analyst II', 'NCR Atleos, Belgrade', 'Responsibilities:', 'Requirements:'),
        ]
        for number, (role, place, duties, requirements) in enumerate(examples, 1):
            text = '\n'.join([role, place, duties, 'Product and customer operations.', requirements, 'Relevant experience.'])
            with self.subTest(role=role):
                self.assertTrue(hiring_post(text))
                job = post_job(self.source, {'id': number, 'text': text, 'date': DATE})
                self.assertIsNotNone(job)
                self.assertEqual(job.title, role)
                self.assertEqual(job.published_at, DATE)
                self.assertIsNone(job.expires_at)

    def test_role_alone_or_editorial_article_is_not_a_vacancy(self):
        for text in [
            'Software Architect\nSerbia\nRequirements: experience.',
            'Customer Success Analyst\nBelgrade\nResponsibilities: support clients.',
            '🇷🇸 В Сербии хватает вакансий, не хватает квалифицированных работников\n'
            'Безработица снижается. Пишет Национальная служба занятости.',
            '404 Страница не найдена\nВакансии в Сербии',
            'Как найти работу в Сербии\nТребования работодателей и обязанности инженера.',
            'Ищу работу инженером в Руме. Резюме.',
            'Предлагаю услуги электрика в Руме.',
        ]:
            with self.subTest(text=text):
                self.assertFalse(hiring_post(text))

    def test_guide_companion_channel_is_enabled_without_weakening_location_rules(self):
        source = SOURCES['telegram_rabotavbelgrade1']
        self.assertTrue(source_enabled(source.id))
        self.assertEqual(source.telegram_channel, 'rabotavbelgrade1')
        html = preview(source, [2919], text='В службу доставки еды требуется су-шеф.\nБелград, Аутокоманда.\nОпыт работы обязателен.')
        jobs, status = collect_source(source, fetcher=FakeFetcher({source.listing_url: html}), crawl_state={}, page_limit=1)
        self.assertEqual(status['state'], 'ok')
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].url, 'https://t.me/rabotavbelgrade1/2919')
        self.assertIsNone(post_job(source, {'id': 1, 'text': 'Требуется повар, условия по договорённости.', 'date': DATE}))
        self.assertIsNone(post_job(source, {'id': 2, 'text': 'Hiring cook\nLocation: Germany\nCompany office: Serbia', 'date': DATE}))

    def test_guide_interviews_and_multi_job_digests_are_not_single_vacancies(self):
        # Reduced from srbijabiz/1594 (roundup) and /1610 (editorial interview).
        for text in [
            'ℹ️ Вакансии\nБармен, Нови Сад — ссылка.\nПовар, Белград — ссылка.',
            '🍽 Интервью с владельцами кафе о бизнесе в Сербии\nРаньше мы разместили вакансию повара.',
            'Interview with a restaurant owner in Belgrade\nWe were hiring a cook in the summer.',
        ]:
            with self.subTest(text=text):
                self.assertIn(post_exclusion(text), {'editorial', 'digest'})
                html = preview(self.source, [1], text=text)
                jobs, status = collect_source(self.source, fetcher=FakeFetcher({self.source.listing_url: html}), crawl_state={}, page_limit=1)
                self.assertEqual(jobs, [])
                self.assertEqual(status['state'], 'empty')
        text = 'Вакансия: бармен\nБелград.\nНа интервью обсудим график и оплату.'
        self.assertIsNone(post_exclusion(text))
        self.assertTrue(hiring_post(text))

    def test_editorial_gate_preserves_partial_errors_and_crawl_checkpoint(self):
        job = post_job(self.source, {'id': 1, 'text': 'ℹ️ Вакансии\nБармен, Нови Сад — ссылка.\nПовар, Белград — ссылка.', 'date': DATE})
        self.assertIsNotNone(job)
        status = {'state': 'partial', 'healthy': False, 'count': 1, 'parsed_count': 1,
                  'rejected': {'outdated': 2}, 'crawl_state': {'cursor': 'saved'},
                  'errors': ['timeout'], 'withdrawn_urls': ['closed'], 'inspected': 4}
        jobs, result = without_editorial_posts([job], status)
        self.assertEqual(jobs, [])
        self.assertEqual(result, {**status, 'count': 0, 'parsed_count': 0,
                                 'rejected': {'outdated': 2, 'digest': 1}})
        self.assertEqual(status['rejected'], {'outdated': 2})

    def test_localities_include_smaller_cities_without_substring_false_positives(self):
        examples = {'Требуется повар в Руме': 'Ruma', 'Radnik, Ruma': 'Ruma',
                    'Posao u Pančevu': 'Pancevo', 'Производство, Рача': 'Raca',
                    'Нови-Сад': 'Novi Sad', 'Сремска Митровица': 'Sremska Mitrovica',
                    'Posao u Inđiji': 'Indjija', 'Инженер, Гроцка': 'Grocka',
                    'Location: nis': 'Nis', 'Инженер в Нише': 'Nis'}
        for text, city in examples.items():
            with self.subTest(text=text):
                self.assertIn(city, serbian_cities(text))
                self.assertTrue(has_serbian_location(text))
        for text in ['Ниша рынка B2B, remote worldwide', 'Разработчик нового борта',
                     'Bruma, Germany', 'Romania', 'Worldwide, remote', 'Service in Siberia']:
            with self.subTest(text=text):
                self.assertFalse(has_serbian_location(text))
        job = post_job(self.source, {'id': 10, 'text': 'Требуется повар в Руме', 'date': DATE})
        self.assertEqual(job.location, 'Ruma')

    def test_reviewed_channels_enabled_but_titles_and_each_post_stay_serbian(self):
        for channel in ['serbiawork', 'serbia_vacancies', 'serbiarabotavacancies']:
            key = 'telegram_' + channel
            self.assertIn(key, ACTIVE_TELEGRAM)
            self.assertTrue(source_enabled(key))
            self.assertEqual(SOURCES[key].telegram_channel, channel)
        self.assertFalse(source_enabled('telegram_python_jobs'))
        with self.assertRaises(FetchError):
            validate_channel_page('<meta property="og:title" content="Worldwide jobs">')
        for text in ['Hiring engineer, remote worldwide',
                     'Hiring engineer\nSerbia office exists\nLocation: Germany',
                     'Hiring engineer remotely\nРабота в Сербии · наш Telegram канал']:
            with self.subTest(text=text):
                self.assertIsNone(post_job(self.source, {'id': 10, 'text': text, 'date': DATE}))

    def test_raci_business_acronym_does_not_supply_a_serbian_city(self):
        duties = 'Establish project governance, RACI, reporting cadence, decision mechanisms, and escalation paths;'
        # Reduced public youritjob/8525: Serbia is stated, but no city is given.
        text = ('Senior Project Manager (AI Hackathon Event)\n'
                'NTT DATA Europe & Latam, Serbia\nResponsibilities:\n' + duties +
                '\nRequirements:\nRelevant experience.')
        self.assertEqual(serbian_cities(text), [])
        job = post_job(self.source, {'id': 8525, 'text': text, 'date': DATE})
        self.assertIsNotNone(job)
        self.assertEqual(job.location, 'Serbia')
        for business_text in [duties, 'Experience with RACI matrices.', 'Define the raci matrix.',
                              'Iskustvo u RACI matrici.', 'Rad u RACI modelu.']:
            with self.subTest(text=business_text):
                text = 'Hiring engineer\n' + business_text
                self.assertFalse(has_serbian_location(text))
                self.assertIsNone(post_job(self.source, {'id': 10, 'text': text, 'date': DATE}))

    def test_raca_and_raci_location_spellings_remain_supported(self):
        for place in ['Rača', 'Rači', 'RAČI', 'Raca', 'Рача', 'Раче', 'Рачи',
                      'u Raci', 'u raci', 'Location: Raci', 'Lokacija — RACI', '📍 Raci',
                      'RACI governance; lokacija: Rača']:
            with self.subTest(place=place):
                text = 'Tražimo radnika\n' + place
                self.assertEqual(serbian_cities(text), ['Raca'])
                job = post_job(self.source, {'id': 10, 'text': text, 'date': DATE})
                self.assertIsNotNone(job)
                self.assertEqual(job.location, 'Raca')

    def test_labelled_public_links_keep_original_application_for_deduplication(self):
        from telegram_sources import ChannelPage
        html = preview(self.source, [12], text='Требуется инженер в Сербии')
        html = html.replace('Требуется инженер в Сербии', 'Требуется инженер в Сербии<br/>'
            '<a href="https://radim.rs/jobs/engineer?utm_source=tg">Откликнуться</a><br/>'
            '<a href="https://t.me/example_contact">Связаться</a>')
        page = ChannelPage(self.source.telegram_channel)
        page.feed(html)
        job = post_job(self.source, page.posts[0])
        self.assertEqual(job.url, 'https://t.me/youritjob/12')
        self.assertIn('Откликнуться', job.description)
        self.assertIn('https://radim.rs/jobs/engineer', job.description)
        self.assertNotIn('utm_source', job.description)
        self.assertIn('https://t.me/example_contact', job.description)
        self.assertEqual(page.posts[0]['links'][0], 'https://radim.rs/jobs/engineer')
        for invalid in ['javascript:alert(1)', 'http://example.org/', 'https://user:pass@example.org/', 'https://example.org:22/']:
            self.assertEqual(public_link(invalid), '')

    def test_ninety_days_is_a_traversal_bound_not_a_fabricated_expiry(self):
        recent = (NOW - timedelta(days=60)).isoformat()
        old = (NOW - timedelta(days=91)).isoformat()
        for key in ['telegram_youritjob', 'tg_radim_serbia']:
            source = SOURCES[key]
            with self.subTest(source=key):
                jobs, status = collect_source(source, fetcher=FakeFetcher({source.listing_url:
                    preview(source, [10], date=recent)}), crawl_state={}, page_limit=1)
                self.assertEqual(len(jobs), 1)
                self.assertIsNone(jobs[0].expires_at)
                self.assertTrue(active(jobs[0].__dict__, NOW + timedelta(days=60)))
                for include_expired in (False, True):
                    jobs, status = collect_source(source, fetcher=FakeFetcher({source.listing_url:
                        preview(source, [10], date=old, before=10)}), crawl_state={},
                        include_expired=include_expired, page_limit=1)
                    self.assertEqual(jobs, [])
                    self.assertIsNone(status['crawl_state']['cursor'])
                    self.assertEqual(status['rejected'].get('outdated'), 1)
                stale_checkpoint = {'version': 1, 'seen': {},
                    'cursor': source.listing_url + '?before=8',
                    'pending': [source.listing_url + '?before=7']}
                fetcher = FakeFetcher({source.listing_url: preview(source, [10], date=old,
                    text='Вакансия закрыта: инженер в Белграде', before=10)})
                jobs, status = collect_source(source, fetcher=fetcher, crawl_state=stale_checkpoint,
                    include_expired=True, page_limit=2)
                self.assertEqual(jobs, [])
                self.assertEqual(fetcher.calls, [source.listing_url])
                self.assertEqual(status['withdrawn_urls'], ['https://t.me/' + source.telegram_channel + '/10'])
                self.assertIsNone(status['crawl_state']['cursor'])
                self.assertEqual(status['crawl_state']['pending'], [])


class TelegramCheckpointTests(unittest.TestCase):
    def test_restart_resumes_history_and_always_reparses_head_for_edited_closure(self):
        for key in ['telegram_youritjob', 'tg_radim_serbia']:
            source = SOURCES[key]
            head = source.listing_url
            routes = {head: preview(source, [100, 99], before=99),
                      head + '?before=99': preview(source, [98, 97], before=97),
                      head + '?before=97': preview(source, [96], before=96)}
            with self.subTest(source=key):
                _, first = collect_source(source, fetcher=FakeFetcher(routes), crawl_state={}, page_limit=2)
                self.assertEqual(first['crawl_state']['cursor'], head + '?before=97')
                routes[head] = preview(source, [100, 99], text='Вакансия закрыта: инженер в Белграде', before=99)
                fetcher = FakeFetcher(routes)
                jobs, second = collect_source(source, fetcher=fetcher, crawl_state=first['crawl_state'], page_limit=2)
                self.assertEqual(fetcher.calls, [head, head + '?before=97'])
                self.assertEqual([job.url for job in jobs], ['https://t.me/' + source.telegram_channel + '/96'])
                self.assertEqual(set(second['withdrawn_urls']), {
                    'https://t.me/' + source.telegram_channel + '/100',
                    'https://t.me/' + source.telegram_channel + '/99'})

    def test_new_head_gap_is_filled_before_saved_older_cursor(self):
        source = SOURCES['telegram_youritjob']
        head = source.listing_url
        routes = {head: preview(source, [100, 99], before=99),
                  head + '?before=99': preview(source, [98, 97], before=97)}
        _, first = collect_source(source, fetcher=FakeFetcher(routes), crawl_state={}, page_limit=2)
        routes[head] = preview(source, [110, 109], before=109)
        routes[head + '?before=109'] = preview(source, [108, 100], before=100)
        _, gap = collect_source(source, fetcher=FakeFetcher(routes), crawl_state=first['crawl_state'], page_limit=2)
        self.assertEqual(gap['crawl_state']['cursor'], head + '?before=97')
        self.assertEqual(gap['crawl_state']['pending'], [])
        self.assertEqual(gap['skipped_known'], 1)

    def test_failed_history_page_keeps_cursor_and_untrusted_cursor_is_not_requested(self):
        source = SOURCES['telegram_youritjob']
        head = source.listing_url
        routes = {head: preview(source, [100], before=100),
                  head + '?before=100': FetchError('timeout', 'budget')}
        jobs, first = collect_source(source, fetcher=FakeFetcher(routes), crawl_state={}, page_limit=2)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(first['state'], 'partial')
        self.assertEqual(first['crawl_state']['cursor'], head + '?before=100')
        for invalid in ['https://t.me/s/other?before=1', head + '?before=-1',
                        head + '?before=1&other=2', 'https://user:pass@t.me/s/youritjob?before=1']:  # pragma: allowlist secret
            raw = {'version': 1, 'cursor': invalid, 'pending': [invalid], 'seen': {}}
            fetcher = FakeFetcher(routes)
            collect_source(source, fetcher=fetcher, crawl_state=raw, page_limit=1)
            self.assertEqual(fetcher.calls, [head])

    def test_all_channel_fetchers_share_host_pacing(self):
        clock = [1000.0]
        def sleep(seconds):
            clock[0] += seconds
        first = Fetcher(SOURCES['telegram_youritjob'], delay=1.5)
        second = Fetcher(SOURCES['telegram_serbiawork'], delay=1.5)
        first.deadline = second.deadline = 2000
        with patch('sources._TELEGRAM_LAST_REQUEST', -1e9), \
                patch('sources.time.monotonic', side_effect=lambda: clock[0]), \
                patch('sources.time.sleep', side_effect=sleep) as wait:
            first._pace('https://t.me', 1.5)
            second._pace('https://t.me', 1.5)
            first._pace('https://t.me', 1.5)
        self.assertEqual(wait.call_count, 2)
        self.assertEqual(clock[0], 1003.0)
