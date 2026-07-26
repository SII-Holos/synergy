import z from "zod"

export const CHROMIUM_RELEASE_PLATFORMS = ["darwin", "win32", "linux"] as const
export const CHROMIUM_RELEASE_ARCHES = ["x64", "arm64"] as const

export type ChromiumReleasePlatform = (typeof CHROMIUM_RELEASE_PLATFORMS)[number]
export type ChromiumReleaseArch = (typeof CHROMIUM_RELEASE_ARCHES)[number]

export const ChromiumManifestSchema = z
  .object({
    version: z.string().min(1).max(200),
    platform: z.enum(CHROMIUM_RELEASE_PLATFORMS),
    arch: z.enum(CHROMIUM_RELEASE_ARCHES),
    name: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(500 * 1024 * 1024),
    url: z
      .string()
      .url()
      .max(20_000)
      .refine((value) => new URL(value).protocol === "https:", "Chromium artifact URL must use HTTPS."),
    executable: z.string().min(1).max(20_000),
    browserVersion: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
  })
  .strict()

export type ChromiumManifest = z.infer<typeof ChromiumManifestSchema>

export interface ChromiumReleaseTarget {
  platform: ChromiumReleasePlatform
  arch: ChromiumReleaseArch
  name: string
  path: string
  urls: readonly string[]
  executable: string
}

const PLAYWRIGHT_CHROMIUM_ORIGINS = [
  "https://cdn.playwright.dev/dbazure/download/playwright",
  "https://playwright.download.prss.microsoft.com/dbazure/download/playwright",
  "https://cdn.playwright.dev",
] as const
const PLAYWRIGHT_CFT_ORIGINS = ["https://cdn.playwright.dev"] as const

const STABLE_TARGETS: ReadonlyArray<Pick<ChromiumReleaseTarget, "platform" | "arch">> = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "win32", arch: "x64" },
]

export function chromiumManifestName(
  version: string,
  platform: ChromiumReleasePlatform,
  arch: ChromiumReleaseArch,
): string {
  return `synergy-chromium-${platform}-${arch}-${version}.manifest.json`
}

export function chromiumManifestSignatureName(
  version: string,
  platform: ChromiumReleasePlatform,
  arch: ChromiumReleaseArch,
): string {
  return `${chromiumManifestName(version, platform, arch)}.sig`
}

export function chromiumManifestArtifacts(version: string): string[] {
  return STABLE_TARGETS.flatMap(({ platform, arch }) => [
    chromiumManifestName(version, platform, arch),
    chromiumManifestSignatureName(version, platform, arch),
  ])
}

export function chromiumReleaseTarget(
  platform: ChromiumReleasePlatform,
  arch: ChromiumReleaseArch,
  browserVersion: string,
  revision: string,
): ChromiumReleaseTarget | null {
  if (platform === "darwin") {
    const suffix = arch === "arm64" ? "mac-arm64" : "mac-x64"
    return releaseTarget(PLAYWRIGHT_CFT_ORIGINS, {
      platform,
      arch,
      name: `chrome-${suffix}.zip`,
      path: `builds/cft/${browserVersion}/${suffix}/chrome-${suffix}.zip`,
      executable: `chrome-${suffix}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    })
  }
  if (platform === "linux") {
    if (arch === "arm64") {
      return releaseTarget(PLAYWRIGHT_CHROMIUM_ORIGINS, {
        platform,
        arch,
        name: "chromium-linux-arm64.zip",
        path: `builds/chromium/${revision}/chromium-linux-arm64.zip`,
        executable: "chrome-linux/chrome",
      })
    }
    return releaseTarget(PLAYWRIGHT_CFT_ORIGINS, {
      platform,
      arch,
      name: "chrome-linux64.zip",
      path: `builds/cft/${browserVersion}/linux64/chrome-linux64.zip`,
      executable: "chrome-linux64/chrome",
    })
  }
  if (platform === "win32" && arch === "x64") {
    return releaseTarget(PLAYWRIGHT_CFT_ORIGINS, {
      platform,
      arch,
      name: "chrome-win64.zip",
      path: `builds/cft/${browserVersion}/win64/chrome-win64.zip`,
      executable: "chrome-win64/chrome.exe",
    })
  }
  return null
}

function releaseTarget(origins: readonly string[], target: Omit<ChromiumReleaseTarget, "urls">): ChromiumReleaseTarget {
  return {
    ...target,
    urls: origins.map((origin) => `${origin}/${target.path}`),
  }
}
