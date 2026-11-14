import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { text } from "node:stream/consumers"
import { testRuntime } from "../support/runtime"
import { ChildProcessClose } from "@ericsanchezok/synergy-harness/process/child-process-close"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { OwnedProcess } from "../../src/process/owned-process"
import { DarwinJob } from "../../src/process/darwin-job"
import { WindowsJob } from "../../src/process/windows-job"
import { LinuxTree } from "../../src/process/linux-tree"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

const nativeTest = test.skipIf(!["darwin", "linux", "win32"].includes(process.platform))
const supervisor = process.platform === "darwin" ? DarwinJob : process.platform === "win32" ? WindowsJob : LinuxTree
const sourceCommand = [
  process.execPath,
  "run",
  "--no-env-file",
  `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
]
const fixture = path.join(import.meta.dir, "fixtures/supervisor-environment.ts")

nativeTest(
  "native supervisors receive only their explicit environment and working directory",
  async () => {
    await using directory = await tmpdir()
    const marker = path.join(directory.path, "environment.json")
    const key = "SYNERGY_FIXTURE_PARENT"
    const previous = process.env[key]
    process.env[key] = "not-selected"
    try {
      const job = await supervisor.start([...sourceCommand, fixture, marker], directory.path, {
        HOME: directory.path,
        SYNERGY_FIXTURE_EXPLICIT: "组织 & <scope> = ✓",
        SYNERGY_FIXTURE_EMPTY: "",
      })
      try {
        const until = Date.now() + 10000
        while (!(await Bun.file(marker).exists())) {
          if (Date.now() >= until) throw new Error("Supervisor did not publish its environment")
          await Bun.sleep(20)
        }
        expect(await Bun.file(marker).json()).toEqual({
          cwd: await fs.realpath(directory.path),
          home: directory.path,
          explicit: "组织 & <scope> = ✓",
          empty: "",
        })
      } finally {
        await job.remove()
      }
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  },
  20000,
)

nativeTest(
  "owned execution selects its Runtime launcher and separates supervisor and command environments",
  async () => {
    await using home = await runtimeHome()
    const marker = path.join(home.host.root, "supervisor.json")
    const coordinator = new WorkspaceCoordinator({ directory: path.join(home.host.root, "locks") })
    await using runtime = await testRuntime({
      home: home.host.home,
      workspaceCoordinator: coordinator,
      env: {
        ...home.host.env,
        HOME: "unselected-home",
        SYNERGY_RUNTIME_ROOT: "unselected-root",
        SYNERGY_INSTALLATION_PIN: JSON.stringify({ id: crypto.randomUUID(), sha256: "a".repeat(64) }),
        SYNERGY_LAUNCHER_COMMAND: JSON.stringify([...sourceCommand, fixture, marker]),
        OPENAI_API_KEY: "private-runtime-provider",
        BASH_ENV: "private-shell-initializer",
      },
    })
    expect(await Bun.file(marker).exists()).toBe(false)
    const lease = await coordinator.acquire({
      id: crypto.randomUUID(),
      owner: "fixture",
      ancestors: [],
      kind: "process",
      roots: [home.host.root],
    })
    try {
      await runtime.run(async () => {
        const owned = await OwnedProcess.prepare({
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({home:process.env.HOME,value:process.env.COMMAND_VALUE,provider:process.env.OPENAI_API_KEY}))",
          ],
          cwd: home.host.root,
          env: { HOME: "selected-command-home", COMMAND_VALUE: "command-only" },
          ownership: lease,
        })
        const output = text(owned.child.stdout)
        const errors = text(owned.child.stderr)
        const closed = ChildProcessClose.wait(owned.child)
        try {
          await owned.activate()
          expect((await closed).code, await errors).toBe(0)
          expect(JSON.parse(await output)).toEqual({ home: "selected-command-home", value: "command-only" })
          expect(await Bun.file(marker).exists()).toBe(true)
          const snapshot = await Bun.file(marker).json()
          expect(snapshot).toEqual({ cwd: snapshot.cwd, home: home.host.home, root: home.host.root })
          expect(path.basename(snapshot.cwd)).toStartWith("sy-p-")
          expect(await coordinator.inspect()).toHaveLength(0)
        } finally {
          await owned.stop()
          await Promise.allSettled([output, errors, closed])
        }
      })
    } finally {
      await lease.release()
    }
  },
  20000,
)

nativeTest(
  "source supervisors ignore dotenv and preload files in their private working directory",
  async () => {
    await using directory = await tmpdir()
    const marker = path.join(directory.path, "preload-ran")
    const start = supervisor.start
    using observer = spyOn(supervisor, "start").mockImplementation(async (command, cwd, environment) => {
      await fs.writeFile(path.join(cwd, ".env"), "SYNERGY_FIXTURE_PARENT=implicit\n")
      await fs.writeFile(
        path.join(cwd, "preload.ts"),
        `await Bun.write(${JSON.stringify(marker)}, 'executed');throw new Error('unselected preload')`,
      )
      await fs.writeFile(path.join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
      return start(command, cwd, environment)
    })
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "locks") })
    const lease = await coordinator.acquire({
      id: crypto.randomUUID(),
      owner: "fixture",
      ancestors: [],
      kind: "process",
      roots: [directory.path],
    })
    try {
      const owned = await OwnedProcess.prepare({
        command: process.execPath,
        args: ["-e", "process.stdout.write('command-completed')"],
        cwd: directory.path,
        env: {},
        ownership: lease,
      })
      const output = text(owned.child.stdout)
      const errors = text(owned.child.stderr)
      const closed = ChildProcessClose.wait(owned.child)
      try {
        await owned.activate()
        expect((await closed).code, await errors).toBe(0)
        expect(await output).toBe("command-completed")
        expect(await Bun.file(marker).exists()).toBe(false)
        expect(await coordinator.inspect()).toHaveLength(0)
      } finally {
        await owned.stop()
        await Promise.allSettled([output, errors, closed])
      }
    } finally {
      await lease.release()
    }
  },
  20000,
)
