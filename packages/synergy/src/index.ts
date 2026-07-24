async function bootstrap(): Promise<void> {
  const pluginRuntimeRunnerArgIndex = process.argv.indexOf("__plugin-runtime-runner")
  if (pluginRuntimeRunnerArgIndex >= 0) {
    const entryPath = process.argv[pluginRuntimeRunnerArgIndex + 1]
    if (!entryPath) {
      console.error("Missing plugin runtime entry path")
      process.exit(1)
    }
    process.argv = [process.argv[0] ?? "synergy", process.argv[1] ?? "synergy", entryPath]
    await import("./plugin-runtime/runner.js")
    await new Promise(() => {})
    return
  }

  if (process.argv.includes("__agent-turn-runner")) {
    await import("./session/agent-turn/runner.js")
    await new Promise(() => {})
    return
  }

  if (process.argv.includes("__policy-worker-runner")) {
    await import("./enforcement/policy-worker/runner.js")
    await new Promise(() => {})
    return
  }

  await import("./main.js")
}

await bootstrap()
