import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { buildPluginProject } from "../src/commands/build"
import { packPluginProject } from "../src/commands/pack"
import {
  copyRegistryEntryIcon,
  githubRepoSlug,
  normalizeRepoUrl,
  parseAuthor,
  readTarballManifest,
  registryEntry,
  renderReleaseUrlTemplate,
  resolveReleaseAssetUrls,
  uiSurfaces,
  writeRegistryEntry,
} from "../src/lib/market-entry"
import { sha256File } from "../src/lib/crypto"
import { createFixtureProject, minimalPluginSource, writeMinimalPlugin } from "./fixtures"

function manifestFor(project: { root: string }) {
  return PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(project.root, "dist", "plugin.json"), "utf8")))
}

function signFor(project: { root: string }, tarballPath: string) {
  const manifest = manifestFor(project)
  const signature = {
    signatureVersion: 1,
    pluginId: manifest.id,
    version: manifest.version,
    algorithm: "ed25519",
    signer: "a".repeat(64),
    signature: "b".repeat(128),
    signedAt: Date.now(),
    payload: {
      tarballHash: sha256File(tarballPath),
      manifestHash: computeManifestHash(manifest),
      permissionsHash: computePermissionsHash(manifest),
    },
  }
  fs.writeFileSync(`${tarballPath}.sig`, `${JSON.stringify(signature, null, 2)}\n`)
}

async function buildAndPack(project: { root: string }, id: string) {
  expect(await buildPluginProject(project.root)).toBe(true)
  const tarballPath = packPluginProject(project.root)
  signFor(project, tarballPath)
  return { tarballPath, manifest: manifestFor(project) }
}

describe("parseAuthor", () => {
  test("parses name, email, and url fields", () => {
    expect(parseAuthor(undefined)).toEqual({ name: "unknown" })
    expect(parseAuthor("Jane Doe")).toEqual({ name: "Jane Doe" })
    expect(parseAuthor("Jane Doe <jane@example.com>")).toEqual({ name: "Jane Doe", email: "jane@example.com" })
    expect(parseAuthor("Jane Doe (https://example.com)")).toEqual({
      name: "Jane Doe",
      url: "https://example.com",
    })
    expect(parseAuthor("Jane <jane@example.com> (https://example.com)")).toEqual({
      name: "Jane",
      email: "jane@example.com",
      url: "https://example.com",
    })
  })
})

describe("normalizeRepoUrl and githubRepoSlug", () => {
  test("normalizes GitHub URLs and passes through non-GitHub URLs", () => {
    expect(normalizeRepoUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo")
    expect(normalizeRepoUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo")
    expect(normalizeRepoUrl("https://gitlab.com/owner/repo")).toBe("https://gitlab.com/owner/repo")
    expect(normalizeRepoUrl(undefined)).toBeUndefined()
    expect(normalizeRepoUrl("  trimmed  ")).toBe("trimmed")
  })

  test("extracts GitHub slugs", () => {
    expect(githubRepoSlug("https://github.com/owner/repo.git")).toBe("owner/repo")
    expect(githubRepoSlug("https://gitlab.com/owner/repo")).toBeUndefined()
  })
})

describe("renderReleaseUrlTemplate", () => {
  test("renders repo, version, tag, and filename", () => {
    expect(
      renderReleaseUrlTemplate({
        template: "{repo}/releases/download/{tag}/{filename}",
        repo: "https://github.com/owner/repo/",
        version: "1.2.3",
        filename: "my plugin.tgz",
      }),
    ).toBe("https://github.com/owner/repo/releases/download/v1.2.3/my%20plugin.tgz")
  })

  test("supports custom tags", () => {
    expect(
      renderReleaseUrlTemplate({
        template: "{repo}/{tag}",
        repo: "https://github.com/owner/repo",
        version: "1.2.3",
        tag: "custom-tag",
        filename: "x.tgz",
      }),
    ).toBe("https://github.com/owner/repo/custom-tag")
  })
})

describe("resolveReleaseAssetUrls", () => {
  test("uses explicit URLs first", () => {
    expect(
      resolveReleaseAssetUrls({
        repo: "https://github.com/owner/repo",
        version: "1.2.3",
        filename: "x.tgz",
        downloadUrl: "https://explicit/download",
        signatureUrl: "https://explicit/sig",
      }),
    ).toEqual({ downloadUrl: "https://explicit/download", signatureUrl: "https://explicit/sig" })
  })

  test("derives signature URLs from download URLs", () => {
    expect(
      resolveReleaseAssetUrls({
        repo: "https://github.com/owner/repo",
        version: "1.2.3",
        filename: "x.tgz",
        downloadUrl: "https://explicit/download",
      }),
    ).toEqual({ downloadUrl: "https://explicit/download", signatureUrl: "https://explicit/download.sig" })
  })

  test("renders templates for the manual backend", () => {
    expect(
      resolveReleaseAssetUrls({
        backend: "manual",
        repo: "https://github.com/owner/repo",
        version: "1.2.3",
        filename: "x.tgz",
        releaseUrlTemplate: "https://cdn.example.com/{repo}/{version}/{filename}",
      }),
    ).toEqual({
      downloadUrl: "https://cdn.example.com/https://github.com/owner/repo/1.2.3/x.tgz",
      signatureUrl: "https://cdn.example.com/https://github.com/owner/repo/1.2.3/x.tgz.sig",
    })
  })

  test("rejects the manual backend without any URL source", () => {
    expect(() =>
      resolveReleaseAssetUrls({
        backend: "manual",
        repo: "https://github.com/owner/repo",
        version: "1",
        filename: "x",
      }),
    ).toThrow(/release asset URLs/)
  })

  test("builds GitHub URLs by default with custom tag templates", () => {
    expect(
      resolveReleaseAssetUrls({
        repo: "https://github.com/owner/repo",
        version: "1.2.3",
        filename: "x.tgz",
        releaseTagTemplate: "release-{version}",
      }),
    ).toEqual({
      downloadUrl: "https://github.com/owner/repo/releases/download/release-1.2.3/x.tgz",
      signatureUrl: "https://github.com/owner/repo/releases/download/release-1.2.3/x.tgz.sig",
    })
  })
})

describe("registryEntry", () => {
  test("builds a registry v2 entry for a signed tarball", async () => {
    const project = createFixtureProject("registry-entry-")
    try {
      writeMinimalPlugin(
        project,
        `import { definePlugin, tool, operation, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "registry-entry",
  version: "1.2.0",
  description: "Registry entry fixture",
  author: "Jane Doe <jane@example.com>",
  homepage: "https://example.com/registry-entry",
  repository: "https://github.com/owner/registry-entry",
  keywords: ["beta"],
  compatibility: { synergy: ">=3.1.0" },
  capabilities: [{ id: "shell.execute" }],
  contributions: [
    tool({ id: "echo", description: "Echo input", input: { type: "object" }, handler: async () => "ok" }),
    operation({ id: "query", type: "query", input: {}, output: {}, handler: async () => ({ ok: true }) }),
    workbenchPanel({
      id: "panel", label: "Panel", surface: "side", cardinality: "singleton",
      component: { source: "src/panel.tsx" },
    }),
  ],
})
`,
      )
      project.writeFile("src/panel.tsx", "export default function Panel() { return null }\n")
      const { tarballPath, manifest } = await buildAndPack(project, "registry-entry")

      const entry = registryEntry({
        tarballPath,
        repo: "https://github.com/owner/registry-entry",
        publishedAt: "2026-08-14T00:00:00.000Z",
        changelog: "initial",
      })
      expect(entry.schemaVersion).toBe(2)
      expect(entry.id).toBe("registry-entry")
      expect(entry.name).toBe("registry-entry")
      expect(entry.repo).toBe("https://github.com/owner/registry-entry")
      expect(entry.homepage).toBe("https://example.com/registry-entry")
      expect(entry.author).toEqual({ name: "Jane Doe", email: "jane@example.com" })
      expect(entry.keywords).toEqual(["beta", "synergy-plugin"])
      expect(entry.compatibility).toEqual({ synergy: ">=3.1.0" })
      expect(entry.verified).toBe(false)
      expect(entry.official).toBe(false)
      expect(entry.versions[0].apiVersion).toBe("4.0")
      expect(entry.versions[0].publishedAt).toBe("2026-08-14T00:00:00.000Z")
      expect(entry.versions[0].changelog).toBe("initial")
      expect(entry.versions[0].tools).toEqual(["echo"])
      expect(entry.versions[0].uiSurfaces).toEqual(["ui.workbenchPanel"])
      expect(entry.versions[0].runtimeMode).toBe("process")
      expect(entry.versions[0].permissionsSummary[0].key).toBe("shell.execute")
      expect(entry.yankedVersions).toEqual([])
      expect(entry.versions[0].manifestHash).toBe(computeManifestHash(manifest))
    } finally {
      project.cleanup()
    }
  })

  test("requires a valid signature", async () => {
    const project = createFixtureProject("registry-signature-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("registry-signature"))
      expect(await buildPluginProject(project.root)).toBe(true)
      const tarballPath = packPluginProject(project.root)

      expect(() => registryEntry({ tarballPath, repo: "https://github.com/owner/registry-signature" })).toThrow(
        /Signature file not found/,
      )

      fs.writeFileSync(`${tarballPath}.sig`, JSON.stringify({ signatureVersion: 1, algorithm: "rsa" }))
      expect(() => registryEntry({ tarballPath, repo: "https://github.com/owner/registry-signature" })).toThrow(
        /Signature file not found or invalid/,
      )
    } finally {
      project.cleanup()
    }
  })

  test("requires manifest.repository when --repo is omitted", async () => {
    const project = createFixtureProject("registry-repo-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("registry-repo"))
      const { tarballPath } = await buildAndPack(project, "registry-repo")
      expect(() => registryEntry({ tarballPath })).toThrow(/requires --repo or manifest.repository/)
    } finally {
      project.cleanup()
    }
  })

  test("rejects signature mismatches", async () => {
    const project = createFixtureProject("registry-mismatch-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("registry-mismatch"))
      const { tarballPath } = await buildAndPack(project, "registry-mismatch")
      const sigPath = `${tarballPath}.sig`
      const signature = JSON.parse(fs.readFileSync(sigPath, "utf8"))
      signature.pluginId = "someone-else"
      fs.writeFileSync(sigPath, JSON.stringify(signature))
      expect(() => registryEntry({ tarballPath, repo: "https://github.com/owner/registry-mismatch" })).toThrow(
        /Signature pluginId does not match/,
      )

      const restored = JSON.parse(fs.readFileSync(sigPath, "utf8"))
      restored.pluginId = "registry-mismatch"
      restored.payload.tarballHash = "0".repeat(64)
      fs.writeFileSync(sigPath, JSON.stringify(restored))
      expect(() => registryEntry({ tarballPath, repo: "https://github.com/owner/registry-mismatch" })).toThrow(
        /Signature tarball hash does not match/,
      )
    } finally {
      project.cleanup()
    }
  })
})

describe("writeRegistryEntry", () => {
  test("merges new versions into an existing entry", async () => {
    const project = createFixtureProject("registry-merge-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("registry-merge"))
      const { tarballPath } = await buildAndPack(project, "registry-merge")
      const entryPath = path.join(project.root, "plugins", "registry-merge.json")

      const first = registryEntry({
        tarballPath,
        repo: "https://github.com/owner/registry-merge",
        publishedAt: "2026-08-01T00:00:00.000Z",
      })
      fs.mkdirSync(path.dirname(entryPath), { recursive: true })
      fs.writeFileSync(entryPath, `${JSON.stringify({ ...first, verified: true, official: true }, null, 2)}\n`)

      const merged = writeRegistryEntry(entryPath, first)
      expect(merged.verified).toBe(true)
      expect(merged.official).toBe(true)
      expect(merged.versions).toHaveLength(1)
      expect(merged.versions[0].publishedAt).toBe("2026-08-01T00:00:00.000Z")
    } finally {
      project.cleanup()
    }
  })

  test("sorts versions by publishedAt and preserves yanked versions", () => {
    const project = createFixtureProject("registry-sort-")
    try {
      const entryPath = path.join(project.root, "plugins", "entry.json")
      writeRegistryEntry(entryPath, {
        schemaVersion: 2,
        id: "entry",
        name: "entry",
        description: "d",
        repo: "https://github.com/owner/entry",
        author: { name: "a" },
        verified: false,
        official: false,
        keywords: [],
        compatibility: { synergy: ">=3" },
        versions: [
          {
            version: "1.0.0",
            apiVersion: "4.0",
            compatibility: { synergy: ">=3" },
            downloadUrl: "u",
            signatureUrl: "s",
            signature: { algorithm: "ed25519", signer: "k" },
            integrity: "i",
            manifestHash: "m",
            permissionsHash: "p",
            runtimeMode: "process",
            featuresSummary: [],
            permissionsSummary: [],
            tools: [],
            uiSurfaces: [],
            publishedAt: "2026-08-02T00:00:00.000Z",
          },
        ],
        yankedVersions: ["0.9.0"],
      })
      const next = JSON.parse(fs.readFileSync(entryPath, "utf8"))
      writeRegistryEntry(entryPath, {
        ...next,
        versions: [
          {
            ...next.versions[0],
            version: "1.1.0",
            publishedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      })
      const merged = JSON.parse(fs.readFileSync(entryPath, "utf8"))
      expect(merged.versions.map((version: { version: string }) => version.version)).toEqual(["1.1.0", "1.0.0"])
      expect(merged.yankedVersions).toEqual(["0.9.0"])
    } finally {
      project.cleanup()
    }
  })
})

describe("readTarballManifest and uiSurfaces", () => {
  test("reads the manifest from a tarball and reports missing manifests", async () => {
    const project = createFixtureProject("read-manifest-")
    try {
      writeMinimalPlugin(project, minimalPluginSource("read-manifest"))
      expect(await buildPluginProject(project.root)).toBe(true)
      const tarballPath = packPluginProject(project.root)
      expect(readTarballManifest(tarballPath).id).toBe("read-manifest")

      const empty = path.join(project.root, "empty.tgz")
      const staging = path.join(project.root, "empty")
      fs.mkdirSync(staging)
      const packed = Bun.spawnSync(["tar", "-czf", empty, "-C", staging, "."])
      expect(packed.exitCode).toBe(0)
      expect(() => readTarballManifest(empty)).toThrow(/does not contain plugin.json/)
    } finally {
      project.cleanup()
    }
  })

  test("uiSurfaces collects unique ui contribution kinds", async () => {
    const project = projectWithUI()
    try {
      expect(await buildPluginProject(project.root)).toBe(true)
      const manifest = manifestFor(project)
      expect(uiSurfaces(manifest)).toEqual(["ui.workbenchPanel"])
    } finally {
      project.cleanup()
    }
  })
})

function projectWithUI() {
  const project = createFixtureProject("ui-surfaces-")
  writeMinimalPlugin(
    project,
    `import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "ui-surfaces",
  version: "1.0.0",
  description: "UI surfaces fixture",
  contributions: [
    workbenchPanel({
      id: "one", label: "One", surface: "side", cardinality: "singleton",
      component: { source: "src/panel.tsx" },
    }),
    workbenchPanel({
      id: "two", label: "Two", surface: "bottom", cardinality: "multi",
      component: { source: "src/panel.tsx" },
    }),
  ],
})
`,
  )
  project.writeFile("src/panel.tsx", "export default function Panel() { return null }\n")
  return project
}

describe("copyRegistryEntryIcon", () => {
  test("copies a packaged SVG icon next to the registry entry", async () => {
    const project = createFixtureProject("registry-icon-")
    try {
      writeMinimalPlugin(
        project,
        `import { definePlugin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "registry-icon",
  version: "1.0.0",
  description: "Icon fixture",
  icon: "icons/logo.svg",
  contributions: [],
})
`,
      )
      project.writeFile("icons/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')
      expect(await buildPluginProject(project.root)).toBe(true)
      const tarballPath = packPluginProject(project.root)
      signFor(project, tarballPath)
      const entryPath = path.join(project.root, "market", "plugins", "registry-icon.json")
      const entry = registryEntry({
        tarballPath,
        repo: "https://github.com/owner/registry-icon",
      })
      expect(entry.icon).toEqual({ type: "registry-svg", path: "icons/registry-icon.svg" })
      const copied = copyRegistryEntryIcon({ tarballPath, entryPath, entry })
      expect(copied).toBe(path.join(project.root, "market", "icons", "registry-icon.svg"))
      expect(fs.existsSync(copied ?? "")).toBe(true)
      expect(fs.readFileSync(copied ?? "", "utf8")).toContain("</svg>")
    } finally {
      project.cleanup()
    }
  })
})
