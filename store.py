"""Persistent multi-user state for the Serbia jobs Telegram bot.

Each method uses a short-lived SQLite connection. Jobs are shared, while filter
settings, saved vacancies, and delivery history belong to a Telegram user.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from typing import Any, Iterable, Mapping


SOURCE_IDS = (
    "poslovi", "workforce", "halooglasi", "careerjet", "sale_me",
    "helloworld", "lakodoposla", "klikdoposla", "jooble", "radim",
    "serbiahub", "ovdejobs", "startit", "bulevar",
)


def default_settings() -> dict[str, Any]:
    """Return fresh containers so one user's changes cannot leak to another."""
    return {
        "keywords": [],
        "exclusions": [],
        "city": "any",
        "remote": "any",
        "language": "any",
        "residence_permit": "any",
        "freshness": "any",
        "min_salary": None,
        "currency": "EUR",
        "include_unknown_salary": True,
        "sources": list(SOURCE_IDS),
        "notifications": "off",
        "daily_hour": 9,
        "pending_input": None,
        "webhook_update_ids": [],
        "hidden_jobs": [],
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    """SQLite-backed users, vacancy cache, and notification bookkeeping."""

    JOB_FIELDS = (
        "source", "url", "title", "company", "location", "description",
        "salary_min", "salary_currency", "remote", "russian",
        "serbian_required", "published_at", "expires_at",
        "languages", "required_languages", "country", "eligible_countries", "contacts", "salary_period", "salary_display", "publication_date_only", "expires_date_only",
    )
    BOOL_FIELDS = ("remote", "russian", "serbian_required", "publication_date_only", "expires_date_only")
    JSON_FIELDS = ("languages", "required_languages", "eligible_countries", "contacts")

    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path == ":memory:":
            raise ValueError("Store needs a file path to preserve data between connections")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    settings TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_notified_at TEXT
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    company TEXT,
                    location TEXT,
                    description TEXT,
                    salary_min REAL,
                    salary_currency TEXT,
                    remote INTEGER,
                    russian INTEGER,
                    serbian_required INTEGER,
                    published_at TEXT,
                    expires_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(source, url)
                );
                CREATE TABLE IF NOT EXISTS favorites (
                    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, job_id)
                );
                CREATE TABLE IF NOT EXISTS deliveries (
                    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                    delivered_at TEXT NOT NULL,
                    PRIMARY KEY (user_id, job_id)
                );
                CREATE TABLE IF NOT EXISTS source_status (
                    source TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at DESC, id DESC);
                """
            )

            existing = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
            for name in self.JSON_FIELDS + ("country", "salary_period", "salary_display", "publication_date_only", "expires_date_only"):
                if name not in existing:
                    conn.execute(f"ALTER TABLE jobs ADD COLUMN {name} {'INTEGER' if name in self.BOOL_FIELDS else 'TEXT'}")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS leases (
                    key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS webhook_events (
                    update_id INTEGER PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0,
                    expires_at REAL NOT NULL, owner TEXT NOT NULL
                );
            """)

    @contextmanager
    def _connection(self):
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @staticmethod
    def _settings(raw: str | None) -> dict[str, Any]:
        settings = default_settings()
        if raw:
            settings.update(json.loads(raw))
        return settings

    @classmethod
    def _job(cls, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        job = dict(row)
        for field in cls.BOOL_FIELDS:
            if job.get(field) is not None:
                job[field] = job[field] in {'1','true','True'} if isinstance(job[field],str) else bool(job[field])
        for field in cls.JSON_FIELDS:
            value = job.get(field)
            job[field] = json.loads(value) if isinstance(value, str) else value
        if job.get('salary_period') is None and job.get('salary_min') is not None:
            job['salary_period'] = 'month'
        return job

    def ensure_user(self, user_id: int, chat_id: int) -> dict[str, Any]:
        now = utc_now()
        with self._connection() as conn:
            conn.execute(
                """INSERT INTO users (user_id, chat_id, settings, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    chat_id = excluded.chat_id, updated_at = excluded.updated_at""",
                (user_id, chat_id, json.dumps(default_settings()), now, now),
            )
            row = conn.execute("SELECT settings FROM users WHERE user_id = ?", (user_id,)).fetchone()
            return self._settings(row['settings'])

    def get_settings(self, user_id: int) -> dict[str, Any]:
        with self._connection() as conn:
            row = conn.execute("SELECT settings FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return self._settings(row["settings"] if row else None)

    def update_settings(self, user_id: int, **kwargs: Any) -> dict[str, Any]:
        unknown = set(kwargs) - set(default_settings())
        if unknown:
            raise ValueError(f"Unknown setting(s): {', '.join(sorted(unknown))}")
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT settings FROM users WHERE user_id = ?", (user_id,)).fetchone()
            settings = self._settings(row["settings"] if row else None)
            settings.update(kwargs)
            now = utc_now()
            conn.execute(
                """INSERT INTO users (user_id, chat_id, settings, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    settings = excluded.settings, updated_at = excluded.updated_at""",
                (user_id, user_id, json.dumps(settings, ensure_ascii=False), now, now),
            )
            return settings

    def save_jobs(self, jobs: Iterable[Any]) -> int:
        """Upsert dataclasses or mappings, returning the number of new vacancies.

        Sources must provide a canonical URL. Updating an existing vacancy keeps
        its integer id, favorites, original ingestion time, and delivery history.
        """
        inserted = 0
        now = utc_now()
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for value in jobs:
                data = asdict(value) if is_dataclass(value) else dict(value)
                for required in ("source", "url", "title"):
                    if not data.get(required):
                        raise ValueError(f"Vacancy requires a nonempty {required}")
                existing = conn.execute(
                    "SELECT id FROM jobs WHERE source = ? AND url = ?",
                    (data["source"], data["url"]),
                ).fetchone()
                values = [json.dumps(data.get(field)) if field in self.JSON_FIELDS and data.get(field) is not None else data.get(field) for field in self.JOB_FIELDS]
                columns = ", ".join(self.JOB_FIELDS)
                placeholders = ", ".join("?" for _ in self.JOB_FIELDS)
                updates = ", ".join(
                    (f"published_at = COALESCE(jobs.published_at, excluded.published_at)" if field == "published_at" else f"publication_date_only = CASE WHEN jobs.published_at IS NOT NULL THEN jobs.publication_date_only ELSE excluded.publication_date_only END" if field == "publication_date_only" else f"{field} = excluded.{field}") for field in self.JOB_FIELDS
                    if field not in ("source", "url")
                )
                conn.execute(
                    f"""INSERT INTO jobs ({columns}, created_at, updated_at)
                    VALUES ({placeholders}, ?, ?)
                    ON CONFLICT(source, url) DO UPDATE SET
                        {updates}, updated_at = excluded.updated_at""",
                    (*values, now, now),
                )
                if existing is None:
                    inserted += 1
        return inserted

    def list_jobs(self) -> list[dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC, id DESC").fetchall()
        return [self._job(row) for row in rows]

    def get_job(self, job_id: int) -> dict[str, Any] | None:
        with self._connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row)

    def set_favorite(self, user_id: int, job_id: int, enabled: bool) -> None:
        with self._connection() as conn:
            if enabled:
                conn.execute(
                    "INSERT OR IGNORE INTO favorites (user_id, job_id, created_at) VALUES (?, ?, ?)",
                    (user_id, job_id, utc_now()),
                )
            else:
                conn.execute("DELETE FROM favorites WHERE user_id = ? AND job_id = ?", (user_id, job_id))

    def favorites(self, user_id: int) -> list[dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute(
                """SELECT jobs.* FROM jobs JOIN favorites ON jobs.id = favorites.job_id
                WHERE favorites.user_id = ? ORDER BY favorites.created_at DESC, jobs.id DESC""",
                (user_id,),
            ).fetchall()
        return [self._job(row) for row in rows]

    def has_delivered(self, user_id: int, job_id: int) -> bool:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM deliveries WHERE user_id = ? AND job_id = ?", (user_id, job_id)
            ).fetchone()
        return row is not None

    def delivered_job_ids(self, user_id: int) -> set[int]:
        with self._connection() as conn:
            rows = conn.execute("SELECT job_id FROM deliveries WHERE user_id = ?", (user_id,)).fetchall()
        return {row["job_id"] for row in rows}

    def mark_delivered(self, user_id: int, job_id: int) -> None:
        with self._connection() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO deliveries (user_id, job_id, delivered_at) VALUES (?, ?, ?)",
                (user_id, job_id, utc_now()),
            )

    def subscribers(self) -> list[dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT user_id, chat_id, settings, last_notified_at FROM users ORDER BY user_id"
            ).fetchall()
        return [
            {
                "user_id": row["user_id"],
                "chat_id": row["chat_id"],
                "settings": self._settings(row["settings"]),
                "last_notified_at": row["last_notified_at"],
            }
            for row in rows
        ]

    def get_subscriber(self, user_id):
        with self._connection() as conn:
            row=conn.execute('SELECT user_id,chat_id,settings,last_notified_at FROM users WHERE user_id=?',(user_id,)).fetchone()
        return dict(row,settings=self._settings(row['settings'])) if row else None

    def mark_notified(self, user_id: int, at_iso: str | None = None) -> None:
        with self._connection() as conn:
            conn.execute(
                "UPDATE users SET last_notified_at = ? WHERE user_id = ?", (at_iso or utc_now(), user_id)
            )

    def set_source_status(self, statuses: Mapping[str, Any]) -> None:
        with self._connection() as conn:
            conn.executemany(
                """INSERT INTO source_status (source, payload) VALUES (?, ?)
                ON CONFLICT(source) DO UPDATE SET payload = excluded.payload""",
                [(source, json.dumps(status, ensure_ascii=False)) for source, status in statuses.items()],
            )

    def source_status(self) -> dict[str, Any]:
        with self._connection() as conn:
            rows = conn.execute("SELECT source, payload FROM source_status ORDER BY source").fetchall()
        return {row["source"]: json.loads(row["payload"]) for row in rows}

    def delete_user(self, user_id: int) -> None:
        """Remove the user's settings, saved vacancies, and delivery history."""
        with self._connection() as conn:
            conn.execute("DELETE FROM users WHERE user_id = ?", (user_id,))


    def acquire_lease(self, key, owner, seconds=900):
        import time
        now = time.time()
        with self._connection() as conn:
            row = conn.execute("""INSERT INTO leases(key,owner,expires_at) VALUES(?,?,?)
                ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
                WHERE leases.expires_at <= ? OR leases.owner = excluded.owner RETURNING owner""",
                (key, owner, now+seconds, now)).fetchone()
        return row is not None

    def release_lease(self, key, owner):
        with self._connection() as conn:
            conn.execute("DELETE FROM leases WHERE key=? AND owner=?", (key, owner))

    def claim_update(self, update_id, owner, seconds=300):
        import time
        now = time.time()
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM webhook_events WHERE completed=1 AND expires_at < ?", (now,))
            existing = conn.execute("SELECT completed, expires_at FROM webhook_events WHERE update_id=?", (update_id,)).fetchone()
            if existing and existing['completed']: return 'completed'
            row = conn.execute("""INSERT INTO webhook_events(update_id,owner,expires_at) VALUES(?,?,?)
                ON CONFLICT(update_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
                WHERE webhook_events.completed=0 AND webhook_events.expires_at <= ? RETURNING owner""",
                (update_id,owner,now+seconds,now)).fetchone()
            return 'claimed' if row else 'busy'

    def finish_update(self, update_id, owner):
        import time
        with self._connection() as conn:
            conn.execute("UPDATE webhook_events SET completed=1,expires_at=? WHERE update_id=? AND owner=?", (time.time()+172800,update_id,owner))

    def release_update(self, update_id, owner):
        with self._connection() as conn:
            conn.execute("DELETE FROM webhook_events WHERE update_id=? AND owner=? AND completed=0", (update_id,owner))


    def renew_update(self, update_id, owner, seconds=600):
        import time
        with self._connection() as conn:
            row=conn.execute('UPDATE webhook_events SET expires_at=? WHERE update_id=? AND owner=? AND completed=0 RETURNING update_id',(time.time()+seconds,update_id,owner)).fetchone()
        return row is not None
