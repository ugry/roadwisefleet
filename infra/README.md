# Infra — live VPS configuration

Files here mirror what runs on the production VPS (51.222.139.227 / elilavps2).
Public-exposure runbook: [`pilot-exposure.md`](./pilot-exposure.md).

| File | Where it lives on the VPS | Notes |
|---|---|---|
| `nginx/roadwisefleet.conf` | `/etc/nginx/sites-available/roadwisefleet.conf` | Apex + www TLS, static site, `/pilot/` + `/app/` + `/api/` → `127.0.0.1:8080`, `/api/waitlist` → `127.0.0.1:8787`, www→apex 301, security-header includes. The `/app/` location (board #69) is inert until the owner reload. Certbot-managed lines are generated — keep them when editing. |
| `nginx/snippets/roadwisefleet-headers-static.conf` | `/etc/nginx/snippets/` | HSTS + CSP + nosniff/frame/referrer/permissions headers for the landing pages. |
| `nginx/snippets/roadwisefleet-headers-pilot.conf` | `/etc/nginx/snippets/` | Stricter headers for `/pilot/`, including `X-Robots-Tag: noindex, nofollow`. |
| `nginx/snippets/roadwisefleet-headers-app.conf` | `/etc/nginx/snippets/` | **Board #69/#87/#91** — headers for the strict no-inline surfaces (`/app/` Fleet Manager, `/c/` customer portal, `/s/` solo driver). Same lockdown as the pilot but `script-src 'self'`/`style-src 'self'` with **no** `'unsafe-inline'`, plus `manifest-src 'self'` for the solo PWA manifest (no-op on the other two). |
| `nginx/snippets/roadwisefleet-headers-api.conf` | `/etc/nginx/snippets/` | Headers for proxied API responses. |
| `nginx/conf.d/roadwisefleet-limits.conf` | `/etc/nginx/conf.d/` | Per-IP `limit_req` zones (http context). Install **before** the site file — the `limit_req` lines in it are enabled as of board #45 (+ the `/app/` line, #69; the share surfaces move to the dedicated `rwf_share` zone, board #75). Also holds the `map $uri $rwf_share_path` redaction + `rwf_share` log format (board #75, PII-free share logging). |
| `checks/pilot-exposure-check.sh` | run from a checkout | Read-only before/after verification sweep. |
| `checks/nginx-limits-preflight.sh` | run from a checkout | Read-only, board #45: verifies every enabled `limit_req zone=` has a declared zone (repo + live), prints the install order. Run before any nginx reload. |
| `checks/pilot-csp-check.sh` | run from a checkout | Read-only, board #65: asserts the pilot CSP covers every resource the pilot HTML/JS declares (CSP fallback semantics) and that the lockdown tokens are intact. `--live` compares the live headers; `--self-test` proves it catches the broken policy. Runs in the `pilot-csp-check` CI job. |
| `checks/app-csp-check.sh` | run from a checkout | Read-only, board #69: same for the strict surfaces, and additionally asserts `script-src`/`style-src` stay strict (no `'unsafe-inline'`) while they declare no inline code — so the pilot snippet is not reused — and (board #91) that a declared PWA manifest is allowed by `manifest-src`. `--live` compares the live headers; `--self-test` proves each rejection. Runs in the `app-csp-check` CI job once per surface (`app/`, `customer/`, `solo/`). |
| `checks/uploads-perms-check.sh` | run from a checkout | Read-only, board #46 (U1/U7): `--live` audits the live **and** retired pre-move uploads roots for world-readable files; repo mode fails CI if any of the four storage artifacts binds `UPLOAD_DIR` back to the retired path (board #62 D1). `--self-test` proves each decision. Runs in the `uploads-perms-check` CI job. |
| `checks/site-routes-check.sh` | run from a checkout | Read-only, board #87/#93: repo mode fails CI if any API-served public surface (`/pilot/`, `/app/`, `/c/`, `/s/`, `/track/`, `/api/`, and the exact `/signup` + `/login` entry points) has no proxying, rate-limited, header-protected location — with the strict app snippet on the no-inline surfaces and the API snippet + `rwf_api` zone on `/signup`/`/login`; also checks the no-slash 301s. `--live` probes the public URLs post-reload; `--self-test` proves each rejection. Runs in the `site-routes-check` CI job. |
| `scripts/pilot-notify-deliver.sh` | `/usr/local/bin/` | **Board #79 (UXF-O2)** — provider-agnostic customer notification transport: renders the per-event template, honours per-channel preferences, retries **once**, and logs without secrets/PII (redacted recipient, no body, no capability link). Inert (exit 3, nothing sent) until an owner-approved transport/sender is configured. `--check-repo` / `--self-test` run in the `notification-delivery` CI job. |
| `notifications/templates/*.txt` | — | **Board #79** — the notification catalogue: one template per lifecycle event (offer received · awarded · driver assigned · at pickup · in transit · delivered · POD ready · invoice issued). |
| `systemd/pilot-notify-deliver.{service,timer}` | `/etc/systemd/system/` | Ready-to-apply 1-minute drain of the outbound notification queue. Runbook: [`notifications.md`](./notifications.md). |
| `checks/share-link-check.sh` | run from a checkout | Read-only, board #75: repo mode fails CI if a share-token location (`/track/`, `/s/`) is not on the dedicated `rwf_share` zone, or if the `rwf_share` log format can carry the token (`$request`/`$uri`/`$http_referer`/user-agent); `--live` probes a random token (no `Set-Cookie`, 404/410 for unknown, ≥1 × 429 under a loop); `--self-test` proves each decision. Runs in the `share-link-check` CI job. Board #91: `/s/` is the solo shell now — the guard keeps it on `rwf_share` deliberately. |
| `pilot-exposure.md` | — | Runbook: routing, topology, reboot resilience, deploy/rollback, health checks, logs, credentials. |
| `pilot-api.md` | — | Runbook: pilot API unit, config, ops, update steps, hardening. |
| `pilot-db.md` | — | Runbook: Postgres/Redis containers and backups. |
| `systemd/roadwise-api.service` | `/etc/systemd/system/roadwise-api.service` | Value-free reference mirror of the pilot API unit. Runbook: [`pilot-api.md`](./pilot-api.md). |
| `systemd/roadwise-pg.service` | `/etc/systemd/system/roadwise-pg.service` | Value-free reference mirror of the pilot Postgres unit. Runbook: [`pilot-db.md`](./pilot-db.md). |
| `systemd/roadwise-redis.service` | `/etc/systemd/system/roadwise-redis.service` | Value-free reference mirror of the pilot Redis unit (observable fields only). Runbook: [`pilot-db.md`](./pilot-db.md). |
| `systemd/pilot-uptime-check.{service,timer}` | `/etc/systemd/system/` | Ready-to-apply 5-minute uptime check for the pilot public surface + loopback liveness. Runbook: [`pilot-observability.md`](./pilot-observability.md). |
| `systemd/pilot-backup-verify.{service,timer}` | `/etc/systemd/system/` | Ready-to-apply nightly backup freshness + artifact-integrity check. |
| `scripts/pilot-uptime-check.sh` | `/usr/local/bin/` | Probes `/`, `/pilot/`, `/api/trips`, `/api/waitlist`, `/health`; mails `ugur@` on failure. |
| `scripts/pilot-backup-verify.sh` | `/usr/local/bin/` | `pg_restore --list` / gzip / tar integrity + freshness (pg dump, waitlist tarball, uploads archive + manifest); mails `ugur@` on failure. `--self-test` proves the detection/alert decisions (incl. deleting the newest backup) in CI — board #43. |
| `scripts/pilot-restore-drill.sh` | `/usr/local/bin/` | Quarterly restore drill into a throwaway container on the **first free port in 5440–5479** (auto; never 5432/5433 — board #62) with the dump's owner roles bootstrapped first. Live volume untouched. Also restores the uploads archive and checks every file against its sha256 manifest (`--with-uploads`). `--self-test` runs in the `restore-drill-selftest` CI job. |
| `scripts/pilot-uploads-backup.sh` | `/usr/local/bin/` | **Board #46** — archives the document upload directory (POD/eCMR bytes) + sha256 manifest (both 0600), 30-day retention, refuses to write an empty archive. Runbook: [`uploads.md`](./uploads.md). |
| `systemd/pilot-uploads-backup.{service,timer}` | `/etc/systemd/system/` | Ready-to-apply daily 03:45 UTC uploads backup (after the 03:15 pg dump). |
| `scripts/pilot-disk-check.sh` | `/usr/local/bin/` | **Board #46** — disk headroom (T9/T10) + file count/bytes + a standing "no upload is world-readable" check; hourly timer, alert cooldown. |
| `systemd/pilot-disk-check.{service,timer}` | `/etc/systemd/system/` | Ready-to-apply hourly disk/uploads check. |
| `scripts/pilot-api-error-watch.sh` | `/usr/local/bin/` | API error visibility (board #44): 5xx/upstream rate from the nginx logs, unit state + restart bursts, `/pilot/` latency. Alerts once per incident via `roadwise-notify.sh`, announces recovery, stays quiet during a single restart. `run` / `status` / `--self-test` (the self-test runs in CI). |
| `systemd/pilot-api-error-watch.{service,timer}` | `/etc/systemd/system/` | Ready-to-apply 2-minute timer for the above (a stopped API alerts within ~4 min). Runbook: [`monitoring/runbook.md`](./monitoring/runbook.md) §7. |
| `logrotate/roadwisefleet` | `/etc/logrotate.d/roadwisefleet` | Logrotate drop-in for pilot log files. |
| `firewall/ufw-pilot.sh` | `/opt/roadwisefleet/firewall/` | Reviewed, idempotent firewall rule set (default-deny inbound; 22/80/443 only). `apply` / `status` / `rollback`. |
| `deploy.md` | — | Runbook: the automatic deploy path (board #31). **§10 = the current single-environment deployer** (merge → live pilot → health check → auto-rollback); §4–§7 are the superseded staging design (not installed). |
| `deploy/roadwise-deploy-site.sh` | `/usr/local/bin/roadwise-deploy-site.sh` | **Current** deployer: pull `main` → CI-green gate → in-place checkout of `/opt/roadwisefleet/api` → migrate → restart → health check → auto-rollback. `deploy`/`status`/`rollback`/`--self-test` (the self-test proves the good-deploy/rollback/defer decisions and runs in the `deploy-site-selftest` CI job — board #42). See `deploy.md` §10. |
| `systemd/roadwise-deploy-site.{service,timer}` | `/etc/systemd/system/` | 5-minute pull-deploy job for the live pilot site (board #31 re-scope). Ready-to-apply, not installed. |
| `deploy/roadwise-deploy.sh` | `/usr/local/bin/roadwise-deploy.sh` | **Superseded (staging)** by the 2026-09-23 re-scope; kept for reference. CI-gated pull deploy with rollback. |
| `deploy/roadwise-notify.sh` | `/usr/local/bin/roadwise-notify.sh` | "READY TO TEST" / "PRODUCTION UPDATED" signal + deploy-failure alerts. Matrix is the transport usable from elilavps2 (the relay is loopback-only on elilavps1); exit 3/4 = nothing delivered, never a silent skip (0600 env). |
| `deploy/roadwise-promote.sh` | `/usr/local/bin/roadwise-promote.sh` | Owner-gated staging → production promotion with automatic revert on failed health check. |
| `deploy/staging.env.example` | `/opt/roadwisefleet/staging/.env` | Key names only for the staging environment (values live on the host, 0600). |
| `deploy/notify.env.example` | `/etc/roadwisefleet/notify.env` | Key names only for the notifier credential (0600). |
| `systemd/roadwise-staging-api.service` | `/etc/systemd/system/` | NEW staging API unit (127.0.0.1:8081); separate from `roadwise-api.service`. |
| `systemd/roadwise-deploy-staging.{service,timer}` | `/etc/systemd/system/` | 5-minute pull-deploy job for staging. |
| `nginx/roadwisefleet-staging.conf` | `/etc/nginx/sites-available/roadwisefleet-staging.conf` | `staging.roadwisefleet.com` vhost behind basic auth, proxies 127.0.0.1:8081. |
| `../services/waitlist/roadwisefleet-waitlist.service` | `/etc/systemd/system/roadwisefleet-waitlist.service` | systemd unit for the legacy waitlist microservice. |
| `../services/waitlist/server.js` | `/opt/roadwisefleet/waitlist/server.js` | Waitlist microservice. Per-IP limiter keys on the real client (`X-Real-IP`, trusted only from a loopback peer) as of board #45; regression suite `server.test.js` runs in the `api-tests` CI job. |
| `../services/waitlist/backup.sh` | `/opt/roadwisefleet/waitlist/backup.sh` | Nightly waitlist backup (tar.gz to `/var/backups/roadwisefleet`, 14-day retention), run by the `roadwisefleet-backup.timer` unit. |

Apply nginx changes (requires owner approval; `nginx -t` fails closed):

```bash
scp -i <key> nginx/snippets/*.conf debian@51.222.139.227:/tmp/
ssh -i <key> debian@51.222.139.227 \
  'sudo install -m 0644 /tmp/roadwisefleet-headers-*.conf /etc/nginx/snippets/'
scp -i <key> nginx/roadwisefleet.conf debian@51.222.139.227:/tmp/rwf-nginx.conf
ssh -i <key> debian@51.222.139.227 \
  'sudo cp /etc/nginx/sites-available/roadwisefleet.conf /etc/nginx/sites-available/roadwisefleet.conf.bak-$(date +%Y%m%d-%H%M) \
   && sudo mv /tmp/rwf-nginx.conf /etc/nginx/sites-available/roadwisefleet.conf \
   && sudo nginx -t && sudo systemctl reload nginx'
```

Full procedure and rollback: [`pilot-exposure.md`](./pilot-exposure.md) §2.

Known drift risk: certbot rewrites the site file on renewal/creation — pull it back into the repo after any certbot change.

## Host runbooks

| Runbook | Covers |
|---|---|
| [`host-exposure.md`](./host-exposure.md) | Public-listener inventory (3000, 9000/9001, 9200, 5355), no-host-firewall finding, closure plan. |
| [`pilot-observability.md`](./pilot-observability.md) | Current observability (metrics/alerting gaps), verified backup state, restore-drill procedure. |
| [`firewall/README.md`](./firewall/README.md) | Host firewall config-as-code: reviewed `ufw` rules, apply/rollback, order of operations. |
| [`monitoring/README.md`](./monitoring/README.md) | Monitoring stack inventory (Gatus/VictoriaMetrics/node_exporter/Grafana/relay), **config-as-code gap** (configs live on elilavps1 — not transcribable from here), owned thresholds/checks T1–T13, API error visibility (board #44). |
| [`monitoring/runbook.md`](./monitoring/runbook.md) | Monitoring operations: routine probes, silence/extend a check, alert round-trip test, relay Matrix token rotation, restore procedures, first response to an API error alert (§7), change control. |
| [`deploy.md`](./deploy.md) | The automatic deploy path (board #31): §10 single-environment deployer (merge → live pilot → auto-rollback); §4–§7 staging design, superseded. |
| [`uploads.md`](./uploads.md) | Driver document transport (board #46/F7b): upload path + limits, live storage state, findings U1–U7 (incl. the still-world-readable retired pre-move tree), storage/permission contract, retention policy draft, disk + backup/restore inclusion. Guard: [`checks/uploads-perms-check.sh`](./checks/uploads-perms-check.sh). |
| [`notifications.md`](./notifications.md) | Customer notification delivery (board #79/UXF-O2): the event catalogue, the envelope/transport/preferences contract, retry-once and PII-free logging, install steps, acceptance mapping, owner gates (#29 sender, #21/#24 providers). |
| [`share-links.md`](./share-links.md) | Off-platform share links (board #75/UXF-O1): the signed/revocable token contract for the tracking page + POD/eCMR documents + invoice view, the `rwf_share` nginx rules, PII-free access logging, storage/backup impact, acceptance mapping and the infra/app role split. Guard: [`checks/share-link-check.sh`](./checks/share-link-check.sh). |

> The `scripts/`, `logrotate/` and `firewall/` files are **ready-to-apply
> artifacts**: they are reviewed here but not installed on the host. Installing
> any of them is a production change needing owner approval and host access.
