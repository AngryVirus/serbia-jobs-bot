# Security operations

The immutable Telegram owner is numeric user ID **340780041**, in private chat
**340780041**. Moderators may ban ordinary users; administrators may ban/unban lower
roles and manage moderators. Only the owner manages administrators and accesses
advertising, statistics and team audit. Each route, text-input step and callback
checks the current numeric identity, private chat and role hierarchy. Usernames
are never authorization credentials. Advertising controls
and audit history are in `/admin` → advertising. Emergency stop bypasses the owner's
ordinary operation lease so it remains available during a sending batch. A request
already in flight may finish; subsequent recipients are stopped. Stopped campaigns
cannot be restarted by replaying their buttons. A new post requires preview and a
separate confirmation.

Advertising launch quota defaults to **3 per UTC calendar day**; the admin panel
allows 1, 3 or 5. Reservations are atomic and survive interruption. A reserved but
interrupted launch consumes a slot conservatively. `ad_audit` records creation,
confirmation, launch, stop and emergency stop, without message contents or recipient
identities. A delivery claim is persisted before sending: timeouts and interrupted
`sending` claims are never automatically resent. Only an explicit Telegram 429 can
release a claim for retry. Advertising and vacancy notifications use separate
queues, cooldowns and health metrics.

Per-user SQLite quotas: search/navigation **40/minute**, translation **10/minute**,
complaints **5/minute** and new complaints **20/24 hours**. Windows start with the
first request. Atomic SQL enforces quotas across isolates and restarts. Replies
include a wait time. These records contain only numeric IDs, counters and expiry. Profile deletion
does not reset an active window; counters expire at their original deadline.
Expired counters, update receipts and minimal input receipts are removed in
indexed batches of at most 100 rows per type. Input receipts contain no input
text and expire after 48 hours; they prevent a failed panel refresh from applying
a completed state change again.

The independent `Independent bot watchdog` workflow runs twice hourly, separately
from collection and its concurrency group. It calls only `health_tick`, never
collection or advertising workers. It warns the owner after **2 hours without a
successful collection** (a completed run needs at least one healthy source).
Delivery warnings use a rolling 2-hour window, at least **5 errors and 20%** of
attempts, separately for advertising and job notifications. It emits warnings and
recoveries only on state transitions, stored in SQLite. An ambiguous owner notice
is not replayed; explicit 429 responses are retried after their wait. GitHub
scheduled runs may be delayed; a total Telegram Cloud or GitHub outage can also
prevent this infrastructure from delivering an alert. Workflow failures remain
visible in GitHub Actions.

## Required main protection

The required checks are `tests` and `security` from the `Test bot` workflow.
If the connected GitHub App cannot read or update branch protection (403), the
repository owner can inspect/configure the rule in the GitHub UI without sharing
a personal token:

1. Open https://github.com/AngryVirus/serbia-jobs-bot/settings/branches → Add branch
   protection rule, branch name pattern `main`.
2. Enable **Require a pull request before merging**. For a solo-maintained repo,
   leave required approving reviews disabled (zero); otherwise the owner's own PR
   cannot be approved by the same person.
3. Enable **Require status checks to pass before merging** and **Require branches
   to be up to date before merging**. Select the exact check names **tests** and
   **security** from the `Test bot` workflow after its first successful run.
4. Enable **Do not allow bypassing the above settings**. Leave force pushes and
   deletions disabled. Save and verify that main shows as protected.
5. Future changes use a branch and PR. After successful merged-main checks,
   `Serbia Jobs Serverless` deploys automatically using `workflow_run`. It accepts
   only a successful push run for the current main commit; PR runs cannot deploy.
   The existing manual operation workflow remains available and runs tests before
   accessing cloud credentials. Render must remain suspended; do not enable the
   archived `deploy/legacy-collect.yml.disabled` collector. Its former workflow
   file is no longer under `.github/workflows`.

`security` runs detect-secrets without external verification or printing values,
`pip-audit` and npm audit for both lockfiles. Inline scanner allowlists cover only
reviewed synthetic test credentials, an environment-variable lookup, scanner package versions, and the
predecessor code digest. Dependabot checks Actions, npm and Python weekly. All
third-party Actions are pinned to complete upstream commit SHAs. Secret values
and routing are unchanged by this release.


## Data, retention and recovery

The profile stores Telegram user/chat IDs, the last verified username and its
observation day, settings/input state, activity days and delivery state. Moderation
and role decisions store the real executor's numeric ID, name and username from
Telegram updates. Bans, role versions and minimal safety receipts can outlive
profile deletion; the bot does not retain arbitrary conversation as a chat log.
The team audit expires after **10 days**. Active bans and current role decisions
remain until superseded; `/delete_me` does not bypass moderation. The user-facing
policy is documented in [README.md](README.md) and
[OPERATIONS.md](serverless/OPERATIONS.md).

Encrypted backup artifacts expire after **7 days**. Deleted data can remain in
older encrypted snapshots until expiration. Temporary snapshot staging expires
after 24 hours. A backup is successful only after an artifact was uploaded and
offline restoration was verified. The old Supabase snapshot is historical and
cannot restore changes made after migration. Never enable Render or an old
Python webhook as a recovery shortcut.

Legacy polling/webhook CLI startup is blocked by default before initializing
storage or Telegram. `SERBIA_JOBS_ALLOW_LEGACY_RUNTIME=1` is an explicit opt-in for
an isolated legacy test bot only; do not configure it on the production service.
Importing legacy modules for regression tests does not require opt-in. The
archived Render and systemd examples do not provision any new infrastructure.

Source release ZIPs are generated from a verified commit into `dist/` or an
explicit `--output` path; no generated ZIP is kept in main. The allowlist includes
current workers, all runtime modules, tests, security/operations instructions and
third-party licenses. Private/runtime directories, databases, `.env`, caches and
node_modules are excluded, and source symlinks are rejected. Release tests unpack
into a clean directory and use local API stubs, never the real bot.

Heavy Cloud operations coordinate through the built-in read-only Actions token;
the independent watchdog has priority. No personal token, paid service, secret
rotation or new secret is required for this coordination. Scheduled execution
and management API availability remain best effort.


Сохранённые поиски хранят в профиле до трёх названий и снимков фильтров с
независимыми отметками уведомлений и просмотра. Пользователь может удалить
отдельный поиск либо весь профиль. Подборки используют до шести сессий
со сроком действия 24 часа; они содержат фильтры и ID, не историю переписки.
Предупреждения о подозрительных условиях анализируют только публичный текст
вакансии локальными правилами и не выносят решений о работодателе.
