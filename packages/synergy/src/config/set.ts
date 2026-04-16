import { NamedError } from "@ericsanchezok/synergy-util/error"
import { existsSync, readFileSync } from "fs"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"

export namespace ConfigSet {
  export const DEFAULT = "default"

  export const Name = z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      "Config Set names must start with a letter or number and use only letters, numbers, hyphens, and underscores",
    )
    .meta({ ref: "ConfigSetName" })
  export type Name = z.infer<typeof Name>

  export const Metadata = z
    .object({
      active: Name.default(DEFAULT),
    })
    .strict()
    .meta({ ref: "ConfigSetMetadata" })
  export type Metadata = z.infer<typeof Metadata>

  export const Summary = z
    .object({
      name: Name,
      active: z.boolean(),
      isDefault: z.boolean(),
      path: z.string(),
    })
    .meta({ ref: "ConfigSetSummary" })
  export type Summary = z.infer<typeof Summary>

  export const NotFoundError = NamedError.create(
    "ConfigSetNotFoundError",
    z.object({
      name: z.string(),
    }),
  )

  export const ExistsError = NamedError.create(
    "ConfigSetExistsError",
    z.object({
      name: z.string(),
    }),
  )

  export const DeleteDefaultError = NamedError.create(
    "ConfigSetDeleteDefaultError",
    z.object({
      name: z.string(),
    }),
  )

  export const DeleteActiveError = NamedError.create(
    "ConfigSetDeleteActiveError",
    z.object({
      name: z.string(),
      active: z.string(),
    }),
  )

  export function metadataPath() {
    return path.join(Global.Path.config, "config-set.json")
  }

  export function directory() {
    return path.join(Global.Path.config, "config-sets")
  }

  export function defaultFilePath() {
    return path.join(Global.Path.config, "synergy.jsonc")
  }

  export function filePath(name: string) {
    const parsed = Name.parse(name)
    if (parsed === DEFAULT) return defaultFilePath()
    return path.join(directory(), parsed, "synergy.jsonc")
  }

  export function configDirectory(name: string) {
    const parsed = Name.parse(name)
    if (parsed === DEFAULT) return Global.Path.config
    return path.join(directory(), parsed)
  }

  export async function activeName(): Promise<Name> {
    return (await readMetadata()).active
  }

  export function activeNameSync(): Name {
    try {
      const filepath = metadataPath()
      if (!existsSync(filepath)) return DEFAULT
      const text = readFileSync(filepath, "utf8")
      if (!text.trim()) return DEFAULT
      return Metadata.parse(JSON.parse(text)).active
    } catch {
      return DEFAULT
    }
  }

  export async function readMetadata(): Promise<Metadata> {
    const filepath = metadataPath()
    const text = await Bun.file(filepath)
      .text()
      .catch((error) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (!text?.trim()) return { active: DEFAULT }
    return Metadata.parse(JSON.parse(text))
  }

  export async function writeMetadata(active: string) {
    const parsed = Name.parse(active)
    await fs.mkdir(Global.Path.config, { recursive: true })
    await Bun.write(metadataPath(), JSON.stringify({ active: parsed }, null, 2) + "\n")
    return parsed
  }

  export async function exists(name: string) {
    const parsed = Name.parse(name)
    if (parsed === DEFAULT) return true
    return Bun.file(filePath(parsed)).exists()
  }

  export async function assertExists(name: string) {
    const parsed = Name.parse(name)
    if (!(await exists(parsed))) {
      throw new NotFoundError({ name: parsed })
    }
    return parsed
  }

  export async function summary(name: string): Promise<Summary> {
    const parsed = await assertExists(name)
    const active = await activeName()
    return {
      name: parsed,
      active: parsed === active,
      isDefault: parsed === DEFAULT,
      path: filePath(parsed),
    }
  }

  export async function list(): Promise<Summary[]> {
    await fs.mkdir(directory(), { recursive: true })
    const entries = await fs.readdir(directory(), { withFileTypes: true }).catch(() => [])
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(path.join(directory(), name, "synergy.jsonc")))
      .sort((left, right) => left.localeCompare(right))

    const active = await activeName()
    return [DEFAULT, ...names].map((name) => ({
      name,
      active: name === active,
      isDefault: name === DEFAULT,
      path: filePath(name),
    }))
  }

  export async function create(name: string) {
    const parsed = Name.parse(name)
    if (parsed === DEFAULT || (await exists(parsed))) {
      throw new ExistsError({ name: parsed })
    }
    await fs.mkdir(configDirectory(parsed), { recursive: true })
    const filepath = filePath(parsed)
    await Bun.write(filepath, "{}\n")
    return filepath
  }

  export async function remove(name: string) {
    const parsed = await assertExists(name)
    if (parsed === DEFAULT) {
      throw new DeleteDefaultError({ name: parsed })
    }
    const active = await activeName()
    if (parsed === active) {
      throw new DeleteActiveError({ name: parsed, active })
    }
    await fs.rm(configDirectory(parsed), { recursive: true, force: true })
  }

  export async function activate(name: string) {
    const parsed = await assertExists(name)
    const previous = await activeName()
    await writeMetadata(parsed)
    return {
      previous,
      active: parsed,
      changed: previous !== parsed,
    }
  }
}
