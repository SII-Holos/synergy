export type TuiTheme = "system" | "light" | "dark"

export type TuiOptionsInput = {
  baseUrl?: string
  directory?: string
  scopeID?: string
  sessionID?: string
  theme?: TuiTheme
}

export type TuiOptions = {
  baseUrl: string
  directory: string | undefined
  scopeID: string | undefined
  sessionID: string | undefined
  theme: TuiTheme
}

function optionalValue(value: string | undefined, label: string) {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must not be blank`)
  return normalized
}

function normalizeBaseUrl(value: string | undefined) {
  const source = value === undefined ? "http://127.0.0.1:4096" : optionalValue(value, "server URL")!
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error("server URL must be a valid http or https URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("server URL must use http or https")
  }
  if (url.username || url.password) throw new Error("server URL must not contain credentials")
  if (!/^\/*$/.test(url.pathname) || url.search || url.hash) {
    throw new Error("server URL must not contain a path, query, or fragment")
  }
  return url.origin
}

export function normalizeTuiOptions(input: TuiOptionsInput): TuiOptions {
  const directory = optionalValue(input.directory, "directory")
  const scopeID = optionalValue(input.scopeID, "scope")
  if (directory && scopeID) throw new Error("choose either directory or scope, not both")

  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    directory,
    scopeID,
    sessionID: optionalValue(input.sessionID, "session"),
    theme: input.theme ?? "system",
  }
}
