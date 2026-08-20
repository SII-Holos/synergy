import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { DEFAULT_PET_SETTINGS, type PetSettingsV1 } from "./pet-types.js"

export const PetSettingsStateV1 = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    spritePath: z.string(),
    width: z.number().int().min(64).max(512),
    height: z.number().int().min(64).max(512),
    position: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
      })
      .nullable(),
    idleTimeoutMs: z.number().int().min(0).max(86_400_000),
    frameMs: z.number().int().min(16).max(2_000),
  })
  .strict()

export type PetSettingsStateV1 = z.infer<typeof PetSettingsStateV1>

const PET_SETTINGS_FILE = "desktop-pet.json"

export function petSettingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, PET_SETTINGS_FILE)
}

export function defaultPetSettingsState(): PetSettingsStateV1 {
  return { ...DEFAULT_PET_SETTINGS }
}

export async function loadPetSettings(userDataPath: string): Promise<PetSettingsStateV1> {
  try {
    const content = await readFile(petSettingsFilePath(userDataPath), "utf8")
    const parsed = PetSettingsStateV1.safeParse(JSON.parse(content))
    if (parsed.success) return parsed.data
  } catch {
    // Missing or unreadable state falls back to defaults.
  }
  return defaultPetSettingsState()
}

export async function savePetSettings(userDataPath: string, state: PetSettingsStateV1): Promise<void> {
  const filepath = petSettingsFilePath(userDataPath)
  await mkdir(path.dirname(filepath), { recursive: true })
  await writeFile(filepath, `${JSON.stringify(state, null, 2)}\n`)
}

export function parsePetSettingsUpdate(input: unknown): PetSettingsStateV1 {
  return PetSettingsStateV1.parse(input)
}

/** Return a settings object coerced to the typed PetSettingsV1 shape the renderer consumes. */
export function toPetSettings(state: PetSettingsStateV1): PetSettingsV1 {
  return { ...state }
}
