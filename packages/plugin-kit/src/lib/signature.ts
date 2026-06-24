import fs from "fs"

export interface SignatureMetadata {
  signatureVersion: 1
  pluginId: string
  version: string
  algorithm: "ed25519"
  signer: string
  signature: string
  signedAt: number
  payload: {
    tarballHash: string
    manifestHash: string
    permissionsHash: string
  }
}

export function readSignatureFile(tarballPath: string): SignatureMetadata | null {
  const sigPath = `${tarballPath}.sig`
  if (!fs.existsSync(sigPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(sigPath, "utf-8")) as SignatureMetadata
    if (parsed.signatureVersion !== 1 || parsed.algorithm !== "ed25519") return null
    return parsed
  } catch {
    return null
  }
}
