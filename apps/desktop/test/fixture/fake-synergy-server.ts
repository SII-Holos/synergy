#!/usr/bin/env bun
import fs from "node:fs"

const args = process.argv.slice(2)
const port = Number(args[args.indexOf("--port") + 1])
const hostname = args[args.indexOf("--hostname") + 1] ?? "127.0.0.1"

const attemptsFile = process.env.FAKE_SYNERGY_ATTEMPTS
if (attemptsFile) {
  const previous = (() => {
    try {
      return fs.readFileSync(attemptsFile, "utf8")
    } catch {
      return ""
    }
  })()
  fs.writeFileSync(attemptsFile, `${previous}${port}\n`)
}

const modesFile = process.env.FAKE_SYNERGY_MODES_FILE
const modes: Record<string, string> = modesFile
  ? (JSON.parse(fs.readFileSync(modesFile, "utf8")) as Record<string, string>)
  : {}
const mode = modes[String(port)] ?? "ok"

if (mode === "conflict") {
  process.stderr.write(`Error: Server startup failed: Failed to start server on port ${port}\n`)
  process.exit(1)
}
if (mode === "other") {
  process.stderr.write("Another Synergy runtime already owns this Home (pid 4242)\n")
  process.exit(1)
}

const server = Bun.serve({
  port,
  hostname,
  fetch() {
    return new Response(JSON.stringify({ healthy: true, version: "fake" }), {
      headers: { "content-type": "application/json" },
    })
  },
})

process.on("SIGTERM", () => {
  void server.stop(true)
  process.exit(0)
})
