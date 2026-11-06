import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

export namespace BlueprintLoopSources {
  const state = RuntimeContext.state(() => new Set<string>(["user"]))

  export function register(source: string): void {
    RuntimeContext.assertCompositionOpen("BlueprintLoop source")
    if (state().has(source)) throw new Error(`BlueprintLoop source ${source} is already registered`)
    state().add(source)
  }

  export function available(source?: string): boolean {
    return state().has(source ?? "user")
  }

  export function ids(): string[] {
    return [...state()].sort()
  }

  export function requiredFeatures(source?: string): string[] {
    return [
      "blueprint",
      ...(source === "lattice" ? ["lattice"] : source === "plugin" ? ["plugin-host", "plugin-blueprint"] : []),
    ]
  }

  export function requiredOwners(source?: string): string[] {
    return ["blueprint", ...(source === "lattice" ? ["lattice"] : source === "plugin" ? ["plugin-blueprint"] : [])]
  }
}
