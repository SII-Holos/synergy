export const DESKTOP_RELEASE_PLATFORMS = ["darwin", "win32", "linux"] as const
export const DESKTOP_RELEASE_ARCHES = ["x64", "arm64"] as const

export type DesktopReleasePlatform = (typeof DESKTOP_RELEASE_PLATFORMS)[number]
export type DesktopReleaseArch = (typeof DESKTOP_RELEASE_ARCHES)[number]

const DESKTOP_RELEASE_TARGETS: ReadonlyArray<{
  platform: DesktopReleasePlatform
  arch: DesktopReleaseArch
}> = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
]

export function desktopPrimaryArtifactName(
  version: string,
  platform: DesktopReleasePlatform,
  arch: DesktopReleaseArch,
): string {
  const extension = platform === "darwin" ? "pkg" : platform === "win32" ? "exe" : "deb"
  const artifactArch = platform === "linux" && arch === "x64" ? "x86_64" : arch
  return `Synergy-${platform}-${artifactArch}-${version}.${extension}`
}

export function desktopPortableArtifactNames(version: string): string[] {
  return DESKTOP_RELEASE_TARGETS.flatMap(({ platform, arch }) => {
    const artifactArch = platform === "linux" && arch === "x64" ? "x86_64" : arch
    const extensions = platform === "darwin" ? ["dmg", "zip"] : platform === "win32" ? ["zip"] : ["AppImage", "tar.gz"]
    return extensions.map((extension) => `Synergy-${platform}-${artifactArch}-${version}.${extension}`)
  })
}

export function expectedDesktopPrimaryArtifacts(version: string): string[] {
  return DESKTOP_RELEASE_TARGETS.map(({ platform, arch }) => desktopPrimaryArtifactName(version, platform, arch))
}

export function desktopChecksumsName(version: string): string {
  return `Synergy-${version}-checksums.txt`
}

export function browserHostArtifactName(
  version: string,
  platform: DesktopReleasePlatform,
  arch: DesktopReleaseArch,
): string {
  return `synergy-browser-host-${platform}-${arch}-${version}.zip`
}

export function browserHostManifestName(
  version: string,
  platform: DesktopReleasePlatform,
  arch: DesktopReleaseArch,
): string {
  return `synergy-browser-host-${platform}-${arch}-${version}.manifest.json`
}

export function browserHostManifestSignatureName(
  version: string,
  platform: DesktopReleasePlatform,
  arch: DesktopReleaseArch,
): string {
  return `${browserHostManifestName(version, platform, arch)}.sig`
}

export function expectedBrowserHostArtifacts(version: string): string[] {
  return DESKTOP_RELEASE_PLATFORMS.flatMap((platform) =>
    DESKTOP_RELEASE_ARCHES.flatMap((arch) => [
      browserHostArtifactName(version, platform, arch),
      browserHostManifestName(version, platform, arch),
      browserHostManifestSignatureName(version, platform, arch),
    ]),
  )
}

export function isDesktopUpdateMetadata(name: string): boolean {
  return /^latest.*\.ya?ml$/.test(name)
}
