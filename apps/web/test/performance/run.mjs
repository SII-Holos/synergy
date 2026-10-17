import path from "node:path"
import { mkdir } from "node:fs/promises"
const [repository, output, panels] = process.argv.slice(2)
if (!repository || !output)
  throw new Error("Usage: bun test/performance/run.mjs <repository> <fresh temporary run directory> [panels]")
if (Bun.version !== "1.4.2") throw new Error("Use the pinned Bun 1.4.2 runtime")
const repo = path.resolve(repository),
  home = path.resolve(output)
await mkdir(home, { recursive: true })
const server = Bun.spawn([process.execPath, path.join(import.meta.dir, "server.mjs"), repo, home], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: Bun.file(path.join(home, "server.log")),
})
const ready = Promise.withResolvers()
const readServer = (async () => {
  let buffer = ""
  for await (const chunk of server.stdout) {
    const value = new TextDecoder().decode(chunk)
    buffer += value
    if (buffer.includes("FIXTURE_READY")) ready.resolve()
  }
  await Bun.write(path.join(home, "server-stdout.log"), buffer)
  ready.reject(new Error("Fixture server exited before readiness"))
})()
let client
try {
  let timer
  await Promise.race([
    ready.promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture readiness timeout")), 120000)
    }),
  ]).finally(() => clearTimeout(timer))
  client = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, panels === "soak" ? "soak.mjs" : "browser.mjs"), repo, home],
    {
      stdout: "pipe",
      stderr: Bun.file(path.join(home, "browser-errors.log")),
    },
  )
  let output = "",
    started = false
  for await (const chunk of client.stdout) {
    const value = new TextDecoder().decode(chunk)
    output += value
    if (!started && output.includes("CLIENT_READY_FOR_BURST")) {
      started = true
      server.stdin.write("burst\n")
      await server.stdin.flush()
    }
  }
  await Bun.write(path.join(home, "browser.log"), output)
  if ((await client.exited) !== 0) throw new Error("Browser comparison failed; inspect browser-errors.log")
  if (panels === "panels" || process.env.SYNERGY_PERF_PANELS === "1") {
    const panel = Bun.spawn([process.execPath, path.join(import.meta.dir, "panels.mjs"), repo, home], {
      stdout: Bun.file(path.join(home, "panels.log")),
      stderr: Bun.file(path.join(home, "panels-errors.log")),
    })
    if ((await panel.exited) !== 0) throw new Error("Panel continuity failed; inspect panels-errors.log")
  }
  console.log(await Bun.file(path.join(home, "report.json")).text())
} finally {
  if (server.exitCode === null) {
    try {
      server.stdin.write("stop\n")
      await server.stdin.flush()
      server.stdin.end()
    } catch {}
  }
  await server.exited
  await readServer
}
