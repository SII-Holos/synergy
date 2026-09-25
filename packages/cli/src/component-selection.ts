import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { z } from "zod"
import { version as coreVersion } from "../package.json" with { type: "json" }

export function selectComponents(components: readonly RuntimeComponent[], serialized?: string) {
  if (serialized === undefined) return [...components]
  const requested = z.record(z.string().min(1), z.string().min(1)).parse(JSON.parse(serialized))
  const selected = new Set<string>()
  const byID = new Map(components.map((component) => [component.id, component]))
  function include(id: string) {
    if (selected.has(id) || id === "local-runtime" || id === "plugin-host") return
    const component = byID.get(id)
    if (!component) throw new Error(`Component is not installed: ${id}`)
    selected.add(id)
    for (const required of Object.keys(component.requires ?? {})) include(required)
  }
  for (const [id, version] of Object.entries(requested)) {
    include(id)
    const installed = byID.get(id)?.version ?? coreVersion
    if (installed !== version)
      throw new Error(`Component ${id} requires exact version ${version}; installed ${installed}`)
  }
  return components.filter((component) => selected.has(component.id))
}
