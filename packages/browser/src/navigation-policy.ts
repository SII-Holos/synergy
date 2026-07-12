export interface BrowserNavigationDecision {
  allowed: boolean
  reason?: string
}

export interface BrowserNavigationPolicyOptions {
  allowUserNavigation(url: string): boolean
  now?: () => number
  userGestureWindowMs?: number
}

export class BrowserNavigationPolicy {
  private pending: { url: string; origin: string } | null = null
  private currentOrigin: string | null = null
  private userGestureExpiresAt = 0
  private now: () => number
  private userGestureWindowMs: number

  constructor(private options: BrowserNavigationPolicyOptions) {
    this.now = options.now ?? Date.now
    this.userGestureWindowMs = options.userGestureWindowMs ?? 2_000
  }

  begin(url: string, _source: "agent" | "user"): void {
    const parsed = parse(url)
    if (!parsed) return
    this.pending = { url: parsed.href, origin: parsed.origin }
  }

  noteUserGesture(): void {
    this.userGestureExpiresAt = this.now() + this.userGestureWindowMs
  }

  noteCommitted(url: string): void {
    const parsed = parse(url)
    this.currentOrigin = parsed?.origin && parsed.origin !== "null" ? parsed.origin : null
    this.pending = null
  }

  decide(url: string): BrowserNavigationDecision {
    const parsed = parse(url)
    if (!parsed) return { allowed: false, reason: "Navigation URL is invalid." }
    if (parsed.href === "about:blank") return { allowed: true }
    if (parsed.protocol === "file:") {
      return parsed.href === this.pending?.url
        ? { allowed: true }
        : { allowed: false, reason: "File navigation requires an explicit Browser command." }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, reason: `Navigation protocol is not allowed: ${parsed.protocol}` }
    }
    if (this.pending) {
      if (this.options.allowUserNavigation(parsed.href)) return { allowed: true }
      if (parsed.href === this.pending.url || parsed.origin === this.pending.origin) return { allowed: true }
    }
    if (this.currentOrigin === parsed.origin) return { allowed: true }
    if (this.now() <= this.userGestureExpiresAt && this.options.allowUserNavigation(parsed.href)) {
      return { allowed: true }
    }
    return {
      allowed: false,
      reason: `Cross-origin navigation to ${parsed.origin} has no user gesture or navigation grant.`,
    }
  }
}

function parse(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
