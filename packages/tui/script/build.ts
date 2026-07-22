import { $ } from "bun"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(root, "src", "index.ts")],
  outdir: dist,
  target: "bun",
  format: "esm",
  packages: "external",
  sourcemap: "external",
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await $`bun tsc -p ${join(root, "tsconfig.build.json")}`
