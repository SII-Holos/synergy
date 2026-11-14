import path from "node:path"

export function explicitOrganizationHome() {
  const home = process.env.SYNERGY_HOME
  if (!home || !path.isAbsolute(home)) throw new Error("Set SYNERGY_HOME to an absolute dedicated organization Home")
  const root = process.env.SYNERGY_RUNTIME_ROOT
  if (root && path.resolve(root) !== path.join(path.resolve(home), ".synergy"))
    throw new Error("Organization commands require SYNERGY_RUNTIME_ROOT to match SYNERGY_HOME/.synergy")
  return path.resolve(home)
}
