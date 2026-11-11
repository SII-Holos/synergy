import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import type { OrganizationProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import type { createOrganizationSessionReader } from "./private-read"
import { createOrganizationAttachmentDirectory } from "./attachment-directory"
import { PrivateAttachment, privateAttachmentIdentity } from "./private-attachment"
import { WorkspaceError } from "./workspace-error"
import { publicationMessages } from "./publication-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"

type Target = {
  sessionID: string
  sourceSessionID?: string
  messageID: string
  partID: string
  count: number
  binding: Protocol.SessionBinding
  signal: AbortSignal
  read: ReturnType<typeof createOrganizationSessionReader>
  attachmentPreview?: string
  selectAttachmentPreview: (id?: string) => void
  invalidated: (error: unknown) => void
}
const messages = {
  first: { id: "organization.session.firstFiles", message: "First files" },
  next: { id: "organization.session.nextFiles", message: "Next files" },
  empty: { id: "organization.session.emptyFilePage", message: "No visible files on this page" },
}

export function PrivateToolAttachments(props: Target) {
  const { _, i18n } = useLingui()
  const [open, setOpen] = createSignal(false)
  const id = generateUUID()
  return (
    <section class="organization-private-tool-files">
      <Button variant="ghost" aria-expanded={open()} aria-controls={id} onClick={() => setOpen(!open())}>
        {_(publicationMessages.files)} <span>{new Intl.NumberFormat(i18n().locale).format(props.count)}</span>
      </Button>
      <Show when={open()}>
        <div id={id}>
          <ToolFilePage {...props} />
        </div>
      </Show>
    </section>
  )
}

function ToolFilePage(props: Target) {
  const { _ } = useLingui()
  const directory = createOrganizationAttachmentDirectory({ ...props })
  const previews = new Set<string>()
  const identity = (ordinal: number) =>
    privateAttachmentIdentity({
      rootSessionID: props.sessionID,
      sourceSessionID: props.sourceSessionID,
      messageID: props.messageID,
      partID: props.partID,
      version: directory.version()!,
      ordinal,
    })
  function clearPreview() {
    if (props.attachmentPreview && previews.has(props.attachmentPreview)) props.selectAttachmentPreview(undefined)
    previews.clear()
  }
  function load(more = false) {
    clearPreview()
    void directory.load(more)
  }
  onMount(() => load())
  onCleanup(clearPreview)
  return (
    <div class="organization-private-tool-file-page">
      <WorkspaceError error={directory.error()} retry={() => load()} />
      <Show when={directory.loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={directory.loaded() && !directory.state.items.length}>
        <p>{_(messages.empty)}</p>
      </Show>
      <Show when={directory.version()} keyed>
        {(version) => (
          <For each={directory.state.items}>
            {(file) => (
              <PrivateAttachment
                rootSessionID={props.sessionID}
                sourceSessionID={props.sourceSessionID}
                messageID={props.messageID}
                partID={props.partID}
                version={version}
                ordinal={file.ordinal}
                file={file}
                binding={props.binding}
                read={props.read}
                invalidated={props.invalidated}
                previewActive={props.attachmentPreview === identity(file.ordinal)}
                openPreview={() => {
                  const id = identity(file.ordinal)
                  previews.add(id)
                  props.selectAttachmentPreview(id)
                }}
                closePreview={clearPreview}
              />
            )}
          </For>
        )}
      </Show>
      <div class="organization-actions">
        <Show when={directory.earlier()}>
          <Button disabled={directory.loading()} onClick={() => load()}>
            {_(messages.first)}
          </Button>
        </Show>
        <Show when={directory.cursor()}>
          <Button disabled={directory.loading()} onClick={() => load(true)}>
            {_(messages.next)}
          </Button>
        </Show>
      </div>
    </div>
  )
}
