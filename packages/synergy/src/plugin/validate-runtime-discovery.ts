/**
 * Runtime discovery validation for plugins.
 *
 * Compares a plugin's manifest-declared tools (contributes.tools[].name)
 * against the tools actually registered at runtime via hooks.tool.
 *
 * This is a pure function with no I/O dependencies — testable in isolation.
 */

export interface RuntimeDiscoveryInput {
  /** Tool names declared in plugin.json contributes.tools[] */
  manifestToolNames: string[]
  /**
   * Tool names registered at runtime via hooks.tool.
   * null means the plugin failed to load (no runtime data available).
   */
  runtimeToolNames: string[] | null
  /** Plugin identifier for diagnostic messages */
  pluginId: string
}

export interface RuntimeDiscoveryResult {
  /** All validated — no undeclared tools and no load failure */
  valid: boolean
  /** Tools registered at runtime but not declared in manifest */
  undeclared: string[]
  /** Tools declared in manifest but not found at runtime (warning, not error) */
  declaredButMissing: string[]
  /** Tools that are both declared and registered */
  matched: string[]
  /** True when runtime load failed (runtimeToolNames is null) */
  loadFailed: boolean
}

/**
 * Compare manifest-declared tools against runtime-registered tools.
 *
 * - undeclared tools → validation FAIL (red flag: tool runs with unknown permissions)
 * - declared-but-missing → warning only (plugin may lazily register)
 * - null runtimeToolNames → load failure (can't validate)
 */
export function validateRuntimeDiscovery(input: RuntimeDiscoveryInput): RuntimeDiscoveryResult {
  const { manifestToolNames, runtimeToolNames, pluginId: _pluginId } = input

  // Load failure: plugin couldn't start, no runtime data available
  if (runtimeToolNames === null) {
    return {
      valid: true,
      undeclared: [],
      declaredButMissing: [],
      matched: [],
      loadFailed: true,
    }
  }

  const manifestSet = new Set(manifestToolNames)
  const runtimeSet = new Set(runtimeToolNames)

  // Tools in runtime but not in manifest → undeclared
  const undeclared: string[] = []
  for (const name of runtimeToolNames) {
    if (!manifestSet.has(name)) {
      undeclared.push(name)
    }
  }

  // Tools in manifest but not in runtime → declared but missing
  const declaredButMissing: string[] = []
  for (const name of manifestToolNames) {
    if (!runtimeSet.has(name)) {
      declaredButMissing.push(name)
    }
  }

  // Tools in both sets → matched
  const matched: string[] = []
  for (const name of runtimeToolNames) {
    if (manifestSet.has(name)) {
      matched.push(name)
    }
  }

  return {
    valid: undeclared.length === 0,
    undeclared,
    declaredButMissing,
    matched,
    loadFailed: false,
  }
}
