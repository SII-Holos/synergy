import { afterEach, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import {
  chromiumManifestName,
  chromiumReleaseTarget,
  type ChromiumReleaseArch,
  type ChromiumReleasePlatform,
} from "@ericsanchezok/synergy-browser/chromium-release"
import { BrowserInstall } from "../../src/browser/install"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture(
  options: {
    platform?: ChromiumReleasePlatform
    arch?: ChromiumReleaseArch
    signatureValid?: boolean
    artifact?: Buffer
    manifestPatch?: Record<string, unknown>
  } = {},
) {
  const version = "9.9.9"
  const platform = options.platform ?? (process.platform as ChromiumReleasePlatform)
  const arch = options.arch ?? (process.arch as ChromiumReleaseArch)
  const target = chromiumReleaseTarget(platform, arch, "149.0.7827.55", "1228")
  if (!target) throw new Error("Fixture target is unsupported")
  const artifact = options.artifact ?? (await zip(target.executable, "#!/bin/sh\nexit 0\n"))
  const manifestName = chromiumManifestName(version, platform, arch)
  const manifestValue = {
    version,
    platform,
    arch,
    name: target.name,
    sha256: createHash("sha256").update(artifact).digest("hex"),
    size: artifact.byteLength,
    url: `https://cdn.playwright.dev/dbazure/download/playwright/${target.path}`,
    executable: target.executable,
    browserVersion: "149.0.7827.55",
    revision: "1228",
    ...options.manifestPatch,
  }
  const manifest = `${JSON.stringify(manifestValue, null, 2)}\n`
  const pair = generateKeyPairSync("ed25519")
  const signature = sign(
    null,
    Buffer.from(options.signatureValid === false ? `${manifest}tampered` : manifest),
    pair.privateKey,
  ).toString("base64")
  const publicJwk = pair.publicKey.export({ format: "jwk" })
  if (!publicJwk.x) throw new Error("Ed25519 fixture public key is missing")
  const publicKey = Buffer.from(publicJwk.x, "base64url").toString("base64")
  const base = "https://release.test"
  const responses = new Map<string, BodyInit>([
    [`${base}/${manifestName}`, manifest],
    [`${base}/${manifestName}.sig`, signature],
    [manifestValue.url, Uint8Array.from(artifact)],
  ])
  let fetchCount = 0
  const fetchMock: typeof fetch = (async (input) => {
    fetchCount++
    const body = responses.get(String(input))
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 })
  }) as typeof fetch
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-chromium-install-"))
  tempDirs.push(destination)
  await fs.rm(destination, { recursive: true })
  return {
    version,
    platform,
    arch,
    publicKey,
    fetchMock,
    fetchCount: () => fetchCount,
    destination,
    manifestName,
    manifestValue,
    artifact,
    responses,
    base,
  }
}

describe("managed Chromium installation", () => {
  test("verifies signed target metadata and digest before atomic installation", async () => {
    const input = await fixture()

    const result = await BrowserInstall.installChromium({
      fetch: input.fetchMock,
      publicKey: input.publicKey,
      manifestBaseUrl: input.base,
      version: input.version,
      platform: input.platform,
      arch: input.arch,
      libc: "glibc",
      destination: input.destination,
    })

    expect(result.action).toBe("installed")
    expect(result.browserVersion).toBe("149.0.7827.55")
    expect(result.executablePath.startsWith(input.destination)).toBe(true)
    expect(await Bun.file(result.executablePath).text()).toContain("exit 0")
    expect((await Bun.file(path.join(input.destination, "executable")).text()).trim()).toBe(result.executablePath)
    expect(
      await BrowserInstall.discoverChromium({
        platform: input.platform,
        arch: input.arch,
        env: {},
        home: path.dirname(input.destination),
        managedDir: input.destination,
      }),
    ).toBe(await fs.realpath(result.executablePath))
  })

  test("rejects invalid signatures and artifact tampering", async () => {
    const invalidSignature = await fixture({ signatureValid: false })
    await expect(
      BrowserInstall.installChromium({
        fetch: invalidSignature.fetchMock,
        publicKey: invalidSignature.publicKey,
        manifestBaseUrl: invalidSignature.base,
        version: invalidSignature.version,
        platform: invalidSignature.platform,
        arch: invalidSignature.arch,
        libc: "glibc",
        destination: invalidSignature.destination,
      }),
    ).rejects.toThrow(/signature/i)

    const tampered = await fixture()
    tampered.responses.set(
      tampered.manifestValue.url,
      Uint8Array.from(Buffer.concat([tampered.artifact, Buffer.from("x")])),
    )
    await expect(
      BrowserInstall.installChromium({
        fetch: tampered.fetchMock,
        publicKey: tampered.publicKey,
        manifestBaseUrl: tampered.base,
        version: tampered.version,
        platform: tampered.platform,
        arch: tampered.arch,
        libc: "glibc",
        destination: tampered.destination,
      }),
    ).rejects.toThrow(/size|digest/i)
  })

  test("cancels oversized manifest metadata while streaming", async () => {
    const input = await fixture()
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetchMock: typeof fetch = (async (resource) => {
      const url = String(resource)
      if (url === `${input.base}/${input.manifestName}`) return new Response(oversized)
      if (url === `${input.base}/${input.manifestName}.sig`) return new Response("signature")
      return new Response("missing", { status: 404 })
    }) as typeof fetch

    await expect(
      BrowserInstall.installChromium({
        fetch: fetchMock,
        publicKey: input.publicKey,
        manifestBaseUrl: input.base,
        version: input.version,
        platform: input.platform,
        arch: input.arch,
        libc: "glibc",
        destination: input.destination,
      }),
    ).rejects.toThrow(/metadata response is too large/i)
    expect(cancelled).toBe(true)
  })

  test("rejects target and upstream URL substitution", async () => {
    const wrongTarget = await fixture({ manifestPatch: { arch: "x64" === process.arch ? "arm64" : "x64" } })
    await expect(
      BrowserInstall.installChromium({
        fetch: wrongTarget.fetchMock,
        publicKey: wrongTarget.publicKey,
        manifestBaseUrl: wrongTarget.base,
        version: wrongTarget.version,
        platform: wrongTarget.platform,
        arch: wrongTarget.arch,
        libc: "glibc",
        destination: wrongTarget.destination,
      }),
    ).rejects.toThrow(/exactly match/i)

    const wrongUrl = await fixture({ manifestPatch: { url: "https://example.com/chrome.zip" } })
    wrongUrl.responses.set("https://example.com/chrome.zip", Uint8Array.from(wrongUrl.artifact))
    await expect(
      BrowserInstall.installChromium({
        fetch: wrongUrl.fetchMock,
        publicKey: wrongUrl.publicKey,
        manifestBaseUrl: wrongUrl.base,
        version: wrongUrl.version,
        platform: wrongUrl.platform,
        arch: wrongUrl.arch,
        libc: "glibc",
        destination: wrongUrl.destination,
      }),
    ).rejects.toThrow(/artifact.*requested|URL/i)
  })

  test("is idempotent and deduplicates concurrent installs", async () => {
    const input = await fixture()
    const options = {
      fetch: input.fetchMock,
      publicKey: input.publicKey,
      manifestBaseUrl: input.base,
      version: input.version,
      platform: input.platform,
      arch: input.arch,
      libc: "glibc" as const,
      destination: input.destination,
    }

    const [first, replay] = await Promise.all([
      BrowserInstall.installChromium(options),
      BrowserInstall.installChromium(options),
    ])
    expect(replay.executablePath).toBe(first.executablePath)
    expect(input.fetchCount()).toBe(3)

    const current = await BrowserInstall.installChromium(options)
    expect(current.action).toBe("up-to-date")
    expect(input.fetchCount()).toBe(3)
  })

  test("refuses unsupported and local release targets without network access", async () => {
    const input = await fixture()
    await expect(
      BrowserInstall.installChromium({ ...input, fetch: input.fetchMock, version: "local", libc: "glibc" }),
    ).rejects.toThrow(/local source/i)
    await expect(
      BrowserInstall.installChromium({
        fetch: input.fetchMock,
        version: input.version,
        platform: "linux",
        arch: "x64",
        libc: "musl",
        destination: input.destination,
      }),
    ).rejects.toThrow(/musl|CHROMIUM_PATH/i)
    await expect(
      BrowserInstall.installChromium({
        fetch: input.fetchMock,
        version: input.version,
        platform: "win32",
        arch: "arm64",
        libc: "glibc",
        destination: input.destination,
      }),
    ).rejects.toThrow(/unsupported|CHROMIUM_PATH/i)
  })
})

describe("Chromium discovery", () => {
  test("preserves the 32-bit Windows Chrome installation path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-chromium-discovery-"))
    tempDirs.push(root)
    const executable = path.join(root, "Google", "Chrome", "Application", "chrome.exe")
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, "fixture")

    expect(
      await BrowserInstall.discoverChromium({
        platform: "win32",
        arch: "x64",
        home: path.join(root, "home"),
        env: { "PROGRAMFILES(X86)": root },
        managedDir: path.join(root, "managed"),
        playwrightCoreExecutable: async () => null,
      }),
    ).toBe(executable)
  })
})

describe("Chromium diagnosis", () => {
  test("reports actionable not-found state without downloading", async () => {
    const report = await BrowserInstall.diagnoseChromium({ discover: async () => null })

    expect(report.ready).toBe(false)
    expect(report.chromiumPath).toBeNull()
    expect(
      report.checks.some((check) => check.status === "fail" && check.recovery?.command.includes("browser install")),
    ).toBe(true)
  })

  test("uses launch as the authoritative readiness check and reports Linux loader failures", async () => {
    const executable = "/fixture/chrome"
    const report = await BrowserInstall.diagnoseChromium({
      platform: "linux",
      discover: async () => ({ path: executable, source: "managed" }),
      launch: async () => {
        throw new Error("libnss3.so: cannot open shared object file")
      },
      version: async () => "Chromium 149.0.7827.55",
      ldd: async () => "libnss3.so => not found\nlibgbm.so.1 => /lib/libgbm.so.1",
    })

    expect(report.ready).toBe(false)
    expect(report.chromiumPath).toBe(executable)
    expect(report.browserVersion).toBe("149.0.7827.55")
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "shared_libraries",
        status: "fail",
        detail: expect.stringContaining("libnss3.so"),
      }),
    )
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "launch", status: "fail", detail: expect.stringContaining("libnss3.so") }),
    )
  })

  test("reports ready when the discovered Chromium launches", async () => {
    const report = await BrowserInstall.diagnoseChromium({
      platform: "darwin",
      discover: async () => ({ path: "/fixture/chrome", source: "system" }),
      launch: async () => undefined,
      version: async () => "Google Chrome 149.0.7827.55",
    })

    expect(report.ready).toBe(true)
    expect(report.discoverySource).toBe("system")
    expect(report.checks.every((check) => check.status !== "fail")).toBe(true)
  })
})

async function zip(name: string, content: string): Promise<Buffer> {
  const writer = new BlobWriter("application/zip")
  const zipWriter = new ZipWriter(writer)
  await zipWriter.add(name, new TextReader(content))
  const blob = await zipWriter.close()
  return Buffer.from(await blob.arrayBuffer())
}
