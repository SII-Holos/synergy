import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { sessionTags } from "@/locales/messages"

export function SessionTagMenu(props: {
  tags: string[]
  availableTags: string[]
  onChange: (tags: string[]) => Promise<string[]>
}) {
  const { _ } = useLingui()
  const [query, setQuery] = createSignal("")
  const [tags, setTags] = createSignal(props.tags)
  const [pending, setPending] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  createEffect(on(() => props.tags, setTags))
  const candidate = createMemo(() =>
    query()
      .trim()
      .replace(/^(?:#\s*)+/, ""),
  )
  const filteredTags = createMemo(() => {
    const term = candidate().toLowerCase()
    return props.availableTags.filter((tag) => !term || tag.toLowerCase().includes(term))
  })
  const canCreate = () =>
    candidate().length > 0 && candidate().length <= 40 && tags().length < 20 && !tags().includes(candidate())

  async function save(next: string[]) {
    if (pending()) return
    setPending(true)
    setFailed(false)
    try {
      setTags(await props.onChange(next))
      setQuery("")
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }
  function toggleTag(tag: string) {
    if (tags().includes(tag)) void save(tags().filter((value) => value !== tag))
    else if (tags().length < 20) void save([...tags(), tag])
  }
  function createTag() {
    if (canCreate()) void save([...tags(), candidate()])
  }

  return (
    <Popover
      placement="left-start"
      title={_(sessionTags.tags)}
      class="w-[220px] max-w-[calc(100vw-24px)]"
      triggerAs={(triggerProps) => (
        <button {...triggerProps} type="button" role="menuitem" class="stb-menu-item">
          <Icon name={getSemanticIcon("notes.tag")} size="small" class="text-icon-weak-base" />
          {_(sessionTags.tags)}
        </button>
      )}
    >
      <div aria-busy={pending()}>
        <input
          type="text"
          value={query()}
          maxLength={41}
          disabled={pending()}
          aria-label={_(sessionTags.filterOrCreate)}
          placeholder={_(sessionTags.filterOrCreate)}
          class="w-full px-2 py-1.5 text-12-regular rounded-md bg-surface-inset-base border border-border-base outline-none focus:border-border-interactive-base"
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              createTag()
            }
          }}
        />
        <Show when={failed()}>
          <div role="alert" class="text-text-critical-base text-12-regular py-1">
            {_(sessionTags.saveFailed)}
          </div>
        </Show>
        <div class="flex flex-wrap gap-1 py-2">
          <For each={tags()}>
            {(tag) => (
              <button
                type="button"
                disabled={pending()}
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-10-medium text-text-interactive-base bg-surface-info-base/20"
                onClick={() => toggleTag(tag)}
              >
                #{tag}
                <Icon name={getSemanticIcon("action.close")} size="small" />
              </button>
            )}
          </For>
        </div>
        <Show when={filteredTags().length > 0}>
          <div class="max-h-32 overflow-y-auto border-t border-border-weaker-base/40 pt-1">
            <For each={filteredTags()}>
              {(tag) => (
                <button
                  type="button"
                  disabled={pending() || (!tags().includes(tag) && tags().length >= 20)}
                  aria-pressed={tags().includes(tag)}
                  class="w-full px-2 py-1 text-left text-12-regular text-text-base hover:bg-surface-raised-base-hover rounded cursor-pointer"
                  onClick={() => toggleTag(tag)}
                >
                  <span class={tags().includes(tag) ? "text-text-interactive-base" : ""}>#{tag}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={canCreate()}>
          <button
            type="button"
            disabled={pending()}
            class="w-full mt-1 px-2 py-1.5 text-left text-12-medium text-text-interactive-base hover:bg-surface-raised-base-hover rounded cursor-pointer"
            onClick={createTag}
          >
            {_({ ...sessionTags.create, values: { tag: candidate() } })}
          </button>
        </Show>
      </div>
    </Popover>
  )
}
