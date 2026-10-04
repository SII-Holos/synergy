import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import "./tool-object-result.css"

export function ToolObjectResult(props: { value: unknown; depth?: number }) {
  const { _ } = useLingui()
  const [page, setPage] = createSignal(0)
  const [full, setFull] = createSignal(false)
  const array = () => Array.isArray(props.value)
  const entries = createMemo(() =>
    props.value && typeof props.value === "object" ? Object.entries(props.value) : undefined,
  )
  const size = () => ((props.depth ?? 0) === 0 ? 12 : 6)
  const items = createMemo(() => entries()?.slice(page() * size(), (page() + 1) * size()))
  const text = () => (typeof props.value === "string" ? props.value : (JSON.stringify(props.value, null, 2) ?? "—"))
  createEffect(() => {
    void props.value
    setPage(0)
    setFull(false)
  })
  const pagination = () => (
    <Show when={(entries()?.length ?? 0) > size()}>
      <nav data-slot="tool-object-pages" aria-label={_({ id: "tool.result.pages", message: "Result pages" })}>
        <button type="button" disabled={page() === 0} onClick={() => setPage(page() - 1)}>
          {_({ id: "tool.result.previous", message: "Previous results" })}
        </button>
        <span aria-live="polite">
          {_({
            id: "tool.result.pageRange",
            message: "{start}–{end} of {count}",
            values: {
              start: page() * size() + 1,
              end: Math.min((page() + 1) * size(), entries()!.length),
              count: entries()!.length,
            },
          })}
        </span>
        <button type="button" disabled={(page() + 1) * size() >= entries()!.length} onClick={() => setPage(page() + 1)}>
          {_({ id: "tool.result.next", message: "Next results" })}
        </button>
      </nav>
    </Show>
  )
  return (
    <div data-component="tool-object-result">
      <Show
        when={entries() && (props.depth ?? 0) < 2}
        fallback={
          <>
            <pre>{full() ? text() : text().slice(0, 8000)}</pre>
            <Show when={text().length > 8000 && !full()}>
              <button type="button" onClick={() => setFull(true)}>
                {_({ id: "tool.result.showFullValue", message: "Show full value" })}
              </button>
            </Show>
          </>
        }
      >
        <Show
          when={array()}
          fallback={
            <dl data-slot="tool-object-fields">
              <For each={items()}>
                {([key, value]) => (
                  <>
                    <dt>{key}</dt>
                    <dd>
                      <ToolObjectResult value={value} depth={(props.depth ?? 0) + 1} />
                    </dd>
                  </>
                )}
              </For>
            </dl>
          }
        >
          <For each={items()}>
            {([, value]) => (
              <div data-slot="tool-object-item">
                <ToolObjectResult value={value} depth={(props.depth ?? 0) + 1} />
              </div>
            )}
          </For>
        </Show>
        {pagination()}
      </Show>
    </div>
  )
}
