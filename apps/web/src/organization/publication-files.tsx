import { createSignal, For, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { OrgPublicationFile, OrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { usePlatform } from "@/context/platform"
import { useSpace } from "@/context/space"
import { organizationOwnerFailure } from "./owner-error"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { publicationFileHash, streamPublicationDownload } from "./publication-transfer"
import { WorkspaceError } from "./workspace-error"
import { publicationMessages as messages } from "./publication-messages"

export type PublicationTarget =
  | { kind: "knowledge"; itemID: string; version: number }
  | { kind: "artifact"; artifactID: string; version: number }
  | { kind: "session"; sessionID: string; shareGeneration: number }

export async function publicationContent(
  api: OrganizationClient,
  target: PublicationTarget,
  fileID: string,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  const options = { throwOnError: true, signal, parseAs: "blob", headers: { Range: `bytes=${start}-${end}` } } as const
  const result =
    target.kind === "knowledge"
      ? await api.orgKnowledge.content({ ...target, fileID }, options)
      : target.kind === "artifact"
        ? await api.orgArtifacts.content({ ...target, fileID }, options)
        : await api.orgSessionSync.downloadBlob(
            { sessionID: target.sessionID, shareGeneration: target.shareGeneration, hash: fileID },
            options,
          )
  if (!(result.data instanceof Blob)) throw new Error("Invalid publication content response")
  return {
    bytes: new Uint8Array(await result.data.arrayBuffer()),
    status: result.response.status,
    contentRange: result.response.headers.get("content-range"),
  }
}

type SaveHandle = {
  createWritable(): Promise<{ write(value: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>
}
type SaveWindow = Window & { showSaveFilePicker?: (input: { suggestedName: string }) => Promise<SaveHandle> }

export function PublicationFiles(props: {
  files: OrgPublicationFile[]
  target: PublicationTarget
  more?: () => void
  loading?: boolean
  invalidated?: (error: unknown) => void
}) {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const platform = usePlatform()
  const view = space.current()!
  const api = space.client()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  onCleanup(() => controller.abort())
  const [busy, setBusy] = createSignal<string>()
  const [error, setError] = createSignal<unknown>()
  const [notice, setNotice] = createSignal<string>()
  const [preview, setPreview] = createSignal<{ file: OrgPublicationFile; text?: string; image?: string }>()
  let imageURL: string | undefined
  function close() {
    if (imageURL) URL.revokeObjectURL(imageURL)
    imageURL = undefined
    setPreview(undefined)
  }
  onCleanup(close)
  function fail(error: unknown) {
    if (signal.aborted) return
    const failure = organizationOwnerFailure(error)
    if (failure) {
      close()
      props.invalidated?.(error)
      if (failure === "authentication") space.authorizationRequired(view)
    }
    if (!signal.aborted) setError(error)
  }
  async function show(file: OrgPublicationFile) {
    if (busy()) return
    setError(undefined)
    setNotice(undefined)
    const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mediaType)
    const text = file.mediaType.startsWith("text/") || /^(application\/(json|yaml|xml))$/.test(file.mediaType)
    if (!file.bytes || (!image && !text) || file.bytes > (image ? 4 * 1024 * 1024 : 256 * 1024)) {
      setNotice(_(messages.previewUnavailable))
      return
    }
    setBusy(file.fileID)
    try {
      const content = await publicationContent(api, props.target, file.fileID, 0, file.bytes - 1, signal)
      if (signal.aborted) return
      if (
        content.status !== 206 ||
        content.contentRange !== `bytes 0-${file.bytes - 1}/${file.bytes}` ||
        content.bytes.length !== file.bytes
      )
        throw new Error("Invalid publication preview range")
      if ((await publicationFileHash(new Blob([content.bytes]), signal)) !== file.sha256)
        throw new Error("Invalid publication preview checksum")
      close()
      if (image) {
        imageURL = URL.createObjectURL(new Blob([content.bytes], { type: file.mediaType }))
        setPreview({ file, image: imageURL })
      } else setPreview({ file, text: new TextDecoder().decode(content.bytes) })
    } catch (error) {
      fail(error)
    } finally {
      if (!signal.aborted) setBusy(undefined)
    }
  }
  async function download(file: OrgPublicationFile) {
    if (busy()) return
    setError(undefined)
    setNotice(undefined)
    const connection = space.connection()!
    const target = props.target
    const fileName = file.path.split("/").at(-1)!
    setBusy(file.fileID)
    try {
      if (platform.organization && connection.transport === "desktop") {
        const requestID = generateSecureUUID()
        const cancel = () => void platform.organization!.cancel({ requestID }).catch(() => {})
        signal.addEventListener("abort", cancel, { once: true })
        try {
          const path =
            target.kind === "knowledge"
              ? `/org/v1/knowledge/${encodeURIComponent(target.itemID)}/versions/${target.version}/files/${file.fileID}/content`
              : target.kind === "artifact"
                ? `/org/v1/artifacts/${encodeURIComponent(target.artifactID)}/versions/${target.version}/files/${file.fileID}/content`
                : `/org/v1/sessions/${encodeURIComponent(target.sessionID)}/blobs/${file.fileID}/content?shareGeneration=${target.shareGeneration}`
          const result = await platform.organization.download({
            requestID,
            connectionID: connection.id,
            path,
            fileName,
            bytes: file.bytes,
            sha256: file.sha256,
          })
          if (!result.ok) throw result.error
          if (result.value.saved && !signal.aborted) setNotice(_(messages.saved))
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
        await streamPublicationDownload({
          file,
          signal: signal,
          read: (start, end) => publicationContent(api, target, file.fileID, start, end, signal),
          append: (bytes) => output.write(bytes),
        })
        await output.close()
        if (!signal.aborted) setNotice(_(messages.saved))
      } catch (error) {
        await output.abort().catch(() => {})
        throw error
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) fail(error)
    } finally {
      if (!signal.aborted) setBusy(undefined)
    }
  }
  return (
    <div class="organization-publication-files">
      <WorkspaceError error={error()} />
      <Show when={notice()}>
        <p role="status">{notice()}</p>
      </Show>
      <ul class="organization-file-list">
        <For each={props.files}>
          {(file) => (
            <li>
              <div>
                <strong>{file.path}</strong>
                <span>
                  {file.mediaType} · {new Intl.NumberFormat(i18n().locale).format(file.bytes)}
                </span>
              </div>
              <Button disabled={!!busy()} onClick={() => void show(file)}>
                {_(messages.preview)}
              </Button>
              <Button disabled={!!busy()} onClick={() => void download(file)}>
                {_(messages.download)}
              </Button>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.more}>
        <Button disabled={props.loading} onClick={props.more}>
          {_({ id: "organization.workspace.more", message: "Load more" })}
        </Button>
      </Show>
      <Show when={preview()}>
        {(value) => (
          <section class="organization-file-preview" aria-label={value().file.path}>
            <div class="organization-page-heading">
              <h3>{value().file.path}</h3>
              <Button onClick={close}>{_(messages.close)}</Button>
            </div>
            <Show when={value().image} fallback={<pre>{value().text}</pre>}>
              {(url) => <img src={url()} alt={value().file.path} />}
            </Show>
          </section>
        )}
      </Show>
    </div>
  )
}
