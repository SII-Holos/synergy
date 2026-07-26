async function bootstrap(): Promise<void> {
  if (process.argv.includes("__browser-playwright-runtime-check")) {
    const { PlaywrightRuntime } = await import("./browser/playwright-runtime.js")
    console.log(`Playwright Core ${PlaywrightRuntime.version()}`)
    return
  }

  if (process.argv.includes("__browser-install-deps-runner")) {
    if (process.platform !== "linux")
      throw new Error("Browser system dependency installation is only available on Linux.")
    const { PlaywrightRuntime } = await import("./browser/playwright-runtime.js")
    await PlaywrightRuntime.installChromiumDependencies()
    return
  }

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
