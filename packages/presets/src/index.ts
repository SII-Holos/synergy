import { main as runCli, runCoreWorker } from "@ericsanchezok/synergy-cli/index"
import { desktopComponents, fullComponents } from "./components"
import { sourceWebApp } from "./server/web-app"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { readFeaturePreferences } from "@ericsanchezok/synergy-util/feature-config"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { version } from "../package.json" with { type: "json" }
import { z } from "zod"
import path from "node:path"

export async function main() {
  if (process.argv[2] !== "__storage-maintenance-runner" && (await runCoreWorker())) return
  if (process.argv[2] === "__embedding-runtime-check") {
    const { verifyStandaloneEmbeddingRuntime } = await import("@ericsanchezok/synergy-library/vector/embedding-runtime")
    await verifyStandaloneEmbeddingRuntime()
    console.log("Standalone embedding runtime ready")
    return
  }
  const components = process.env.SYNERGY_DESKTOP_BROWSER === "1" ? await desktopComponents() : fullComponents()
  const candidates = [...components, sourceWebApp()]
  const features =
    process.argv[2] === "generate"
      ? FeatureSelection.complete(candidates, { "local-runtime": version, "plugin-host": version })
      : FeatureSelection.resolve(candidates, {
          ...(await readFeaturePreferences(path.join(createLocalHost().root, "config"))),
          selection:
            process.env.SYNERGY_COMPONENTS === undefined
              ? undefined
              : z.record(z.string(), z.string()).parse(JSON.parse(process.env.SYNERGY_COMPONENTS)),
          provided: { "local-runtime": version, "plugin-host": version },
        })
  const selected = candidates.filter((component) => features.components.includes(component.id))
  const maintenance = candidates.flatMap((component) =>
    !features.components.includes(component.id) && component.maintenance ? [component.maintenance] : [],
  )
  await runCli(selected, undefined, { features, maintenance })
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}

export { fullComponents } from "./components"
export { PresetRuntimeHandle } from "./server/runtime-handle"
