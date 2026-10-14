"""Source regressions based on verified public page formats."""
from dataclasses import asdict
from datetime import datetime, timezone
import json
import unittest

from filters import matches
from job_metadata import country_values
from sources import (SOURCES, Fetcher, FetchError, canonical_url, collect_source,
                     discover_links, extract_jobs, is_detail_url, parse_page)
from store import SOURCE_IDS, default_settings
from test_sources import FakeFetcher, Opener


HALO_URL = 'https://www.halooglasi.com/posao/ponuda-poslova-higijenicar/higijenicar/12345'
STARTIT_URL = 'https://startit.rs/poslovi/devops-company/'
BULEVAR_URL = ('https://www.omladinskabulevar.rs/za-zadrugare-omladinske-zadruge/'
               'poslovi-omladinska-zadruga-beograd/5980-magacin.html')
API = 'https://prod.lakodoposla.net/api'


def halo(**changes):
    node = {'Id': '12345', 'StateId': 101, 'Title': 'Higijeničar',
            'ValidFrom': '2026-10-14T08:00:00Z', 'ValidTo': '2026-11-13T08:00:00Z',
            'TextHtml': '<p>Opis posla: čišćenje.</p>',
            'OtherFields': {'gradovi_ss': ['Beograd'], 'naziv_poslodavca_s': 'Example',
                            'napomena_s': 'ВНЖ не требуется'}}
    node.update(changes)
    stale = {'@type': 'JobPosting', 'title': 'Old title', 'url': HALO_URL,
             'datePosted': '2024-08-19', 'validThrough': '2024-09-18',
             'jobLocation': {'address': 'Beograd'}}
    return ('<script type="application/ld+json">' + json.dumps(stale) + '</script>'
            '<script>QuidditaEnvironment.CurrentClassified=' + json.dumps(node) +
            '; QuidditaEnvironment.IsCurrentAdActive=true;</script>')


class PageAdapterTests(unittest.TestCase):
    def test_halo_uses_current_payload_instead_of_stale_schema(self):
        job = extract_jobs(SOURCES['halooglasi'], halo(), HALO_URL + '?kid=4')[0]
        self.assertEqual(job.url, HALO_URL)
        self.assertEqual(job.title, 'Higijeničar')
        self.assertEqual(job.company, 'Example')
        self.assertEqual(job.location, 'Beograd')
        self.assertIsNone(job.country)
        self.assertEqual(job.expires_at, '2026-11-13T08:00:00Z')
        self.assertTrue(matches(asdict(job), dict(default_settings(), freshness=['today'], residence_permit=['no']),
                                datetime(2026, 10, 14, 12, tzinfo=timezone.utc)))
        renewed = extract_jobs(SOURCES['halooglasi'], halo(ValidToProlonged='2026-12-13T08:00:00Z'), HALO_URL)[0]
        self.assertEqual(renewed.expires_at, '2026-12-13T08:00:00Z')

    def test_halo_rejects_wrong_id_inactive_malformed_and_stale_only(self):
        for body in (halo(Id='555'), halo(StateId=102), halo().replace('IsCurrentAdActive=true', 'IsCurrentAdActive=false'),
                     '<script>QuidditaEnvironment.CurrentClassified={bad};</script>',
                     halo().split('<script>QuidditaEnvironment.CurrentClassified')[0]):
            self.assertEqual(extract_jobs(SOURCES['halooglasi'], body, HALO_URL), [])
        self.assertEqual(extract_jobs(SOURCES['halooglasi'], halo(), SOURCES['halooglasi'].listing_url), [])

    def test_free_form_city_address_is_not_a_country(self):
        for address in ('Beograd', ['Beograd'], {'addressLocality': 'Beograd'}):
            self.assertEqual(country_values({'address': address}), [])
        self.assertEqual(country_values({'address': {'addressCountry': 'DE'}}), ['DE'])
        self.assertEqual(country_values({'@type': 'Country', 'name': 'Serbia'}), ['Serbia'])

    def test_startit_discovers_job_headings_without_taxonomy_pages(self):
        listing = ('<h1><a href="/poslovi/devops-company/">DevOps</a></h1>'
                   '<a href="/poslovi/aws-2/">AWS</a><a href="/poslovi/">sve</a>'
                   '<a href="/poslovi/devops-company/"></a>')
        self.assertEqual(discover_links(SOURCES['startit'], parse_page(listing), SOURCES['startit'].url), [STARTIT_URL])

    def test_startit_scoped_description_location_expiry_and_unknown_publication(self):
        body = ('<nav>Wrong job: English required</nav><h1>DevOps</h1>'
                '<div id="so-co-ad-wrap"><p>Requirements: Kubernetes</p><div><p>Наличие ВНЖ</p></div>'
                '<p>Prijavi se do 08/12/26</p><p>Lokacija — Beograd</p></div>'
                '<div>Unrelated footer: German required</div>')
        job = extract_jobs(SOURCES['startit'], body, STARTIT_URL)[0]
        self.assertEqual(job.location, 'Beograd')
        self.assertEqual(job.expires_at, '2026-12-08')
        self.assertIsNone(job.published_at)
        self.assertEqual(job.languages, [])
        self.assertNotIn('footer', job.description)
        self.assertTrue(matches(asdict(job), dict(default_settings(), residence_permit=['yes'])))
        self.assertEqual(extract_jobs(SOURCES['startit'], '<h1>AWS</h1><p>Other jobs</p>', STARTIT_URL), [])

    def test_bulevar_keeps_job_body_hourly_pay_and_application_conditions(self):
        body = ('<h1>Magacioner — za studente</h1><div class="padding-right">'
                '<h4>Omladinska zadruga Bulevar</h4><p>Mesto: Niš</p>'
                '<p>Opis posla: pakovanje</p><ul><li>Uslovi: za studente do 26 godina</li></ul>'
                '<p>Zarada: 500 RSD/H</p><p>Prijava: hr@example.org</p></div>'
                '<div class="job-overview">Beograd 999999 din / sat</div>'
                '<footer>Contact admin@example.org, English mandatory</footer>')
        job = extract_jobs(SOURCES['bulevar'], body, BULEVAR_URL)[0]
        self.assertEqual(job.location, 'Niš')
        self.assertEqual(job.salary_display, '500 RSD/H')
        self.assertIsNone(job.salary_min)
        self.assertIsNone(job.published_at)
        self.assertIn('do 26 godina', job.description)
        self.assertEqual(job.contacts, ['hr@example.org'])
        self.assertEqual(job.languages, [])
        self.assertNotIn('999999', job.description)

    def test_unicode_links_are_requestable_and_canonicalization_is_idempotent(self):
        raw = BULEVAR_URL.replace('magacin', 'promoter–Niš') + '?utm_source=x'
        url = canonical_url(raw)
        self.assertTrue(url.isascii())
        self.assertTrue(is_detail_url(SOURCES['bulevar'], url))
        self.assertEqual(canonical_url(url), url)
        self.assertEqual(set(SOURCE_IDS), set(SOURCES))


def lako_node(identity=1, **changes):
    node = {'id': identity, 'slug': 'support-' + str(identity), 'positionTitle': 'Support',
            'employerName': 'Public Company', 'locationName': 'Beograd', 'date': '14.10.2026',
            'expiryDate': '14.11.2099', 'hasExpired': False,
            'jobDescription': '<p>Support clients.</p>', 'conditionsDescription': '<p>English required. Наличие ВНЖ.</p>',
            'employer': {'email': 'private@example.org', 'irrelevant_account_field': 'MUST_NOT_STORE'},
            'notificationsEmail': 'internal@example.org'}
    node.update(changes)
    return node


class LakoAdapterTests(unittest.TestCase):
    def test_api_fields_budget_dates_and_private_data_exclusion(self):
        routes = {API + '/postings?page=1': json.dumps({'data': [lako_node(1), lako_node(1), lako_node(2)]}),
                  API + '/postings/1': json.dumps({'data': lako_node(1)})}
        fetcher = FakeFetcher(routes)
        jobs, status = collect_source(SOURCES['lakodoposla'], detail_limit=1, fetcher=fetcher)
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(fetcher.calls, list(routes))
        self.assertEqual(status['state'], 'ok')
        self.assertEqual(job.url, 'https://www.lakodoposla.com/oglasi/support-1')
        self.assertEqual(job.published_at, '2026-10-14')
        self.assertTrue(job.publication_date_only)
        self.assertIn('en', job.languages)
        saved = json.dumps(asdict(job))
        for secret in ('private@example.org', 'MUST_NOT_STORE', 'internal@example.org'):
            self.assertNotIn(secret, saved)

    def test_partial_error_keeps_jobs_and_does_not_bypass_block(self):
        routes = {API + '/postings?page=1': json.dumps({'data': [lako_node(1), lako_node(2), lako_node(3)]}),
                  API + '/postings/1': json.dumps({'data': lako_node(1)}),
                  API + '/postings/2': FetchError('blocked', 'HTTP 403')}
        fetcher = FakeFetcher(routes)
        jobs, status = collect_source(SOURCES['lakodoposla'], fetcher=fetcher)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(status['state'], 'partial')
        self.assertNotIn(API + '/postings/3', fetcher.calls)

    def test_invalid_private_or_expired_api_data_is_never_a_vacancy(self):
        for changes in ({'id': 2}, {'slug': '../other-1'}, {'hasExpired': True}, {'expiryDate': '01.01.2020'},
                        {'jobDescription': '', 'conditionsDescription': ''}):
            routes = {API + '/postings?page=1': json.dumps({'data': [lako_node()]}),
                      API + '/postings/1': json.dumps({'data': lako_node(**changes)})}
            with self.subTest(changes=changes):
                self.assertEqual(collect_source(SOURCES['lakodoposla'], fetcher=FakeFetcher(routes))[0], [])
        for body in ('not json', '{}', '{"data": {}}'):
            jobs, status = collect_source(SOURCES['lakodoposla'], fetcher=FakeFetcher({API + '/postings?page=1': body}))
            self.assertEqual(jobs, [])
            self.assertEqual(status['state'], 'error')

    def test_api_host_has_its_own_robots_and_is_not_a_job_link(self):
        fetcher = Fetcher(SOURCES['lakodoposla'], delay=0)
        fetcher.opener = Opener({'https://prod.lakodoposla.net/robots.txt': 'User-agent: *\nDisallow: /api'})
        with self.assertRaises(FetchError) as error:
            fetcher.get(API + '/postings?page=1')
        self.assertEqual(error.exception.state, 'robots_disallowed')
        self.assertEqual(len(fetcher.opener.calls), 1)
        self.assertFalse(is_detail_url(SOURCES['lakodoposla'], 'https://prod.lakodoposla.net/oglasi/support-1'))
        for url in ('https://unrelated.example/api/postings', 'http://prod.lakodoposla.net/api/postings'):
            with self.assertRaises(FetchError):
                fetcher.get(url)
