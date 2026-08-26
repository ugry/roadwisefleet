#!/usr/bin/env bash
# RoadwiseFleet — deploy static web assets + waitlist service to the VPS.
# Usage: ./deploy.sh            (uses default key path below)
#        RWF_VPS=user@host ./deploy.sh
set -euo pipefail

KEY="${RWF_DEPLOY_KEY:-/home/semyaza/roadsidefleet/vps-c196d9d6_51.222.139.227/keys/id_ed25519}"
VPS="${RWF_VPS:-debian@51.222.139.227}"
REMOTE_WEB=/tmp/rwf-web

ssh -i "$KEY" -o BatchMode=yes "$VPS" "mkdir -p $REMOTE_WEB"
scp -q -i "$KEY" -o BatchMode=yes web/*.html "$VPS:$REMOTE_WEB/"
scp -q -i "$KEY" -o BatchMode=yes services/waitlist/server.js "$VPS:/tmp/rwf-waitlist-server.js"

ssh -i "$KEY" -o BatchMode=yes "$VPS" bash -s <<'REMOTE'
set -euo pipefail
sudo chown -R root:root /tmp/rwf-web
sudo chmod 644 /tmp/rwf-web/*
sudo mv /tmp/rwf-web/* /var/www/roadwisefleet/
sudo mv /tmp/rwf-waitlist-server.js /opt/roadwisefleet/waitlist/server.js
sudo systemctl reload nginx
sudo systemctl restart roadwisefleet-waitlist
echo "deployed: web/ -> /var/www/roadwisefleet, waitlist service restarted"
REMOTE

echo "OK — https://roadwisefleet.com (once DNS points to the VPS)"
