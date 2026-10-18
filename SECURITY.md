# Security operations

The only Telegram administrator is numeric user ID **340780041**, in private chat
**340780041**. Usernames are never authorization credentials. Advertising controls
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
include a wait time. These records contain only numeric IDs, counters and expiry.

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

## Enable main protection after the checks succeed

The connected GitHub App does not have Administration permission (branch-protection
API returns 403). No personal token is needed: the repository owner can configure
this in the GitHub UI:

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
   legacy `Check Serbia jobs` workflow.

`security` runs detect-secrets without external verification or printing values,
`pip-audit` and npm audit for both lockfiles. Inline scanner allowlists cover only
reviewed synthetic test credentials, an environment-variable lookup, scanner package versions, and the
predecessor code digest. Dependabot checks Actions, npm and Python weekly. All
third-party Actions are pinned to complete upstream commit SHAs. Secret values
and routing are unchanged by this release.
