import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { main as runCli } from "@ericsanchezok/synergy-cli/index"
import { fullComponents } from "./components"
import { sourceWebApp } from "./server/web-app"
import { selectComponents } from "@ericsanchezok/synergy-cli/component-selection"

export async function main() {
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
    return RuntimeContext.create(createLocalHost()).run(async () => {
      const { Global } = await import("@ericsanchezok/synergy-harness/global")
      await Global.initialize({ cache: false })
      await (await import("@ericsanchezok/synergy-browser-runtime/install-deps-runner")).installBrowserDependencies()
    })
  }
  await runCli(selectComponents([...fullComponents(), sourceWebApp()], process.env.SYNERGY_COMPONENTS))
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}

export { fullComponents } from "./components"
export { PresetRuntimeHandle } from "./server/runtime-handle"
