import fs from "node:fs/promises"
import path from "node:path"
import { afterAll } from "bun:test"
import { createIsolatedTestEnv } from "./env"

const isolated = await createIsolatedTestEnv()
delete process.env["SYNERGY_HOME"]
process.env["SYNERGY_TEST_HOME"] = isolated.env.SYNERGY_TEST_HOME
process.env["SYNERGY_TEST_ROOT"] = isolated.env.SYNERGY_TEST_ROOT
process.env["LC_ALL"] = isolated.env.LC_ALL
afterAll(() => isolated.dispose())
const testHome = isolated.env.SYNERGY_TEST_HOME!

// Existing observability/performance tests exercise the store contract with
// synchronous flush-then-query semantics; pin them to the inline write path so
// behavior is unchanged. Worker-mode coverage explicitly deletes this env var.
process.env["SYNERGY_OBSERVABILITY_INLINE"] = "1"

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
const fixture = await Bun.file(new URL("../fixtures/models-api.json", import.meta.url)).text()
await fs.writeFile(modelsCachePath, fixture)
process.env["MODELS_DEV_API_JSON"] = modelsCachePath
// Disable models.dev refresh to avoid race conditions during tests
process.env["SYNERGY_DISABLE_MODELS_FETCH"] = "true"
// Disable plugins and LSP download to avoid hangs in CI
process.env["SYNERGY_DISABLE_DEFAULT_PLUGINS"] = "true"
process.env["SYNERGY_DISABLE_LSP_DOWNLOAD"] = "true"
// Disable file watcher to avoid native module / inotify hangs in CI
process.env["SYNERGY_DISABLE_FILEWATCHER"] = "true"
// Disable built-in remote MCP search servers (anysearch/scholight) so no
// test ever connects to external endpoints during config-driven MCP init.
process.env["SYNERGY_DISABLE_BUILTIN_MCP"] = "true"

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
