import { Show } from "solid-js"
import { useLocale } from "@/context/locale"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { Message, Session, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import type { useLayout } from "@/context/layout"
import { SessionContextTab } from "./session-context-tab"
import { SessionContextUsage } from "./session-context-usage"
import { S } from "./session-i18n"

export function SessionContextPanel(props: {
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  messages: () => Message[]
  info: () => Session | undefined
  visibleUserMessages: () => UserMessage[]
}) {
  const { i18n } = useLocale()

  return (
    <aside class="relative flex h-full min-w-[200px] flex-1 flex-col border-l border-border-weak-base bg-background-stronger">
      <header class="flex h-12 min-h-12 items-center justify-between border-b border-border-weak-base px-3">
        <div class="flex items-center gap-2 text-13-medium text-text-strong">
          <SessionContextUsage variant="indicator" />
          <span>{i18n._(S.contextPanelTitle)}</span>
        </div>
        <IconButton
          icon={getSemanticIcon("action.close")}
          variant="ghost"
          aria-label={i18n._(S.contextPanelClose)}
          onClick={() => props.tabs().close("context")}
        />
      </header>
      <div class="relative min-h-0 flex-1 overflow-hidden pt-2">
        <Show when={props.tabs().active() === "context"}>
          <SessionContextTab
            messages={props.messages}
            visibleUserMessages={props.visibleUserMessages}
            view={props.view}
            info={props.info}
          />
        </Show>
      </div>
    </aside>
  )
}
