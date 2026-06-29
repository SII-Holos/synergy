import { $ } from "bun"
import fs from "fs"
import path from "path"
import type { Argv } from "yargs"
import { OFFICIAL_GITHUB_PLUGIN_MARKETPLACE } from "@ericsanchezok/synergy-plugin/market"
import { cmd } from "../cmd"
import { UI } from "../ui"
import { SYNERGY_ROOT } from "../lib/paths"
import { buildPluginProject } from "./build"
import { packPluginProject } from "./pack"
import { signPluginTarball } from "./sign"
import { validatePluginProject } from "./validate"
import {
  copyGithubEntryIcon,
  githubEntry,
  githubRepoSlug,
  normalizeRepoUrl,
  releaseAssetUrl,
  readTarballManifest,
  writeGithubEntry,
} from "../lib/market-entry"

function defaultRegistryRepo(): string {
  return process.env.SYNERGY_PLUGIN_MARKET_REGISTRY_REPO ?? OFFICIAL_GITHUB_PLUGIN_MARKETPLACE.registryRepo
}

function defaultRegistryGithubRepo(registryRepo: string): string {
  return (
    process.env.SYNERGY_PLUGIN_MARKET_GITHUB_REPO ??
    githubRepoSlug(registryRepo) ??
    OFFICIAL_GITHUB_PLUGIN_MARKETPLACE.registryGithubRepo
  )
}

function defaultRegistryBaseBranch(): string {
  return process.env.SYNERGY_PLUGIN_MARKET_BASE_BRANCH ?? OFFICIAL_GITHUB_PLUGIN_MARKETPLACE.registryBaseBranch
}

function defaultRegistryBranchPrefix(): string {
  return process.env.SYNERGY_PLUGIN_MARKET_BRANCH_PREFIX ?? OFFICIAL_GITHUB_PLUGIN_MARKETPLACE.registryBranchPrefix
}

function defaultReleaseBackend(): "github" | "manual" {
  const raw = process.env.SYNERGY_PLUGIN_MARKET_RELEASE_BACKEND?.trim()
  return raw === "manual" ? "manual" : "github"
}

async function commandExists(name: string): Promise<boolean> {
  const result = await $`which ${name}`.quiet().nothrow()
  return result.exitCode === 0
}

async function ghReady(): Promise<boolean> {
  if (!(await commandExists("gh"))) return false
  const result = await $`gh auth status`.quiet().nothrow()
  return result.exitCode === 0
}

async function currentRepoUrl(cwd: string): Promise<string | undefined> {
  const result = await $`git remote get-url origin`.cwd(cwd).quiet().nothrow()
  if (result.exitCode !== 0) return undefined
  return normalizeRepoUrl(result.text().trim())
}

function defaultRegistryDir(): string {
  if (process.env.SYNERGY_PLUGIN_MARKET_REGISTRY_DIR) return process.env.SYNERGY_PLUGIN_MARKET_REGISTRY_DIR
  return path.join(SYNERGY_ROOT, "cache", "plugin-market", "registry-checkout")
}

function safeArtifactName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "-")
}

function readTarballPackageName(tarballPath: string): string | undefined {
  const result = Bun.spawnSync(["tar", "-xOf", tarballPath, "package.json"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) return undefined
  const pkg = JSON.parse(new TextDecoder().decode(result.stdout)) as { name?: unknown }
  return typeof pkg.name === "string" ? pkg.name : undefined
}

function assertMarketplaceNaming(input: { tarballPath: string; manifest: { name: string; version: string } }) {
  const packageName = readTarballPackageName(input.tarballPath)
  if (!packageName) {
    throw new Error(
      "Marketplace publishing requires package.json inside the plugin tarball. Run `synergy-plugin build` and `synergy-plugin pack`.",
    )
  }
  if (packageName !== input.manifest.name) {
    throw new Error(
      `Marketplace publishing requires package.json name "${packageName}" to match plugin.json name "${input.manifest.name}".`,
    )
  }

  const expectedArtifact = `${safeArtifactName(input.manifest.name)}-${input.manifest.version}.synergy-plugin.tgz`
  if (path.basename(input.tarballPath) !== expectedArtifact) {
    throw new Error(
      `Marketplace publishing requires artifact name "${expectedArtifact}", got "${path.basename(input.tarballPath)}".`,
    )
  }
}

function renderReleaseUrlTemplate(input: {
  template: string
  repo: string
  version: string
  filename: string
}): string {
  const tag = `v${input.version}`
  return input.template
    .replaceAll("{repo}", input.repo.replace(/\/+$/, ""))
    .replaceAll("{version}", input.version)
    .replaceAll("{tag}", tag)
    .replaceAll("{filename}", encodeURIComponent(input.filename))
}

function resolveReleaseAssetUrls(input: {
  backend: "github" | "manual"
  repo: string
  version: string
  filename: string
  downloadUrl?: string
  signatureUrl?: string
  urlTemplate?: string
}): { downloadUrl: string; signatureUrl: string } {
  const downloadUrl =
    input.downloadUrl ??
    (input.urlTemplate
      ? renderReleaseUrlTemplate({
          template: input.urlTemplate,
          repo: input.repo,
          version: input.version,
          filename: input.filename,
        })
      : input.backend === "github"
        ? releaseAssetUrl(input.repo, input.version, input.filename)
        : undefined)
  const signatureUrl = input.signatureUrl ?? (downloadUrl ? `${downloadUrl}.sig` : undefined)
  if (!downloadUrl || !signatureUrl) {
    throw new Error(
      "Marketplace publishing requires release asset URLs. Use GitHub backend, --release-url-template, or explicit --download-url and --signature-url.",
    )
  }
  return { downloadUrl, signatureUrl }
}

async function ensureRegistryCheckout(registryDir: string, registryRepo: string) {
  if (fs.existsSync(path.join(registryDir, ".git"))) return
  fs.mkdirSync(path.dirname(registryDir), { recursive: true })
  UI.println(`Cloning plugin registry to ${registryDir}`)
  const result = await $`git clone ${registryRepo} ${registryDir}`.nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`Failed to clone ${registryRepo}. Clone it manually or pass --registry-dir.`)
  }
}

async function ensureGitHubReleaseAssets(input: {
  repo: string
  version: string
  tarballPath: string
  signaturePath: string
  skipUpload: boolean
}) {
  if (input.skipUpload) return
  if (!(await ghReady())) {
    UI.println(
      `${UI.Style.TEXT_WARNING}gh is not authenticated; skipping GitHub Release upload.${UI.Style.TEXT_NORMAL}`,
    )
    return
  }
  const repoSlug = githubRepoSlug(input.repo)
  if (!repoSlug) {
    UI.println(
      `${UI.Style.TEXT_WARNING}Could not derive GitHub owner/repo from ${input.repo}; skipping release upload.${UI.Style.TEXT_NORMAL}`,
    )
    return
  }

  const tag = `v${input.version}`
  const view = await $`gh release view ${tag} --repo ${repoSlug}`.quiet().nothrow()
  if (view.exitCode === 0) {
    await $`gh release upload ${tag} ${input.tarballPath} ${input.signaturePath} --repo ${repoSlug} --clobber`
    return
  }

  await $`gh release create ${tag} ${input.tarballPath} ${input.signaturePath} --repo ${repoSlug} --title ${tag} --notes ${`Synergy plugin release ${tag}`}`
}

async function runRegistryValidation(registryDir: string) {
  await $`bun install`.cwd(registryDir)
  await $`bun run build-registry`.cwd(registryDir)
  await $`bun run validate`.cwd(registryDir)
  await $`bun run build-registry --check`.cwd(registryDir)
}

async function openRegistryPr(input: {
  registryDir: string
  pluginId: string
  version: string
  noPr: boolean
  githubRepo: string
  baseBranch: string
  branchPrefix: string
}) {
  const prefix = input.branchPrefix.replace(/\/+$/, "")
  const branch = `${prefix}/${input.pluginId}-${input.version}`
  await $`git checkout -B ${branch}`.cwd(input.registryDir)
  await $`git add plugins/${input.pluginId}.json registry.json`.cwd(input.registryDir).nothrow()
  const iconPath = path.join(input.registryDir, "icons", `${input.pluginId}.svg`)
  if (fs.existsSync(iconPath)) await $`git add icons/${input.pluginId}.svg`.cwd(input.registryDir).nothrow()
  const diff = await $`git diff --cached --quiet`.cwd(input.registryDir).nothrow()
  if (diff.exitCode === 0) {
    UI.println(`${UI.Style.TEXT_DIM}No registry changes to commit.${UI.Style.TEXT_NORMAL}`)
    return
  }

  await $`git commit -m ${`Add ${input.pluginId} ${input.version}`}`.cwd(input.registryDir)

  if (input.noPr || !(await ghReady())) {
    UI.println()
    UI.println(
      `${UI.Style.TEXT_WARNING}Registry entry is ready, but PR was not opened automatically.${UI.Style.TEXT_NORMAL}`,
    )
    UI.println(`  cd ${input.registryDir}`)
    UI.println(`  git push origin ${branch}`)
    UI.println(`  Open a PR against ${input.githubRepo}:${input.baseBranch}`)
    return
  }

  try {
    await $`git push -u origin ${branch}`.cwd(input.registryDir)
    await $`gh pr create --repo ${input.githubRepo} --base ${input.baseBranch} --head ${branch} --title ${`Add ${input.pluginId} ${input.version}`} --body ${`Adds ${input.pluginId} ${input.version} to the Synergy Plugin Marketplace.`}`.cwd(
      input.registryDir,
    )
  } catch {
    UI.println()
    UI.println(
      `${UI.Style.TEXT_WARNING}Registry entry is committed, but the PR could not be opened automatically.${UI.Style.TEXT_NORMAL}`,
    )
    UI.println(`  cd ${input.registryDir}`)
    UI.println(`  git push origin ${branch}`)
    UI.println(`  Open a PR against ${input.githubRepo}:${input.baseBranch}`)
  }
}

export const PluginPublishMarketCommand = cmd({
  command: "publish-market [tarball]",
  describe: "prepare and open an official Synergy Plugin Marketplace PR",
  builder: (yargs: Argv) =>
    yargs
      .positional("tarball", {
        type: "string",
        describe: "optional prebuilt .synergy-plugin.tgz tarball",
      })
      .option("path", {
        type: "string",
        describe: "plugin directory (defaults to cwd)",
      })
      .option("repo", {
        type: "string",
        describe: "plugin GitHub repository URL",
      })
      .option("registry-dir", {
        type: "string",
        describe: "local checkout path for the marketplace registry repository",
      })
      .option("registry-repo", {
        type: "string",
        default: defaultRegistryRepo(),
        describe: "registry repository to clone when --registry-dir does not exist",
      })
      .option("registry-github-repo", {
        type: "string",
        describe: "GitHub owner/repo used for opening the registry PR",
      })
      .option("registry-base-branch", {
        type: "string",
        default: defaultRegistryBaseBranch(),
        describe: "base branch for the registry PR",
      })
      .option("registry-branch-prefix", {
        type: "string",
        default: defaultRegistryBranchPrefix(),
        describe: "branch prefix for registry PR branches",
      })
      .option("download-url", {
        type: "string",
        describe: "release asset URL for the .synergy-plugin.tgz",
      })
      .option("signature-url", {
        type: "string",
        describe: "release asset URL for the .sig file",
      })
      .option("skip-release-upload", {
        type: "boolean",
        default: false,
        describe: "do not create/upload GitHub Release assets",
      })
      .option("release-backend", {
        choices: ["github", "manual"] as const,
        default: defaultReleaseBackend(),
        describe: "release asset backend; github can create/upload releases, manual only writes registry metadata",
      })
      .option("release-url-template", {
        type: "string",
        describe: "template for release asset URLs; supports {repo}, {version}, {tag}, and {filename}",
      })
      .option("pr", {
        type: "boolean",
        default: true,
        describe: "open a PR after preparing registry changes; pass --no-pr to skip",
      })
      .option("changelog", {
        type: "string",
        describe: "version changelog for the registry entry",
      }),
  async handler(args) {
    try {
      const pluginDir = path.resolve((args.path as string | undefined) ?? process.cwd())
      let tarballPath = args.tarball ? path.resolve(args.tarball as string) : undefined

      if (!tarballPath) {
        await validatePluginProject(pluginDir, { runtimeDiscovery: true })
        if (process.exitCode && process.exitCode !== 0) throw new Error("Validation failed")
        const built = await buildPluginProject(pluginDir)
        if (!built) throw new Error("Build failed")
        tarballPath = packPluginProject(pluginDir)
      }

      const manifest = readTarballManifest(tarballPath)
      assertMarketplaceNaming({ tarballPath, manifest })
      await signPluginTarball(tarballPath)

      const repo = normalizeRepoUrl(
        (args.repo as string | undefined) ?? (await currentRepoUrl(pluginDir)) ?? manifest.repository,
      )
      if (!repo) throw new Error("Could not determine plugin GitHub repo. Pass --repo https://github.com/owner/repo.")

      const signaturePath = `${tarballPath}.sig`
      const releaseBackend = (args["release-backend"] as "github" | "manual" | undefined) ?? defaultReleaseBackend()
      await ensureGitHubReleaseAssets({
        repo,
        version: manifest.version,
        tarballPath,
        signaturePath,
        skipUpload: releaseBackend !== "github" || Boolean(args["skip-release-upload"]),
      })

      const { downloadUrl, signatureUrl } = resolveReleaseAssetUrls({
        backend: releaseBackend,
        repo,
        version: manifest.version,
        filename: path.basename(tarballPath),
        downloadUrl: args.downloadUrl as string | undefined,
        signatureUrl: args.signatureUrl as string | undefined,
        urlTemplate: args["release-url-template"] as string | undefined,
      })
      const entry = githubEntry({
        tarballPath,
        repo,
        downloadUrl,
        signatureUrl,
        changelog: args.changelog as string | undefined,
      })

      const registryRepo = (args["registry-repo"] as string | undefined) ?? defaultRegistryRepo()
      const registryDir = path.resolve((args["registry-dir"] as string | undefined) ?? defaultRegistryDir())
      await ensureRegistryCheckout(registryDir, registryRepo)
      const entryPath = path.join(registryDir, "plugins", `${entry.id}.json`)
      writeGithubEntry(entryPath, entry)
      copyGithubEntryIcon({ tarballPath, entryPath, entry })

      await runRegistryValidation(registryDir)
      await openRegistryPr({
        registryDir,
        pluginId: entry.id,
        version: manifest.version,
        noPr: (args.pr as boolean | undefined) === false,
        githubRepo: (args["registry-github-repo"] as string | undefined) ?? defaultRegistryGithubRepo(registryRepo),
        baseBranch: (args["registry-base-branch"] as string | undefined) ?? defaultRegistryBaseBranch(),
        branchPrefix: (args["registry-branch-prefix"] as string | undefined) ?? defaultRegistryBranchPrefix(),
      })

      UI.println(
        `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Marketplace publishing request prepared for ${entry.id} v${manifest.version}`,
      )
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
})
