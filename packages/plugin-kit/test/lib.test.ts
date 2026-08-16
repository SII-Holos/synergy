import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  hashPackagedFiles,
  isManifestIconPath,
  normalizeManifestPath,
  packageRelativePath,
  resolveUnder,
} from "../src/lib/artifact-assets"
import { sha256File, sha256Hex, sha256JSON, sha256Content, sortKeys } from "../src/lib/crypto"
import { resolveDefinitionEntry, resolveDefinitionLoaderPath } from "../src/lib/definition"
import { readSignatureFile } from "../src/lib/signature"
import { extractTarballText } from "../src/lib/tarball"
import { SIGNING_KEY_FILE, SIGNING_KEYS_DIR, SYNERGY_HOME, SYNERGY_ROOT } from "../src/lib/paths"
import { createFixtureProject, tarDirectory } from "./fixtures"

describe("crypto utilities", () => {
  test("sha256Hex hashes bytes", () => {
    expect(sha256Hex(new Uint8Array(Buffer.from("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  test("sha256Content and sha256File agree on the same bytes", () => {
    const project = createFixtureProject("crypto-")
    try {
      const file = path.join(project.root, "payload.txt")
      fs.writeFileSync(file, "payload")
      expect(sha256File(file)).toBe(sha256Content("payload"))
    } finally {
      project.cleanup()
    }
  })

  test("sha256JSON is stable under key reordering", () => {
    expect(sha256JSON({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(sha256JSON({ a: [2, { c: 3, d: 4 }], b: 1 }))
    expect(sha256JSON({ a: 1 })).not.toBe(sha256JSON({ a: 2 }))
  })

  test("sortKeys sorts objects recursively and preserves arrays", () => {
    expect(sortKeys({ b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] })).toEqual({
      a: { c: 3, d: 2 },
      b: 1,
      list: [3, 1, 2],
    })
    expect(sortKeys("primitive")).toBe("primitive")
    expect(sortKeys(null)).toBeNull()
  })
})

describe("artifact asset paths", () => {
  test("normalizeManifestPath normalizes relative paths", () => {
    expect(normalizeManifestPath("./themes/./default.json")).toBe("themes/default.json")
    expect(normalizeManifestPath("icons\\logo.svg")).toBe("icons/logo.svg")
  })

  test("normalizeManifestPath rejects absolute and escaping paths", () => {
    expect(() => normalizeManifestPath("/etc/passwd")).toThrow(/must be relative/)
    expect(() => normalizeManifestPath("../secret")).toThrow(/must be relative/)
    expect(() => normalizeManifestPath("")).toThrow(/must be relative/)
  })

  test("packageRelativePath strips the dist prefix", () => {
    expect(packageRelativePath("dist/icons/logo.svg")).toBe("icons/logo.svg")
    expect(packageRelativePath("icons/logo.svg")).toBe("icons/logo.svg")
  })

  test("isManifestIconPath accepts local SVGs and rejects URLs and other files", () => {
    expect(isManifestIconPath("icons/logo.svg")).toBe(true)
    expect(isManifestIconPath("https://example.com/logo.svg")).toBe(false)
    expect(isManifestIconPath("data:image/svg+xml;base64,xx")).toBe(false)
    expect(isManifestIconPath("icons/logo.png")).toBe(false)
    expect(isManifestIconPath(undefined)).toBe(false)
    expect(isManifestIconPath("../escape.svg")).toBe(false)
  })

  test("resolveUnder rejects paths escaping the root", () => {
    const project = createFixtureProject("resolve-")
    try {
      expect(resolveUnder(project.root, "file.txt")).toBe(path.join(project.root, "file.txt"))
      expect(() => resolveUnder(project.root, "../outside.txt")).toThrow(/must be relative/)
    } finally {
      project.cleanup()
    }
  })

  test("hashPackagedFiles hashes every packaged file and skips the integrity file", () => {
    const project = createFixtureProject("hash-files-")
    try {
      project.writeFile("runtime/index.js", "console.log(1)")
      project.writeFile("plugin.json", "{}")
      project.writeFile("integrity.json", "{}")
      const hashes = hashPackagedFiles(project.root)
      expect(Object.keys(hashes).sort()).toEqual(["plugin.json", "runtime/index.js"])
      expect(hashes["runtime/index.js"]).toBe(sha256File(path.join(project.root, "runtime", "index.js")))
    } finally {
      project.cleanup()
    }
  })
})

describe("signature files", () => {
  test("returns null for missing or malformed signature files", () => {
    const project = createFixtureProject("signature-")
    try {
      const tarball = path.join(project.root, "x.tgz")
      expect(readSignatureFile(tarball)).toBeNull()
      fs.writeFileSync(`${tarball}.sig`, "{not json")
      expect(readSignatureFile(tarball)).toBeNull()
      fs.writeFileSync(`${tarball}.sig`, JSON.stringify({ signatureVersion: 2 }))
      expect(readSignatureFile(tarball)).toBeNull()
      fs.writeFileSync(`${tarball}.sig`, JSON.stringify({ signatureVersion: 1, algorithm: "rsa" }))
      expect(readSignatureFile(tarball)).toBeNull()
    } finally {
      project.cleanup()
    }
  })

  test("returns parsed ed25519 signatures", () => {
    const project = createFixtureProject("signature-")
    try {
      const tarball = path.join(project.root, "x.tgz")
      const signature = {
        signatureVersion: 1,
        pluginId: "p",
        version: "1.0.0",
        algorithm: "ed25519",
        signer: "a".repeat(64),
        signature: "b".repeat(128),
        signedAt: 1,
        payload: { tarballHash: "t", manifestHash: "m", permissionsHash: "p" },
      }
      fs.writeFileSync(`${tarball}.sig`, JSON.stringify(signature))
      expect(readSignatureFile(tarball)).toEqual(signature)
    } finally {
      project.cleanup()
    }
  })
})

describe("tarball text extraction", () => {
  test("extracts packaged members with and without ./ prefix", () => {
    const project = createFixtureProject("tarball-")
    try {
      const payload = path.join(project.root, "payload")
      fs.mkdirSync(path.join(payload, "nested"), { recursive: true })
      fs.writeFileSync(path.join(payload, "plugin.json"), '{"id":"p"}')
      fs.writeFileSync(path.join(payload, "nested", "file.txt"), "nested content")
      const tarball = path.join(project.root, "archive.tgz")
      expect(tarDirectory(payload, tarball)).toBe(true)

      expect(extractTarballText(tarball, "plugin.json")).toBe('{"id":"p"}')
      expect(extractTarballText(tarball, "./nested/file.txt")).toBe("nested content")
      expect(extractTarballText(tarball, "missing.txt")).toBeNull()
      expect(extractTarballText(path.join(project.root, "missing.tgz"), "plugin.json")).toBeNull()
    } finally {
      project.cleanup()
    }
  })
})

describe("synergy path constants", () => {
  test("export the resolved signing key locations", () => {
    expect(SIGNING_KEY_FILE).toContain("signing-key.json")
    expect(SIGNING_KEYS_DIR).toContain("keys")
    expect(SYNERGY_ROOT).toBe(path.join(SYNERGY_HOME, ".synergy"))
  })
})

describe("plugin definition entry resolution", () => {
  test("prefers package.json source, then exports, then main", () => {
    const project = createFixtureProject("definition-entry-")
    try {
      project.writeFile("src/source.ts", "export default {}")
      project.writeFile("src/export.ts", "export default {}")
      project.writeFile("src/main.ts", "export default {}")
      project.writeFile("package.json", JSON.stringify({ source: "./src/source.ts" }))
      expect(resolveDefinitionEntry(project.root)).toBe(path.join(project.root, "src", "source.ts"))

      project.writeFile("package.json", JSON.stringify({ exports: "./src/export.ts" }))
      expect(resolveDefinitionEntry(project.root)).toBe(path.join(project.root, "src", "export.ts"))

      project.writeFile("package.json", JSON.stringify({ exports: { ".": { bun: "./src/source.ts" } } }))
      expect(resolveDefinitionEntry(project.root)).toBe(path.join(project.root, "src", "source.ts"))

      project.writeFile("package.json", JSON.stringify({ exports: { ".": { import: "./src/main.ts" } } }))
      expect(resolveDefinitionEntry(project.root)).toBe(path.join(project.root, "src", "main.ts"))

      project.writeFile("package.json", JSON.stringify({ main: "./src/main.ts" }))
      expect(resolveDefinitionEntry(project.root)).toBe(path.join(project.root, "src", "main.ts"))
    } finally {
      project.cleanup()
    }
  })

  test("falls back to conventional entry points and reports missing entries", () => {
    const project = createFixtureProject("definition-entry-")
    try {
      project.writeFile("index.ts", "export default {}")
      expect(resolveDefinitionEntry(project.root)).toBe(path.join(project.root, "index.ts"))

      fs.rmSync(path.join(project.root, "index.ts"))
      expect(() => resolveDefinitionEntry(project.root)).toThrow(/definition entry not found/)
    } finally {
      project.cleanup()
    }
  })

  test("resolves the compiled loader first and falls back to TypeScript", () => {
    expect(resolveDefinitionLoaderPath(import.meta.url, (candidate) => candidate.endsWith(".js"))).toContain(
      "definition-loader-child.js",
    )
    expect(resolveDefinitionLoaderPath(import.meta.url, () => false)).toContain("definition-loader-child.ts")
  })
})
