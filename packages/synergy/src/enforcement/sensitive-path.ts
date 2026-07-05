import path from "path"
import { Filesystem } from "../util/filesystem"

export type SensitivePathKind = "synergy_secret" | "credential_root" | "secret_candidate" | "vcs"
export type SensitivePathCategory = "credentials" | "secrets" | "vcs"
export type SensitivePathConfidence = "exact" | "candidate"

export interface SensitivePathOptions {
  mode: "read" | "write"
  workspaceRoot?: string
  originalCheckout?: string
  synergyRoot?: string
}

export interface SensitivePathMatch {
  matched: boolean
  kind?: SensitivePathKind
  reason?: string
  category?: SensitivePathCategory
  confidence?: SensitivePathConfidence
  smartAllowEligible?: boolean
  exactSecretRoot?: boolean
}

const CREDENTIAL_ROOT_PARTS = [".ssh", ".aws", ".gnupg", path.join(".config", "git"), path.join(".config", "gcloud")]

const SECRET_CANDIDATE_PATTERNS = [
  /(^|[/\\])\.env($|\.(?!rc$)[^/\\]+$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|[/\\])id_rsa/i,
  /(^|[/\\])id_ed25519/i,
  /(^|[/\\])credentials$/i,
]

const PLACEHOLDER_ENV_PATTERN = /(^|[/\\])\.env\.(example|template|sample)$/i

function expandHomeDir(input: string): string {
  const stripped = input.replace(/^[\"']/, "").replace(/[\"']$/, "")
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  if (stripped === "~" || stripped === "~/" || stripped === "~\\" || stripped === "$HOME" || stripped === "${HOME}")
    return home
  if (stripped.startsWith("~/") || stripped.startsWith("~\\")) return path.join(home, stripped.slice(2))
  if (stripped.startsWith("$HOME/") || stripped.startsWith("$HOME\\")) return path.join(home, stripped.slice(6))
  if (stripped.startsWith("${HOME}/") || stripped.startsWith("${HOME}\\")) return path.join(home, stripped.slice(8))
  return input
}

function normalizePath(input: string): string {
  return path.normalize(input.replace(/^~[/\\]/, ""))
}

function normalizeForMatch(input: string): string {
  return normalizePath(input).replace(/\\/g, "/").toLowerCase()
}

function isInside(candidate: string, root: string | undefined): boolean {
  if (!root) return false
  return Filesystem.contains(path.resolve(root), path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate))
}

function isSynergyPluginAuth(candidate: string, synergyRoot: string | undefined): boolean {
  if (!synergyRoot) return false
  const rel = path.relative(path.resolve(synergyRoot), path.resolve(candidate)).replace(/\\/g, "/").toLowerCase()
  return /^data\/plugin\/[^/]+\/auth\.json$/.test(rel)
}

function isSynergyAuthRoot(candidate: string, synergyRoot: string | undefined): boolean {
  if (!synergyRoot) return false
  return Filesystem.contains(path.join(path.resolve(synergyRoot), "data", "auth"), path.resolve(candidate))
}

function isCredentialRoot(normalized: string): boolean {
  return CREDENTIAL_ROOT_PARTS.some((part) => {
    const p = part.replace(/\\/g, "/").toLowerCase()
    return normalized === p || normalized.startsWith(p + "/") || normalized.includes("/" + p + "/")
  })
}

function isProjectSynergyPath(candidate: string, workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot) return false
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspaceRoot, candidate)
  const rel = path.relative(path.resolve(workspaceRoot), absolute).replace(/\\/g, "/").toLowerCase()
  return rel === ".synergy" || rel.startsWith(".synergy/")
}

export namespace SensitivePathPolicy {
  export function classify(pathInput: string, options: SensitivePathOptions): SensitivePathMatch {
    if (!pathInput) return { matched: false }
    const normalized = normalizeForMatch(pathInput)
    const homeExpanded = expandHomeDir(pathInput)
    const absoluteCandidate = path.isAbsolute(homeExpanded)
      ? path.normalize(homeExpanded)
      : path.resolve(options.workspaceRoot ?? process.cwd(), homeExpanded)

    if (options.synergyRoot && isSynergyAuthRoot(absoluteCandidate, options.synergyRoot)) {
      return {
        matched: true,
        kind: "synergy_secret",
        reason: "Path is inside Synergy auth secret root",
        category: "credentials",
        confidence: "exact",
        exactSecretRoot: true,
        smartAllowEligible: false,
      }
    }

    if (options.synergyRoot && isSynergyPluginAuth(absoluteCandidate, options.synergyRoot)) {
      return {
        matched: true,
        kind: "synergy_secret",
        reason: "Path is a Synergy plugin auth secret file",
        category: "credentials",
        confidence: "exact",
        exactSecretRoot: true,
        smartAllowEligible: false,
      }
    }

    if (normalized === ".git" || normalized.startsWith(".git/") || normalized.includes("/.git/")) {
      return {
        matched: true,
        kind: "vcs",
        reason: "Path is inside Git metadata",
        category: "vcs",
        confidence: "exact",
        smartAllowEligible: false,
      }
    }

    if (isCredentialRoot(normalized)) {
      return {
        matched: true,
        kind: "credential_root",
        reason: "Path is inside an external credential directory",
        category: "credentials",
        confidence: "exact",
        exactSecretRoot: true,
        smartAllowEligible: false,
      }
    }

    for (const pattern of SECRET_CANDIDATE_PATTERNS) {
      if (!pattern.test(normalized)) continue
      const placeholderEnv = PLACEHOLDER_ENV_PATTERN.test(normalized)
      return {
        matched: true,
        kind: "secret_candidate",
        reason: placeholderEnv
          ? "Path is a dotenv example/template secret candidate"
          : "Path matches secret or credential filename pattern",
        category: normalized.includes(".env") ? "secrets" : "credentials",
        confidence: "candidate",
        smartAllowEligible: placeholderEnv,
        exactSecretRoot: false,
      }
    }

    if (isProjectSynergyPath(homeExpanded, options.workspaceRoot)) return { matched: false }
    if (options.synergyRoot && isInside(absoluteCandidate, options.synergyRoot)) return { matched: false }

    return { matched: false }
  }
}
