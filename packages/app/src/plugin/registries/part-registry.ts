import { registerPartComponent, PART_MAPPING, type PartComponent } from "@ericsanchezok/synergy-ui/message-part"

export type PartRenderer = PartComponent

export function registerPartRenderer(type: string, renderer: PartRenderer): () => void {
  registerPartComponent(type, renderer)
  return () => {
    delete PART_MAPPING[type]
  }
}

export function getPartRenderer(type: string): PartRenderer | undefined {
  return PART_MAPPING[type]
}

export function hasPartRenderer(type: string): boolean {
  return type in PART_MAPPING && PART_MAPPING[type] !== undefined
}
