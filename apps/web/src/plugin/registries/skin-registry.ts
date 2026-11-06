import type { Skin } from "@ericsanchezok/synergy-plugin/skin"
import { SlotRegistry, type SlotEntryBase } from "../slot-registry"

export interface SkinEntry extends SlotEntryBase {
  pluginId: string
  definition: Skin
  assets: Readonly<Record<string, string>>
}
const registry = new SlotRegistry<SkinEntry>()
export const registerSkin = (entry: Omit<SkinEntry, "slot">) => registry.register({ ...entry, slot: "app.skin" })
export const getSkin = (id: string) => registry.get(id)
export const listSkins = () => registry.list("app.skin")
export const subscribeSkins = (listener: () => void) => registry.subscribe(listener)
