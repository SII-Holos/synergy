import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import os from "os"

const app = "synergy"

function root() {
  return path.join(process.env.SYNERGY_TEST_HOME || os.homedir(), "." + app)
}

export namespace Global {
  export const Path = {
    get home() {
      return process.env.SYNERGY_TEST_HOME || os.homedir()
    },
    get root() {
      return root()
    },

    get data() {
      return path.join(root(), "data")
    },
    get bin() {
      return path.join(root(), "bin")
    },
    get log() {
      return path.join(root(), "log")
    },
    get cache() {
      return path.join(root(), "cache")
    },
    get config() {
      return path.join(root(), "config")
    },
    get state() {
      return path.join(root(), "state")
    },

    get engramDB() {
      return path.join(root(), "data", "engram.db")
    },
    get authApiKey() {
      return path.join(root(), "data", "auth", "api-key.json")
    },
    get authMcp() {
      return path.join(root(), "data", "auth", "mcp.json")
    },
    get snapshot() {
      return path.join(root(), "data", "snapshot")
    },
    get worktree() {
      return path.join(root(), "data", "worktree")
    },
    get toolOutput() {
      return path.join(root(), "data", "tool-output")
    },
    get assets() {
      return path.join(root(), "data", "assets")
    },
    get media() {
      return path.join(root(), "data", "media")
    },
    get engramDebug() {
      return path.join(root(), "data", "engram")
    },
    get lspPids() {
      return path.join(root(), "state", "lsp-pids.json")
    },
    get modelsCache() {
      return path.join(root(), "cache", "models.json")
    },
    get schema() {
      return path.join(root(), "schema")
    },
    get configSchema() {
      return path.join(root(), "schema", "config.schema.json")
    },
    get configSchemaUrl() {
      return "file://" + path.join(root(), "schema", "config.schema.json")
    },
  }
}

await Promise.all([
  fs.mkdir(Global.Path.root, { recursive: true }),
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
  fs.mkdir(Global.Path.assets, { recursive: true }),
  fs.mkdir(Global.Path.media, { recursive: true }),
  fs.mkdir(Global.Path.schema, { recursive: true }),
])

// Copy bundled config schema to ~/.synergy/schema/ so editors can resolve file:// $schema URLs.
// Checked on every startup to keep the schema in sync with the installed synergy version.
{
  const bundled = (() => {
    const execDir = path.dirname(fsSync.realpathSync(process.execPath))
    const candidates = [
      path.resolve(execDir, "../schema/config.schema.json"),
      path.resolve(execDir, "../../schema/config.schema.json"),
      path.resolve(import.meta.dirname, "../../schema/config.schema.json"),
    ]
    return candidates.find((candidate) => fsSync.existsSync(candidate))
  })()
  if (bundled) {
    await fs.copyFile(bundled, Global.Path.configSchema)
  }
}

const CACHE_VERSION = "15"

const version = await Bun.file(path.join(Global.Path.cache, "version"))
  .text()
  .catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Global.Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Global.Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Bun.file(path.join(Global.Path.cache, "version")).write(CACHE_VERSION)
}
