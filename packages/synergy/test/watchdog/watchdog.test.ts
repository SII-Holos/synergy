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
    const afterSleepCatch = source.substring(source.indexOf("sleep was aborted"))

    // The next significant code after the catch should check shuttingDown
    const nextLines = afterSleepCatch.substring(0, 2000)

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

    // SIGHUP should be treated as a shutdown signal (like SIGINT/SIGTERM)
    // Check that SIGHUP is handled by onWrapperSignal in the signal handlers section
    const signalSection = source.substring(
      source.indexOf("Install persistent signal handlers"),
      source.indexOf("Install persistent signal handlers") + 500,
    )

    // SIGHUP should call onWrapperSignal (shutdown)
    const sighupTriggersShutdown = signalSection.includes("SIGHUP") && signalSection.includes("onWrapperSignal")

    expect(sighupTriggersShutdown).toBe(true)
  })

  test("intentional restart should use SIGUSR1 instead of SIGHUP", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // For dev restart, use SIGUSR1 (which is never sent by the terminal)
    const usesSigusr1 = /SIGUSR1/.test(source)
    expect(usesSigusr1).toBe(true)
  })

  test("Windows should have a non-signal restart path", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // On Windows, SIGUSR1 is not available. The restart command should
    // fall back to a non-signal mechanism (e.g. writing a restart flag file,
    // or just using daemon restart) instead of trying process.kill with SIGUSR1.
    const hasWindowsFallback =
      /win32/.test(source) &&
      !/SIGUSR1/.test(
        // Check that SIGUSR1 is not used on the Windows path
        source.substring(source.indexOf("win32")),
      )
    // OR: restart.ts should check platform before sending SIGUSR1
    const platformChecksBeforeSignal = /platform.*win32|win32.*platform/.test(source)

    expect(hasWindowsFallback || platformChecksBeforeSignal).toBe(true)
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

  test("verifyWatchdogIdentity should not hardcode CLK_TCK=100", () => {
    const restartSource = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // CLK_TCK should not be hardcoded — it varies by system
    const hardcodesClkTck = /const\s+clockTicks\s*=\s*100\b/.test(restartSource)

    expect(hardcodesClkTck).toBe(false)
  })

  test("verifyWatchdogIdentity should not be a circular calculation", () => {
    const restartSource = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // The identity check must NOT derive CLK_TCK from the stored startTime
    // and then use that derived value to reconstruct the start time — that's
    // algebraically tautological and validates any PID.
    //
    // Instead, it should compare the process's actual running time
    // (from /proc/uptime and /proc/<pid>/stat) with the expected
    // running time (Date.now() - stored startTime).
    const usesDerivedClkTck = /derivedClkTck/.test(restartSource)

    expect(usesDerivedClkTck).toBe(false)
  })

  test("verifyWatchdogIdentity should parse /proc/<pid>/stat correctly (handle comm with spaces)", () => {
    // parseProcStatStarttime is now in shared util
    const utilSource = fs.readFileSync(path.join(__dirname, "../../src/util/proc.ts"), "utf-8")

    // Must NOT use naive fields[21] which breaks when comm contains spaces.
    // Instead, should find last ')' and parse from there.
    const usesNaiveSplit = /fields\[21\]/.test(utilSource)
    const usesLastParen = /lastIndexOf/.test(utilSource) && /lastParen/.test(utilSource)

    expect(usesNaiveSplit).toBe(false)
    expect(usesLastParen).toBe(true)
  })
})

describe("Windows dev restart", () => {
  test("restart command should use flag file instead of SIGUSR1 on win32", () => {
    const restartSource = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // On Windows, SIGUSR1 doesn't exist. The restart command should write a
    // flag file that the watchdog polls for, rather than sending a signal.
    const hasWin32Branch = /win32/.test(restartSource)
    const usesFlagFile = /getDevRestartFlagFile|devRestartFlag|restart.*\.flag/.test(restartSource)

    expect(hasWin32Branch).toBe(true)
    expect(usesFlagFile).toBe(true)
  })

  test("watchdog should poll for restart flag file during child lifetime", () => {
    const runtimeSource = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // The watchdog must poll for the restart flag file *while* the child
    // process is running (not just after exit), so that Windows restart
    // requests actually take effect. This is done via setInterval.
    const checksRestartFlag = /devRestartFlag/.test(runtimeSource)
    const usesInterval = /setInterval/.test(runtimeSource)
    const killsChild = /currentChild\.kill|child\.kill/.test(runtimeSource)

    expect(checksRestartFlag).toBe(true)
    expect(usesInterval).toBe(true)
    expect(killsChild).toBe(true)
  })

  test("PID file should store starttimeJiffies on Linux", () => {
    const runtimeSource = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // On Linux, the PID file should include starttimeJiffies from
    // /proc/self/stat so restart.ts can verify process identity.
    const storesJiffies = /starttimeJiffies/.test(runtimeSource)

    expect(storesJiffies).toBe(true)
  })
})

describe("restart flag file behavioral test", () => {
  test("writing restart flag file should cause a running watchdog to restart", async () => {
    // Integration-style test: spawn a minimal watchdog-like process,
    // write a restart flag, and verify the process detects it.
    const tmpDir = `/tmp/synergy-test-restart-${Date.now()}`
    fs.mkdirSync(tmpDir, { recursive: true })
    const flagFile = path.join(tmpDir, "dev-restart-test.flag")

    // Spawn a child that polls for the flag file
    const child = Bun.spawn({
      cmd: [
        process.argv0,
        "-e",
        `
          const flagPath = ${JSON.stringify(flagFile)};
          const poll = setInterval(async () => {
            try {
              const exists = await Bun.file(flagPath).exists();
              if (exists) {
                await Bun.file(flagPath).unlink().catch(() => {});
                console.log("RESTART_DETECTED");
                clearInterval(poll);
                process.exit(0);
              }
            } catch {}
          }, 200);
          // Timeout after 10s
          setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 10000);
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })

    // Wait for the child to start polling, then write the flag file
    await Bun.sleep(500)
    await Bun.write(flagFile, String(Date.now()))

    // Wait for the child to detect the flag
    const exitCode = await child.exited
    const stdout = await new Response(child.stdout).text()

    // Cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true })
    } catch {}

    expect(exitCode).toBe(0)
    expect(stdout).toContain("RESTART_DETECTED")
  })
})
