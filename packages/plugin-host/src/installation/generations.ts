import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { SynergyPackage } from "@ericsanchezok/synergy-plugin/package"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withInstallationLock } from "./lock"
import { sha256File } from "./files"

const RelativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
  )
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Pointer = z.object({ version: z.literal(1), id: z.uuid(), sha256: Digest }).strict()
const Intent = z
  .object({ version: z.literal(1), previous: Pointer.optional(), next: Pointer })
  .strict()
  .refine((value) => value.previous?.id !== value.next.id, "Installation intent must select a new generation")
const LockedPackage = z
  .object({
    directory: RelativePath,
    version: z.string().min(1),
    spec: z.string().min(1),
    metadata: SynergyPackage.optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
  })
  .strict()
const File = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), sha256: Digest }).strict(),
  z.object({ kind: z.literal("symlink"), target: z.string().min(1) }).strict(),
])
const Manifest = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    hostVersion: z.string().regex(/^(?:local|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/),
    minimumVersions: z.record(z.string(), z.string()),
    roots: z.record(z.string(), z.string()),
    packages: z.record(z.string(), LockedPackage),
    files: z.record(RelativePath, File),
    hostCodeApprovedAt: z.number().int().positive(),
  })
  .strict()

export type InstalledGeneration = z.infer<typeof Manifest> & { directory: string; sha256: string }
export type InstalledPackage = z.infer<typeof LockedPackage>
export interface GenerationInput {
  directory: string
  previous?: string
  hostVersion: string
  roots: Record<string, string>
  packages: Record<string, InstalledPackage>
  trustHostCode: boolean
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const base = (root: string) => path.join(root, "installations")
const generationPath = (root: string, id: string) => path.join(base(root), "generations", z.uuid().parse(id))
const samePointer = (left?: z.infer<typeof Pointer>, right?: z.infer<typeof Pointer>) =>
  left?.id === right?.id && left?.sha256 === right?.sha256

function contained(root: string, filename: string) {
  const relative = path.relative(root, filename)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Installation file escapes its generation")
}

async function optionalJson(filename: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function pointer(root: string) {
  const value = await optionalJson(path.join(base(root), "active.json"))
  return value === undefined ? undefined : Pointer.parse(value)
}

async function inventory(directory: string, durable = false) {
  const canonical = await fs.realpath(directory)
  const files: z.infer<typeof Manifest>["files"] = {}
  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(current, entry.name)
      const relative = path.relative(canonical, filename).split(path.sep).join("/")
      if (relative === "generation.json") continue
      RelativePath.parse(relative)
      if (entry.isSymbolicLink()) {
        contained(canonical, await fs.realpath(filename))
        const target = await fs.readlink(filename)
        if (path.isAbsolute(target)) throw new Error("Installation symlinks must be relative")
        files[relative] = { kind: "symlink", target }
      } else if (entry.isDirectory()) await walk(filename)
      else if (entry.isFile()) {
        files[relative] = { kind: "file", sha256: await sha256File(filename, durable) }
      } else throw new Error(`Unsupported installation file: ${relative}`)
    }
    if (durable) await AtomicFile.syncDirectories(current)
  }
  await walk(canonical)
  return files
}

async function verify(root: string, selected: z.infer<typeof Pointer>): Promise<InstalledGeneration> {
  const directory = generationPath(root, selected.id)
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Installation generation is not an owned directory")
  if (!(await fs.lstat(path.join(directory, "generation.json"))).isFile())
    throw new Error("Installation manifest must be a regular file")
  const text = await fs.readFile(path.join(directory, "generation.json"), "utf8")
  if (digest(text) !== selected.sha256) throw new Error("Installation manifest integrity mismatch")
  const manifest = Manifest.parse(JSON.parse(text))
  if (manifest.id !== selected.id) throw new Error("Installation generation identity mismatch")
  const actual = await inventory(directory)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("Installation file integrity mismatch")
  return { ...manifest, directory: await fs.realpath(directory), sha256: selected.sha256 }
}

async function recoverGeneration(root: string) {
  const filename = path.join(base(root), "pending.json")
  const value = await optionalJson(filename)
  if (value === undefined) return
  const intent = Intent.parse(value)
  const active = await pointer(root)
  if (samePointer(active, intent.next)) await verify(root, intent.next)
  else if (samePointer(active, intent.previous))
    await fs.rm(generationPath(root, intent.next.id), { recursive: true, force: true })
  else throw new Error("Installation changed during recovery; the pending transaction is retained")
  await fs.rm(filename)
}

function validatePackages(input: GenerationInput) {
  const components = new Map<string, string>([
    ["local-runtime", input.hostVersion],
    ["plugin-host", input.hostVersion],
  ])
  for (const pkg of Object.values(input.packages)) {
    const metadata = pkg.metadata
    if (!metadata) continue
    if (metadata.version !== pkg.version) throw new Error(`Package version mismatch: ${metadata.id}`)
    if (input.hostVersion !== "local" && !Bun.semver.satisfies(input.hostVersion, metadata.compatibility.synergy))
      throw new Error(`${metadata.id} requires Synergy ${metadata.compatibility.synergy}`)
    if (metadata.kind === "component") {
      if (components.has(metadata.id)) throw new Error(`Duplicate installed component: ${metadata.id}`)
      components.set(metadata.id, metadata.version)
    }
  }
  for (const pkg of Object.values(input.packages)) {
    if (pkg.metadata?.kind !== "component") continue
    for (const [id, range] of Object.entries(pkg.metadata.requires ?? {})) {
      const version = components.get(id)
      if (!version || (version !== "local" && !Bun.semver.satisfies(version, range)))
        throw new Error(`${pkg.metadata.id} requires component ${id}@${range}`)
    }
  }
  const owners = new Map(
    Object.values(input.packages).flatMap((pkg) =>
      pkg.metadata?.kind === "component" ? [[pkg.metadata.id, pkg.metadata] as const] : [],
    ),
  )
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string) {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Installed component dependency cycle at ${id}`)
    visiting.add(id)
    for (const required of Object.keys(owners.get(id)?.requires ?? {})) visit(required)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of owners.keys()) visit(id)
}

export namespace InstallationGenerations {
  export const recoverUnlocked = recoverGeneration

  export async function readSeed(directory: string): Promise<InstalledGeneration> {
    const raw = await fs.readFile(path.join(directory, "generation.json"), "utf8")
    const manifest = Manifest.parse(JSON.parse(raw))
    if (JSON.stringify(await inventory(directory)) !== JSON.stringify(manifest.files))
      throw new Error("Bundled installation seed integrity mismatch")
    return { ...manifest, directory: await fs.realpath(directory), sha256: digest(raw) }
  }

  export function pin(root: string, selected: { id: string; sha256: string }) {
    return verify(root, Pointer.parse({ version: 1, ...selected }))
  }

  export async function stage(root: string) {
    const directory = path.join(base(root), "staging", randomUUID())
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  export function current(root: string) {
    return withInstallationLock(root, async () => {
      await recoverUnlocked(root)
      const selected = await pointer(root)
      return selected ? verify(root, selected) : undefined
    })
  }

  export function commit(root: string, input: GenerationInput) {
    return withInstallationLock(root, async () => {
      await recoverUnlocked(root)
      const previous = await pointer(root)
      if (previous?.id !== input.previous) throw new Error("Installation changed while resolving packages; retry")
      if (!input.trustHostCode) throw new Error("Explicit trust of host code is required before installation")
      const previousGeneration = previous ? await verify(root, previous) : undefined
      if (previousGeneration?.files["plugin-activation.json"]) {
        const applied = await optionalJson(path.join(base(root), "activated", previousGeneration.id + ".json"))
        if (applied !== previousGeneration.sha256)
          throw new Error("The previous installation has pending plugin activation; run synergy install --resume")
      }
      const minimumVersions = { ...previousGeneration?.minimumVersions }
      const versions = [
        ["host:core", input.hostVersion],
        ...Object.values(input.packages).flatMap((pkg) =>
          pkg.metadata ? [[`${pkg.metadata.kind}:${pkg.metadata.id}`, pkg.version]] : [],
        ),
      ]
      for (const [id, version] of versions) {
        const minimum = minimumVersions[id]
        if (minimum && minimum !== "local" && version !== "local" && Bun.semver.order(version, minimum) < 0)
          throw new Error(`Cannot downgrade ${id} below ${minimum}; upgraded data requires its current code`)
        minimumVersions[id] = version
      }
      const id = z.uuid().parse(path.basename(input.directory))
      if (path.resolve(input.directory) !== path.resolve(base(root), "staging", id))
        throw new Error("Installation stage is not owned by this home")
      if (!(await fs.lstat(input.directory)).isDirectory()) throw new Error("Installation stage must be a directory")
      validatePackages(input)
      const files = await inventory(input.directory, true)
      for (const pkg of Object.values(input.packages)) {
        if (pkg.metadata?.kind === "component") {
          const entry = path.posix.join(pkg.directory, pkg.metadata.entry)
          if (!files[entry]) throw new Error(`Component entry is missing: ${pkg.metadata.id}`)
        }
      }
      const manifest = Manifest.parse({
        version: 1,
        id,
        hostVersion: input.hostVersion,
        minimumVersions,
        roots: input.roots,
        packages: input.packages,
        files,
        hostCodeApprovedAt: Date.now(),
      })
      const text = JSON.stringify(manifest)
      await AtomicFile.writeJsonAtomic(path.join(input.directory, "generation.json"), text, {
        durable: true,
        private: true,
      })
      const next = Pointer.parse({ version: 1, id, sha256: digest(text) })
      const pending = path.join(base(root), "pending.json")
      await AtomicFile.writeJsonAtomic(pending, JSON.stringify({ version: 1, previous, next }), {
        durable: true,
        private: true,
      })
      const directory = generationPath(root, id)
      try {
        await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
        await fs.rename(input.directory, directory)
        await AtomicFile.syncDirectories(path.dirname(input.directory), path.dirname(directory))
        await AtomicFile.writeJsonAtomic(path.join(base(root), "active.json"), JSON.stringify(next), {
          durable: true,
          private: true,
        })
        await fs.rm(pending)
        return { ...manifest, directory: await fs.realpath(directory), sha256: next.sha256 }
      } catch (error) {
        await recoverUnlocked(root)
        if (samePointer(await pointer(root), next)) return verify(root, next)
        throw error
      }
    })
  }
}
