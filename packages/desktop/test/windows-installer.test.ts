import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const desktopDir = path.resolve(import.meta.dir, "..")
const packageJson = (await Bun.file(path.join(desktopDir, "package.json")).json()) as { version: string }

async function run(command: string[], env: Record<string, string> = {}, timeoutMs = 300_000) {
  const child = Bun.spawn(command, {
    cwd: desktopDir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout))
  if (timedOut) {
    throw new Error(`${command.join(" ")} timed out after ${timeoutMs} ms\n${stdout}\n${stderr}`)
  }
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${exitCode}\n${stdout}\n${stderr}`)
  }
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function createFallbackInstallerInclude() {
  const releaseDir = path.join(desktopDir, "release")
  await fs.mkdir(releaseDir, { recursive: true })
  const directory = await fs.mkdtemp(path.join(releaseDir, "windows-installer-test-"))
  const includePath = path.join(directory, "installer.nsh")
  const productionInclude = path.join(desktopDir, "build", "installer.nsh")
  await Bun.write(
    includePath,
    [
      `!include "${productionInclude}"`,
      "!macro customCheckAppRunning",
      "  Var /GLOBAL IsPowerShellAvailable",
      "  StrCpy $IsPowerShellAvailable 1",
      '  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0',
      "  ${if} $R0 == 0",
      "    SetErrorLevel 86",
      "    Quit",
      "  ${endIf}",
      "!macroend",
    ].join("\n"),
  )
  return { directory, includePath }
}

async function spawnSiblingProcess(directory: string) {
  const siblingPath = path.join(directory, "synergy-desktop.exe-helper.exe")
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  await fs.copyFile(path.join(systemRoot, "System32", "cmd.exe"), siblingPath)
  const child = spawn(siblingPath, ["/c", "ping", "-n", "999", "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
  })
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  const pid = child.pid
  if (pid === undefined) throw new Error("Sibling process started without a process ID")
  return {
    assertAlive: () => expect(isProcessRunning(pid)).toBe(true),
    cleanup: async () => {
      await run(["taskkill", "/PID", String(pid), "/T", "/F"], {}, 30_000).catch(() => undefined)
      await fs.rm(siblingPath, { force: true })
    },
  }
}

async function uninstall(installDir: string) {
  const uninstaller = path.join(installDir, "Uninstall synergy-desktop.exe")
  if (await Bun.file(uninstaller).exists()) {
    await run([uninstaller, "/S"], {}, 120_000)
  }
}

describe("Windows installer", () => {
  test.skipIf(process.platform !== "win32")(
    "ignores a running process whose name only contains the application executable name",
    async () => {
      const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-windows-installer-"))
      const installDir = path.join(temporaryDirectory, "installed")
      const installerInclude = await createFallbackInstallerInclude()
      const sibling = await spawnSiblingProcess(temporaryDirectory)

      try {
        await run([process.execPath, "run", "desktop:build"])
        await run(
          [
            process.execPath,
            "x",
            "electron-builder",
            "--win",
            "nsis",
            "--x64",
            "--publish=never",
            `--config.nsis.include=${installerInclude.includePath}`,
          ],
          {
            CSC_IDENTITY_AUTO_DISCOVERY: "false",
            SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME: "1",
          },
        )

        const installer = path.join(desktopDir, "release", `Synergy-win32-x64-${packageJson.version}.exe`)
        await run([installer, "/S", `/D=${installDir}`], {}, 120_000)

        sibling.assertAlive()
        expect(await Bun.file(path.join(installDir, "synergy-desktop.exe")).exists()).toBe(true)
      } finally {
        await sibling.cleanup()
        await uninstall(installDir)
        await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        await fs.rm(installerInclude.directory, { recursive: true, force: true })
      }
    },
    600_000,
  )
})
