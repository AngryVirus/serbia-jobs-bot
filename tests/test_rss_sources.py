import unittest
from sources import SOURCES, collect_source
from test_sources import FakeFetcher


class RSSTests(unittest.TestCase):
    def collect(self, body):
        source = SOURCES['infostud']
        return collect_source(source, fetcher=FakeFetcher({source.listing_url: body}))

    def test_official_feed_parses_dates_addresses_and_only_job_links(self):
        jobs, status = self.collect('''<rss><channel><item>
            <title>Kuvar</title><link>https://poslovi.infostud.com/posao/kuvar/company/123</link>
            <description><![CDATA[<p>Beograd</p><p>Adresa: Knez Mihailova 12</p>]]></description>
            <pubDate>Wed, 14 Oct 2026 09:00:00 +0200</pubDate></item>
            <item><title>External</title><link>https://example.org/job</link></item></channel></rss>''')
        self.assertEqual(len(jobs), 1)
        self.assertEqual(status['state'], 'ok')
        self.assertEqual(jobs[0].published_at, '2026-10-14T07:00:00+00:00')
        from addresses import job_address
        self.assertIn('Knez Mihailova 12', job_address(jobs[0].__dict__))

    def test_invalid_feed_is_not_reported_as_success(self):
        for body in ('<html>Blocked</html>', '<rss>', '<!DOCTYPE rss><rss><channel/></rss>'):
            self.assertEqual(self.collect(body)[1]['state'], 'error')
        self.assertEqual(self.collect('<rss><channel/></rss>')[1]['state'], 'empty')
