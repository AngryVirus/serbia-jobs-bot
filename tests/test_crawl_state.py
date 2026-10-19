import copy
import json
import unittest
from unittest.mock import patch

from crawl_state import CrawlState, RECHECK_SECONDS
from sources import SOURCES, FetchError, Fetcher, _status, collect_all, collect_source, discover_links, parse_page
from test_sources import FakeFetcher, structured


class CrawlCheckpointTests(unittest.TestCase):
    def test_source_health_defaults_and_explicit_successful_backfill(self):
        for state in ('ok', 'empty', 'partial', 'blocked', 'error', 'unsupported'):
            with self.subTest(state=state):
                self.assertEqual(_status(SOURCES['radim'], state)['healthy'], state in {'ok', 'empty'})
        self.assertTrue(_status(SOURCES['radim'], 'partial', healthy=True)['healthy'])

    def test_checkpoint_rejects_cross_site_credentials_ports_and_bad_routes(self):
        source = SOURCES['radim']
        urls = ['https://example.org/jobs/1', 'https://radim.rs:22/jobs/1',
                'https://user:password@radim.rs/jobs/1', 'http://radim.rs/jobs/1',  # pragma: allowlist secret
                'https://radim.rs/admin', 'https://radim.rs/jobs/1#fragment',
                'https://radim.rs/jobs/1%0a', 'https://radim.rs/jobs/1\x7f',
                'https://radim.rs/jobs/1?access_token=public-test-marker']
        for url in urls:
            with self.subTest(url=url):
                crawl = CrawlState(source, {'version': 1, 'cursor': url, 'pending': [url], 'seen': {}})
                self.assertEqual(crawl.pending, [])
                self.assertIsNone(crawl.cursor)
        crawl = CrawlState(source, {'version': 1, 'cursor': 'https://radim.rs/jobs?page=3',
            'pending': ['https://radim.rs/jobs/a'], 'seen': {}})
        self.assertEqual(crawl.pending, ['https://radim.rs/jobs/a'])
        self.assertEqual(crawl.cursor, 'https://radim.rs/jobs?page=3')

    def test_seen_is_hashed_bounded_and_rechecked_after_24_hours(self):
        source = SOURCES['radim']
        crawl = CrawlState(source, {}, now=2_000_000)
        for index in range(1200):
            crawl.mark(f'https://radim.rs/jobs/{index}')
        raw = crawl.checkpoint()
        self.assertEqual(len(raw['seen']), 1000)
        self.assertNotIn('https://', json.dumps(raw['seen']))
        self.assertLessEqual(len(json.dumps(raw).encode()), 90 * 1024)
        url = 'https://radim.rs/jobs/0'
        self.assertFalse(CrawlState(source, raw, now=2_000_001).due(url))
        self.assertTrue(CrawlState(source, raw, now=2_000_000 + RECHECK_SECONDS).due(url))
        self.assertEqual(CrawlState(source, raw, now=2_000_000 + 8 * RECHECK_SECONDS).history, {})

    def test_pending_urls_and_total_bytes_are_bounded_and_input_unchanged(self):
        crawl = CrawlState(SOURCES['radim'], {}, now=2_000_000)
        urls = [f'https://radim.rs/jobs/{index}-' + 'a' * 940 for index in range(100)]
        self.assertTrue(crawl.enqueue(urls))
        self.assertEqual(len(crawl.pending), 48)
        for index in range(1200):
            crawl.mark(f'https://radim.rs/jobs/{index}')
        raw = crawl.checkpoint()
        self.assertLessEqual(len(json.dumps(raw, separators=(',', ':')).encode()), 90 * 1024)
        previous = copy.deepcopy(raw)
        next_state = CrawlState(SOURCES['radim'], raw, now=2_000_001)
        next_state.mark(urls[0])
        self.assertEqual(raw, previous)

    def test_corrupt_and_future_checkpoint_is_reset(self):
        for raw in (None, [], {'version': 999}, {'version': 1, 'seen': [], 'pending': {}}):
            crawl = CrawlState(SOURCES['radim'], raw, now=100)
            self.assertEqual(crawl.history, {})
            self.assertEqual(crawl.pending, [])
        crawl = CrawlState(SOURCES['radim'], {'version': 1, 'seen': {'a' * 64: 10000, 'b' * 64: True}}, now=100)
        self.assertEqual(crawl.history, {})

    def test_listing_cursor_cannot_move_to_another_allowed_host(self):
        source = SOURCES['infostud']
        crawl = CrawlState(source, {'version': 1, 'cursor': 'https://poslovi.infostud.com/poslovi/?page=2'})
        self.assertIsNone(crawl.cursor)
        crawl = CrawlState(source, {'version': 1, 'cursor': source.listing_url + '?page=2'})
        self.assertEqual(crawl.cursor, source.listing_url + '?page=2')

    def test_discovery_and_fetcher_reject_malformed_urls_and_nonstandard_ports(self):
        source = SOURCES['radim']
        page = parse_page('<a href="https://radim.rs:123/jobs/a">Bad port</a>'
                          '<a href="https://radim.rs:invalid/jobs/a">Invalid port</a>'
                          '<a href="https://[">Malformed</a><a href="/jobs/valid">Valid</a>')
        self.assertEqual(discover_links(source, page, source.listing_url), ['https://radim.rs/jobs/valid'])
        for url in ('https://radim.rs:123/jobs/a', 'https://radim.rs:invalid/jobs/a', 'https://['):
            with self.subTest(url=url), self.assertRaises(FetchError):
                Fetcher(source).get(url)


class ResumableCollectionTests(unittest.TestCase):
    source = SOURCES['radim']

    def routes(self, count):
        return {self.source.listing_url: ''.join(f'<a href="/jobs/{i}">Role</a>' for i in range(count)),
                **{f'https://radim.rs/jobs/{i}': structured(url=f'/jobs/{i}', title=f'Role {i}') for i in range(count)}}

    def test_consecutive_cycles_skip_known_pinned_jobs_and_keep_new_first(self):
        routes = self.routes(6)
        jobs, first = collect_source(self.source, fetcher=FakeFetcher(routes), detail_limit=2, crawl_state={})
        self.assertEqual([j.url for j in jobs], ['https://radim.rs/jobs/0', 'https://radim.rs/jobs/1'])
        routes[self.source.listing_url] = routes[self.source.listing_url].replace('</a>', '</a>', 1) + '<a href="/jobs/new">New</a>'
        routes['https://radim.rs/jobs/new'] = structured(url='/jobs/new', title='New')
        fetcher = FakeFetcher(routes)
        jobs, second = collect_source(self.source, fetcher=fetcher, detail_limit=2, crawl_state=first['crawl_state'])
        self.assertEqual(jobs[0].url, 'https://radim.rs/jobs/new')
        self.assertNotIn('https://radim.rs/jobs/0', fetcher.calls)
        self.assertGreaterEqual(second['skipped_known'], 2)
        self.assertTrue(second['truncated'])

    def test_more_than_48_links_are_all_eventually_inspected(self):
        routes, raw, found = self.routes(130), {}, set()
        for _ in range(8):
            jobs, status = collect_source(self.source, fetcher=FakeFetcher(routes), detail_limit=24, crawl_state=raw)
            found.update(j.url for j in jobs)
            raw = status['crawl_state']
        self.assertEqual(len(found), 130)
        self.assertEqual(status['backlog'], 0)
        self.assertFalse(status['truncated'])

    def test_listing_cursor_reaches_lower_pages_over_cycles(self):
        routes = self.routes(4)
        for index in range(1, 5):
            url = self.source.listing_url + (f'?page={index}' if index > 1 else '')
            routes[url] = f'<a href="/jobs/{index-1}">Role</a>' + (f'<a href="/jobs?page={index+1}">Next</a>' if index < 4 else '')
        jobs, first = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state={}, page_limit=2)
        self.assertEqual(len(jobs), 2)
        self.assertEqual(first['crawl_state']['cursor'], self.source.listing_url + '?page=3')
        fetcher = FakeFetcher(routes)
        jobs, second = collect_source(self.source, fetcher=fetcher, crawl_state=first['crawl_state'], page_limit=2)
        self.assertIn(self.source.listing_url + '?page=3', fetcher.calls)
        self.assertEqual([j.url for j in jobs], ['https://radim.rs/jobs/2'])
        jobs, third = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state=second['crawl_state'], page_limit=2)
        self.assertEqual([j.url for j in jobs], ['https://radim.rs/jobs/3'])
        self.assertIsNone(third['crawl_state']['cursor'])

    def test_failed_detail_is_not_marked_and_is_retried_after_restart(self):
        routes = self.routes(1)
        routes['https://radim.rs/jobs/0'] = FetchError('timeout', 'budget')
        jobs, first = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state={})
        self.assertEqual(jobs, [])
        self.assertEqual(first['crawl_state']['seen'], {})
        self.assertEqual(first['crawl_state']['pending'], ['https://radim.rs/jobs/0'])
        routes['https://radim.rs/jobs/0'] = structured(url='/jobs/0')
        jobs, second = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state=first['crawl_state'])
        self.assertEqual(len(jobs), 1)
        self.assertEqual(second['crawl_state']['pending'], [])

    def test_failed_first_detail_does_not_starve_the_other_queued_jobs(self):
        routes = self.routes(3)
        routes['https://radim.rs/jobs/0'] = FetchError('timeout', 'budget')
        _, first = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state={}, detail_limit=1)
        self.assertEqual(first['crawl_state']['pending'], [f'https://radim.rs/jobs/{i}' for i in (1, 2, 0)])
        jobs, second = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state=first['crawl_state'], detail_limit=1)
        self.assertEqual([job.url for job in jobs], ['https://radim.rs/jobs/1'])
        self.assertIn('https://radim.rs/jobs/0', second['crawl_state']['pending'])

    def test_html_backlog_is_healthy_but_failed_reads_are_not(self):
        routes = self.routes(3)
        _, backfill = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state={}, detail_limit=1)
        self.assertEqual(backfill['state'], 'partial')
        self.assertTrue(backfill['truncated'])
        self.assertTrue(backfill['healthy'])
        routes['https://radim.rs/jobs/1'] = FetchError('error', 'Read failed')
        jobs, failed = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state={}, detail_limit=3)
        self.assertEqual(len(jobs), 2)
        self.assertEqual(failed['state'], 'partial')
        self.assertFalse(failed['healthy'])
        # The older non-checkpoint path must not report a partial read as healthy.
        self.assertFalse(collect_source(self.source, fetcher=FakeFetcher(routes), detail_limit=3)[1]['healthy'])

    def test_poslovi_uses_the_verified_complete_listing_instead_of_homepage(self):
        source = SOURCES['poslovi']
        self.assertEqual(source.listing_url, 'https://www.poslovi.rs/jobs')

    def test_failed_next_listing_keeps_cursor_and_first_page_block_does_not_fetch_pending(self):
        routes = self.routes(1)
        routes[self.source.listing_url] += '<a href="/jobs?page=2">Next</a>'
        routes[self.source.listing_url + '?page=2'] = FetchError('timeout', 'budget')
        _, status = collect_source(self.source, fetcher=FakeFetcher(routes), crawl_state={})
        self.assertEqual(status['crawl_state']['cursor'], self.source.listing_url + '?page=2')
        raw = {'version': 1, 'pending': ['https://radim.rs/jobs/0'], 'cursor': None, 'seen': {}}
        fetcher = FakeFetcher({self.source.listing_url: FetchError('blocked', 'HTTP 403')})
        collect_source(self.source, fetcher=fetcher, crawl_state=raw)
        self.assertEqual(fetcher.calls, [self.source.listing_url])

    def test_feed_continues_after_page_budget_and_skips_unchanged_first_page(self):
        source, routes = SOURCES['klikdoposla'], {}
        for index in range(1, 5):
            url = source.feed_url + (f'?page={index}' if index > 1 else '')
            routes[url] = json.dumps({'has_more': index < 4, 'next_page_url': source.feed_url + f'?page={index+1}',
                'jobs': [{'title': f'Role {index}', 'url': f'https://www.klikdoposla.com/oglasi/{index}-role'}]})
        jobs, first = collect_source(source, fetcher=FakeFetcher(routes), crawl_state={}, page_limit=2)
        self.assertEqual(len(jobs), 2)
        self.assertTrue(first['healthy'])
        jobs, second = collect_source(source, fetcher=FakeFetcher(routes), crawl_state=first['crawl_state'], page_limit=2)
        self.assertEqual([j.title for j in jobs], ['Role 3'])
        self.assertEqual(second['skipped_known'], 1)
        self.assertTrue(second['truncated'])
        self.assertTrue(second['healthy'])
        routes[source.feed_url + '?page=3'] = FetchError('timeout', 'budget')
        self.assertFalse(collect_source(source, fetcher=FakeFetcher(routes), crawl_state=first['crawl_state'], page_limit=2)[1]['healthy'])

    def test_lako_metadata_pagination_and_queued_details_survive_restart(self):
        base = 'https://prod.lakodoposla.net/api/postings'
        routes = {}
        for page in (1, 2, 3):
            node = {'id': page, 'slug': f'role-{page}', 'positionTitle': f'Role {page}', 'jobDescription': 'Support clients in Beograd.'}
            routes[base + f'?page={page}'] = json.dumps({'data': [node], 'meta': {'hasMorePages': page < 3, 'lastPage': 3}})
            routes[base + f'/{page}'] = json.dumps({'data': node})
        jobs, first = collect_source(SOURCES['lakodoposla'], fetcher=FakeFetcher(routes), crawl_state={}, detail_limit=1, page_limit=2)
        self.assertEqual([j.title for j in jobs], ['Role 1'])
        self.assertEqual(first['crawl_state']['cursor'], base + '?page=3')
        self.assertTrue(first['healthy'])
        jobs, second = collect_source(SOURCES['lakodoposla'], fetcher=FakeFetcher(routes), crawl_state=first['crawl_state'], detail_limit=3, page_limit=2)
        self.assertEqual({j.title for j in jobs}, {'Role 2', 'Role 3'})
        self.assertFalse(second['truncated'])
        self.assertTrue(second['healthy'])

    def test_lako_partial_detail_failure_is_unhealthy(self):
        base = 'https://prod.lakodoposla.net/api/postings'
        node = {'id': 1, 'slug': 'role-1', 'positionTitle': 'Role', 'jobDescription': 'Support clients in Beograd.'}
        routes = {base + '?page=1': json.dumps({'data': [{'id': 1}, {'id': 2}]}),
                  base + '/1': json.dumps({'data': node}), base + '/2': FetchError('timeout', 'budget')}
        jobs, status = collect_source(SOURCES['lakodoposla'], fetcher=FakeFetcher(routes), crawl_state={})
        self.assertEqual(len(jobs), 1)
        self.assertEqual(status['state'], 'partial')
        self.assertFalse(status['healthy'])

    def test_serbiahub_resumes_after_the_first_two_pages_and_keeps_failed_cursor(self):
        source, routes = SOURCES['serbiahub'], {}
        for offset in (0, 50, 100):
            routes[f'https://serbiahub.com/api/jobs?limit=50&offset={offset}'] = json.dumps({
                'items': [{'id': offset + index, 'title': 'Support', 'city': 'Beograd'} for index in range(50)],
                'total': 150})
        jobs, first = collect_source(source, fetcher=FakeFetcher(routes), crawl_state={}, page_limit=2)
        self.assertEqual(len(jobs), 100)
        self.assertTrue(first['healthy'])
        self.assertTrue(first['crawl_state']['cursor'].endswith('offset=100'))
        routes['https://serbiahub.com/api/jobs?limit=50&offset=100'] = FetchError('timeout', 'budget')
        _, failed = collect_source(source, fetcher=FakeFetcher(routes), crawl_state=first['crawl_state'], page_limit=2)
        self.assertEqual(failed['crawl_state']['cursor'], first['crawl_state']['cursor'])
        self.assertFalse(failed['healthy'])
        routes['https://serbiahub.com/api/jobs?limit=50&offset=100'] = json.dumps({
            'items': [{'id': 100 + index, 'title': 'Support', 'city': 'Beograd'} for index in range(50)], 'total': 150})
        fetcher = FakeFetcher(routes)
        jobs, last = collect_source(source, fetcher=fetcher, crawl_state=failed['crawl_state'], page_limit=2)
        self.assertEqual(len(jobs), 50)
        self.assertEqual(last['skipped_known'], 50)
        self.assertIsNone(last['crawl_state']['cursor'])
        self.assertFalse(last['truncated'])

    def test_collect_all_forwards_independent_states_and_explicit_budgets(self):
        seen = []
        def collect(source, **options):
            seen.append((source.id, options))
            return [], {'state': 'ok'}
        with patch('sources.collect_source', side_effect=collect):
            collect_all(['radim', 'poslovi'], crawl_states={'radim': {'version': 1}}, detail_limit=24, page_limit=4)
        self.assertEqual(dict(seen)['radim']['crawl_state'], {'version': 1})
        self.assertEqual(dict(seen)['poslovi']['crawl_state'], {})
        self.assertTrue(all(opts['detail_limit'] == 24 and opts['page_limit'] == 4 for _, opts in seen))
