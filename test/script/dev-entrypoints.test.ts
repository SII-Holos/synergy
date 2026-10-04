import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { createDevPlan } from "../../script/dev"

const root = path.resolve(import.meta.dir, "../..")
for (const exitCode of [0, 7]) {
  test(`dev forwards live Computer build status and compiler output before exit ${exitCode}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-dev-computer-progress-"))
    const reporter = Bun.pathToFileURL(path.join(root, "apps/desktop/script/prepare-computer-progress.ts")).href
    const orchestrator = Bun.pathToFileURL(path.join(root, "script/dev.ts")).href
    const source = `
      import { ComputerBuildProgress } from ${JSON.stringify(reporter)}
      const progress = new ComputerBuildProgress()
      try {
        await progress.step("Building arm64", async () => {
          console.log("native compiler output")
          await Bun.stdin.text()
          if (${exitCode} !== 0) throw new Error("compiler fixture failed")
        })
        progress.ready()
      } catch {
        process.exitCode = ${exitCode}
      }
    `
    const entry = path.join(directory, "forward.ts")
    await Bun.write(
      entry,
      `
      import { spawnDevProcess } from ${JSON.stringify(orchestrator)}
      const child = spawnDevProcess({ label: "desktop", cwd: ${JSON.stringify(directory)}, command: [process.execPath, "-e", ${JSON.stringify(source)}] })
      process.exitCode = await child.exited
    `,
    )
    const child = Bun.spawn([process.execPath, entry], {
      cwd: directory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const visible = Promise.withResolvers<void>()
    let errors = ""
    const stderr = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stderr) {
        errors += decoder.decode(chunk, { stream: true })
        if (errors.includes("[desktop] [computer] Building arm64 · elapsed 0s\n")) visible.resolve()
      }
      errors += decoder.decode()
      visible.reject(new Error(`Child exited before live progress was visible: ${errors}`))
      return errors
    })()
    const stdout = new Response(child.stdout).text()
    try {
      await visible.promise
      expect(child.exitCode).toBeNull()
      child.stdin.end("release compiler\n")
      const [code, output, errors] = await Promise.all([child.exited, stdout, stderr])
      expect(code).toBe(exitCode)
      expect(output).toContain("[desktop] native compiler output\n")
      expect(errors).toContain(exitCode === 0 ? "[desktop] [computer] Driver ready" : "Building arm64 failed")
      expect(errors).not.toContain("\r")
    } finally {
      child.stdin.end()
      await child.exited
      await Promise.all([stdout, stderr])
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const args of [
  ["server"],
  ["app"],
  ["web"],
  ["desktop"],
  ["desktop", "--managed"],
  ["send", "hello"],
  ["build", "app"],
  ["build", "desktop"],
]) {
  test(`dev ${args.join(" ")} resolves runnable workspace commands`, async () => {
    const plan = createDevPlan(args, { repoRoot: root })
    expect(plan.kind).toBe("run")
    expect(plan.processes.length).toBeGreaterThan(0)
    for (const process of plan.processes) {
      const manifest = Bun.file(path.join(process.cwd, "package.json"))
      expect(await manifest.exists()).toBe(true)
      if (process.command[1] === "turbo") {
        const child = Bun.spawn([...process.command, "--dry-run=json"], {
          cwd: process.cwd,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [output, errors, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(code, errors).toBe(0)
        const tasks = JSON.parse(output).tasks as Array<{ taskId: string; command: string }>
        expect(tasks.filter((task) => task.command !== "<NONEXISTENT>").map((task) => task.taskId)).toEqual([
          "@ericsanchezok/synergy-plugin#build",
          "@ericsanchezok/synergy-sdk#build",
          "@ericsanchezok/synergy-util#build",
        ])
        continue
      }
      const command = process.command.slice(2).find((value) => !value.startsWith("--"))!
      if (command.endsWith(".ts")) expect(await Bun.file(path.resolve(process.cwd, command)).exists()).toBe(true)
      else expect((await manifest.json()).scripts[command]).toBeString()
    }
  })
}

test("CI sandbox builder commands resolve and accept both target platforms", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(path.join(root, ".github/workflows/build-helpers.yml")).text()) as {
    jobs: Record<string, { steps: { run?: string }[] }>
  }
  let commands = 0
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      for (const match of (step.run ?? "").matchAll(/bun run ([\w/.-]+\.ts) (linux|windows)/g)) {
        commands++
        const entry = path.join(root, match[1]!)
        expect(await Bun.file(entry).exists()).toBe(true)
        const child = Bun.spawn([process.execPath, entry, match[2]!, "--dry-run"], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exit, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(errors).toBe("")
        expect(exit).toBe(0)
        expect(output).toContain(`platform: ${match[2]}`)
      }
    }
  }
  expect(commands).toBe(3)
})
