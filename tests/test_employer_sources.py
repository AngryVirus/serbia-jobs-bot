import copy
import json
import unittest
from urllib.parse import urlsplit

from employer_sources import API_ROOT, collect_employer
from sources import FetchError, MAX_BYTES, Source
from test_sources import FakeFetcher


def source(board='wolt'):
    host = {'wolt': 'job-boards.greenhouse.io', 'jetbrains': 'job-boards.eu.greenhouse.io',
            'nordeus': 'www.nordeus.com', 'epicgames': 'epicgames.com'}[board]
    return Source('gh_' + board, board, 'https://' + host + '/',
                  API_ROOT + board + '/jobs', (), api_hosts=('boards-api.greenhouse.io',))


def listing(board='wolt', identity=1, location='Belgrade, Serbia', **extra):
    urls = {'wolt': f'https://job-boards.greenhouse.io/wolt/jobs/{identity}',
            'jetbrains': f'https://job-boards.eu.greenhouse.io/jetbrains/jobs/{identity}',
            'nordeus': f'http://www.nordeus.com/careers?gh_jid={identity}',
            'epicgames': f'https://epicgames.com/careers/jobs/{identity}?gh_jid={identity}'}
    return {'id': identity, 'title': 'Support Specialist', 'location': {'name': location},
            'absolute_url': urls[board], 'first_published': '2026-01-02T12:00:00Z', **extra}


def routes(board='wolt', items=None):
    items = items if items is not None else [listing(board)]
    base = API_ROOT + board + '/jobs'
    result = {base: json.dumps({'jobs': items})}
    for item in items:
        if isinstance(item, dict) and type(item.get('id')) is int:
            result[base + '/' + str(item['id'])] = json.dumps({**item,
                'content': '&lt;p&gt;English required. Full-time role.&lt;/p&gt;',
                'updated_at': '2026-10-01T00:00:00Z',
                'data_compliance': {'private_field': 'not retained'},
                'metadata': [{'name': 'Hiring Manager', 'value': 'not retained'}]})
    return result


class EmployerSourceTests(unittest.TestCase):
    def test_compact_lists_details_only_serbia_and_keep_public_facts(self):
        items = [listing(identity=1, location='Remote; Serbia'),
                 listing(identity=2, location='Helsinki, Finland'),
                 listing(identity=3, location='Remote - Worldwide')]
        fetcher = FakeFetcher(routes(items=items))
        jobs, status = collect_employer(source(), fetcher, crawl_state={})
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(job.country, 'RS')
        self.assertEqual(job.eligible_countries, ['RS'])
        self.assertEqual(job.company, 'Wolt')
        self.assertTrue(job.remote)
        self.assertIn('English required.', job.description)
        self.assertNotIn('<p>', job.description)
        self.assertNotIn('not retained', json.dumps(job.__dict__))
        self.assertEqual(job.published_at, '2026-01-02T12:00:00Z')
        self.assertEqual(status['discovered'], 3)
        self.assertEqual(status['eligible'], 1)
        self.assertEqual(status['rejected'], {'not_serbia': 2})
        self.assertEqual(len(fetcher.calls), 2)
        self.assertTrue(all('content=true' not in url for url in fetcher.calls))

    def test_mixed_locations_and_cities_without_country(self):
        cases = [('jetbrains', 'Amsterdam, Netherlands; Belgrade, Serbia; Remote, Germany'),
                 ('nordeus', 'Belgrade'), ('epicgames', 'Novi Sad,Vojvodina,Serbia')]
        for board, location in cases:
            with self.subTest(board=board):
                fetcher = FakeFetcher(routes(board, [listing(board, location=location)]))
                jobs, _ = collect_employer(source(board), fetcher)
                self.assertEqual(len(jobs), 1)
                self.assertEqual(jobs[0].country, 'RS')
                self.assertEqual(jobs[0].location, location)
                if board == 'jetbrains':
                    self.assertTrue(jobs[0].url.startswith('https://job-boards.eu.greenhouse.io/'))
                    self.assertIsNot(jobs[0].remote, True)
                elif board == 'nordeus':
                    self.assertEqual(jobs[0].url, 'https://www.nordeus.com/careers?gh_jid=1')
                else:
                    self.assertEqual(jobs[0].url, 'https://epicgames.com/careers/jobs/1')

    def test_foreign_belgrade_global_remote_and_description_mentions_are_not_admitted(self):
        locations = ['Belgrade, Montana, United States', 'Berlin, Germany', 'Worldwide',
                     'Remote', '', 'EMEA']
        items = [listing(identity=i + 1, location=location) for i, location in enumerate(locations)]
        for item in items:
            item['content'] = 'Our company has offices in Belgrade, Serbia.'
            item['offices'] = [{'name': 'Belgrade, Serbia'}] if item['location']['name'] else []
        fetcher = FakeFetcher(routes(items=items))
        jobs, status = collect_employer(source(), fetcher)
        self.assertEqual(jobs, [])
        self.assertEqual(status['eligible'], 0)
        self.assertEqual(len(fetcher.calls), 1)

    def test_explicit_job_location_metadata_and_absent_location_office(self):
        cases = [listing(location='Remote', metadata=[{'name': 'Job Location', 'value': 'Serbia - Home Office'}]),
                 listing(location='', offices=[{'name': 'Ruma'}])]
        for item in cases:
            fetcher = FakeFetcher(routes(items=[item]))
            detail = json.loads(fetcher.routes[API_ROOT + 'wolt/jobs/1'])
            detail['metadata'] = item.get('metadata')
            fetcher.routes[API_ROOT + 'wolt/jobs/1'] = json.dumps(detail)
            jobs, _ = collect_employer(source(), fetcher)
            self.assertEqual(len(jobs), 1)

    def test_only_verified_public_url_routes_with_matching_identity_are_allowed(self):
        invalid = ['https://evil.example/wolt/jobs/1', 'https://job-boards.greenhouse.io/other/jobs/1',
                   'https://job-boards.greenhouse.io/wolt/jobs/999',
                   'https://boards-api.greenhouse.io/v1/boards/wolt/jobs/1',
                   'https://job-boards.greenhouse.io/wolt/jobs/1/apply',
                   'https://user:pass@job-boards.greenhouse.io/wolt/jobs/1',  # pragma: allowlist secret
                   'https://job-boards.greenhouse.io:444/wolt/jobs/1',
                   'https://job-boards.greenhouse.io/wolt/jobs/1\\evil', 'not a URL']
        for url in invalid:
            with self.subTest(url=url):
                fetcher = FakeFetcher(routes(items=[listing(absolute_url=url)]))
                jobs, status = collect_employer(source(), fetcher)
                self.assertEqual(jobs, [])
                self.assertEqual(status['inspected'], 0)
        for url in ['https://www.nordeus.com/careers?gh_jid=999',
                    'https://www.nordeus.com/?gh_jid=1',
                    'https://www.nordeus.com/careers?gh_jid=1&token=unexpected']:
            fetcher = FakeFetcher(routes('nordeus', [listing('nordeus', absolute_url=url)]))
            self.assertEqual(collect_employer(source('nordeus'), fetcher)[0], [])

    def test_detail_cannot_change_id_country_or_canonical_url(self):
        for overrides in ({'id': 2}, {'location': {'name': 'Berlin, Germany'}},
                          {'absolute_url': 'https://evil.example/offer/1'}):
            fetcher = FakeFetcher(routes())
            url = API_ROOT + 'wolt/jobs/1'
            node = json.loads(fetcher.routes[url])
            node.update(overrides)
            fetcher.routes[url] = json.dumps(node)
            jobs, status = collect_employer(source(), fetcher, crawl_state={})
            self.assertEqual(jobs, [])
            self.assertEqual(status['inspected'], 1)

    def test_updated_at_is_never_used_as_publication_date(self):
        item = listing(first_published=None)
        fetcher = FakeFetcher(routes(items=[item]))
        jobs, _ = collect_employer(source(), fetcher)
        self.assertIsNone(jobs[0].published_at)

    def test_expiry_is_preserved_for_existing_only_upsert(self):
        item = listing(application_deadline='2001-01-01')
        self.assertEqual(collect_employer(source(), FakeFetcher(routes(items=[item])))[0], [])
        jobs, _ = collect_employer(source(), FakeFetcher(routes(items=[item])), include_expired=True)
        self.assertEqual([job.expires_at for job in jobs], ['2001-01-01'])

    def test_queue_progresses_after_restart_and_does_not_repeat_details_within_day(self):
        data = routes(items=[listing(identity=i) for i in range(1, 4)])
        checkpoint = {}
        inspected = []
        for _ in range(4):
            fetcher = FakeFetcher(data)
            jobs, status = collect_employer(source(), fetcher, detail_limit=1, crawl_state=checkpoint)
            inspected.extend(job.url for job in jobs)
            checkpoint = status['crawl_state']
            self.assertLessEqual(len(fetcher.calls), 2)
        self.assertEqual(len(set(inspected)), 3)
        self.assertEqual(len(inspected), 3)
        self.assertEqual(status['inspected'], 0)
        self.assertEqual(status['skipped_known'], 3)
        self.assertEqual(status['state'], 'ok')
        self.assertEqual(status['backlog'], 0)
        self.assertFalse(status['truncated'])
        self.assertEqual(checkpoint['pending'], [])
        self.assertNotIn('Support', json.dumps(checkpoint))

    def test_recheck_after_24_hours_and_new_jobs_priority(self):
        data = routes(items=[listing(identity=i) for i in (1, 2)])
        _, first = collect_employer(source(), FakeFetcher(data), detail_limit=1, crawl_state={})
        data = routes(items=[listing(identity=i) for i in (1, 2, 3)])
        jobs, second = collect_employer(source(), FakeFetcher(data), detail_limit=1, crawl_state=first['crawl_state'])
        self.assertTrue(jobs[0].url.endswith('/3'))
        checkpoint = copy.deepcopy(second['crawl_state'])
        checkpoint['seen'] = {key: value - 86401 for key, value in checkpoint['seen'].items()}
        _, status = collect_employer(source(), FakeFetcher(data), detail_limit=8, crawl_state=checkpoint)
        self.assertEqual(status['inspected'], 3)

    def test_failed_detail_stays_pending_and_private_errors_are_not_logged(self):
        data = routes()
        data[API_ROOT + 'wolt/jobs/1'] = FetchError('blocked', 'HTTP 429; доступ ограничен.')
        _, status = collect_employer(source(), FakeFetcher(data), crawl_state={})
        self.assertEqual(status['state'], 'blocked')
        self.assertFalse(status['healthy'])
        self.assertEqual(status['crawl_state']['pending'], [API_ROOT + 'wolt/jobs/1'])
        jobs, _ = collect_employer(source(), FakeFetcher(routes()), crawl_state=status['crawl_state'])
        self.assertEqual(len(jobs), 1)

    def test_one_broken_detail_does_not_starve_other_queued_jobs(self):
        data = routes(items=[listing(identity=1), listing(identity=2)])
        data[API_ROOT + 'wolt/jobs/1'] = FetchError('error', 'HTTP 500')
        jobs, first = collect_employer(source(), FakeFetcher(data), detail_limit=1)
        self.assertEqual(jobs, [])
        self.assertEqual(first['state'], 'error')
        self.assertEqual(first['crawl_state']['pending'], [API_ROOT + 'wolt/jobs/2', API_ROOT + 'wolt/jobs/1'])
        jobs, second = collect_employer(source(), FakeFetcher(data), detail_limit=1, crawl_state=first['crawl_state'])
        self.assertEqual([job.url for job in jobs], ['https://job-boards.greenhouse.io/wolt/jobs/2'])
        self.assertEqual(second['backlog'], 1)
        self.assertTrue(second['truncated'])
        self.assertEqual(second['state'], 'partial')
        self.assertTrue(second['healthy'])

    def test_initial_http_failure_is_not_a_healthy_empty_board(self):
        jobs, status = collect_employer(source(), FakeFetcher({API_ROOT + 'wolt/jobs': FetchError('error', 'HTTP 500')}))
        self.assertEqual(jobs, [])
        self.assertEqual(status['listing_pages'], 0)
        self.assertFalse(status['healthy'])

    def test_untrusted_checkpoint_cannot_fetch_other_employers_or_hosts(self):
        raw = {'version': 1, 'pending': [API_ROOT + 'jetbrains/jobs/1',
               API_ROOT + 'wolt/jobs/999', 'https://evil.example/jobs/1'],
               'cursor': 'https://evil.example/list', 'seen': {}}
        fetcher = FakeFetcher(routes())
        _, status = collect_employer(source(), fetcher, crawl_state=raw)
        self.assertEqual(fetcher.calls, [API_ROOT + 'wolt/jobs', API_ROOT + 'wolt/jobs/1'])
        self.assertIsNone(status['crawl_state']['cursor'])

    def test_response_budgets_malformed_json_and_item_types(self):
        for body in ('x' * (MAX_BYTES + 1), '{broken', '[]', '{}'):
            _, status = collect_employer(source(), FakeFetcher({API_ROOT + 'wolt/jobs': body}))
            self.assertEqual(status['state'], 'error')
            self.assertEqual(status['inspected'], 0)
            self.assertLess(len(status['detail']), 500)
        items = [None, [], {'id': True}, {'id': -1}, listing(), listing()]
        jobs, status = collect_employer(source(), FakeFetcher(routes(items=items)))
        self.assertEqual(len(jobs), 1)
        self.assertEqual(status['discovered'], 1)
        data = routes()
        data[API_ROOT + 'wolt/jobs/1'] = 'x' * (MAX_BYTES + 1)
        _, status = collect_employer(source(), FakeFetcher(data), crawl_state={})
        self.assertEqual(status['state'], 'error')
        self.assertEqual(status['deferred'], 1)

    def test_large_eligible_catalog_is_bounded_without_fetching_full_content(self):
        data = routes(items=[listing(identity=i) for i in range(1, 81)])
        fetcher = FakeFetcher(data)
        jobs, status = collect_employer(source(), fetcher, detail_limit=8, crawl_state={})
        self.assertEqual(len(jobs), 8)
        self.assertEqual(len(fetcher.calls), 9)
        self.assertEqual(status['deferred'], 40)
        self.assertEqual(status['backlog'], 40)
        self.assertEqual(status['state'], 'partial')
        self.assertTrue(status['truncated'])
        self.assertTrue(status['healthy'])
        self.assertTrue(status['queue_overflow'])
        self.assertLess(len(json.dumps(status['crawl_state']).encode()), 90 * 1024)
        self.assertTrue(all(urlsplit(url).hostname == 'boards-api.greenhouse.io' for url in fetcher.calls))
        # Overflow must postpone the tail of a real board, never lose it or
        # repeatedly spend the bounded detail budget on its first eight jobs.
        accepted = [job.url for job in jobs]
        for _ in range(10):
            jobs, status = collect_employer(source(), FakeFetcher(data), detail_limit=8, crawl_state=status['crawl_state'])
            accepted.extend(job.url for job in jobs)
        self.assertEqual(len(accepted), 80)
        self.assertEqual(len(set(accepted)), 80)
        self.assertEqual(status['backlog'], 0)
        self.assertFalse(status['truncated'])
