export function pluginAssetIntegrity(sha256: string | undefined): string {
  if (!sha256 || !/^[a-f\d]{64}$/i.test(sha256)) throw new Error("Plugin UI artifact has no valid SHA-256 integrity")
  return `sha256-${btoa(String.fromCharCode(...sha256.match(/../g)!.map((byte) => Number.parseInt(byte, 16))))}`
}
