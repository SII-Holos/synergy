import { cmd } from "./cmd"
import { UI } from "../ui"
import { $ } from "bun"
import fs from "fs"
import path from "path"

/**
 * Resolve the monorepo root. If run from a subdirectory (e.g. packages/synergy),
 * walk up to find the root (identified by the presence of the monorepo package.json
 * with workspaces, or the turbo.json file).
 */
function resolveRepoRoot(cwd: string): string {
  let dir = cwd
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "turbo.json")) && fs.existsSync(path.join(dir, "packages"))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return cwd
}

function requireSourceCheckout(repoRoot: string): void {
  const generateScript = path.join(repoRoot, "script", "generate.ts")
  const appDir = path.join(repoRoot, "packages", "app")
  const synergyDir = path.join(repoRoot, "packages", "synergy")
  if (!fs.existsSync(generateScript) || !fs.existsSync(appDir) || !fs.existsSync(synergyDir)) {
    UI.error("'synergy prepare' is only available in source checkouts (development mode).")
    UI.error("Installed builds do not need this step.")
    process.exit(1)
  }
}

export const PrepareCommand = cmd({
  command: "prepare",
  describe: "one-time dev setup: install deps, generate SDK, build frontend",
  handler: async () => {
    const repoRoot = resolveRepoRoot(process.env.SYNERGY_CWD ?? process.cwd())
    requireSourceCheckout(repoRoot)

    UI.println("📦 Installing dependencies...")
    const install = await $`bun install`.cwd(repoRoot).nothrow()
    if (install.exitCode !== 0) {
      UI.error("Failed to install dependencies.")
      process.exit(1)
    }

    UI.println("🔧 Generating SDK and OpenAPI spec...")
    const generate = await $`bun ./script/generate.ts`.cwd(repoRoot).nothrow()
    if (generate.exitCode !== 0) {
      UI.error("Failed to generate SDK / OpenAPI spec.")
      process.exit(1)
    }

    UI.println("🏗️  Building web frontend...")
    const build = await $`bun run --cwd packages/app build`.cwd(repoRoot).nothrow()
    if (build.exitCode !== 0) {
      UI.error("Failed to build web frontend.")
      process.exit(1)
    }

    UI.println("✅ Dev environment ready. Start the server with: bun dev server")
  },
})

export const BuildCommand = cmd({
  command: "build",
  describe: "rebuild the web frontend",
  handler: async () => {
    const repoRoot = resolveRepoRoot(process.env.SYNERGY_CWD ?? process.cwd())
    requireSourceCheckout(repoRoot)

    UI.println("🏗️  Building web frontend...")
    const build = await $`bun run --cwd packages/app build`.cwd(repoRoot).nothrow()
    if (build.exitCode !== 0) {
      UI.error("Failed to build web frontend.")
      process.exit(1)
    }

    UI.println("✅ Frontend built. Restart the server with: bun dev restart")
  },
})
