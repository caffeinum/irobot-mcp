# irobot-mcp

Control a local-network iRobot Roomba from the command line and from an MCP
server — no cloud account, no internet round-trip. Talks straight to the robot's
own MQTT broker over your LAN.

Built and tested against a **Roomba i4 (i415020)**, firmware `daredevil+2.6.0`.

## What this can and cannot do

**It can:** discover the robot on the LAN, read live state (battery, bin, dock,
wifi, mission progress, lifetime counters), start/stop/pause/resume a cleaning
mission, send it to the dock, empty the bin, make it beep, and — the actually
useful part day to day — tell you in plain language **why it stopped** by
decoding the numeric error code.

**It cannot drive the robot.** There is no forward/turn/nudge/motor control.
Wifi Roombas only expose mission-level commands; the low-level drive API of the
old serial "Roomba Open Interface" is not reachable over wifi. This is a hard
limit of the hardware, verified three independent ways (dorita980's local
transport, openHAB's irobot binding, and the reverse-engineered cloud path).
No amount of clever code adds it. If you came here for a remote-control robot
pet, this isn't that.

**No local map.** The map you see in the iRobot app is rendered cloud-side.
The robot does not expose a local map format, and on this i-series firmware it
often does not even report `pose` (its x/y/heading) locally. That absence is
normal, not a bug.

## Why Node + dorita980

The local protocol is MQTT-over-TLS with a fussy legacy handshake. `dorita980`
is the most complete, still-maintained implementation of exactly that transport,
and Node's `tls` module lets us force the legacy ciphers the robot requires.
Python's `roombapy` is an equally fine choice; this picked one to avoid a
second runtime.

## Install

```sh
npm install
```

## Quick start

```sh
# 1. Find the robot (no credentials needed)
node bin/roomba.js discover

# 2. Pair once — extracts the local password.
#    Hold the robot's HOME/DOCK button until it chirps (~2s), then release.
node bin/roomba.js pair

# 3. Use it
node bin/roomba.js status
node bin/roomba.js why      # plain-language "what is it doing / why did it stop"
node bin/roomba.js find     # beep — the safe way to locate it
node bin/roomba.js start    # begins a cleaning mission (it moves!)
node bin/roomba.js dock     # send it home
node bin/roomba.js watch    # live stream until ctrl-c
node bin/roomba.js dashboard   # local web UI at http://localhost:8080
```

## Dashboard

```sh
node bin/roomba.js dashboard --port 8080
```

A dependency-free local web dashboard: live battery / bin / dock / wifi, the
plain-language "why" reading front and centre, lifetime counters, and buttons
for start / pause / stop / dock / find (motion buttons confirm first). State
streams to the browser over server-sent events, so it updates on its own with no
polling. It runs entirely on `localhost` — no cloud.

Like `watch`, the dashboard holds the robot's single connection slot for as long
as it's open, so the iRobot phone app falls back to cloud while it runs. The UI
says so.

Add `--json` to any command for machine-readable output. Add `--ip <addr>` to
skip auto-detection.

## The one-time password

The robot's local password can't be read remotely — you have to physically hold
its HOME/DOCK button until it chirps, which opens a short window where it will
hand the password out. `roomba pair` does the extraction and stores the result
in `~/.config/irobot-mcp/config.json` (mode `0600`, outside this repo, already
in `.gitignore`). It is never committed. You can also supply credentials by
environment variable: `ROOMBA_IP`, `ROOMBA_BLID`, `ROOMBA_PASSWORD`.

## MCP server

```sh
node bin/irobot-mcp.js      # speaks MCP over stdio
```

Register it with an MCP client, e.g. Claude Code:

```json
{
  "mcpServers": {
    "irobot": { "command": "node", "args": ["/absolute/path/to/bin/irobot-mcp.js"] }
  }
}
```

Tools exposed:

| tool | moves? | purpose |
|------|--------|---------|
| `roomba_discover` | no | list robots on the LAN |
| `roomba_status` | no | battery, bin, dock, wifi, mission reading |
| `roomba_why` | no | decode mission status + error code into plain language |
| `roomba_raw_state` | no | full unfiltered state object |
| `roomba_error_codes` | no | error-code lookup table |
| `roomba_command` | maybe | send a mission command; motion needs `confirm: true` |

Any command that makes the robot physically move (`start`, `clean`, `resume`,
`dock`, `evac`, `train`) requires `confirm: true` — it is a real machine in a
real home. `find` (a beep) is the safe way to identify the robot.

## Known traps (you will hit these)

- **Legacy TLS.** The robot negotiates `TLS_RSA_WITH_AES_256_CBC_SHA` and legacy
  renegotiation, both of which modern OpenSSL 3 / Node reject by default. This
  project forces them back on (`@SECLEVEL=0` cipher string +
  `SSL_OP_LEGACY_SERVER_CONNECT`). If a future Node build changes the handshake,
  override the cipher list with the `ROBOT_CIPHERS` environment variable.

- **The broker accepts exactly ONE connection.** While this tool is connected,
  the iRobot phone app gets pushed to its cloud path — and if the app holds the
  slot, this tool can't connect. The CLI connects and disconnects per command to
  minimise this; `watch` holds the slot for as long as it runs. If a command
  reports it can't connect, close the phone app and retry.

- **Firewall the robot's internet access.** OTA firmware updates have repeatedly
  broken local access on these robots. The standing recommendation is to block
  the robot's WAN access at your router so it can't silently update. (Do this
  yourself on your own network — this tool won't touch your network config.)

- **Sandboxed shells may silently block LAN traffic.** If discovery returns
  "no device responded" but the robot is definitely on, you're likely running
  inside a sandbox that drops LAN broadcast/UDP. Run outside the sandbox.

## Error codes

`roomba why` and `roomba_error_codes` decode `cleanMissionStatus.error`. A few
common ones: `1` left wheel off floor, `6` stuck near a cliff, `14` bin missing,
`15` reboot required, `36` bin full, `46` low battery. Full table in
`src/errors.js`. Unknown codes are reported as `Unknown error code N` — never
guessed at.

### What we deliberately do NOT decode

The raw state also carries `bbpause.pauses`, an array of the last ~10 missions'
stop codes (e.g. `[18, 46, 46, 46, 6, 33, ...]`). These *look* like they use the
same enum as `cleanMissionStatus.error`, and they decode into a plausible story
(repeated `46`s reading as "low battery" on a robot that recharges mid-run). We
do **not** decode this array anywhere in the tool, because that shared-enum
assumption is unconfirmed — a satisfying-but-wrong decode is worse than none.
`roomba why` decodes only `cleanMissionStatus.error` / `notReady`, which are the
documented fields. If you can tie `bbpause` to a documented code table, that's
the thread to pull — see `src/errors.js`.
