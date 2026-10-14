"""Google Maps links from public vacancy facts; no geocoding requests."""
import re
from html import unescape
from urllib.parse import urlencode, urlsplit


def google_maps_url(value):
    """Accept only known Google Maps HTTPS destinations, without credentials."""
    if not isinstance(value, str) or len(value) > 2048:
        return ''
    value = unescape(value).strip()
    try:
        parts = urlsplit(value)
        if parts.scheme != 'https' or parts.username or parts.password or parts.port not in (None, 443):
            return ''
        if any(ord(c) < 32 for c in value) or any(c in value for c in '<>"'):
            return ''
        host = parts.hostname
        allowed = (host in {'google.com', 'www.google.com'} and
                   (parts.path == '/maps' or parts.path.startswith('/maps/')))
        allowed |= host == 'maps.google.com'
        allowed |= host == 'maps.app.goo.gl' and len(parts.path) > 1
        allowed |= host == 'goo.gl' and parts.path.startswith('/maps/')
        return value if allowed else ''
    except ValueError:
        return ''


def coordinates(value):
    match = re.fullmatch(r'\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*', str(value))
    if match and -90 <= float(match[1]) <= 90 and -180 <= float(match[2]) <= 180:
        return f'{float(match[1]):g},{float(match[2]):g}'
    return ''


def job_map_url(job):
    location = str(job.get('location') or '').strip()
    description = str(job.get('description') or '')
    for value in (location, *re.findall(r'https://[^\s<>"\']+', description)):
        url = google_maps_url(value.rstrip('.,;'))
        if url:
            return url
    point = coordinates(location)
    if point:
        return 'https://www.google.com/maps/search/?' + urlencode({'api': '1', 'query': point})
    # A city plus "remote/hybrid" is still a useful location. Pure work models,
    # unknown placeholders and arbitrary URLs must not become map searches.
    if not location or len(location) > 500 or '://' in location:
        return ''
    terms = re.split(r'[,|/;·]', location.casefold().replace('ё', 'е'))
    unknown = re.compile(r'^(?:remote(?: work)?|fully remote|worldwide|anywhere|online|'
                         r'удаленно|удаленная работа|гибрид|hybrid|rad od kuće|rad od kuce|'
                         r'не указан[оа]?|место не указано|n/?a|unknown|—|-)$')
    terms = [term.strip() for term in terms if term.strip()]
    if terms and all(unknown.fullmatch(term) for term in terms):
        return ''
    query = location
    # Use a known country; otherwise leave the public address untouched.
    if job.get('country') in {'RS', 'Serbia', 'Srbija', 'Сербия'} or re.search(
            r'(?i)\b(?:belgrade|beograd|белград|београд|novi sad|нови сад|niš|nis|ниш|subotica|суботица)\b', location):
        if not re.search(r'(?i)\b(?:serbia|srbija|србија|сербия|rs)\b', location):
            query += ', Serbia'
    return 'https://www.google.com/maps/search/?' + urlencode({'api': '1', 'query': query})
