import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { createHistorySearch } from "./history-search"
import { S } from "./session-i18n"

export function HistorySearchDialog(props: {
  sessionID: string
  locate(messageID: string, partID?: string): Promise<boolean>
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { _ } = useLingui()
  const [query, setQuery] = createSignal("")
  const [reasoning, setReasoning] = createSignal(false)
  const [tools, setTools] = createSignal(false)
  const [revision, setRevision] = createSignal(0)
  const [locating, setLocating] = createSignal<string>()
  const search = createHistorySearch(
    async ({ signal, ...input }) => {
      const result = await sdk.client.session.historySearch(
        { sessionID: props.sessionID, ...input },
        { signal, throwOnError: true },
      )
      if (!result.data) throw new Error(_(S.historySearchFailed))
      return result.data
    },
    () => setRevision((value) => value + 1),
  )
  const state = createMemo(() => {
    revision()
    return { ...search.state, items: search.state.items.slice() }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const start = () => {
    clearTimeout(timer)
    void search.start({ query: query(), reasoning: reasoning(), tools: tools() })
  }
  onCleanup(() => {
    clearTimeout(timer)
    search.dispose()
  })
  const select = async (messageID: string, partID: string) => {
    setLocating(partID)
    try {
      if (await props.locate(messageID, partID)) dialog.close()
    } finally {
      setLocating(undefined)
    }
  }
  return (
    <Dialog title={_(S.historySearchTitle)}>
      <div class="flex flex-col gap-4 px-5 pb-5">
        <TextField
          autofocus
          value={query()}
          placeholder={_(S.historySearchPlaceholder)}
          onChange={(value) => {
            setQuery(value)
            clearTimeout(timer)
            timer = setTimeout(start, 150)
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter" && !event.isComposing) start()
          }}
        />
        <div class="flex gap-4">
          <Switch
            checked={reasoning()}
            onChange={(value) => {
              setReasoning(value)
              start()
            }}
          >
            {_(S.historySearchReasoning)}
          </Switch>
          <Switch
            checked={tools()}
            onChange={(value) => {
              setTools(value)
              start()
            }}
          >
            {_(S.historySearchTools)}
          </Switch>
        </div>
        <Show when={state().preparing}>
          <div class="text-12-regular text-text-weak" role="status">
            {_(S.historySearchPreparing.id, { count: state().prepared })}
          </div>
        </Show>
        <Show when={state().error}>
          <div class="text-12-regular text-text-weak" role="alert">
            {state().error}
          </div>
        </Show>
        <div class="max-h-96 overflow-y-auto flex flex-col gap-2" aria-busy={state().loading}>
          <For each={state().items}>
            {(item) => (
              <button
                type="button"
                class="text-left p-3 rounded-md bg-surface-base hover:bg-surface-raised-base text-13-regular text-text-base whitespace-pre-wrap break-words"
                disabled={!!locating()}
                onClick={() => void select(item.messageID, item.partID)}
              >
                {item.text}
              </button>
            )}
          </For>
        </div>
        <Show when={state().cursor}>
          <Button variant="ghost" disabled={state().loading} onClick={() => void search.more()}>
            {_(S.historySearchMore)}
          </Button>
        </Show>
        <Show
          when={query().trim() && !state().loading && !state().preparing && !state().cursor && !state().items.length}
        >
          <div class="text-13-regular text-text-weak">{_(S.historySearchEmpty)}</div>
        </Show>
      </div>
    </Dialog>
  )
}
