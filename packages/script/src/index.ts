import { $ } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

if (process.versions.bun !== expectedBunVersion) {
  throw new Error(`This script requires bun@${expectedBunVersion}, but you are using bun@${process.versions.bun}`)
}

const env = {
  SYNERGY_CHANNEL: process.env["SYNERGY_CHANNEL"],
  SYNERGY_BUMP: process.env["SYNERGY_BUMP"],
  SYNERGY_VERSION: process.env["SYNERGY_VERSION"],
}
const CHANNEL = await (async () => {
  if (env.SYNERGY_CHANNEL) return env.SYNERGY_CHANNEL
  if (env.SYNERGY_BUMP) return "latest"
  if (env.SYNERGY_VERSION && !env.SYNERGY_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim().replace(/\//g, "-"))
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.SYNERGY_VERSION) return env.SYNERGY_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`

  // Fetch latest version from npm registry
  const version = await fetch("https://registry.npmjs.org/@ericsanchezok/synergy/latest")
    .then((res) => {
      if (!res.ok) {
        console.warn(`Failed to fetch latest version: ${res.statusText}, defaulting to 0.1.0`)
        return { version: "0.1.0" }
      }
      return res.json()
    })
    .then((data: any) => data.version)
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.SYNERGY_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

async function npmVersionExists(name: string, version: string): Promise<boolean> {
  const res = await fetch(`https://registry.npmjs.org/${name}/${version}`)
  return res.ok
}

async function retry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delay = 10_000 }: { attempts?: number; delay?: number } = {},
): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts) throw err
      console.log(`  attempt ${i}/${attempts} failed, retrying in ${delay / 1000}s...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error("unreachable")
}

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  npmVersionExists,
  retry,
}
console.log(`synergy script`, JSON.stringify(Script, null, 2))
