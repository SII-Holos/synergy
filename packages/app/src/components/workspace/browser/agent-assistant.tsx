import { Show } from "solid-js"
import { useBrowser } from "./browser-store"

function hostLabel(url: string | null): string {
  if (!url) return "page"
  try {
    return new URL(url).host || "page"
  } catch {
    return "page"
  }
}

export function AgentAssistant() {
  const browser = useBrowser()
  const activity = browser.agentActivity

  return (
    <Show when={activity().kind !== "idle" && activity().label}>
      <div
        class="absolute right-3 top-3 z-40 max-w-[min(360px,calc(100%-24px))] rounded-full border px-3 py-1.5 text-12 shadow-sm"
        classList={{
          "border-border-warning-base/30 bg-surface-warning-weak text-text-on-warning-base":
            activity().kind === "acting",
          "border-border-weak-base bg-surface-raised-stronger-non-alpha text-text-base": activity().kind === "reading",
        }}
      >
        <div class="flex min-w-0 items-center gap-2">
          <span
            class="size-2 rounded-full shrink-0"
            classList={{
              "bg-icon-warning-base": activity().kind === "acting",
              "bg-text-weaker": activity().kind === "reading",
            }}
          />
          <span class="truncate">
            Agent {activity().kind} {hostLabel(activity().url)}
          </span>
          <Show when={!browser.followAgent() && activity().pageId}>
            <button
              type="button"
              class="ml-1 text-text-base hover:text-text-strong"
              onClick={() => browser.followAgentNow()}
            >
              Follow
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}
