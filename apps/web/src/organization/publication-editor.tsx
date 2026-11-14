import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { useSpace } from "@/context/space"
import { organizationOwnerFailure } from "./owner-error"
import { WorkspaceError } from "./workspace-error"
import { publicationMessages as messages } from "./publication-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import { uploadPublication } from "./publication-transfer"
import { PublicationIdentity, preparePublicationRecord, type PublicationRecord } from "./publication-record"
import { createOrganizationPublicationStore } from "./publication-store"
import { submitPublication } from "./publication-recovery"

export function PublicationEditor(props: {
  purpose: "knowledge" | "artifact"
  scope: Publication.Scope
  sourceSessionID?: string
  existing?: { id: string; revision: number; title: string; kind?: "material" | "skill" }
  cancel: () => void
  published: () => void
  invalidated?: (error: unknown) => void
  titleRef?: (element: HTMLInputElement) => void
}) {
  const space = useSpace()
  const { _, i18n } = useLingui()
  const api = space.client()!
  const owner = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([owner.signal, controller.signal])
  const store = createOrganizationPublicationStore({ identity: PublicationIdentity.parse(owner.identity), signal })
  const target = () =>
    JSON.stringify([
      props.purpose,
      Publication.Scope.parse(props.scope),
      props.sourceSessionID,
      props.existing?.id,
      props.existing?.revision,
    ])
  const originalTarget = target()
  const current = () => !signal.aborted && target() === originalTarget
  createEffect(() => {
    if (target() !== originalTarget) controller.abort()
  })
  onCleanup(() => {
    controller.abort()
    store.dispose()
  })
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
  let pending: PublicationRecord | undefined
  let selection:
    | {
        purpose: "knowledge" | "artifact"
        scope: Publication.Scope
        sourceSessionID?: string
        revision: number
        title: string
        kind: "material" | "skill"
        files: { path: string; blob: File }[]
      }
    | undefined
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
    if (!current() || busy() || !state.files.length || !title().trim()) return
    const completed = props.published
    const invalidated = props.invalidated
    selection ??= {
      purpose: props.purpose,
      scope: Publication.Scope.parse(props.scope),
      sourceSessionID: props.sourceSessionID,
      revision: props.existing?.revision ?? 0,
      title: title().trim(),
      kind: kind(),
      files: state.files.map((file) => ({ path: file.path, blob: file.blob })),
    }
    const original = selection
    setBusy(true)
    setAttempted(true)
    setError(undefined)
    try {
      if (!pending) {
        const upload = await uploadPublication(api, {
          requestID,
          purpose: original.purpose,
          scope: original.scope,
          sourceSessionID: original.sourceSessionID,
          files: original.files,
          signal,
          progress: (value) => {
            if (current()) setProgress(value)
          },
        })
        if (!current()) return
        const request = {
          requestID: publishRequestID,
          expectedRevision: original.revision,
          uploadID: upload.uploadID,
          title: original.title,
        }
        pending = await store.put(
          preparePublicationRecord({
            identity: PublicationIdentity.parse(owner.identity),
            source: { scope: original.scope, sourceSessionID: original.sourceSessionID },
            upload,
            publication:
              original.purpose === "knowledge"
                ? { purpose: "knowledge", request: { ...request, itemID: id, kind: original.kind } }
                : { purpose: "artifact", request: { ...request, artifactID: id } },
            createdAt: Date.now(),
          }),
        )
      }
      if (!current()) return
      await submitPublication(api, store, pending, signal)
      if (current()) completed()
    } catch (error) {
      if (current()) {
        if (organizationOwnerFailure(error) && invalidated) invalidated(error)
        else setError(error)
      }
    } finally {
      if (current()) setBusy(false)
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
      <WorkspaceError error={error()} />
      <TextField
        ref={props.titleRef}
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
