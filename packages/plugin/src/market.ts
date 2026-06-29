export interface GitHubPluginMarketplaceDefaults {
  registryRepo: string
  registryGithubRepo: string
  registryBaseBranch: string
  registryBranchPrefix: string
}

export const OFFICIAL_GITHUB_PLUGIN_MARKETPLACE: GitHubPluginMarketplaceDefaults = {
  registryRepo: "https://github.com/SII-Holos/synergy-plugins.git",
  registryGithubRepo: "SII-Holos/synergy-plugins",
  registryBaseBranch: "main",
  registryBranchPrefix: "publish",
}

export interface GitHubReleaseAssetUrlInput {
  repo: string | undefined
  version: string
  filename: string
  tagTemplate?: string
}

function encodeGitHubPath(value: string): string {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/")
}

export function githubReleaseAssetUrl(input: GitHubReleaseAssetUrlInput): string | undefined {
  const normalized = normalizeGitHubRepoUrl(input.repo)
  if (!normalized) return undefined
  return `${normalized}/releases/download/${encodeURIComponent(githubReleaseTag(input.version, input.tagTemplate))}/${encodeURIComponent(input.filename)}`
}

export function githubReleaseTag(version: string, template = "v{version}"): string {
  return template.replaceAll("{version}", version).replaceAll("{tag}", `v${version}`)
}

export function normalizeGitHubRepoUrl(input?: string): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (ssh) return `https://github.com/${ssh[1]}`
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(trimmed)) return trimmed.replace(/\.git$/, "")
  return undefined
}

export function githubRepoSlug(input?: string): string | undefined {
  const normalized = normalizeGitHubRepoUrl(input)
  const match = normalized?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/.*)?$/)
  return match?.[1]?.replace(/\.git$/, "")
}

export function githubRawFileUrl(input: { repo?: string; branch: string; filepath: string }): string | undefined {
  const slug = githubRepoSlug(input.repo)
  if (!slug) return undefined
  return `https://raw.githubusercontent.com/${slug}/${encodeGitHubPath(input.branch)}/${encodeGitHubPath(input.filepath)}`
}

export function githubMarketplaceRegistryUrl(
  input: GitHubPluginMarketplaceDefaults = OFFICIAL_GITHUB_PLUGIN_MARKETPLACE,
): string {
  const url = githubRawFileUrl({
    repo: input.registryRepo,
    branch: input.registryBaseBranch,
    filepath: "registry.json",
  })
  if (!url) throw new Error(`Invalid GitHub plugin marketplace repo: ${input.registryRepo}`)
  return url
}

export const OFFICIAL_PLUGIN_REGISTRY_URL = githubMarketplaceRegistryUrl()

export const DEFAULT_PLUGIN_MARKETPLACE_CONFIG = {
  enabled: true,
  registryUrl: OFFICIAL_PLUGIN_REGISTRY_URL,
  includeLocalRegistry: true,
  cacheTtlMs: 300_000,
  offlineCache: true,
  requestTimeoutMs: 10_000,
  artifactDownloadTimeoutMs: 60_000,
  cliRequestTimeoutMs: 120_000,
} as const
