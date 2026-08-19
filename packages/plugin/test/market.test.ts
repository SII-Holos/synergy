import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PLUGIN_MARKETPLACE_CONFIG,
  OFFICIAL_GITHUB_PLUGIN_MARKETPLACE,
  OFFICIAL_PLUGIN_REGISTRY_URL,
  githubMarketplaceRegistryUrl,
  githubRawFileUrl,
  githubReleaseAssetUrl,
  githubReleaseTag,
  githubRepoSlug,
  normalizeGitHubRepoUrl,
} from "../src/market"

describe("githubMarketplaceRegistryUrl", () => {
  test("derives the official raw registry URL from the marketplace defaults", () => {
    expect(OFFICIAL_PLUGIN_REGISTRY_URL).toBe(
      "https://raw.githubusercontent.com/SII-Holos/synergy-plugins/main/registry.json",
    )
  })

  test("defaults carry the official marketplace configuration", () => {
    expect(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.registryUrl).toBe(OFFICIAL_PLUGIN_REGISTRY_URL)
    expect(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.enabled).toBe(true)
    expect(OFFICIAL_GITHUB_PLUGIN_MARKETPLACE.registryBranchPrefix).toBe("publish")
  })

  test("encodes branches and file paths", () => {
    expect(
      githubRawFileUrl({
        repo: "https://github.com/owner/repo",
        branch: "feature/branch name",
        filepath: "plugins/my plugin.json",
      }),
    ).toBe("https://raw.githubusercontent.com/owner/repo/feature/branch%20name/plugins/my%20plugin.json")
  })

  test("rejects non-GitHub registry repos", () => {
    expect(() =>
      githubMarketplaceRegistryUrl({
        ...OFFICIAL_GITHUB_PLUGIN_MARKETPLACE,
        registryRepo: "https://gitlab.com/team/registry.git",
      }),
    ).toThrow(/Invalid GitHub plugin marketplace repo/)
  })
})

describe("githubReleaseTag", () => {
  test("renders the default v-prefixed tag", () => {
    expect(githubReleaseTag("1.2.3")).toBe("v1.2.3")
  })

  test("supports custom templates with {version} and {tag}", () => {
    expect(githubReleaseTag("1.2.3", "release-{version}")).toBe("release-1.2.3")
    expect(githubReleaseTag("1.2.3", "{tag}")).toBe("v1.2.3")
  })
})

describe("normalizeGitHubRepoUrl", () => {
  test("normalizes SSH remotes", () => {
    expect(normalizeGitHubRepoUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo")
    expect(normalizeGitHubRepoUrl("git@github.com:owner/repo")).toBe("https://github.com/owner/repo")
  })

  test("normalizes HTTPS URLs and trims whitespace", () => {
    expect(normalizeGitHubRepoUrl(" https://github.com/owner/repo.git ")).toBe("https://github.com/owner/repo")
    expect(normalizeGitHubRepoUrl("https://github.com/owner/repo/tree/main")).toBe(
      "https://github.com/owner/repo/tree/main",
    )
  })

  test("rejects invalid inputs", () => {
    expect(normalizeGitHubRepoUrl(undefined)).toBeUndefined()
    expect(normalizeGitHubRepoUrl("")).toBeUndefined()
    expect(normalizeGitHubRepoUrl("owner/repo")).toBeUndefined()
    expect(normalizeGitHubRepoUrl("https://gitlab.com/owner/repo")).toBeUndefined()
  })
})

describe("githubRepoSlug", () => {
  test("extracts owner/repo from normalized and raw URLs", () => {
    expect(githubRepoSlug("https://github.com/owner/repo.git")).toBe("owner/repo")
    expect(githubRepoSlug("git@github.com:owner/repo.git")).toBe("owner/repo")
    expect(githubRepoSlug("https://github.com/owner/repo/tree/main")).toBe("owner/repo")
    expect(githubRepoSlug(undefined)).toBeUndefined()
    expect(githubRepoSlug("https://gitlab.com/owner/repo")).toBeUndefined()
  })
})

describe("githubReleaseAssetUrl", () => {
  test("builds release download URLs", () => {
    expect(
      githubReleaseAssetUrl({
        repo: "https://github.com/owner/repo.git",
        version: "1.2.3",
        filename: "plugin-1.2.3.synergy-plugin.tgz",
      }),
    ).toBe("https://github.com/owner/repo/releases/download/v1.2.3/plugin-1.2.3.synergy-plugin.tgz")
  })

  test("applies tag templates and percent-encodes the filename", () => {
    expect(
      githubReleaseAssetUrl({
        repo: "git@github.com:owner/repo.git",
        version: "1.2.3",
        filename: "my plugin.tgz",
        tagTemplate: "release-{version}",
      }),
    ).toBe("https://github.com/owner/repo/releases/download/release-1.2.3/my%20plugin.tgz")
  })

  test("returns undefined when the repo cannot be normalized", () => {
    expect(
      githubReleaseAssetUrl({ repo: "gitlab.com/owner/repo", version: "1.0.0", filename: "x.tgz" }),
    ).toBeUndefined()
    expect(githubReleaseAssetUrl({ repo: undefined, version: "1.0.0", filename: "x.tgz" })).toBeUndefined()
  })
})
