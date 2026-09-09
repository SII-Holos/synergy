import { randomUUID } from "crypto"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { Filesystem } from "../util/filesystem"
import { assertIsolatedTestHome } from "./test-home-guard"

const app = "synergy"

function homeDir() {
  return Filesystem.sanitizePath(process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME || os.homedir())
}

function root() {
  return path.join(homeDir(), "." + app)
}

// Test processes must never resolve the Synergy home into a real instance:
// Bun does not propagate test/preload.ts environment into --parallel workers,
// so an unguarded run writes fixtures into ~/.synergy/data. The guard requires
// the SYNERGY_TEST_HOME isolation marker and blocks real-home roots; it is pure
// (no filesystem side effects) and throws before any directory creation below.
assertIsolatedTestHome(root(), Bun.main, process.argv, process.env)

export namespace Global {
  export const Path = {
    get home() {
      return homeDir()
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

    get libraryDB() {
      return path.join(root(), "data", "library.db")
    },
    get auth() {
      return path.join(root(), "data", "auth")
    },
    get authApiKey() {
      return path.join(root(), "data", "auth", "api-key.json")
    },
    get authProvider() {
      return path.join(root(), "data", "auth", "provider-auth.json")
    },
    get authHolosAccounts() {
      return path.join(root(), "data", "auth", "holos-accounts.json")
    },
    get authMcp() {
      return path.join(root(), "data", "auth", "mcp.json")
    },
    get authInspire() {
      return path.join(root(), "data", "auth", "inspire.json")
    },
    get authHarbor() {
      return path.join(root(), "data", "auth", "harbor.json")
    },
    get cacheInspireToken() {
      return path.join(root(), "cache", "inspire-token.json")
    },
    get cacheInspireResources() {
      return path.join(root(), "cache", "inspire-resources.json")
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
    get libraryDebug() {
      return path.join(root(), "data", "library")
    },
    get embeddingModels() {
      return path.join(root(), "data", "embedding", "models")
    },
    get lspPids() {
      return path.join(root(), "state", "lsp-pids.json")
    },
    get modelsCache() {
      return path.join(root(), "cache", "models.json")
    },
    get providerModelCatalogCache() {
      return path.join(root(), "cache", "provider-model-catalogs.v1.json")
    },
    get schema() {
      return path.join(root(), "schema")
    },
    get configSchema() {
      return path.join(root(), "schema", "config.schema.json")
    },
    get configSchemaUrl() {
      return pathToFileURL(path.join(root(), "schema", "config.schema.json")).href
    },
  }

  export async function initialize(options: { cache?: boolean; configSchemaPath?: string } = {}) {
    await Promise.all([
      fs.mkdir(Global.Path.root, { recursive: true }),
      fs.mkdir(Global.Path.data, { recursive: true }),
      fs.mkdir(Global.Path.auth, { recursive: true }),
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
      const bundled = options.configSchemaPath
      if (bundled) {
        // Identical-content boots skip the lock entirely; competing publishers
        // serialize under the schema lock and publish through a same-volume
        // rename so readers never observe a partial schema file.
        const bundledContents = await fs.readFile(bundled, "utf8")
        const current = await fs.readFile(Global.Path.configSchema, "utf8").catch(() => undefined)
        if (current !== bundledContents) {
          await withFileLock({ directory: path.join(Global.Path.schema, ".locks"), key: "config-schema" }, async () => {
            const published = await fs.readFile(Global.Path.configSchema, "utf8").catch(() => undefined)
            if (published === bundledContents) return
            const temporaryPath = `${Global.Path.configSchema}.${randomUUID()}.tmp`
            try {
              await fs.copyFile(bundled, temporaryPath)
              await fs.rename(temporaryPath, Global.Path.configSchema)
            } finally {
              await fs.rm(temporaryPath, { force: true }).catch(() => {})
            }
          })
        }
      }
    }

    if (options.cache === false) return
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
  }
}
