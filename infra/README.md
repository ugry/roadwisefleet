# Infra — live VPS configuration

Files here mirror what runs on the production VPS (51.222.139.227).

| File | Where it lives on the VPS | Notes |
|---|---|---|
| `nginx/roadwisefleet.conf` | `/etc/nginx/sites-available/roadwisefleet.conf` | Includes certbot-managed HTTPS blocks — the `# managed by Certbot` lines are generated; keep them when editing. |
| `../services/waitlist/roadwisefleet-waitlist.service` | `/etc/systemd/system/roadwisefleet-waitlist.service` | systemd unit for the waitlist microservice. |
| `../services/waitlist/backup.sh` | `/opt/roadwisefleet/waitlist/backup.sh` | Nightly waitlist backup (tar.gz to `/var/backups/roadwisefleet`, 14-day retention), run by the `roadwisefleet-backup.timer` systemd unit. |

Apply after editing:
```bash
scp -i <key> nginx/roadwisefleet.conf debian@51.222.139.227:/tmp/rwf-nginx.conf
ssh -i <key> debian@51.222.139.227 'sudo mv /tmp/rwf-nginx.conf /etc/nginx/sites-available/roadwisefleet.conf && sudo nginx -t && sudo systemctl reload nginx'
```

Known drift risk: certbot rewrites this file on renewal/creation — pull it back into the repo after any certbot change.
