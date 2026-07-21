import { afterEach, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import { BrowserInstall } from "../../src/browser/install"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture(options: { artifact?: Buffer; signatureValid?: boolean; entryName?: string } = {}) {
  const version = "9.9.9"
  const platform = process.platform as "darwin" | "win32" | "linux"
  const arch = process.arch as "x64" | "arm64"
  const entryName = options.entryName ?? "host"
  const artifact = options.artifact ?? (await zip(entryName, "#!/bin/sh\nexit 0\n"))
  const name = `synergy-browser-host-${platform}-${arch}-${version}.zip`
  const manifestName = `synergy-browser-host-${platform}-${arch}-${version}.manifest.json`
  const manifest = `${JSON.stringify(
    {
      version,
      protocolVersion: 2,
      platform,
      arch,
      name,
      sha256: createHash("sha256").update(artifact).digest("hex"),
      size: artifact.byteLength,
      url: `https://release.test/${name}`,
      executable: "host",
    },
    null,
    2,
  )}\n`
  const pair = generateKeyPairSync("ed25519")
  const signature = sign(
    null,
    Buffer.from(options.signatureValid === false ? `${manifest}tampered` : manifest),
    pair.privateKey,
  ).toString("base64")
  const publicJwk = pair.publicKey.export({ format: "jwk" })
  if (!publicJwk.x) throw new Error("Ed25519 fixture public key is missing its raw coordinate.")
  const publicKey = Buffer.from(publicJwk.x, "base64url").toString("base64")
  const responses = new Map<string, BodyInit>([
    [`https://release.test/${manifestName}`, manifest],
    [`https://release.test/${manifestName}.sig`, signature],
    [`https://release.test/${name}`, Uint8Array.from(artifact)],
  ])
  const fetchMock: typeof fetch = (async (input) => {
    const url = String(input)
    const body = responses.get(url)
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 })
  }) as typeof fetch
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-host-install-"))
  tempDirs.push(destination)
  await fs.rm(destination, { recursive: true })
  return { version, platform, arch, publicKey, fetchMock, destination, manifestName, artifact, responses }
}

describe("Browser Host artifact installation", () => {
  test("verifies signature and digest before atomically installing the exact artifact", async () => {
    const input = await fixture()
    const executable = await BrowserInstall.installHost({
      fetch: input.fetchMock,
      publicKey: input.publicKey,
      manifestBaseUrl: "https://release.test",
      version: input.version,
      platform: input.platform,
      arch: input.arch,
      destination: input.destination,
    })
    expect(await Bun.file(executable).text()).toContain("exit 0")
    expect(executable.startsWith(input.destination)).toBe(true)
  })

  test("rejects a manifest with an invalid signature", async () => {
    const input = await fixture({ signatureValid: false })
    await expect(
      BrowserInstall.installHost({
        fetch: input.fetchMock,
        publicKey: input.publicKey,
        manifestBaseUrl: "https://release.test",
        version: input.version,
        platform: input.platform,
        arch: input.arch,
        destination: input.destination,
      }),
    ).rejects.toThrow(/signature/i)
  })

  test("rejects artifact tampering and archive path traversal", async () => {
    const tampered = await fixture()
    tampered.responses.set(
      `https://release.test/synergy-browser-host-${tampered.platform}-${tampered.arch}-${tampered.version}.zip`,
      Uint8Array.from(Buffer.concat([tampered.artifact, Buffer.from("tampered")])),
    )
    await expect(
      BrowserInstall.installHost({
        fetch: tampered.fetchMock,
        publicKey: tampered.publicKey,
        manifestBaseUrl: "https://release.test",
        version: tampered.version,
        platform: tampered.platform,
        arch: tampered.arch,
        destination: tampered.destination,
      }),
    ).rejects.toThrow(/size|digest/i)

    const traversal = await fixture({ entryName: "../host" })
    await expect(
      BrowserInstall.installHost({
        fetch: traversal.fetchMock,
        publicKey: traversal.publicKey,
        manifestBaseUrl: "https://release.test",
        version: traversal.version,
        platform: traversal.platform,
        arch: traversal.arch,
        destination: traversal.destination,
      }),
    ).rejects.toThrow(/unsafe path|escapes/i)
  })
})

describe("Chromium discovery", () => {
  test("finds current Playwright Chromium layouts in the Windows local cache", async () => {
    const localAppData = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-playwright-windows-"))
    tempDirs.push(localAppData)
    const executable = path.join(localAppData, "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe")
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, "browser")

    await expect(
      BrowserInstall.discoverChromium({
        platform: "win32",
        arch: "x64",
        home: localAppData,
        env: { LOCALAPPDATA: localAppData },
      }),
    ).resolves.toBe(executable)
  })
})

async function zip(name: string, content: string): Promise<Buffer> {
  const writer = new BlobWriter("application/zip")
  const zipWriter = new ZipWriter(writer)
  await zipWriter.add(name, new TextReader(content))
  const blob = await zipWriter.close()
  return Buffer.from(await blob.arrayBuffer())
}
