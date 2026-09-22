#!/usr/bin/env bash
# RoadwiseFleet pilot host firewall — reviewed, idempotent rule set
# (task eila/tasks#9, finding H2/H4).
#
# Ready-to-apply artifact. NOT applied by CI. Running this is a PRODUCTION
# CHANGE: it requires explicit owner approval and host access (sudo), which the
# DevOps agent does not hold. See infra/host-exposure.md §4.
#
#   sudo /opt/roadwisefleet/firewall/ufw-pilot.sh apply     # install rules + enable
#   sudo /opt/roadwisefleet/firewall/ufw-pilot.sh status    # show current state
#   sudo /opt/roadwisefleet/firewall/ufw-pilot.sh rollback  # disable ufw (back to today)
#
# Design: default-deny inbound, allow only 22/80/443. This closes the unexpected
# public listeners 3000, 9000, 9001, 9200 and 5355 in one reversible step. It is
# defence in depth, not a substitute for rebinding those services to loopback
# (see host-exposure.md §4 step 2).

set -euo pipefail

ALLOW_TCP=(22 80 443)

usage() { echo "usage: $0 {apply|status|rollback}"; exit 2; }
[ $# -eq 1 ] || usage

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: this script must run as root (sudo)." >&2
    exit 1
  fi
}

case "$1" in
  status)
    ufw status verbose
    ;;

  apply)
    require_root
    echo "== before =="; ufw status verbose || true
    ufw --force default deny incoming
    ufw --force default allow outgoing
    ufw --force default deny routed
    for p in "${ALLOW_TCP[@]}"; do ufw allow "${p}/tcp"; done
    # ICMP echo for reachability diagnostics; drop it if policy forbids ping.
    ufw allow proto icmp
    ufw --force enable
    echo "== after =="; ufw status verbose
    echo
    echo "Verify from an EXTERNAL host (not elilavps2):"
    for p in 3000 9000 9001 9200 5355; do
      echo "  nc -vz -w3 51.222.139.227 ${p}   # expect refused/timeout"
    done
    echo "  curl -sI https://roadwisefleet.com/ && curl -sI https://roadwisefleet.com/pilot/   # expect 200"
    echo
    echo "NOTE: 5355 is LLMNR from systemd-resolved; if the firewall is ever flushed"
    echo "it becomes public again — also set LLMNR=no in /etc/systemd/resolved.conf."
    ;;

  rollback)
    require_root
    ufw --force disable
    ufw status verbose || true
    echo "rollback: ufw disabled (same state as 2026-09-22)."
    ;;

  *) usage ;;
esac
