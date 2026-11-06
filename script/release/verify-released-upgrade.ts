#!/usr/bin/env bun
import { constants } from "node:fs"
import { access, copyFile, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { sha256File } from "../../packages/plugin-host/src/installation/files"
import { parseJUnit } from "../ci/junit"
import { assertArchiveMembersSafe } from "./nodes/package-binary-assets"
import release from "./released-upgrade-artifacts.json"

interface Artifact {
  name: string
  url: string
  sha256: string
}

interface Options {
  candidate: string
  version: string
  archive?: string
  evidence?: string
  junit?: string
}

export function releasedUpgradeArtifact(platform: string = process.platform, arch: string = process.arch): Artifact {
  const target = `${platform}-${arch}`
  if (target !== "linux-x64" && target !== "darwin-arm64")
    throw new Error(`Unsupported released-upgrade platform: ${target}`)
  return release.assets[target]
}

export async function candidateVersion(candidate: string): Promise<string> {
  const manifest: unknown = await Bun.file(path.join(candidate, "package.json")).json()
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)
  )
    throw new Error("Candidate package.json must declare a semantic version")
  return manifest.version
}

export async function verifyReleasedUpgrade(
  options: Options,
  context: { root?: string; asset?: Artifact } = {},
): Promise<void> {
  if (!options.candidate || !options.version) throw new Error("Released upgrade requires --candidate and --version")
  const asset = context.asset ?? releasedUpgradeArtifact()
  const root = context.root ?? path.resolve(import.meta.dir, "../..")
  const launcher = path.resolve(options.candidate, "bin/synergy")
  try {
    if (!(await stat(launcher)).isFile()) throw new Error("Not a file")
    await access(launcher, constants.X_OK)
  } catch {
    throw new Error(`Missing or non-executable candidate launcher: ${launcher}`)
  }
  const candidate = await realpath(options.candidate)
  const version = await candidateVersion(candidate)
  if (version !== options.version)
    throw new Error(`Candidate version mismatch: expected ${options.version}, package.json declares ${version}`)
  if (!(await Bun.file(path.join(root, release.test)).exists())) throw new Error("Released upgrade test is missing")
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "synergy-upgrade-verifier-")))
  const previous = path.join(temporary, "previous")
  const home = path.join(temporary, "home")
  const report = path.join(temporary, "upgrade.xml")
  const archive = path.join(temporary, asset.name)
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    SYNERGY_HOME: home,
    SYNERGY_TEST_HOME: home,
    SYNERGY_TEST_ROOT: path.join(temporary, "fixtures"),
    TMPDIR: path.join(temporary, "tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C",
    SYNERGY_DISABLE_MODELS_FETCH: "1",
    SYNERGY_UPGRADE_PREVIOUS: previous,
    SYNERGY_UPGRADE_CANDIDATE: candidate,
    SYNERGY_UPGRADE_VERSION: version,
    ...(options.evidence ? { SYNERGY_UPGRADE_EVIDENCE: path.resolve(options.evidence) } : {}),
  }
  try {
    await Promise.all(
      [previous, home, env.SYNERGY_TEST_ROOT, env.TMPDIR].map((directory) => mkdir(directory, { recursive: true })),
    )
    if (options.archive) await copyFile(path.resolve(options.archive), archive)
    else {
      console.info(`Downloading pinned v${release.version}: ${asset.name}`)
      const response = await fetch(asset.url)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Released upgrade download failed: HTTP ${response.status} (${asset.name})`)
      }
      await Bun.write(archive, response)
    }
    const digest = await sha256File(archive)
    if (digest !== asset.sha256)
      throw new Error(`SHA256 mismatch for ${asset.name}: expected ${asset.sha256}, received ${digest}`)
    console.info(`Verified ${asset.name}: sha256:${digest}`)
    await assertArchiveMembersSafe(archive)
    const unpack = Bun.spawn(
      asset.name.endsWith(".zip") ? ["unzip", "-q", archive, "-d", previous] : ["tar", "-xzf", archive, "-C", previous],
      { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    )
    if ((await unpack.exited) !== 0) throw new Error("Released upgrade archive extraction failed")
    if (!(await Bun.file(path.join(previous, "bin/synergy")).exists()))
      throw new Error("Released upgrade archive has no bin/synergy")
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--config",
        "/dev/null",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        release.test,
      ],
      { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    )
    const code = await child.exited
    if (options.junit && (await Bun.file(report).exists())) {
      await mkdir(path.dirname(path.resolve(options.junit)), { recursive: true })
      await copyFile(report, path.resolve(options.junit))
    }
    if (code !== 0) throw new Error(`Released upgrade test failed (exit ${code})`)
    const [result] = await parseJUnit([await Bun.file(report).bytes()])
    if (
      result!.error ||
      result!.cases.length !== 1 ||
      result!.cases[0]!.name !== release.scenario ||
      result!.cases[0]!.outcome !== "passed"
    )
      throw new Error(`Released upgrade scenario must pass exactly once: ${JSON.stringify(result)}`)
    console.info(`Released upgrade verified: ${release.version} -> ${version}, including restart and backup recovery`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        candidate: { type: "string" },
        version: { type: "string" },
        archive: { type: "string" },
        evidence: { type: "string" },
        junit: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    })
    if (values.help)
      console.info(
        "Usage: bun script/release/verify-released-upgrade.ts --candidate <full-distribution> --version <expected-version> [--archive <pinned-release-archive>] [--junit <report.xml>] [--evidence <private-directory>]\nBuild the candidate first. Requires Python 3 and tar (Linux) or unzip (macOS). Downloads and verifies pinned v3.0.22 unless --archive is supplied; local archives receive the same SHA256 check.",
      )
    else {
      if (!values.candidate || !values.version) throw new Error("Released upgrade requires --candidate and --version")
      await verifyReleasedUpgrade({ ...values, candidate: values.candidate, version: values.version })
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
