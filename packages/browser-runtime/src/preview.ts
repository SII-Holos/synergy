import { previewHTML } from "./preview-html"
import { previewURL, requestPreview, type BrowserPreviewOptions } from "./preview-network"
import { BrowserPreviewFailure, type BrowserPreviewResult } from "./preview-types"

export { BrowserPreviewInputSchema, BrowserPreviewResultSchema } from "./preview-types"
export type { BrowserPreviewResult } from "./preview-types"

function authenticationURL(url: URL) {
  return (
    /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|auth|oauth|sso|authenticate)(?:\/|$)/i.test(url.pathname) ||
    /^(?:login|signin|accounts|auth|sso)\./i.test(url.hostname)
  )
}

function githubSource(url: URL) {
  if (url.hostname !== "github.com" || url.port) return
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([\da-f]{40})\/(.+)$/i.exec(url.pathname)
  if (!match || match.slice(1).some((part) => /%2f|%5c/i.test(part))) return
  const [, owner, repository, commit, path] = match
  const raw = new URL(`https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${path}`)
  return { raw, repository, commit, path }
}

function excerpt(content: string, original: URL, source: NonNullable<ReturnType<typeof githubSource>>) {
  const range = original.hash ? /^#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(original.hash) : undefined
  if (original.hash && !range) throw new BrowserPreviewFailure("invalid_range")
  const startLine = Number(range?.[1] ?? 1)
  const requestedEnd = Number(range?.[2] ?? startLine)
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  if (content.endsWith("\n")) lines.pop()
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(requestedEnd) ||
    requestedEnd < startLine ||
    startLine > lines.length
  ) {
    throw new BrowserPreviewFailure("invalid_range")
  }
  const endLine = Math.min(requestedEnd, startLine + 7, lines.length)
  const text = lines.slice(startLine - 1, endLine).join("\n")
  if (!text.trim() || text.includes("\0")) throw new BrowserPreviewFailure("empty_metadata")
  const extension = source.path.split(".").at(-1)?.toLowerCase() ?? ""
  const language = (
    {
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      py: "python",
      rs: "rust",
      go: "go",
      json: "json",
      md: "markdown",
      sh: "bash",
      css: "css",
      html: "html",
      yml: "yaml",
      yaml: "yaml",
    } as Record<string, string>
  )[extension]
  return {
    title: `${source.repository} / ${source.path.split("/").at(-1)}`,
    code: { text, startLine, ...(language ? { language } : {}) },
    meta: `Excerpt · ${source.commit} · lines ${startLine}–${endLine}${range ? ` (requested ${startLine}–${requestedEnd})` : ""}`,
  }
}

export namespace BrowserPreview {
  export async function read(
    input: { url: string },
    options: BrowserPreviewOptions = {},
  ): Promise<BrowserPreviewResult> {
    const fallback: BrowserPreviewResult = { source: "Website", title: "Website" }
    try {
      const original = new URL(input.url)
      if (original.protocol === "http:" || original.protocol === "https:") {
        fallback.source = original.hostname
        fallback.title = original.hostname
        fallback.path = original.pathname + original.hash
      }
    } catch {}
    const timeout = new AbortController()
    const duration = Math.min(10_000, Math.max(1, options.timeoutMs || 10_000))
    const timer = setTimeout(() => timeout.abort(), duration)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
    try {
      signal.throwIfAborted()
      previewURL(input.url)
      const original = new URL(input.url)
      const source = githubSource(original)
      if (!source && authenticationURL(original)) throw new BrowserPreviewFailure("authentication_required")
      let url = source?.raw ?? original
      const seen = new Set<string>()
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted()
        url = previewURL(url.href)
        if (seen.has(url.href)) throw new BrowserPreviewFailure("redirect_loop")
        seen.add(url.href)
        const response = await requestPreview(url, !!source, options, signal)
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.location) throw new BrowserPreviewFailure("http_error")
          const next = previewURL(new URL(response.location, url).href)
          if (authenticationURL(next)) throw new BrowserPreviewFailure("authentication_required")
          if (source || (original.pathname !== "/" && next.pathname === "/"))
            throw new BrowserPreviewFailure("target_changed")
          if (redirects >= 5) throw new BrowserPreviewFailure("redirect_limit")
          url = next
          continue
        }
        if (response.status === 401 || response.status === 403)
          throw new BrowserPreviewFailure("authentication_required")
        if (response.status === 429) throw new BrowserPreviewFailure("bot_challenge")
        if (response.status < 200 || response.status >= 300) throw new BrowserPreviewFailure("http_error")
        const metadata = source
          ? excerpt(new TextDecoder().decode(response.bytes), original, source)
          : await previewHTML(response.bytes)
        signal.throwIfAborted()
        return { ...fallback, ...metadata, title: metadata.title || fallback.title }
      }
    } catch (error) {
      const unavailable = options.signal?.aborted
        ? "cancelled"
        : timeout.signal.aborted
          ? "timeout"
          : error instanceof BrowserPreviewFailure
            ? error.reason
            : "network_error"
      return { ...fallback, unavailable }
    } finally {
      clearTimeout(timer)
    }
  }
}
