async function bootstrap(): Promise<void> {
  if (process.argv.some((arg) => arg.startsWith("__") && arg.endsWith("-runner"))) {
    const { Global } = await import("@ericsanchezok/synergy-harness/global")
    await Global.initialize({ cache: false })
  }
  if (process.argv.includes("__browser-playwright-runtime-check")) {
    const { PlaywrightRuntime } = await import("@ericsanchezok/synergy-browser-runtime/playwright-runtime")
    if (typeof PlaywrightRuntime.load().chromium.launch !== "function")
      throw new Error("Packaged Playwright Chromium launcher is unavailable")
    console.log(`Playwright Core ${PlaywrightRuntime.version()}`)
    return
  }

  if (process.argv.includes("__embedding-runtime-check")) {
    const { verifyStandaloneEmbeddingRuntime } = await import("@ericsanchezok/synergy-library/vector/embedding-runtime")
    await verifyStandaloneEmbeddingRuntime()
    console.log("Standalone embedding runtime ready")
    return
  }

  if (process.argv.includes("__browser-install-deps-runner")) {
    const { installBrowserDependencies } = await import("@ericsanchezok/synergy-browser-runtime/install-deps-runner")
    await installBrowserDependencies()
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
    await import("@ericsanchezok/synergy-plugin-host/plugin-runtime/runner")
    await new Promise(() => {})
    return
  }

  if (process.argv.includes("__observability-worker-runner")) {
    await import("@ericsanchezok/synergy-harness/observability/telemetry-worker")
    await new Promise(() => {})
    return
  }

  if (process.argv.includes("__agent-turn-runner")) {
    await import("./product-registration")
    await import("@ericsanchezok/synergy-harness/session/agent-turn/runner")
    await new Promise(() => {})
    return
  }

  if (process.argv.includes("__policy-worker-runner")) {
    await import("@ericsanchezok/synergy-harness/enforcement/policy-worker/runner")
    await new Promise(() => {})
    return
  }

  const { runCli } = await import("@ericsanchezok/synergy-cli/main")
  const { productCommands } = await import("./cli-commands")
  await runCli({
    dataCommands: async () => (await import("./cli/data")).commands,
    defaultCommand: "server",
    commands: productCommands,
    runtimeFactory: async (options) => (await import("./server/runtime-handle")).ProductRuntimeHandle.openTask(options),
    beforeCommand: async (command) => {
      if (command !== "send") await import("./product-registration")
    },
    pluginCommands: async (directory) => {
      const { installedPluginCliMetadata } = await import("@ericsanchezok/synergy-plugin-host/plugin/cli-metadata")
      const { createPluginCliCommandModule } = await import("@ericsanchezok/synergy-plugin-host/plugin/cli-command")
      return (await installedPluginCliMetadata()).map((plugin) =>
        createPluginCliCommandModule({
          plugin,
          resolveScope: async () =>
            (await (await import("@ericsanchezok/synergy-harness/scope")).Scope.fromDirectory(directory)).scope,
        }),
      )
    },
  })
  process.exit(process.exitCode ?? 0)
}

await bootstrap()
