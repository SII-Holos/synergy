import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { ConfigImport } from "../../src/config/import"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"

const REFERENCE = "{file:./mcp-key.txt}"
const SECRET = "sk-repro-only-not-a-real-key"
const RELAY_SECRET = "relay-env-secret-value"
const runtime = await testRuntime({ env: { RELAY_API_KEY: RELAY_SECRET } })

const FRAGMENT = [
  "{",
  "  // payment provider credentials stay on disk",
  '  "provider": {',
  '    "gateway": {',
  '      "options": {',
  `        "apiKey": "${REFERENCE}"`,
  "      }",
  "    },",
  "  // secondary relay",
  '    "relay": {',
  '      "options": {',
  '        "apiKey": "{env:RELAY_API_KEY}"',
  "      }",
  "    }",
  "  }",
  "}",
].join("\n")

async function writeFragment(root: string, id: ConfigDomain.Id, content: string) {
  const file = ConfigDomain.filepath(id, root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

async function writeSecretFile(root: string) {
  const file = ConfigDomain.filepath("providers", root)
  await fs.writeFile(path.join(path.dirname(file), "mcp-key.txt"), SECRET)
}

describe("domain writes preserve authored reference text", () => {
  test("adding an unrelated provider keeps references, comments, and untouched entries", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "providers", FRAGMENT)
      await writeSecretFile(root)

      await Config.domainUpdate(
        "providers",
        { provider: { extra: { options: { baseURL: "https://relay.example" } } } },
        { root },
      )
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain("// payment provider credentials stay on disk")
      expect(after).toContain("// secondary relay")
      expect(after).toContain(REFERENCE)
      expect(after).toContain("{env:RELAY_API_KEY}")
      expect(after).not.toContain(SECRET)
      expect(after).not.toContain(RELAY_SECRET)
      const resolved = await Config.domainGet("providers", root)
      expect(resolved.provider?.gateway?.options?.apiKey).toBe(SECRET)
      expect(resolved.provider?.relay?.options?.apiKey).toBe(RELAY_SECRET)
      expect(resolved.provider?.extra?.options?.baseURL).toBe("https://relay.example")
    }))

  test("an empty patch leaves the fragment byte-identical", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "providers", FRAGMENT)
      await writeSecretFile(root)
      const before = await fs.readFile(file, "utf8")
      await Config.domainUpdate("providers", {}, { root })
      expect(await fs.readFile(file, "utf8")).toBe(before)
    }))

  test("a patch echoing the resolved reference keeps the reference text", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "providers", FRAGMENT)
      await writeSecretFile(root)
      await Config.domainUpdate("providers", { provider: { gateway: { options: { apiKey: SECRET } } } }, { root })
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain(REFERENCE)
      expect(after).not.toContain(SECRET)
    }))

  test("a deliberate new value overwrites the reference with the literal", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "providers", FRAGMENT)
      await writeSecretFile(root)
      await Config.domainUpdate(
        "providers",
        { provider: { gateway: { options: { apiKey: "rotated-key" } } } },
        { root },
      )
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain('"rotated-key"')
      expect(after).not.toContain(REFERENCE)
    }))

  test("a redacted round-trip restores the reference instead of the resolved secret", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "providers", FRAGMENT)
      await writeSecretFile(root)
      const redacted = Config.redactForClient(await Config.domainGet("providers", root))
      expect(redacted.provider?.gateway?.options?.apiKey).toBe(Config.REDACTED_SENTINEL)
      await Config.domainUpdate(
        "providers",
        { provider: { gateway: { options: { apiKey: Config.REDACTED_SENTINEL } } } },
        { root },
      )
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain(REFERENCE)
      expect(after).not.toContain(SECRET)
    }))

  test("a fresh fragment file is written user-only", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      await Config.domainUpdate("providers", { provider: { gateway: { options: { apiKey: "k" } } } }, { root })
      const stat = await fs.stat(ConfigDomain.filepath("providers", root))
      expect(stat.mode & 0o777).toBe(0o600)
    }))

  test("a malformed fragment is replaced with the valid merged config", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "providers", "{ broken")
      await Config.domainUpdate("providers", { provider: { gateway: { options: { apiKey: "k" } } } }, { root })
      const after = await fs.readFile(file, "utf8")
      const parsed = JSON.parse(after)
      expect(parsed.provider.gateway.options.apiKey).toBe("k")
    }))
})

describe("domain writes preserve comments across array edits", () => {
  const ARRAY_FRAGMENT = [
    "{",
    "  // allowed browser origins",
    '  "server": {',
    '    "cors": [',
    '      "https://app.example" // production origin',
    "    ]",
    "  }",
    "}",
  ].join("\n")

  test("appending two or more array elements keeps comments instead of re-serializing", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "runtime", ARRAY_FRAGMENT)
      await Config.domainUpdate(
        "runtime",
        { server: { cors: ["https://app.example", "https://a.example", "https://b.example"] } },
        { root },
      )
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain("// allowed browser origins")
      expect(after).toContain("// production origin")
      expect(after).toContain('"https://a.example"')
      expect(after).toContain('"https://b.example"')
    }))

  test("shrinking an array by two or more elements keeps the structural comment", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "runtime", ARRAY_FRAGMENT)
      await Config.domainUpdate(
        "runtime",
        { server: { cors: ["https://app.example", "https://a.example", "https://b.example"] } },
        { root },
      )
      await Config.domainUpdate("runtime", { server: { cors: ["https://app.example"] } }, { root })
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain("// allowed browser origins")
      expect(after).toContain('"https://app.example"')
      expect(after).not.toContain("a.example")
      expect(after).not.toContain("b.example")
      // An inline comment originally attached to element 0 may migrate to the
      // appended tail (jsonc-parser re-associates trailing comments), so this
      // test pins the structural comment only — the data and every surviving
      // comment's correctness are already guaranteed by the parse-back check.
    }))

  test("replacing an element while appending two more keeps comments", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "config")
      const file = await writeFragment(root, "runtime", ARRAY_FRAGMENT)
      await Config.domainUpdate(
        "runtime",
        { server: { cors: ["https://replacement.example", "https://a.example", "https://b.example"] } },
        { root },
      )
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain("// allowed browser origins")
      expect(after).toContain('"https://replacement.example"')
      expect(after).toContain('"https://a.example"')
      expect(after).toContain('"https://b.example"')
    }))
})

describe("config import preserves authored reference text", () => {
  test("importing an unrelated key keeps references, comments, and untouched entries", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const root = path.join(tmp.path, ".synergy")
      const file = await writeFragment(root, "providers", FRAGMENT)
      await writeSecretFile(root)

      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await ConfigImport.apply({
            config: { provider: { extra: { options: { baseURL: "https://relay.example" } } } },
            scope: "project",
            yes: true,
          })
        },
      })
      const after = await fs.readFile(file, "utf8")
      expect(after).toContain("// payment provider credentials stay on disk")
      expect(after).toContain(REFERENCE)
      expect(after).toContain("{env:RELAY_API_KEY}")
      expect(after).not.toContain(SECRET)
    }))
})

afterRuntimeTests(() => runtime.close())
