import type { Navigator } from "@solidjs/router"

export type SessionNavigationIntent = "open" | "return-to-parent"

export type SessionNavigate = Navigator

type HistoryStateWriter = Pick<History, "state" | "replaceState">

export function normalizeSessionRoutePath(path: string, basePath?: string) {
  const normalize = (value: string) => {
    const pathname = value.split(/[?#]/, 1)[0] || "/"
    const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`
    return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash
  }

  const normalizedPath = normalize(path)
  const normalizedBase = basePath ? normalize(basePath) : ""
  if (!normalizedBase || normalizedBase === "/") return normalizedPath
  if (normalizedPath === normalizedBase) return "/"
  if (normalizedPath.startsWith(`${normalizedBase}/`)) return normalizedPath.slice(normalizedBase.length)
  return normalizedPath
}

export function isSessionNavigationRequestCurrent(input: {
  requestedPath: string
  requestedDepth: number | undefined
  currentPath: string
  currentDepth: number | undefined
  basePath?: string
}) {
  return (
    normalizeSessionRoutePath(input.requestedPath, input.basePath) ===
      normalizeSessionRoutePath(input.currentPath, input.basePath) && input.requestedDepth === input.currentDepth
  )
}

export function sessionRouteReplaceOptions(state: unknown) {
  return { replace: true, state }
}

export function replaceSessionHistoryUrl(history: HistoryStateWriter, url: string) {
  history.replaceState(history.state, "", url)
}

export function navigateResolvedSession(
  navigate: SessionNavigate,
  input: {
    intent: SessionNavigationIntent
    targetPath: string
    currentPath: string
    from: string | undefined
    basePath?: string
  },
) {
  const targetPath = normalizeSessionRoutePath(input.targetPath, input.basePath)
  if (input.intent === "open") {
    const currentPath = normalizeSessionRoutePath(input.currentPath, input.basePath)
    navigate(targetPath, { state: { from: currentPath } })
    return
  }

  if (input.from && normalizeSessionRoutePath(input.from, input.basePath) === targetPath) {
    navigate(-1)
    return
  }

  navigate(targetPath, { replace: true })
}
