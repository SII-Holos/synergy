import { main as runCli } from "@ericsanchezok/synergy-cli/index"
import { desktopComponents, fullComponents } from "./components"
import { sourceWebApp } from "./server/web-app"
import { selectComponents } from "@ericsanchezok/synergy-cli/component-selection"

export async function main() {
  if (process.argv[2] === "__embedding-runtime-check") {
    const { verifyStandaloneEmbeddingRuntime } = await import("@ericsanchezok/synergy-library/vector/embedding-runtime")
    await verifyStandaloneEmbeddingRuntime()
    console.log("Standalone embedding runtime ready")
    return
  }
  const components = process.env.SYNERGY_DESKTOP_BROWSER === "1" ? await desktopComponents() : fullComponents()
  await runCli(selectComponents([...components, sourceWebApp()], process.env.SYNERGY_COMPONENTS))
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}

export { fullComponents } from "./components"
export { PresetRuntimeHandle } from "./server/runtime-handle"
