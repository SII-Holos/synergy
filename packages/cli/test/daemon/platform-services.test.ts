import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { DaemonPaths } from "@ericsanchezok/synergy-harness/util/daemon-paths"
import { LaunchdService } from "../../src/daemon/launchd"
import { SchtasksService } from "../../src/daemon/schtasks"
import type { DaemonService } from "../../src/daemon/service"

type Reply = { exitCode?: number; stdout?: string; stderr?: string }
async function fixture(
  reply: (command: string[]) => Reply,
  run: (spec: DaemonService.InstallSpec, commands: string[][]) => Promise<void>,
) {
  await using tmp = await tmpdir()
  const previousHome = process.env.SYNERGY_HOME
  process.env.SYNERGY_HOME = tmp.path
  const commands: string[][] = []
  const spawn = spyOn(Bun, "spawn").mockImplementation((input) => {
    if (!Array.isArray(input) || !["launchctl", "schtasks"].includes(String(input[0])))
      throw new Error("unexpected OS operation")
    const command = input as string[]
    commands.push(command)
    const result = reply(command)
    return {
      stdout: new Response(result.stdout ?? "").body,
      stderr: new Response(result.stderr ?? "").body,
      exited: Promise.resolve(result.exitCode ?? 0),
    } as never
  })
  try {
    await run(
      {
        label: "fixture.synergy",
        hostname: "127.0.0.1",
        port: 49234,
        cwd: tmp.path,
        command: ["/app path/synergy", "server", '<arg&"quoted">'],
        env: { SAMPLE: "a&b<q>\"x'y", SYSTEMROOT: "do-not-copy", EMPTY: "" },
        logFile: DaemonPaths.logFile(),
      },
      commands,
    )
  } finally {
    spawn.mockRestore()
    if (previousHome === undefined) delete process.env.SYNERGY_HOME
    else process.env.SYNERGY_HOME = previousHome
  }
}

test("launchd lifecycle persists escaped plist, bootstraps unloaded jobs and reports exited state", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")
  Object.defineProperty(process, "getuid", { value: () => 42, configurable: true })
  let loaded = false,
    exited = false,
    denyKickstart = false
  try {
    await fixture(
      (command) => {
        if (command[1] === "print")
          return loaded ? { stdout: exited ? "state = exited" : "state = running" } : { exitCode: 1 }
        if (command[1] === "bootstrap") loaded = true
        if (command[1] === "bootout") loaded = false
        if (command[1] === "kickstart" && denyKickstart) return { exitCode: 1, stderr: "kickstart denied" }
        return {}
      },
      async (spec, commands) => {
        expect(await LaunchdService.status(spec)).toMatchObject({ installed: false, running: false })
        await LaunchdService.install(spec)
        const plist = await Bun.file(DaemonPaths.launchAgent(spec.label)).text()
        expect(plist).toContain("&lt;arg&amp;&quot;quoted&quot;&gt;")
        expect(plist).toContain("a&amp;b&lt;q&gt;&quot;x&apos;y")
        expect(await LaunchdService.status(spec)).toMatchObject({ installed: true, running: true })
        await LaunchdService.stop(spec)
        expect(await LaunchdService.status(spec)).toEqual({
          installed: true,
          running: false,
          detail: "LaunchAgent installed but not loaded",
        })
        await LaunchdService.start(spec)
        expect(commands.at(-1)).toEqual(["launchctl", "kickstart", "gui/42/fixture.synergy"])
        await LaunchdService.restart(spec)
        expect(commands.at(-1)).toEqual(["launchctl", "kickstart", "-k", "gui/42/fixture.synergy"])
        exited = true
        expect((await LaunchdService.status(spec)).running).toBe(false)
        denyKickstart = true
        await expect(LaunchdService.start(spec)).rejects.toThrow("kickstart denied")
        await LaunchdService.uninstall(spec)
        expect(await Bun.file(DaemonPaths.launchAgent(spec.label)).exists()).toBe(false)
      },
    )
  } finally {
    if (descriptor) Object.defineProperty(process, "getuid", descriptor)
    else Reflect.deleteProperty(process, "getuid")
  }
})

test("scheduled-task lifecycle writes escaped launchers, falls back from logon and recognizes localized running state", async () => {
  let output = "Ready",
    missing = false,
    unavailable = false,
    denyRun = false
  await fixture(
    (command) => {
      if (command.includes("ONLOGON")) return { exitCode: 1, stderr: "logon trigger unavailable" }
      if (command[1] === "/Query" && command[2] === "/?") return { exitCode: unavailable ? 1 : 0 }
      if (command[1] === "/Query") return { exitCode: missing ? 1 : 0, stdout: output }
      if (command[1] === "/Run" && denyRun) return { exitCode: 1, stdout: "run operation denied" }
      return {}
    },
    async (spec, commands) => {
      await SchtasksService.install(spec)
      expect(commands.filter((command) => command[1] === "/Create").map((command) => command[4])).toEqual([
        "ONLOGON",
        "ONCE",
      ])
      const script = await Bun.file(DaemonPaths.windowsTaskScript()).text()
      expect(script).toContain("setlocal DisableDelayedExpansion")
      expect(script).toContain("a^&b^<q^>")
      expect(script).not.toContain("do-not-copy")
      expect(script).not.toContain('set "EMPTY=')
      expect(await Bun.file(DaemonPaths.windowsLauncher()).text()).toContain('CreateObject("WScript.Shell")')
      expect(await SchtasksService.status(spec)).toMatchObject({ installed: true, running: false })
      for (const status of ["Running", "正在运行", "正在執行"]) {
        output = status
        expect((await SchtasksService.status(spec)).running).toBe(true)
      }
      await SchtasksService.start(spec)
      await SchtasksService.stop(spec)
      await SchtasksService.restart(spec)
      expect(commands.at(-1)).toEqual(["schtasks", "/Run", "/TN", spec.label])
      denyRun = true
      await expect(SchtasksService.start(spec)).rejects.toThrow("run operation denied")
      missing = true
      expect(await SchtasksService.status(spec)).toEqual({
        installed: false,
        running: false,
        detail: "Scheduled Task not registered",
      })
      unavailable = true
      expect((await SchtasksService.status(spec)).detail).toContain("schtasks unavailable")
      await expect(SchtasksService.install(spec)).rejects.toThrow("schtasks unavailable")
      unavailable = false
      await SchtasksService.uninstall(spec)
      expect(await Bun.file(DaemonPaths.windowsTaskScript()).exists()).toBe(false)
      expect(await Bun.file(DaemonPaths.windowsLauncher()).exists()).toBe(false)
    },
  )
})
