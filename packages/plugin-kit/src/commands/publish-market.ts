import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import type { Argv } from "yargs"
import { cmd } from "../cmd"
import { UI } from "../ui"
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

const DEFAULT_REGISTRY_REPO = "https://github.com/SII-Holos/synergy-plugins.git"

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

function defaultRegistryDir(pluginDir: string): string {
  const sibling = path.resolve(pluginDir, "..", "synergy-plugins")
  if (fs.existsSync(sibling)) return sibling
  return path.join(os.homedir(), "projects", "synergy-plugins")
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

async function ensureRegistryCheckout(registryDir: string, registryRepo: string) {
  if (fs.existsSync(path.join(registryDir, ".git"))) return
  fs.mkdirSync(path.dirname(registryDir), { recursive: true })
  UI.println(`Cloning official plugin registry to ${registryDir}`)
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

async function openRegistryPr(input: { registryDir: string; pluginId: string; version: string; noPr: boolean }) {
  const branch = `publish/${input.pluginId}-${input.version}`
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
    UI.println(`  Open a PR against SII-Holos/synergy-plugins:main`)
    return
  }

  try {
    await $`git push -u origin ${branch}`.cwd(input.registryDir)
    await $`gh pr create --repo SII-Holos/synergy-plugins --base main --head ${branch} --title ${`Add ${input.pluginId} ${input.version}`} --body ${`Adds ${input.pluginId} ${input.version} to the official Synergy Plugin Marketplace.`}`.cwd(
      input.registryDir,
    )
  } catch {
    UI.println()
    UI.println(
      `${UI.Style.TEXT_WARNING}Registry entry is committed, but the PR could not be opened automatically.${UI.Style.TEXT_NORMAL}`,
    )
    UI.println(`  cd ${input.registryDir}`)
    UI.println(`  git push origin ${branch}`)
    UI.println(`  Open a PR against SII-Holos/synergy-plugins:main`)
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
        describe: "local checkout path for SII-Holos/synergy-plugins",
      })
      .option("registry-repo", {
        type: "string",
        default: DEFAULT_REGISTRY_REPO,
        describe: "registry repository to clone when --registry-dir does not exist",
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
      await ensureGitHubReleaseAssets({
        repo,
        version: manifest.version,
        tarballPath,
        signaturePath,
        skipUpload: Boolean(args["skip-release-upload"]),
      })

      const downloadUrl =
        (args.downloadUrl as string | undefined) ?? releaseAssetUrl(repo, manifest.version, path.basename(tarballPath))
      const signatureUrl = (args.signatureUrl as string | undefined) ?? (downloadUrl ? `${downloadUrl}.sig` : undefined)
      const entry = githubEntry({
        tarballPath,
        repo,
        downloadUrl,
        signatureUrl,
        changelog: args.changelog as string | undefined,
      })

      const registryDir = path.resolve((args["registry-dir"] as string | undefined) ?? defaultRegistryDir(pluginDir))
      await ensureRegistryCheckout(registryDir, (args["registry-repo"] as string | undefined) ?? DEFAULT_REGISTRY_REPO)
      const entryPath = path.join(registryDir, "plugins", `${entry.id}.json`)
      writeGithubEntry(entryPath, entry)
      copyGithubEntryIcon({ tarballPath, entryPath, entry })

      await runRegistryValidation(registryDir)
      await openRegistryPr({
        registryDir,
        pluginId: entry.id,
        version: manifest.version,
        noPr: (args.pr as boolean | undefined) === false,
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
