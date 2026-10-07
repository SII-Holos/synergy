import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import type { TextPart } from "@ericsanchezok/synergy-sdk/client"
import { render } from "solid-js/web"
import { GlobalSyncProvider, useGlobalSync } from "../../../src/context/global-sync"

type ScopeAPI = ReturnType<typeof useGlobalSync>

class ScopeMemoryMarker implements TextPart {
  readonly type = "text"
  readonly id = "scope-marker"
  readonly messageID = "marker-message"
  readonly sessionID = "marker-session"
  readonly text: string

  constructor(scopeID: string) {
    this.text = Array.from({ length: 8192 }, (_, index) => `${scopeID}:${index}`).join("\n")
  }
}

export type ScopeMemoryFixture = {
  churn(batch: number, count: number): Promise<{ scopes: number; bytes: number }>
  dispose(): void
}

declare global {
  interface Window {
    __scopeMemoryFixture: ScopeMemoryFixture
    __scopeMemoryPrototype: object
  }
}

export function mountScopeMemoryFixture(root: HTMLElement) {
  let api: ScopeAPI | undefined
  function Child() {
    api = useGlobalSync()
    return <div>Scope memory fixture</div>
  }
  const dispose = render(
    () => (
      <I18nProvider i18n={setupI18n({ locale: "en", messages: { en: {} } })}>
        <GlobalSyncProvider>
          <Child />
        </GlobalSyncProvider>
      </I18nProvider>
    ),
    root,
  )
  window.__scopeMemoryPrototype = ScopeMemoryMarker.prototype
  window.__scopeMemoryFixture = {
    async churn(batch, count) {
      if (!api) throw new Error("Scope memory fixture was disposed")
      for (let index = 0; index < count; index++) {
        const scopeID = `memory-${batch}-${index}`
        const [, setState] = api.ensureScopeState(scopeID)
        api.seedSessionViewportContent(scopeID, {
          pages: {
            "budget-message": {
              items: [
                {
                  id: "budget-part",
                  messageID: "budget-message",
                  sessionID: "budget-session",
                  type: "text",
                  preview: "Budget owner",
                  content: { version: "one", bytes: 12 },
                },
              ],
              hasMore: false,
              hasEarlier: false,
              nextCursor: null,
              previousCursor: null,
            },
          },
          bodies: [
            {
              part: {
                id: "budget-part",
                messageID: "budget-message",
                sessionID: "budget-session",
                type: "text",
                text: "Budget owner",
              },
              version: "one",
            },
          ],
        })
        setState("part", "marker-message", [new ScopeMemoryMarker(scopeID)])
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return {
        scopes: Array.from({ length: count }, (_, index) => `memory-${batch}-${index}`).filter((key) =>
          api?.peekScopeState(key),
        ).length,
        bytes: api.contentBudget.bytes,
      }
    },
    dispose() {
      dispose()
      api = undefined
    },
  }
}
