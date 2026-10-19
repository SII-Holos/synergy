import { Show, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { browser as B } from "@/locales/messages"

export function BrowserToolbar(props: { children: JSX.Element; loading: boolean }) {
  const { _ } = useLingui()
  return (
    <div class="shrink-0">
      <div class="browser-address-bar">{props.children}</div>
      <div class="h-0.5">
        <Show when={props.loading}>
          <div
            role="progressbar"
            aria-label={_(B.connecting)}
            class="h-full animate-pulse bg-border-interactive-base motion-reduce:animate-none"
          />
        </Show>
      </div>
    </div>
  )
}
