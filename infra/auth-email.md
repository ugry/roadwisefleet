# Auth email delivery — `no-reply@elilaltd.com` (board eila/tasks#124)

Owner decision (2026-10-19): **email OTP/confirmation now, WhatsApp OTP later, no SMS
and no 10DLC.** This runbook is the DevOps half (`#124`): the sender, where the
credential lives, the key contract the API reads, the real-send test, and the DNS
authentication record. The OTP endpoints, code lifecycle and templates are
software development (`#125`).

**Status: READY-TO-APPLY ARTIFACT.** Nothing in this document is installed.
The mailbox and its SMTP credential are created by the orchestrator; until that
hand-off happens the real-send row of §8 is **not met**.

---

## 1. Sender and endpoint

| | |
| --- | --- |
| Sender | `no-reply@elilaltd.com` (dedicated; never a personal mailbox) |
| Server | Stalwart on **elilavps1** |
| Submission | `smtps://mail.elilaltd.com:465` — **implicit TLS**, verified certificate |
| Auth | SASL PLAIN with the mailbox credential, over TLS only |
| MX | `10 mail.elilaltd.com` |
| Deliverability | DMARC `p=reject` on the domain (§3) — an unauthenticated sender is rejected, so test before enabling |

Do not use port 25 or 587 for this credential: 465 is the only submission path the
owner approved, and it is what the checker enforces.

## 2. Where the credential lives

**Host file:** `/etc/roadwisefleet/auth-email.env` — mode **0600**, owner **root:root**,
outside the repo and outside every agent workspace.

The API unit gains one more, root-only `EnvironmentFile`:

```ini
# /etc/systemd/system/roadwise-api.service  [Service]
EnvironmentFile=/opt/roadwisefleet/api/.env
EnvironmentFile=-/etc/roadwisefleet/auth-email.env   # auth email sender (#124)
```

`systemd` (PID 1) reads that file **as root** and passes the values into the
service environment, so `0600 root:root` works while the API still runs as
`debian`. The `-` prefix makes the unit start even before the hand-off; the API
must then treat auth email as unconfigured (`#125` owns the response).

Rules:

- The file is **data, not a script**: systemd `EnvironmentFile` syntax, parsed by
  the checker and never sourced — a malformed line cannot execute, and a syntax
  error cannot echo a value into a log. If a generated password contains spaces
  or shell/systemd metacharacters, wrap the value in single quotes
  (`AUTH_EMAIL_SMTP_PASS='…'`).
- An **unknown key is an error** in the checker: a typo such as
  `AUTH_EMAIL_SMTP_PASSS` would be silently ignored by systemd and auth email
  would look configured while sending nothing.
- Never commit a value; the committed artefact is
  [`auth-email.env.example`](./auth-email.env.example) — key names only.
- Never paste a credential into an issue, a test message or a log. The checker
  prints `<KEY>: set` / `<KEY>: MISSING` and nothing else.
- Rotate by editing the host file and restarting the unit:
  `sudo editor /etc/roadwisefleet/auth-email.env` then
  `sudo systemctl restart roadwise-api` (owner window; the restart is the cut-over).
- The mailbox is **send-only in practice**: nothing should read it. Disable the
  mailbox in Stalwart to revoke delivery in one step (§9).

## 3. Domain authentication — verified 2026-10-19

`dig` is not installed in my sandbox, so the records below were read with
DNS-over-HTTPS (`https://dns.google/resolve`, `type=TXT|MX|A`) — the exact query is
named for each row so it can be re-run. `curl -sI https://mail.elilaltd.com`
(2026-10-19) returns `302 → /account` with `server: nginx`, i.e. the Stalwart host
is up; that says nothing about port 465, which only the §7 send proves.

| Record | Query | Value (verified) | Consequence |
| --- | --- | --- | --- |
| SPF | `elilaltd.com TXT` | `v=spf1 mx -all` | Only the MX host may send. Passes **if** the egress IP is `mail.elilaltd.com` (see limit below). |
| MX | `elilaltd.com MX` | `10 mail.elilaltd.com` | — |
| A | `mail.elilaltd.com A` | `158.69.198.175` (elilavps1) | The SPF-authorised host. |
| DKIM (RSA) | `v1-rsa-20260830._domainkey.elilaltd.com TXT` | `v=DKIM1; k=rsa; h=sha256; p=MIIBIj…` (2048-bit) | Selector publishes a key. |
| DKIM (Ed25519) | `v1-ed25519-20260830._domainkey.elilaltd.com TXT` | `v=DKIM1; k=ed25519; h=sha256; p=0+dP…` | Second selector publishes a key. |
| DMARC | `_dmarc.elilaltd.com TXT` | `v=DMARC1; p=reject; rua=mailto:postmaster@elilaltd.com` | Strict; alignment must hold. |

Independent cross-check: every message the dispatcher delivers to me carries
`DKIM-Signature: … s=v1-rsa-20260830; d=elilaltd.com` **and** the Ed25519
equivalent, so the signer is live and aligned — not just a DNS record.

**Honest limits.** (a) SPF is `mx`-based; I cannot read the host's egress
interface, so "the outbound IP is 158.69.198.175" is an inference from a
single-VPS layout, not first-hand. The real-send check (§7) plus the received
`Authentication-Results` header settles it: that header is the acceptance
evidence, not the DNS table. (b) `dig`/`openssl` are not available to me, so the
TLS chain on 465 will be observed by `curl` during the send. (c) DKIM selectors
are *published*; whether Stalwart signs `no-reply@` mail with them is proven only
by the delivered message's DKIM result.

## 4. Key contract (the API reads exactly these names)

| Key | Required | Meaning |
| --- | --- | --- |
| `AUTH_EMAIL_SMTP_HOST` | yes | Submission host — `mail.elilaltd.com` |
| `AUTH_EMAIL_SMTP_PORT` | no (default `465`) | Implicit TLS port; do not change to 25/587 |
| `AUTH_EMAIL_SMTP_USER` | yes | `no-reply@elilaltd.com` |
| `AUTH_EMAIL_SMTP_PASS` | yes | Mailbox password — host file only |
| `AUTH_EMAIL_FROM` | yes | Envelope/header From — `no-reply@elilaltd.com` (address only, no display name) |

`#125` should read these names as-is (`env.ts` passthrough). The drift guard
(`auth-email-send.sh --check-repo`) fails CI if the example, this table and the
script disagree, or if the example ever carries a value for a `*_PASS`,
`*_SECRET` or `*_TOKEN` key.

Send-side requirements `#125` owns (listed here so the split is explicit): generic
responses (no account enumeration), 6-digit code, 10-minute TTL, max 5 attempts,
single-use, per-email and per-IP limits via the existing limiter/`client-ip`
helpers, and **no code or address in logs**.

## 5. Hand-off procedure (orchestrator → host → this check)

1. **Orchestrator**: create the `no-reply@elilaltd.com` mailbox on Stalwart
   (elilavps1) with a randomly generated password; keep the mailbox send-only.
2. **Do not email the credential.** It goes into the host file directly.
3. **Host (root, elilavps2)** — or the orchestrator with host access:
   ```bash
   sudo install -m 0600 -o root -g root /dev/null /etc/roadwisefleet/auth-email.env
   sudo editor /etc/roadwisefleet/auth-email.env     # fill the five keys
   ```
   Add the `EnvironmentFile=-/etc/roadwisefleet/auth-email.env` line to the API
   unit in the same window (owner approval: the unit is a protected path).
4. **Tell me the file is in place** (no values). I run §7 and post the evidence.
5. If the mail server rejects the login, the mailbox or password is wrong — that
   is a Stalwart-side fix by whoever created it, not a repo change.

## 6. Install the checker (optional but recommended)

```bash
sudo install -m 0755 infra/scripts/auth-email-send.sh /usr/local/bin/auth-email-send.sh
```

Not required for the test — the script can be run from the checkout as root.

## 7. The real-send test

```bash
# 1. preflight: file mode/owner and the five keys (prints set/MISSING only)
sudo /usr/local/bin/auth-email-send.sh --check

# 2. a real message, to the owner's inbox
sudo /usr/local/bin/auth-email-send.sh --send --to ugur@elilaltd.com
```

Expected output of step 2:

```
ok sent to ugur@elilaltd.com
ok verify delivery by the header: X-RoadwiseFleet-Test: <nonce>
```

Evidence to record in the board OUTCOME (the test is not "done" without it):

1. The nonce is present in the **received** message, with
   `From: no-reply@elilaltd.com`, `To: ugur@elilaltd.com`, and a plausible `Date`.
2. The received message's `Authentication-Results` (or the client's "signed by")
   shows **SPF pass, DKIM pass (`d=elilaltd.com`), DMARC pass** — this is the
   §3 verification, measured on a real message.
3. The message did not land in spam (owner confirms; DMARC is `p=reject`, so a
   failure here means an alignment problem, not "try again").
4. `journalctl -u roadwise-api` shows no code/address from the test.

The checker never prints the password and passes it to `curl` through a 0600
config file, so it does not appear in `ps` either.

## 8. Acceptance mapping (`#124`, email half)

| Criterion | Status |
| --- | --- |
| Dedicated sender `no-reply@elilaltd.com` exists | **Not met** — orchestrator hand-off (§5) |
| SMTP 465 wired into the API environment, 0600 | **Not met on the host** — the key contract, the unit line and the checker are ready (§2, §4) |
| Real send to `ugur@elilaltd.com` verified | **Not met** — needs the §5 credential; the command is §7 |
| SPF/DKIM/DMARC checked | **Met as a record check** (§3, first-hand DNS); the *message-level* result is the §7 evidence and is pending |
| No secret in repo / workspace / email | **Met by construction** — no value exists in the tree; the example is empty and CI fails if a value appears |

## 9. Disable / rollback

- **Stop auth email only:** remove the `EnvironmentFile=` line (or empty the file)
  and restart the API — `#125` must treat missing keys as "send unavailable",
  never as "send without auth".
- **Revoke delivery:** disable the mailbox in Stalwart. Nothing else on the host
  uses this credential.
- **DNS:** leave SPF/DKIM/DMARC alone; they serve all of `elilaltd.com`.

## 10. WhatsApp OTP (P1) — owner-gated, not started

No code and no credential exist for this, by design: the provider resources are
owner decisions. Prerequisites before I wire anything:

1. Twilio account (or Meta WhatsApp Cloud API) owned by EILA LLC.
2. Meta Business + WhatsApp Business Account, **business verification** complete.
3. A sender number that is not already registered to WhatsApp.
4. A **Verify Service** created, and an **authentication template** approved:
   `Your RoadwiseFleet verification code is {{code}}. It expires in 10 minutes.`
5. Account SID / Auth Token / Verify Service SID handed over for root-600 storage
   (never in git, never in an email).

Then, and only then: store the three values in a 0600 root file, wire Twilio
Verify from the API (`#125` behind the flag), and run a real verification to the
owner's phone. **No 10DLC registration** — WhatsApp is not 10DLC.

## 11. Open items

- **B1** mailbox + credential (orchestrator) — blocks §7.
- **B2** owner approval to add the `EnvironmentFile=` line and restart the API
  (protected unit path; same window as any other API change).
- **B3** `#125` must consume the §4 key names and treat "keys absent" as
  "email OTP unavailable" rather than failing open.
- **B4** WhatsApp: all of §10 item 1–5.

## 12. Provenance

- DNS rows (§3): first-hand, `dns.google/resolve` queries, 2026-10-19; the
  selectors are the ones in mail actually delivered to this mailbox.
- `curl -sI https://mail.elilaltd.com`: first-hand from elilavps2, 2026-10-19.
- Host paths, unit directives and the `.env` convention: from
  [`pilot-api.md`](./pilot-api.md) (transcribed unit mirror; the live unit is
  authoritative and I cannot read `/etc`).
- The credential does not exist yet and is not described here in any form.
