// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// global/index.ts reads SYNERGY_TEST_HOME at import time, so we must set it first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "synergy-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})
// Set test home directory to isolate tests from user's actual home directory
// This makes Global.Path.root resolve to <dir>/home/.synergy
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["SYNERGY_TEST_HOME"] = testHome

// Pre-fetch models.json so tests don't need the macro fallback
// Also write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(testHome, ".synergy", "cache")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "15")
const modelsCachePath = path.join(cacheDir, "models.json")
try {
  const response = await fetch("https://models.dev/api.json", {
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) throw new Error(`unexpected status ${response.status}`)
  await fs.writeFile(modelsCachePath, await response.text())
} catch {
  const fixture = await Bun.file(new URL("./tool/fixtures/models-api.json", import.meta.url)).text()
  await fs.writeFile(modelsCachePath, fixture)
}
process.env["MODELS_DEV_API_JSON"] = modelsCachePath
// Disable models.dev refresh to avoid race conditions during tests
process.env["SYNERGY_DISABLE_MODELS_FETCH"] = "true"

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

// Now safe to import from src/
const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
