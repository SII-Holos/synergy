import path from "node:path"

const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reservation.port!
await reservation.stop(true)
const child = Bun.spawn(
  [
    process.execPath,
    "run",
    "packages/product-runtime/src/index.ts",
    "server",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    env: {
      ...process.env,
      SYNERGY_HOME: path.join(process.env.SYNERGY_TEST_ROOT!, "server"),
      SYNERGY_DISABLE_MODELS_FETCH: "true",
      MODELS_DEV_API_JSON: path.resolve("packages/testing/fixtures/models-api.json"),
    },
    stdout: "inherit",
    stderr: "inherit",
  },
)
try {
  const deadline = Date.now() + 30_000
  let healthy = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Server exited before becoming healthy")
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(1000) }).catch(
      () => undefined,
    )
    if (response?.ok && ((await response.json()) as { healthy?: boolean }).healthy === true) {
      healthy = true
      break
    }
    await Bun.sleep(500)
  }
  if (!healthy) throw new Error("Server health deadline exceeded")
} finally {
  child.kill()
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    await child.exited
  } finally {
    clearTimeout(timer)
  }
}
