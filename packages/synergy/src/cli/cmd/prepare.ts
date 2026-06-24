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

function warn(msg: string) {
  UI.println(`⚠️  ${msg}`)
}

export const PrepareCommand = cmd({
  command: "prepare",
  describe: "one-time dev setup: install deps, generate SDK, build frontend, compile sandbox helper",
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

    // ---- Sandbox helper compilation ----
    // On Linux and Windows, the sandbox needs a Rust helper binary.
    // Compile it once during prepare so sandbox works out of the box.
    const platform = process.platform
    if (platform === "linux" || platform === "win32") {
      const helperDir =
        platform === "linux"
          ? path.join(repoRoot, "packages", "synergy", "src", "sandbox", "helper-linux")
          : path.join(repoRoot, "packages", "synergy", "src", "sandbox", "helper")

      if (!fs.existsSync(path.join(helperDir, "Cargo.toml"))) {
        warn("Sandbox helper source not found — sandbox will not be available.")
      } else {
        // Check if Rust is installed
        const rustCheck = await $`which cargo`.env({ PATH: process.env.PATH }).nothrow().quiet()
        if (rustCheck.exitCode !== 0) {
          UI.println()
          warn("Rust (cargo) not found — sandbox helper cannot be compiled.")
          UI.println("   Install: https://rustup.rs")
          UI.println("   Then re-run: bun dev prepare")
          UI.println()
        } else {
          UI.println("🛡️  Compiling sandbox helper (this may take a minute the first time)...")
          const helperBuild = await $`cargo build --release`.cwd(helperDir).nothrow()
          if (helperBuild.exitCode !== 0) {
            warn("Sandbox helper compilation failed — sandbox will not be available.")
            warn("  Check the build output above for missing dependencies.")
            if (platform === "linux") {
              warn("  Linux may need: sudo apt install build-essential pkg-config libseccomp-dev")
            }
          } else {
            UI.println("   Registering helper hash for verification...")
            const helperTarget = platform === "linux" ? "linux" : "windows"
            const register = await $`bun run packages/synergy/scripts/build-helper.ts ${helperTarget} --local`
              .cwd(repoRoot)
              .nothrow()
            if (register.exitCode !== 0) {
              warn("Hash registration failed — sandbox will use relaxed verification.")
            } else {
              UI.println(`   ✅ Sandbox helper compiled and registered.`)
            }

            if (platform === "linux") {
              const bwrapCheck = await $`which bwrap`.env({ PATH: process.env.PATH }).nothrow().quiet()
              if (bwrapCheck.exitCode !== 0) {
                warn("bwrap (bubblewrap) not found — sandbox requires it on Linux.")
                UI.println("   Install: sudo apt install bubblewrap")
                UI.println("   Or: bash packages/synergy/scripts/download-bwrap.sh")
              }
            }
          }
        }
      }
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

    UI.println("✅ Frontend built. Restart the server with: bun dev server")
  },
})
