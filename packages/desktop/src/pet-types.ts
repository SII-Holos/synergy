/** Animation rows map to the 8x7 sprite sheet rows in order. */
export const PET_ANIMATIONS = ["idle", "happy", "celebrate", "sleepy", "working", "angry", "dragging"] as const

export type PetAnimation = (typeof PET_ANIMATIONS)[number]

export const PET_SPRITE_COLUMNS = 8
export const PET_SPRITE_ROWS = PET_ANIMATIONS.length

export interface PetSpriteSheet {
  /** data URL of the sprite sheet image, or null when the pet uses the CSS fallback */
  dataUrl: string | null
  /** frames per row; defaults to PET_SPRITE_COLUMNS when validation is absent */
  columns: number
  /** rows; defaults to PET_SPRITE_ROWS when validation is absent */
  rows: number
  /** ms per frame; defaults to 120 */
  frameMs: number
}

export interface PetSettingsV1 {
  version: 1
  /** master switch; the pet window is destroyed when disabled */
  enabled: boolean
  /** absolute path to an 8x7 sprite sheet (PNG/JPG); empty uses the CSS fallback */
  spritePath: string
  /** window width in CSS pixels */
  width: number
  /** window height in CSS pixels */
  height: number
  /** stored window position; null lets the window pick its own corner */
  position: { x: number; y: number } | null
  /** idle time before the pet falls asleep, in ms */
  idleTimeoutMs: number
  /** ms per frame for sprite animation */
  frameMs: number
}

export const DEFAULT_PET_SETTINGS: PetSettingsV1 = {
  version: 1,
  enabled: true,
  spritePath: "",
  width: 160,
  height: 140,
  position: null,
  idleTimeoutMs: 5 * 60_000,
  frameMs: 120,
}
