// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// global/index.ts reads SYNERGY_TEST_HOME at import time, so we must set it first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "synergy-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  try {
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
  } catch (error) {
    if (process.platform === "win32" && isTransientCleanupError(error)) return
    throw error
  }
})

function isTransientCleanupError(error: unknown) {
  const code = (error as { code?: unknown })?.code
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY"
}
// Set test home directory to isolate tests from user's actual home directory
// This makes Global.Path.root resolve to <dir>/home/.synergy
// Clear SYNERGY_HOME first: homeDir() in global/index.ts checks SYNERGY_HOME
// before SYNERGY_TEST_HOME, so a pre-existing SYNERGY_HOME would leak real
// user data (sessions, messages, migration state) into test execution.
delete process.env["SYNERGY_HOME"]
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["SYNERGY_TEST_HOME"] = testHome

// Always seed the model catalog from the checked-in fixture rather than fetching
// models.dev live. The live catalog drifts (models get renamed/removed), which
// makes tests that reference specific models non-deterministic — a network-
// reachable-but-drifted catalog turns CI red with no code change (e.g.
// claude-sonnet-4-20250514 was removed upstream). The fixture is the pinned
// source of truth; update it deliberately when a test needs a new model.
const cacheDir = path.join(testHome, ".synergy", "cache")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "15")
const modelsCachePath = path.join(cacheDir, "models.json")
const fixture = await Bun.file(new URL("./tool/fixtures/models-api.json", import.meta.url)).text()
await fs.writeFile(modelsCachePath, fixture)
process.env["MODELS_DEV_API_JSON"] = modelsCachePath
// Disable models.dev refresh to avoid race conditions during tests
process.env["SYNERGY_DISABLE_MODELS_FETCH"] = "true"
process.env["SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH"] = "true"
// Disable plugins and LSP download to avoid hangs in CI
process.env["SYNERGY_DISABLE_DEFAULT_PLUGINS"] = "true"
process.env["SYNERGY_DISABLE_LSP_DOWNLOAD"] = "true"
// Disable file watcher to avoid native module / inotify hangs in CI
process.env["SYNERGY_DISABLE_FILEWATCHER"] = "true"

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
