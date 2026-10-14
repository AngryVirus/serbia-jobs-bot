"""On-demand translation of public vacancy text, with bounded memory caching."""
import asyncio
from functools import lru_cache
import json
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class TranslationError(Exception):
    pass


class Translator:
    def __init__(self):
        self._slots = threading.BoundedSemaphore(3)

    @lru_cache(maxsize=256)
    def _chunk(self, text):
        url = 'https://translate.googleapis.com/translate_a/single?' + urlencode(
            {'client': 'gtx', 'sl': 'auto', 'tl': 'ru', 'dt': 't', 'q': text})
        try:
            with self._slots:
                with urlopen(Request(url, headers={'User-Agent': 'SerbiaJobsBot'}), timeout=8) as response:
                    raw = response.read(100_001)
            if len(raw) > 100_000:
                raise ValueError('Oversized response')
            result = json.loads(raw)
            if not isinstance(result, list) or not result or not isinstance(result[0], list):
                raise ValueError('Unexpected response')
            if any(not isinstance(part, list) or not part or not isinstance(part[0], (str, type(None))) for part in result[0]):
                raise ValueError('Unexpected segment')
            translated = ''.join(part[0] for part in result[0] if part[0])
            if not translated.strip():
                raise ValueError('Empty translation')
            return translated
        except (HTTPError, URLError, OSError, ValueError, TypeError, IndexError, KeyError):
            # Never expose URLs, source text or provider response bodies in errors.
            raise TranslationError('Translation service unavailable') from None

    async def translate(self, text):
        if not text.strip():
            return text
        chunks = []
        remaining = text
        while remaining:
            boundary = len(remaining)
            if boundary > 900:
                boundary = remaining.rfind(' ', 0, 901)
                if boundary < 1:
                    boundary = 900
            chunks.append(remaining[:boundary])
            remaining = remaining[boundary:].lstrip()
        parts = await asyncio.gather(*(asyncio.to_thread(self._chunk, part) for part in chunks))
        return '\n'.join(parts)


def browser_translation_url(job):
    from job_metadata import valid_job_url
    if valid_job_url(job.get('url')):
        return 'https://translate.google.com/translate?' + urlencode({'sl': 'auto', 'tl': 'ru', 'u': job['url']})
    text = (str(job.get('title') or '') + '\n' + str(job.get('description') or ''))[:400]
    return 'https://translate.google.com/?' + urlencode({'sl': 'auto', 'tl': 'ru', 'text': text, 'op': 'translate'})
