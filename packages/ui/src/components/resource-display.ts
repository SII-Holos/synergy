import type { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { SemanticIconTokenName } from "./semantic-icon"

const readable = (value: string) => {
  try {
    return decodeURI(value.replace(/%25/gi, "%2525"))
  } catch {
    return value
  }
}

function githubTarget(url: URL) {
  const parts = url.pathname.slice(1).split("/")
  if (
    !/^https?:$/.test(url.protocol) ||
    url.hostname !== "github.com" ||
    url.port ||
    parts[2] !== "blob" ||
    parts.length < 5 ||
    parts.some((part) => !part)
  )
    return
  const tail = url.href.match(/[?#].*$/)?.[0] ?? ""
  const lines = url.hash.match(/^#L(\d+)(?:-L(\d+))?$/)
  const suffix = lines
    ? `:${lines[1]}${lines[2] ? `–${lines[2]}` : ""}${readable(tail.slice(0, tail.indexOf("#")))}`
    : readable(tail)
  return {
    url: url.href,
    owner: readable(parts[0]!),
    repository: readable(parts[1]!),
    ref: parts[3]!,
    path: parts.slice(4),
    route: readable(parts.slice(2).join("/")),
    suffix,
    label: `${readable(parts[1]!)} / ${readable(parts.at(-1)!)}${suffix}`,
  }
}

export function resourceDisplay(
  reference: ResourceReference.Target,
  peers: readonly ResourceReference.Target[] = [],
): {
  label: string
  source: string
  icon?: SemanticIconTokenName
  file?: string
  disambiguatedLabel?: string
} {
  if (reference.kind === "url") {
    const url = new URL(reference.url)
    const icon = url.hostname === "github.com" ? "github.main" : "browser.main"
    const target = githubTarget(url)
    if (!target)
      return {
        label: /^https?:$/.test(url.protocol)
          ? `${url.host}${readable(url.pathname === "/" ? "" : url.pathname)}${readable(url.href.match(/[?#].*$/)?.[0] ?? "")}`
          : reference.url,
        source: url.hostname || url.protocol.slice(0, -1),
        icon,
      }
    let label = target.label
    let collisions = peers.flatMap((peer) => {
      if (peer.kind !== "url") return []
      const candidate = githubTarget(new URL(peer.url))
      return candidate && candidate.label === target.label && candidate.url !== target.url ? [candidate] : []
    })
    if (collisions.length) {
      const owner = collisions.some((peer) => peer.owner !== target.owner)
      collisions = collisions.filter((peer) => peer.owner === target.owner)
      const ref = collisions.some((peer) => peer.ref !== target.ref)
      const commit = /^[a-f\d]{40}$/i.test(target.ref) && collisions.every((peer) => /^[a-f\d]{40}$/i.test(peer.ref))
      const repository = `${owner ? `${target.owner}/` : ""}${target.repository}${ref && commit ? `@${target.ref}` : ""}`
      if (ref && !commit) label = `${repository} / ${target.route}${target.suffix}`
      else {
        collisions = collisions.filter((peer) => peer.ref === target.ref)
        let depth = 1
        while (
          depth < target.path.length &&
          collisions.some(
            (peer) => readable(peer.path.slice(-depth).join("/")) === readable(target.path.slice(-depth).join("/")),
          )
        )
          depth++
        const path = readable(target.path.slice(-depth).join("/"))
        const root = collisions.some((peer) => readable(peer.path.slice(-depth).join("/")) === path)
        label = collisions.some((peer) => peer.route === target.route)
          ? reference.url
          : `${repository} / ${root ? "./" : ""}${path}${target.suffix}`
      }
    }
    return {
      label,
      source: url.hostname,
      icon,
      disambiguatedLabel: `${target.owner}/${target.repository} / ${target.route}${target.suffix}`,
    }
  }
  if (reference.kind === "note") return { label: reference.id, source: "Note", icon: "notes.main" }
  if (reference.kind === "workspace-file" || reference.kind === "asset") {
    const file = reference.kind === "workspace-file" ? reference.path : reference.url
    const location = reference.location
    const label =
      location?.kind === "text" ? `${file}:${location.line}${location.endLine ? `–${location.endLine}` : ""}` : file
    return { label, source: file, file }
  }
  return {
    label:
      reference.kind === "anchor" ? reference.id : reference.kind === "unavailable" ? reference.value : reference.url,
    source: "",
    icon: "browser.main",
  }
}
