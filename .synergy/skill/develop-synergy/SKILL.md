---
name: develop-synergy
description: "Workflow for developing Synergy using Synergy itself. Use when the user needs to test code changes to Synergy without disrupting their running Synergy session, or when they need to run a second isolated Synergy instance for development. Triggers: 'develop synergy', 'test my changes', 'debug synergy', 'second instance', 'isolated synergy', 'SYNERGY_HOME', 'dev workflow', 'dev instance'."
---

# Developing Synergy with Synergy

## Core Principle: Never Disrupt the Running Instance

When you are chatting with Synergy **and** modifying Synergy's source code at the same time, the session you are talking to **must never be stopped, restarted, or disrupted**. The development workflow uses a fully isolated second instance.

## How Isolation Works: `SYNERGY_HOME`

Synergy's entire runtime state is rooted at `process.env.SYNERGY_HOME` or `os.homedir()`:

```ts
// packages/synergy/src/global/index.ts:11
function homeDir() {
  return process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME || os.homedir()
}
```

Setting `SYNERGY_HOME` redirects the entire `.synergy/` directory to a new path:

| What moves                                   | Path relative to `$SYNERGY_HOME` |
| -------------------------------------------- | -------------------------------- |
| All session data                             | `.synergy/data/`                 |
| Logs                                         | `.synergy/log/`                  |
| Config (API keys, providers, models, agents) | `.synergy/config/`               |
| Daemon state, runtime locks                  | `.synergy/state/`                |
| Cache (models, provider catalog)             | `.synergy/cache/`                |

This means the dev instance gets its own lock file, its own sessions, and its own port binding — **zero conflict** with the main instance.

## When to Use This Workflow

- You made code changes to `packages/synergy/`, `packages/app/`, `packages/desktop/`, `packages/ui/`, etc. and want to test them
- You want to see how a feature behaves with a clean session slate
- You need to debug a server startup issue without touching the running session
- You want to run two different branches concurrently

## Safety Rules

1. **NEVER** run `synergy stop`, `kill`, `pkill synergy`, or any command that terminates the current Synergy process
2. **NEVER** modify `~/.synergy/` while the main instance is running
3. **NEVER** use the same ports as the running instance for the dev instance
4. Always use `SYNERGY_HOME` pointing to a temporary or dedicated dev directory
5. Always use explicit `--server-port` and `--app-port` that differ from the running instance's ports

## Three Startup Modes

### Mode 1: `bun dev web` — server + web UI

Best for testing most code changes (CLI, server, tools, session logic, web UI).

```bash
bun dev web --server-port 4097 --app-port 3001
```

Starts:

- Synergy server on port 4097
- Vite dev server for the web app on port 3001
- Opens the browser to `http://127.0.0.1:3001`

### Mode 2: `bun dev desktop` — server + web UI + Electron shell

Best for testing Electron-specific features (window management, native menus, browser workspace, managed server lifecycle).

```bash
bun dev desktop --server-port 4097 --app-port 3001
```

Starts the same as `web` plus an Electron window connected to the dev server. Uses **external mode** by default (Electron connects to the existing server, doesn't manage its lifecycle).

### Mode 3: `bun dev desktop --managed` — managed server mode

Best for testing the production-style managed server path (auto-start, auto-stop, restart recovery).

```bash
bun dev desktop --managed --server-port 4097 --app-port 3001
```

Builds the web app dist first, then launches Electron in managed mode where the Electron shell owns the server lifecycle.

## Complete Setup Recipe

### Step 1: Scan existing instances before choosing ports

**Never assume** 4097/3001 are free. If you have multiple worktrees or dev instances running, those ports might be taken. Always scan first:

```bash
# Find all Synergy runtime lock files across known SYNERGY_HOME paths
for d in ~/.synergy /tmp/synergy-dev*; do
  lock="$d/state/daemon/runtime-lock.json"
  if [ -f "$lock" ]; then
    pid=$(python3 -c "import json; print(json.load(open('$lock'))['pid'])" 2>/dev/null)
    if kill -0 "$pid" 2>/dev/null; then
      ports=$(lsof -nP -Pan -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk '/LISTEN/{print $9}' | sed 's/.*://')
      echo "ALIVE pid=$pid ports=[$ports] home=$d"
    fi
  fi
done
```

This shows all live Synergy processes and their listening ports. Use this to pick the next free port pair.

### Step 2: Create the isolated data directory

```bash
# Per-worktree isolation — use a directory named after the branch or worktree
mkdir -p /tmp/synergy-dev

# Or if you have multiple worktrees:
mkdir -p "/tmp/synergy-dev-$(git branch --show-current)"
```

### Step 3: Copy config from main environment

This avoids re-configuring API keys, providers, models, and agents:

```bash
cp -r ~/.synergy/config /tmp/synergy-dev/.synergy/config
```

This copies all domain config files (`00-general.jsonc` through `120-runtime.jsonc`) including your provider auth, model preferences, and custom agents.

### Step 4: Choose ports that don't conflict with any running instance

The default main instance uses 4096 (server) and 3000 (app). Based on Step 1's scan, pick the **next free pair**:

```bash
# Common port pairs, try each until you find a free one:
# 4097 + 3001  (first dev instance)
# 4098 + 3002  (second dev instance)
# 4099 + 3003  (third dev instance)
# ... and so on
```

If you ran the scan in Step 1 and 4097 is taken, move to 4098/3002. If both are taken, try 4099/3003, etc.

### Step 5: Start the dev instance

```bash
SYNERGY_HOME=/tmp/synergy-dev bun dev web --server-port 4097 --app-port 3001
```

Or for desktop:

```bash
SYNERGY_HOME=/tmp/synergy-dev bun dev desktop --server-port 4097 --app-port 3001
```

### Step 6: Test your changes

The dev instance picks up source changes live:

- **Server code** (`packages/synergy/src/`): restart the dev instance to pick up changes
- **Web app code** (`packages/app/`, `packages/ui/`): Vite hot-reloads automatically
- **Desktop code** (`packages/desktop/`): restart the desktop process

### Step 7: Clean up when done

```bash
# Kill the dev instance (it has its own PID, safe to kill)
# The lock file is at /tmp/synergy-dev/.synergy/state/daemon/runtime-lock.json

# Optionally remove the temp directory
rm -rf /tmp/synergy-dev
```

## Quick Start (Copy-Paste)

```bash
# Step 0: Scan for existing instances
for d in ~/.synergy /tmp/synergy-dev*; do
  lock="$d/state/daemon/runtime-lock.json"
  [ -f "$lock" ] && pid=$(python3 -c "import json; print(json.load(open('$lock'))['pid'])") && kill -0 "$pid" 2>/dev/null && \
    echo "TAKEN: home=$d pid=$pid ports=$(lsof -nP -Pan -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk '/LISTEN/{print $9}' | sed 's/.*://' | tr '\n' ' ')"
done

# Step 1: Choose a free port pair (based on scan above) and set up
export SYN_HOME="/tmp/synergy-dev-$(git branch --show-current)"
mkdir -p "$SYN_HOME"
cp -r ~/.synergy/config "$SYN_HOME/.synergy/config"

# Step 2: Start dev instance (pick mode; use the ports you confirmed free)
SYNERGY_HOME="$SYN_HOME" bun dev web --server-port 4097 --app-port 3001
# SYNERGY_HOME="$SYN_HOME" bun dev desktop --server-port 4097 --app-port 3001
# SYNERGY_HOME="$SYN_HOME" bun dev desktop --managed --server-port 4097 --app-port 3001
```

## Key Files Referenced

| File                                                    | Purpose                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/synergy/src/global/index.ts:11`               | `homeDir()` — `SYNERGY_HOME` resolution                      |
| `packages/synergy/src/daemon/server-process-lock.ts:40` | Lock acquisition — `AlreadyRunningError` prevention          |
| `packages/synergy/src/daemon/paths.ts:17`               | `runtimeLock()` — lock file path under `state/daemon/`       |
| `./script/dev.ts`                                       | `bun dev` orchestrator — `web`, `desktop`, `server` commands |

## Common Pitfalls

- **Forgetting `SYNERGY_HOME`**: without it, the dev instance uses `~/.synergy/` and hits `AlreadyRunningError`
- **Port conflicts across worktrees**: if you have multiple worktrees each running a dev instance, 4097/3001 will be taken by the first one. Always run the scan in Step 1 before picking ports.
- **Missing config**: without copying config, the dev instance has no API keys and can't call models
- **`bun dev send` without `SYNERGY_HOME`**: sends to the main instance's server — usually what you want for normal use, but use `SYNERGY_HOME` if testing CLI changes in isolation
