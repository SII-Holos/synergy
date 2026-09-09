import { expect, test } from "bun:test"
import path from "node:path"
import { createDevPlan } from "../../script/dev"

const root = path.resolve(import.meta.dir, "../..")
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
        expect(JSON.parse(output).tasks.map((task: { taskId: string }) => task.taskId)).toEqual([
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
