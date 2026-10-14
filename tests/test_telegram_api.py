import io
import json
import unittest
from unittest.mock import patch, AsyncMock
from urllib.error import URLError
from telegram_api import TelegramAPI, TelegramError


class APITests(unittest.IsolatedAsyncioTestCase):
    async def test_long_retry_after_prevents_early_retry(self):
        api=TelegramAPI('unit-test-placeholder')
        with patch.object(api,'_request',side_effect=TelegramError('rate limited',429,120)) as request:
            for _ in range(2):
                with self.assertRaises(TelegramError) as failure: await api.call('sendMessage')
                self.assertEqual(failure.exception.code,429)
            self.assertEqual(request.call_count,1)

    async def test_short_retry_after_is_respected(self):
        api=TelegramAPI('unit-test-placeholder');clock=[0]
        async def sleep(seconds):clock[0]+=seconds
        with patch('telegram_api.time.monotonic',side_effect=lambda:clock[0]),patch('telegram_api.asyncio.sleep',side_effect=sleep) as delay,patch.object(api,'_request',side_effect=[TelegramError('rate limited',429,3),{'message_id':1}]) as request:
            self.assertEqual(await api.call('sendMessage'),{'message_id':1})
            self.assertEqual(request.call_count,2)
            delay.assert_awaited_once_with(3)

    async def test_network_errors_do_not_expose_token_or_request(self):
        api=TelegramAPI('unit-test-private-value')
        with patch('telegram_api.urlopen',side_effect=URLError('unit-test-private-value in request URL')):
            with self.assertRaises(TelegramError) as failure:await api.call('getMe')
            self.assertNotIn('unit-test-private-value',str(failure.exception))

    async def test_malformed_success_response_is_sanitized(self):
        api=TelegramAPI('unit-test-placeholder')
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,size):return b'not-json'
        with patch('telegram_api.urlopen',return_value=Response()):
            with self.assertRaises(TelegramError):await api.call('getMe')
