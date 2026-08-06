/** Shared scalar-safe extraction for Browser tool cards and permission-dock summaries. */

export function browserRecord(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined
}

export function browserNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function shortBrowserText(value: unknown, max = 42): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function firstBrowserText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = shortBrowserText(value)
    if (text) return text
  }
  return undefined
}

export function browserAction(input: any = {}) {
  return browserRecord(input.action)
}

export function browserTarget(input: any = {}, metadata: any = {}) {
  return browserRecord(metadata.target) ?? browserRecord(browserAction(input)?.target)
}

export function browserCondition(input: any = {}, metadata: any = {}) {
  return browserRecord(metadata.condition) ?? browserRecord(input.condition)
}

export function browserActionType(input: any = {}, metadata: any = {}) {
  return shortBrowserText(firstBrowserText(metadata.actionType, browserAction(input)?.type, input.type), 18)
}

export function browserNavigationAction(input: any = {}, metadata: any = {}) {
  return shortBrowserText(firstBrowserText(metadata.action, input.action), 18)
}

export function browserUrl(input: any = {}, metadata: any = {}) {
  return firstBrowserText(metadata.url, input.url)
}

export function joinBrowserSummary(...parts: Array<string | undefined>) {
  const summary = parts.filter(Boolean).join(" · ")
  return summary || undefined
}

export function formatBrowserTarget(target: unknown): string | undefined {
  const descriptor = browserRecord(target)
  if (!descriptor) return undefined
  const kind = shortBrowserText(descriptor.kind, 18)
  const role = shortBrowserText(descriptor.role, 24)
  const name = shortBrowserText(descriptor.name)
  const ref = shortBrowserText(descriptor.ref, 24)
  const targetType = role ?? (kind === "role" ? undefined : kind)
  return shortBrowserText(joinBrowserSummary(targetType, name ?? ref))
}

export function browserTargetName(target: unknown) {
  const descriptor = browserRecord(target)
  return shortBrowserText(descriptor?.name) ?? formatBrowserTarget(descriptor)
}

export function formatBrowserCondition(condition: unknown): string | undefined {
  const descriptor = browserRecord(condition)
  const type = shortBrowserText(descriptor?.type, 18)
  if (!descriptor || !type) return undefined

  if (type === "load") return joinBrowserSummary(type, shortBrowserText(descriptor.state, 22))
  if (type === "url" || type === "title") {
    const expected = shortBrowserText(descriptor.value, 28)
    return expected ? `${type} "${expected}"` : type
  }
  if (type === "text") {
    const values = Array.isArray(descriptor.values)
      ? descriptor.values.filter((value): value is string => typeof value === "string" && !!value.trim())
      : []
    const expected = shortBrowserText(values[0], 28)
    if (!expected) return type
    const remainder = values.length > 1 ? ` +${values.length - 1}` : ""
    return `${type} "${expected}"${remainder}`
  }
  if (type === "locator") {
    return shortBrowserText(
      joinBrowserSummary(type, formatBrowserTarget(descriptor.locator), shortBrowserText(descriptor.state, 18)),
    )
  }
  return type
}

export function browserElementLabel(value: unknown) {
  const count = browserNumber(value)
  return count === undefined ? undefined : `${count} elements`
}
