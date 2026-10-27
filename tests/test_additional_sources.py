"""Real public-format fixtures + deterministic coverage and safety regressions."""
from pathlib import Path
import unittest

from additional_sources import (collect_additional, discover_additional,
                                extract_additional_jobs)
from crawl_state import CrawlState
from sources import FetchError, MAX_BYTES, Source

FIXTURES = Path(__file__).parent / 'fixtures' / 'additional'
SPECS = {
    'nsz': ('https://nsz.gov.rs/', 'employee/jobs/search', r'^/employee/jobs/preview/\d+/?$', 'employee/jobs/preview/104159'),
    'manpower': ('https://www.manpower.rs/', 'sr/job-posts', r'^/sr/job-posts/\d+/?$', 'sr/job-posts/313111'),
    'boxposlovi': ('https://www.boxposlovi.com/', 'studenti/', r'^/posao/[a-z0-9-]+/?$', 'posao/prodavac-sladoleda-nis-centar-2/'),
    'delhaize': ('https://karijera.delhaizeserbia.rs/', 'sitemap.vacancy.xml', r'^/radne-pozicija/\d+/[a-z0-9-]+/?$', 'radne-pozicija/686/prodavac-prodavacica-novi-sad-6'),
}


def source(identity):
    base, listing, pattern, _ = SPECS[identity]
    return Source(identity, identity, base, base + listing, (pattern,), rss_feed=identity == 'delhaize')


def fixture(identity, kind):
    name = 'box' if identity == 'boxposlovi' else identity
    return (FIXTURES / (name + '_' + kind + ('.xml' if kind == 'sitemap' else '.html'))).read_text()


def detail_url(identity):
    return SPECS[identity][0] + SPECS[identity][3]


class FakeFetcher:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get(self, url):
        self.calls.append(url)
        response = self.pages[url]
        if isinstance(response, Exception):
            raise response
        return response if isinstance(response, tuple) else (response, url)


class AdditionalSourceTests(unittest.TestCase):
    def test_nsz_preserves_citizenship_dates_and_public_conditions(self):
        job, = extract_additional_jobs(source('nsz'), fixture('nsz', 'detail'), detail_url('nsz'))
        self.assertEqual(job.title, 'Рецепционер')
        self.assertIn('Gejzer', job.company)
        self.assertEqual(job.location, 'Медвеђа')
        self.assertIn('држављанству Републике Србије', job.description)
        self.assertIn('Средња школа - IV степен', job.description)
        self.assertEqual((job.published_at, job.expires_at), ('2026-10-16', '2026-10-25'))
        self.assertTrue(job.publication_date_only)
        self.assertTrue(job.expires_date_only)
        self.assertIsNone(job.country)
        self.assertIsNone(job.russian)
        self.assertNotIn('cookies', job.description)

    def test_nsz_literal_preview_links_only_and_pagination(self):
        s = source('nsz')
        links, cursor = discover_additional(s, fixture('nsz', 'list'), s.listing_url)
        self.assertEqual(len(links), 20)
        self.assertEqual(cursor, s.listing_url + '?page=2')
        self.assertTrue(all('/employee/jobs/preview/' in value for value in links))
        hostile = '<a href="https://poslovi.infostud.com/posao/123">Other inventory</a><div onclick="document.location.href=\'https://evil.test/employee/jobs/preview/1\'"></div><div onclick="document.location.href=\'https://nsz.gov.rs/employee/jobs/preview/1\';alert(1)"></div>'
        self.assertEqual(discover_additional(s, hostile, s.listing_url), ([], None))

    def test_manpower_preserves_full_sections_not_marketing(self):
        job, = extract_additional_jobs(source('manpower'), fixture('manpower', 'detail'), detail_url('manpower'))
        self.assertEqual(job.location, 'Niš')
        self.assertIn('Operater', job.title)
        self.assertIn('Ariston', job.description)
        self.assertIn('Zahtevi', job.description)
        self.assertIn('Plaćen prevoz', job.description)
        self.assertIs(job.remote, False)
        self.assertEqual(job.company, '')
        self.assertIsNone(job.published_at)
        self.assertIsNone(job.expires_at)
        self.assertNotIn('Vaša sledeća poslovna prilika', job.description)

    def test_manpower_top_promoted_items_do_not_end_scanning_or_lose_dates(self):
        s = source('manpower')
        listing = fixture('manpower', 'list')
        links, cursor = discover_additional(s, listing, s.listing_url)
        self.assertGreater(len(links), 8)
        self.assertEqual(cursor, s.listing_url + '?page=1')
        state = CrawlState(s)
        for url in links:
            if url != detail_url('manpower'):
                state.mark(url)
        fetcher = FakeFetcher({s.listing_url: listing, detail_url('manpower'): fixture('manpower', 'detail')})
        jobs, status = collect_additional(s, fetcher, crawl_state=state.checkpoint(), page_limit=1)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].published_at, '2026-10-16')
        self.assertEqual(status['inspected'], 1)
        self.assertGreaterEqual(status['skipped_known'], 8)

    def test_manpower_foreign_location_rejected_and_checkpointed(self):
        s = source('manpower')
        for location in ('Rad u inostranstvu', 'Berlin, Germany'):
            body = fixture('manpower', 'detail').replace(' Niš</div>', ' ' + location + '</div>')
            url = detail_url('manpower')
            fetcher = FakeFetcher({s.listing_url: '<a href="' + url + '">Operater</a>', url: body})
            jobs, status = collect_additional(s, fetcher, page_limit=1)
            self.assertEqual(jobs, [], location)
            self.assertEqual(status['rejected']['foreign'], 1)
            self.assertTrue(CrawlState(s, status['crawl_state']).seen(url))
            self.assertEqual(status['backlog'], 0)

    def test_box_preserves_student_age_hours_and_hourly_pay(self):
        job, = extract_additional_jobs(source('boxposlovi'), fixture('boxposlovi', 'detail'), detail_url('boxposlovi'))
        self.assertEqual(job.title, 'Prodavac sladoleda – Niš (centar)')
        self.assertNotEqual(job.title, 'CENTAR')
        self.assertEqual(job.location, 'Niš')
        self.assertIn('studenti do 26 godina', job.description)
        self.assertIn('10h do 16h', job.description)
        self.assertIn('16h do 22h', job.description)
        self.assertEqual(job.salary_display, '371 RSD / sat')
        self.assertEqual(job.salary_currency, 'RSD')
        self.assertEqual(job.salary_period, 'hour')
        self.assertIsNone(job.salary_min)
        self.assertEqual(job.published_at, '2026-10-16T12:40:01+00:00')
        self.assertIsNone(job.expires_at)

    def test_box_page_navigation(self):
        s = source('boxposlovi')
        links, cursor = discover_additional(s, fixture('boxposlovi', 'list'), s.listing_url)
        self.assertEqual(len(links), 8)
        self.assertEqual(cursor, s.listing_url + 'page/2/')

    def test_delhaize_uses_advertised_vacancy_sitemap_only(self):
        s = source('delhaize')
        links, cursor = discover_additional(s, fixture('delhaize', 'sitemap'), s.listing_url)
        self.assertEqual(len(links), 18)
        self.assertIn(detail_url('delhaize'), links)
        self.assertIsNone(cursor)
        for bad in ('<!DOCTYPE urlset [<!ENTITY a "bad">]><urlset/>', '<sitemapindex/>', '<html>0 results</html>', '<urlset>'):
            with self.assertRaises(FetchError):
                discover_additional(s, bad, s.listing_url)
        hostile = '<urlset><url><loc>https://evil.test/radne-pozicija/1/test</loc></url><url><loc>https://karijera.delhaizeserbia.rs/radne-pozicija/1/test?location=x</loc></url></urlset>'
        self.assertEqual(discover_additional(s, hostile, s.listing_url), ([], None))

    def test_delhaize_truthful_old_publication_future_expiry_no_zero_salary(self):
        job, = extract_additional_jobs(source('delhaize'), fixture('delhaize', 'detail'), detail_url('delhaize'))
        self.assertEqual(job.company, 'Delhaize Serbia')
        self.assertEqual(job.country, 'RS')
        self.assertIn('Novi Sad', job.location)
        self.assertEqual(job.published_at, '2026-04-02T09:30:16+02:00')
        self.assertEqual(job.expires_at, '2026-10-28T22:59:59+01:00')
        self.assertIn('Najmanje 26 dana', job.description)
        self.assertIsNone(job.salary_display)
        self.assertIsNone(job.salary_min)
        self.assertIsNone(job.salary_currency)

    def test_repeated_runs_process_backlog_then_resume_next_page(self):
        s = source('boxposlovi')
        urls = [s.url + 'posao/job-' + str(index) + '/' for index in range(1, 25)]
        page2 = s.listing_url + 'page/2/'
        listing1 = ''.join('<a href="' + url + '">Job</a>' for url in urls[:12]) + '<nav><a href="' + page2 + '">2</a></nav>'
        listing2 = ''.join('<a href="' + url + '">Job</a>' for url in urls[12:])
        pages = {s.listing_url: listing1, page2: listing2, **{url: fixture('boxposlovi', 'detail') for url in urls}}
        fetcher, raw, delivered = FakeFetcher(pages), {}, []
        for _ in range(3):
            jobs, status = collect_additional(s, fetcher, 8, crawl_state=raw)
            raw = status['crawl_state']
            delivered.extend(job.url for job in jobs)
        self.assertEqual(len(delivered), 24)
        self.assertEqual(len(set(delivered)), 24)
        self.assertEqual(status['backlog'], 0)
        self.assertGreater(status['skipped_known'], 0)
        self.assertEqual(len([url for url in fetcher.calls if '/posao/' in url]), 24)

    def test_overflow_retains_page_until_all_discovered_urls_are_queued(self):
        s = source('nsz')
        urls = [s.url + 'employee/jobs/preview/' + str(index) for index in range(1, 61)]
        listing = ''.join('<div onclick="document.location.href=\'' + url + '\'"></div>' for url in urls)
        pages = {s.listing_url: listing, **{url: fixture('nsz', 'detail') for url in urls}}
        raw, accepted = {}, set()
        for _ in range(8):
            # Pagination coverage must not expire with the dated public fixture.
            jobs, status = collect_additional(s, FakeFetcher(pages), 8, crawl_state=raw, page_limit=1, include_expired=True)
            raw = status['crawl_state']
            accepted.update(job.url for job in jobs)
        self.assertEqual(accepted, set(urls))
        self.assertEqual(status['backlog'], 0)

    def test_checkpoint_injection_redirects_oversize_and_shells(self):
        s = source('delhaize')
        raw = {'version': 1, 'cursor': s.url + 'otvorene-pozicije?location=1', 'pending': ['https://evil.test/x', s.url + 'apply/1'], 'seen': {}}
        fetcher = FakeFetcher({s.listing_url: fixture('delhaize', 'sitemap')})
        _, status = collect_additional(s, fetcher, 0, crawl_state=raw)
        self.assertEqual(fetcher.calls, [s.listing_url])
        self.assertEqual(status['backlog'], 18)
        self.assertTrue(status['truncated'])
        self.assertEqual(status['state'], 'partial')
        self.assertTrue(status['healthy'])
        with self.assertRaises(FetchError):
            discover_additional(s, 'x' * (MAX_BYTES + 1), s.listing_url)
        with self.assertRaises(FetchError):
            discover_additional(s, 'я' * (MAX_BYTES // 2 + 1), s.listing_url)
        for final in ('https://evil.test/sitemap.vacancy.xml', s.url + 'otvorene-pozicije'):
            jobs, status = collect_additional(s, FakeFetcher({s.listing_url: ('<html/>', final)}))
            self.assertEqual(jobs, [])
            self.assertEqual(status['state'], 'error')
            self.assertFalse(status['healthy'])
        jobs, status = collect_additional(s, FakeFetcher({s.listing_url: '<urlset/>'}))
        self.assertEqual(jobs, [])
        self.assertEqual(status['state'], 'error')
        self.assertEqual(status['listing_pages'], 1)

    def test_detail_failures_are_retried_without_blocking_queued_success(self):
        s = source('boxposlovi')
        first, second = s.url + 'posao/one/', s.url + 'posao/two/'
        listing = '<a href="' + first + '">1</a><a href="' + second + '">2</a>'
        fetcher = FakeFetcher({s.listing_url: listing, first: FetchError('error', 'HTTP 500'), second: fixture('boxposlovi', 'detail')})
        jobs, status = collect_additional(s, fetcher, 1, page_limit=1)
        self.assertEqual(status['state'], 'error')
        self.assertFalse(status['healthy'])
        self.assertEqual(status['crawl_state']['pending'], [second, first])
        jobs, status = collect_additional(s, fetcher, 1, page_limit=1, crawl_state=status['crawl_state'])
        self.assertEqual([job.url for job in jobs], [second])
        self.assertEqual(status['crawl_state']['pending'], [first])
        self.assertTrue(status['healthy'])

    def test_initial_http_failure_is_not_a_healthy_empty_source(self):
        s = source('boxposlovi')
        jobs, status = collect_additional(s, FakeFetcher({s.listing_url: FetchError('error', 'HTTP 500')}))
        self.assertEqual(jobs, [])
        self.assertEqual(status['listing_pages'], 0)
        self.assertFalse(status['healthy'])

    def test_expiry_dates_preserved_when_reconciling(self):
        s = source('nsz')
        url = detail_url('nsz')
        body = fixture('nsz', 'detail').replace('16.10.2026. - 25.10.2026.', '16.10.2020. - 25.10.2020.')
        pages = {s.listing_url: '<div onclick="document.location.href=\'' + url + '\'"></div>', url: body}
        jobs, status = collect_additional(s, FakeFetcher(pages), page_limit=1)
        self.assertEqual(jobs, [])
        self.assertEqual(status['rejected']['expired'], 1)
        jobs, status = collect_additional(s, FakeFetcher(pages), page_limit=1, include_expired=True)
        self.assertEqual(jobs[0].expires_at, '2020-10-25')


if __name__ == '__main__':
    unittest.main()
