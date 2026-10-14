"""Authenticated Telegram webhook and a scheduled collection endpoint."""
import asyncio
from concurrent.futures import TimeoutError as FutureTimeout
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import threading
import uuid
from version import VERSION

LOG = logging.getLogger("serbia_jobs")
MAX_BODY = 256_000


class WebhookProcessor:
    def __init__(self, bot):
        self.bot = bot
        self.collection = None

    async def update(self, update):
        update_id = update.get('update_id')
        if not isinstance(update_id, int) or isinstance(update_id, bool):
            raise ValueError('Invalid update')
        await self.bot.acknowledge_callback(update)
        owner = str(uuid.uuid4())
        claim = await asyncio.to_thread(self.bot.store.claim_update, update_id, owner, 600)
        if claim == 'completed': return
        if claim == 'busy':
            for _ in range(40):
                await asyncio.sleep(0.1)
                claim = await asyncio.to_thread(self.bot.store.claim_update, update_id, owner, 600)
                if claim == 'completed': return
                if claim == 'claimed': break
        if claim != 'claimed': raise RuntimeError('Update is already processing; retry later')
        callback = update.get('callback_query') or {}
        message = callback.get('message', {}) if callback else update.get('message', {})
        user = callback.get('from', {}) if callback else message.get('from', {})
        uid = user.get('id') if message.get('chat', {}).get('type') == 'private' and not user.get('is_bot') else None
        key = f'user:{uid}'
        locked = False
        heartbeat = None
        interrupted = False
        saved = None
        try:
            if uid:
                locked = await asyncio.to_thread(self.bot.store.acquire_lease, key, owner, 600)
                if not locked: raise RuntimeError('Another update for this user is processing')
                saved = await asyncio.to_thread(self.bot.store.ensure_user, uid, message['chat']['id'])
                if update_id in saved.get('webhook_update_ids', []):
                    await asyncio.to_thread(self.bot.store.finish_update, update_id, owner)
                    return
            async def renew():
                while True:
                    await asyncio.sleep(30)
                    if not await asyncio.to_thread(self.bot.store.renew_update, update_id, owner, 600):
                        raise RuntimeError('Update lease expired')
                    if locked and not await asyncio.to_thread(self.bot.store.acquire_lease, key, owner, 600):
                        raise RuntimeError('User lease expired')
            heartbeat = asyncio.create_task(renew())
            processing = asyncio.create_task(self.bot.handle(update, prepared_settings=saved, acknowledged=True))
            done, _ = await asyncio.wait((processing, heartbeat), return_when=asyncio.FIRST_COMPLETED)
            if heartbeat in done:
                interrupted = True
                processing.cancel()
                await asyncio.gather(processing, return_exceptions=True)
                await heartbeat
            else:
                await processing
            await asyncio.to_thread(self.bot.store.finish_update, update_id, owner)
        except asyncio.CancelledError:
            interrupted = True
            raise
        except BaseException:
            if not interrupted: await asyncio.to_thread(self.bot.store.release_update, update_id, owner)
            raise
        finally:
            if heartbeat:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
            if locked and not interrupted: await asyncio.to_thread(self.bot.store.release_lease, key, owner)

    async def collect(self):
        if self.collection and not self.collection.done():
            return "already_running"

        async def run():
            collected = await self.bot.scan()
            if collected is not False: await self.bot.notify()

        self.collection = asyncio.create_task(run())
        # Retrieve errors so they do not expose request details in an asyncio traceback.
        def completed(task):
            if not task.cancelled() and task.exception():
                LOG.error("Scheduled collection failed (%s)", type(task.exception()).__name__)
        self.collection.add_done_callback(completed)
        return "started"


def make_handler(loop, processor, webhook_secret, collect_secret):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Telegram bodies and credentials are never written to access logs.
            pass

        def respond(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path == "/health":
                if processor is not None and not getattr(processor, 'ready', True):
                    self.respond(503, {'ok': False, 'version': VERSION})
                else:
                    self.respond(200, {'ok': True, 'version': VERSION})
            else:
                self.respond(404, {"error": "not_found"})

        def do_POST(self):
            if self.path == "/telegram":
                supplied = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
                if not hmac.compare_digest(supplied, webhook_secret):
                    self.respond(403, {"error": "forbidden"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_BODY:
                        raise ValueError
                    self.connection.settimeout(15)
                    value = json.loads(self.rfile.read(length))
                    if not isinstance(value, dict) or (not isinstance(value.get("update_id"), int) or isinstance(value.get("update_id"), bool)):
                        raise ValueError
                except (ValueError, OSError):
                    self.respond(400, {"error": "bad_request"})
                    return
                task = processor.update(value)
            elif self.path == "/collect":
                supplied = self.headers.get("X-Collect-Secret", "")
                if not hmac.compare_digest(supplied, collect_secret):
                    self.respond(403, {"error": "forbidden"})
                    return
                task = processor.collect()
            else:
                self.respond(404, {"error": "not_found"})
                return
            future = asyncio.run_coroutine_threadsafe(task, loop)
            try:
                result = future.result(timeout=90)
                self.respond(202 if self.path == "/collect" else 200, {"ok": True, "result": result})
            except FutureTimeout:
                # Do not cancel: a retry waits on the update lock and is deduplicated.
                self.respond(503, {"error": "retry_later"})
            except Exception as error:
                LOG.error("Webhook request failed (%s)", type(error).__name__)
                self.respond(503, {"error": "retry_later"})
    return Handler


async def serve(bot, base_url, webhook_secret, collect_secret, port):
    loop = asyncio.get_running_loop()
    processor = WebhookProcessor(bot)
    processor.ready = False
    scheduler = None
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(loop, processor, webhook_secret, collect_secret))
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        if hasattr(bot.store, 'readiness'):
            await asyncio.to_thread(bot.store.readiness)
        await bot.configure()
        await bot.api.call("setWebhook", url=base_url + "/telegram", secret_token=webhook_secret,
                           max_connections=4, allowed_updates=["message", "callback_query"])
        processor.ready = True
        scheduler = asyncio.create_task(bot.scheduler())
        LOG.info('Webhook server is ready on port %d; version %s', port, VERSION)
        await asyncio.Event().wait()
    finally:
        processor.ready = False
        if scheduler:
            scheduler.cancel()
            await asyncio.gather(scheduler, return_exceptions=True)
        if processor.collection:
            processor.collection.cancel()
            await asyncio.gather(processor.collection, return_exceptions=True)
        await asyncio.to_thread(server.shutdown)
        server.server_close()
