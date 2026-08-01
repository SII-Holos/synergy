# Qizhi Synergy Link Deployment Runbook

This runbook covers deploying, verifying, and recovering a [Synergy Link](../product/connections.md) host on the Qizhi platform: shared-filesystem containers, multi-instance hosts, and GPU job containers that need a stable remote-execution identity. It is the operational companion to the built-in `qizhi-synergy-link` Skill, which agents load automatically for these tasks.

## Supported Topology

- One physical or device instance (container, VM, or bare-metal host) runs exactly one Link host service.
- One Holos Agent ID belongs to exactly one instance. The Agent ID is the device identity; `synergy-link whoami` must always report the same `agentID` for the same instance.
- The Link host uses an Agent ID distinct from the Synergy application and from every other Link deployment on the same machine.
- A sender (Synergy runtime with Holos enabled) controls the host through a persisted Link target. The sender never stores the host's Holos secret.
- Shared persistent mounts may carry read-only binaries, read-only install assets, and read-only datasets for multiple instances.

## Unsupported Topology: Duplicate Agents

Running the same Holos Agent ID on two or more instances is unsupported. Holos tunnel routing is last-writer-wins: the most recently connected instance receives the traffic, and the earlier instance silently loses reachability. No local mechanism can reliably prevent or detect that race, and this runbook does not claim otherwise. Replacing a device requires a new Agent ID followed by a verified target relink; never move the old Agent identity to another device.

Never deploy two Link hosts that share a writable state root, a control socket, or a Holos credential store. A shared filesystem is not a high-availability cluster for Link.

## Forbidden Shared State

Never share these across Link instances, even on a common persistent mount:

- Writable `HOME` (shell history, SSH material, per-user caches, runtime dirs).
- Synergy runtime data `$SYNERGY_HOME/.synergy/`: config, `data/auth/`, sessions, Library, state, cache, log.
- Holos credential stores: Synergy runtime `$SYNERGY_HOME/.synergy/data/auth/` and the Link host's `$HOME/.synergy/data/auth/api-key.json` record written by `synergy-link login`.
- `SYNERGY_LINK_HOME` (default `$HOME/.synergy-link/`): `state.json`, `migrations.json`, `owner.json`, `control.sock`, `logs/`.
- Identity material: agent secrets, bind tokens, callback state, tunnel credentials.
- Control sockets, PID files, runtime locks, temp directories, log files.

Shared read-only binaries and read-only assets are allowed only when every instance mounts them read-only and no instance writes beside them.

## Per-Instance Namespace Layout

Use these generic variables; substitute per-deployment values:

```text
$INSTANCE_ROOT/            per-instance base (instance-local volume, NOT the shared mount)
  home/                    $HOME for the Link service user
  synergy-home/            $SYNERGY_HOME base; runtime data lives below .synergy/
  synergy-link/            $SYNERGY_LINK_HOME host root
  tmp/                     $TMPDIR for this instance
$SHARED_READONLY/          common mount: read-only binaries and assets only
```

Rules:

- Create one `$INSTANCE_ROOT` per instance; never point two instances at the same root.
- Set `SYNERGY_HOME=$INSTANCE_ROOT/synergy-home`, `SYNERGY_LINK_HOME=$INSTANCE_ROOT/synergy-link`, `HOME=$INSTANCE_ROOT/home`, and `TMPDIR=$INSTANCE_ROOT/tmp` in the service environment.
- Verify mounts: `df` and `mount` must show `$INSTANCE_ROOT` on instance-local storage and the shared mount read-only (`ro`).
- The control socket lives at `$SYNERGY_LINK_HOME/control.sock`. Exactly one live socket must exist per instance root; a second instance sharing the root would delete and replace it.

## Preflight Checklist

1. Container is dedicated: one Link service user; no other process holds `$SYNERGY_LINK_HOME`.
2. `SYNERGY_HOME`, `SYNERGY_LINK_HOME`, `HOME`, and `TMPDIR` point into `$INSTANCE_ROOT`, which is not on the shared mount.
3. Shared mount is read-only for this instance.
4. No stale control socket: `ls "$SYNERGY_LINK_HOME/control.sock"` should fail, or the owning process must be verified dead before removal.
5. Record `synergy-link --version` for the target record.
6. Disk space and log rotation for `$SYNERGY_LINK_HOME/logs/`; a full local disk breaks state writes and the control socket.

## Qizhi Process and Recovery Ownership

- Prefer a Qizhi workload/container supervisor that runs `synergy-link server` in the foreground with the complete per-instance environment. The platform owns restart policy and process lifetime; Link owns only its own state and control socket.
- `synergy-link start` is the supported fallback when the Qizhi workload cannot supervise a foreground command. Invoke it only from the platform terminal on the intended instance, never through a remote Link Bash call or merely because the shared binary is visible.
- Remote Bash is not a Link service manager. The host applies a best-effort pre-spawn guard to obvious direct detached launches (`tmux … -d`, `screen -dm`, `nohup`, `setsid`, `disown`, and shell `&`), but shell indirection cannot be exhaustively classified. Never use remote Link execution to recover or supervise the host.
- The Qizhi platform terminal is the required independent recovery channel. If operators cannot reach the intended instance without Link, do not deploy Link as that instance's only control path.

## Deploy and Start

1. Place the `synergy-link` binary under the per-instance bin path; keep the shared mount read-only.
2. Start the host: `synergy-link start` (background service) or `synergy-link server [--print-logs]` (foreground debugging).
3. Log in explicitly on non-interactive containers: `synergy-link login --agent-id <AGENT_ID> --agent-secret <SECRET>` on a secure console, or the interactive flow when a TTY exists. Credential import asks Holos to authenticate the secret and verifies that `/me` returns the supplied Agent ID before it replaces any saved credential. Never paste a secret into a prompt, log, or chat.
   The host reads Holos endpoint settings from the canonical `~/.synergy/config/synergy.d/100-holos.jsonc` domain file; legacy monolithic config is read only as migration fallback.
4. Confirm the service stayed up: `synergy-link status` must show `Status source: live` and exit zero. `snapshot (last-known)` is degraded diagnostic data, exits nonzero, and is not proof that the service is healthy.

## Verification

All three must pass:

1. **Identity**: `synergy-link whoami` → `loggedIn: true`, `agentID` matches the intended device identity, auth `source` is the expected store. Record `linkID`.
2. **Singleton/control socket**: `synergy-link status` shows `Status source: live`; exactly one service process per `$SYNERGY_LINK_HOME` (check `ps` for the PID shown in status). A `snapshot (last-known)` or a second instance answering means current ownership is unverified — stop and fix, do not reuse.
3. **Health**: `synergy-link doctor` — every applicable check `ok`:

| Check          | Meaning when ok                                                    |
| -------------- | ------------------------------------------------------------------ |
| `config_dir`   | `SYNERGY_LINK_HOME` resolves to this instance's root               |
| `mode`         | runtime mode reported                                              |
| `local_owner`  | managed owner lease is active; not applicable in standalone mode   |
| `auth`         | Holos credentials exist (standalone) or managed mode applies       |
| `endpoints`    | effective sanitized API, WebSocket, and portal endpoints           |
| `service`      | service running with a PID                                         |
| `connection`   | `connected` in standalone mode (or `disconnected` in managed mode) |
| `holos_secret` | present when auth exists; credentials accepted by Holos            |

Then force a reconnect and re-verify: `synergy-link reconnect` → `doctor` shows `connection: connected`.

## Sender Target Setup and Test

From the controlling Synergy runtime:

1. Create a target in Synergy Link Settings with the host's `targetAgentID` and `linkID`, or use the `connect` bootstrap path (`connect open` with `linkID` + `targetAgentID`).
2. Test the target: a successful probe records the host observation and sets authorization to `approved`; a `refused` probe sets `revoked`; a host identity mismatch fails with an error and leaves the target's last state unchanged — investigate before re-testing.
3. `connect list_targets` → confirm the target is enabled for the local agent, then `connect open` with the persisted `targetID`.
4. Run a trivial remote command to confirm execution and output routing.

## Safe Remote Work

- Remote Bash clamps `yieldSeconds` to five seconds so the auto-background result and process ID can return before the 30-second transport deadline.
- Remote blocking `process poll` waits are clamped to at most 30 seconds.
- For genuinely long work use the tracked background flow (`bash` with `background`/`yieldSeconds`, then `process` for poll/write/kill). Direct detached-daemon patterns are rejected on a best-effort basis before spawn; this guard is not a shell security boundary. Platform-supervised service lifetime and session-owned process-tree cleanup remain the enforcement boundaries.
- Every remote process belongs to the authenticated collaboration session that created it. Closing, kicking, disabling, or expiring that session terminates its process trees and removes retained output; a later session cannot list or control those process IDs.
- Duplicate delivery retries with the same request ID are idempotent inside one session. A transport timeout still does not prove a remote command failed, so reconnect and verify session state rather than changing the request and blindly retrying.
- Never copy agent secrets, tunnel URLs, bind tokens, or callback state into prompts, logs, target names, or chat.

## Incident Recovery

Symptom: sender sees `unknown` or `unreachable` availability, timeouts, or `refused`; or the wrong host answers.

1. Check the host: `synergy-link status` and `synergy-link doctor`. If the service is down, read `synergy-link logs --tail 200` and `$SYNERGY_LINK_HOME/logs/runtime.log`.
2. Check identity: `synergy-link whoami`. If `agentID` is not the expected device identity, the auth store is wrong or shared — do not continue; rotate credentials (below).
3. Check for a duplicate: a second live `synergy-link` process or a second instance reporting the same `agentID`. Stop the stale instance before touching the healthy one. Then `synergy-link reconnect` on the intended host and re-verify `doctor`.
4. If the control socket is stale (service dead but `control.sock` exists), remove it only after confirming no live service process owns it, then `synergy-link start`.
5. If an unrecoverable stale sender record remains, use `connect clear` for that target. It removes only the local cached session and does not contact the remote host.
6. Re-test from the sender: `connect` probe, then a bounded remote command.

## Credential Rotation and Relink

1. On the old host, run `synergy-link stop`. If it cannot be reached, revoke its Agent credential before continuing.
2. Create a distinct Holos Agent identity and Secret for the replacement device. Never copy or reuse the old host's Agent ID or Secret.
3. On the replacement host's secure console, log in with the new identity: `synergy-link login` (interactive) or `synergy-link login --agent-id <NEW_AGENT_ID> --agent-secret <NEW_SECRET>`. Keep the Secret out of logs and chat.
4. Run `synergy-link start`, then verify `whoami`, `doctor`, and the Link ID.
5. On the sender, atomically relink the persisted target to the replacement `targetAgentID` and `linkID`, and require a successful probe before remote work.
6. Confirm the old host remains stopped, revoke its credential, and retire its state only after the replacement target passes verification.

## Rollback

If replacement or relink verification fails:

1. Stop the replacement Link and revoke its new Agent credential.
2. Leave the sender target disabled while identity or reachability is uncertain.
3. From the Qizhi platform terminal on the original instance, verify its per-instance environment and restart the original Link only if its original Agent identity has not been moved or copied.
4. Re-run `whoami`, live `status`, and `doctor`, then relink the sender target to the original `targetAgentID` and `linkID` and require a successful probe.
5. Resume remote work only after the original host identity and a bounded command are verified. If the original host cannot be verified, keep the target disabled and provision another new identity instead.

## Stop and Decommission

- `synergy-link stop` stops the background service; confirm with `synergy-link status`.
- `synergy-link logout` clears the standalone host's Holos credential from its per-instance `$HOME/.synergy/data/auth/` and stops the runtime; use it before decommissioning.
- Remove the instance root only after the service is stopped and the control socket is gone.
- Remove or disable the sender target when an instance is retired so agents never route to a dead identity.

## Related Documentation

- [Connections: Synergy Link](../product/connections.md) — target model, host CLI, and ownership semantics
- [Storage and paths](../reference/storage-and-paths.md) — Synergy runtime home boundary
- [Synergy Link rebrand migration](../migrations/synergy-link-rebrand.md) — historical v1 → v2 state migration
