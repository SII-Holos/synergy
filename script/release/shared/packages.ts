import path from "path"
import type { SandboxRuntimeTarget } from "./build/sandbox-assets"

export const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
export const RELEASE_STATE_DIR = path.join(REPO_ROOT, ".release")
export const NPM_REGISTRY = "https://registry.npmjs.org"
export const RELEASE_TAG_PREFIX = "v"

interface ReleasePackage {
  directory: string
  registry: string | null
  versioned: boolean
}

export const RELEASE_CATALOG = {
  sdk: { directory: "packages/sdk/js", registry: "@ericsanchezok/synergy-sdk", versioned: true },
  util: { directory: "packages/util", registry: "@ericsanchezok/synergy-util", versioned: true },
  secretDetection: {
    directory: "packages/secret-detection",
    registry: "@ericsanchezok/synergy-secret-detection",
    versioned: true,
  },
  linkProtocol: {
    directory: "packages/synergy-link-protocol",
    registry: "@ericsanchezok/synergy-link-protocol",
    versioned: true,
  },
  plugin: { directory: "packages/plugin", registry: "@ericsanchezok/synergy-plugin", versioned: true },
  pluginKit: { directory: "packages/plugin-kit", registry: "@ericsanchezok/synergy-plugin-kit", versioned: true },
  presets: { directory: "packages/presets", registry: "@ericsanchezok/synergy-presets", versioned: true },
  cli: { directory: "packages/cli", registry: "@ericsanchezok/synergy-cli", versioned: true },
  harness: { directory: "packages/harness", registry: "@ericsanchezok/synergy-harness", versioned: true },
  agentRuntime: {
    directory: "packages/agent-runtime",
    registry: "@ericsanchezok/synergy-agent-runtime",
    versioned: true,
  },
  localRuntime: {
    directory: "packages/local-runtime",
    registry: "@ericsanchezok/synergy-local-runtime",
    versioned: true,
  },
  browser: { directory: "packages/browser-core", registry: "@ericsanchezok/synergy-browser-core", versioned: true },
  computer: {
    directory: "packages/computer-protocol",
    registry: "@ericsanchezok/synergy-computer-protocol",
    versioned: true,
  },
  browserRuntime: {
    directory: "packages/browser-runtime",
    registry: "@ericsanchezok/synergy-browser-runtime",
    versioned: true,
  },
  computerRuntime: {
    directory: "packages/computer-runtime",
    registry: "@ericsanchezok/synergy-computer-runtime",
    versioned: true,
  },
  library: { directory: "packages/library", registry: "@ericsanchezok/synergy-library", versioned: true },
  note: { directory: "packages/note", registry: "@ericsanchezok/synergy-note", versioned: true },
  connections: { directory: "packages/connections", registry: "@ericsanchezok/synergy-connections", versioned: true },
  pluginHost: { directory: "packages/plugin-host", registry: "@ericsanchezok/synergy-plugin-host", versioned: true },
  mcp: { directory: "packages/mcp", registry: "@ericsanchezok/synergy-mcp", versioned: true },
  lsp: { directory: "packages/lsp", registry: "@ericsanchezok/synergy-lsp", versioned: true },
  formatter: { directory: "packages/formatter", registry: "@ericsanchezok/synergy-formatter", versioned: true },
  acp: { directory: "packages/acp", registry: "@ericsanchezok/synergy-acp", versioned: true },
  external_agents: {
    directory: "packages/external-agents",
    registry: "@ericsanchezok/synergy-external-agents",
    versioned: true,
  },
  link_client: { directory: "packages/link-client", registry: "@ericsanchezok/synergy-link-client", versioned: true },
  code_tools: { directory: "packages/code-tools", registry: "@ericsanchezok/synergy-code-tools", versioned: true },
  server: { directory: "packages/server", registry: "@ericsanchezok/synergy-server", versioned: true },
  workbench: { directory: "packages/workbench", registry: "@ericsanchezok/synergy-workbench", versioned: true },
  workflows: { directory: "packages/workflows", registry: "@ericsanchezok/synergy-workflows", versioned: true },
  media: { directory: "packages/media", registry: "@ericsanchezok/synergy-media", versioned: true },
  testing: { directory: "packages/testing", registry: null, versioned: true },
  web: { directory: "apps/web", registry: null, versioned: true },
  desktop: { directory: "apps/desktop", registry: null, versioned: true },
  ui: { directory: "packages/ui", registry: null, versioned: false },
  link: { directory: "packages/synergy-link", registry: null, versioned: false },
  benchmark: { directory: "benchmark", registry: null, versioned: false },
} as const satisfies Record<string, ReleasePackage>

export type ReleasePackageID = keyof typeof RELEASE_CATALOG
export const NATIVE_TARGETS: readonly SandboxRuntimeTarget[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
] as const
export const GENERATED_REGISTRY_PACKAGES = [
  "@ericsanchezok/synergy",
  ...["core", "full", "web", "desktop", "web-app"].map((id) => `@ericsanchezok/synergy-${id}`),
  ...NATIVE_TARGETS.map(
    (target) =>
      `@ericsanchezok/synergy-native-${target.os}-${target.arch}${target.os === "linux" ? `-${target.abi ?? "glibc"}` : ""}`,
  ),
]
export const DESKTOP_APP_PACKAGE = "@ericsanchezok/synergy-desktop-app"

export const RUNTIME_RELEASE_TARGETS = {
  core: {
    package: "cli",
    entrypoint: "src/launcher.ts",
    executable: "synergy",
    registry: "@ericsanchezok/synergy-cli",
  },
  full: { package: "cli", entrypoint: "src/launcher.ts", executable: "synergy", registry: "@ericsanchezok/synergy" },
} as const satisfies Record<
  string,
  { package: ReleasePackageID; entrypoint: string; executable: string; registry: string }
>

export type RuntimeArtifactProfile = keyof typeof RUNTIME_RELEASE_TARGETS

export function releasePackageDirectory(id: ReleasePackageID): string {
  return path.join(REPO_ROOT, RELEASE_CATALOG[id].directory)
}

export const VERSION_MANAGED_PACKAGE_PATHS = Object.values(RELEASE_CATALOG)
  .filter((entry) => entry.versioned)
  .map((entry) => path.join(REPO_ROOT, entry.directory, "package.json"))

export const FIXED_REGISTRY_PACKAGES = [
  ...Object.values(RELEASE_CATALOG).flatMap((entry) => (entry.registry ? [entry.registry] : [])),
  ...GENERATED_REGISTRY_PACKAGES,
]

export const SDK_DIR = releasePackageDirectory("sdk")
export const UTIL_DIR = releasePackageDirectory("util")
export const SYNERGY_LINK_PROTOCOL_DIR = releasePackageDirectory("linkProtocol")
export const PLUGIN_DIR = releasePackageDirectory("plugin")
export const PLUGIN_KIT_DIR = releasePackageDirectory("pluginKit")
export const PRESETS_DIR = releasePackageDirectory("presets")
export const CLI_DIR = releasePackageDirectory("cli")
export const HARNESS_DIR = releasePackageDirectory("harness")
export const LOCAL_RUNTIME_DIR = releasePackageDirectory("localRuntime")
export const WEB_DIR = releasePackageDirectory("web")
export const DESKTOP_DIR = releasePackageDirectory("desktop")
export const SYNERGY_LINK_DIR = releasePackageDirectory("link")
export const SYNERGY_LINK_DIST_DIR = path.join(SYNERGY_LINK_DIR, "dist")
export const WEB_DIST_DIR = path.join(WEB_DIR, "dist")
export const PRESETS_DIST_DIR = path.join(PRESETS_DIR, "dist")
export const CORE_RUNTIME_DIST_DIR = path.join(CLI_DIR, "dist")
export const DESKTOP_RELEASE_DIR = path.join(DESKTOP_DIR, "release")

export type ReleaseKind = "dev" | "stable"

export type ReleaseState = {
  kind: ReleaseKind
  version: string
  channel: string
  promoteTag: string | null
  createdAt: string
  registryPackages: string[]
  binaryAssets: string[]
  binaryChecksums: string | null
  desktopAssets: string[]
  desktopChecksums: string | null
  desktopUpdateMetadata: string[]
  releaseTag: string | null
  githubReleaseID: string | null
  githubReleaseTagName: string | null
}
