import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { normalizeServerUrl, serverDisplayName, useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { DialogSelectServer } from "./dialog-select-server"
import { locationCopy } from "./task-location-copy"
import { projectEntryCopy as copy } from "./project-entry-copy"
import "./project-flow.css"

export function useComputerLabel() {
  const { _ } = useLingui()
  const platform = usePlatform()
  const [status] = createResource(() => platform.desktopServer?.status())
  return (url: string) =>
    status()?.mode === "managed" &&
    status()?.state === "running" &&
    normalizeServerUrl(status()?.url ?? "") === normalizeServerUrl(url)
      ? _(platform.desktopWindow?.chrome === "native" ? locationCopy.mac : locationCopy.computer)
      : serverDisplayName(url)
}

export function ComputerMenu(props: { value?: string; onChange?: (url: string) => void; disabled?: boolean }) {
  const { _ } = useLingui()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const label = useComputerLabel()
  const [open, setOpen] = createSignal(false)
  const urls = createMemo(() => [...new Set([props.value ?? server.url, server.url, ...server.list])])
  const [health] = createResource(
    () => (open() ? urls() : false),
    async (values) =>
      Object.fromEntries(
        await Promise.all(
          values.map(async (url) => {
            const client = createSynergyClient({
              baseUrl: url,
              fetch: platform.fetch,
              signal: AbortSignal.timeout(5000),
            })
            return [
              url,
              await client.global.health().then(
                (result) => !!result.data?.healthy,
                () => false,
              ),
            ] as const
          }),
        ),
      ),
  )
  return (
    <Popover
      variant="menu"
      title={_(copy.computer)}
      placement="top-start"
      open={open()}
      onOpenChange={setOpen}
      class="project-computer-menu"
      triggerAs={(attributes) => (
        <button
          {...attributes}
          type="button"
          class="session-work-context-button"
          disabled={props.disabled}
          aria-label={_(copy.computer)}
        >
          <Icon name={getSemanticIcon("computer.main")} size="small" />
          <span>{label(props.value ?? server.url)}</span>
        </button>
      )}
    >
      <For each={urls()}>
        {(url) => (
          <button
            type="button"
            class="project-flow-row"
            aria-pressed={url === (props.value ?? server.url)}
            disabled={health()?.[url] === false}
            onClick={() => {
              setOpen(false)
              ;(props.onChange ?? server.setActive)(url)
            }}
          >
            <Icon name={getSemanticIcon("computer.main")} size="small" />
            <span class="project-flow-row-copy">
              <strong>{label(url)}</strong>
              <small>
                {_(health()?.[url] === false ? copy.unavailable : health()?.[url] ? copy.connected : copy.loading)}
              </small>
            </span>
            <span class="project-flow-check">
              <Show when={url === (props.value ?? server.url)}>
                <Icon name={getSemanticIcon("state.success")} size="small" />
              </Show>
            </span>
          </button>
        )}
      </For>
      <div class="project-menu-footer">
        <button
          class="project-flow-row"
          type="button"
          onClick={() => {
            setOpen(false)
            dialog.push(() => <DialogSelectServer onChoose={props.onChange} />)
          }}
        >
          {_(copy.manageComputers)}
        </button>
      </div>
    </Popover>
  )
}
