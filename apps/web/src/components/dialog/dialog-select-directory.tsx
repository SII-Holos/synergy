import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { DirectoryPage, SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { serverDisplayName } from "@/context/server"
import { directoryCopy as copy } from "./directory-navigation-copy"
import "./project-flow.css"
import "./dialog-select-directory.css"

export interface DialogSelectDirectoryResult {
  directory: string | string[]
}
interface DialogSelectDirectoryProps {
  client?: SynergyClient
  serverUrl?: string
  title?: string
  multiple?: boolean
  onSelect: (result: DialogSelectDirectoryResult | null) => void
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const dialog = useDialog()
  const { _ } = useLingui()
  const client = props.client ?? sdk.client
  const [home, setHome] = createSignal(
    props.serverUrl && props.serverUrl !== sdk.url ? "/" : sync.data.paths.home || "/",
  )
  const [path, setPath] = createSignal(home())
  const [draft, setDraft] = createSignal(home())
  const [query, setQuery] = createSignal("")
  const [hidden, setHidden] = createSignal(false)
  const [listing, setListing] = createSignal<DirectoryPage>()
  const [selected, setSelected] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [searched, setSearched] = createSignal(false)
  let pathInput: HTMLInputElement | undefined
  let request: AbortController | undefined
  onCleanup(() => request?.abort())
  createEffect(() => {
    if (!props.client && sdk.client !== client) dialog.close()
  })
  const crumbs = createMemo(() => {
    const current = path()
    const separator = current.includes("\\") ? "\\" : "/"
    const root = current.match(/^(?:[a-z]:[\\/]|\/)/i)?.[0] ?? separator
    const parts = current.slice(root.length).split(/[\\/]/).filter(Boolean)
    return [
      { name: root, path: root },
      ...parts.map((name, index) => ({ name, path: root + parts.slice(0, index + 1).join(separator) })),
    ]
  })
  async function load(target = path(), cursor?: string, search = false) {
    request?.abort()
    const controller = new AbortController()
    request = controller
    setLoading(true)
    setError("")
    setPath(target)
    setSearched(search && !!query().trim())
    setDraft(target)
    try {
      const options = { signal: controller.signal, throwOnError: true as const }
      const result =
        search && query().trim()
          ? {
              path: target,
              parent: listing()?.parent ?? null,
              entries: (
                await client.global.filesystem.browse({ path: target, query: query().trim(), limit: 200 }, options)
              ).data
                .filter(
                  (item) =>
                    hidden() ||
                    !item
                      .slice(target.length)
                      .split(/[\\/]/)
                      .some((part) => part.startsWith(".")),
                )
                .map((item) => ({ path: item, name: getFilename(item) })),
            }
          : (
              await client.global.filesystem.directories(
                { path: target, hidden: hidden(), cursor, limit: 100 },
                options,
              )
            ).data
      if (controller.signal.aborted) return
      setSearched(search && !!query().trim())
      setPath(result.path)
      if (draft() === target) setDraft(result.path)
      setListing(cursor ? { ...result, entries: [...(listing()?.entries ?? []), ...result.entries] } : result)
    } catch (failure) {
      if (controller.signal.aborted) return
      const code =
        failure &&
        typeof failure === "object" &&
        "data" in failure &&
        failure.data &&
        typeof failure.data === "object" &&
        "code" in failure.data
          ? failure.data.code
          : undefined
      setError(
        _(
          code === "permission_denied"
            ? copy.denied
            : code === "not_found"
              ? copy.missing
              : code === "not_directory"
                ? copy.notFolder
                : copy.failed,
        ),
      )
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  function enter(target: string) {
    setQuery("")
    if (!props.multiple) setSelected([])
    void load(target)
  }
  function select(target: string) {
    setSelected((previous) =>
      props.multiple
        ? previous.includes(target)
          ? previous.filter((item) => item !== target)
          : [...previous, target]
        : [target],
    )
  }
  function choose() {
    if (loading() || error()) return
    const paths = selected().length ? selected() : [listing()!.path]
    props.onSelect({ directory: props.multiple ? paths : paths[0] })
    dialog.close()
  }
  onMount(() => {
    void (async () => {
      if (props.serverUrl && props.serverUrl !== sdk.url) {
        const paths = await client.global.paths.get().catch(() => undefined)
        if (paths?.data?.home) setHome(paths.data.home)
      }
      await load(home())
    })()
  })
  return (
    <Dialog
      title={props.title ?? _(copy.title)}
      description={_({ ...copy.service, values: { service: serverDisplayName(props.serverUrl ?? sdk.url) } })}
      footer={
        <div data-slot="dialog-actions">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {_(copy.cancel)}
          </Button>
          <Button
            disabled={loading() || !!error() || !listing() || (props.multiple && !selected().length)}
            onClick={choose}
          >
            {_(props.multiple ? copy.useMany : copy.use)}
          </Button>
        </div>
      }
      size="wide"
      class="directory-navigation"
    >
      <div data-slot="dialog-form" class="project-flow">
        <form
          class="directory-navigation-path"
          onSubmit={(event) => {
            event.preventDefault()
            enter(draft())
          }}
        >
          <IconButton
            type="button"
            icon={getSemanticIcon("navigation.home")}
            aria-label={_(copy.home)}
            onClick={() => enter(home())}
          />
          <IconButton
            type="button"
            icon={getSemanticIcon("navigation.back")}
            aria-label={_(copy.up)}
            disabled={!listing()?.parent || loading()}
            onClick={() => enter(listing()!.parent!)}
          />
          <TextField
            ref={pathInput}
            label={_(copy.path)}
            hideLabel
            value={draft()}
            onChange={setDraft}
            spellcheck={false}
          />
          <Button type="submit" disabled={!draft().trim()}>
            {_(copy.go)}
          </Button>
        </form>
        <nav class="directory-navigation-crumbs" aria-label={_(copy.current)}>
          <For each={crumbs()}>
            {(crumb) => (
              <button type="button" onClick={() => enter(crumb.path)}>
                {crumb.name}
              </button>
            )}
          </For>
        </nav>
        <form
          class="directory-navigation-search"
          onSubmit={(event) => {
            event.preventDefault()
            void load(path(), undefined, true)
          }}
        >
          <TextField
            label={_(copy.search)}
            hideLabel
            placeholder={_(copy.search)}
            value={query()}
            onChange={setQuery}
          />
          <Button type="submit" icon={getSemanticIcon("action.search")} aria-label={_(copy.search)} />
        </form>
        <Checkbox
          checked={hidden()}
          onChange={(value) => {
            setHidden(value)
            void load(path(), undefined, searched())
          }}
        >
          {_(copy.hidden)}
        </Checkbox>
        <Show when={loading()}>
          <p role="status">{_(copy.loading)}</p>
        </Show>
        <Show when={error()}>
          <div role="alert">
            <p>{error()}</p>
            <Button
              variant="ghost"
              onClick={() => {
                pathInput?.focus()
                void load(path(), undefined, searched())
              }}
            >
              {_(copy.retry)}
            </Button>
          </div>
        </Show>
        <Show when={!error()}>
          <div class="project-flow-list directory-navigation-list" aria-label={_(copy.title)}>
            <For each={listing()?.entries}>
              {(entry) => (
                <div class="directory-navigation-entry">
                  <button
                    type="button"
                    class="project-flow-row"
                    aria-pressed={selected().includes(entry.path)}
                    disabled={loading()}
                    onClick={() => select(entry.path)}
                    onDblClick={() => enter(entry.path)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight") {
                        event.preventDefault()
                        enter(entry.path)
                      }
                    }}
                  >
                    <Icon name={getSemanticIcon("workspace.main")} size="small" />
                    <span class="project-flow-row-copy">
                      <strong>{entry.name}</strong>
                      <Show when={searched()}>
                        <small>{entry.path}</small>
                      </Show>
                    </span>
                    <span class="project-flow-check">
                      <Show when={selected().includes(entry.path)}>
                        <Icon name={getSemanticIcon("state.success")} size="small" />
                      </Show>
                    </span>
                  </button>
                  <IconButton
                    icon={getSemanticIcon("navigation.forward")}
                    aria-label={`${_(copy.enter)}: ${entry.name}`}
                    disabled={loading()}
                    onClick={() => enter(entry.path)}
                  />
                </div>
              )}
            </For>
            <Show when={!loading() && !listing()?.entries.length}>
              <p class="directory-navigation-empty">{_(searched() ? copy.noResults : copy.empty)}</p>
            </Show>
            <Show when={listing()?.nextCursor && !searched()}>
              <Button variant="ghost" disabled={loading()} onClick={() => void load(path(), listing()?.nextCursor)}>
                {_(copy.more)}
              </Button>
            </Show>
            <Show when={searched() && listing()?.entries.length === 200}>
              <p>{_(copy.searchLimit)}</p>
            </Show>
          </div>
        </Show>
        <Show when={props.multiple && listing() && !loading() && !error()}>
          <Button variant="secondary" aria-pressed={selected().includes(path())} onClick={() => select(path())}>
            {_(copy.selectCurrent)}
          </Button>
        </Show>
        <div class="directory-navigation-selection">
          <span title={selected().join("\n")}>
            {props.multiple ? _({ ...copy.selected, values: { count: selected().length } }) : (selected()[0] ?? path())}
          </span>
          <Show when={selected().length}>
            <Button variant="ghost" onClick={() => setSelected([])}>
              {_(copy.clear)}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
