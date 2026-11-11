import { createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import { Button } from "@ericsanchezok/synergy-ui/button"
import {
  OrganizationReadContent,
  type OrganizationReadProtocol as Read,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { useSpace } from "@/context/space"
import { organizationOwnerFailure } from "./owner-error"
import { usePlatform } from "@/context/platform"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { publicationMessages as messages } from "./publication-messages"
import { WorkspaceError } from "./workspace-error"

type Writable = { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
type SaveWindow = Window & {
  showSaveFilePicker?: (input: { suggestedName: string }) => Promise<{ createWritable(): Promise<Writable> }>
}
export function PrivateContentDownload(props: {
  invalidated?: (error: unknown) => void
  rootSessionID: string
  sourceSessionID?: string
  messageID: string
  partID: string
  reference: Extract<Read.Content, { kind: "native" }>
  binding: Protocol.SessionBinding
  read: (query: Read.Query, signal: AbortSignal) => Promise<Read.Result>
}) {
  const { _ } = useLingui()
  const space = useSpace()
  const platform = usePlatform()
  const view = space.current()!
  const controller = new AbortController()
  const lifetime = AbortSignal.any([view.signal, controller.signal])
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  const [error, setError] = createSignal<unknown>()
  let transfer: AbortController | undefined
  onCleanup(() => controller.abort())
  async function download() {
    if (busy()) return
    setBusy(true)
    setNotice(undefined)
    setError(undefined)
    const active = (transfer = new AbortController())
    const signal = AbortSignal.any([lifetime, active.signal])
    const reference = props.reference
    const fileName = `${props.partID}-${reference.field}${reference.original === "partial" ? "-retained" : ""}.txt`
    try {
      const connection = space.connection()!
      if (platform.organization && connection.transport === "desktop") {
        const requestID = generateUUID()
        const cancel = () => {
          void platform.organization!.cancel({ requestID }).catch(() => {})
        }
        signal.addEventListener("abort", cancel, { once: true })
        try {
          const result = await platform.organization.downloadContent({
            requestID,
            connectionID: connection.id,
            binding: props.binding,
            reference,
            fileName,
            query: {
              operation: "partContent",
              rootSessionID: props.rootSessionID,
              sourceSessionID: props.sourceSessionID,
              messageID: props.messageID,
              partID: props.partID,
              field: reference.field,
              version: reference.version,
              offset: 0,
              length: 131072,
            },
          })
          signal.throwIfAborted()
          if (!result.ok) {
            if (result.error.code === "reauthorization_required" || result.error.code === "signed_out")
              space.authorizationRequired(view)
            throw result.error
          }
          if (result.value.kind === "preparing")
            setNotice(
              _({
                id: "organization.session.contentPreparing",
                message: "Content is preparing. Retry the download when it is ready.",
              }),
            )
          else if (result.value.result.saved) setNotice(_(messages.saved))
        } finally {
          signal.removeEventListener("abort", cancel)
        }
        return
      }
      const picker = (window as SaveWindow).showSaveFilePicker
      if (!picker) {
        setNotice(_(messages.downloadUnsupported))
        return
      }
      const handle = await picker.call(window, { suggestedName: fileName })
      signal.throwIfAborted()
      const output = await handle.createWritable()
      try {
        const hash = sha256.create()
        const result = await OrganizationReadContent.stream({
          rootSessionID: props.rootSessionID,
          sourceSessionID: props.sourceSessionID,
          messageID: props.messageID,
          partID: props.partID,
          reference,
          expectedBinding: props.binding,
          signal,
          read: props.read,
          append: (bytes) => output.write(bytes),
          hash: { update: (bytes) => hash.update(bytes), digest: () => bytesToHex(hash.digest()) },
        })
        if (result.state === "preparing") {
          await output.abort()
          setNotice(
            _({
              id: "organization.session.contentPreparing",
              message: "Content is preparing. Retry the download when it is ready.",
            }),
          )
          return
        }
        signal.throwIfAborted()
        await output.close()
        if (!signal.aborted) setNotice(_(messages.saved))
      } catch (error) {
        await output.abort().catch(() => {})
        throw error
      }
    } catch (error) {
      if (!signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
        if (organizationOwnerFailure(error)) props.invalidated?.(error)
        if (!signal.aborted) setError(error)
      }
    } finally {
      if (transfer === active) transfer = undefined
      if (!lifetime.aborted) setBusy(false)
    }
  }
  return (
    <div class="organization-native-download">
      <Button disabled={busy()} onClick={() => void download()}>
        {_(busy() ? { id: "organization.session.downloading", message: "Downloading…" } : messages.download)}
      </Button>
      <Show when={busy()}>
        <Button onClick={() => transfer?.abort()}>
          {_({ id: "organization.session.cancelDownload", message: "Cancel download" })}
        </Button>
      </Show>
      <Show when={notice()}>{(notice) => <p role="status">{notice()}</p>}</Show>
      <WorkspaceError error={error()} />
    </div>
  )
}
