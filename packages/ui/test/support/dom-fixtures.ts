import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(import.meta.dir, "../../../..")
const source = path.join(root, "packages/ui/test/fixtures/session-turn")
const names = Array.from(new Bun.Glob("*.tsx").scanSync({ cwd: source }))
  .map((file) => file.slice(0, -4))
  .sort()
let prepared: Promise<string> | undefined

async function inputHash() {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(`${process.platform}/${process.arch}/${Bun.version}`)
  const files = [
    "bun.lock",
    "package.json",
    "packages/ui/tsconfig.json",
    "packages/ui/test/support/dom-fixtures.ts",
    ...["ui", "plugin", "sdk/js", "util"].map((name) => `packages/${name}/package.json`),
  ]
  for (const directory of [
    "packages/ui/src",
    "packages/ui/test/fixtures/session-turn",
    "packages/plugin/src",
    "packages/plugin/dist",
    "packages/sdk/js/src",
    "packages/util/src",
  ])
    for await (const file of new Bun.Glob("**/*").scan({ cwd: path.join(root, directory), onlyFiles: true }))
      files.push(`${directory}/${file}`)
  for (const file of files.sort()) {
    hash.update(file)
    hash.update(await Bun.file(path.join(root, file)).arrayBuffer())
  }
  return hash.digest("hex")
}

async function valid(directory: string, input: string) {
  try {
    const manifest = (await Bun.file(path.join(directory, "manifest.json")).json()) as {
      input: string
      files: Record<string, string>
    }
    if (manifest.input !== input || names.some((name) => !manifest.files[`${name}.js`])) return false
    for (const [file, digest] of Object.entries(manifest.files)) {
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) return false
      const hash = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(path.join(directory, file)).arrayBuffer())
        .digest("hex")
      if (digest !== hash) return false
    }
    return true
  } catch {
    return false
  }
}

export function prepareDOMFixtures() {
  return (prepared ??= (async () => {
    const input = await inputHash()
    const cache = path.join(root, ".artifacts/testing/ui-dom-fixtures")
    const directory = path.join(cache, input)
    if (await valid(directory, input)) return directory
    await mkdir(cache, { recursive: true })
    const staging = await mkdtemp(path.join(cache, ".build-"))
    try {
      const [{ build }, { default: solidPlugin }] = await Promise.all([import("vite"), import("vite-plugin-solid")])
      await build({
        configFile: false,
        logLevel: "silent",
        plugins: [solidPlugin()],
        resolve: {
          alias: { "@ericsanchezok/synergy-plugin/theme": path.join(root, "packages/plugin/src/theme/index.ts") },
        },
        worker: { format: "es" },
        build: {
          outDir: staging,
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: Object.fromEntries(names.map((name) => [name, path.join(source, `${name}.tsx`)])),
            formats: ["es"],
          },
          rollupOptions: { output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" } },
        },
      })
      const files: Record<string, string> = {}
      for await (const file of new Bun.Glob("**/*").scan({ cwd: staging, onlyFiles: true }))
        files[file] = new Bun.CryptoHasher("sha256")
          .update(await Bun.file(path.join(staging, file)).arrayBuffer())
          .digest("hex")
      await Bun.write(path.join(staging, "manifest.json"), JSON.stringify({ input, files }))
      if (await valid(directory, input)) return directory
      await rm(directory, { recursive: true, force: true })
      await rename(staging, directory)
      return directory
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })())
}

export async function domFixture(name: string) {
  if (!names.includes(name)) throw new Error(`Unknown DOM fixture: ${name}`)
  return `${pathToFileURL(path.join(await prepareDOMFixtures(), `${name}.js`)).href}?test=${Date.now()}`
}
