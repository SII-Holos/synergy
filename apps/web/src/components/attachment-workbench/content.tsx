import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { Part } from "@ericsanchezok/synergy-sdk"
import { attachmentFromReference, attachmentSourcePath } from "@ericsanchezok/synergy-ui/attachment-card"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useData } from "@ericsanchezok/synergy-ui/context/data"
import { usePlatform } from "@/context/platform"
import { useWorkbenchPanels } from "@/context/workbench"
import { useSDK } from "@/context/sdk"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { attachmentWorkbench as A } from "@/locales/messages"
import { attachmentResourceState, findAttachmentByLocator } from "./model"
import { AttachmentPreview } from "./preview"
import "./styles.css"

export function AttachmentWorkbenchContent(
  props: WorkbenchPanelContentProps & { sourceFileAction?: (path: string) => (() => void) | undefined },
) {
  const lingui = useLingui()
  const data = useData()
  const platform = usePlatform()
  const sdk = useSDK()
  const workbench = useWorkbenchPanels()
  const [browserOpenNonce, setBrowserOpenNonce] = createSignal(0)
  const openInBrowserPanel = (href: string) => {
    setBrowserOpenNonce((value) => value + 1)
    void workbench.openPanel("browser", {
      init: { state: { url: href, nonce: browserOpenNonce() } },
    })
  }
  const resource = createMemo(() => attachmentResourceState(props.tab.state))
  const locator = createMemo(() => {
    const value = resource()
    return value && !("url" in value) ? value : undefined
  })
  const local = createMemo(() => {
    const reference = resource()
    if (reference && "url" in reference) return attachmentFromReference(reference.url, reference.filename)
    const value = locator()
    return value ? findAttachmentByLocator(data.view.partsFor(value.messageID), value) : undefined
  })
  const [remoteParts, { refetch }] = createResource(
    () => {
      const value = locator()
      return value && !local() ? value : undefined
    },
    async (value) => {
      const response = await sdk.client.session.message({
        sessionID: value.sessionID,
        messageID: value.messageID,
      })
      return response.data?.parts as Part[] | undefined
    },
  )
  const attachment = createMemo(() => {
    const value = locator()
    return local() ?? (value && !remoteParts.error ? findAttachmentByLocator(remoteParts(), value) : undefined)
  })
  const sourceFileAction = createMemo(() => {
    const path = attachmentSourcePath(attachment() ?? { mime: "" })
    return path ? props.sourceFileAction?.(path) : undefined
  })
  return (
    <Show
      when={attachment()}
      fallback={
        <div class="attachment-workbench-state">
          <Show when={remoteParts.loading} fallback={<Icon name={getSemanticIcon("state.warning")} size="normal" />}>
            <Spinner class="size-5" />
          </Show>
          <strong>{remoteParts.loading ? lingui._(A.loading) : lingui._(A.unavailable)}</strong>
          <Show when={locator() && !remoteParts.loading}>
            <button type="button" class="attachment-workbench-action" onClick={() => void refetch()}>
              {lingui._({ id: "app.workspace.panel.retry", message: "Retry" })}
            </button>
          </Show>
        </div>
      }
    >
      {(current) => (
        <AttachmentPreview
          file={current()}
          serverUrl={sdk.url}
          fetcher={platform.fetch}
          onOpenSource={sourceFileAction()}
          onOpenBrowser={openInBrowserPanel}
          onOpenExternal={platform.openLink}
        />
      )}
    </Show>
  )
}
