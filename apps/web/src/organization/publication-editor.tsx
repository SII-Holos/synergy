import { createSignal, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import type { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { useSpace } from "@/context/space"
import { WorkspaceError } from "./workspace-error"
import { publicationMessages as messages } from "./publication-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import { uploadPublication } from "./publication-transfer"

export function PublicationEditor(props: {
  purpose: "knowledge" | "artifact"
  scope: Publication.Scope
  sourceSessionID?: string
  existing?: { id: string; revision: number; title: string; kind?: "material" | "skill" }
  cancel: () => void
  published: () => void
}) {
  const space = useSpace()
  const { _, i18n } = useLingui()
  const api = space.client()!
  const owner = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([owner.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const [title, setTitle] = createSignal(props.existing?.title ?? "")
  const [kind, setKind] = createSignal<"material" | "skill">(props.existing?.kind ?? "material")
  const [state, setState] = createStore({ files: [] as { path: string; blob: File }[] })
  const [busy, setBusy] = createSignal(false)
  const [attempted, setAttempted] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [progress, setProgress] = createSignal<{ path: string; bytes: number; total: number }>()
  const requestID = generateSecureUUID()
  const publishRequestID = generateSecureUUID()
  const id = props.existing?.id ?? generateSecureUUID()
  let filesInput: HTMLInputElement | undefined
  let folderInput: HTMLInputElement | undefined
  function select(files: FileList | null, folder: boolean) {
    if (!files || attempted()) return
    const selection = Array.from(files).map((blob) => ({
      blob,
      path: folder ? blob.webkitRelativePath.split("/").slice(1).join("/") : blob.name,
    }))
    setState("files", reconcile(selection))
    setError(undefined)
  }
  async function publish() {
    if (busy() || !state.files.length || !title().trim()) return
    setBusy(true)
    setAttempted(true)
    setError(undefined)
    try {
      const upload = await uploadPublication(api, {
        requestID,
        purpose: props.purpose,
        scope: props.scope,
        sourceSessionID: props.sourceSessionID,
        files: state.files,
        signal,
        progress: setProgress,
      })
      if (props.purpose === "knowledge") {
        await api.orgKnowledge.publish(
          {
            requestID: publishRequestID,
            itemID: id,
            expectedRevision: props.existing?.revision ?? 0,
            uploadID: upload.uploadID,
            title: title().trim(),
            kind: kind(),
          },
          options,
        )
      } else {
        await api.orgArtifacts.publish(
          {
            requestID: publishRequestID,
            artifactID: id,
            expectedRevision: props.existing?.revision ?? 0,
            uploadID: upload.uploadID,
            title: title().trim(),
          },
          options,
        )
      }
      if (!signal.aborted) props.published()
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  const size = () =>
    new Intl.NumberFormat(i18n().locale).format(state.files.reduce((bytes, file) => bytes + file.blob.size, 0))
  return (
    <form
      class="organization-editor"
      onSubmit={(event) => {
        event.preventDefault()
        void publish()
      }}
    >
      <h3>{_(props.existing ? messages.publishVersion : messages.publish)}</h3>
      <p>{_(messages.publishHint)}</p>
      <WorkspaceError error={error()} />
      <TextField
        label={_(messages.title)}
        value={title()}
        onChange={setTitle}
        required
        maxLength={200}
        disabled={attempted()}
      />
      <Show when={props.purpose === "knowledge"}>
        <MenuField
          ariaLabel={_(messages.kind)}
          value={kind()}
          onChange={setKind}
          disabled={attempted() || !!props.existing}
          options={[
            { value: "material", label: _(messages.material) },
            { value: "skill", label: _(messages.skill) },
          ]}
        />
      </Show>
      <Show when={kind() === "skill" && props.purpose === "knowledge"}>
        <p>{_(messages.skillHint)}</p>
      </Show>
      <input
        ref={filesInput}
        type="file"
        multiple
        class="sr-only"
        tabindex={-1}
        aria-label={_(messages.chooseFiles)}
        disabled={attempted()}
        onChange={(event) => select(event.currentTarget.files, false)}
      />
      <input
        ref={(element) => {
          folderInput = element
          element.setAttribute("webkitdirectory", "")
        }}
        type="file"
        multiple
        class="sr-only"
        tabindex={-1}
        aria-label={_(messages.chooseFolder)}
        disabled={attempted()}
        onChange={(event) => select(event.currentTarget.files, true)}
      />
      <div class="organization-actions">
        <Button type="button" disabled={attempted() || kind() === "skill"} onClick={() => filesInput?.click()}>
          {_(messages.chooseFiles)}
        </Button>
        <Button type="button" disabled={attempted()} onClick={() => folderInput?.click()}>
          {_(messages.chooseFolder)}
        </Button>
      </div>
      <Show when={state.files.length}>
        <p>{_({ ...messages.selected, values: { count: state.files.length, bytes: size() } })}</p>
      </Show>
      <Show when={progress()}>{(value) => <p role="status">{_({ ...messages.uploading, values: value() })}</p>}</Show>
      <div class="organization-actions">
        <Button
          size="large"
          variant="primary"
          type="submit"
          disabled={busy() || !state.files.length || !title().trim()}
        >
          {_(busy() ? common.working : attempted() ? common.retry : messages.publish)}
        </Button>
        <Button
          size="large"
          type="button"
          variant="ghost"
          onClick={() => {
            controller.abort()
            props.cancel()
          }}
        >
          {_(common.cancel)}
        </Button>
      </div>
    </form>
  )
}
