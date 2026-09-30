#!/usr/bin/env bash
# Runs ON the VPS as root (invoked by deploy.sh via: sudo bash /tmp/rwf-deploy-remote.sh).
# Kept as a real file, not a heredoc over stdin: sudo drains piped stdin and
# silently truncates inline scripts.
set -euo pipefail

STAGE=/tmp/rwf-web
WEBROOT=/var/www/roadwisefleet

chown -R root:root "$STAGE"
find "$STAGE" -type d -exec chmod 755 {} \;
find "$STAGE" -type f -exec chmod 644 {} \;
cp -a "$STAGE"/. "$WEBROOT"/

if [ -f /tmp/rwf-waitlist-server.js ]; then
  mv /tmp/rwf-waitlist-server.js /opt/roadwisefleet/waitlist/server.js
fi
if [ -f /tmp/rwf-waitlist-backup.sh ]; then
  mv /tmp/rwf-waitlist-backup.sh /opt/roadwisefleet/waitlist/backup.sh
  chmod 755 /opt/roadwisefleet/waitlist/backup.sh
fi

systemctl reload nginx
systemctl restart roadwisefleet-waitlist

echo "deployed: web/ -> $WEBROOT ($(ls -1 "$WEBROOT"/*.html | wc -l) pages), waitlist service restarted"
