import type { PluginLockfile } from "../../plugin/lockfile-schema"

export async function resolvePluginUpdateTargets<T>(input: {
  specs: string[]
  target?: string
  lockfile: PluginLockfile
  read: (spec: string) => Promise<T>
  matches: (plugin: T, target: string) => boolean
}): Promise<T[]> {
  if (!input.target) return Promise.all(input.specs.map(input.read))

  const lockedEntry =
    input.lockfile.plugins[input.target] ??
    Object.values(input.lockfile.plugins).find((entry) => entry.approvalId === input.target)
  const lockedSpec = lockedEntry?.spec
  if (lockedSpec && input.specs.includes(lockedSpec)) {
    return [await input.read(lockedSpec)]
  }

  for (const spec of input.specs) {
    try {
      const plugin = await input.read(spec)
      if (input.matches(plugin, input.target)) return [plugin]
    } catch {
      continue
    }
  }
  return []
}
