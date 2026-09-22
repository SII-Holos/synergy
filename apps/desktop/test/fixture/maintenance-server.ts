import fs from "node:fs/promises"
import path from "node:path"
import { runtimeStartupLine } from "@ericsanchezok/synergy-util/runtime-startup"

const root = process.env.MAINTENANCE_FIXTURE_ROOT!
const mode = await Bun.file(`${root}/mode`).text()
const command = process.argv[2]
await fs.appendFile(`${root}/commands`, `${command}\n`)
if (command === "migration" || (command === "data" && process.argv[4] === "prune")) {
  await Bun.write(`${root}/maintenance-pid`, String(process.pid))
  process.stdout.write(runtimeStartupLine({ phase: "migration", step: 1, current: 256, total: 0 }))
  process.stdout.write("SYNERGY_STARTUP_V1 {invalid}\n")
  process.stdout.write(runtimeStartupLine({ phase: "migration", step: 1, current: 1, total: 0 }))
  if (mode === "failure") {
    console.error("Fixture disk is full; free space and retry")
    process.exit(1)
  }
  if (mode === "hold") await new Promise(() => {})
  if (mode === "controlled-delay") {
    process.stdout.write(
      runtimeStartupLine({ phase: "maintenance", id: 1, state: "started", operation: "vacuum", timeoutMs: 370_000 }),
    )
    process.stdout.write(runtimeStartupLine({ phase: "maintenance", id: 1, state: "stage", stage: "rewrite" }))
    await Bun.sleep(310_000)
    process.stdout.write(runtimeStartupLine({ phase: "maintenance", id: 1, state: "completed", elapsedMs: 310_000 }))
    process.stdout.write(runtimeStartupLine({ phase: "migration", step: 2, current: 512, total: 0 }))
  }
  process.exit(0)
}
if (command === "diagnostics") {
  const index = process.argv.indexOf("--output")
  const output = index >= 0 ? process.argv[index + 1] : undefined
  if (!output || !path.resolve(output).startsWith(path.resolve(root) + path.sep))
    throw new Error("Diagnostics fixture requires an output inside its isolated root")
  await Bun.write(output, "fixture diagnostics")
  process.exit(0)
}
const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: (request) => {
    if (new URL(request.url).pathname === "/global/maintenance/prepare")
      return Response.json(
        mode === "busy" ? { message: "working" } : { token: "fixture-lease", expiresAt: Date.now() + 30_000 },
        { status: mode === "busy" ? 409 : 200 },
      )
    return Response.json(
      new URL(request.url).pathname === "/global/activity"
        ? { active: mode === "busy", sessions: mode === "busy" ? 1 : 0, backgroundJobs: 0 }
        : { healthy: true },
    )
  },
})
process.on("SIGTERM", () => {
  server.stop(true)
  process.exit(0)
})
