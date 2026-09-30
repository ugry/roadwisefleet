#!/usr/bin/env bash
# RoadwiseFleet — deploy static web assets + waitlist service to the VPS.
# Usage: ./deploy.sh            (uses default key path below)
#        RWF_VPS=user@host ./deploy.sh
set -euo pipefail

KEY="${RWF_DEPLOY_KEY:-/home/semyaza/roadsidefleet/vps-c196d9d6_51.222.139.227/keys/id_ed25519}"
VPS="${RWF_VPS:-debian@51.222.139.227}"
REMOTE_WEB=/tmp/rwf-web

# Fresh staging dir owned by the deploy user (earlier runs leave it root-owned)
ssh -i "$KEY" -o BatchMode=yes "$VPS" "sudo rm -rf $REMOTE_WEB && sudo mkdir -p $REMOTE_WEB && sudo chown debian:debian $REMOTE_WEB"

# Copy the whole web tree (pages + asset folders such as ux-flows/)
scp -q -r -i "$KEY" -o BatchMode=yes web/. "$VPS:$REMOTE_WEB/"
scp -q -i "$KEY" -o BatchMode=yes services/waitlist/server.js "$VPS:/tmp/rwf-waitlist-server.js"
scp -q -i "$KEY" -o BatchMode=yes services/waitlist/backup.sh "$VPS:/tmp/rwf-waitlist-backup.sh"

# Run the remote step as a FILE (sudo drains piped stdin, which silently
# truncates heredoc scripts — see infra/deploy-remote.sh).
scp -q -i "$KEY" -o BatchMode=yes infra/deploy-remote.sh "$VPS:/tmp/rwf-deploy-remote.sh"
ssh -i "$KEY" -o BatchMode=yes "$VPS" 'sudo bash /tmp/rwf-deploy-remote.sh'

echo "OK — https://roadwisefleet.com"
