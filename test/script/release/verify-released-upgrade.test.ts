import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { assertPluginCompatibility } from "../../../packages/plugin-host/src/installation/plugin-manifest"
import upgradePlugin from "./upgrade-plugin-fixture"
import {
  candidateVersion,
  releasedUpgradeArtifact,
  verifyReleasedUpgrade,
} from "../../../script/release/verify-released-upgrade"

const scenario = "released 3.0.22 preserves history, plugins and assets through upgrade, restart and backup recovery"
const repository = path.resolve(import.meta.dir, "../../..")

test("the retained plugin supports released and CI candidates without accepting unrelated release lines", () => {
  const manifest = compilePluginManifest(upgradePlugin, {
    generation: "compatibility-probe",
    runtime: { entry: "runtime.js", sha256: "a".repeat(64) },
  })
  for (const version of ["3.0.22", "3.1.0", "0.0.0-dev-20261025"])
    expect(() => assertPluginCompatibility(manifest, version)).not.toThrow()
  for (const version of ["2.0.0", "3.0.21", "4.0.0"])
    expect(() => assertPluginCompatibility(manifest, version)).toThrow("requires Synergy")
})

async function fixture(format: "tar.gz" | "zip" = "tar.gz") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "released-upgrade-runner-")))
  const candidate = path.join(root, "candidate with spaces")
  const source = path.join(root, "source")
  const archive = path.join(root, `previous.${format}`)
  const junit = path.join(root, "reports/upgrade.xml")
  let requests = 0
  let status = 200
  let corrupt = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return new Response(corrupt ? "not an archive" : Bun.file(archive), { status })
    },
  })
  try {
    for (const directory of [candidate, source]) {
      await mkdir(path.join(directory, "bin"), { recursive: true })
      await Bun.write(path.join(directory, "bin/synergy"), "#!/bin/sh\nexit 99\n")
      await chmod(path.join(directory, "bin/synergy"), 0o755)
    }
    await Bun.write(path.join(candidate, "package.json"), JSON.stringify({ version: "0.0.0-dev-fixture" }))
    const child = Bun.spawn(format === "zip" ? ["zip", "-qr", archive, "bin"] : ["tar", "-czf", archive, "bin"], {
      cwd: source,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`Fixture archive failed: ${stderr}`)
    const asset = {
      name: path.basename(archive),
      url: new URL(path.basename(archive), server.url).href,
      sha256: createHash("sha256")
        .update(await Bun.file(archive).bytes())
        .digest("hex"),
    }
    async function control(body: string) {
      await Bun.write(
        path.join(root, "test/script/release/released-upgrade.test.ts"),
        `import { expect, test } from "bun:test";\n${body}`,
      )
    }
    await control(`test(${JSON.stringify(scenario)}, async () => {
      expect(await Bun.file(process.env.SYNERGY_UPGRADE_PREVIOUS + "/bin/synergy").text()).toContain("exit 99");
      expect(process.env.SYNERGY_UPGRADE_CANDIDATE).toBe(${JSON.stringify(candidate)});
      expect(process.env.SYNERGY_UPGRADE_VERSION).toBe("0.0.0-dev-fixture");
      expect(process.env.HOME).toBe(process.env.SYNERGY_TEST_HOME);
      expect(process.env.SYNERGY_HOME).toBe(process.env.SYNERGY_TEST_HOME);
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect(process.env.GH_TOKEN).toBeUndefined();
      expect(process.env.SYNERGY_CONFIG_CONTENT).toBeUndefined();
      expect(process.env.SYNERGY_TEST_FILES).toBeUndefined();
      await Bun.write("invoked.json", JSON.stringify({ previous: process.env.SYNERGY_UPGRADE_PREVIOUS }));
    });`)
    const input = { candidate, version: "0.0.0-dev-fixture", junit }
    return {
      root,
      candidate,
      archive,
      junit,
      control,
      requests: () => requests,
      failDownload: () => (status = 503),
      corruptDownload: () => (corrupt = true),
      run: (extra: { archive?: string; version?: string } = {}) =>
        verifyReleasedUpgrade({ ...input, ...extra }, { root, asset }),
      [Symbol.asyncDispose]: async () => {
        await server.stop(true)
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

test("released platform pins match both the GitHub asset digests and published CLI checksums", () => {
  expect(releasedUpgradeArtifact("linux", "x64")).toMatchObject({
    name: "synergy-linux-x64.tar.gz",
    url: "https://github.com/SII-Holos/synergy/releases/download/v3.0.22/synergy-linux-x64.tar.gz",
    sha256: "9444a6d0c5484be9c370f0ab9506bcfdd6e1faba700461bbb1df4f0aa178e422",
  })
  expect(releasedUpgradeArtifact("darwin", "arm64")).toMatchObject({
    name: "synergy-darwin-arm64.zip",
    url: "https://github.com/SII-Holos/synergy/releases/download/v3.0.22/synergy-darwin-arm64.zip",
    sha256: "ef9a9594dfaed998413fc40ef49df52aa0977c2ac205ec4230b66771a2259334",
  })
  expect(() => releasedUpgradeArtifact("win32", "x64")).toThrow("Unsupported released-upgrade platform")
})

test.each(["tar.gz", "zip"] as const)(
  "verified %s archives run an isolated control and retain JUnit",
  async (format) => {
    await using run = await fixture(format)
    expect(await candidateVersion(run.candidate)).toBe("0.0.0-dev-fixture")
    await run.run()
    expect(run.requests()).toBe(1)
    expect(await Bun.file(run.junit).text()).toContain(scenario)
    const invoked = await Bun.file(path.join(run.root, "invoked.json")).json()
    expect(await Bun.file(path.join(invoked.previous, "bin/synergy")).exists()).toBe(false)
    expect(await Bun.file(path.join(run.candidate, "bin/synergy")).text()).toContain("exit 99")
  },
)

test("a verified local archive is reused without downloading", async () => {
  await using run = await fixture()
  await run.run({ archive: run.archive })
  expect(run.requests()).toBe(0)
})

test("the control does not inherit coordinator credentials, config or test selection", async () => {
  await using run = await fixture()
  const keys = ["GITHUB_TOKEN", "GH_TOKEN", "SYNERGY_CONFIG_CONTENT", "SYNERGY_TEST_FILES"]
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    for (const key of keys) process.env[key] = "release-fixture-not-a-secret"
    await run.run({ archive: run.archive })
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  }
})

test("download errors and digest mismatches fail before unpacking or test execution", async () => {
  await using run = await fixture()
  run.corruptDownload()
  await expect(run.run()).rejects.toThrow("SHA256 mismatch")
  run.failDownload()
  await expect(run.run()).rejects.toThrow("503")
  await Bun.write(run.archive, "corrupt local archive")
  await expect(run.run({ archive: run.archive })).rejects.toThrow("SHA256 mismatch")
  expect(await Bun.file(path.join(run.root, "invoked.json")).exists()).toBe(false)
  expect(await Bun.file(run.junit).exists()).toBe(false)
})

test("candidate version mismatch, malformed metadata and missing launcher fail before downloading", async () => {
  await using run = await fixture()
  await expect(run.run({ version: "3.1.0" })).rejects.toThrow("Candidate version mismatch")
  await Bun.write(path.join(run.candidate, "package.json"), JSON.stringify({ version: "not-a-version" }))
  await expect(run.run()).rejects.toThrow("semantic version")
  await rm(path.join(run.candidate, "bin/synergy"))
  await expect(run.run()).rejects.toThrow("candidate launcher")
  expect(run.requests()).toBe(0)
})

test.each([
  ["skipped", `test.skip(${JSON.stringify(scenario)}, () => {});`],
  ["absent", 'test("unrelated passing test", () => {});'],
  ["duplicate", `test(${JSON.stringify(scenario)}, () => {}); test(${JSON.stringify(scenario)}, () => {});`],
  ["failed", `test(${JSON.stringify(scenario)}, () => expect(false).toBe(true));`],
])("a %s upgrade control cannot succeed or reuse an old passing report", async (_name, body) => {
  await using run = await fixture()
  await Bun.write(run.junit, `<testsuite><testcase name="${scenario}"/></testsuite>`)
  await run.control(body!)
  await expect(run.run({ archive: run.archive })).rejects.toThrow("Released upgrade")
  expect(await Bun.file(path.join(run.root, "invoked.json")).exists()).toBe(false)
})

test("the CLI requires explicit candidate and version arguments without falling back to opt-in environment", async () => {
  const child = Bun.spawn([process.execPath, "script/release/verify-released-upgrade.ts"], {
    cwd: repository,
    env: { PATH: process.env.PATH, SYNERGY_UPGRADE_CANDIDATE: "ignored", SYNERGY_UPGRADE_VERSION: "3.1.0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code).not.toBe(0)
  expect(stderr).toContain("--candidate")
  expect(stderr).toContain("--version")
})
