"""Bounded, robots-aware vacancy collection with no third-party dependencies.

All adapters are experimental: observed URL patterns are not a guarantee that a
site permits collection or that its HTML remains compatible. JSON-LD is preferred;
a conservative HTML fallback is used only on recognized vacancy detail URLs.
No JavaScript, login, verification challenge or anti-bot bypass is attempted.
"""

from __future__ import annotations

import concurrent.futures
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
import json
import math
import re
import time
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.robotparser import RobotFileParser


USER_AGENT = "SerbiaJobsBot/0.1"
MAX_BYTES = 2_000_000
DEFAULT_DETAIL_LIMIT = 8
REQUEST_TIMEOUT = 10
REQUEST_DELAY = 1.5


@dataclass
class Job:
    source: str
    url: str
    title: str
    company: str = ""
    location: str = ""
    description: str = ""
    salary_min: float | None = None
    salary_currency: str | None = None
    remote: bool | None = None
    russian: bool | None = None
    serbian_required: bool | None = None
    published_at: str | None = None
    expires_at: str | None = None
    languages: list[str] | None = None
    required_languages: list[str] | None = None
    country: str | None = None
    eligible_countries: list[str] | None = None
    contacts: list[str] | None = None
    salary_period: str | None = None
    salary_display: str | None = None
    publication_date_only: bool = False
    expires_date_only: bool = False


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    url: str
    listing_url: str
    detail_patterns: tuple[str, ...]
    note: str = "Экспериментальный адаптер; результат зависит от доступности и разметки сайта."
    requires_permission: bool = False
    observed_links: bool = False
    feed_url: str | None = None


SOURCES: dict[str, Source] = {
    "poslovi": Source("poslovi", "Poslovi.rs", "https://www.poslovi.rs/", "https://www.poslovi.rs/", (r"^/job/[^/]+/[^/]+-\d+/?$",), observed_links=True),
    "workforce": Source("workforce", "Workforce", "https://www.workforce.rs/", "https://www.workforce.rs/oglasi-za-posao/", (r"^/oglas/[^/]+/?$",), observed_links=True),
    "halooglasi": Source("halooglasi", "Halo oglasi", "https://www.halooglasi.com/posao", "https://www.halooglasi.com/posao/ponuda-poslova-pretraga", (r"^/posao/ponuda-poslova-[^/]+/[^/]+/\d+/?$",), observed_links=True),
    "careerjet": Source("careerjet", "Careerjet", "https://www.careerjet.rs/", "https://www.careerjet.rs/", (r"^/jobad/[^/]+/?$",), "При проверке сайт показывал защитную проверку; бот её не обходит."),
    "sale_me": Source("sale_me", "Sale-me", "https://www.sale-me.com/serbia/vacancies", "https://www.sale-me.com/serbia/vacancies", (r"^/serbia/vacancies/[^/]+/?$", r"^/serbia/vacancy/[^/]+/?$"), "Источник не удалось проверить; пути вакансий требуют проверки владельцем."),
    "helloworld": Source("helloworld", "HelloWorld", "https://www.helloworld.rs/", "https://www.helloworld.rs/oglasi-za-posao/", (r"^/konkurs/[^/]+/[^/]+/\d+/?$",), "Сайт требует разрешение на скачивание контента. Автосбор отключён до получения разрешения.", requires_permission=True),
    "lakodoposla": Source("lakodoposla", "Lako do posla", "https://www.lakodoposla.com/", "https://www.lakodoposla.com/", (r"^/oglasi/(?:[^/]+-)?\d+/?$",), "Пути объявлений найдены в поиске, но HTML адаптер требует проверки на сервере.", observed_links=True),
    "klikdoposla": Source("klikdoposla", "Klik do posla", "https://www.klikdoposla.com/", "https://www.klikdoposla.com/", (r"^/oglasi/\d+-[^/]+/?$",), "Официальная JSON-лента для AI из /llms.txt; максимум четыре страницы за один сбор.", observed_links=True, feed_url="https://www.klikdoposla.com/ai/jobs.json"),
    "jooble": Source("jooble", "Jooble Serbia", "https://rs.jooble.org/", "https://rs.jooble.org/posao", (r"^/desc/[^/]+/?$", r"^/jdp/[^/]+/?$"), "Домен исправлен на rs.jooble.org; массовая доступность HTML не подтверждена."),
    "radim": Source("radim", "Radim.rs", "https://radim.rs/", "https://radim.rs/jobs", (r"^/jobs/[^/]+/?$",), observed_links=True),
    "serbiahub": Source("serbiahub", "SerbiaHub", "https://serbiahub.com/jobs", "https://serbiahub.com/jobs", (r"^/detail/jobs/\d+/?$",), observed_links=True),
    "ovdejobs": Source("ovdejobs", "Ovde Jobs", "https://ovdejobs.com/", "https://ovdejobs.com/vacancies/", (r"^/jobs/[^/]+/?$",), observed_links=True),
}


def clean_text(value: object) -> str:
    if value is None:
        return ""
    parser = PageParser()
    parser.feed(str(value))
    return " ".join(parser.text_parts).strip()


class PageParser(HTMLParser):
    """Extract structured data, text lines, headings and links without a browser."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.json_scripts: list[str] = []
        self.links: list[tuple[str, str]] = []
        self.headings: list[tuple[str, str]] = []
        self.text_parts: list[str] = []
        self.lines: list[str] = []
        self.meta: dict[str, str] = {}
        self._script: list[str] | None = None
        self._ignored: list[str] = []
        self._anchor: tuple[str, list[str]] | None = None
        self._heading: tuple[str, list[str]] | None = None
        self._line: list[str] = []

    def _flush(self) -> None:
        line = " ".join(self._line).strip()
        if line:
            self.lines.append(line)
        self._line = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag == "script":
            if (attr.get("type") or "").lower().split(";")[0] == "application/ld+json":
                self._script = []
            self._ignored.append(tag)
            return
        if tag in {"style", "nav", "footer", "noscript", "form"}:
            self._ignored.append(tag)
        if tag == "meta":
            self.meta[attr.get("property") or attr.get("name") or ""] = attr.get("content") or ""
        if self._ignored:
            return
        if tag in {"p", "div", "section", "article", "main", "li", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._flush()
        if tag == "a" and attr.get("href"):
            self._anchor = (attr["href"], [])
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._heading = (tag, [])

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._script is not None:
            self.json_scripts.append("".join(self._script))
            self._script = None
        if tag in self._ignored:
            # Tolerate malformed nested HTML rather than retaining a stale ignore.
            self._ignored = self._ignored[:self._ignored.index(tag)]
            return
        if self._ignored:
            return
        if tag == "a" and self._anchor:
            self.links.append((self._anchor[0], " ".join(self._anchor[1])))
            self._anchor = None
        if self._heading and tag == self._heading[0]:
            self.headings.append((tag, " ".join(self._heading[1])))
            self._heading = None
        if tag in {"p", "div", "section", "article", "main", "li", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._script is not None:
            self._script.append(data)
        if self._ignored:
            return
        value = " ".join(data.split())
        if not value:
            return
        self.text_parts.append(value)
        self._line.append(value)
        if self._anchor:
            self._anchor[1].append(value)
        if self._heading:
            self._heading[1].append(value)

    def close(self) -> None:
        super().close()
        self._flush()


def parse_page(html: str) -> PageParser:
    page = PageParser()
    page.feed(html)
    page.close()
    return page


def canonical_url(url: str) -> str:
    parts = urlsplit(url)
    params = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
              if not key.lower().startswith("utm_") and key.lower() not in {"fbclid", "gclid"}]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", urlencode(params), ""))


def _same_site(source: Source, url: str) -> bool:
    origin_host = (urlsplit(source.url).hostname or "").removeprefix("www.")
    candidate = urlsplit(url)
    return candidate.scheme in {"http", "https"} and (candidate.hostname or "").removeprefix("www.") == origin_host and not candidate.username


def is_detail_url(source: Source, url: str) -> bool:
    return _same_site(source, url) and any(re.search(pattern, urlsplit(url).path, re.I) for pattern in source.detail_patterns)


def discover_links(source: Source, page: PageParser, base_url: str) -> list[str]:
    result: list[str] = []
    for href, _ in page.links:
        url = canonical_url(urljoin(base_url, href))
        if is_detail_url(source, url) and url not in result:
            result.append(url)
    return result


def _job_nodes(value: object) -> Iterable[dict]:
    if isinstance(value, dict):
        types = value.get("@type", [])
        if isinstance(types, str):
            types = [types]
        if any(isinstance(kind, str) and kind.rsplit("/", 1)[-1] == "JobPosting" for kind in types):
            yield value
        for child in value.values():
            if isinstance(child, (list, dict)):
                yield from _job_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from _job_nodes(child)


def _location(value: object) -> str:
    if isinstance(value, list):
        return ", ".join(dict.fromkeys(filter(None, (_location(item) for item in value))))
    if isinstance(value, str):
        return clean_text(value)
    if not isinstance(value, dict):
        return ""
    address = value.get("address", value)
    if isinstance(address, str):
        return clean_text(address)
    if not isinstance(address, dict):
        return ""
    # Country is omitted when a city is supplied so users can filter the city.
    return clean_text(address.get("addressLocality") or address.get("addressRegion") or value.get("name") or address.get("addressCountry"))


def _numeric(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def parse_money_amount(value: str) -> float | None:
    """Accept Serbian/English thousands separators without erasing decimals."""
    compact = re.sub(r"\s", "", value)
    if not re.fullmatch(r"\d+(?:[.,]\d+)*", compact):
        return None
    separators = [match.start() for match in re.finditer(r"[.,]", compact)]
    if not separators:
        return _numeric(compact)
    last = separators[-1]
    fractional_digits = len(compact) - last - 1
    if fractional_digits in {1, 2}:
        integer = re.sub(r"[.,]", "", compact[:last])
        return _numeric(integer + "." + compact[last + 1:])
    if fractional_digits == 3:
        return _numeric(re.sub(r"[.,]", "", compact))
    return None


def _salary(value: object) -> tuple[float | None, str | None]:
    if not isinstance(value, dict):
        return None, None
    currency = value.get("currency")
    currency = str(currency).upper() if currency in {"RSD", "EUR", "USD", "rsd", "eur", "usd"} else None
    amount = value.get("value")
    if isinstance(amount, dict):
        unit = str(amount.get("unitText", "")).upper()
        # Filters use monthly amounts. Hourly/yearly figures must not be silently
        # compared with monthly salary, so ambiguous periods remain unknown.
        if unit not in {"MONTH", "MONTHLY", "MESEČNO", "MESECNO"}:
            return None, currency
        amount = amount.get("minValue", amount.get("value"))
    else:
        return None, currency
    return _numeric(amount), currency


def infer_flags(text: str) -> tuple[bool | None, bool | None, bool | None]:
    """Only explicit evidence sets a flag; absence is always unknown."""
    text = text.casefold()
    from job_metadata import remote_fact
    remote = remote_fact(text)
    russian: bool | None = None
    if re.search(r"russian (?:language|speakers)|ruski(?:m|h)? jezik|русск(?:ий|ого|им) язык|русскоговорящ|русскоязыч", text):
        russian = True
    serbian: bool | None = None
    if re.search(r"serbian (?:language )?(?:is )?not required|no serbian required|сербск\w*(?: язык\w*)? не (?:нужен|требуется|обязателен)|знание сербск\w*(?: язык\w*)? не требуется|bez znanja srpskog", text):
        serbian = False
    elif re.search(r"(?:fluent|must speak) serbian|serbian (?:language )?(?:is )?(?:required|mandatory)|(?:свободн\w*|обязательн\w*) сербск|(?:требуется|обязательно) знание сербск|сербск\w*(?: язык\w*)? (?:обязателен|требуется)|obavezno poznavanje srpskog", text):
        serbian = True
    return remote, russian, serbian


def safe_date(value: object) -> str | None:
    """Invalid source dates must not reject a whole PostgreSQL insert batch."""
    if not isinstance(value, str):
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


def parse_feed_jobs(source: Source, body: str) -> tuple[list[Job], str | None]:
    """Parse KlikDoPosla's documented AI feed; salary period remains explicit."""
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise FetchError("error", "Официальная лента вернула некорректный JSON.") from exc
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
        raise FetchError("error", "Изменился формат официальной ленты вакансий.")
    jobs = []
    for node in data["jobs"][:100]:
        if not isinstance(node, dict):
            continue
        raw_url, title = node.get("url"), clean_text(node.get("title"))
        if not isinstance(raw_url, str) or not title or not is_detail_url(source, raw_url):
            continue
        description = clean_text(node.get("description_text"))[:16000]
        locations = node.get("locations", [])
        if not isinstance(locations, list):
            locations = [locations]
        working_model = node.get("working_model", [])
        if not isinstance(working_model, list):
            working_model = [working_model]
        remote, russian, serbian = infer_flags(title + " " + description + " " + " ".join(str(item) for item in working_model))
        models = {str(item).casefold() for item in working_model}
        if 'hybrid' in models or 'hibrid' in models: remote = False
        elif 'remote' in models: remote = True
        # The feed's salary_fixed field contains daily and hourly amounts too.
        # Only a directly adjacent monthly period permits monthly comparison.
        monthly = re.search(r"([\d][\d\s.,]*)\s*\+?\s*(?:[-–]\s*[\d\s.,]+)?\s*(RSD|EUR|USD)\s*(?:/\s*month|в месяц|mesečno|мес\.)", description, re.I)
        amount, currency = (parse_money_amount(monthly.group(1)), monthly.group(2).upper()) if monthly else (None, None)
        jobs.append(Job(source.id, canonical_url(raw_url), title,
                        clean_text(node.get("employer_public_name")),
                        ", ".join(clean_text(location) for location in locations if location),
                        description, amount, currency, remote, russian, serbian,
                        safe_date(node.get("published_at")),
                        safe_date(node.get("expires_on"))))
    next_url = data.get("next_page_url") if data.get("has_more") else None
    if next_url and (not isinstance(next_url, str) or not _same_site(source, next_url) or urlsplit(next_url).path != urlsplit(source.feed_url or "").path):
        raise FetchError("error", "Официальная лента содержит неподдерживаемую ссылку следующей страницы.")
    from job_metadata import enrich
    return [enrich(job) for job in jobs], next_url


def _structured_job(source: Source, node: dict, page_url: str) -> Job | None:
    title = clean_text(node.get("title"))
    if not title:
        return None
    raw_url = node.get("url")
    url = canonical_url(urljoin(page_url, raw_url)) if isinstance(raw_url, str) else canonical_url(page_url)
    if not _same_site(source, url) or not is_detail_url(source, url):
        return None
    # A listing with several postings must supply individual URLs. Otherwise the
    # listing URL would collapse unrelated jobs into a single stored vacancy.
    if not isinstance(raw_url, str) and not is_detail_url(source, page_url):
        return None
    description = clean_text(node.get("description"))[:16000]
    company = node.get("hiringOrganization") or {}
    if isinstance(company, list):
        company = company[0] if company else {}
    company = clean_text(company.get("name")) if isinstance(company, dict) else clean_text(company)
    remote, russian, serbian = infer_flags(title + " " + description)
    job_location_type = node.get("jobLocationType")
    if isinstance(job_location_type, list):
        job_location_type = " ".join(str(item) for item in job_location_type)
    if str(job_location_type).upper() == "TELECOMMUTE" and not re.search(r"hybrid|hibrid|гибрид", description, re.I):
        remote = True
    salary, currency = _salary(node.get("baseSalary"))
    job = Job(source.id, url, title, company, _location(node.get("jobLocation")), description,
               salary, currency, remote, russian, serbian,
               safe_date(node.get("datePosted")),
               safe_date(node.get("validThrough")))
    from job_metadata import enrich
    return enrich(job, node)


def _label_value(lines: list[str], labels: tuple[str, ...]) -> str:
    for index, line in enumerate(lines):
        normalized = line.casefold().rstrip(":").strip()
        if normalized in labels and index + 1 < len(lines):
            return lines[index + 1]
        for label in labels:
            if line.casefold().startswith(label + ":"):
                return line.split(":", 1)[1].strip()
    return ""


def _html_job(source: Source, page: PageParser, page_url: str) -> Job | None:
    if not is_detail_url(source, page_url):
        return None
    title = next((text for tag, text in page.headings if tag == "h1" and 2 < len(text) < 250), "")
    if not title or title.casefold() in {"jobs", "poslovi", "posao", "vacancies", "вакансии"}:
        return None
    lines = page.lines
    # Detail URLs plus a job-specific section prevent category pages and failed
    # responses from being manufactured into vacancy cards.
    text = "\n".join(lines)
    signals = r"opis (?:posla|pozicije)|uslovi|nudimo|description|requirements|responsibilities|описание вакансии|требования|обязанности|what we offer|apliciraj|конкурс|apply"
    if not re.search(signals, text, re.I):
        return None
    company = ""
    location = _label_value(lines, ("location", "mesto rada", "gradovi", "город", "локация"))
    if source.id == "poslovi":
        company = next((value for tag, value in page.headings if tag == "h5"), "")
    elif source.id == "ovdejobs":
        company = next((value for tag, value in page.headings if tag == "h2" and value.casefold().rstrip(":") not in {"location", "salary", "requirements", "key responsibilities", "what the company offers"}), "")
    elif source.id == "workforce":
        try:
            index = lines.index(title)
            location = lines[index + 1]
        except (ValueError, IndexError):
            pass
    elif source.id == "klikdoposla":
        company = _label_value(lines, ("poslodavac", "postavljen od"))
    elif source.id == "radim":
        company = next((text for href, text in page.links if re.search(r"/compan(?:y|ies)/", href)), "")
        try:
            index = lines.index(title)
            location = re.split(r"Field work|Full-time|Part-time|Hybrid|Remote", lines[index + 1], flags=re.I)[0].strip()
        except (ValueError, IndexError):
            pass
    # Remove site navigation before the vacancy title and recommendations after
    # the description so unrelated jobs cannot contribute filter evidence.
    start = next((index for index, line in enumerate(lines) if line == title), 0)
    end = next((index for index in range(start + 1, len(lines)) if re.search(r"^(?:similar jobs|slični poslovi|pogledajte još|похожие вакансии|new jobs on telegram|find jobs in serbia|nekoliko reči o nama)", lines[index], re.I)), len(lines))
    description = "\n".join(lines[start + 1:end])[:16000]
    remote, russian, serbian = infer_flags(title + " " + description)
    salary_min, currency = None, None
    # Only explicitly monthly salary is comparable to the monthly filter.
    salary_line = _label_value(lines, ("salary", "plata", "зарплата"))
    match = re.search(r"([\d][\d\s.,]*)\s*\+?\s*(?:[-–]\s*[\d\s.,]+)?\s*(RSD|EUR|USD)\s*(?:/\s*month|в месяц|mesečno|мес\.)", salary_line, re.I)
    if match:
        salary_min = parse_money_amount(match.group(1))
        currency = match.group(2).upper()
    if source.id == "radim" and re.search(r"languages\s*\nне требуется", description, re.I):
        serbian = False
    expiry = re.search(r"Ističe:\s*(\d{2}\.\d{2}\.\d{4})", description, re.I)
    expires = None
    if expiry:
        try:
            expires = datetime.strptime(expiry.group(1), "%d.%m.%Y").date().isoformat()
        except ValueError:
            pass
    job = Job(source.id, canonical_url(page_url), title, company, location, description,
               salary_min, currency, remote, russian, serbian, expires_at=expires)
    date_value = (page.meta.get('article:published_time') or page.meta.get('datePublished') or
                  _label_value(lines, ('published', 'published on', 'datum objave', 'objavljeno', 'дата публикации')))
    job.published_at = safe_date(date_value)
    from job_metadata import enrich
    return enrich(job)


def extract_jobs(source: Source, html: str, page_url: str, *, allow_fallback: bool = True) -> list[Job]:
    page = parse_page(html)
    jobs: dict[str, Job] = {}
    for script in page.json_scripts:
        try:
            value = json.loads(script.strip())
        except (ValueError, TypeError):
            # Some publishers entity-encode the entire JSON block. Decode only
            # after normal JSON fails; decoding valid JSON first can break an
            # otherwise valid title containing &quot;.
            try:
                value = json.loads(unescape(script).strip())
            except (ValueError, TypeError):
                continue
        for node in _job_nodes(value):
            job = _structured_job(source, node, page_url)
            if job:
                jobs[job.url] = job
    if not jobs and allow_fallback:
        job = _html_job(source, page, page_url)
        if job:
            jobs[job.url] = job
    return list(jobs.values())


class FetchError(Exception):
    def __init__(self, state: str, detail: str):
        super().__init__(detail)
        self.state = state
        self.detail = detail


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Fetcher:
    """One instance per source, including per-host pacing and robots policy."""

    def __init__(self, source: Source, timeout: float = REQUEST_TIMEOUT, delay: float = REQUEST_DELAY):
        self.source = source
        self.timeout = timeout
        self.delay = delay
        self.deadline = time.monotonic() + 150
        self.opener = build_opener(NoRedirect())
        self.robots: dict[str, RobotFileParser] = {}
        self.last_request: dict[str, float] = {}

    def _pace(self, origin: str, delay: float) -> None:
        remaining = delay - (time.monotonic() - self.last_request.get(origin, -1e9))
        if time.monotonic()+max(remaining,0) > self.deadline:
            raise FetchError('timeout', 'Достигнут лимит времени проверки источника.')
        if remaining > 0:
            time.sleep(remaining)
        self.last_request[origin] = time.monotonic()

    def _raw(self, url: str, *, robot_file: bool = False, redirects: int = 0) -> tuple[str, str]:
        if redirects > 4 or not _same_site(self.source, url):
            raise FetchError("error", "Перенаправление за пределы источника или слишком много перенаправлений.")
        origin = urlunsplit((*urlsplit(url)[:2], "", "", ""))
        delay = self.delay
        if not robot_file:
            policy = self._policy(origin)
            if not policy.can_fetch(USER_AGENT, url):
                raise FetchError("robots_disallowed", "robots.txt запрещает автоматический доступ к этой странице.")
            delay = max(delay, policy.crawl_delay(USER_AGENT) or policy.crawl_delay("*") or 0)
            rate = policy.request_rate(USER_AGENT) or policy.request_rate("*")
            if rate and rate.requests:
                delay = max(delay, rate.seconds / rate.requests)
            if delay > 60:
                raise FetchError("robots_disallowed", "robots.txt требует слишком редкие запросы для текущего сборщика.")
        self._pace(origin, delay)
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.8"})
        try:
            with self.opener.open(request, timeout=min(self.timeout, max(0.1,self.deadline-time.monotonic()))) as response:
                if response.headers.get("Content-Encoding", "identity") not in {"identity", ""}:
                    raise FetchError("error", "Неожиданное сжатие ответа; данные не разобраны.")
                content_type = response.headers.get("Content-Type", "")
                if not robot_file and content_type and not any(kind in content_type.lower() for kind in ("html", "text/plain", "application/json", "javascript")):
                    raise FetchError("error", "Источник вернул неподдерживаемый формат.")
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise FetchError("error", "Страница превышает ограничение размера.")
                charset = response.headers.get_content_charset() or "utf-8"
                try:
                    body = raw.decode(charset, errors="replace")
                except LookupError:
                    body = raw.decode("utf-8", errors="replace")
                return body, canonical_url(url)
        except HTTPError as exc:
            if exc.code in {301, 302, 303, 307, 308} and exc.headers.get("Location"):
                return self._raw(urljoin(url, exc.headers["Location"]), robot_file=robot_file, redirects=redirects + 1)
            if robot_file and exc.code in {404, 410}:
                return "User-agent: *\nAllow: /", url
            state = "blocked" if exc.code in {401, 403, 429} else "error"
            raise FetchError(state, f"HTTP {exc.code}; автоматический доступ не подтверждён.") from exc
        except (URLError, TimeoutError, OSError) as exc:
            # Do not print proxy credentials, full request URLs or response data.
            raise FetchError("error", f"Сетевой запрос не выполнен ({type(exc).__name__}).") from exc

    def _policy(self, origin: str) -> RobotFileParser:
        if origin not in self.robots:
            try:
                body, _ = self._raw(origin + "/robots.txt", robot_file=True)
                if "<html" in body.casefold() or "<!doctype" in body.casefold():
                    raise FetchError("robots_unavailable", "robots.txt вернул HTML вместо правил; сбор приостановлен.")
                policy = RobotFileParser(origin + "/robots.txt")
                policy.parse(body.splitlines())
                self.robots[origin] = policy
            except FetchError as exc:
                if exc.state in {"blocked", "robots_unavailable"}:
                    raise
                raise FetchError("robots_unavailable", "Не удалось проверить robots.txt; сбор приостановлен.") from exc
        return self.robots[origin]

    def get(self, url: str) -> tuple[str, str]:
        body, final_url = self._raw(url)
        beginning = clean_text(body)[:1800].casefold()
        if any(marker in beginning for marker in ("potrebna je verifikacija", "verify you are human", "checking your browser", "just a moment", "access denied", "не робот", "unusual traffic")):
            raise FetchError("blocked", "Источник показывает защитную проверку; бот её не обходит.")
        return body, final_url


def _status(source: Source, state: str, count: int = 0, detail: str = "", **extra) -> dict:
    return {"state": state, "count": count, "detail": detail, "url": source.url,
            "checked_at": datetime.now(timezone.utc).isoformat(), "experimental": True,
            "observed_links": source.observed_links, **extra}


def collect_source(source: Source, *, detail_limit: int = DEFAULT_DETAIL_LIMIT, fetcher: Fetcher | None = None) -> tuple[list[Job], dict]:
    if source.requires_permission:
        return [], _status(source, "requires_permission", detail=source.note)
    fetcher = fetcher or Fetcher(source)
    if source.id == 'serbiahub':
        return _collect_serbiahub(source, fetcher)
    if source.feed_url:
        return _collect_feed(source, fetcher)
    jobs: dict[str, Job] = {}
    errors: list[str] = []
    error_states: list[str] = []
    try:
        html, listing_url = fetcher.get(source.listing_url)
        for job in extract_jobs(source, html, listing_url, allow_fallback=False):
            jobs[job.url] = job
        links = discover_links(source, parse_page(html), listing_url)
    except FetchError as exc:
        return [], _status(source, exc.state, detail=exc.detail)
    # Follow at most one explicit same-site next listing page, sharing the
    # original detail budget. No guessing query parameters or unbounded crawl.
    page = parse_page(html)
    next_url = next((canonical_url(urljoin(listing_url, href)) for href,label in page.links
                     if re.fullmatch(r'next(?: page)?|sledeća|sledeca|следующая|→|»', label.strip(), re.I)
                     and _same_site(source,urljoin(listing_url,href))
                     and not is_detail_url(source,urljoin(listing_url,href))), None)
    listing_pages = 1
    if next_url and next_url != listing_url:
        try:
            extra, extra_url = fetcher.get(next_url)
            listing_pages += 1
            for job in extract_jobs(source,extra,extra_url,allow_fallback=False): jobs[job.url]=job
            links = list(dict.fromkeys(links + discover_links(source,parse_page(extra),extra_url)))
        except FetchError as exc:
            errors.append(exc.detail); error_states.append(exc.state)
    inspected = 0
    for url in links[:max(0, min(detail_limit, 50))]:
        if url in jobs:
            continue
        inspected += 1
        try:
            detail_html, detail_url = fetcher.get(url)
            for job in extract_jobs(source, detail_html, detail_url):
                jobs[job.url] = job
        except FetchError as exc:
            errors.append(exc.detail)
            error_states.append(exc.state)
            if exc.state in {"blocked", "robots_unavailable"}:
                break
    if jobs:
        state = "partial" if errors else "ok"
        detail = "Частичная проверка: до двух страниц списка, без обхода всей истории."
        if errors:
            detail += " " + errors[0]
    elif not links and re.search(r'<script[^>]*src=', html, re.I) and len(parse_page(html).lines)<5:
        state = 'unsupported'
        detail = 'Страница загружается JavaScript; разрешённый публичный API пока не подтверждён.'
    elif errors:
        state = error_states[0]
        detail = errors[0]
    else:
        state = "empty"
        detail = "Объявления не извлечены. Это может быть изменение разметки, JavaScript или отсутствие вакансий; адаптер требует проверки."
    from filters import active, serbia_eligible
    parsed_count = len(jobs)
    jobs = {url: job for url,job in jobs.items() if active(job.__dict__) and serbia_eligible(job.__dict__)}
    if parsed_count > len(jobs):
        detail += f' Отсеяно {parsed_count-len(jobs)} истёкших или явно не подходящих по стране объявлений.'
    return list(jobs.values()), _status(source, state if jobs or state not in {'ok','partial'} else 'empty', len(jobs), detail, discovered=len(links), inspected=inspected, listing_pages=listing_pages, parsed_count=parsed_count)


def _collect_feed(source: Source, fetcher: Fetcher) -> tuple[list[Job], dict]:
    jobs: dict[str, Job] = {}
    seen: set[str] = set()
    url = source.feed_url
    try:
        while url and url not in seen and len(seen) < 4:
            seen.add(url)
            body, _ = fetcher.get(url)
            page_jobs, url = parse_feed_jobs(source, body)
            from filters import active, serbia_eligible
            jobs.update((job.url, job) for job in page_jobs if active(job.__dict__) and serbia_eligible(job.__dict__))
    except FetchError as exc:
        return list(jobs.values()), _status(source, "partial" if jobs else exc.state, len(jobs), exc.detail,
                                           feed=True, inspected=len(seen))
    state = "ok" if jobs else "empty"
    detail = f"Официальная JSON-лента: проверено страниц {len(seen)}."
    if url:
        state = "partial" if jobs else "empty"
        detail += " Достигнуто ограничение: максимум четыре страницы за сбор."
    return list(jobs.values()), _status(source, state, len(jobs), detail, feed=True, inspected=len(seen))


def collect_all(enabled: Iterable[str] | None = None) -> tuple[list[Job], dict[str, dict]]:
    """Collect selected source IDs synchronously; use asyncio.to_thread in a bot.

    HTML crawl visits one listing and at most eight detail pages per source. The
    official KlikDoPosla feed is limited to four pages. Selection is explicit:
    an empty iterable means collect nothing, not every source.
    """
    ids = list(SOURCES) if enabled is None else list(dict.fromkeys(enabled))
    statuses: dict[str, dict] = {}
    jobs: dict[tuple[str, str], Job] = {}
    selected = [SOURCES[source_id] for source_id in ids if source_id in SOURCES]
    for source_id in ids:
        if source_id not in SOURCES:
            statuses[source_id] = {"state": "error", "count": 0, "detail": "Неизвестный источник.", "experimental": True}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(collect_source, source): source for source in selected}
        for future in concurrent.futures.as_completed(futures):
            source = futures[future]
            try:
                found, status = future.result()
            except Exception as exc:
                found, status = [], _status(source, "error", detail=f"Не удалось разобрать источник ({type(exc).__name__}).")
            statuses[source.id] = status
            for job in found:
                jobs[(job.source, job.url)] = job
    return list(jobs.values()), statuses


def _collect_serbiahub(source, fetcher):
    """Public anonymous API used by the site's frontend (not a private API)."""
    from job_metadata import enrich, text_salary, valid_job_url
    from filters import active, serbia_eligible
    jobs = {}
    pages = 0
    try:
        for offset in (0, 50):
            body, _ = fetcher.get(f'https://serbiahub.com/api/jobs?limit=50&offset={offset}')
            data = json.loads(body)
            if not isinstance(data,dict) or not isinstance(data.get('items'),list):
                raise FetchError('error','Изменился формат публичного API SerbiaHub.')
            pages += 1
            for node in data['items'][:50]:
                if not isinstance(node,dict): continue
                title = clean_text(node.get('title'))
                identity = str(node.get('id',''))
                if not title or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',identity): continue
                url = 'https://serbiahub.com/detail/jobs/' + identity
                job = Job(source.id,url,title,clean_text(node.get('company')),
                          clean_text(node.get('city')),clean_text(node.get('description'))[:16000],
                          published_at=safe_date(node.get('published_at') or node.get('datePosted')),
                          expires_at=safe_date(node.get('expirationDate')))
                job = enrich(job)
                model = str(node.get('workArrangement') or '').casefold()
                if 'hybrid' in model or 'hibrid' in model: job.remote=False
                elif isinstance(node.get('isRemote'),bool): job.remote=node['isRemote']
                language = node.get('languagesReq')
                if isinstance(language,list): language=', '.join(str(v) for v in language)
                if isinstance(language,str):
                    from job_metadata import LANGUAGE_NAMES
                    for code, roots in LANGUAGE_NAMES.items():
                        if any(re.search(r'\b'+root+r'\w*',language,re.I) for root in roots):
                            if code not in job.languages: job.languages.append(code)
                            if code not in job.required_languages: job.required_languages.append(code)
                period = str(node.get('salaryPeriod') or '').casefold()
                if period in ('month','monthly','месяц','mesečno'):
                    job.salary_min=_numeric(node.get('salaryMin'))
                    currency=str(node.get('salaryCurrency') or '').upper()
                    job.salary_currency=currency if currency in ('RSD','EUR','USD') else None
                    job.salary_period='month'
                if node.get('salaryText'): job.salary_display=clean_text(node['salaryText'])[:150]
                if active(job.__dict__) and serbia_eligible(job.__dict__) and valid_job_url(url): jobs[url]=job
            total=data.get('total')
            if len(data['items'])<50 or isinstance(total,int) and offset+50>=total: break
    except (FetchError,ValueError) as error:
        detail=error.detail if isinstance(error,FetchError) else 'Некорректный JSON публичного API.'
        state='partial' if jobs else error.state if isinstance(error,FetchError) else 'error'
        return list(jobs.values()),_status(source,state,len(jobs),detail,inspected=pages,public_api=True)
    return list(jobs.values()),_status(source,'ok' if jobs else 'empty',len(jobs),
        'Публичный API SerbiaHub: не более двух страниц по 50 объявлений; firstSeen не используется как дата публикации.',
        inspected=pages,public_api=True)
