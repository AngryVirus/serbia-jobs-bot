"""Compact, escaped Telegram panels and keyboards."""
from html import escape
from zoneinfo import ZoneInfo

from filters import (FILTER_OPTIONS, SINGLE_CHOICE_FILTERS, hidden_job_ids,
                     parse_datetime, search_diagnostics, selected_values)
from job_metadata import job_language_facts, valid_job_url
from sources import SOURCES
from addresses import job_address, maps_url, map_buttons

BELGRADE = ZoneInfo('Europe/Belgrade')
HELP_URL = 'https://t.me/AngryVirus'
LANGUAGE_NAMES = {'ru': 'Русский', 'sr': 'Сербский', 'en': 'Английский', 'de': 'Немецкий'}
FILTER_TITLES = {'city': '📍 Города', 'remote': '💻 Формат работы',
                 'language': '🗣 Языки', 'freshness': '🕒 Свежесть',
                 'residence_permit': '🪪 Наличие ВНЖ'}


def button(label, data):
    return {'text': label, 'callback_data': data}


def menu_buttons(settings):
    enabled = settings.get('notifications', 'off') != 'off'
    return [[button('🔎 Найти вакансии', 'search:0')],
            [button('⚙️ Фильтры', 'filters'),
             button('🔔 Уведомления: вкл' if enabled else '🔕 Уведомления: выкл',
                    'notify:off' if enabled else 'notify:instant')],
            [button('🙈 Скрытые вакансии', 'hidden:0'), button('💬 Помощь', 'help')]]


MENU = menu_buttons({})
BACK = [[button('🏠 Главное меню', 'menu')]]
CANCEL = [[button('✖ Отменить ввод', 'cancel')]] + BACK


def clipped(value, limit, keep_lines=False):
    text = ('\n'.join(' '.join(line.split()) for line in str(value or '').splitlines() if line.strip())
            if keep_lines else ' '.join(str(value or '').split()))
    # Telegram entity offsets use UTF-16; astral emoji consume two units.
    if sum(2 if ord(char) > 0xFFFF else 1 for char in text) <= limit:
        return text
    result, size = [], 0
    for char in text:
        size += 2 if ord(char) > 0xFFFF else 1
        if size > limit - 1:
            break
        result.append(char)
    return ''.join(result).rstrip() + '…'


def safe(value, limit, keep_lines=False):
    return escape(clipped(value, limit, keep_lines))


def selection_label(settings, field):
    labels = FILTER_OPTIONS[field]
    legacy = {'no_serbian': 'Без обязательного сербского (прежний фильтр)'}
    return ' · '.join(labels.get(value, legacy.get(value, value))
                      for value in selected_values(settings, field))


def filter_summary(settings, compact=False):
    lines = []
    for field, title in FILTER_TITLES.items():
        active = selected_values(settings, field) != ['any']
        if active or not compact:
            lines.append(f"{'✅' if active else '▫️'} {title}: {safe(selection_label(settings, field), 230)}")
    for field, title in (('keywords', 'Ключевые слова'), ('exclusions', 'Исключения')):
        values = settings.get(field) or []
        if values or not compact:
            lines.append(f"{'✅' if values else '▫️'} {title}: {safe(', '.join(values) or 'Нет', 90 if compact else 950)}")
    minimum = settings.get('min_salary')
    if minimum is not None or not compact:
        salary = f"от {minimum:g} {settings.get('currency', 'EUR')} / месяц" if minimum is not None else 'Любая'
        lines.append(f"{'✅' if minimum is not None else '▫️'} 💶 Зарплата: {escape(salary)}")
    if not settings.get('include_unknown_salary', True) or not compact:
        lines.append('▫️ Без зарплаты: показывать' if settings.get('include_unknown_salary', True)
                     else '✅ Без зарплаты: скрывать')
    return '\n'.join(lines) or '🔎 Все вакансии · вся Сербия'


def menu_text(settings, start=False):
    mode = 'выключены' if settings.get('notifications', 'off') == 'off' else 'включены — новые вакансии'
    text = '<b>🇷🇸 Работа в Сербии</b>\n<i>SERBIA JOBS</i>\n\n'
    text += '<b>Ваша подборка</b>\n<blockquote>' + filter_summary(settings, compact=True) + '</blockquote>'
    text += f'\n\n🔔 Уведомления: {mode}\n🙈 Скрытые вакансии: {len(hidden_job_ids(settings))}'
    text += ('\n\n<b>«Найти вакансии»</b> — листать предложения.\n'
             'В <b>«Фильтрах»</b> выберите города, языки и условия работы.')
    return text


def choice_panel(settings, field):
    selected = selected_values(settings, field)
    single = field in SINGLE_CHOICE_FILTERS
    text = (f'<b>{FILTER_TITLES[field]}</b>\n\n'
            f'<blockquote>Выбрано: {safe(selection_label(settings, field), 250)}</blockquote>\n\n')
    text += ('Выберите один вариант. ' if single else
             'Можно отметить несколько вариантов. Подойдёт любой из выбранных. ')
    text += 'Изменения сохраняются сразу.'
    if field == 'freshness':
        text += '\nПериоды объединяются: «7 дней» уже включает сегодня и вчера.'
        text += '\nОбъявления без даты доступны при выборе «Не важно».'
    elif field == 'language':
        text += '\nУчитываются явно указанные языковые требования, а не язык текста объявления.'
    elif field == 'remote':
        text += '\nЕсли формат не указан, объявление доступно при выборе «Любой формат».'
    elif field == 'residence_permit':
        text += ('\n\nУчитывается требование работодателя в объявлении.\n'
                 '<b>Да</b> — наличие ВНЖ обязательно.\n'
                 '<b>Нет</b> — явно указано, что ВНЖ не требуется.\n'
                 '<b>Не важно</b> — все вакансии, в том числе без информации о ВНЖ.\n\n'
                 'Помощь с оформлением ВНЖ сама по себе не означает, что можно работать без него.')
    rows = [[button(('✅ ' if value in selected else '▫️ ') + label,
                    f'choose:{field}:{value}:{0 if not single and value in selected and value != "any" else 1}')]
            for value, label in FILTER_OPTIONS[field].items()]
    rows += [[button('✓ Готово', 'filters')]] + BACK
    return text, rows


def empty_search_text(jobs, settings, now=None):
    diagnostics = search_diagnostics(jobs, settings, now)
    text = '<b>Подходящих вакансий нет по выбранным условиям.</b>\n\n'
    text += filter_summary(settings, compact=True)
    if not diagnostics['available']:
        if hidden_job_ids(settings):
            text += '\n\nДействующих вакансий вне вашего списка скрытых сейчас нет.'
        else:
            text += '\n\nСейчас в базе нет доступных действующих объявлений. Попробуйте позже.'
        return text
    text += f'\n\nБез ограничений ваших фильтров доступно: {diagnostics["available"]}.'
    labels = {'freshness': 'Свежесть', 'language': 'Языки', 'remote': 'Формат работы',
              'city': 'Города', 'keywords': 'Ключевые слова', 'exclusions': 'Исключения',
              'salary': 'Зарплата', 'residence_permit': 'Наличие ВНЖ'}
    if diagnostics['relaxed']:
        text += '\nМожно изменить в фильтрах:'
        for item in diagnostics['relaxed'][:2]:
            text += f'\n• Без ограничения «{labels[item["field"]]}» — {item["count"]}.'
    else:
        text += '\nНужно расширить несколько условий: изменение только одного не даёт совпадений.'
    if selected_values(settings, 'freshness') != ['any']:
        text += '\n\nОбъявления без даты не проходят выбранный срок. Для них выберите свежесть «Не важно».'
    if selected_values(settings, 'language') != ['any']:
        text += '\n\nЯзык учитывается только при явно указанных требованиях работодателя.'
    if selected_values(settings, 'residence_permit') != ['any']:
        text += '\n\nОбъявления без явного условия о ВНЖ доступны при выборе «Наличие ВНЖ → Не важно».'
    return text


def job_text(job, expanded=False, *, location_url=None):
    """Short preview by default; details remain available in the same message."""
    lines = ['💼 <b>' + safe(job.get('title') or 'Вакансия', 140 if expanded else 90) + '</b>']
    place = job.get('location') or ('Удалённо' if job.get('remote') is True else 'Место не указано')
    company = safe(job.get('company'), 80 if expanded else 40)
    from location_links import job_map_url, google_maps_url
    location_url = job_map_url(job) if location_url is None else google_maps_url(location_url)
    place_label = safe(place, 110 if expanded else 55)
    if location_url:
        if not job.get('location'):
            place_label = 'На карте'
        place_label = '<a href="' + escape(location_url, quote=True) + '">' + place_label + '</a>'
    lines.append(('🏢 ' + company + ' · ' if company else '') + '📍 ' + place_label)
    if maps_url(job):
        lines.append('🗺 <a href="' + escape(maps_url(job), quote=True) + '">' + safe(job_address(job), 180) + '</a>')
    salary = job.get('salary_min')
    payment = job.get('salary_display')
    if not payment and salary is not None:
        period = {'month': 'месяц', 'hour': 'час', 'year': 'год'}.get(job.get('salary_period') or 'month', 'период не указан')
        payment = f"от {salary:g} {job.get('salary_currency') or ''} / {period}"
    lines.append('💶 <b>' + safe(payment or 'Зарплата не указана', 120 if expanded else 80) + '</b>')
    languages, required = job_language_facts(job)
    language_text = ', '.join(LANGUAGE_NAMES.get(code, code) + (' (обяз.)' if code in required else '') for code in languages)
    lines.append('🗣 ' + safe(language_text or 'Языки не указаны', 140 if expanded else 80))
    description = job.get('description')
    if description:
        lines.append('<blockquote>' + safe(description, 1800 if expanded else 150, keep_lines=expanded) + '</blockquote>')
    contacts = job.get('contacts') or []
    if contacts:
        lines.append('☎️ ' + safe(' · '.join(contacts), 200 if expanded else 90))
    source = SOURCES.get(job.get('source'))
    source_label = safe(source.name if source else job.get('source') or 'Источник', 55)
    if valid_job_url(job.get('url')):
        source_label = '<a href="' + escape(job['url'], quote=True) + '">' + source_label + '</a>'
    published = parse_datetime(job.get('published_at'))
    date = published.astimezone(BELGRADE).strftime('%d.%m.%Y') if published else 'Дата не указана'
    lines.append('📅 ' + date + ' · ' + source_label)
    return '\n'.join(lines)


def job_buttons(job, expanded=False, translated=False):
    rows = [[{'text': '🔗 Открыть объявление', 'url': job['url']}]] if valid_job_url(job.get('url')) else []
    rows += map_buttons(job)
    if job.get('id'):
        prefix = 'ru_' if translated else ''
        rows.append([button('Свернуть ↑' if expanded else 'Подробнее ↓', f'job:{job["id"]}:{prefix}{"short" if expanded else "full"}'),
                     button('🙈 Скрыть', f'hide:{job["id"]}')])
        target = ('' if translated else 'ru_') + ('full' if expanded else 'short')
        rows.append([button('🌐 Оригинал' if translated else '🇷🇺 Перевести на русский', f'job:{job["id"]}:{target}')])
        rows.append([button('🗂 Смотреть подборку', 'search:0'), button('🏠 Меню', 'menu')])
    return rows
