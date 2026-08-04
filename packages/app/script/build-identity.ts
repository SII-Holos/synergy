export interface AppBuildIdentityInput {
  command: "serve" | "build"
  packageVersion: string
  sourceBuild?: boolean
  revision?: string
  dirty?: boolean
}

export interface AppBuildIdentity {
  label: string
  sourcemap: boolean
}

export function resolveAppBuildIdentity(input: AppBuildIdentityInput): AppBuildIdentity {
  const local = input.command === "serve" || input.sourceBuild === true
  if (!local) return { label: input.packageVersion, sourcemap: false }

  const revision = input.revision?.trim().slice(0, 9)
  const label = revision ? `local@${revision}${input.dirty ? "+dirty" : ""}` : "local"
  return { label, sourcemap: true }
}
