import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

export async function generateOpenApi(): Promise<string> {
  const root = path.resolve(import.meta.dirname, "..")
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-openapi-"))
  try {
    return await $`bun ${path.join(root, "packages/product-runtime/src/index.ts")} generate`
      .cwd(root)
      .env({
        ...process.env,
        SYNERGY_HOME: home,
        MODELS_DEV_API_JSON: path.join(root, "packages/testing/fixtures/models-api.json"),
        SYNERGY_DISABLE_MODELS_FETCH: "true",
        SYNERGY_DISABLE_DEFAULT_PLUGINS: "true",
        SYNERGY_DISABLE_BUILTIN_MCP: "true",
        SYNERGY_DISABLE_FILEWATCHER: "true",
        SYNERGY_DISABLE_LSP_DOWNLOAD: "true",
      })
      .text()
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}
