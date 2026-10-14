"""Store contract tests against an in-memory PostgREST transport.

No Supabase account or network access is needed. Transport tests separately
check credentials and redaction using the actual urllib request builder.
"""

from copy import deepcopy
from dataclasses import dataclass
import io
import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from cloud_store import SupabaseStore
from store import SOURCE_IDS, default_settings


@dataclass
class SampleJob:
    source: str = "poslovi"
    url: str = "https://poslovi.rs/job/123"
    title: str = "Python developer"
    company: str = "Example"
    location: str = "Beograd"
    description: str = "Remote work, Russian language welcome"
    salary_min: int = 1500
    salary_currency: str = "EUR"
    remote: bool | None = True
    russian: bool | None = True
    serbian_required: bool | None = None
    published_at: str | None = None
    expires_at: str | None = None


class MemorySupabaseStore(SupabaseStore):
    """Small transport fake implementing the PostgREST operations under test."""

    def __init__(self):
        super().__init__("https://example.supabase.co", "sb_secret_test_only")
        self.tables = {name: [] for name in (
            "sj_users", "sj_jobs", "sj_favorites", "sj_deliveries", "sj_source_status",
        )}
        self.calls = []
        self.next_job_id = 1
        self.default_counter = 0

    @staticmethod
    def _matches(row, params):
        for field, value in params.items():
            if field in {"select", "order", "limit", "offset", "on_conflict"}:
                continue
            if value.startswith("eq."):
                if str(row.get(field)) != value[3:]:
                    return False
            elif value.startswith("in.("):
                choices = value[4:-1].split(",")
                if str(row.get(field)) not in [item.strip('"') for item in choices]:
                    return False
            else:
                raise AssertionError(f"Unsupported fake query operator: {value}")
        return True

    def _default_row(self, table, payload):
        self.default_counter += 1
        timestamp = f"2026-10-14T07:00:{self.default_counter % 60:02d}+00:00"
        if table == "sj_users":
            defaults = {"settings": default_settings(), "last_notified_at": None,
                        "created_at": timestamp, "updated_at": timestamp}
        elif table == "sj_jobs":
            defaults = {"id": self.next_job_id, "created_at": timestamp,
                        "updated_at": timestamp}
            self.next_job_id += 1
        elif table == "sj_favorites":
            defaults = {"created_at": timestamp}
        elif table == "sj_deliveries":
            defaults = {"delivered_at": timestamp}
        else:
            defaults = {}
        defaults.update(deepcopy(payload))
        return defaults

    def _request(self, method, table, params=None, data=None, prefer=None):
        params = dict(params or {})
        self.calls.append({"method": method, "table": table, "params": deepcopy(params),
                           "data": deepcopy(data), "prefer": prefer})
        if table == 'rpc/sj_patch_settings':
            rows=self.tables['sj_users']
            row=next((r for r in rows if r['user_id']==data['p_user_id']),None)
            if row is None:
                row=self._default_row('sj_users',{'user_id':data['p_user_id'],'chat_id':data['p_user_id'],'settings':deepcopy(data['p_defaults'])})
                rows.append(row)
            row['settings'].update(deepcopy(data['p_patch']))
            return deepcopy(row['settings'])
        rows = self.tables[table]
        selected = [row for row in rows if self._matches(row, params)]
        if method == "GET":
            for clause in reversed(params.get("order", "").split(",")):
                if clause:
                    field, _, direction = clause.partition(".")
                    selected.sort(key=lambda row: row.get(field) or "",
                                  reverse=direction == "desc")
            offset = int(params.get("offset", 0))
            limit = int(params.get("limit", len(selected)))
            selected = selected[offset:offset + limit]
            projection = params.get("select", "*")
            if projection == "sj_jobs(*)":
                return [{"sj_jobs": deepcopy(next(job for job in self.tables["sj_jobs"]
                                                  if job["id"] == row["job_id"]))}
                        for row in selected]
            if projection != "*":
                return [{field: deepcopy(row.get(field)) for field in projection.split(",")}
                        for row in selected]
            return deepcopy(selected)
        if method == "POST":
            key_fields = params.get("on_conflict") or {
                "sj_users": "user_id", "sj_jobs": "source,url",
                "sj_favorites": "user_id,job_id", "sj_deliveries": "user_id,job_id",
                "sj_source_status": "source",
            }[table]
            key_fields = key_fields.split(",")
            changed = []
            for payload in data if isinstance(data, list) else [data]:
                existing = next((row for row in rows if all(
                    row.get(field) == payload.get(field) for field in key_fields)), None)
                if existing is None:
                    existing = self._default_row(table, payload)
                    rows.append(existing)
                elif "ignore-duplicates" in (prefer or ""):
                    continue
                else:
                    existing.update(deepcopy(payload))
                changed.append(existing)
            return deepcopy(changed) if "return=representation" in (prefer or "") else None
        if method == "PATCH":
            for row in selected:
                row.update(deepcopy(data))
            return deepcopy(selected) if "return=representation" in (prefer or "") else None
        if method == "DELETE":
            selected_ids = {id(row) for row in selected}
            self.tables[table] = [row for row in rows if id(row) not in selected_ids]
            if table == "sj_users":
                deleted_users = {row["user_id"] for row in selected}
                for child in ("sj_favorites", "sj_deliveries"):
                    self.tables[child] = [row for row in self.tables[child]
                                          if row["user_id"] not in deleted_users]
            return None
        raise AssertionError(f"Unsupported fake request method: {method}")


class SupabaseStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = MemorySupabaseStore()
        self.store.ensure_user(1, 101)
        self.store.ensure_user(2, 202)

    def job_id(self):
        self.store.save_jobs([SampleJob()])
        return self.store.list_jobs()[0]["id"]

    def test_delivered_job_ids_are_scoped_and_paged_for_one_user(self):
        self.store.tables["sj_deliveries"] = [
            {"user_id": 1, "job_id": job_id} for job_id in range(1, 1003)
        ] + [{"user_id": 2, "job_id": 9999}]
        self.store.calls.clear()
        self.assertEqual(self.store.delivered_job_ids(1), set(range(1, 1003)))
        reads = [call for call in self.store.calls if call["table"] == "sj_deliveries"]
        self.assertEqual(len(reads), 2)
        self.assertTrue(all(call["params"]["select"] == "job_id" for call in reads))
        self.assertTrue(all(call["params"]["user_id"] == "eq.1" for call in reads))
        self.assertEqual(self.store.delivered_job_ids(2), {9999})

    def test_ensure_user_preserves_preferences_and_updates_only_the_right_chat(self):
        self.store.update_settings(1, keywords=["Python"], notifications="daily")
        self.store.mark_notified(1, "2026-10-14T07:00:00+00:00")
        original = deepcopy(self.store.tables["sj_users"][0])
        self.store.ensure_user(1, 111)
        settings = self.store.get_settings(1)
        self.assertEqual(settings["keywords"], ["Python"])
        self.assertEqual(settings["notifications"], "daily")
        self.assertEqual(self.store.tables["sj_users"][0]["created_at"], original["created_at"])
        self.assertEqual(self.store.subscribers()[0]["last_notified_at"], original["last_notified_at"])
        self.assertEqual([user["chat_id"] for user in self.store.subscribers()], [111, 202])
        self.store.update_settings(1, city="Novi Sad")
        self.assertEqual(self.store.subscribers()[0]["chat_id"], 111)

    def test_defaults_and_mutable_settings_are_isolated(self):
        first = self.store.get_settings(1)
        self.assertEqual(first["sources"], list(SOURCE_IDS))
        self.assertEqual(first["notifications"], "off")
        self.assertIsNone(first["pending_input"])
        self.assertEqual(first["webhook_update_ids"], [])
        first["keywords"].append("returned value only")
        self.assertEqual(self.store.get_settings(1)["keywords"], [])
        self.store.update_settings(1, pending_input="keywords", keywords=["Python"])
        self.assertEqual(self.store.get_settings(2)["keywords"], [])
        self.assertIsNone(self.store.get_settings(2)["pending_input"])
        missing = self.store.get_settings(999)
        missing["sources"].clear()
        self.assertEqual(self.store.get_settings(998)["sources"], list(SOURCE_IDS))

    def test_unknown_settings_fail_before_any_mutation(self):
        self.store.calls.clear()
        with self.assertRaises(ValueError):
            self.store.update_settings(1, city="Novi Sad", nonexistent=True)
        self.assertFalse(any(call["method"] != "GET" for call in self.store.calls))
        self.assertEqual(self.store.get_settings(1)["city"], "any")

    def test_update_settings_can_create_user_without_resetting_existing_users(self):
        self.store.update_settings(3, keywords=["QA"])
        self.assertEqual(self.store.get_settings(3)["keywords"], ["QA"])
        self.assertEqual(self.store.subscribers()[-1]["chat_id"], 3)
        self.assertEqual(self.store.subscribers()[0]["chat_id"], 101)

    def test_job_upsert_preserves_backend_id_created_time_and_user_state(self):
        self.assertEqual(self.store.save_jobs([SampleJob()]), 1)
        initial = self.store.list_jobs()[0]
        job_id = initial["id"]
        self.store.set_favorite(1, job_id, True)
        self.store.mark_delivered(1, job_id)
        self.assertEqual(self.store.save_jobs([
            SampleJob(title="Senior Python developer", remote=False)]), 0)
        updated = self.store.get_job(job_id)
        self.assertEqual(updated["title"], "Senior Python developer")
        self.assertFalse(updated["remote"])
        self.assertIsNone(updated["serbian_required"])
        self.assertEqual(updated["created_at"], initial["created_at"])
        self.assertEqual(self.store.favorites(1)[0]["id"], job_id)
        self.assertTrue(self.store.has_delivered(1, job_id))
        writes = [call for call in self.store.calls
                  if call["table"] == "sj_jobs" and call["method"] == "POST"]
        self.assertTrue(writes)
        for call in writes:
            for payload in call["data"] if isinstance(call["data"], list) else [call["data"]]:
                self.assertNotIn("id", payload)
                self.assertNotIn("created_at", payload)

    def test_duplicate_canonical_urls_count_once_and_different_sources_count_separately(self):
        self.assertEqual(self.store.save_jobs([
            SampleJob(), SampleJob(title="Updated title"), SampleJob(source="careerjet")]), 2)
        self.assertEqual(len(self.store.list_jobs()), 2)
        poslovi = next(job for job in self.store.list_jobs() if job["source"] == "poslovi")
        self.assertEqual(poslovi["title"], "Updated title")
        self.assertEqual(self.store.save_jobs([SampleJob(), SampleJob()]), 0)

    def test_invalid_batch_is_rejected_before_any_backend_mutation(self):
        self.store.calls.clear()
        with self.assertRaises(ValueError):
            self.store.save_jobs(iter([
                SampleJob(), {"source": "poslovi", "url": "", "title": "Bad"},
            ]))
        self.assertFalse(any(call["method"] != "GET" for call in self.store.calls))
        self.assertEqual(self.store.list_jobs(), [])

    def test_empty_batch_avoids_requests_and_caller_cannot_replace_generated_fields(self):
        self.store.calls.clear()
        self.assertEqual(self.store.save_jobs([]), 0)
        self.assertEqual(self.store.calls, [])
        self.store.save_jobs([{"source": "poslovi", "url": "https://poslovi.rs/job/1",
                               "title": "Developer", "id": 9999,
                               "created_at": "2000-01-01T00:00:00+00:00"}])
        row = self.store.list_jobs()[0]
        self.assertNotEqual(row["id"], 9999)
        self.assertNotEqual(row["created_at"], "2000-01-01T00:00:00+00:00")

    def test_favorites_and_delivery_are_per_user_and_idempotent(self):
        job_id = self.job_id()
        for _ in range(2):
            self.store.set_favorite(1, job_id, True)
            self.store.mark_delivered(1, job_id)
        self.assertEqual(len(self.store.favorites(1)), 1)
        self.assertEqual(self.store.favorites(2), [])
        self.assertTrue(self.store.has_delivered(1, job_id))
        self.assertFalse(self.store.has_delivered(2, job_id))
        self.store.set_favorite(2, job_id, True)
        self.store.set_favorite(1, job_id, False)
        self.assertEqual(self.store.favorites(1), [])
        self.assertEqual(len(self.store.favorites(2)), 1)

    def test_source_status_and_notification_timestamps_are_preserved(self):
        timestamp = "2026-10-14T07:00:00+00:00"
        self.store.mark_notified(1, timestamp)
        self.assertEqual(self.store.subscribers()[0]["last_notified_at"], timestamp)
        self.assertIsNone(self.store.subscribers()[1]["last_notified_at"])
        self.store.set_source_status({"poslovi": {"ok": True, "count": 2},
                                      "jooble": {"ok": False}})
        self.store.set_source_status({"poslovi": {"ok": True, "count": 3}})
        self.assertEqual(self.store.source_status()["poslovi"]["count"], 3)
        self.assertFalse(self.store.source_status()["jooble"]["ok"])

    def test_delete_user_cascades_personal_rows_and_retains_shared_jobs(self):
        job_id = self.job_id()
        for user_id in (1, 2):
            self.store.set_favorite(user_id, job_id, True)
            self.store.mark_delivered(user_id, job_id)
        self.store.delete_user(1)
        self.assertEqual([row["user_id"] for row in self.store.subscribers()], [2])
        self.assertEqual(self.store.favorites(1), [])
        self.assertFalse(self.store.has_delivered(1, job_id))
        self.assertEqual(len(self.store.list_jobs()), 1)
        self.assertEqual(len(self.store.favorites(2)), 1)
        self.assertTrue(self.store.has_delivered(2, job_id))

    def test_list_jobs_paginates_past_the_postgrest_default_limit(self):
        self.store.tables["sj_jobs"] = [
            {"id": number, "source": "poslovi", "url": f"https://poslovi.rs/job/{number}",
             "title": f"Job {number}", "created_at": "2026-10-14T07:00:00+00:00",
             "remote": None, "russian": None, "serbian_required": None}
            for number in range(1, 1003)
        ]
        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 1002)
        self.assertEqual(len({job["id"] for job in jobs}), 1002)
        pages = [call for call in self.store.calls
                 if call["method"] == "GET" and call["table"] == "sj_jobs"]
        self.assertGreaterEqual(len(pages), 2)
        self.assertTrue(any(int(call["params"].get("offset", 0)) > 0 for call in pages))


class SupabaseTransportTests(unittest.TestCase):
    LEGACY_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.test-signature"

    @staticmethod
    def response(body=b"[]"):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = body
        return response

    def test_constructor_rejects_unsafe_urls_and_header_injection(self):
        for url in ("http://example.supabase.co", "https://user:password@example.supabase.co",
                    "https://example.supabase.co/path", "https://example.supabase.co?key=secret",
                    "https://example.supabase.co#fragment"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                SupabaseStore(url, "sb_secret_test_only")
        for key in ("", "sb_secret_test\r\nAuthorization: injected"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                SupabaseStore("https://example.supabase.co", key)

    def test_legacy_jwt_uses_apikey_and_bearer_headers(self):
        store = SupabaseStore("https://example.supabase.co", self.LEGACY_KEY)
        with patch("cloud_store.urlopen", return_value=self.response()) as open_url:
            self.assertEqual(store._request("GET", "sj_jobs"), [])
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("Apikey"), self.LEGACY_KEY)
        self.assertEqual(request.get_header("Authorization"), f"Bearer {self.LEGACY_KEY}")
        self.assertEqual(request.full_url, "https://example.supabase.co/rest/v1/sj_jobs")

    def test_opaque_secret_uses_apikey_without_invalid_bearer_token(self):
        key = "sb_secret_this-is-not-a-jwt"
        store = SupabaseStore("https://example.supabase.co/", key)
        with patch("cloud_store.urlopen", return_value=self.response()) as open_url:
            store._request("GET", "sj_jobs")
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("Apikey"), key)
        self.assertIsNone(request.get_header("Authorization"))

    def test_http_error_never_reveals_key_or_response_body(self):
        key = "sb_secret_private-test-value"
        sensitive_body = f'{{"message": "private user data {key}"}}'.encode()
        error = HTTPError("https://example.supabase.co", 403, "Forbidden", {},
                          io.BytesIO(sensitive_body))
        store = SupabaseStore("https://example.supabase.co", key)
        with patch("cloud_store.urlopen", side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                store._request("GET", "sj_users")
        message = str(raised.exception)
        self.assertNotIn(key, message)
        self.assertNotIn("private user data", message)
        self.assertIn("403", message)

    def test_network_error_never_reveals_sensitive_reason(self):
        key = "sb_secret_private-test-value"
        store = SupabaseStore("https://example.supabase.co", key)
        with patch("cloud_store.urlopen", side_effect=URLError(f"secret={key}")):
            with self.assertRaises(RuntimeError) as raised:
                store._request("GET", "sj_users")
        self.assertNotIn(key, str(raised.exception))

    def test_invalid_response_does_not_expose_body(self):
        store = SupabaseStore("https://example.supabase.co", "sb_secret_test_only")
        with patch("cloud_store.urlopen", return_value=self.response(b"private non-JSON data")):
            with self.assertRaises(RuntimeError) as raised:
                store._request("GET", "sj_users")
        self.assertNotIn("private non-JSON data", str(raised.exception))
        with patch.object(store, "_request", return_value={"unexpected": "object"}):
            with self.assertRaises(RuntimeError):
                store.list_jobs()

    def test_json_request_preserves_params_and_empty_mutation_response(self):
        store = SupabaseStore("https://example.supabase.co", "sb_secret_test_only")
        params = {"user_id": "eq.1", "select": "settings"}
        with patch("cloud_store.urlopen", return_value=self.response(b"")) as open_url:
            result = store._request("PATCH", "sj_users", params=params,
                                    data={"settings": {"keywords": ["Разработчик"]}},
                                    prefer="return=minimal")
        self.assertIsNone(result)
        self.assertEqual(params, {"user_id": "eq.1", "select": "settings"})
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_method(), "PATCH")
        self.assertEqual(json.loads(request.data), {"settings": {"keywords": ["Разработчик"]}})
        self.assertEqual(request.get_header("Prefer"), "return=minimal")


if __name__ == "__main__":
    unittest.main()
