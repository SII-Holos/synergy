import { BrowserProtocolError } from "./error.js"
import { isSafeBrowserObservation, type BrowserBackendCommand } from "./protocol.js"

type Counts = Record<"pointer" | "keyboard" | "scroll" | "navigation" | "page", number>
type Observation = { sessionID: string; counts: Counts; observes: boolean; summary?: string }
const empty = (): Counts => ({ pointer: 0, keyboard: 0, scroll: 0, navigation: 0, page: 0 })

export class BrowserHumanChanges {
  private counts = empty()
  private observed = new Map<string, Counts>()

  constructor(private pageId: string) {}

  record(kind: keyof Counts) {
    this.counts[kind]++
  }

  begin(sessionID: string, command: BrowserBackendCommand): Observation {
    const previous = this.observed.get(sessionID) ?? empty()
    const changes = (Object.keys(this.counts) as Array<keyof Counts>)
      .filter((kind) => this.counts[kind] > previous[kind])
      .map((kind) => `${kind}: ${this.counts[kind] - previous[kind]}`)
    const summary = changes.length ? `The user changed this page (${changes.join(", ")}).` : undefined
    if (summary && !isSafeBrowserObservation(command) && !["wait", "resume", "close"].includes(command.type))
      throw new BrowserProtocolError({
        code: "browser_page_changed_by_user",
        message: `${summary} Read the page again before acting; the requested action was not dispatched.`,
        retryable: true,
        pageId: this.pageId,
        suggestedAction:
          "Use browser_snapshot, browser_read, browser_inspect or browser_screenshot, then decide on a fresh action from the new state.",
      })
    return {
      sessionID,
      counts: { ...this.counts },
      observes: ["snapshot", "read", "inspect", "screenshot"].includes(command.type),
      summary,
    }
  }

  finish(observation: Observation): string | undefined {
    if (!observation.observes) return observation.summary
    this.observed.delete(observation.sessionID)
    this.observed.set(observation.sessionID, observation.counts)
    if (this.observed.size > 256) this.observed.delete(this.observed.keys().next().value!)
    const changed = (Object.keys(this.counts) as Array<keyof Counts>).some(
      (kind) => this.counts[kind] !== observation.counts[kind],
    )
    return changed
      ? `${observation.summary ?? ""} The user changed the page during the observation. Read it again before acting.`.trim()
      : observation.summary
  }
}
