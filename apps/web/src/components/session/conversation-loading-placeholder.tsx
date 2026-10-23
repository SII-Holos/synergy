import { useLingui } from "@lingui/solid"
import type { JSX } from "solid-js"
import { For, Show } from "solid-js"
import { useViewActivity } from "@ericsanchezok/synergy-ui/context/view-activity"
import { AP } from "@/app-i18n"
import "./conversation-loading-placeholder.css"

// Percent widths per paragraph, each ending short like authored prose.
const rhythm: number[][] = [
  [100, 96, 88, 52],
  [100, 94, 97, 68],
  [100, 76],
]

// The waiting shape is anchored like the transcript's first row and repeats past
// the pane's bottom edge, clipped there. That covers both readings of the same
// column: short history starts at the top and long history fills the pane after
// following its latest turn. Anchoring to either edge alone would move on one of
// them. The repeat runs well past any realistic pane height (~3500px at the
// default type scale) so the pane height is never what limits coverage; what
// renders below the fold stays clipped and costs only markup. It never claims
// the target Session's real rows, and carries no body text.
const paragraphs = Array.from({ length: 32 }, (_, index) => rhythm[index % rhythm.length]!)

export function ConversationLoadingPlaceholder(props: { action?: JSX.Element }) {
  const { _ } = useLingui()
  const active = useViewActivity()
  return (
    <div
      data-conversation-loading
      data-active={active()}
      class="absolute inset-0 pointer-events-none overflow-hidden md:pt-[58px]"
    >
      <div class="session-conversation-content session-content-column flex flex-col items-start gap-5">
        <span role="status" class="sr-only">
          {_(AP.sessionLoading)}
        </span>
        <For each={paragraphs}>
          {(widths) => (
            <div class="flex w-full flex-col">
              <For each={widths}>
                {(width) => <span data-conversation-loading-line style={{ width: `${width}%` }} />}
              </For>
            </div>
          )}
        </For>
      </div>
      <div data-conversation-loading-sheen aria-hidden="true" />
      <Show when={props.action}>
        {(action) => (
          <div class="pointer-events-auto absolute inset-x-0 bottom-6 flex justify-center md:bottom-[calc(var(--prompt-height,10rem)+16px)]">
            {action()}
          </div>
        )}
      </Show>
    </div>
  )
}
