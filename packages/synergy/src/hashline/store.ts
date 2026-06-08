import { Bus } from "../bus"
import { Instance } from "../scope/instance"
import { SessionEvent } from "../session/event"
import { computeTag, normalizeContent } from "./tag"

const TAG_PATTERN = /^[0-9A-F]{4}$/

function assertTag(tag: string): void {
  if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid hashline tag: ${tag}`)
}

interface SnapshotEntry {
  path: string
  tag: string
  content: string
}

export class SnapshotStore {
  readonly #byPath = new Map<string, Map<string, string>>()

  set(filePath: string, tag: string, content: string): void {
    assertTag(tag)
    const normalized = normalizeContent(content)
    let versions = this.#byPath.get(filePath)
    if (!versions) {
      versions = new Map()
      this.#byPath.set(filePath, versions)
    }
    versions.set(tag, normalized)
  }

  record(filePath: string, content: string): string {
    const normalized = normalizeContent(content)
    const tag = computeTag(normalized)
    this.set(filePath, tag, normalized)
    return tag
  }

  get(filePath: string, tag: string): string | undefined {
    assertTag(tag)
    return this.#byPath.get(filePath)?.get(tag)
  }

  has(filePath: string, tag: string): boolean {
    return this.get(filePath, tag) !== undefined
  }

  getContentByTag(tag: string): string | undefined {
    assertTag(tag)
    for (const versions of this.#byPath.values()) {
      const content = versions.get(tag)
      if (content !== undefined) return content
    }
    return undefined
  }

  setMultiple(entries: SnapshotEntry[]): void {
    for (const entry of entries) this.set(entry.path, entry.tag, entry.content)
  }

  clear(): void {
    this.#byPath.clear()
  }
}

export namespace SessionHashlineStore {
  const state = Instance.state(() => new Map<string, SnapshotStore>())

  let cleanupSubscribed = false

  function ensureCleanupSubscription(): void {
    if (cleanupSubscribed) return
    cleanupSubscribed = true
    Bus.subscribe(SessionEvent.Deleted, (event) => {
      clear(event.properties.info.id)
    })
  }

  export function get(sessionID: string): SnapshotStore {
    ensureCleanupSubscription()
    const stores = state()
    let store = stores.get(sessionID)
    if (!store) {
      store = new SnapshotStore()
      stores.set(sessionID, store)
    }
    return store
  }

  export function clear(sessionID?: string): void {
    const stores = state()
    if (sessionID) stores.delete(sessionID)
    else stores.clear()
  }
}
