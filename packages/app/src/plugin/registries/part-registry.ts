import { registerPartComponent, PART_MAPPING, type PartComponent } from "@ericsanchezok/synergy-ui/message-part"

export type PartRenderer = PartComponent

/** Loader stored alongside a registered part type (no component yet). */
const loaders = new Map<string, () => Promise<{ default: PartRenderer }>>()
const loading = new Set<string>()

export function registerPartRenderer(
  type: string,
  renderer: PartRenderer | undefined,
  loader?: () => Promise<{ default: PartRenderer }>,
): () => void {
  registerPartComponent(type, renderer as any)
  if (loader) loaders.set(type, loader)
  return () => {
    delete PART_MAPPING[type]
    loaders.delete(type)
    loading.delete(type)
  }
}

/** Resolve a part renderer synchronously. Kicks off loader on first miss. */
export function resolvePartRenderer(type: string): PartRenderer | undefined {
  const existing = PART_MAPPING[type] as PartRenderer | undefined
  if (existing) return existing
  const loader = loaders.get(type)
  if (loader && !loading.has(type)) {
    loading.add(type)
    loader().then(
      (mod) => {
        registerPartComponent(type, mod.default as any)
        loading.delete(type)
      },
      () => loading.delete(type),
    )
  }
  return undefined
}

export function getPartRenderer(type: string): PartRenderer | undefined {
  return resolvePartRenderer(type) ?? (PART_MAPPING[type] as PartRenderer | undefined)
}

export function hasPartRenderer(type: string): boolean {
  return type in PART_MAPPING || loaders.has(type)
}
