"""Reviewed collection policy; the full registry remains for historical records."""
import re
import unicodedata
from channel_catalog import CHANNELS

# GitHub collector, 2026-10-17: blocked, unreachable, or permission required.
DISABLED_SITES = {'infostud', 'halooglasi', 'careerjet', 'sale_me', 'jooble', 'helloworld'}
UNAVAILABLE_CHANNELS = {'telegram_serbia_jobs'}  # No readable public history.


def serbian_channel_title(title):
    text = ''.join(c for c in unicodedata.normalize('NFKD', title.casefold())
                   if not unicodedata.combining(c))
    return bool(re.search(
        r'\b(?:серби[яиюи]|србија|србији|serbia|serbii|srbija|srbiji|'
        r'белград[аеу]?|београд[ау]?|belgrade|beograd|'
        r'нови[ -]сад(?:е|у)?|novi[ -]sad|ниш|nis|суботица|subotica|'
        r'крагуевац|крагујевац|kragujevac)\b', text))


ACTIVE_TELEGRAM = {'tg_rabotavserbii', 'tg_radim_serbia'} | {
    'telegram_' + channel for channel, title in CHANNELS.items()
    if serbian_channel_title(title) and 'telegram_' + channel not in UNAVAILABLE_CHANNELS
}


def source_enabled(source_id):
    if source_id.startswith(('tg_', 'telegram_')):
        return source_id in ACTIVE_TELEGRAM
    return source_id not in DISABLED_SITES


def validate_channel_page(html):
    from sources import PageParser, FetchError
    page = PageParser()
    page.feed(html)
    title = page.meta.get('og:title', '')
    if not title:
        raise FetchError('unsupported', 'Название публичного канала недоступно.')
    if not serbian_channel_title(title):
        raise FetchError('excluded', 'Название канала не подтверждает связь с Сербией или её городами.')
