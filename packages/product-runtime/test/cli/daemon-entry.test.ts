import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("daemon entry stays healthy and drains on SIGTERM in an isolated home", async () => {
  const isolated = await createIsolatedTestEnv()
  const script = `
    import { ProductRuntimeHandle } from "./src/server/runtime-handle"
    const open = ProductRuntimeHandle.open
    ProductRuntimeHandle.open = async (options) => {
      const handle = await open({ ...options, network: { hostname: "127.0.0.1", port: 0 } })
      console.log("READY " + handle.server.port)
      return handle
    }
    const { main } = await import("./src/daemon-entry")
    await main()
  `
  const child = Bun.spawn([process.execPath, "--conditions=browser", "-e", script], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: isolated.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const errors = new Response(child.stderr).text()
  let output = ""
  const ready = (async () => {
    const reader = child.stdout.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      output += new TextDecoder().decode(value)
      const match = output.match(/READY (\d+)/)
      if (match) return Number(match[1])
    }
    throw new Error(`Daemon exited before readiness: ${await errors}`)
  })()
  try {
    const port = await Promise.race([
      ready,
      Bun.sleep(15_000).then(() => {
        throw new Error("Daemon startup timed out")
      }),
    ])
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await fetch(`http://127.0.0.1:${port}/global/health`)).status).toBe(200)
      await Bun.sleep(50)
    }
    child.kill("SIGTERM")
    const code = await Promise.race([child.exited, Bun.sleep(15_000).then(() => null)])
    if (code === null) child.kill("SIGKILL")
    expect(code, await errors).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await isolated.dispose()
  }
}, 35_000)
