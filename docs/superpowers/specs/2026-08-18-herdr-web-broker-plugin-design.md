# herdr-web-broker-plugin — Design

**Date:** 2026-08-18
**Status:** Approved design, ready for planning
**Deliverable:** a standalone community plugin for the herdr marketplace — a new
public GitHub repository (`herdr-web-broker-plugin`, tagged `herdr-plugin`),
not a package
in this monorepo. The spec lives here because smithagents is where the
architecture happens; smithagents is also an eventual *client* of this plugin,
but the design optimizes for the general herdr↔herdr case, not for us.
**Grounded against:** herdr 0.8.0 — the plugin contract at
`herdr.dev/docs/plugins/` and the socket API at `herdr.dev/docs/socket-api/`.

## Goal

herdr keeps agent terminals alive on one machine and exposes complete control
of them — workspaces, panes, agents, status — through a local socket speaking
newline-delimited JSON. That API stops at the machine boundary. There is no way
to ask, from one machine, "is anything on my laptop blocked?", and no way to
send a prompt to an agent running somewhere else.

This plugin lifts the boundary. It is a broker with two jobs:

1. **Gateway.** Expose the herdr socket API over the network — a WebSocket
   carrying the same NDJSON frames the local socket already speaks, plus a thin
   REST facade — so any authorized client can drive a herdr machine remotely.
2. **Federation.** A broker can enroll as a *child* of another broker of the
   same type. The parent provides an address and a secret; the child dials out
   and holds a persistent tunnel; the parent can thereafter route requests to
   the child and query its status. Parent and child run the same plugin —
   the roles are configuration, not builds.

The result: one parent herdr instance becomes a control point for a herd of
machines, each reachable by name, each reporting agent status live.

## Settled decisions

- **The child dials out; requests flow back down that connection.** The parent
  never dials the child. This makes NAT and roaming laptops work with zero
  network setup, makes the pairing secret travel exactly one way (parent →
  child config), and makes the open socket itself the liveness signal.
- **Pairing is parent-issued.** The parent mints a named secret; the operator
  carries `{address, secret}` to the child. No discovery protocol.
- **The API is a passthrough, not a curated resource model.** Clients speak
  herdr's own method vocabulary (`agent.list`, `pane.split`, …), which is
  documented and schema-discoverable via `herdr api schema --json`. The broker
  adds routing (`instance`, `session`) and policy; it does not re-model ~70
  methods and it inherits new herdr methods for free.
- **The daemon is machine-level.** herdr supports multiple named sessions
  (separate servers, separate sockets) per machine. One broker daemon serves
  all of them; federation and pairing are machine↔machine. One secret pairs a
  laptop, not each of its sessions.
- **The parent treats itself as an instance.** The reserved instance name
  `runtime` is the local machine, populated through the same registry code path
  as remotes. `GET /parent` has one code path, not two.
- **Status is pushed, then cached; deep queries are forwarded.** Children
  stream herdr's native `pane.agent_status_changed` events up the tunnel; the
  parent answers rollup queries from cache instantly and forwards anything
  deeper as an ordinary passthrough call.
- **Stale beats silent.** An offline instance keeps its last-known status with
  `online: false` and its original `as_of` timestamp. "Laptop went dark two
  hours ago with one agent blocked" is the answer an operator needs.
- **TypeScript on Node ≥ 22, one runtime dependency (`ws`).** herdr plugins may
  be any executable; herdr's own plugin example is Node. No native deps, no
  framework.

## 1. Plugin packaging and daemon lifecycle

The repository root carries the marketplace contract:

```toml
# herdr-plugin.toml
id = "jefelabs.web-broker"
name = "Web Broker"
version = "0.1.0"
min_herdr_version = "0.8.0"
description = "REST/WS gateway and parent↔child federation for herdr instances"

[[build]]
command = ["npm", "install", "--omit=dev"]

[[startup]]
command = ["node", "daemon.js"]

[[actions]]
id = "status"
title = "Broker: status"
contexts = ["workspace"]
command = ["node", "cli.js", "status"]

[[actions]]
id = "issue-secret"
title = "Broker: issue child secret"
contexts = ["workspace"]
command = ["node", "cli.js", "issue-secret"]

[[actions]]
id = "pair"
title = "Broker: pair with parent"
contexts = ["workspace"]
command = ["node", "cli.js", "pair"]

[[actions]]
id = "revoke"
title = "Broker: revoke child"
contexts = ["workspace"]
command = ["node", "cli.js", "revoke"]

[[actions]]
id = "start"
title = "Broker: start daemon"
contexts = ["workspace"]
command = ["node", "cli.js", "start"]
```

**Lifecycle.** herdr runs `[[startup]]` hooks asynchronously at server init
without blocking, so the hook process simply *stays alive* as the daemon.
Because startup fires once per herdr session and the daemon is machine-level,
the daemon takes a lockfile in a machine-scoped location and binds its port on
boot; a second launch (another named session starting, or a live handoff) finds
a healthy daemon via the lockfile + a local health ping and exits 0. A stale
lockfile whose owner is dead is broken and replaced.

If the daemon crashes after startup, nothing auto-restarts it — herdr will not
re-run startup hooks until the server restarts. v1 mitigations, stated plainly:
the daemon is deliberately boring (no native deps, restart-safe persisted
state), and the `status` / `start` actions surface and fix a dead daemon by
hand. A supervisor loop is future work (§9).

**Files.** Config is operator-owned TOML in `HERDR_PLUGIN_CONFIG_DIR`; runtime
state lives in `HERDR_PLUGIN_STATE_DIR`:

```toml
# $HERDR_PLUGIN_CONFIG_DIR/config.toml
listen = "127.0.0.1:7591"        # loopback unless the operator opts out

[[client_tokens]]
name = "cli"
token = "…"                       # bearer token for REST/WS clients

[parent]                          # present only on children
address = "wss://home.example:7591"
secret = "…"                      # minted by the parent, §4

[policy]
remote_deny = ["server.stop", "server.reload_config", "plugin.*"]

[tls]                             # optional, §4
cert = "/path/cert.pem"
key = "/path/key.pem"
```

State dir contents: `children.json` (registered names → hashed secrets),
`registry.json` (last-known status snapshots, §5), `daemon.lock`.

**Local attach.** The daemon opens NDJSON connections to every herdr server on
the machine: the socket named by its own `HERDR_SOCKET_PATH`, the default
`~/.config/herdr/herdr.sock`, and each `~/.config/herdr/sessions/*/herdr.sock`.
The sessions directory is re-scanned on a timer and on demand, so sessions
created after daemon boot are picked up. Each live socket is one entry in the
`runtime` instance's session map.

## 2. Addressing and the REST/WS surface

Everything is namespaced under `/parent`. The instance segment is the reserved
name `runtime` (this machine) or a registered child's name.

```
GET  /parent                                    instances (runtime + remotes) with status rollup
GET  /parent/{instance}                         one instance: online, as_of, platform, herdr version
GET  /parent/{instance}/sessions                herdr sessions on that machine
GET  /parent/{instance}/sessions/{s}/agents     agent list with live status
POST /parent/{instance}/sessions/{s}/rpc        generic passthrough: {"method", "params"}
WS   /parent/ws                                 duplex NDJSON
```

The REST facade is thin: the three GETs read the registry cache (plus a
forwarded `agent.list` when the caller asks for `?fresh=1`); the `rpc` POST and
the WS are the real surface. A WS frame is herdr's existing request shape plus
two routing fields:

```json
{"id":"req_1","instance":"laptop","session":"default","method":"agent.prompt","params":{…}}
```

Responses correlate by `id` exactly as herdr's socket does. Event frames
(`events.subscribe` results, and the broker's own `instance.online` /
`instance.offline` notifications) flow back unsolicited on the same WS.

**Routing.** `instance == "runtime"` resolves to the matching local socket.
Anything else looks up a connected child tunnel and relays the frame verbatim;
the child's daemon resolves `session` against *its* local sockets and answers.
One hop only in v1 — a parent does not forward to a grandchild (§9).

**Policy.** Before forwarding, the method name is checked against the method
policy — a deny-list of method globs, with `remote_deny` applying its stricter
default to remote-originated calls. Denied methods answer `method_denied`
without touching the tunnel; everything else passes — passthrough is the
point.

**Auth.** Every REST call and WS upgrade requires `Authorization: Bearer
<token>` matching a `[[client_tokens]]` entry. Token comparison is
constant-time.

## 3. Tunnel protocol (child ↔ parent)

The child dials `wss://<parent>/parent/enroll` with headers `x-herdr-broker-name`
and `x-herdr-broker-secret`. The parent verifies the secret hash for that name
and completes the upgrade, or closes with an auth error. Then, over NDJSON:

1. **`hello`** (child → parent): `{type:"hello", name, platform, herdr_version,
   plugin_version, proto: 1, sessions:[…snapshot per §5…]}`.
2. **`welcome`** (parent → child): `{type:"welcome", name, proto: 1}`. A `proto`
   the parent cannot speak closes the connection with `proto_mismatch`.

After the handshake, three frame kinds:

- **`req` / `res`** — the parent forwards a client call down
  (`{type:"req", id, session, method, params}`); the child calls its local
  socket and answers (`{type:"res", id, result}` or `{type:"res", id, error}`).
  The `id` is minted by the parent and namespaced per tunnel, so concurrent
  clients never collide.
- **`event`** — child-pushed, unsolicited: agent status changes
  (`pane.agent_status_changed` relayed with its session name attached),
  session added/removed, and full snapshot re-syncs.
- **heartbeat** — WS-level ping/pong on an interval; two missed pongs close
  the socket from either side.

**Reconnection.** On close, the child redials with exponential backoff
(1s → 60s cap, jittered) forever — a laptop that sleeps overnight re-enrolls by
itself. On every successful reconnect the child re-sends the full `hello`
snapshot and the parent *replaces* that instance's registry entry — replacement
is idempotent and cheap, so there is no diff-reconciliation protocol to get
wrong. The parent marks the instance offline the moment the socket closes and
fails any in-flight forwarded requests with `instance_offline`.

## 4. Enrollment and security

**Minting.** On the parent: `herdr plugin action invoke
jefelabs.web-broker.issue-secret --name laptop` generates a random 256-bit
secret, prints it exactly once,
and stores only its SHA-256 hash in `children.json`. The name is bound at mint
time: a secret is valid for exactly one instance name, so a leaked secret
cannot impersonate a different node, and re-enrolling a rebuilt machine reuses
its name and secret. Re-issuing for an existing name replaces the hash.

**Pairing.** On the child: the `pair` action writes `[parent]` address + secret
into its config and pokes the daemon to dial immediately.

**Revocation.** `revoke --name laptop` deletes the hash and severs the live
tunnel if connected. The child will retry and be refused; its logs say why.

**Transport security — honest v1 scope.** The daemon listens on `127.0.0.1` by
default; binding a routable address requires explicitly setting `listen`. For
cross-network traffic the spec recommends a tailnet/VPN or a TLS-terminating
reverse proxy in front; direct exposure is supported via the optional `[tls]`
cert/key config. The plugin does not do cert issuance or rotation — that is
infrastructure, not plugin.

**Two credential classes, deliberately separate.** Client bearer tokens
authorize the REST/WS surface; child secrets authorize tunnel enrollment. A
child secret cannot call the client API; a client token cannot enroll. Method
policy applies per class, with remote-originated calls getting the stricter
default.

## 5. Status model

The parent keeps one in-memory registry, flushed to `registry.json` on change
so a daemon restart comes back with stale-but-present data:

```
instance → { online, as_of, platform, herdr_version,
             sessions: { name → { agents: [{id, title, status}],
                                  counts: {working, blocked, idle} } } }
```

`status` values are herdr's own agent states as delivered by
`pane.agent_status_changed` — the broker relays vocabulary, it does not invent
one.

Populated three ways, all through the same code path:

1. the `hello` snapshot at enrollment (and at every reconnect — full replace),
2. `event` frames as agents change state or sessions appear/disappear,
3. the local attach doing exactly the same for `runtime`: it subscribes to
   status events on each local socket and feeds the registry as if it were a
   child that never disconnects.

`GET /parent` returns the rollup (`{instance, online, as_of, counts}` per
instance); `GET /parent/{i}/sessions/{s}/agents` returns the cached agent list,
or a forwarded fresh `agent.list` with `?fresh=1`. Offline instances keep their
last-known block with `online: false` and the old `as_of` — never discarded.

## 6. Error handling

One envelope everywhere: herdr's own `{code, message}` error shape, extended
with broker codes, so every client parses one thing.

| code | HTTP | meaning |
|---|---|---|
| `unauthorized` | 401 | missing/bad bearer token or enrollment secret |
| `method_denied` | 403 | policy allowlist rejection; message names the method |
| `unknown_instance` | 404 | no such registered name |
| `unknown_session` | 404 | instance has no such herdr session |
| `instance_offline` | 503 | tunnel down; body includes `last_seen` |
| `upstream_timeout` | 504 | forwarded call exceeded its timeout |
| `proto_mismatch` | — | tunnel handshake version disagreement (WS close) |
| herdr passthrough | 502 | herdr's own errors (`not_found`, …) relayed verbatim |

Forwarded calls carry a per-request timeout (default 30s, per-call override in
the frame). On timeout the parent answers `upstream_timeout` *and* the child
daemon cancels its local socket call, so nothing leaks on either side. A
tunnel that dies mid-request fails that request immediately with
`instance_offline` rather than waiting out the timeout.

## 7. Remote socket projection

For each online remote instance, the parent materializes every remote session
as a local socket file:

```
~/.config/herdr/remotes/<instance>/<session>.sock
```

Each accepts plain herdr NDJSON and relays frames down the tunnel — which means
the entire stock herdr CLI drives remote machines unmodified:

```sh
HERDR_SOCKET_PATH=~/.config/herdr/remotes/laptop/default.sock herdr agent list
```

Projection sockets are removed when the instance goes offline (a connect to a
missing socket is a clearer failure than a hung one) and recreated on
reconnect. Policy applies to projected calls exactly as to REST/WS calls —
projection is a client surface, not a back door. On Windows the projection is
named pipes under the equivalent namespace; if that proves awkward in
implementation it degrades to a documented Unix-only feature for v1 rather
than blocking the release.

## 8. Testing

- **Unit** (`node:test`, no framework dependency): NDJSON codec, route parsing
  for the `/parent/...` grammar, method policy evaluation, secret hash/verify,
  registry replace-on-reconnect semantics, backoff schedule.
- **Integration, no herdr binary required:** a ~60-line fake herdr socket
  server (NDJSON, canned `agent.list` / `events.subscribe` behavior) lets the
  suite boot two complete daemons in one process — parent and child over
  loopback — and drive every real seam: enrollment handshake, forwarded rpc
  round-trip, status push updating the parent cache, snapshot replace on
  reconnect, revocation severing the tunnel, wrong-secret and wrong-name
  rejection, denied method, offline-instance fast-fail, per-request timeout
  with child-side cancellation, projection socket round-trip.
- **Live smoke** (skipped unless a `herdr` binary is on PATH): the daemon
  attaches to a real server; `GET /parent/runtime/sessions` reflects truth;
  passthrough results validate against `herdr api schema --json`.

## 9. Out of scope for v1 — named, not implied

- **Multi-hop routing.** A parent does not forward to a grandchild. The frame
  shape (`instance` as a single name) is the only thing that would change;
  revisit when a real tree exists.
- **Daemon supervision.** No auto-restart loop; `status`/`start` actions are
  the recovery path.
- **Cert management.** `[tls]` accepts files; nothing issues or rotates them.
- **A curated resource API.** Passthrough is the contract; anyone wanting
  prettier routes builds them client-side against the schema.
- **smithagents integration.** The smithagents broker consuming this plugin
  (e.g., as an engine or channel adapter) is its own spec in this repo when
  the time comes.
