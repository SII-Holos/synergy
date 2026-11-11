import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import {
  OrganizationReadContent,
  OrganizationReadProtocol as Read,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { publicationMessages as messages } from "./publication-messages"
import { organizationOwnerFailure } from "./owner-error"
import { WorkspaceError } from "./workspace-error"

type Attachment = Read.Part & { part: Extract<Read.Part["part"], { type: "attachment" }> }
type Target = {
  rootSessionID: string
  sourceSessionID?: string
  record: Attachment
  binding: Protocol.SessionBinding
  read: (query: Read.Query, signal: AbortSignal) => Promise<Read.Result>
}
type Writable = { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
type SaveWindow = Window & {
  showSaveFilePicker?: (input: { suggestedName: string }) => Promise<{ createWritable(): Promise<Writable> }>
}
const unavailable = {
  id: "organization.session.attachmentUnavailable",
  message: "The original attachment is not retained in full and cannot be downloaded.",
}
const previewLimit = 256 * 1024

async function descriptor(input: Target, signal: AbortSignal) {
  const query = {
    operation: "attachmentContent" as const,
    rootSessionID: input.rootSessionID,
    sourceSessionID: input.sourceSessionID,
    messageID: input.record.messageID,
    partID: input.record.partID,
    version: input.record.version,
    offset: 0,
    length: 1,
  }
  const result = Read.Result.parse(await input.read(query, signal))
  signal.throwIfAborted()
  if (!Read.matches(query, result, input.binding) || result.operation !== "attachmentContent")
    throw new OrganizationReadContent.InvalidResponse()
  return result.state === "ready" ? result.reference : undefined
}

export function PrivateAttachment(
  props: Target & {
    previewActive: boolean
    openPreview: () => void
    closePreview: () => void
    invalidated: (error: unknown) => void
  },
) {
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
  function fail(error: unknown) {
    if (organizationOwnerFailure(error)) props.invalidated(error)
    if (!lifetime.aborted) setError(error)
  }
  async function download() {
    if (busy()) return
    setBusy(true)
    setNotice(undefined)
    setError(undefined)
    const active = (transfer = new AbortController())
    const signal = AbortSignal.any([lifetime, active.signal])
    const target: Target = {
      rootSessionID: props.rootSessionID,
      sourceSessionID: props.sourceSessionID,
      record: { ...props.record },
      binding: { ...props.binding },
      read: props.read,
    }
    try {
      const connection = space.connection()!
      if (platform.organization && connection.transport === "desktop") {
        const requestID = generateUUID()
        const cancel = () => {
          void platform.organization!.cancel({ requestID }).catch(() => {})
        }
        signal.addEventListener("abort", cancel, { once: true })
        try {
          const result = await platform.organization.downloadAttachment({
            requestID,
            connectionID: connection.id,
            binding: target.binding,
            query: {
              operation: "attachmentContent",
              rootSessionID: target.rootSessionID,
              sourceSessionID: target.sourceSessionID,
              messageID: target.record.messageID,
              partID: target.record.partID,
              version: target.record.version,
              offset: 0,
              length: 65_536,
            },
          })
          signal.throwIfAborted()
          if (!result.ok) {
            if (result.error.code === "reauthorization_required" || result.error.code === "signed_out")
              space.authorizationRequired(view)
            throw result.error
          }
          if (result.value.kind === "unavailable") setNotice(_(unavailable))
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
      const reference = await descriptor(target, signal)
      if (!reference) {
        setNotice(_(unavailable))
        return
      }
      const handle = await picker.call(window, { suggestedName: reference.filename })
      signal.throwIfAborted()
      const output = await handle.createWritable()
      try {
        const hash = sha256.create()
        const result = await OrganizationReadContent.stream({
          rootSessionID: target.rootSessionID,
          sourceSessionID: target.sourceSessionID,
          messageID: target.record.messageID,
          partID: target.record.partID,
          reference,
          expectedBinding: target.binding,
          signal,
          read: target.read,
          append: (bytes) => output.write(bytes),
          hash: { update: (bytes) => hash.update(bytes), digest: () => bytesToHex(hash.digest()) },
        })
        if (result.state === "unavailable") {
          await output.abort()
          setNotice(_(unavailable))
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
      if (!signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) fail(error)
    } finally {
      if (transfer === active) transfer = undefined
      if (!lifetime.aborted) setBusy(false)
    }
  }
  return (
    <section class="organization-private-attachment" aria-label={props.record.part.filename}>
      <div class="organization-private-attachment-header">
        <FileIcon node={{ path: props.record.part.filename, type: "file" }} aria-hidden="true" />
        <div>
          <strong title={props.record.part.filename}>
            <span>
              {props.record.part.filename.includes(".")
                ? props.record.part.filename.slice(0, props.record.part.filename.lastIndexOf("."))
                : props.record.part.filename}
            </span>
            <span>
              {props.record.part.filename.includes(".")
                ? props.record.part.filename.slice(props.record.part.filename.lastIndexOf("."))
                : ""}
            </span>
          </strong>
          <span>
            {props.record.part.mediaType}
            <Show when={props.record.part.bytes !== undefined}>
              {" "}
              · {new Intl.NumberFormat().format(props.record.part.bytes!)}{" "}
              {_({ id: "organization.session.bytes", message: "bytes" })}
            </Show>
          </span>
        </div>
      </div>
      <div class="organization-private-attachment-actions">
        <Button
          onClick={() => {
            setError(undefined)
            props.previewActive ? props.closePreview() : props.openPreview()
          }}
        >
          {_(props.previewActive ? messages.close : messages.preview)}
        </Button>
        <Button disabled={busy()} onClick={() => void download()}>
          {_(busy() ? { id: "organization.session.downloading", message: "Downloading…" } : messages.download)}
        </Button>
        <Show when={busy()}>
          <Button onClick={() => transfer?.abort()}>
            {_({ id: "organization.session.cancelDownload", message: "Cancel download" })}
          </Button>
        </Show>
      </div>
      <Show when={props.previewActive}>
        <AttachmentPreview {...props} signal={lifetime} fail={fail} />
      </Show>
      <Show when={notice()}>{(notice) => <p role="status">{notice()}</p>}</Show>
      <WorkspaceError error={error()} />
    </section>
  )
}

function AttachmentPreview(props: Target & { signal: AbortSignal; fail: (error: unknown) => void }) {
  const { _ } = useLingui()
  const controller = new AbortController()
  const signal = AbortSignal.any([props.signal, controller.signal])
  const [text, setText] = createSignal<string>()
  const [image, setImage] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  onCleanup(() => {
    controller.abort()
    const url = image()
    if (url) URL.revokeObjectURL(url)
  })
  onMount(
    () =>
      void (async () => {
        try {
          const reference = await descriptor(props, signal)
          if (!reference) {
            setNotice(_(unavailable))
            return
          }
          const image = /^(image\/(png|jpeg|gif|webp|avif))$/i.test(reference.mediaType)
          const text = /^(text\/|application\/(json|xml)(;|$))/i.test(reference.mediaType)
          if (reference.bytes > previewLimit || (!image && !text)) {
            setNotice(_(messages.previewUnavailable))
            return
          }
          const chunks: Uint8Array[] = []
          const hash = sha256.create()
          const result = await OrganizationReadContent.stream({
            rootSessionID: props.rootSessionID,
            sourceSessionID: props.sourceSessionID,
            messageID: props.record.messageID,
            partID: props.record.partID,
            reference,
            expectedBinding: props.binding,
            signal,
            read: props.read,
            append: async (bytes) => {
              chunks.push(bytes.slice())
            },
            hash: { update: (bytes) => hash.update(bytes), digest: () => bytesToHex(hash.digest()) },
          })
          if (result.state === "unavailable") {
            setNotice(_(unavailable))
            return
          }
          signal.throwIfAborted()
          const bytes = new Uint8Array(reference.bytes)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          if (image) setImage(URL.createObjectURL(new Blob([bytes], { type: reference.mediaType })))
          else setText(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        } catch (error) {
          if (!signal.aborted) {
            setFailed(true)
            props.fail(error)
          }
        }
      })(),
  )
  return (
    <div
      class="organization-private-attachment-preview"
      role="region"
      aria-label={_({ id: "organization.session.attachmentPreview", message: "Attachment preview" })}
    >
      <Show when={!failed()}>
        <Show
          when={notice()}
          fallback={
            <Show
              when={image()}
              fallback={
                <Show
                  when={text() !== undefined}
                  fallback={<p role="status">{_({ id: "organization.workspace.loading", message: "Loading…" })}</p>}
                >
                  <pre>{text()}</pre>
                </Show>
              }
            >
              {(url) => <img src={url()} alt={props.record.part.filename} />}
            </Show>
          }
        >
          {(notice) => <p role="status">{notice()}</p>}
        </Show>
      </Show>
    </div>
  )
}
