import { describe, expect, test } from "bun:test"
import { subtle } from "node:crypto"
import path from "path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import {
  verifySignature,
  verifySignatureFromHashes,
  readSignatureFile,
  verifySignatureWithPublicKey,
  type SignatureMetadata,
} from "../../src/plugin/signature"
import fs from "node:fs/promises"
import { PluginPaths } from "../../src/plugin/paths"
import { sha256File } from "@ericsanchezok/synergy-harness/util/crypto"

async function generateKeyPair() {
  const key = (await subtle.generateKey("Ed25519" as any, true, ["sign", "verify"])) as CryptoKeyPair
  const privateRaw = await subtle.exportKey("pkcs8", key.privateKey)
  const publicRaw = await subtle.exportKey("raw", key.publicKey)
  return {
    privateKey: Buffer.from(privateRaw as ArrayBuffer).toString("hex"),
    publicKey: Buffer.from(publicRaw as ArrayBuffer).toString("hex"),
  }
}

async function importPrivateKey(hex: string) {
  return subtle.importKey("pkcs8", Buffer.from(hex, "hex"), "Ed25519" as any, false, ["sign"])
}

async function signMetadata(input: {
  tarballPath: string
  pluginId: string
  version: string
  privateKeyHex: string
  publicKeyHex: string
}): Promise<SignatureMetadata> {
  const payload = {
    tarballHash: sha256File(input.tarballPath),
    manifestHash: "manifest-hash",
    permissionsHash: "permissions-hash",
  }
  const privateKey = await importPrivateKey(input.privateKeyHex)
  const signature = await subtle.sign("Ed25519" as any, privateKey, new TextEncoder().encode(JSON.stringify(payload)))
  return {
    signatureVersion: 1,
    pluginId: input.pluginId,
    version: input.version,
    algorithm: "ed25519",
    signer: input.publicKeyHex,
    signature: Buffer.from(signature as ArrayBuffer).toString("hex"),
    signedAt: Date.now(),
    payload,
  }
}

describe("plugin signature verification", () => {
  test("trusted-key verification binds installed hashes and tarball bytes, and rejects malformed signature files", async () => {
    await using tmp = await tmpdir()
    const tarballPath = path.join(tmp.path, "verified.tgz")
    await Bun.write(tarballPath, "signed artifact")
    const key = await generateKeyPair()
    const metadata = await signMetadata({
      tarballPath,
      pluginId: "trusted-fixture",
      version: "1.0.0",
      privateKeyHex: key.privateKey,
      publicKeyHex: key.publicKey,
    })
    const keyPath = path.join(PluginPaths.trustedSigningKeysDir(), `fixture-${crypto.randomUUID()}.pub`)
    expect(await verifySignature(tarballPath, metadata)).toBe(false)
    await Bun.write(keyPath, key.publicKey)
    try {
      expect(await verifySignature(tarballPath, metadata)).toBe(true)
      expect(await verifySignatureFromHashes(metadata, "manifest-hash", "permissions-hash")).toBe(true)
      expect(await verifySignatureFromHashes(metadata, "changed", "permissions-hash")).toBe(false)
      expect(await verifySignatureFromHashes(metadata, "manifest-hash", "changed")).toBe(false)
      expect(await verifySignature(tarballPath, { ...metadata, algorithm: "unsupported" })).toBe(false)
      await Bun.write(tarballPath, "tampered artifact")
      expect(await verifySignature(tarballPath, metadata)).toBe(false)
      expect(readSignatureFile(tarballPath)).toBeNull()
      await Bun.write(`${tarballPath}.sig`, "malformed")
      expect(readSignatureFile(tarballPath)).toBeNull()
      await Bun.write(`${tarballPath}.sig`, JSON.stringify(metadata))
      expect(readSignatureFile(tarballPath)).toEqual(metadata)
    } finally {
      await fs.rm(keyPath, { force: true })
    }
  })

  test("verifies a tarball signature with an explicit registry-reviewed public key", async () => {
    await using tmp = await tmpdir()
    const tarballPath = path.join(tmp.path, "plugin.synergy-plugin.tgz")
    await Bun.write(tarballPath, "signed artifact")
    const key = await generateKeyPair()
    const metadata = await signMetadata({
      tarballPath,
      pluginId: "signed-plugin",
      version: "1.0.0",
      privateKeyHex: key.privateKey,
      publicKeyHex: key.publicKey,
    })

    await expect(verifySignatureWithPublicKey(tarballPath, metadata, key.publicKey)).resolves.toBe(true)
  })

  test("rejects a valid signature when the registry-reviewed signer differs", async () => {
    await using tmp = await tmpdir()
    const tarballPath = path.join(tmp.path, "plugin.synergy-plugin.tgz")
    await Bun.write(tarballPath, "signed artifact")
    const key = await generateKeyPair()
    const other = await generateKeyPair()
    const metadata = await signMetadata({
      tarballPath,
      pluginId: "signed-plugin",
      version: "1.0.0",
      privateKeyHex: key.privateKey,
      publicKeyHex: key.publicKey,
    })

    await expect(verifySignatureWithPublicKey(tarballPath, metadata, other.publicKey)).resolves.toBe(false)
  })
})
