"""Small Telegram Bot API client. Does not log URLs containing the token."""
import asyncio
import json
import time
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class TelegramError(Exception):
    def __init__(self, description, code=0, retry_after=None):
        super().__init__(description)
        self.code = code
        self.retry_after = retry_after


class TelegramAPI:
    def __init__(self, token):
        self._token = token
        self._cooldowns = {}
        self._lock = threading.Lock()
        self._base = "https://api.telegram.org/bot" + token + "/"

    def _request(self, method, params):
        request = Request(self._base + method, data=json.dumps(params).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=65 if method=='getUpdates' else 20) as response:
                result = json.loads(response.read(1_000_000))
        except HTTPError as error:
            try:
                result = json.loads(error.read())
            except (ValueError, OSError):
                raise TelegramError("Telegram HTTP error", error.code) from None
        except (ValueError, TypeError):
            raise TelegramError('Некорректный ответ Telegram') from None
        except (URLError, TimeoutError, OSError):
            raise TelegramError("Нет соединения с Telegram") from None
        if not isinstance(result, dict):
            raise TelegramError('Некорректный ответ Telegram')
        if not result.get("ok"):
            raise TelegramError(str(result.get("description", "Telegram error")).replace(self._token, "[token]"),
                                result.get("error_code", 0),
                                result.get("parameters", {}).get("retry_after"))
        return result["result"]

    async def call(self, method, **params):
        if method == 'editMessageText':
            params.setdefault('link_preview_options', {'is_disabled': True})
        for attempt in range(3):
            with self._lock:
                remaining = self._cooldowns.get(method, 0) - time.monotonic()
            if remaining > 0:
                if remaining > 60: raise TelegramError('Telegram ограничил частоту запросов', 429, remaining)
                await asyncio.sleep(remaining)
            try:
                return await asyncio.to_thread(self._request, method, params)
            except TelegramError as error:
                if error.code != 429: raise
                retry = max(1, float(error.retry_after or 2))
                with self._lock:
                    self._cooldowns[method] = max(self._cooldowns.get(method, 0), time.monotonic()+retry)
                if attempt == 2 or retry > 60: raise

    async def send(self, chat_id, text, rows=None):
        params = {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                  "link_preview_options": {"is_disabled": True}}
        if rows is not None:
            params["reply_markup"] = {"inline_keyboard": rows}
        return await self.call("sendMessage", **params)
