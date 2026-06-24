import { describe, expect, test } from "bun:test"
import { subtle } from "node:crypto"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { verifySignatureWithPublicKey, type SignatureMetadata } from "../../src/plugin/signature"
import { sha256File } from "../../src/util/crypto"

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
