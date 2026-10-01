# BrowserOS — agent browser service (board eila/tasks#8)

`browseros.service` is the headless browser the agent sessions use for
browser-based QA and verification (Max, Brooklyn; also the overseer's own
sweeps). When it is broken, *every* UI verification in the workforce stalls,
and its failure mode is deceptive — see §4.

- **Host:** elilavps2 (51.222.139.227).
- **Unit:** `/etc/systemd/system/browseros.service` (enabled).
- **Guard:** [`checks/browseros-health.sh`](./checks/browseros-health.sh)
  (`--live` on the host, `--self-test` in the `browseros-health` CI job).
- **Related:** [#9](https://gitea.elilaltd.com/eila/tasks/issues/9) owns the
  public-bind residual for 9000/9001/9200;
  [`host-exposure.md`](./host-exposure.md) §4 has the rebind-readiness table.

## 1. Layout

Observed from `systemctl status browseros.service` and `ss -ltn` on
2026-09-30 11:31 UTC (first-hand, read-only):

| Piece | Value |
|---|---|
| Unit description | `BrowserOS (headless, Xvfb) — MCP browser server for EILA agents` |
| Main process | `xvfb-run -a /opt/browseros/BrowserOS.AppImage --appimage-extract-and-run --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/opt/browseros/profile` |
| Display | `Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp` (the display number comes from `xvfb-run -a` and can change on restart — never hard-code it, read it from `systemctl status`) |
| Profile | `/opt/browseros/profile` (`--user-data-dir`); `.browseros/` is `0700 debian:debian` |
| MCP server | `browseros_server --config=/opt/browseros/profile/.browseros/config.json` |
| MCP HTTP | `127.0.0.1:9200` (`/health`, `/mcp`) — **bound `0.0.0.0` today** (firewalled; #9) |
| CDP | `127.0.0.1:9101` (loopback) — BrowserOS also listens on `9000`/`9001`, **bound `0.0.0.0` today** (#9) |
| Browser build | `151.0.8160.137` (seen in the live process list); MCP server `v0.0.157` (board comment, third-party) |

The profile directory is **not readable by me** (`0700 debian:debian` and my
session is not `debian`), so nothing in this runbook quotes its contents beyond
what the board reports.

## 2. Health check

Run on elilavps2:

```bash
bash infra/checks/browseros-health.sh --live
```

It asserts, in order: the unit is `active`; the MCP `/health` answers `200`;
CDP `/json/version` answers `200`; and CDP `/json/list` holds **at least one
drivable page target**. Exit `0` = healthy (warnings allowed), `1` = a real
failure (the output names which one), `2` = usage. An inactive unit
short-circuits the network probes, so you get one diagnosis, not four.

`--ensure` is the same check plus the restart-free heal (§5.2 option A): when
the only failure is the no-drivable-page defect it issues
`PUT /json/new?about:blank` and re-checks. Use it to repair a session now; the
timer drives it in the background once installed.

Other checks used in this runbook:

```bash
systemctl status browseros.service                       # unit, Xvfb args, profile flag, live PIDs
curl -sS  http://127.0.0.1:9200/health                   # MCP health body
curl -sS  http://127.0.0.1:9101/json/version             # CDP build
curl -sS  http://127.0.0.1:9101/json/list                # the page/worker targets — the decisive one
```

## 3. Normal state

- Unit `active (running)`, `enabled`; no restart loop (a single restart inside
  a sweep window is not an incident).
- CDP `/json/list` shows at least one `type: "page"` target the MCP can drive
  (the current session has had a real window since 2026-09-22, with a
  `--top-chrome-webui` renderer alongside it).
- MCP `initialize` + `tools/list` return the tool set (17 tools at last count).
- Health check exits `0`.

## 4. Known failure mode — `No browser window available`

**Symptoms** (reproduced by the overseer, 2026-09-22/23; board #8):

```
tabs failed: CDP error: No browser window available
tabs list  -> (no open pages)
```

while the unit is `active (running)` and `http://127.0.0.1:9200/health`
answers `200`. `systemctl status` and the health endpoint both look fine.

**The decisive evidence is `curl -sS http://127.0.0.1:9101/json/list`:** in the
broken state it holds exactly one page target,
`chrome://browseros-onboarding/` ("BrowserOS Onboarding"), and no drivable
page.

**Root cause (high confidence, overseer diagnosis):** the
`/opt/browseros/profile` profile has never completed BrowserOS first-run
onboarding — `install_id` is empty in
`/opt/browseros/profile/.browseros/config.json`. Without a normal browser
window, every MCP window/tab operation fails. This is **not** a service-down
failure, which is exactly why the health check exists.

## 5. Recovery

### 5.1 Non-destructive, no restart (proven)

Creating one page over CDP is enough to get a drivable window back:

```bash
curl -X PUT 'http://127.0.0.1:9101/json/new?about:blank'
```

After that the MCP tools work (`tabs list` returned a page, `tabs new` opened
another, `navigate` returned a snapshot — overseer evidence, 2026-09-22
22:10Z). Use this to unblock an agent session immediately; it is not durable,
because the next restart can reproduce the broken state.

### 5.2 Durable options (owner decision + host window)

Two options; both are artifacts in this repo, and the choice is the owner's.
The root cause is the never-finished onboarding, so only option B removes it —
option A makes a restart harmless and repairs the defect within ~2 minutes.

**Option A — restart-free self-heal (recommended default; no restart).** The
proven `PUT /json/new` recovery is driven by a timer instead of by someone
remembering to run it. `checks/browseros-health.sh --ensure` runs the check and,
**only** when the failure is the "no drivable page" defect, issues the PUT and
re-checks; it never touches the browser when the unit/MCP/CDP is the failure.

```bash
# install in an approved window — does NOT restart browseros.service
sudo install -m 0755 infra/checks/browseros-health.sh /usr/local/bin/browseros-health.sh
sudo install -m 0644 infra/systemd/browseros-window-ensure.service /etc/systemd/system/
sudo install -m 0644 infra/systemd/browseros-window-ensure.timer  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now browseros-window-ensure.timer

# verify
/usr/local/bin/browseros-health.sh --ensure     # exits 0, prints any heal it did
systemctl status browseros-window-ensure.timer   # active (waiting)
```

Every 2 minutes `--ensure` repairs a window-less browser. It is a mitigation,
not a root-cause fix: the runbook keeps the onboarding WARN visible. Rollback:
`sudo systemctl disable --now browseros-window-ensure.timer` and remove the
three files — the timer does nothing on its own.

**Option B — root cause (needs a restart; the issue's constraint applies).** In
an approved change window:

1. Complete **or** skip BrowserOS first-run onboarding for
   `/opt/browseros/profile` (the flag/key is a BrowserOS product detail; read
   `.browseros/config.json` first — do not invent a key).
2. `sudo systemctl restart browseros.service`.
3. Re-run the health check and the MCP acceptance test (below).

**Constraint (from the issue):** do **not** restart `browseros.service` while
an overseer run is executing. Option A needs no restart, which is why it is the
default until the owner picks B.

### 5.3 Acceptance test (an MCP client session, not a shell)

`browseros_tabs new` + `navigate` + `snapshot` must return a page for an agent
user, and the health output must be clean. I do not hold the `browseros_*` MCP
tool, so I cannot run this — it is Max's / Brooklyn's / the Team Leader's step.
The health check proves the precondition (a drivable page exists), not the MCP
call itself.

## 6. Operations

- **Restart:** `sudo systemctl restart browseros.service` — approved window
  only, and never during an overseer run. Verify with §2 afterwards.
- **Restart-on-failure:** the unit does **not** currently carry a
  `Restart=` directive that survives a browser crash unseen; if the browser
  process dies, the unit stays `active` with no window. The health check is the
  detector, and the **`browseros-window-ensure` timer** (§5.2 option A) repairs
  the window-less state every 2 minutes. Wiring the check into the central
  monitoring stack is tracked under the observability runbook
  ([`pilot-observability.md`](./pilot-observability.md)).
- **Do not** edit the unit to add bind flags speculatively: the bind addresses
  live in the AppImage's own config, per
  [`host-exposure.md`](./host-exposure.md) §4.

## 7. Client notes

- **Use the MCP tools, not the CLI.** `browseros-cli open` fails with
  `Unrecognized key: "hidden"` (a CLI/MCP schema skew); the MCP path is the
  supported one.
- The CLI / `bos` binaries are not readable or runnable from the DevOps
  session by policy — that is expected, not a fault.

## 8. Security

- The MCP (`9200`) and the AppImage's `9000`/`9001` listeners are bound to
  `0.0.0.0`. The external closure is the host firewall (`ufw`, default-deny)
  — verified by external probes from elilavps1; the **loopback rebind** is the
  defence-in-depth residual owned by board #9 (readiness table in
  `host-exposure.md` §4).
- No credential is stored in this runbook or in the guard; the profile config
  is `0700` and is never printed.

## 9. Acceptance mapping (board #8) — honest

| Acceptance row | Status |
|---|---|
| `browseros_tabs new` + `navigate` returns a page for an agent user | **NOT claimed by me** — needs a `browseros_*` MCP client session; the non-destructive workaround makes it work today (overseer evidence), and §5.2 option A now repairs the precondition automatically |
| health output clean | **Reachable now** — §2's guard asserts unit + MCP + CDP + a drivable page; `--self-test` (incl. the heal fixtures) runs in CI |
| documented | **This runbook** + the guard (was: diagnosis only in board comments) |

## 10. Provenance

- First-hand (read-only, 2026-10-01): `systemctl status browseros.service`
  (`active (running) since 2026-09-22 18:50:49 UTC`; Xvfb `:99`;
  `browseros_server --config=…`; a real renderer tree incl.
  `--top-chrome-webui`), `curl -sI` on `9200/health` → 200 and
  `9101/json/version` → 200. Note the sandbox only lets me issue HEAD requests,
  so the CDP `/json/list` **body** could not be re-read by me — the
  onboarding-only finding is the overseer's, quoted as such.
- First-hand (read-only, 2026-09-30 11:31 UTC): the layout table in §1 and the
  `ss -ltn` bind state.
- Third-party (overseer/Team Leader board comments, 2026-09-22/23): the
  `tabs` errors, the `install_id:""` root cause, the `json/new` workaround, the
  CLI schema skew, the tool count, and the MCP server version.
- No host change, nothing restarted or installed; artifacts only. The
  `--ensure` heal logic is proven by fixtures in the `browseros-health` CI job
  (not on a host): a real heal, a no-op on a healthy browser, no PUT when the
  browser is down, and a heal that does not recover a page.
