# RoadwiseFleet — customer notification delivery (UXF-O2)

**Board:** [eila/tasks#79](https://gitea.elilaltd.com/eila/tasks/issues/79) · **Lane:** customer + off-platform
**Date:** 2026-09-29 · **Author:** Lance Chapman (DevOps) · **Status:** artifacts reviewed in the repo, **nothing installed on any host**

## 1. Scope and role split

Every lifecycle change is an event that fans out to tracking, documents, notifications and
money (design `docs/ux-flows/README.md`). UXF-O2 is the **notification** fan-out. This document
covers the part of it that is DevOps-owned:

| Part | Owner | State |
|---|---|---|
| Emit the lifecycle events (`offer received`, `awarded`, … ) from the API | Software development (Max) | not built (#74/#75/#76) |
| **Deliver** an event to a recipient on a channel, honouring preferences, with retry + logging | **DevOps (this doc)** | **artifacts delivered** |
| The **sender domain** for email (roadwisefleet.com) | Owner (`#29`) | **open — nothing is sent until then** |
| The **WhatsApp / SMS provider** and its bridge | Owner (`#21` / `#24`) | **open** |

The transport is **safe by default**: with no owner-approved transport configured it sends
**nothing** (exit 3) and records that fact. It never invents a sender, a domain or a provider.

## 2. The notification catalogue

One template per event, in `infra/notifications/templates/<event>.txt`. The first line is
`Subject:` (used for email; dropped for chat channels), then a blank line, then the body.
`{{variable}}` placeholders are substituted from the event envelope; an unresolved placeholder
**fails the delivery** (exit 5) rather than sending a message with `{{…}}` in it.

| Event | Recipient | Key variables |
|---|---|---|
| `offer_received` | customer | `customer_name`, `trip_ref`, `pickup`, `delivery` |
| `awarded` | customer | `customer_name`, `trip_ref`, `carrier_name`, `price` |
| `driver_assigned` | customer | `customer_name`, `trip_ref`, `driver_name`, `vehicle` |
| `at_pickup` | customer | `customer_name`, `trip_ref`, `pickup` |
| `in_transit` | customer | `customer_name`, `trip_ref`, `delivery`, `eta` |
| `delivered` | customer | `customer_name`, `trip_ref`, `link` |
| `pod_ready` | customer | `customer_name`, `trip_ref`, `link` |
| `invoice_issued` | customer | `customer_name`, `trip_ref`, `invoice_ref`, `amount`, `link` |

`{{link}}` is the guest share/tracking link (board #75) — a **capability token**. It is in the
message the customer receives and it must **never** reach a log (see §3.4).

The catalogue is asserted by CI: every event has a template, no template exists without an
event, and **no template hardcodes an address** (the sender is the owner's decision, #29).

## 3. The delivery transport

`infra/scripts/pilot-notify-deliver.sh` — reviewed artifact, installed at
`/usr/local/bin/pilot-notify-deliver.sh`.

### 3.1 Envelope (the app-side contract)

A queued event is a `key=value` file (one per line). The app writes it into the spool; the
transport drains the spool:

```
event=delivered
channel=email                 # email | whatsapp | sms
recipient=customer@example.com
customer_name=Ada
trip_ref=RWF-1042
link=https://roadwisefleet.com/track/…
```

`event`, `channel` and `recipient` are required. An unknown `event` or `channel`, or a missing
key, is refused (exit 2/5) — nothing leaves the host on a malformed envelope.

### 3.2 Transports (a command per channel, all read the message on stdin)

| Setting | Channel | Contract |
|---|---|---|
| `RWF_NOTIFY_EMAIL_CMD` | email | sendmail-compatible: `From`/`To`/`Subject` + body on stdin |
| `RWF_NOTIFY_WEBHOOK_CMD` | whatsapp / sms | text on stdin; `RWF_NOTIFY_CHANNEL` and `RWF_NOTIFY_RECIPIENT` in the environment; the bridge turns it into the provider call |
| `RWF_NOTIFY_FROM` | email | the **owner-approved** From address; unset ⇒ exit 3, nothing sent |

Because the transport is a **command**, the provider can be swapped (`#21`/`#24`, an SMTP relay,
`msmtp`, …) without touching this code, and the CI self-test can stub it exactly.

### 3.3 Retry, preferences

* **Retry once.** Attempt 1 fails ⇒ one retry (after `RWF_NOTIFY_RETRY_DELAY`, default 2 s). A
  second failure ⇒ exit 4 and a `result=failed` log line. Never an unbounded retry loop.
* **Preferences.** `/etc/roadwisefleet/notify-prefs.conf`, one rule per line
  (`<recipient> <channel> <true|false>`, `#` comments). An explicit `false` **suppresses** the
  send (exit 0, `result=suppressed`, nothing sent). Absent recipient/channel ⇒ allowed
  (opt-out model) — the design shows per-user `WhatsApp · email · SMS` preferences on the
  customer profile (`01-customer-flow`).

### 3.4 Logging without secrets/PII

Every outcome appends one line to `RWF_NOTIFY_LOG`
(default `/var/log/roadwisefleet/notifications.log`):

```
2026-09-29T21:10:04Z event=delivered channel=email to=c***@example.com attempt=1 result=delivered
```

The line carries **only** the timestamp, result, event, channel, the **redacted** recipient and
the attempt number. It deliberately omits the message body (which can carry a capability link),
the envelope variables, and every transport setting (which can carry a credential). Redaction:
`customer@example.com → c***@example.com`, `+15551234567 → ***4567`.

## 4. Install (owner window — not applied)

```sh
# 1. the script + the spool + the log
install -m 0755 infra/scripts/pilot-notify-deliver.sh /usr/local/bin/pilot-notify-deliver.sh
install -d  -m 0750 -o debian -g debian /var/lib/roadwisefleet/notifications/queue
install -d  -m 0750 -o debian -g debian /var/log/roadwisefleet

# 2. the 0600 EnvironmentFile (transport command + the owner-approved sender)
install -m 0600 -o root -g root /dev/null /etc/roadwisefleet/notifications.env

# 3. preferences (one rule per line)
install -m 0644 /dev/null /etc/roadwisefleet/notify-prefs.conf

# 4. the drain units
install -m 0644 infra/systemd/pilot-notify-deliver.service /etc/systemd/system/
install -m 0644 infra/systemd/pilot-notify-deliver.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pilot-notify-deliver.timer
```

Verify: `systemctl status pilot-notify-deliver.timer` (active/next trigger), a dry envelope in
the spool produces **no send** with no transport configured (exit 3, `result=no_transport`), and
with the configured transport a real message arrives with the headers as evidence.

## 5. Acceptance mapping (honest)

| Acceptance (issue) | State |
|---|---|
| A scripted e2e triggers each event and a real message is received (headers as evidence) | **Not met on a host.** CI proves all 8 events render and are delivered to a stubbed transport; the real send needs an owner-approved sender (`#29`) + transport. |
| A forced failure retries and is logged | **Met in CI** (`self-test`, a transport that fails once is retried exactly once then delivered; one that always fails is attempted exactly twice, logged `result=failed`, exit 4). Host proof pending install. |
| Preferences suppress a channel when switched off | **Met in CI** (`customer@example.com sms false` ⇒ exit 0, nothing sent, `result=suppressed`; switched on ⇒ delivered). Host proof pending a preferences file. |

The remaining acceptance rows are **owner-gated**, not blocked by me: the real message and the
host-level preferences file cannot exist before `#29` (sender/domain) and the install window.

## 6. Owner gates / blocked

* **B1 — email sender/domain (`#29`).** No message is sent until the owner approves a From
  address/domain; the transport exits 3 without `RWF_NOTIFY_FROM`.
* **B2 — WhatsApp/SMS provider (`#21`/`#24`).** The `whatsapp`/`sms` channels are inert until the
  bridge URL/command is decided and configured; the templates are already in the catalogue.
* **B3 — event emission (`#74`/`#75`/`#76`, Max).** No envelopes are produced until the app emits
  lifecycle events; the envelope contract in §3.1 is the interface to build against.
* **B4 — install window.** The script + spool + preferences + units (§4) need a host window
  (protected paths `infra/systemd/**`, `infra/scripts/**` reviewed; owner applies).

## 7. Local checks (no host, no network)

```sh
bash infra/scripts/pilot-notify-deliver.sh --check-repo   # catalogue consistency
bash infra/scripts/pilot-notify-deliver.sh --self-test    # 20+ fixture assertions
```
