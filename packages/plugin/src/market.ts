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
}

export function githubReleaseAssetUrl(input: GitHubReleaseAssetUrlInput): string | undefined {
  const normalized = normalizeGitHubRepoUrl(input.repo)
  if (!normalized) return undefined
  return `${normalized}/releases/download/v${input.version}/${encodeURIComponent(input.filename)}`
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
