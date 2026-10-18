"""Russian-language, multi-user Telegram job bot; Python 3.11+, no dependencies."""
import argparse
import asyncio
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timezone
from html import escape
import logging
import os
from pathlib import Path
import re
import threading
import uuid
from weakref import WeakValueDictionary
from zoneinfo import ZoneInfo

from filters import FILTER_OPTIONS, hidden_job_ids, matches, parse_datetime, select_value
from sources import collect_all
from store import Store
from telegram_api import TelegramAPI, TelegramError
from job_metadata import valid_job_url
from version import VERSION
from translation import Translator, browser_translation_url
from viewer import ACTIONS as VIEW_ACTIONS, MODES as VIEW_MODES, render_card, show as show_viewer
from presentation import (MENU, BACK, CANCEL, HELP_URL, button, choice_panel,
                          empty_search_text, filter_summary, job_text, job_buttons, menu_text, menu_buttons, safe)

LOG = logging.getLogger("serbia_jobs")
BELGRADE = ZoneInfo("Europe/Belgrade")
PAGE_SIZE = 5

def contactable(job):
    return valid_job_url(job.get('url')) or bool(job.get('contacts'))


def daily_due(user, now):
    settings = user["settings"]
    local = now.astimezone(BELGRADE)
    last = parse_datetime(user.get("last_notified_at"))
    return (local.hour >= settings["daily_hour"] and
            (last is None or last.astimezone(BELGRADE).date() < local.date()))


class Bot:
    def __init__(self, api, store, scan_minutes=30):
        self.api, self.store = api, store
        self.scan_minutes = scan_minutes
        self.pending = {}
        self.scanning = False
        self.instance_id = str(uuid.uuid4())
        self._locks = WeakValueDictionary()
        self._request_settings = ContextVar('request_settings', default=None)
        self.translator = Translator()

    def get_settings(self, uid):
        """Reuse only the current handler's snapshot; never cache between clicks."""
        snapshot = self._request_settings.get()
        if snapshot is not None and snapshot[0] == uid:
            return deepcopy(snapshot[1])
        return self.store.get_settings(uid)

    def update_settings(self, uid, **fields):
        saved = self.store.update_settings(uid, **fields)
        snapshot = self._request_settings.get()
        if snapshot is not None and snapshot[0] == uid:
            self._request_settings.set((uid, saved))

    async def acknowledge_callback(self, update):
        callback = update.get('callback_query')
        if not callback:
            return
        params = {'callback_query_id': callback['id']}
        user = callback.get('from', {})
        if callback.get('message', {}).get('chat', {}).get('type') != 'private' or not user.get('id') or user.get('is_bot'):
            params['text'] = 'Откройте личный чат с ботом.'
        try:
            await self.api.call('answerCallbackQuery', **params)
        except TelegramError as error:
            # An expired callback confirmation must not prevent the requested action.
            LOG.warning('Callback acknowledgement failed (%s)', error.code)

    def set_pending(self, uid, field):
        self.pending[uid] = field
        self.update_settings(uid, pending_input=field)

    def clear_pending(self, uid):
        self.pending.pop(uid, None)
        if self.get_settings(uid).get("pending_input") is not None:
            self.update_settings(uid, pending_input=None)

    async def panel(self, chat_id, text, rows, message_id=None):
        if message_id:
            try:
                await self.api.call("editMessageText", chat_id=chat_id, message_id=message_id,
                                    text=text, parse_mode="HTML", reply_markup={"inline_keyboard": rows})
                return
            except TelegramError as error:
                if "message is not modified" in str(error):
                    return
                if error.code != 400:
                    raise
        await self.api.send(chat_id, text, rows)

    def user_lock(self, uid):
        lock = self._locks.get(uid)
        if lock is None:
            lock = self._locks[uid] = asyncio.Lock()
        return lock

    async def filters(self, uid, chat, mid=None):
        s = self.get_settings(uid)
        text = ('<b>⚙️ Фильтры поиска</b>\n\n<blockquote>' + filter_summary(s) + '</blockquote>\n\n'
                '✅ — выбранные условия. Города, языки, формат и свежесть допускают несколько вариантов. '
                'Для ВНЖ выберите один вариант. Между группами условия действуют вместе.')
        rows = [[button('🔎 Ключевые слова', 'input:keywords'), button('🚫 Исключения', 'input:exclusions')],
                [button('📍 Города', 'city'), button('💻 Формат работы', 'remote')],
                [button('🗣 Языки', 'language'), button('💶 Минимальная зарплата', 'input:salary')],
                [button('🕒 Свежесть вакансии', 'freshness'), button('🪪 Наличие ВНЖ', 'residence_permit')],
                [button('Без зарплаты: ' + ('✓' if s['include_unknown_salary'] else '✕'), 'toggle_salary')],
                [button('🔎 Найти вакансии', 'search:0')],
                [button('↩ Сбросить фильтры', 'reset')]] + BACK
        await self.panel(chat, text, rows, mid)

    async def notifications(self, uid, chat, mid=None):
        s = self.get_settings(uid)
        enabled = s['notifications'] != 'off'
        current = 'Включены' if enabled else 'Выключены'
        await self.panel(chat, f"<b>🔔 Уведомления</b>\n\n<blockquote>Сейчас: {current}</blockquote>\n"
                         'Новая вакансия по вашим фильтрам придёт сразу после обнаружения.\n'
                         f'Источники проверяются примерно каждые {self.scan_minutes} минут.\n'
                         'Старый каталог при включении не рассылается. Уже отправленные вакансии не повторяются.',
                         [[button('🔕 Выключить' if enabled else '🔔 Включить',
                                  'notify:off' if enabled else 'notify:instant')]] + BACK, mid)

    async def results(self, uid, chat, page=0, after_id=None, mid=None):
        # Old search pagination links still open the corresponding position.
        await show_viewer(self, uid, chat, index=page * PAGE_SIZE, mid=mid, after_id=after_id)

    async def hidden(self, uid, chat, page=0, mid=None):
        ids = sorted(hidden_job_ids(self.get_settings(uid)), reverse=True)
        page = min(max(page, 0), max((len(ids) - 1) // PAGE_SIZE, 0))
        if not ids:
            await self.panel(chat, '<b>🙈 Скрытые вакансии</b>\n\nЗдесь пока пусто. '
                             'Кнопка «Скрыть» под вакансией уберёт её из вашего поиска и уведомлений.',
                             [[button('🔎 Найти вакансии', 'search:0')]] + BACK, mid)
            return
        lines = [f'<b>🙈 Скрытые вакансии · {len(ids)}</b>',
                 'Эти объявления исключены из вашего поиска и уведомлений. Нажмите «Вернуть», чтобы снять скрытие.']
        rows = []
        for number, job_id in enumerate(ids[page * PAGE_SIZE:(page + 1) * PAGE_SIZE], page * PAGE_SIZE + 1):
            job = self.store.get_job(job_id)
            title = job.get('title') if job else f'Вакансия №{job_id} (больше нет в базе)'
            lines.append(f'\n<b>{number}. {safe(title, 100)}</b>')
            if job:
                lines.append(safe(' · '.join(value for value in (job.get('company'), job.get('location')) if value), 100))
            rows.append([button(f'↩️ Вернуть №{number}', f'restore:{job_id}:{page}')])
        navigation = []
        if page:
            navigation.append(button('← Назад', f'hidden:{page - 1}'))
        if (page + 1) * PAGE_SIZE < len(ids):
            navigation.append(button('Далее →', f'hidden:{page + 1}'))
        lines.append(f'\nСтраница {page + 1} из {(len(ids) - 1) // PAGE_SIZE + 1}')
        await self.panel(chat, '\n'.join(lines), rows + ([navigation] if navigation else []) + BACK, mid)

    async def hidden_card(self, chat, job, mid):
        await self.panel(chat, '<b>🙈 Вакансия скрыта</b>\n' + safe(job['title'], 100) +
                         '\n\nБольше не появится в вашем поиске и уведомлениях, пока вы её не вернёте.',
                         [[button('↩️ Вернуть', f'restore:{job["id"]}'), button('🙈 Скрытые', 'hidden:0')]] + BACK, mid)

    async def vacancy_action(self, uid, chat, action, mid):
        parts = action.split(':')
        if len(parts) not in (2, 3) or not parts[1].isascii() or not parts[1].isdigit():
            return
        job_id = int(parts[1])
        if not 0 < job_id <= 2**63 - 1:
            return
        kind = parts[0]
        if kind == 'job' and (len(parts) != 3 or parts[2] not in ('full', 'short', 'ru_full', 'ru_short')):
            return
        if kind == 'hide' and len(parts) != 2:
            return
        if kind == 'restore' and len(parts) == 3 and not parts[2].isdigit():
            return
        ids = hidden_job_ids(self.get_settings(uid))
        job = self.store.get_job(job_id)
        if kind == 'restore':
            ids.discard(job_id)
            self.update_settings(uid, hidden_jobs=sorted(ids))
            if len(parts) == 3:
                await self.hidden(uid, chat, int(parts[2]), mid)
            else:
                await self.panel(chat, '<b>↩️ Вакансия возвращена</b>\n'
                                 'Она снова доступна при совпадении с вашими фильтрами. '
                                 'История уже отправленных уведомлений сохранена.',
                                 [[button('🔎 Найти вакансии', 'search:0'), button('🙈 Скрытые', 'hidden:0')]] + BACK, mid)
        elif job is None:
            await self.panel(chat, 'Вакансия больше не доступна.', BACK, mid)
        elif kind == 'hide':
            ids.add(job_id)
            self.update_settings(uid, hidden_jobs=sorted(ids))
            await self.hidden_card(chat, job, mid)
        elif job_id in ids:
            await self.hidden_card(chat, job, mid)
        else:
            expanded = parts[2].endswith('full')
            translated = parts[2].startswith('ru_')
            text, failed = await render_card(job, ('r' if translated else '') + ('f' if expanded else 's'), self.translator)
            rows = job_buttons(job, expanded, translated and not failed)
            if failed:
                rows.append([{'text': '🌐 Перевести в браузере', 'url': browser_translation_url(job)}])
            await self.panel(chat, text, rows, mid)

    async def help(self, chat, mid=None):
        await self.panel(chat,
                         '<b>💬 Помощь</b>\n\n'
                         'Если нужна помощь с настройками, вы нашли ошибку или бот работает неправильно, '
                         'напишите владельцу.\n\n'
                         'Кратко опишите, что произошло. Скриншот поможет быстрее разобраться.',
                         [[{'text': '✉️ Написать владельцу', 'url': HELP_URL}]] + BACK, mid)

    async def input_value(self, uid, chat, text):
        field = self.pending[uid]
        try:
            if field in ("keywords", "exclusions"):
                values = [] if text.strip() == "-" else list(dict.fromkeys(x.strip() for x in text.split(",") if x.strip()))
                if len(values) > 15 or any(len(x) > 60 for x in values):
                    raise ValueError("Максимум 15 слов или фраз, до 60 символов каждое.")
                self.update_settings(uid, **{field: values})
            elif field == "salary":
                if text.strip() == "-":
                    self.update_settings(uid, min_salary=None)
                else:
                    match = re.fullmatch(r"\s*(\d+(?:[.,]\d{1,2})?)\s+(EUR|RSD)\s*", text.upper())
                    if not match or float(match[1].replace(",", ".")) > 100_000_000:
                        raise ValueError("Введите сумму в месяц и валюту: 1000 EUR или 120000 RSD. «-» — снять фильтр.")
                    self.update_settings(uid, min_salary=float(match[1].replace(",", ".")), currency=match[2])
            elif field == "hour":
                if not text.strip().isdigit() or not 0 <= int(text.strip()) <= 23:
                    raise ValueError("Введите час от 0 до 23 по времени Белграда.")
                self.update_settings(uid, daily_hour=int(text.strip()))
            else:
                raise ValueError("Неизвестная настройка. Используйте /cancel.")
        except ValueError as error:
            await self.api.send(chat, escape(str(error)))
            return
        self.clear_pending(uid)
        if field == "hour":
            await self.notifications(uid, chat)
        else:
            await self.filters(uid, chat)

    async def _handle(self, update, prepared_settings=None, acknowledged=False):
        callback = update.get("callback_query")
        message = callback.get("message", {}) if callback else update.get("message", {})
        user = callback.get("from", {}) if callback else message.get("from", {})
        chat = message.get("chat", {})
        if callback and not acknowledged:
            await self.acknowledge_callback(update)
        if chat.get("type") != "private" or not user.get("id") or user.get("is_bot"):
            return
        uid, chat_id = user["id"], chat["id"]
        if prepared_settings is None:
            prepared_settings = self.store.ensure_user(uid, chat_id)
        self._request_settings.set((uid, prepared_settings))
        if callback:
            action = callback.get("data", "")
            mid = message.get("message_id")
            self.clear_pending(uid)
        else:
            text = message.get("text", "")
            if not text:
                return
            if len(text) > 1000:
                await self.api.send(chat_id, "Пожалуйста, сократите сообщение до 1000 символов.")
                return
            saved_pending = self.get_settings(uid).get("pending_input")
            if saved_pending:
                self.pending[uid] = saved_pending
            else:
                self.pending.pop(uid, None)
            if uid in self.pending and not text.startswith("/"):
                await self.input_value(uid, chat_id, text)
                return
            self.clear_pending(uid)
            command = text.split()[0].split("@")[0]
            action = {"/start": "start", "/menu": "menu", "/cancel": "menu", "/delete_me": "delete"}.get(command, "menu")
            mid = None
        if action in ('menu', 'start'):
            await self.panel(chat_id, menu_text(self.get_settings(uid), start=action == 'start'), menu_buttons(self.get_settings(uid)), mid)
        elif action == "help":
            await self.help(chat_id, mid)
        elif action == "filters":
            await self.filters(uid, chat_id, mid)
        elif action == 'cancel':
            self.clear_pending(uid)
            await self.panel(chat_id, 'Ввод отменён.', menu_buttons(self.get_settings(uid)), mid)
        elif action.startswith('search:'):
            parts = action.split(':')
            if len(parts) not in (2, 3): return
            try:
                page = int(parts[1])
                after_id = int(parts[2]) if len(parts) == 3 else None
            except ValueError: return
            await self.results(uid, chat_id, page, after_id, mid=mid)
        elif action.startswith('view:'):
            parts = action.split(':')
            if (len(parts) != 5 or not parts[1].isascii() or not parts[1].isdigit()
                    or not parts[2].isascii() or not parts[2].isdigit()
                    or parts[3] not in VIEW_ACTIONS or parts[4] not in VIEW_MODES):
                return
            job_id, index = int(parts[1]), int(parts[2])
            if not 0 < job_id <= 2**63 - 1 or index > 1_000_000:
                return
            await show_viewer(self, uid, chat_id, index, job_id, parts[3], parts[4], mid)
        elif action.startswith('hidden:'):
            try: page = int(action.split(':')[1])
            except ValueError: return
            await self.hidden(uid, chat_id, page, mid)
        elif action.startswith(('hide:', 'restore:', 'job:')):
            await self.vacancy_action(uid, chat_id, action, mid)
        elif action == 'sources' or action.startswith(('source:', 'favorite:', 'favorites:')):
            # Previously sent inline keyboards may remain in Telegram histories.
            # Their actions are retired and cannot mutate preserved legacy data.
            await self.panel(chat_id, 'Меню обновлено. Выберите действие:', menu_buttons(self.get_settings(uid)), mid)
        elif action == "notifications":
            await self.notifications(uid, chat_id, mid)
        elif action.startswith("notify:") and action[7:] in ("off", "instant", "daily"):
            mode = 'off' if action[7:] == 'off' else 'instant'
            fields = {'notifications': mode}
            if mode == 'instant' and self.get_settings(uid)['notifications'] == 'off':
                fields['notifications_after_id'] = self.store.latest_job_id()
            self.update_settings(uid, **fields)
            await self.panel(chat_id, menu_text(self.get_settings(uid)), menu_buttons(self.get_settings(uid)), mid)
        elif action.startswith("input:") and action[6:] in ("keywords", "exclusions", "salary", "hour"):
            field = action[6:]
            self.set_pending(uid, field)
            prompt = {"keywords": "Введите слова или фразы через запятую. Достаточно совпадения одного. «-» — очистить.",
                      "exclusions": "Введите слова, по которым нужно исключать вакансии, через запятую. «-» — очистить.",
                      "salary": "Введите минимальную зарплату в месяц: 1000 EUR или 120000 RSD. «-» — снять фильтр.",
                      "hour": "Введите час ежедневной подборки от 0 до 23, время Белграда."}[field]
            await self.panel(chat_id, prompt + "\n/cancel — отмена.", CANCEL, mid)
        elif action in FILTER_OPTIONS:
            text, rows = choice_panel(self.get_settings(uid), action)
            await self.panel(chat_id, text, rows, mid)
        elif action.startswith('choose:'):
            parts = action.split(':')
            if (len(parts) == 4 and parts[1] in FILTER_OPTIONS
                    and parts[2] in FILTER_OPTIONS[parts[1]] and parts[3] in ('0', '1')):
                field, value = parts[1:3]
                settings = self.get_settings(uid)
                self.update_settings(uid, **{field: select_value(settings, field, value, parts[3] == '1')})
                text, rows = choice_panel(self.get_settings(uid), field)
                await self.panel(chat_id, text, rows, mid)
        elif action.startswith('set:'):
            # Previously sent single-choice buttons retain their original meaning.
            parts = action.split(':')
            if len(parts) == 3 and parts[1] in FILTER_OPTIONS and parts[2] in FILTER_OPTIONS[parts[1]]:
                self.update_settings(uid, **{parts[1]: parts[2]})
                await self.filters(uid, chat_id, mid)
        elif action == "toggle_salary":
            self.update_settings(uid, include_unknown_salary=not self.get_settings(uid)["include_unknown_salary"])
            await self.filters(uid, chat_id, mid)
        elif action == "reset":
            self.update_settings(uid, keywords=[], exclusions=[], city="any", remote="any", language="any",
                                       min_salary=None, currency="EUR", include_unknown_salary=True, freshness="any",
                                       residence_permit="any")
            await self.filters(uid, chat_id, mid)
        elif action == "delete":
            await self.panel(chat_id, "Удалить ваши настройки, скрытые вакансии и историю уведомлений?",
                             [[button("Удалить мои данные", "delete_confirm")]] + BACK, mid)
        elif action == "delete_confirm":
            self.store.delete_user(uid)
            await self.api.send(chat_id, "Ваши данные удалены. Уведомления выключены. /start — начать заново.")

    async def handle(self, update, prepared_settings=None, acknowledged=False):
        callback = update.get('callback_query') or {}
        message = callback.get('message', {}) if callback else update.get('message', {})
        user = callback.get('from', {}) if callback else message.get('from', {})
        uid = user.get('id')
        async with self.user_lock(uid):
            # Synchronous PostgREST I/O runs in a worker with its own event loop.
            # A slow user's database calls never block the main webhook loop.
            async def run():
                token = self._request_settings.set(None)
                try:
                    await self._handle(update, prepared_settings, acknowledged)
                finally:
                    self._request_settings.reset(token)
            await asyncio.to_thread(lambda: asyncio.run(run()))

    async def scan(self):
        if self.scanning: return False
        self.scanning = True
        claimed = False
        heartbeat = None
        stopped = threading.Event()
        try:
            claimed = await asyncio.to_thread(self.store.acquire_lease, 'collection', self.instance_id, 900)
            if not claimed: return False
            async def renew_collection():
                while True:
                    await asyncio.sleep(60)
                    try:
                        renewed = await asyncio.to_thread(self.store.acquire_lease, 'collection', self.instance_id, 900)
                    except Exception:
                        renewed = False
                    if not renewed:
                        stopped.set()
                        return
            heartbeat = asyncio.create_task(renew_collection())
            # Migrate old subscriptions before this scan discovers new jobs.
            try:
                await self.notify()
            except Exception as error:
                LOG.error('Notification initialization failed (%s)', type(error).__name__)
            await asyncio.to_thread(self.store.set_source_status, {'_collection': {'state': 'running', 'checked_at': datetime.now(timezone.utc).isoformat()}})
            loop = asyncio.get_running_loop()
            added = 0
            def on_source(source_id, found, status):
                nonlocal added
                if stopped.is_set():
                    raise RuntimeError('Collection lease lost or collection cancelled')
                new = self.store.save_jobs(found)
                added += new
                self.store.set_source_status({source_id: status})
                if new:
                    try:
                        asyncio.run_coroutine_threadsafe(self.notify(), loop).result()
                    except Exception as error:
                        LOG.error('Notification cycle failed (%s); retry scheduled', type(error).__name__)
            jobs, statuses = await asyncio.to_thread(collect_all, on_source=on_source)
            if stopped.is_set():
                raise RuntimeError('Collection lease lost')
            statuses['_collection'] = {'state': 'finished', 'checked_at': datetime.now(timezone.utc).isoformat(), 'count': len(jobs)}
            await asyncio.to_thread(self.store.set_source_status, statuses)
            for key, status in statuses.items():
                LOG.info('Source %s: %s, count=%s, reason=%s', key, status.get('state'), status.get('count', 0), status.get('detail', ''))
            LOG.info('Collection: %d records, %d new', len(jobs), added)
            return True
        except Exception as error:
            LOG.error('Collection failed (%s)', type(error).__name__)
            if claimed:
                try:
                    await asyncio.to_thread(self.store.set_source_status, {'_collection': {'state': 'error', 'checked_at': datetime.now(timezone.utc).isoformat(), 'detail': type(error).__name__}})
                except Exception: pass
            return False
        finally:
            stopped.set()
            if heartbeat:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
            if claimed:
                try: await asyncio.to_thread(self.store.release_lease, 'collection', self.instance_id)
                except Exception as error: LOG.error('Lease release failed (%s)', type(error).__name__)
            self.scanning = False

    async def notify(self, now=None):
        now = now or datetime.now(timezone.utc)
        users = await asyncio.to_thread(self.store.subscribers)
        jobs = await asyncio.to_thread(self.store.list_jobs)
        async def one(user):
            uid = user['user_id']
            key = f'notifications:{uid}'
            owner = str(uuid.uuid4())
            async with self.user_lock(uid):
                if not await asyncio.to_thread(self.store.acquire_lease, key, owner, 900): return
                user_key = f'user:{uid}'
                user_locked = False
                try:
                    # Serialize delivery with hide/filter callbacks in another
                    # webhook process too, not only inside this Bot instance.
                    user_locked = await asyncio.to_thread(self.store.acquire_lease, user_key, owner, 900)
                    if not user_locked: return
                    latest_user = await asyncio.to_thread(self.store.get_subscriber, uid)
                    if latest_user is None: return
                    user = latest_user
                    settings = user['settings']
                    if settings['notifications'] == 'off': return
                    if settings.get('notifications_after_id') is None:
                        # First cycle after upgrading a legacy subscription:
                        # establish a baseline instead of sending the old catalog.
                        latest_id = await asyncio.to_thread(self.store.latest_job_id)
                        await asyncio.to_thread(self.store.update_settings, uid, notifications_after_id=latest_id)
                        return
                    delivered = await asyncio.to_thread(self.store.delivered_job_ids, uid)
                    pending = [job for job in jobs if job['id'] > settings.get('notifications_after_id', 0)
                               and job['id'] not in delivered and contactable(job) and matches(job, settings, now)]
                    for job in reversed(pending):
                        if not await asyncio.to_thread(self.store.acquire_lease, key, owner, 900): break
                        if not await asyncio.to_thread(self.store.acquire_lease, user_key, owner, 900): break
                        latest = await asyncio.to_thread(self.store.get_settings, uid)
                        if latest['notifications'] == 'off': break
                        if not matches(job, latest, now): continue
                        await self.api.send(user['chat_id'], job_text(job), job_buttons(job))
                        await asyncio.to_thread(self.store.mark_delivered, uid, job['id'])
                        await asyncio.sleep(0.1)
                    if (await asyncio.to_thread(self.store.get_settings, uid))['notifications'] != 'off':
                        await asyncio.to_thread(self.store.mark_notified, uid, now.isoformat())
                except TelegramError as error:
                    if error.code == 403: await asyncio.to_thread(self.store.update_settings, uid, notifications='off')
                    LOG.warning('Notification delivery failed (%s)', error.code)
                finally:
                    if user_locked:
                        await asyncio.to_thread(self.store.release_lease, user_key, owner)
                    await asyncio.to_thread(self.store.release_lease, key, owner)
        semaphore = asyncio.Semaphore(4)
        async def limited(user):
            async with semaphore: await one(user)
        await asyncio.gather(*(limited(user) for user in users))

    async def scheduler(self):
        next_scan = 0
        loop = asyncio.get_running_loop()
        while True:
            if loop.time() >= next_scan:
                await self.scan()
                next_scan = loop.time() + self.scan_minutes * 60
            try:
                await self.notify()
            except Exception as error:
                LOG.error("Notification cycle failed (%s)", type(error).__name__)
            await asyncio.sleep(60)

    async def configure(self):
        me = await self.api.call("getMe")
        LOG.info("Telegram bot connected: @%s", me.get("username", "unknown"))
        await self.api.call('setMyCommands', commands=[
            {'command': 'start', 'description': 'Начать работу'},
            {'command': 'menu', 'description': 'Открыть меню'},
            {'command': 'cancel', 'description': 'Отменить текущий ввод'},
            {'command': 'delete_me', 'description': 'Удалить личные данные'}])
        LOG.info('Application version: %s', VERSION)


    async def run(self):
        await self.configure()
        scheduler = asyncio.create_task(self.scheduler())
        from web_server import WebhookProcessor
        processor = WebhookProcessor(self)
        offset = 0
        try:
            while True:
                try:
                    updates = await self.api.call("getUpdates", offset=offset, timeout=45,
                                                  allowed_updates=["message", "callback_query"])
                    for update in updates:
                        try:
                            await processor.update(update)
                        except Exception as error:
                            LOG.error("Update failed (%s); retrying", type(error).__name__)
                            # A higher offset acknowledges every earlier update.
                            # Retry this one before processing the rest of the batch.
                            await asyncio.sleep(5)
                            break
                        offset = update["update_id"] + 1
                except TelegramError as error:
                    if error.code in (401, 409):
                        raise
                    LOG.warning("Telegram polling unavailable (%s); retrying", error.code)
                    await asyncio.sleep(5)
        finally:
            scheduler.cancel()
            await asyncio.gather(scheduler, return_exceptions=True)


def load_env(path):
    """Only task-specific variables; no shell evaluation or expansion."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in ("TELEGRAM_BOT_TOKEN", "DATABASE_PATH", "SCAN_INTERVAL_MINUTES", "SUPABASE_URL",
                   "SUPABASE_SERVICE_ROLE_KEY", "WEBHOOK_BASE_URL", "WEBHOOK_SECRET", "COLLECT_SECRET", "PORT"):
            os.environ.setdefault(key, value.strip().strip("\"'"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect", action="store_true", help="Collect once without a Telegram token")
    parser.add_argument("--status", action="store_true", help="Print stored source statuses")
    parser.add_argument("--webhook", action="store_true", help="Web server for free cloud hosting")
    args = parser.parse_args()
    load_env(Path(__file__).with_name(".env"))
    if not args.collect and not args.status and os.environ.get('SERBIA_JOBS_ALLOW_LEGACY_RUNTIME') != '1':
        parser.error('Legacy polling/webhook is disabled. Production uses Telegram Serverless. '
                     'Only an isolated legacy test bot may opt in with SERBIA_JOBS_ALLOW_LEGACY_RUNTIME=1; '
                     'never resume Render for @SerbiaJobsBot.')
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        from cloud_store import SupabaseStore
        store = SupabaseStore(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    else:
        if args.webhook:
            parser.error("Webhook mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for persistent storage.")
        store = Store(os.environ.get("DATABASE_PATH", str(Path(__file__).parent / "data" / "jobs.sqlite3")))
    if args.status:
        for key, status in store.source_status().items():
            print(key, status.get("state"), status.get("count", 0), status.get("detail", ""))
        return
    if args.collect:
        owner=str(uuid.uuid4())
        if not store.acquire_lease('collection',owner,900):
            print('Collection already running.')
            return
        try:
            store.set_source_status({'_collection':{'state':'running','checked_at':datetime.now(timezone.utc).isoformat()}})
            def renew_collection(source_id, found, status):
                if not store.acquire_lease('collection', owner, 900):
                    raise RuntimeError('Collection lease lost')
            jobs, statuses = collect_all(on_source=renew_collection)
            print('New vacancies:',store.save_jobs(jobs))
            statuses['_collection']={'state':'finished','count':len(jobs),'checked_at':datetime.now(timezone.utc).isoformat()}
            store.set_source_status(statuses)
            for key, status in statuses.items():
                print(key,status.get('state'),status.get('count',0),status.get('detail',''))
        finally:
            store.release_lease('collection',owner)
        return
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not token or any(c in token for c in "\r\n"):
        parser.error("Set TELEGRAM_BOT_TOKEN in .env (see .env.example).")
    try:
        minutes = int(os.environ.get("SCAN_INTERVAL_MINUTES", "30"))
        if minutes < 15:
            raise ValueError
    except ValueError:
        parser.error("SCAN_INTERVAL_MINUTES must be an integer >= 15.")
    try:
        bot = Bot(TelegramAPI(token), store, minutes)
        if args.webhook:
            from web_server import serve
            base_url = os.environ.get("WEBHOOK_BASE_URL") or os.environ.get("RENDER_EXTERNAL_URL", "")
            webhook_secret = os.environ.get("WEBHOOK_SECRET", "")
            collect_secret = os.environ.get("COLLECT_SECRET", "")
            if not base_url.startswith("https://") or any(c in base_url for c in "?#"):
                parser.error("Set WEBHOOK_BASE_URL to the public HTTPS service URL.")
            if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", webhook_secret) or len(collect_secret) < 32:
                parser.error("Set WEBHOOK_SECRET and COLLECT_SECRET to random strings of at least 32 characters.")
            asyncio.run(serve(bot, base_url.rstrip("/"), webhook_secret, collect_secret,
                              int(os.environ.get("PORT", "10000"))))
        else:
            asyncio.run(bot.run())
    except KeyboardInterrupt:
        pass
    except TelegramError as error:
        LOG.error("Telegram error: %s", str(error))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
