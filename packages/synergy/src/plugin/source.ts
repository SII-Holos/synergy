import { PluginSpec } from "../util/plugin-spec"
import type { PluginSource } from "@ericsanchezok/synergy-util/plugin-policy"

export function sourceFromSpec(spec: string): PluginSource {
  if (spec.startsWith("file://")) return "local"
  if (/^https?:\/\//.test(spec)) return "url"
  if (PluginSpec.isNonRegistry(spec)) return "git"
  return "npm"
}
