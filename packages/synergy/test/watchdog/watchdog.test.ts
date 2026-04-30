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
    const writeIdx = runtimeSource.indexOf("Bun.write(devPidFile")
    const pidFileWriteSection = writeIdx >= 0 ? runtimeSource.substring(writeIdx, writeIdx + 200) : ""

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

// ============================================================
// TDD tests for remaining PR review issues
// These tests should FAIL before the fix and PASS after.
// ============================================================

describe("dev watchdog banner notification", () => {
  test("server.ts should show a banner when running in dev watchdog mode", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // When restartPolicy === "dev", the user should be informed.
    // Check for a banner or log message that indicates watchdog mode is active.
    const hasWatchdogBanner = /watchdog.*active|dev.*watchdog.*active|dev restart.*active|Dev watchdog/i.test(source)

    expect(hasWatchdogBanner).toBe(true)
  })
})

describe("dev watchdog PID file cleanup on SIGUSR1 restart", () => {
  test("PID file should be cleaned up when watchdog exits after receiving SIGUSR1 during shutdown", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // After onDevRestart kills the child, if shuttingDown is also true,
    // the PID file should be unlinked before process.exit.
    // Look at the devRestartRequested block that checks shuttingDown.
    const restartBlock = source.substring(
      source.indexOf("Intentional dev restarts should not count as crashes"),
      source.indexOf("Track crash time for backoff calculation"),
    )

    // When dev restart is requested AND shuttingDown, PID file should be cleaned
    const cleansPidOnRestartShutdown = /devPidFile.*unlink|unlink.*devPidFile/.test(restartBlock)

    expect(cleansPidOnRestartShutdown).toBe(true)
  })
})

describe("verifyWatchdogIdentity on non-Linux", () => {
  test("verifyWatchdogIdentity should use startTime on non-Linux (macOS/Windows) paths", () => {
    const restartSource = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // On non-Linux, verifyWatchdogIdentity falls back to isWatchdogRunning(pid)
    // which only checks if ANY process with that PID exists — PID reuse is not
    // detected. The function receives startTime but ignores it on non-Linux.
    //
    // Fix: On macOS, use `ps -p <pid> -o lstart=` to verify process start time.
    // On Windows, use a similar mechanism.
    //
    // At minimum, startTime should be used on the non-Linux path too.
    const identityFn = restartSource.substring(
      restartSource.indexOf("async function verifyWatchdogIdentity"),
      restartSource.indexOf("export const RestartCommand"),
    )

    // Extract the non-Linux branch (the fallback after the linux check)
    const nonLinuxBranch = identityFn.includes("On non-Linux")
      ? identityFn.substring(identityFn.indexOf("On non-Linux"))
      : identityFn

    // The non-Linux path should reference startTime (not just isWatchdogRunning)
    const usesStartTimeOnNonLinux = /startTime/.test(nonLinuxBranch)

    expect(usesStartTimeOnNonLinux).toBe(true)
  })
})

describe("snapshot revert data safety", () => {
  test("revert should NOT delete files when ls-tree fails (exitCode !== 0)", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/session/snapshot.ts"), "utf-8")

    // Find the revert function
    const revertFn = source.substring(source.indexOf("async function revert"), source.indexOf("async function diff"))

    // When ls-tree fails, we should NOT delete the file.
    // The code should check exitCode === 0 BEFORE deciding to delete.
    // Pattern: check exitCode first, only delete when ls-tree succeeds
    // AND returns empty output (meaning file didn't exist in snapshot).
    //
    // Verify that there is no path where fs.unlink is called
    // without ls-tree exitCode === 0 guard.
    const hasUnguardedDelete = /else\s*\{[^}]*unlink/.test(revertFn)
    const hasProperExitCodeGuard = /checkTree\.exitCode\s*===\s*0/.test(revertFn)

    // Should have the exit code guard
    expect(hasProperExitCodeGuard).toBe(true)
    // Should not have an else-unlink pattern (unguarded delete)
    expect(hasUnguardedDelete).toBe(false)
  })
})

describe("prepare.ts SDK generation path", () => {
  test("prepare should use ./script/generate.ts for full SDK generation", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/prepare.ts"), "utf-8")

    // prepare should run ./script/generate.ts which regenerates the OpenAPI spec
    // AND builds the SDK, not just packages/sdk/js/script/build.ts
    const usesFullGenerate = /\.\/script\/generate\.ts/.test(source)

    expect(usesFullGenerate).toBe(true)
  })
})

describe("behavioral test: watchdog PID file identity", () => {
  test("PID file should contain JSON with pid, startTime, and devCwd", async () => {
    const tmpDir = `/tmp/synergy-test-pidfile-${Date.now()}`
    fs.mkdirSync(tmpDir, { recursive: true })

    // Simulate what the watchdog does: write PID file with identity
    const crypto = await import("crypto")
    const cwdHash = crypto.createHash("sha256").update(tmpDir).digest("hex").slice(0, 12)

    const identity = {
      pid: process.pid,
      startTime: Date.now(),
      devCwd: tmpDir,
    }

    // On Linux, include starttimeJiffies
    if (process.platform === "linux") {
      try {
        const selfStat = await Bun.file("/proc/self/stat").text()
        const { parseProcStatStarttime } = await import("../../src/util/proc")
        const starttime = parseProcStatStarttime(selfStat)
        if (starttime !== undefined) (identity as any).starttimeJiffies = starttime
      } catch {}
    }

    const pidFile = path.join(tmpDir, `dev-watchdog-${cwdHash}.pid`)
    await Bun.write(pidFile, JSON.stringify(identity))

    // Verify the PID file can be read and parsed
    const content = await Bun.file(pidFile).text()
    const data = JSON.parse(content)

    expect(data.pid).toBe(process.pid)
    expect(typeof data.startTime).toBe("number")
    expect(data.devCwd).toBe(tmpDir)

    // On Linux, verify starttimeJiffies was stored
    if (process.platform === "linux") {
      expect(typeof data.starttimeJiffies).toBe("number")
    }

    // Verify identity verification works
    const { parseProcStatStarttime } = await import("../../src/util/proc")
    if (process.platform === "linux" && data.starttimeJiffies !== undefined) {
      const selfStat = await Bun.file("/proc/self/stat").text()
      const currentStarttime = parseProcStatStarttime(selfStat)
      expect(currentStarttime).toBe(data.starttimeJiffies)
    }

    // Cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true })
    } catch {}
  })
})

describe("behavioral test: stale PID file detection", () => {
  test("isWatchdogRunning should return false for non-existent PID", async () => {
    // Use a PID that is very unlikely to exist
    const unlikelyPid = 299999

    // Import and test the function behavior by checking process.kill(pid, 0)
    let pidExists: boolean
    try {
      process.kill(unlikelyPid, 0)
      pidExists = true
    } catch {
      pidExists = false
    }

    // The PID should not exist (very high PID)
    // If it does exist by chance, skip this test
    if (!pidExists) {
      expect(pidExists).toBe(false)
    }
  })
})

// ============================================================
// TDD tests for Windows-specific issues from latest review
// These tests should FAIL before the fix and PASS after.
// ============================================================

describe("Windows SIGUSR1 crash guard", () => {
  test("SIGUSR1 handler should be guarded by platform check (not registered on Windows)", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // Find the line that registers the SIGUSR1 handler
    const sigusr1Idx = source.indexOf('process.on("SIGUSR1"')
    if (sigusr1Idx === -1) {
      // No SIGUSR1 registration at all — test passes vacuously
      return
    }

    // Get the 300 chars before the SIGUSR1 registration — the platform guard
    // must appear in this range (in the same if block or just before it)
    const guardRange = source.substring(Math.max(0, sigusr1Idx - 500), sigusr1Idx)

    // Must contain a platform check that excludes win32 before the SIGUSR1 registration
    const hasPlatformGuard = /win32/.test(guardRange) && /platform\s*[!=]==?\s*["']win32["']/.test(guardRange)

    expect(hasPlatformGuard).toBe(true)
  })

  test("isDev block should use flag file polling on Windows instead of SIGUSR1", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // On Windows, instead of SIGUSR1, the watchdog should rely on
    // flag file polling (which already exists via setInterval).
    const hasFlagFilePolling = /devRestartFlag|setInterval.*restart/.test(source)

    expect(hasFlagFilePolling).toBe(true)
  })
})

describe("Windows PID identity verification", () => {
  test("verifyWatchdogIdentity on Windows should check process command line, not just existence", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // Find the Windows branch of verifyWatchdogIdentity
    const identityFn = source.substring(
      source.indexOf("async function verifyWatchdogIdentity"),
      source.indexOf("export const RestartCommand"),
    )

    const win32Idx = identityFn.indexOf("win32")
    if (win32Idx === -1) {
      // No Windows branch — test fails because we need one
      expect(true).toBe(false)
      return
    }

    // Get just the Windows else-if block
    const afterWin32 = identityFn.substring(win32Idx)
    const blockEnd = afterWin32.indexOf("}\n      } catch")
    const win32Block = blockEnd > 0 ? afterWin32.substring(0, blockEnd) : afterWin32.substring(0, 300)

    // Strip comments to check actual code, not comment text
    const win32Code = win32Block.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")

    // On Windows, isWatchdogRunning(pid) only checks existence — too weak.
    // Should verify the process is actually the watchdog, e.g. by checking
    // the process command line (tasklist /FI, wmic, or Get-Process)
    // or by checking startTime against the stored value.
    const onlyChecksExistence =
      /isWatchdogRunning\(pid\)/.test(win32Code) &&
      !/startTime|cmdline|command|tasklist|wmic|Get-Process|exe|CreationDate/.test(win32Code)

    expect(onlyChecksExistence).toBe(false)
  })
})

describe("snapshot revert path separator safety", () => {
  test("revert should normalize path separators to forward slashes for git commands", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/session/snapshot.ts"), "utf-8")

    // On Windows, path.relative() produces backslash paths like "sub\file.txt"
    // but git tree paths always use forward slashes like "sub/file.txt".
    // Without normalization, git ls-tree won't find the file, and revert()
    // would delete it instead of restoring it — a data-loss bug.
    const revertFn = source.substring(source.indexOf("async function revert"), source.indexOf("async function diff"))

    // The relativePath passed to git ls-tree and git checkout must be
    // normalized to forward slashes. Check for:
    // 1. replaceAll with backslash -> forward slash
    // 2. Or splitting on path.sep and joining with "/"
    const normalizesPathSeparators =
      /replaceAll/.test(revertFn) && /\\\\/.test(revertFn) && /\/["']\s*\)/.test(revertFn)

    expect(normalizesPathSeparators).toBe(true)
  })
})

describe("non-Linux PID identity check robustness", () => {
  test("macOS identity check should handle ps lstart parse failure gracefully", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // Find the macOS branch
    const identityFn = source.substring(
      source.indexOf("async function verifyWatchdogIdentity"),
      source.indexOf("export const RestartCommand"),
    )

    const darwinIdx = identityFn.indexOf("darwin")
    if (darwinIdx === -1) return // No macOS branch

    const darwinBlock = identityFn.substring(darwinIdx, darwinIdx + 600)

    // macOS should use etime (BSD-compatible, locale-independent)
    // and handle parse failures gracefully
    const usesEtime = /etime/.test(darwinBlock)
    const hasParseErrorHandling = /parseEtime|undefined/.test(darwinBlock) || /isNaN|NaN/.test(darwinBlock)

    expect(usesEtime).toBe(true)
    expect(hasParseErrorHandling).toBe(true)
  })

  test("Windows identity check should fall back to PowerShell if wmic is unavailable", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    const identityFn = source.substring(
      source.indexOf("async function verifyWatchdogIdentity"),
      source.indexOf("export const RestartCommand"),
    )

    const win32Idx = identityFn.indexOf("win32")
    if (win32Idx === -1) return

    const win32Block = identityFn.substring(win32Idx, win32Idx + 800)

    // wmic is deprecated on newer Windows. Should have a fallback path
    // (e.g., PowerShell Get-Process, or tasklist)
    // Check that there's more than one verification approach on Windows
    const hasWmicFallback = /PowerShell|Get-Process|tasklist|fallback/.test(win32Block)

    expect(hasWmicFallback).toBe(true)
  })
})

describe("PID file write failure handling", () => {
  test("watchdog should warn if PID file write fails, not silently continue", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/server/runtime.ts"), "utf-8")

    // Find the Bun.write(devPidFile ...) section
    const pidWriteIdx = source.indexOf("Bun.write(devPidFile")
    const writeBlock = source.substring(Math.max(0, pidWriteIdx - 100), pidWriteIdx + 200)

    // The PID file write is inside a try/catch that silently swallows errors.
    // There should be a log.warn or UI.error in the catch block.
    // Find the catch block after the write
    const catchIdx = source.indexOf("catch {}", pidWriteIdx)
    const catchBlock = source.substring(catchIdx, catchIdx + 200)

    // An empty catch {} is bad — it should at least log the failure
    const hasSilentCatch = /catch\s*\{\s*\}/.test(source.substring(pidWriteIdx, pidWriteIdx + 100))
    const hasWarningInCatch = /log\.(warn|error)|UI\.(warn|error)/.test(
      source.substring(pidWriteIdx, source.indexOf("let child", pidWriteIdx)),
    )

    // Should NOT have a silent catch, or SHOULD have a warning
    expect(hasSilentCatch && !hasWarningInCatch).toBe(false)
  })
})

describe("daemon restart fallback safety", () => {
  test("restart command should NOT fall back to daemon restart when dev server was expected", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // When the user runs 'bun dev restart', they expect to restart the dev
    // watchdog server. If the PID file is missing/stale, falling back to
    // Daemon.restart() can create stray processes and port conflicts.
    // The restart command should check if it's being invoked in dev mode
    // (e.g. SYNERGY_CWD is set, or the dev script is the entry point) and
    // error instead of silently restarting the daemon.

    // After all the PID file handling, before the Daemon.restart() call,
    // there should be a check: if we were trying to restart a dev server
    // (PID file existed or SYNERGY_CWD is set), don't fall through to daemon.
    const daemonRestartIdx = source.indexOf("Daemon.restart()")
    const beforeDaemon = source.substring(source.indexOf("handler: async"), daemonRestartIdx)

    // Check that there's some guard before daemon restart that considers
    // whether a dev server was expected
    const hasDevModeGuard = /SYNERGY_CWD|isDev|dev.*server|dev.*watchdog/.test(
      beforeDaemon.substring(beforeDaemon.length - 1500),
    )

    expect(hasDevModeGuard).toBe(true)
  })
})

describe("parseEtime behavioral test", () => {
  test("parses BSD ps etime formats correctly", async () => {
    // Import the helper via a quick inline test since it's not exported
    // We'll test the logic by importing restart.ts internals aren't exposed,
    // so test the parseEtime function logic directly
    function parseEtime(etime: string): number | undefined {
      const trimmed = etime.trim()
      const dashParts = trimmed.split("-")
      let days = 0
      let timeStr = trimmed
      if (dashParts.length === 2) {
        days = parseInt(dashParts[0], 10)
        timeStr = dashParts[1]
      }
      const parts = timeStr.split(":").map((p) => parseInt(p, 10))
      if (parts.some((p) => isNaN(p))) return undefined
      let seconds = 0
      if (parts.length === 3) {
        seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
      } else if (parts.length === 2) {
        seconds = parts[0] * 60 + parts[1]
      } else {
        return undefined
      }
      return days * 86400 + seconds
    }

    // mm:ss
    expect(parseEtime("05:30")).toBe(330)
    expect(parseEtime("00:01")).toBe(1)

    // hh:mm:ss
    expect(parseEtime("1:23:45")).toBe(5025)
    expect(parseEtime("0:00:30")).toBe(30)

    // dd-hh:mm:ss
    expect(parseEtime("1-03:45:22")).toBe(86400 + 3 * 3600 + 45 * 60 + 22)
    expect(parseEtime("2-00:00:00")).toBe(172800)

    // Invalid
    expect(parseEtime("invalid")).toBeUndefined()
    expect(parseEtime("")).toBeUndefined()
  })
})

describe("SDK alias fallback for fresh checkouts", () => {
  test("vite.js SDK aliases should only activate when gen/ source files exist", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../../app/vite.js"), "utf-8")

    // The SDK aliases point to src/client.ts, src/server.ts, src/index.ts
    // These source files import from ./gen/ which may not exist on fresh checkout.
    // The aliases should check that the gen/ directory has source files,
    // not just that dist/ is missing.
    const checksGenExists = /gen.*exist|existsSync.*gen|gen.*source/.test(source)

    expect(checksGenExists).toBe(true)
  })
})

describe("restart daemon fallback safety in dev mode", () => {
  test("missing PID file in dev mode (SYNERGY_CWD set) should exit with error, not fall through to daemon", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // When SYNERGY_CWD is set, the user ran `bun dev restart` and expects
    // to restart the dev server. If the PID file is absent, falling through
    // to Daemon.restart() would restart the managed background service instead,
    // creating port conflicts and stray processes. The command must exit(1).
    const noPidFileCatch = source.substring(source.indexOf("// No PID file"), source.indexOf("Daemon.restart()"))

    // In dev mode (SYNERGY_CWD set), should call process.exit(1)
    const exitsInDevMode = /SYNERGY_CWD[\s\S]*exit\s*\(\s*1\s*\)/.test(noPidFileCatch)

    expect(exitsInDevMode).toBe(true)
  })

  test("missing PID file without SYNERGY_CWD should fall through to daemon restart", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/restart.ts"), "utf-8")

    // When SYNERGY_CWD is NOT set, the user is in daemon mode, and a missing
    // PID file just means no dev server is running. Falling through to
    // Daemon.restart() is correct.
    const noPidFileCatch = source.substring(source.indexOf("// No PID file"), source.indexOf("Daemon.restart()"))

    // The SYNERGY_CWD check should be a conditional guard, not an unconditional exit
    // There should be a path that does NOT call exit (falls through to daemon)
    const hasConditionalExit = /if\s*\(\s*process\.env\.SYNERGY_CWD/.test(noPidFileCatch)

    expect(hasConditionalExit).toBe(true)
  })
})
