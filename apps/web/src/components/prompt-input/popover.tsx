import type { Accessor } from "solid-js"
import { For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { useLocale } from "@/context/locale"
import { PI } from "./prompt-input-i18n"
import type { AtOption, PromptPopoverMode, SlashCommand } from "./types"

export function PromptPopover(props: {
  mode: Accessor<PromptPopoverMode>
  setSlashRef: (el: HTMLDivElement) => void
  atItems: Accessor<AtOption[]>
  atActive: Accessor<string | null | undefined>
  atKey: (option: AtOption | undefined) => string
  onAtSelect: (option: AtOption | undefined) => void
  slashItems: Accessor<SlashCommand[]>
  slashActive: Accessor<string | null | undefined>
  onSlashSelect: (command: SlashCommand | undefined) => void
  keybindFor: (id: string) => string | undefined
}) {
  const { i18n } = useLocale()

  return (
    <div
      ref={(el) => {
        if (props.mode() === "slash") props.setSlashRef(el)
      }}
      class="absolute inset-x-0 -top-3 -translate-y-full origin-bottom-left max-h-80 min-h-10
             overflow-auto no-scrollbar flex flex-col p-2 rounded-md
             border border-border-base bg-surface-raised-stronger-non-alpha shadow-md"
    >
      <Switch>
        <Match when={props.mode() === "at"}>
          <Show
            when={props.atItems().length > 0}
            fallback={<div class="text-text-weak px-2 py-1">{i18n._(PI.popoverNoResults)}</div>}
          >
            <For each={props.atItems().slice(0, 10)}>
              {(item) => (
                <button
                  classList={{
                    "w-full flex items-center gap-x-2 rounded-md px-2 py-0.5": true,
                    "bg-surface-raised-base-hover": props.atActive() === props.atKey(item),
                  }}
                  onClick={() => props.onAtSelect(item)}
                >
                  <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-14-regular min-w-0">
                    <span class="text-text-weak whitespace-nowrap truncate min-w-0">{getDirectory(item.path)}</span>
                    <Show when={!item.path.endsWith("/")}>
                      <span class="text-text-strong whitespace-nowrap">{getFilename(item.path)}</span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </Match>
        <Match when={props.mode() === "slash"}>
          <Show
            when={props.slashItems().length > 0}
            fallback={<div class="text-text-weak px-2 py-1">{i18n._(PI.popoverNoCommands)}</div>}
          >
            <For each={props.slashItems()}>
              {(cmd) => (
                <button
                  data-slash-id={cmd.id}
                  classList={{
                    "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                    "bg-surface-raised-base-hover": props.slashActive() === cmd.id,
                  }}
                  onClick={() => props.onSlashSelect(cmd)}
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                    <Show when={cmd.description}>
                      <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <Show when={cmd.type === "custom"}>
                      <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                        {cmd.kind === "action" ? i18n._(PI.popoverActionTag) : i18n._(PI.popoverPromptTag)}
                      </span>
                    </Show>
                    <Show when={props.keybindFor(cmd.id)}>
                      {(keybind) => <span class="text-12-regular text-text-subtle">{keybind()}</span>}
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </Match>
      </Switch>
    </div>
  )
}
