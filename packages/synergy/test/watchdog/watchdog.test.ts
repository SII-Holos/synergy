import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs"
import crypto from "crypto"

/**
 * Tests for the dev watchdog restart policy.
 *
 * TDD approach: these tests should FAIL before the fix is applied,
 * and PASS after the fix.
 */

describe("dev watchdog crash-loop accounting", () => {
  test("SIGHUP-triggered restarts should NOT count toward crash budget", () => {
    // Read the runtime source to verify that SIGHUP sets a flag
    // that prevents crash counting for intentional restarts
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // The onSighup handler should set a flag (e.g. intentionalRestart)
    // that the respawn loop checks to skip crash counting
    const hasIntentionalRestartFlag = /intentionalRestart|restartRequested|devRestartRequested/.test(source)

    // The respawn loop should check this flag before incrementing crash count
    const crashCountingSkipsIntentional = /intentionalRestart|restartRequested|devRestartRequested/.test(
      source.substring(source.indexOf("for (;;)")),
    )

    expect(hasIntentionalRestartFlag).toBe(true)
    expect(crashCountingSkipsIntentional).toBe(true)
  })
})

describe("dev watchdog shutdown during backoff", () => {
  test("after aborted backoff sleep, should check shuttingDown before respawning", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // After the catch block for the aborted sleep, there should be
    // a check of shuttingDown before falling through to respawn
    const afterSleepCatch = source.substring(source.indexOf("sleep was aborted by shutdown signal"))

    // The next significant code after the catch should check shuttingDown
    const nextLines = afterSleepCatch.substring(0, 500)

    // Should contain a check like: if (shuttingDown) { ... process.exit }
    // before respawning
    const hasShuttingDownCheckAfterAbort = /if\s*\(\s*shuttingDown\s*\)/.test(nextLines)

    expect(hasShuttingDownCheckAfterAbort).toBe(true)
  })
})

describe("dev watchdog PID file scoping", () => {
  test("PID file path should include cwd hash to avoid multi-instance conflicts", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // The PID file should not be a static global name
    // It should incorporate something unique per working directory
    const hasGlobalPidPath = /dev-watchdog\.pid/.test(source) && !/dev-watchdog-/.test(source)
    const hasScopedPidPath = /dev-watchdog-/.test(source) || /scopeId|cwd.*hash|directory.*hash/.test(source)

    // Should NOT use a single global path like "dev-watchdog.pid"
    expect(hasGlobalPidPath).toBe(false)
    // Should use a scoped path
    expect(hasScopedPidPath).toBe(true)
  })
})

describe("dev watchdog signal handling", () => {
  test("SIGHUP should trigger shutdown, not restart", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // The onSighup handler should NOT just kill the child for restart.
    // Instead, SIGHUP should be treated the same as SIGINT/SIGTERM (shutdown).
    // Intentional restart should use SIGUSR1 instead.
    const onSighupSection = source.substring(source.indexOf("onSighup"), source.indexOf("onSighup") + 300)

    // SIGHUP should call onWrapperSignal (shutdown) or be removed as a restart trigger
    const sighupTriggersShutdown = /onWrapperSignal|shuttingDown\s*=\s*true/.test(onSighupSection)
    // It should NOT just kill the child (restart behavior)
    const sighupJustKillsChild = /child\.kill\("SIGTERM"\)/.test(onSighupSection) && !sighupTriggersShutdown

    expect(sighupJustKillsChild).toBe(false)
  })

  test("intentional restart should use SIGUSR1 instead of SIGHUP", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // For dev restart, use SIGUSR1 (which is never sent by the terminal)
    const usesSigusr1 = /SIGUSR1/.test(source)
    expect(usesSigusr1).toBe(true)
  })
})

describe("dev watchdog dead code", () => {
  test("sigint and sigterm locals inside spawn loop should not exist", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // These dead locals should be removed
    const hasDeadSigintLocal = /const sigint\s*=/.test(source)
    const hasDeadSigtermLocal = /const sigterm\s*=/.test(source)

    expect(hasDeadSigintLocal).toBe(false)
    expect(hasDeadSigtermLocal).toBe(false)
  })
})

describe("restart command uses SIGUSR1", () => {
  test("restart.ts should send SIGUSR1 to watchdog, not SIGHUP", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // The restart command should send SIGUSR1 for intentional restart
    // SIGHUP should not be used since it conflicts with terminal hangup
    const sendsSighup = /SIGHUP/.test(source)
    const sendsSigusr1 = /SIGUSR1/.test(source)

    expect(sendsSighup).toBe(false)
    expect(sendsSigusr1).toBe(true)
  })
})

describe("dev script --restart=dev injection", () => {
  test("--restart=dev should NOT be in the root dev script (breaks non-server subcommands)", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../../../package.json"), "utf-8")
    const pkg = JSON.parse(source)

    // The root `dev` script is the entrypoint for ALL CLI subcommands
    // (server, web, restart, send, prepare, etc.)
    // --restart=dev is a server-only flag and will cause yargs validation
    // errors for non-server commands like `bun dev web --dev` or `bun dev restart`
    const devScript = pkg.scripts.dev

    // Should NOT contain --restart=dev in the generic dev script
    expect(devScript).not.toContain("--restart=dev")
  })

  test("--restart=dev should be applied only in the server command handler", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/server.ts"), "utf-8")

    // The server command should default to --restart=dev for local installs
    // or explicitly set it. This is the right place for server-specific flags.
    const hasDevRestartDefault = /isLocal.*dev|restartPolicy.*dev|--restart=dev/.test(source)

    expect(hasDevRestartDefault).toBe(true)
  })
})

describe("PID file hash consistency", () => {
  test("watchdog and restart should use the same cwd for PID file hash", () => {
    const runtimeSource = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")
    const restartSource = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // Both must agree on the directory used for hashing the PID file path.
    // The watchdog uses `parentCwd = process.cwd()`, but the CLI entrypoint
    // sets `SYNERGY_CWD=$PWD` and runs with `--cwd packages/synergy`,
    // so `process.cwd()` in the watchdog would be `packages/synergy`.
    // The restart command uses `SYNERGY_CWD ?? process.cwd()`.
    //
    // The fix: both should use SYNERGY_CWD ?? process.cwd() for consistency.

    // Check that runtime.ts uses SYNERGY_CWD for the PID file hash calculation
    // Look in the broader watchdog function area, not just after devPidFile
    const watchdogArea = runtimeSource.substring(
      runtimeSource.indexOf("runWithRestartPolicyAlways"),
      runtimeSource.indexOf("const onWrapperSignal"),
    )
    const runtimeUsesSynergyCwd = /SYNERGY_CWD/.test(watchdogArea)

    // Check that restart.ts uses SYNERGY_CWD
    const restartUsesSynergyCwd = /SYNERGY_CWD/.test(restartSource)

    expect(runtimeUsesSynergyCwd).toBe(true)
    expect(restartUsesSynergyCwd).toBe(true)
  })
})

describe("PID file identity token", () => {
  test("PID file should store more than just PID to prevent signaling wrong process", () => {
    const runtimeSource = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // The PID file should contain an identity token (e.g. startup timestamp)
    // that can be verified before signaling, preventing PID reuse attacks
    const pidFileWriteSection = runtimeSource.substring(runtimeSource.indexOf("Bun.write(devPidFile")).substring(0, 200)

    // Should write more than just process.pid — e.g. JSON with {pid, startTime}
    const writesJustPid = /Bun\.write\(devPidFile,\s*String\(process\.pid\)\)/.test(pidFileWriteSection)

    expect(writesJustPid).toBe(false)
  })

  test("restart.ts should verify identity token before signaling", () => {
    const restartSource = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // The restart command should read the PID file and verify the identity
    // token (e.g. check that the process start time matches) before sending SIGUSR1
    const verifiesIdentity = /startTime|identity|token|birthtime|start_time|proc.*stat/.test(restartSource)

    expect(verifiesIdentity).toBe(true)
  })
})
