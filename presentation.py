"""Compact, escaped Telegram panels and keyboards."""
from html import escape
from zoneinfo import ZoneInfo

from filters import FILTER_OPTIONS, hidden_job_ids, parse_datetime, selected_values
from job_metadata import valid_job_url
from sources import SOURCES

BELGRADE = ZoneInfo('Europe/Belgrade')
HELP_URL = 'https://t.me/AngryVirus'
LANGUAGE_NAMES = {'ru': 'Русский', 'sr': 'Сербский', 'en': 'Английский', 'de': 'Немецкий'}
FILTER_TITLES = {'city': '📍 Города', 'remote': '💻 Формат работы',
                 'language': '🗣 Языки', 'freshness': '🕒 Свежесть'}
DISCLAIMER = (
    '<b>Перед началом</b>\n'
    'Бот работает в тестовом режиме. Возможны ошибки и неточности в объявлениях.\n'
    'Бот собирает объявления из открытых источников и не является работодателем. '
    'Мы не гарантируем актуальность вакансий или трудоустройство и не отвечаем '
    'за действия работодателей. Проверяйте условия самостоятельно.'
)


def button(label, data):
    return {'text': label, 'callback_data': data}


MENU = [[button('🔎 Найти вакансии', 'search:0')],
        [button('⚙️ Фильтры', 'filters'), button('🔔 Уведомления', 'notifications')],
        [button('🙈 Скрытые', 'hidden:0'), {'text': '🆘 Помощь', 'url': HELP_URL}]]
BACK = [[button('← Главное меню', 'menu')]]
CANCEL = [[button('✖ Отменить ввод', 'cancel')]] + BACK


def clipped(value, limit):
    text = ' '.join(str(value or '').split())
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


def safe(value, limit):
    return escape(clipped(value, limit))


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
    mode = {'off': 'выключены', 'instant': 'после проверки',
            'daily': f"ежедневно в {settings.get('daily_hour', 9):02}:00"}.get(settings.get('notifications'), 'выключены')
    text = '<b>🇷🇸 SERBIA JOBS</b>\n<i>Работа под ваши условия</i>\n🧪 Тестовый режим\n\n'
    if start:
        text += DISCLAIMER + '\n\n'
    text += '<b>Ваш поиск</b>\n' + filter_summary(settings, compact=True)
    text += f'\n\n🔔 {mode}  ·  🙈 скрыто: {len(hidden_job_ids(settings))}'
    return text + '\n\nВыберите действие ↓'


def choice_panel(settings, field):
    selected = selected_values(settings, field)
    text = (f'<b>{FILTER_TITLES[field]}</b>\n\n'
            f'Выбрано: {safe(selection_label(settings, field), 250)}\n\n'
            'Можно отметить несколько вариантов. Подойдёт любой из выбранных. '
            'Изменения сохраняются сразу.')
    if field == 'freshness':
        text += '\nПериоды объединяются: «7 дней» уже включает сегодня и вчера.'
    rows = [[button(('✅ ' if value in selected else '▫️ ') + label,
                    f'choose:{field}:{value}:{0 if value in selected and value != "any" else 1}')]
            for value, label in FILTER_OPTIONS[field].items()]
    rows += [[button('✓ Готово', 'filters'), button('🔎 Найти', 'search:0')]] + BACK
    return text, rows


def job_text(job, expanded=False):
    """Short preview by default; details remain available in the same message."""
    lines = ['💼 <b>' + safe(job.get('title') or 'Вакансия', 140 if expanded else 90) + '</b>']
    place = job.get('location') or ('Удалённо' if job.get('remote') is True else 'Место не указано')
    company = safe(job.get('company'), 80 if expanded else 40)
    lines.append(('🏢 ' + company + ' · ' if company else '') + '📍 ' + safe(place, 110 if expanded else 55))
    salary = job.get('salary_min')
    payment = job.get('salary_display')
    if not payment and salary is not None:
        period = {'month': 'месяц', 'hour': 'час', 'year': 'год'}.get(job.get('salary_period') or 'month', 'период не указан')
        payment = f"от {salary:g} {job.get('salary_currency') or ''} / {period}"
    lines.append('💶 ' + safe(payment or 'Зарплата не указана', 120 if expanded else 80))
    languages = job.get('languages')
    if languages is None:
        languages = (['ru'] if job.get('russian') is True else []) + (['sr'] if job.get('serbian_required') is True else [])
    required = job.get('required_languages') or []
    language_text = ', '.join(LANGUAGE_NAMES.get(code, code) + (' (обяз.)' if code in required else '') for code in languages)
    lines.append('🗣 ' + safe(language_text or 'Языки не указаны', 140 if expanded else 80))
    description = job.get('description')
    if description:
        lines.append(safe(description, 1800 if expanded else 150))
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


def job_buttons(job, expanded=False):
    rows = [[{'text': '🔗 Открыть объявление', 'url': job['url']}]] if valid_job_url(job.get('url')) else []
    if job.get('id'):
        rows.append([button('Свернуть ↑' if expanded else 'Подробнее ↓', f'job:{job["id"]}:{"short" if expanded else "full"}'),
                     button('🙈 Скрыть', f'hide:{job["id"]}')])
    return rows
