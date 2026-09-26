import { z } from "zod"

const Identifier = z.string().regex(/^[a-z][a-z0-9.-]*$/)
export const SynergyPackageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const RelativeFile = z.string().refine(
  (value) =>
    value.startsWith("./") &&
    value.length > 2 &&
    !/[\\\0?#]/.test(value) &&
    value
      .slice(2)
      .split("/")
      .every((part) => part !== ".." && part !== "." && part !== ""),
  "Package files must be relative paths inside the package",
)
const Packages = z.record(SynergyPackageName, z.string().min(1))
const common = {
  formatVersion: z.literal(1),
  id: Identifier,
  version: Version,
  compatibility: z.object({ synergy: z.string().min(1).max(256) }).strict(),
}

export const ComponentPackage = z
  .object({
    ...common,
    kind: z.literal("component"),
    apiVersion: z.literal(1),
    entry: RelativeFile,
    export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
    runners: z
      .record(
        Identifier,
        z.object({ entry: RelativeFile, export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/) }).strict(),
      )
      .optional(),
    requires: z.record(Identifier, z.string().min(1)).optional(),
    packages: Packages.optional(),
  })
  .strict()

export const PresetPackage = z
  .object({
    ...common,
    kind: z.literal("preset"),
    packages: Packages,
  })
  .strict()

export const AppArtifact = z
  .object({
    target: z.enum(["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64", "linux-arm64", "linux-x64"]),
    url: z.url().refine((value) => new URL(value).protocol === "https:", "Application artifacts require HTTPS"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    executable: RelativeFile,
    format: z.enum(["zip", "dmg", "exe", "AppImage", "deb", "tar.gz"]),
    signing: z.discriminatedUnion("type", [
      z.object({ type: z.literal("apple"), teamID: z.string().regex(/^[A-Z0-9]{10}$/) }).strict(),
      z.object({ type: z.literal("authenticode"), publisher: z.string().min(1) }).strict(),
      z.object({ type: z.literal("checksum") }).strict(),
    ]),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.target.startsWith("darwin-") && artifact.signing.type !== "apple")
      context.addIssue({ code: "custom", message: "macOS applications require an Apple signing identity" })
    if (artifact.target.startsWith("win32-") && !["authenticode", "checksum"].includes(artifact.signing.type))
      context.addIssue({
        code: "custom",
        message: "Windows applications require an Authenticode publisher or explicit checksum-only distribution",
      })
  })

export const SynergyPackage = z.discriminatedUnion("kind", [
  ComponentPackage,
  PresetPackage,
  z.object({ ...common, kind: z.literal("plugin"), manifest: RelativeFile }).strict(),
  z.object({ ...common, kind: z.literal("app"), artifacts: z.array(AppArtifact).min(1) }).strict(),
])

export type SynergyPackage = z.infer<typeof SynergyPackage>
export type ComponentPackage = z.infer<typeof ComponentPackage>
export type PresetPackage = z.infer<typeof PresetPackage>
export type AppArtifact = z.infer<typeof AppArtifact>
