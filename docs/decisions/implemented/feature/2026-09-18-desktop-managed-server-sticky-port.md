# Decision Record: Desktop managed server keeps a sticky loopback port

Status: implemented

## Problem

Managed Desktop starts a private Synergy server on the loopback interface, and that origin is what the surrounding ecosystem is configured against: bookmarks, terminal shortcuts, an external local process pointed at Synergy through the `runtime.endpoint.read` plugin capability, and provider redirect URIs a user registers against that origin all name `http://127.0.0.1:<port>`. Before this change the port came from the operating system's ephemeral range on every launch — non-Windows platforms asked the kernel for a free port and passed it to the child, and Windows passed `--port 0` and recovered the assigned port afterwards by parsing `netstat` output. The address therefore changed on nearly every start.

RFC 8252 (OAuth 2.0 for Native Apps) section 7.3 permits a loopback redirect on any port, and section 8.4 requires authorization servers to register a complete redirect URI while explicitly excepting the loopback port component; section 8.10 additionally requires the redirect URI received to match the one in the outgoing request exactly. A registered loopback redirect URI is therefore only portable across ports at the authorization server's discretion, which is why local integrations conventionally pin one. Synergy already applies that reasoning to its own MCP OAuth callback, which listens on a dedicated fixed port (`19876`, overridable through `SYNERGY_OAUTH_CALLBACK_PORT`) rather than sharing the runtime listener's port.

## Decision

Managed Desktop picks its server port from a fixed candidate chain and keeps the winner stable across launches.

`apps/desktop/src/server-manager.ts` builds the chain in priority order: a valid `SYNERGY_DESKTOP_SERVER_PORT` environment value, the port persisted for the current Desktop channel, the default `4096` and the three ports above it (`4096`, `4097`, `4098`, `4099`), and finally one random ephemeral port. Each deterministic candidate is probed with a real loopback bind before the child is spawned, and a candidate already held by another listener is skipped rather than joined: RFC 8252 Appendix B.3 recommends exclusive loopback binding on Windows and B.5 recommends against socket-reuse options on Linux, so an occupied port is treated as unavailable.

Desktop names that default locally, as `script/dev.ts` already does, rather than importing `DEFAULT_SERVER_PORT` from the runtime: `apps/desktop` does not depend on the harness package, and `script/dev.ts` must run before workspace dependencies exist. The value is the same number every launcher uses, so the chain still resolves to one Desktop-and-CLI-visible origin; only the constant's home is package-local.

Every platform now passes an explicit `--port <n>` to the server child process. Windows no longer receives `--port 0`, which made `waitForWindowsServerHealth`, `findListeningPort`, and `parseListeningPort` and their tests unreachable; those were removed, while `terminateWindowsProcessTree` is retained because Windows shutdown still needs a process-tree kill.

A spawned server that exits before becoming healthy advances to the next candidate only when its captured stderr contains `Failed to start server on port`. That is the single message the server emits for every bind failure: `Bun.serve` rejections are caught and normalized at `packages/server/src/server/server.ts`, so no raw socket error such as `EADDRINUSE` reaches the child's stderr. Every other startup failure fails immediately and surfaces the existing diagnostics instead of trying another port; that includes `ServerProcessLock.AlreadyRunningError`, raised when another Synergy runtime owns the same `SYNERGY_HOME`, which remains an ownership conflict rather than a port problem.

`apps/desktop/src/server-port-state.ts` owns the persisted state: `{ version: 1, channel: "dev" | "stable", port, updatedAt }` under a strict V1 zod schema at `<electron userData>/server-port.json`, written with `mkdir -p` and a plain file write, matching the `window-state.json` and `desktop-zoom.json` precedent in this package. `loadServerPort` returns `undefined` — silently falling back to the default chain — for a missing, unreadable, corrupt, wrong-channel, unknown-shape, or out-of-range record. Only a deterministic winner is saved; the random fallback never is, so the next launch retries the stable chain first.

`script/dev.ts` exposes the same choice to source development. `bun dev desktop --managed --server-port <port>` sets `SYNERGY_DESKTOP_SERVER_PORT` on the Electron process and adds the port to the run preflight; without the flag it sets nothing and Desktop runs its default chain. The [development reference](../../../reference/development.md) documents the developer-facing form.

The chain follows the pattern of comparable local-server products: Jupyter binds `8888` and scans sequential neighbors before random ones, while Ollama (`11434`) and LM Studio (`1234`) publish a fixed default port. Remembering the winning port across launches is the part this decision adds.

## Alternatives considered

- **Use a separate desktop-only default port (for example `44096`)** — rejected because it splits the single "Synergy port" mental model into two numbers: documentation, isolation instructions, and diagnostics would each have to distinguish the CLI or daemon default from the Desktop default, and an isolated second instance would need both kept apart. One default across every launcher is worth more than avoiding collisions with the CLI's own default.
- **Keep the previous random, non-persisted port choice** — rejected because the origin would still drift whenever the default port was busy, which is exactly the case this change exists to fix. Bookmarks, configured clients, and a redirect URI registered against the origin would work on an idle machine and break on a busy one, which is harder to diagnose than a consistently unstable address.
- **Fail fast with diagnostics instead of falling back** — rejected because an ordinary user cannot act on it: a Desktop app that refuses to start because an unrelated process holds `4096`-`4099` is a worse outcome than quietly using an ephemeral port for that session.
- **Store the sticky port in `SYNERGY_HOME` server state** — rejected because the desktop shell owns this decision. `SYNERGY_HOME` is the runtime's data area, shared with the CLI and the background daemon, while `userData` is the shell's own state directory with existing state-file precedent; the port is a Desktop launch decision, not runtime data.
- **Keep the Windows `netstat` discovery path** — rejected because it became unreachable once every platform passes an explicit `--port`: no code path spawns a server with port `0` that would need its assigned port recovered afterwards.
- **Persist whichever port won, including the random fallback** — rejected because a busy machine would then hold a transient address indefinitely. Leaving the fallback unsaved keeps the next launch pointed at the stable chain.

## Consequences

- Desktop keeps one loopback origin per channel across launches, so bookmarks, plugin endpoint configuration, external local integrations, and diagnostics stay valid instead of being rebuilt after every start. A redirect URI registered against the origin survives ordinary restarts as well.
- The design is subject to a time-of-check/time-of-use gap: a port can be taken between the pre-spawn probe and the child's own bind. The bounded candidate chain absorbs it, because the child exits with a bind failure, its stderr matches, and the next candidate is tried immediately — the same risk class as Jupyter's sequential scan.
- `server-port.json` is written non-atomically (`mkdir -p` plus a plain write), the same risk level as the package's existing state files. A torn or partial write is not fatal: the loader falls back to the default chain.
- Managed Desktop and the `synergy start` daemon stay mutually exclusive over `SYNERGY_HOME` ownership, and that conflict is intentionally not retried. A Desktop launch against an owned Home fails with the existing diagnostics rather than searching for a port where the server would still refuse to start.
- A port held by an unrelated local process is skipped, so the chosen port reflects local occupancy at launch time rather than a reservation. Users see the occupied candidate move to the next one, not an error.
- The record is per Desktop channel and per `userData` directory, so a development and a stable Desktop can hold different ports. That is intended, but it means the sticky port is not a single machine-wide constant.
- A launch that had to use the random fallback does not hold that address on the next start; the fallback keeps the app usable without promising stability it does not have.
