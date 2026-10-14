"""Persistent Supabase/PostgREST storage for the free webhook deployment.

Only the server holds the service role key. All queries are sent over HTTPS,
and failures deliberately omit request URLs, credentials, and response bodies.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, is_dataclass
import json
from typing import Any, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from store import Store, default_settings, utc_now


class CloudStoreError(RuntimeError):
    def __init__(self, message: str, code: int = 0):
        super().__init__(message)
        self.code = code


class SupabaseStore:
    """The Store API backed by private, RLS-enabled Supabase tables."""

    PAGE_SIZE = 1000

    def __init__(self, url: str, service_role_key: str):
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username
                or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise ValueError("SUPABASE_URL must be your project's HTTPS base URL")
        if not service_role_key or any(char in service_role_key for char in "\r\n"):
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")
        self._base = url.rstrip("/") + "/rest/v1/"
        self._key = service_role_key

    def _request(self, method: str, table: str, params=None, data=None, prefer=None):
        query = urlencode(params or {})
        url = self._base + table + ("?" + query if query else "")
        headers = {"apikey": self._key, "Accept": "application/json"}
        # Legacy service-role JWTs use both headers. New sb_secret_ keys belong
        # only in apikey: treating one as a JWT would cause a gateway rejection.
        if self._key.startswith("eyJ"):
            headers["Authorization"] = "Bearer " + self._key
        if prefer:
            headers["Prefer"] = prefer
        payload = None
        if data is not None:
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(url, data=payload, headers=headers, method=method)
        try:
            with urlopen(request, timeout=30) as response:
                body = response.read()
        except HTTPError as error:
            raise CloudStoreError(f"Supabase HTTP error ({error.code})", error.code) from None
        except (URLError, TimeoutError, OSError):
            raise CloudStoreError("Supabase connection failed") from None
        if not body:
            return None
        try:
            return json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise CloudStoreError("Supabase returned an invalid response") from None

    def _rows(self, table: str, params=None) -> list[dict[str, Any]]:
        """Page explicitly: Supabase caps a single response at 1,000 records."""
        rows = []
        while True:
            query = dict(params or {})
            query.update(limit=self.PAGE_SIZE, offset=len(rows))
            page = self._request("GET", table, query) or []
            if not isinstance(page, list):
                raise CloudStoreError("Supabase returned an invalid response")
            rows.extend(page)
            if len(page) < self.PAGE_SIZE:
                return rows

    @staticmethod
    def _settings(raw: Mapping[str, Any] | str | None) -> dict[str, Any]:
        settings = default_settings()
        if raw:
            settings.update(json.loads(raw) if isinstance(raw, str) else deepcopy(raw))
        return settings

    @staticmethod
    def _job(row: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        job = dict(row)
        for field in Store.BOOL_FIELDS:
            if job.get(field) is not None:
                job[field] = bool(job[field])
        if job.get('salary_period') is None and job.get('salary_min') is not None:
            job['salary_period']='month'
        return job

    @staticmethod
    def _in(values) -> str:
        # PostgREST quoted values protect commas and quotes in string filters.
        return "in.(" + ",".join(
            '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'
            for value in values
        ) + ")"

    def ensure_user(self, user_id: int, chat_id: int) -> dict[str, Any]:
        # Omit settings from the upsert: existing preferences must never be reset.
        rows = self._request("POST", "sj_users", {"on_conflict": "user_id", "select": "settings"},
                             {"user_id": user_id, "chat_id": chat_id, "updated_at": utc_now()},
                             prefer="resolution=merge-duplicates,return=representation")
        return self._settings(rows[0].get("settings"))

    def get_settings(self, user_id: int) -> dict[str, Any]:
        rows = self._request("GET", "sj_users",
                             {"user_id": f"eq.{user_id}", "select": "settings", "limit": 1}) or []
        return self._settings(rows[0].get("settings") if rows else None)

    def update_settings(self, user_id: int, **kwargs: Any) -> dict[str, Any]:
        unknown = set(kwargs) - set(default_settings())
        if unknown:
            raise ValueError(f"Unknown setting(s): {', '.join(sorted(unknown))}")
        result = self._request('POST', 'rpc/sj_patch_settings', data={
            'p_user_id': user_id, 'p_patch': kwargs, 'p_defaults': default_settings()})
        return self._settings(result)

    def save_jobs(self, jobs: Iterable[Any]) -> int:
        """Validate first, upsert canonical source/URL pairs, count new pairs.

        The database assigns id and created_at. Neither is in the upsert payload,
        so subsequent collections retain ids, original discovery, and favorites.
        """
        unique = {}
        now = utc_now()
        for value in jobs:
            data = asdict(value) if is_dataclass(value) else dict(value)
            for field in ("source", "url", "title"):
                if not data.get(field):
                    raise ValueError(f"Vacancy requires a nonempty {field}")
            row = {field: data.get(field) for field in Store.JOB_FIELDS}
            row["updated_at"] = now
            unique[(row["source"], row["url"])] = row
        if not unique:
            return 0
        sources = sorted({source for source, _ in unique})
        existing = self._rows("sj_jobs", {"select": "source,url", "source": self._in(sources), "order": "id.asc"})
        existing_pairs = {(row["source"], row["url"]) for row in existing}
        self._request("POST", "sj_jobs", {"on_conflict": "source,url"}, list(unique.values()),
                      prefer="resolution=merge-duplicates,missing=default,return=minimal")
        return len(set(unique) - existing_pairs)

    def list_jobs(self) -> list[dict[str, Any]]:
        return [self._job(row) for row in self._rows("sj_jobs", {"order": "created_at.desc,id.desc"})]

    def get_job(self, job_id: int) -> dict[str, Any] | None:
        rows = self._request("GET", "sj_jobs", {"id": f"eq.{job_id}", "limit": 1}) or []
        return self._job(rows[0] if rows else None)

    def set_favorite(self, user_id: int, job_id: int, enabled: bool) -> None:
        if enabled:
            self._request("POST", "sj_favorites", {"on_conflict": "user_id,job_id"},
                          {"user_id": user_id, "job_id": job_id},
                          prefer="resolution=ignore-duplicates,return=minimal")
        else:
            self._request("DELETE", "sj_favorites", {"user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}"},
                          prefer="return=minimal")

    def favorites(self, user_id: int) -> list[dict[str, Any]]:
        rows = self._rows("sj_favorites", {"user_id": f"eq.{user_id}", "select": "sj_jobs(*)",
                                            "order": "created_at.desc,job_id.desc"})
        return [self._job(row["sj_jobs"]) for row in rows if row.get("sj_jobs")]

    def has_delivered(self, user_id: int, job_id: int) -> bool:
        return bool(self._request("GET", "sj_deliveries",
                                  {"user_id": f"eq.{user_id}", "job_id": f"eq.{job_id}",
                                   "select": "job_id", "limit": 1}))

    def delivered_job_ids(self, user_id: int) -> set[int]:
        rows = self._rows("sj_deliveries", {"user_id": f"eq.{user_id}", "select": "job_id", "order": "job_id.asc"})
        return {row["job_id"] for row in rows}

    def mark_delivered(self, user_id: int, job_id: int) -> None:
        self._request("POST", "sj_deliveries", {"on_conflict": "user_id,job_id"},
                      {"user_id": user_id, "job_id": job_id},
                      prefer="resolution=ignore-duplicates,return=minimal")

    def subscribers(self) -> list[dict[str, Any]]:
        rows = self._rows("sj_users", {"select": "user_id,chat_id,settings,last_notified_at", "order": "user_id.asc"})
        return [{"user_id": row["user_id"], "chat_id": row["chat_id"],
                 "settings": self._settings(row.get("settings")), "last_notified_at": row.get("last_notified_at")}
                for row in rows]

    def get_subscriber(self, user_id):
        rows=self._request('GET','sj_users',{'user_id':f'eq.{user_id}','select':'user_id,chat_id,settings,last_notified_at','limit':1}) or []
        return dict(rows[0],settings=self._settings(rows[0]['settings'])) if rows else None

    def mark_notified(self, user_id: int, at_iso: str | None = None) -> None:
        self._request("PATCH", "sj_users", {"user_id": f"eq.{user_id}"},
                      {"last_notified_at": at_iso or utc_now()}, prefer="return=minimal")

    def set_source_status(self, statuses: Mapping[str, Any]) -> None:
        if statuses:
            self._request("POST", "sj_source_status", {"on_conflict": "source"},
                          [{"source": source, "payload": status} for source, status in statuses.items()],
                          prefer="resolution=merge-duplicates,return=minimal")

    def source_status(self) -> dict[str, Any]:
        rows = self._rows("sj_source_status", {"order": "source.asc"})
        return {row["source"]: row["payload"] for row in rows}

    def delete_user(self, user_id: int) -> None:
        self._request("DELETE", "sj_users", {"user_id": f"eq.{user_id}"}, prefer="return=minimal")


    def acquire_lease(self, key, owner, seconds=900):
        return bool(self._request('POST','rpc/sj_acquire_lease',data={'p_key':key,'p_owner':owner,'p_seconds':seconds}))

    def release_lease(self, key, owner):
        self._request('POST','rpc/sj_release_lease',data={'p_key':key,'p_owner':owner})

    def claim_update(self, update_id, owner, seconds=300):
        return self._request('POST','rpc/sj_claim_update',data={'p_update_id':update_id,'p_owner':owner,'p_seconds':seconds})

    def finish_update(self, update_id, owner):
        self._request('POST','rpc/sj_finish_update',data={'p_update_id':update_id,'p_owner':owner})

    def release_update(self, update_id, owner):
        self._request('POST','rpc/sj_release_update',data={'p_update_id':update_id,'p_owner':owner})

    def readiness(self):
        self._request('GET','sj_jobs',{'select':'languages,country','limit':1})
        # Both additive columns and RPC availability must be present.
        self.release_lease('_readiness','_readiness')


    def renew_update(self, update_id, owner, seconds=600):
        return bool(self._request('POST','rpc/sj_renew_update',data={'p_update_id':update_id,'p_owner':owner,'p_seconds':seconds}))
