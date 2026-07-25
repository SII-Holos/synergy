export function extractTarballText(tarballPath: string, memberPath: string): string | null {
  const normalized = memberPath.replace(/^\.\/+/, "")
  for (const entry of [normalized, `./${normalized}`]) {
    const result = Bun.spawnSync(["tar", "-xOf", tarballPath, entry], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode === 0) return new TextDecoder().decode(result.stdout)
  }
  return null
}
