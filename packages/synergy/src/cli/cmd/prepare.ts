import { cmd } from "./cmd"
import { UI } from "../ui"
import { $ } from "bun"

export const PrepareCommand = cmd({
  command: "prepare",
  describe: "one-time dev setup: install deps, generate SDK, build frontend",
  handler: async () => {
    const repoRoot = process.env.SYNERGY_CWD ?? process.cwd()

    UI.println("📦 Installing dependencies...")
    await $`bun install`.cwd(repoRoot).quiet()

    UI.println("🔧 Generating SDK...")
    await $`bun ./packages/sdk/js/script/build.ts`.cwd(repoRoot).quiet()

    UI.println("🏗️  Building web frontend...")
    await $`bun run --cwd packages/app build`.cwd(repoRoot).quiet()

    UI.println("✅ Dev environment ready. Start the server with: bun dev server")
  },
})

export const BuildCommand = cmd({
  command: "build",
  describe: "rebuild the web frontend",
  handler: async () => {
    const repoRoot = process.env.SYNERGY_CWD ?? process.cwd()

    UI.println("🏗️  Building web frontend...")
    await $`bun run --cwd packages/app build`.cwd(repoRoot).quiet()

    UI.println("✅ Frontend built. Restart the server with: bun dev restart")
  },
})
