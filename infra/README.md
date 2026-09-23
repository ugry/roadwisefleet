# Infra — live VPS configuration

Files here mirror what runs on the production VPS (51.222.139.227 / elilavps2).
Public-exposure runbook: [`pilot-exposure.md`](./pilot-exposure.md).

| File | Where it lives on the VPS | Notes |
|---|---|---|
| `nginx/roadwisefleet.conf` | `/etc/nginx/sites-available/roadwisefleet.conf` | Apex + www TLS, static site, `/pilot/` + `/api/` → `127.0.0.1:8080`, `/api/waitlist` → `127.0.0.1:8787`, www→apex 301, security-header includes. Certbot-managed lines are generated — keep them when editing. |
| `nginx/snippets/roadwisefleet-headers-static.conf` | `/etc/nginx/snippets/` | HSTS + CSP + nosniff/frame/referrer/permissions headers for the landing pages. |
| `nginx/snippets/roadwisefleet-headers-pilot.conf` | `/etc/nginx/snippets/` | Stricter headers for `/pilot/`, including `X-Robots-Tag: noindex, nofollow`. |
| `nginx/snippets/roadwisefleet-headers-api.conf` | `/etc/nginx/snippets/` | Headers for proxied API responses. |
| `nginx/conf.d/roadwisefleet-limits.conf` | `/etc/nginx/conf.d/` | Per-IP `limit_req` zones (http context). Install before enabling the `limit_req` lines in the site file. |
| `checks/pilot-exposure-check.sh` | run from a checkout | Read-only before/after verification sweep. |
| `pilot-exposure.md` | — | Runbook: routing, topology, reboot resilience, deploy/rollback, health checks, logs, credentials. |
| `pilot-api.md` | — | Runbook: pilot API unit, config, ops, update steps, hardening. |
| `pilot-db.md` | — | Runbook: Postgres/Redis containers and backups. |
| `systemd/roadwise-api.service` | `/etc/systemd/system/roadwise-api.service` | Value-free reference mirror of the pilot API unit. Runbook: [`pilot-api.md`](./pilot-api.md). |
| `systemd/roadwise-pg.service` | `/etc/systemd/system/roadwise-pg.service` | Value-free reference mirror of the pilot Postgres unit. Runbook: [`pilot-db.md`](./pilot-db.md). |
| `systemd/roadwise-redis.service` | `/etc/systemd/system/roadwise-redis.service` | Value-free reference mirror of the pilot Redis unit (observable fields only). Runbook: [`pilot-db.md`](./pilot-db.md). |
| `../services/waitlist/roadwisefleet-waitlist.service` | `/etc/systemd/system/roadwisefleet-waitlist.service` | systemd unit for the legacy waitlist microservice. |
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
