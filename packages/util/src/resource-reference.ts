import { z } from "zod"
import { AssetReference } from "./asset-reference"

export namespace ResourceReference {
  const position = z.number().int().positive().max(2_147_483_647)
  export const Workspace = z.object({ id: z.string().min(1), generation: position, root: z.string() })
  export type Workspace = z.infer<typeof Workspace>
  export const Context = z.discriminatedUnion("state", [
    z.object({ state: z.literal("bound"), workspace: Workspace, directory: z.string() }),
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("unresolved") }),
  ])
  export type Context = z.infer<typeof Context>
  export const Location = z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        line: position,
        column: position.optional(),
        endLine: position.optional(),
        endColumn: position.optional(),
      }),
      z.object({ kind: z.literal("heading"), id: z.string() }),
      z.object({ kind: z.literal("page"), page: position }),
    ])
    .refine(
      (value) =>
        value.kind !== "text" ||
        (value.endLine ?? value.line) > value.line ||
        ((value.endLine ?? value.line) === value.line && (value.endColumn ?? value.column ?? 1) >= (value.column ?? 1)),
    )
  export type Location = z.infer<typeof Location>
  export type Target =
    | { kind: "workspace-file"; path: string; location?: Location }
    | { kind: "asset"; url: string; location?: Location }
    | { kind: "url"; url: string }
    | { kind: "image"; url: string }
    | { kind: "anchor"; id: string }
    | { kind: "unavailable"; value: string; reason: "invalid-target" | "invalid-location" | "unsupported-protocol" }

  const controls = /[\u0000-\u001f\u007f]/
  const absolute = (value: string) => value.startsWith("/") || /^[a-z]:\//i.test(value)
  const slash = (value: string) => value.replaceAll("\\", "/")

  function textLocation(match: RegExpMatchArray): Location {
    return {
      kind: "text",
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
      ...(match[4] ? { endLine: Number(match[4]) } : {}),
      ...(match[5] ? { endColumn: Number(match[5]) } : {}),
    }
  }

  export function parse(input: string): Target {
    const value = input.trim()
    const unavailable = (reason: Extract<Target, { kind: "unavailable" }>["reason"] = "invalid-target"): Target => ({
      kind: "unavailable",
      value: input,
      reason,
    })
    if (!value || controls.test(value)) return unavailable()
    if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;[^,]*)?,/i.test(value))
      return { kind: "image", url: value }
    if (value.startsWith("blob:")) {
      if (/^blob:null\/[^/]+$/.test(value)) return { kind: "image", url: value }
      try {
        const source = new URL(value.slice(5))
        if (["http:", "https:"].includes(source.protocol) && source.hostname && source.pathname !== "/")
          return { kind: "image", url: value }
      } catch {}
      return unavailable("unsupported-protocol")
    }
    if (/^(https?:|mailto:|tel:)/i.test(value)) {
      try {
        const url = new URL(value)
        if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return unavailable()
        return { kind: "url", url: value }
      } catch {
        return unavailable()
      }
    }
    if (value.startsWith("//")) return parse(`https:${value}`)
    try {
      if (value.startsWith("#")) return { kind: "anchor", id: decodeURIComponent(value.slice(1)) }
      let path = value
      let location: Location | undefined
      const hash = path.indexOf("#")
      if (hash >= 0) {
        const fragment = path.slice(hash + 1)
        const lines = fragment.match(/^()L(\d+)(?:C(\d+))?(?:[-–]L?(\d+)(?:C(\d+))?)?$/)
        location = lines
          ? textLocation(lines)
          : /^page=\d+$/.test(fragment)
            ? { kind: "page", page: Number(fragment.slice(5)) }
            : { kind: "heading", id: decodeURIComponent(fragment) }
        if (/^L\d|^page=/.test(fragment) && location.kind === "heading") return unavailable("invalid-location")
        path = path.slice(0, hash)
      } else {
        const lines = path.match(/^(.*?):(\d+)(?::(\d+))?(?:[-–](\d+)(?::(\d+))?)?$/)
        if (lines) {
          path = lines[1]!
          location = textLocation(lines)
        }
      }
      if (location && !Location.safeParse(location).success) return unavailable("invalid-location")
      if (path.startsWith("asset://") || path.startsWith("/asset/")) {
        const asset = AssetReference.parse(path.startsWith("/asset/") ? `asset://${path.slice(7)}` : path)
        return asset ? { kind: "asset", url: asset.url, ...(location ? { location } : {}) } : unavailable()
      }
      if (/^file:/i.test(path)) {
        const url = new URL(path)
        if (url.search || url.username || url.password || url.port) return unavailable()
        path = decodeURIComponent(url.pathname)
        if (url.hostname && url.hostname !== "localhost") path = `//${url.hostname}${path}`
        else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
      } else {
        if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return unavailable("unsupported-protocol")
        if (path.includes("?")) return unavailable()
        path = decodeURIComponent(path)
      }
      if (!path || controls.test(path)) return unavailable()
      return { kind: "workspace-file", path: slash(path), ...(location ? { location } : {}) }
    } catch {
      return unavailable()
    }
  }

  export function normalizePath(value: string): string | undefined {
    if (controls.test(value) || absolute(slash(value))) return
    const parts: string[] = []
    for (const part of slash(value).split("/")) {
      if (!part || part === ".") continue
      if (part === "..") {
        if (!parts.length) return
        parts.pop()
      } else parts.push(part)
    }
    return parts.join("/")
  }

  export function format(reference: Target, location?: Location): string {
    if (reference.kind === "unavailable") return reference.value
    if (reference.kind === "anchor") return `#${encodeURIComponent(reference.id)}`
    if (reference.kind === "url" || reference.kind === "image") return reference.url
    const target =
      reference.kind === "asset"
        ? reference.url
        : absolute(slash(reference.path))
          ? fileUrl(reference.path)
          : reference.path.split("/").map(encodeURIComponent).join("/")
    const position = location ?? reference.location
    if (!position) return target
    if (position.kind === "heading") return `${target}#${encodeURIComponent(position.id)}`
    if (position.kind === "page") return `${target}#page=${position.page}`
    const start = `L${position.line}${position.column === undefined ? "" : `C${position.column}`}`
    const end =
      position.endLine !== undefined || position.endColumn !== undefined
        ? `-L${position.endLine ?? position.line}${position.endColumn === undefined ? "" : `C${position.endColumn}`}`
        : ""
    return `${target}#${start}${end}`
  }

  export function fileUrl(path: string): string {
    const value = slash(path)
    if (!absolute(value) || controls.test(value)) throw new Error("A file URL requires an absolute path")
    const encoded = value
      .split("/")
      .map((part, index) => (index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)))
      .join("/")
    return value.startsWith("//") ? `file:${encoded}` : `file://${value.startsWith("/") ? "" : "/"}${encoded}`
  }

  export function resolvePath(input: string, context: Context): string | undefined {
    if (context.state !== "bound" || input.startsWith("~") || controls.test(input)) return
    const value = slash(input)
    const root = slash(context.workspace.root).replace(/\/$/, "")
    if (absolute(value)) {
      if (context.workspace.root === "/" && value.startsWith("/")) return normalizePath(value.slice(1))
      if (!root) return
      const windows = /^[a-z]:\//i.test(root) || root.startsWith("//")
      const compare = windows ? value.toLowerCase() : value
      const base = windows ? root.toLowerCase() : root
      if (compare === base) return ""
      if (!compare.startsWith(`${base}/`)) return
      return normalizePath(value.slice(root.length + 1))
    }
    return normalizePath(context.directory ? `${context.directory}/${value}` : value)
  }

  export function capture(workspace: { id?: string; generation?: number; path: string } | null | undefined): Context {
    if (!workspace) return { state: "none" }
    const parsed = Workspace.safeParse({ id: workspace.id, generation: workspace.generation, root: workspace.path })
    return parsed.success ? { state: "bound", workspace: parsed.data, directory: "" } : { state: "unresolved" }
  }
}
