import { createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { createSynergyClient, type ProjectCreated } from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { requestErrorMessage } from "@/utils/error"
import { useProjectDirectoryPicker } from "./project-directory-picker"
import { ProjectFolderFields } from "./project-folder-fields"
import { ComputerMenu } from "./computer-menu"
import { useConfirm } from "./confirm-dialog"
import { locationCopy } from "./task-location-copy"
import { projectEntryCopy as copy } from "./project-entry-copy"
import "./project-flow.css"

export function DialogCreateProject(props: {
  onCreated: (scopeID: string, url: string) => void | Promise<void | boolean>
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const confirm = useConfirm()
  const server = useServer()
  const platform = usePlatform()
  const [url, setUrl] = createSignal(server.url)
  const [name, setName] = createSignal("")
  const [editedName, setEditedName] = createSignal(false)
  const [selections, setSelections] = createStore<Record<string, { folders: string[]; main: string }>>({})
  const selected = () => selections[url()] ?? { folders: [], main: "" }
  const [pending, setPending] = createSignal(false)
  const [picking, setPicking] = createSignal(false)
  const [error, setError] = createSignal("")
  const [existing, setExisting] = createSignal<ProjectCreated>()
  const [created, setCreated] = createSignal<ProjectCreated>()
  const client = createMemo(() => createSynergyClient({ baseUrl: url(), fetch: platform.fetch }))
  const picker = useProjectDirectoryPicker(url)
  const dirty = () => !!name() || Object.values(selections).some((selection) => selection.folders.length)
  async function close() {
    if (pending() || picking()) return
    if (
      dirty() &&
      !(await confirm.ask({
        title: locationCopy.discard,
        description: locationCopy.discardDescription,
        confirmLabel: locationCopy.discard,
        tone: "warning",
      }))
    )
      return
    dialog.close()
  }
  function change(folders: string[], main: string) {
    setSelections(url(), { folders, main })
    setExisting(undefined)
    setCreated(undefined)
    setError("")
  }
  async function add() {
    if (picking() || pending()) return
    const connection = url()
    setPicking(true)
    try {
      const result = await picker.pickProjectDirectories({ title: _(copy.chooseFolders), multiple: true })
      if (!result || connection !== url()) return
      const folders = [...new Set([...selected().folders, ...result.directoryPaths])]
      change(folders, selected().main || folders[0])
      if (!editedName()) setName(getFilename(folders[0]))
    } finally {
      setPicking(false)
    }
  }
  async function submit() {
    if (pending() || picking() || !name().trim() || !selected().main) return
    const connection = url()
    setPending(true)
    setError("")
    try {
      const result =
        existing() ??
        created() ??
        (
          await client().project.create(
            {
              projectCreateInput: {
                name: name().trim(),
                directories: selected().folders,
                mainDirectory: selected().main,
              },
            },
            { throwOnError: true },
          )
        ).data
      if (result.existing && !existing()) {
        setExisting(result)
        return
      }
      setCreated(result)
      if ((await props.onCreated(result.scope.id, connection)) === false) return
      dialog.close()
      if (!result.existing) showToast({ type: "success", title: _(copy.created) })
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-component="prompt-input"][contenteditable="true"]')?.focus(),
      )
    } catch (failure) {
      setError(requestErrorMessage(failure, _(copy.failed)))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      title={
        <span class="project-create-title">
          <span class="project-create-icon">
            <Icon name={getSemanticIcon("project.main")} />
          </span>
          {_(copy.create)}
        </span>
      }
      size="compact"
      class="project-create-dialog"
      dismissible={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        void close()
      }}
      action={
        <button
          type="button"
          class="project-icon-button"
          disabled={pending()}
          aria-label={_(locationCopy.cancel)}
          onClick={() => void close()}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
      footer={
        <div data-slot="dialog-actions">
          <Button variant="secondary" size="large" disabled={pending() || picking()} onClick={() => void close()}>
            {_(locationCopy.cancel)}
          </Button>
          <Button
            variant="primary"
            size="large"
            class="project-submit"
            disabled={pending() || picking() || !name().trim() || !selected().main}
            onClick={() => void submit()}
            aria-busy={pending()}
          >
            {_(pending() ? copy.creating : existing() ? copy.openExisting : copy.createAction)}
          </Button>
        </div>
      }
    >
      <form
        class="project-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <TextField
          autofocus
          label={_(copy.name)}
          placeholder={_(copy.namePlaceholder)}
          value={name()}
          onChange={(value) => {
            setEditedName(true)
            setName(value)
          }}
          disabled={pending()}
        />
        <ProjectFolderFields
          folders={selected().folders}
          main={selected().main}
          onChange={change}
          onAdd={() => void add()}
          disabled={pending() || picking()}
          computer={
            <ComputerMenu
              value={url()}
              disabled={pending() || picking()}
              onChange={(value) => {
                setUrl(value)
                setExisting(undefined)
                setCreated(undefined)
                setError("")
              }}
            />
          }
        />
        <Show when={existing()}>
          <p class="project-inline-note" role="status">
            {_(copy.existing)} <strong>{existing()?.scope.name}</strong>
          </p>
        </Show>
        <Show when={error()}>
          <p class="project-inline-error" role="alert">
            {error()}
          </p>
        </Show>
      </form>
    </Dialog>
  )
}
