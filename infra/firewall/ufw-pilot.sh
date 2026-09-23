#!/usr/bin/env bash
# RoadwiseFleet pilot host firewall — reviewed, idempotent rule set
# (task eila/tasks#9, findings H2/H4).
#
# STATUS 2026-09-22 18:05 UTC — RECONCILED WITH LIVE HOST; DO NOT RE-APPLY BLINDLY.
# elilavps2 rebooted at 16:25:38 UTC; ufw.service started 16:25:35 and is now
# `active (exited)` + enabled (default deny incoming; 22/80/443 + ICMP allowed).
# The ruleset had been written/enabled since 2026-08-26 but never started, so the
# reboot activated a long-dormant filter. The intended state below therefore
# already matches the live posture: this script is now a *conformance re-assert*,
# not an activation step. Run `status` first and diff against the live rules.
#
#   sudo /opt/roadwisefleet/firewall/ufw-pilot.sh status    # live rules + intended state (read-only)
#   sudo /opt/roadwisefleet/firewall/ufw-pilot.sh apply     # idempotent re-assert of the intended rules
#   sudo /opt/roadwisefleet/firewall/ufw-pilot.sh rollback  # DISABLE ufw — see warning in the code
#
# Running `apply`/`rollback` is a PRODUCTION CHANGE: it requires explicit owner
# approval and host access (sudo), which the DevOps agent does not hold.
# See infra/host-exposure.md §4.
#
# Design: default-deny inbound; allow only 22/80/443 (+ ICMP) to the world, plus
# node_exporter 9100 from elilavps1 only. This closes the unexpected public
# listeners 3000, 9000, 9001, 9200 and 5355. It is defence in depth, not a
# substitute for rebinding those services to loopback (host-exposure.md §4 step 2).
#
# Re-verified 2026-09-22 18:05 UTC (read-only): `ss -ltn` still shows
# 3000 (*), 9000, 9001, 9200, 5355, and NEW 9100 on public addresses — a firewall
# drop is not a loopback bind. /etc/ufw/user.rules is root-only (0640), so the
# exact live rule list could not be read from the DevOps account.

set -euo pipefail

ALLOW_TCP=(22 80 443)

# node_exporter on 9100 is scraped by VictoriaMetrics on elilavps1 and is
# restricted in the live UFW to that host (board #10, ugur 2026-09-22). Set the
# source address explicitly — never open 9100 to the world:
#   ELILAVPS1_IP=<elilavps1-ip> sudo -E ./ufw-pilot.sh apply
NODE_EXPORTER_PORT=9100

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
    echo
    echo "Intended state: default deny incoming; allow 22/80/443/tcp + ICMP;"
    echo "allow ${NODE_EXPORTER_PORT}/tcp from ELILAVPS1_IP only; 3000/9000/9001/9200/5355"
    echo "reachable from loopback/nginx only (rebind pending — host-exposure.md §4 step 2)."
    ;;

  apply)
    require_root
    echo "== before =="; ufw status verbose || true
    if ufw status | grep -q '^Status: active'; then
      echo
      echo "NOTE: ufw is ALREADY active (post-2026-09-22 reboot). This is an"
      echo "idempotent re-assert of the reviewed rules, not a first activation."
      echo "Diff the live rules against the intended state before changing anything."
    fi
    # ufw is idempotent: an identical rule is not duplicated, so re-running is safe.
    ufw --force default deny incoming
    ufw --force default allow outgoing
    ufw --force default deny routed
    for p in "${ALLOW_TCP[@]}"; do ufw allow "${p}/tcp"; done
    # ICMP echo for reachability diagnostics; drop it if policy forbids ping.
    ufw allow proto icmp
    if [ -n "${ELILAVPS1_IP:-}" ]; then
      ufw allow from "${ELILAVPS1_IP}" to any port "${NODE_EXPORTER_PORT}" proto tcp
    else
      echo "WARN: ELILAVPS1_IP unset — node_exporter ${NODE_EXPORTER_PORT} rule NOT asserted;" >&2
      echo "      VictoriaMetrics on elilavps1 would lose its scrape target." >&2
    fi
    ufw --force enable
    echo "== after =="; ufw status verbose
    echo
    echo "Verify from an EXTERNAL host (not elilavps2):"
    for p in 3000 9000 9001 9200 5355; do
      echo "  nc -vz -w3 51.222.139.227 ${p}   # expect refused/timeout"
    done
    echo "  nc -vz -w3 51.222.139.227 ${NODE_EXPORTER_PORT}   # expect refused (allowed from elilavps1 only)"
    echo "  curl -sI https://roadwisefleet.com/ && curl -sI https://roadwisefleet.com/pilot/   # expect 200"
    echo
    echo "NOTE: 5355 is LLMNR from systemd-resolved; if the firewall is ever flushed"
    echo "it becomes public again — also set LLMNR=no in /etc/systemd/resolved.conf."
    ;;

  rollback)
    require_root
    echo "WARNING: disabling ufw re-exposes 3000, 9000, 9001, 9200, 5355 and 9100"
    echo "to the internet. Since the 2026-09-22 16:25 reboot this is the ONLY packet"
    echo "filter on the host — use rollback only to restore service inside an"
    echo "approved change window, then re-apply."
    read -r -p "Type 'disable-ufw' to continue: " ans
    [ "${ans}" = "disable-ufw" ] || { echo "aborted"; exit 1; }
    ufw --force disable
    ufw status verbose || true
    ;;

  *) usage ;;
esac
