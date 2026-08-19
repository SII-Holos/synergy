import { HOST_OWNED_MESSAGE_TYPES } from "@ericsanchezok/synergy-plugin"
import { registerPartComponent, PART_MAPPING, type PartComponent } from "@ericsanchezok/synergy-ui/message-part"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

export type PartRenderer = PartComponent

/** Internal slot entry: one renderer per message type (single-replace). */
interface PartSlotEntry extends SlotEntryBase {
  slot: "message.renderer"
  loader?: () => Promise<{ default: PartRenderer }>
}

const registry = new SlotRegistry<PartSlotEntry>()
/** Per-type disposer so re-registering a type replaces the previous entry. */
const disposers = new Map<string, () => void>()
const loading = new Set<string>()

export function registerPartRenderer(
  type: string,
  renderer: PartRenderer | undefined,
  loader?: () => Promise<{ default: PartRenderer }>,
): () => void {
  if ((HOST_OWNED_MESSAGE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Plugin message renderer cannot replace host-owned message type: ${type}`)
  }
  disposers.get(type)?.()
  registerPartComponent(type, renderer as any)
  const dispose = registry.register({ id: type, slot: "message.renderer", loader })
  disposers.set(type, dispose)
  return () => {
    if (disposers.get(type) !== dispose) return
    disposers.delete(type)
    dispose()
    delete PART_MAPPING[type]
    loading.delete(type)
  }
}

/** Resolve a part renderer synchronously. Kicks off loader on first miss. */
export function resolvePartRenderer(type: string): PartRenderer | undefined {
  const existing = PART_MAPPING[type] as PartRenderer | undefined
  if (existing) return existing
  const entry = registry.get(type)
  const loader = entry?.loader
  if (loader && !loading.has(type)) {
    loading.add(type)
    loader().then(
      (mod) => {
        if (registry.get(type) === entry) registerPartComponent(type, mod.default as any)
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
  return type in PART_MAPPING || registry.get(type)?.loader !== undefined
}
