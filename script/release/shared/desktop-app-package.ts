import { z } from "zod"
import { AppArtifact, SynergyPackage } from "../../../packages/plugin/src/package"
import { DESKTOP_RELEASE_TARGETS } from "../../../apps/desktop/src/release-assets"
import { DESKTOP_APP_PACKAGE } from "./packages"

export const DesktopAppReceipt = z.object({ version: z.string(), artifacts: z.array(AppArtifact) }).strict()

export function desktopApplicationArtifacts(version: string, platform?: string) {
  return DESKTOP_RELEASE_TARGETS.filter((target) => !platform || target.platform === platform).map((target) => {
    const { platform, arch } = target
    const format = platform === "linux" ? "AppImage" : "zip"
    const file = `Synergy-${platform}-${platform === "linux" && arch === "x64" ? "x86_64" : arch}-${version}.${format}`
    return {
      file,
      artifact: {
        target: `${platform}-${arch}` as AppArtifact["target"],
        format,
        executable:
          platform === "darwin"
            ? "./Synergy.app/Contents/MacOS/Synergy"
            : platform === "win32"
              ? "./synergy-desktop.exe"
              : "./Synergy.AppImage",
      },
    }
  })
}

export function createDesktopAppPackage(options: { version: string; repository: string; receipts: unknown[] }) {
  const required = desktopApplicationArtifacts(options.version)
  const artifacts: AppArtifact[] = []
  for (const input of options.receipts) {
    const receipt = DesktopAppReceipt.parse(input)
    if (receipt.version !== options.version)
      throw new Error("Desktop application receipt version differs from this release")
    for (const artifact of receipt.artifacts) {
      if (artifacts.some((item) => item.target === artifact.target))
        throw new Error(`Duplicate Desktop target: ${artifact.target}`)
      const expected = required.find((item) => item.artifact.target === artifact.target)
      if (
        !expected ||
        artifact.url !==
          `https://github.com/${options.repository}/releases/download/v${options.version}/${expected.file}` ||
        artifact.executable !== expected.artifact.executable ||
        artifact.format !== expected.artifact.format
      )
        throw new Error(`Desktop artifact identity differs from the release: ${artifact.target}`)
      artifacts.push(artifact)
    }
  }
  for (const item of required)
    if (!artifacts.some((artifact) => artifact.target === item.artifact.target))
      throw new Error(`Missing Desktop target: ${item.artifact.target}`)
  return {
    name: DESKTOP_APP_PACKAGE,
    version: options.version,
    license: "MIT",
    files: [] as string[],
    synergy: SynergyPackage.parse({
      formatVersion: 1,
      kind: "app",
      id: "desktop-app",
      version: options.version,
      compatibility: { synergy: options.version },
      artifacts,
    }),
  }
}
