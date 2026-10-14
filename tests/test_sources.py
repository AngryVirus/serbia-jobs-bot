import json
from email.message import Message
import unittest
from urllib.error import HTTPError

from sources import (
    SOURCES, FetchError, Fetcher, collect_all, collect_source, discover_links,
    extract_jobs, infer_flags, parse_money_amount, parse_page, parse_feed_jobs,
)


def structured(**updates):
    node = {
        "@type": "JobPosting", "title": "Customer support",
        "url": "https://radim.rs/jobs/support-123?utm_source=telegram",
        "description": "<p>Russian language required. Serbian is not required.</p>",
        "hiringOrganization": {"@type": "Organization", "name": "Example &amp; Co"},
        "jobLocation": [{"address": {"addressLocality": "Beograd"}},
                        {"address": {"addressLocality": "Novi Sad"}}],
        "baseSalary": {"currency": "EUR", "value": {"minValue": 1000.50, "unitText": "MONTH"}},
        "jobLocationType": "TELECOMMUTE", "datePosted": "2026-10-14",
    }
    node.update(updates)
    return '<script type="application/ld+json">' + json.dumps({"@graph": [node]}) + '</script>'


class Response:
    def __init__(self, body, content_type="text/html; charset=utf-8"):
        self.body = body.encode()
        self.headers = Message()
        self.headers["Content-Type"] = content_type

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, size):
        return self.body[:size]


class Opener:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def open(self, request, timeout):
        self.calls.append(request.full_url)
        value = self.routes[request.full_url]
        if isinstance(value, Exception):
            raise value
        return Response(value)


class FakeFetcher:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        value = self.routes[url]
        if isinstance(value, Exception):
            raise value
        return value, url


class SourceParsingTests(unittest.TestCase):
    def test_structured_graph_keeps_values_and_unknowns(self):
        job = extract_jobs(SOURCES["radim"], structured(), SOURCES["radim"].listing_url)[0]
        self.assertEqual(job.url, "https://radim.rs/jobs/support-123")
        self.assertEqual(job.company, "Example & Co")
        self.assertEqual(job.location, "Beograd, Novi Sad")
        self.assertEqual(job.salary_min, 1000.50)
        self.assertTrue(job.remote)
        self.assertTrue(job.russian)
        self.assertFalse(job.serbian_required)
        self.assertEqual(job.published_at, "2026-10-14")
        self.assertIsNone(job.expires_at)

    def test_hourly_salary_never_enters_monthly_filter(self):
        html = structured(baseSalary={"currency": "RSD", "value": {"value": 500, "unitText": "HOUR"}})
        self.assertIsNone(extract_jobs(SOURCES["radim"], html, "https://radim.rs/jobs/test-123")[0].salary_min)

    def test_json_html_entities_do_not_break_valid_json(self):
        job = extract_jobs(SOURCES["radim"], structured(title="Support &quot;Team&quot;"), "https://radim.rs/jobs")[0]
        self.assertEqual(job.title, 'Support "Team"')

    def test_external_structured_urls_and_ambiguous_listing_ids_rejected(self):
        self.assertEqual(extract_jobs(SOURCES["radim"], structured(url="https://example.com/job"), "https://radim.rs/jobs"), [])
        self.assertEqual(extract_jobs(SOURCES["radim"], structured(url=None), "https://radim.rs/jobs"), [])

    def test_unknown_language_is_not_invented(self):
        self.assertEqual(infer_flags("Python developer in Belgrade. English is helpful."), (None, None, None))
        self.assertIsNone(infer_flags("Желательно знание сербского языка")[2])
        self.assertFalse(infer_flags("Знание сербского языка не требуется")[2])
        self.assertTrue(infer_flags("СВОБОДНЫЙ сербский язык")[2])

    def test_negative_remote_evidence(self):
        for text in ("No remote work", "non-remote role", "nije remote", "Remote work is not available"):
            with self.subTest(text=text):
                self.assertFalse(infer_flags(text)[0])

    def test_html_fallback_ignores_navigation_and_similar_jobs(self):
        html = """<nav>Remote Russian language</nav><h1>Accountant</h1>
            <h2>Location:</h2><p>Belgrade</p><h2>Requirements</h2>
            <p>English required</p><h2>Similar Jobs</h2><p>Remote Russian language</p>"""
        job = extract_jobs(SOURCES["ovdejobs"], html, "https://ovdejobs.com/jobs/accountant-123/")[0]
        self.assertEqual(job.location, "Belgrade")
        self.assertEqual(job.title, "Accountant")
        self.assertIsNone(job.remote)
        self.assertIsNone(job.russian)
        self.assertNotIn("Similar Jobs", job.description)

    def test_monthly_html_salary_preserves_decimals(self):
        for raw, expected in (("1000.50", 1000.50), ("1.000,50", 1000.50), ("1,000.50", 1000.50), ("120,000", 120000), ("120 000", 120000)):
            with self.subTest(raw=raw):
                html = f"<h1>Accountant</h1><h2>Salary:</h2><p>{raw} EUR / month</p><h2>Requirements</h2><p>English</p>"
                job = extract_jobs(SOURCES["ovdejobs"], html, "https://ovdejobs.com/jobs/accountant-123/")[0]
                self.assertEqual(job.salary_min, expected)
        self.assertIsNone(parse_money_amount("negotiable"))

    def test_no_fallback_on_listing_or_unrecognized_page(self):
        html = "<h1>Jobs</h1><h2>Description</h2><p>Find a job</p>"
        self.assertEqual(extract_jobs(SOURCES["radim"], html, "https://radim.rs/jobs"), [])
        self.assertEqual(extract_jobs(SOURCES["radim"], html, "https://radim.rs/about"), [])

    def test_discovery_rejects_other_domains_and_navigation(self):
        page = parse_page('<a href="/jobs/support-123">Support</a><a href="/jobs">Jobs</a>'
                          '<a href="https://example.com/jobs/other-123">Other</a>'
                          '<a href="/jobs/support-123?utm_source=mail">Duplicate</a>')
        self.assertEqual(discover_links(SOURCES["radim"], page, "https://radim.rs/jobs"), ["https://radim.rs/jobs/support-123"])


class FetchPolicyTests(unittest.TestCase):
    def make_fetcher(self, routes):
        fetcher = Fetcher(SOURCES["radim"], delay=0)
        fetcher.opener = Opener(routes)
        return fetcher

    def test_robots_disallow_prevents_page_request(self):
        fetcher = self.make_fetcher({"https://radim.rs/robots.txt": "User-agent: *\nDisallow: /jobs"})
        with self.assertRaises(FetchError) as context:
            fetcher.get("https://radim.rs/jobs")
        self.assertEqual(context.exception.state, "robots_disallowed")
        self.assertEqual(fetcher.opener.calls, ["https://radim.rs/robots.txt"])

    def test_missing_robots_allows_but_html_robots_fail_closed(self):
        fetcher = self.make_fetcher({"https://radim.rs/robots.txt": HTTPError("", 404, "not found", Message(), None),
                                     "https://radim.rs/jobs": "<h1>Jobs</h1>"})
        self.assertIn("Jobs", fetcher.get("https://radim.rs/jobs")[0])
        fetcher = self.make_fetcher({"https://radim.rs/robots.txt": "<!doctype html><p>Error</p>"})
        with self.assertRaises(FetchError) as context:
            fetcher.get("https://radim.rs/jobs")
        self.assertEqual(context.exception.state, "robots_unavailable")

    def test_redirect_rechecks_robots(self):
        headers = Message()
        headers["Location"] = "/jobs/private"
        fetcher = self.make_fetcher({"https://radim.rs/robots.txt": "User-agent: *\nDisallow: /jobs/private",
                                     "https://radim.rs/jobs": HTTPError("", 302, "found", headers, None)})
        with self.assertRaises(FetchError) as context:
            fetcher.get("https://radim.rs/jobs")
        self.assertEqual(context.exception.state, "robots_disallowed")
        self.assertNotIn("https://radim.rs/jobs/private", fetcher.opener.calls)

    def test_verification_is_reported_without_bypass(self):
        fetcher = self.make_fetcher({"https://radim.rs/robots.txt": "User-agent: *\nAllow: /",
                                     "https://radim.rs/jobs": "<h1>Verify you are human</h1>"})
        with self.assertRaises(FetchError) as context:
            fetcher.get("https://radim.rs/jobs")
        self.assertEqual(context.exception.state, "blocked")


class CollectionTests(unittest.TestCase):
    def test_official_feed_salary_period_and_fields(self):
        body = json.dumps({"has_more": False, "jobs": [
            {"title": "Cleaner", "url": "https://www.klikdoposla.com/oglasi/1-cleaner",
             "employer_public_name": "Example", "locations": ["Beograd"],
             "description_text": "Plata: 71.000 RSD mesečno.", "salary_fixed": 71000,
             "published_at": "2026-10-14", "expires_on": "2026-12-01"},
            {"title": "Daily worker", "url": "https://www.klikdoposla.com/oglasi/2-worker",
             "description_text": "Dnevnica: 3.000 RSD. Isplata jednom mesečno.",
             "salary_fixed": 3000, "working_model": ["Remote"]},
        ]})
        jobs, next_url = parse_feed_jobs(SOURCES["klikdoposla"], body)
        self.assertIsNone(next_url)
        self.assertEqual(jobs[0].salary_min, 71000)
        self.assertEqual(jobs[0].company, "Example")
        self.assertEqual(jobs[0].location, "Beograd")
        self.assertEqual(jobs[0].expires_at, "2026-12-01")
        self.assertIsNone(jobs[1].salary_min)
        self.assertTrue(jobs[1].remote)

    def test_official_feed_pagination_is_bounded(self):
        source = SOURCES["klikdoposla"]
        routes = {}
        for index in range(1, 6):
            current = source.feed_url if index == 1 else source.feed_url + f"?page={index}"
            routes[current] = json.dumps({"has_more": True, "next_page_url": source.feed_url + f"?page={index + 1}",
                                          "jobs": [{"title": f"Role {index}", "url": f"https://www.klikdoposla.com/oglasi/{index}-role"}]})
        fetcher = FakeFetcher(routes)
        jobs, status = collect_source(source, fetcher=fetcher)
        self.assertEqual(len(fetcher.calls), 4)
        self.assertEqual(len(jobs), 4)
        self.assertEqual(status["state"], "partial")
        self.assertTrue(status["feed"])

    def test_feed_external_pagination_rejected(self):
        body = json.dumps({"jobs": [], "has_more": True, "next_page_url": "https://example.com/feed"})
        with self.assertRaises(FetchError):
            parse_feed_jobs(SOURCES["klikdoposla"], body)

    def test_detail_requests_are_bounded(self):
        source = SOURCES["radim"]
        listing = "".join(f'<a href="/jobs/job-{index}">Role {index}</a>' for index in range(10))
        fetcher = FakeFetcher({source.listing_url: listing, **{
            f"https://radim.rs/jobs/job-{index}": structured(title=f"Role {index}", url=f"/jobs/job-{index}")
            for index in range(10)}})
        jobs, status = collect_source(source, detail_limit=2, fetcher=fetcher)
        self.assertEqual(len(jobs), 2)
        self.assertEqual(len(fetcher.calls), 3)
        self.assertEqual(status["discovered"], 10)
        self.assertEqual(status["inspected"], 2)
        self.assertTrue(status["experimental"])

    def test_failure_and_permission_states_are_not_empty_success(self):
        source = SOURCES["radim"]
        jobs, status = collect_source(source, fetcher=FakeFetcher({source.listing_url: FetchError("blocked", "Verification")}))
        self.assertEqual(jobs, [])
        self.assertEqual(status["state"], "blocked")
        self.assertEqual(collect_source(SOURCES["helloworld"])[1]["state"], "requires_permission")

    def test_empty_selection_has_no_network_requests(self):
        self.assertEqual(collect_all([]), ([], {}))


if __name__ == "__main__":
    unittest.main()
