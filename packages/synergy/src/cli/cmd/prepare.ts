import { cmd } from "./cmd"
import { UI } from "../ui"
import { $ } from "bun"

export const PrepareCommand = cmd({
  command: "prepare",
  describe: "one-time dev setup: install deps, generate SDK, build frontend",
  handler: async () => {
    const repoRoot = process.env.SYNERGY_CWD ?? process.cwd()

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
    const repoRoot = process.env.SYNERGY_CWD ?? process.cwd()

    UI.println("🏗️  Building web frontend...")
    const build = await $`bun run --cwd packages/app build`.cwd(repoRoot).nothrow()
    if (build.exitCode !== 0) {
      UI.error("Failed to build web frontend.")
      process.exit(1)
    }

    UI.println("✅ Frontend built. Restart the server with: bun dev restart")
  },
})
