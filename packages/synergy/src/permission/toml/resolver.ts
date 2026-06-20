import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export const CycleError = NamedError.create("ProfileCycleError", z.object({ cycle: z.array(z.string()) }))
export const UndefinedProfileError = NamedError.create("UndefinedProfileError", z.object({ profile: z.string() }))
export const UndefinedParentError = NamedError.create("UndefinedParentError", z.object({ parent: z.string() }))
export const UnsupportedBuiltinParentError = NamedError.create(
  "UnsupportedBuiltinParentError",
  z.object({ builtin: z.string() }),
)

export namespace TomlResolver {
  export function resolve(profile: any, profiles: Record<string, any>): any {
    const chain: any[] = []
    let current = profile
    const visited = new Set<string>()

    while (current.extends) {
      const parentName: string = current.extends
      if (visited.has(parentName)) {
        throw new CycleError({ cycle: [...visited, parentName] })
      }

      if (parentName.startsWith(":")) {
        throw new UnsupportedBuiltinParentError({ builtin: parentName })
      }

      visited.add(parentName)

      const parent = profiles[parentName]
      if (!parent) {
        throw new UndefinedParentError({ parent: parentName })
      }

      chain.unshift(parent)
      current = parent
    }

    let result: any = {}
    for (const layer of chain) {
      const stripped = { ...layer }
      delete stripped.description
      delete stripped.extends
      result = deepMerge(result, stripped)
    }

    result = deepMerge(result, profile)

    if (result.network?.domains && Array.isArray(result.network.domains)) {
      result.network.domains = result.network.domains.map((d: string) => d.toLowerCase())
    }

    return result
  }

  export function get(name: string, profiles: Record<string, any>): any {
    const profile = profiles[name]
    if (!profile) {
      throw new UndefinedProfileError({ profile: name })
    }
    return profile
  }
}

function deepMerge(base: any, overlay: any): any {
  const result = { ...base }
  for (const key of Object.keys(overlay)) {
    const overlayVal = overlay[key]
    const baseVal = result[key]

    if (
      overlayVal !== null &&
      typeof overlayVal === "object" &&
      !Array.isArray(overlayVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal, overlayVal)
    } else {
      result[key] = overlayVal
    }
  }
  return result
}
