import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { z } from "zod"

const manifestName = ".fixture-manifest.json"
const manifestSchema = z.object({ input: z.string(), files: z.record(z.string(), z.string()) })

async function inventory(directory: string, relative = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = path.posix.join(relative, entry.name)
    if (file === manifestName) continue
    if (entry.isDirectory()) {
      Object.assign(files, await inventory(directory, file))
      continue
    }
    if (!entry.isFile()) throw new Error(`Fixture output is not a regular file: ${file}`)
    files[file] = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path.join(directory, file)).arrayBuffer())
      .digest("hex")
  }
  return files
}

async function valid(directory: string, input: string) {
  try {
    const manifest = manifestSchema.parse(await Bun.file(path.join(directory, manifestName)).json())
    return (
      manifest.input === input &&
      Object.keys(manifest.files).length > 0 &&
      JSON.stringify(await inventory(directory)) === JSON.stringify(manifest.files)
    )
  } catch {
    return false
  }
}

export async function cachedFixture(options: {
  cache: string
  input: string
  build: (directory: string) => Promise<void>
}) {
  const key = new Bun.CryptoHasher("sha256").update(options.input).digest("hex")
  const directory = path.join(options.cache, key)
  if (await valid(directory, options.input)) return directory
  return withFileLock({ directory: path.join(options.cache, ".locks"), key, timeoutMs: 180_000 }, async () => {
    if (await valid(directory, options.input)) return directory
    await mkdir(options.cache, { recursive: true })
    const staging = await mkdtemp(path.join(options.cache, ".build-"))
    try {
      await options.build(staging)
      const files = await inventory(staging)
      if (!Object.keys(files).length) throw new Error("Fixture compilation produced no files")
      await Bun.write(path.join(staging, manifestName), JSON.stringify({ input: options.input, files }))
      await rm(directory, { recursive: true, force: true })
      await rename(staging, directory)
      return directory
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })
}
