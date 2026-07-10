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

### Step 1: Create the isolated data directory

```bash
mkdir -p /tmp/synergy-dev
```

### Step 2: Copy config from main environment

This avoids re-configuring API keys, providers, models, and agents:

```bash
cp -r ~/.synergy/config /tmp/synergy-dev/.synergy/config
```

This copies all domain config files (`00-general.jsonc` through `120-runtime.jsonc`) including your provider auth, model preferences, and custom agents.

### Step 3: Pick ports that don't conflict

The running instance likely uses 4096 (server) and 3000 (app). Use different ports:

```bash
# Common choices
--server-port 4097 --app-port 3001
--server-port 4098 --app-port 3002
```

If unsure what the running instance uses, check:

```bash
cat ~/.synergy/state/daemon/runtime-lock.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'pid={d[\"pid\"]} cwd={d[\"cwd\"]}')"
```

And look for the process's listening ports:

```bash
lsof -nP -Pan -p $(cat ~/.synergy/state/daemon/runtime-lock.json | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])") -iTCP -sTCP:LISTEN
```

### Step 4: Start the dev instance

```bash
SYNERGY_HOME=/tmp/synergy-dev bun dev web --server-port 4097 --app-port 3001
```

Or for desktop:

```bash
SYNERGY_HOME=/tmp/synergy-dev bun dev desktop --server-port 4097 --app-port 3001
```

### Step 5: Test your changes

The dev instance picks up source changes live:

- **Server code** (`packages/synergy/src/`): restart the dev instance to pick up changes
- **Web app code** (`packages/app/`, `packages/ui/`): Vite hot-reloads automatically
- **Desktop code** (`packages/desktop/`): restart the desktop process

### Step 6: Clean up when done

```bash
# Kill the dev instance (it has its own PID, safe to kill)
# The lock file is at /tmp/synergy-dev/.synergy/state/daemon/runtime-lock.json

# Optionally remove the temp directory
rm -rf /tmp/synergy-dev
```

## Quick Start (Copy-Paste)

```bash
# One-time setup
mkdir -p /tmp/synergy-dev
cp -r ~/.synergy/config /tmp/synergy-dev/.synergy/config

# Start dev instance (pick mode)
SYNERGY_HOME=/tmp/synergy-dev bun dev web --server-port 4097 --app-port 3001
# SYNERGY_HOME=/tmp/synergy-dev bun dev desktop --server-port 4097 --app-port 3001
# SYNERGY_HOME=/tmp/synergy-dev bun dev desktop --managed --server-port 4097 --app-port 3001
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
- **Port conflicts**: dev instance on default ports (4096/3000) will fail if main instance is running
- **Missing config**: without copying config, the dev instance has no API keys and can't call models
- **`bun dev send` without `SYNERGY_HOME`**: sends to the main instance's server — usually what you want for normal use, but use `SYNERGY_HOME` if testing CLI changes in isolation
