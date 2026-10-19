"""Bounded public crawl checkpoints; callers persist only after a complete upload.

No vacancy content, credentials or user data belongs in this record. URL history
uses SHA-256 digests. A copied/untrusted checkpoint cannot extend the fetcher's
source allowlist or the adapter's accepted detail/cursor patterns.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from urllib.parse import parse_qsl, urlsplit

VERSION = 1
MAX_PENDING = 48
MAX_SEEN = 1000
MAX_URL = 1000
RECHECK_SECONDS = 24 * 60 * 60
HISTORY_SECONDS = 7 * RECHECK_SECONDS


def _public_url(source, value):
    if (not isinstance(value, str) or not 1 <= len(value.encode()) <= MAX_URL
            or any(ord(c) < 33 or ord(c) == 127 for c in value)
            or re.search(r'%(?:0[0-9a-f]|1[0-9a-f]|7f)', value, re.I)):
        return False
    try:
        parsed = urlsplit(value)
        hosts = {(urlsplit(source.url).hostname or '').removeprefix('www.'),
                 *(host.removeprefix('www.') for host in source.api_hosts)}
        return (parsed.scheme == 'https' and (parsed.hostname or '').removeprefix('www.') in hosts
                and not parsed.username and not parsed.password and parsed.port in (None, 443)
                and not parsed.fragment and '\\' not in value
                and not any(re.fullmatch(r'access_?token|api_?key|password|secret|authorization|session', key, re.I)
                            for key, _ in parse_qsl(parsed.query, keep_blank_values=True)))
    except ValueError:
        return False


def listing_cursor(source, value):
    """Only explicit pagination within the configured listing route is resumable."""
    if not _public_url(source, value):
        return False
    parsed, base = urlsplit(value), urlsplit(source.listing_url)
    if parsed.hostname != base.hostname:
        return False
    path = parsed.path.rstrip('/')
    prefix = base.path.rstrip('/')
    if path != prefix and not re.fullmatch(re.escape(prefix) + r'/(?:page|strana)/[1-9]\d{0,5}', path):
        return False
    return all(key.lower() in {'page', 'p', 'strana', 'offset', 'start', 'limit'}
               and re.fullmatch(r'\d{1,7}', val) for key, val in parse_qsl(parsed.query, keep_blank_values=True))


class CrawlState:
    def __init__(self, source, raw=None, *, now=None, cursor_validator=None, pending_validator=None):
        self.source = source
        self.now = int(time.time() if now is None else now)
        self.cursor_validator = cursor_validator or (lambda value: listing_cursor(source, value))
        if pending_validator is None:
            from sources import is_detail_url
            pending_validator = lambda value: is_detail_url(source, value)
        self.pending_validator = pending_validator
        self.cursor = None
        self.pending = []
        self.history = {}
        self.skipped_known = 0
        raw = raw if isinstance(raw, dict) and raw.get('version') == VERSION else {}
        history = raw.get('seen', {})
        if isinstance(history, dict):
            for digest, stamp in sorted(((k, v) for k, v in history.items()
                    if isinstance(k, str) and re.fullmatch(r'[0-9a-f]{64}', k)
                    and type(v) is int and self.now - HISTORY_SECONDS <= v <= self.now + 300),
                    key=lambda item: item[1], reverse=True)[:MAX_SEEN]:
                self.history[digest] = min(stamp, self.now)
        pending = raw.get('pending', [])
        if isinstance(pending, list):
            for value in pending[:MAX_PENDING]:
                if self.valid_pending(value) and value not in self.pending and self.due(value):
                    self.pending.append(value)
        cursor = raw.get('cursor')
        if self.valid_cursor(cursor):
            self.cursor = cursor

    def valid_pending(self, value):
        return _public_url(self.source, value) and bool(self.pending_validator(value))

    def valid_cursor(self, value):
        return _public_url(self.source, value) and bool(self.cursor_validator(value))

    @staticmethod
    def _digest(url):
        return hashlib.sha256(url.encode()).hexdigest()

    def seen(self, url):
        return self._digest(url) in self.history

    def due(self, url):
        stamp = self.history.get(self._digest(url))
        return stamp is None or self.now - stamp >= RECHECK_SECONDS

    def mark(self, url):
        if not self.valid_pending(url):
            return
        self.history[self._digest(url)] = self.now
        self.pending = [value for value in self.pending if value != url]

    def enqueue(self, urls, *, priority=False):
        added, overflow = [], False
        for url in dict.fromkeys(value for value in urls if isinstance(value, str)):
            if not self.valid_pending(url):
                continue
            if not self.due(url):
                self.skipped_known += 1
                continue
            if url in self.pending or url in added:
                continue
            if len(self.pending) + len(added) >= MAX_PENDING:
                overflow = True
                continue
            added.append(url)
        added.sort(key=self.seen)
        self.pending = added + self.pending if priority else self.pending + added
        return overflow

    def take(self, limit):
        return self.pending[:max(0, min(int(limit), MAX_PENDING))]

    def defer(self, url):
        """Retry failed requests without letting one URL block the next cycle."""
        if url in self.pending:
            self.pending.remove(url)
            self.pending.append(url)

    def checkpoint(self):
        # Validate assignments too: adapters may obtain a new cursor from a page.
        seen = dict(sorted(self.history.items(), key=lambda item: item[1], reverse=True)[:MAX_SEEN])
        result = {'version': VERSION, 'updated_at': self.now,
                  'cursor': self.cursor if self.valid_cursor(self.cursor) else None,
                  'pending': [url for url in self.pending if self.valid_pending(url)][:MAX_PENDING],
                  'seen': seen}
        # Long public URLs must not push the SQLite/RPC record over its budget.
        while len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()) > 90 * 1024 and seen:
            seen.pop(next(reversed(seen)))
        return result
