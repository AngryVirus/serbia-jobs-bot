"""One editable vacancy card; cursors remain meaningful after hiding a job."""
import asyncio

from filters import hidden_job_ids, matches
from job_metadata import job_language_facts, valid_job_url
from location_links import job_map_url
from presentation import BACK, button, clipped, empty_search_text, job_text
from translation import TranslationError, browser_translation_url

MODES = ('s', 'f', 'rs', 'rf')
ACTIONS = ('show', 'next', 'prev', 'details', 'translate', 'hide')


async def render_card(job, mode, translator):
    display = dict(job)
    notice = ''
    failed = False
    if mode.startswith('r'):
        try:
            title, description = await asyncio.gather(
                translator.translate(clipped(job.get('title'), 140)),
                translator.translate(clipped(job.get('description'), 1800, keep_lines=True)))
            display['languages'], display['required_languages'] = job_language_facts(job)
            display.update(title=title, description=description)
            notice = '<i>🇷🇺 Перевод на русский</i>\n\n'
        except TranslationError:
            notice = 'Перевод сейчас недоступен. Попробуйте ещё раз или откройте его в браузере.\n\n'
            failed = True
    return notice + job_text(display, mode.endswith('f'), location_url=job_map_url(job)), failed


def viewer_buttons(job, index, count, mode, failed=False):
    def action(label, value):
        return button(label, f'view:{job["id"]}:{index}:{value}:{mode}')
    rows = [[{'text': '🔗 Открыть объявление', 'url': job['url']}]] if valid_job_url(job.get('url')) else []
    rows += [[action('Свернуть ↑' if mode.endswith('f') else 'Подробнее ↓', 'details'),
              action('🙈 Скрыть', 'hide')],
             [action('🌐 Оригинал' if mode.startswith('r') and not failed else '🇷🇺 Перевести на русский', 'translate')]]
    if failed:
        rows.append([{'text': '🌐 Перевести в браузере', 'url': browser_translation_url(job)}])
    navigation = []
    if index:
        navigation.append(action('← Предыдущая', 'prev'))
    if index + 1 < count:
        navigation.append(action('Следующая →', 'next'))
    if navigation:
        rows.append(navigation)
    rows.append([button('⚙️ Фильтры', 'filters'), button('🏠 Меню', 'menu')])
    return rows


async def show(bot, uid, chat, index=0, job_id=None, action='show', mode='s', mid=None, after_id=None):
    settings = bot.get_settings(uid)
    all_jobs = bot.store.list_jobs()
    notice = ''
    if action == 'hide' and any(j['id'] == job_id for j in all_jobs):
        previous = [j for j in all_jobs if (valid_job_url(j.get('url')) or j.get('contacts')) and matches(j, settings)]
        index = next((i for i, j in enumerate(previous) if j['id'] == job_id), index)
        ids = hidden_job_ids(settings)
        ids.add(job_id)
        bot.update_settings(uid, hidden_jobs=sorted(ids))
        settings = bot.get_settings(uid)
        notice = '<i>🙈 Вакансия скрыта</i>\n\n'
    jobs = [j for j in all_jobs if (valid_job_url(j.get('url')) or j.get('contacts')) and matches(j, settings)]
    if not jobs:
        statuses = bot.store.source_status()
        collection = statuses.get('_collection', {})
        available = any(v.get('state') in ('ok', 'partial') for k, v in statuses.items() if not k.startswith('_'))
        if not all_jobs and (bot.scanning or collection.get('state') == 'running'):
            text = '⏳ Сейчас проверяем вакансии. Попробуйте поиск через несколько минут.'
        elif not all_jobs and not statuses:
            text = '⏳ База ещё наполняется. Проверка вакансий запускается при старте сервера.'
        elif not available and statuses:
            text = '⚠️ Сайты вакансий временно недоступны. Повторим проверку; попробуйте позже.'
        else:
            text = empty_search_text([j for j in all_jobs if valid_job_url(j.get('url')) or j.get('contacts')], settings)
        await bot.panel(chat, notice + text,
                        [[button('⚙️ Фильтры', 'filters'), button('🙈 Скрытые', 'hidden:0')]] + BACK, mid)
        return
    current = next((i for i, j in enumerate(jobs) if j['id'] == job_id), None)
    if job_id is not None and current is None and action in ('show', 'details', 'translate'):
        notice = '<i>Подборка изменилась — показана актуальная вакансия.</i>\n\n'
        action, mode = 'show', 's'
    if current is not None:
        index = current + (1 if action == 'next' else -1 if action == 'prev' else 0)
    elif action == 'prev':
        index -= 1
    if after_id is not None:
        anchor = next((i for i, j in enumerate(all_jobs) if j['id'] == after_id), None)
        if anchor is not None:
            before = {j['id'] for j in all_jobs[:anchor + 1]}
            index = sum(j['id'] in before for j in jobs)
    index = min(max(index, 0), len(jobs) - 1)
    if action == 'details':
        mode = mode[:-1] + ('s' if mode.endswith('f') else 'f')
    elif action == 'translate':
        mode = mode[1:] if mode.startswith('r') else 'r' + mode
    elif action in ('next', 'prev', 'hide'):
        mode = 's'
    header = f'<b>🔎 Вакансия {index + 1} из {len(jobs)}</b>\n\n'
    if action == 'translate' and mode.startswith('r') and mid is not None:
        await bot.panel(chat, header + '⏳ Перевожу на русский…\n\n' + job_text(jobs[index], mode.endswith('f')),
                        viewer_buttons(jobs[index], index, len(jobs), mode[1:]), mid)
    text, failed = await render_card(jobs[index], mode, bot.translator)
    # A failed request keeps a retry button instead of toggling back to original.
    button_mode = mode[1:] if failed and mode.startswith('r') else mode
    await bot.panel(chat, notice + header + text, viewer_buttons(jobs[index], index, len(jobs), button_mode, failed), mid)
