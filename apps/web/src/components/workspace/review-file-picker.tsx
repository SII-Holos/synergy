import { createEffect, createMemo, createSignal, createUniqueId, on, Show } from "solid-js"
import { VList, type VListHandle } from "virtua/solid"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { reviewFileKey } from "@ericsanchezok/synergy-ui/session-review"
import { useLingui } from "@lingui/solid"
import { reviewCopy as C } from "./review-copy"
import type { ReviewRow } from "./review-data"

export function ReviewFilePicker(props: { rows: ReviewRow[]; select: (id: string) => void }) {
  const { _ } = useLingui()
  const id = createUniqueId()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  let list: VListHandle | undefined
  const entries = createMemo(() => {
    const names = new Map<string, number>()
    for (const row of props.rows) {
      const name = row.file.split("/").at(-1)!
      names.set(name, (names.get(name) ?? 0) + 1)
    }
    return props.rows.map((row) => {
      const name = row.file.split("/").at(-1)!
      const directory = row.file.slice(0, row.file.lastIndexOf("/"))
      const workspace = names.get(name)! > 1 ? (row.workspace?.root ?? row.legacyRoot) : undefined
      return { row, name, directory: row.file.includes("/") ? directory : "", workspace }
    })
  })
  const matches = createMemo(() => {
    const search = query().trim().toLocaleLowerCase()
    return entries().filter(({ row, workspace }) =>
      `${row.file} ${workspace ?? ""}`.toLocaleLowerCase().includes(search),
    )
  })
  createEffect(on(matches, () => setActive(0)))
  createEffect(() => list?.scrollToIndex(active(), { align: "nearest" }))
  const choose = (index: number) => {
    const entry = matches()[index]
    if (entry) props.select(reviewFileKey(entry.row))
  }
  return (
    <div class="review-file-picker">
      <input
        class="review-filter"
        role="combobox"
        aria-label={_(C.jump)}
        placeholder={_(C.jump)}
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={matches().length ? `${id}-${active()}` : undefined}
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.isComposing) return
          if (event.key === "Enter") {
            event.preventDefault()
            choose(active())
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault()
            setActive((index) =>
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? Math.max(0, matches().length - 1)
                  : Math.max(0, Math.min(matches().length - 1, index + (event.key === "ArrowDown" ? 1 : -1))),
            )
          }
        }}
      />
      <Show
        when={matches().length}
        fallback={
          <p class="review-navigation-empty" role="status">
            {_(C.filterEmpty)}
          </p>
        }
      >
        <VList
          ref={(value) => {
            list = value
          }}
          id={`${id}-list`}
          role="listbox"
          aria-label={_(C.files)}
          data={matches()}
          itemSize={44}
          overscan={4}
          keepMounted={[active()]}
          style={{ height: `${Math.min(matches().length * 44, 264)}px` }}
        >
          {(entry, index) => (
            <button
              type="button"
              id={`${id}-${index()}`}
              role="option"
              tabIndex={-1}
              aria-selected={active() === index()}
              aria-posinset={index() + 1}
              aria-setsize={matches().length}
              title={`${entry.row.file}${entry.workspace ? ` · ${entry.workspace}` : ""}`}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index())}
              onPointerMove={() => setActive(index())}
            >
              <FileIcon node={{ path: entry.row.file, type: "file" }} />
              <span class="review-picker-name">{entry.name}</span>
              <span class="review-picker-directory">{entry.directory}</span>
              <Show when={entry.workspace}>
                <span class="review-picker-workspace">{entry.workspace}</span>
              </Show>
            </button>
          )}
        </VList>
      </Show>
    </div>
  )
}
