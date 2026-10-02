import { createRoot, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { useGlobalSDK } from "@/context/global-sdk"
import { Persist, persisted } from "@/utils/persist"
import { createNoteDocumentController, type NoteDocumentController } from "./document-controller"
import { createNoteDraftStorage } from "./draft-storage"
import { hasDirtyFields } from "./note-sync"

export const { use: useNoteDocuments, provider: NoteDocumentsProvider } = createSimpleContext({
  name: "NoteDocuments",
  gate: false,
  init: () => {
    const sdk = useGlobalSDK()
    const windowKey = sessionStorage.getItem("synergy.note.window") ?? generateUUID()
    sessionStorage.setItem("synergy.note.window", windowKey)
    const documents = new Map<string, { controller: NoteDocumentController; dispose: () => void; readers: number }>()
    const prune = (keep: string) => {
      for (const [key, value] of documents) {
        if (documents.size <= 32) return
        if (
          key === keep ||
          value.readers ||
          value.controller.saving() ||
          hasDirtyFields(value.controller.dirty()) ||
          value.controller.view.hasHistory?.()
        )
          continue
        value.controller.dispose()
        value.dispose()
        documents.delete(key)
      }
    }
    const navigation = new Map<
      string,
      { state: { open: boolean; width: number }; setOpen: (open: boolean) => void; setWidth: (width: number) => void }
    >()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        ![...documents.values()].some(
          ({ controller }) => controller.backupUnavailable() && hasDirtyFields(controller.dirty()),
        )
      )
        return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    onCleanup(() => window.removeEventListener("beforeunload", beforeUnload))
    onCleanup(() => {
      for (const document of documents.values()) {
        document.controller.dispose()
        document.dispose()
      }
    })
    return {
      retain(scopeID: string, id: string) {
        const key = JSON.stringify([sdk.url, scopeID, id])
        const document = documents.get(key)
        if (!document) throw new Error("Note controller must be loaded before retention")
        document.readers++
        return () => {
          document.readers--
          prune("")
        }
      },
      navigation(scopeID: string) {
        const key = JSON.stringify([sdk.url, scopeID])
        const existing = navigation.get(key)
        if (existing) return existing
        const [state, setState] = persisted(
          Persist.workspace(Persist.scopeKey(sdk.url, scopeID), "notes-navigation"),
          createStore({ open: true, width: 260 }),
        )
        const value = {
          state,
          setOpen: (open: boolean) => setState("open", open),
          setWidth: (width: number) => setState("width", Math.max(208, Math.min(420, width))),
        }
        navigation.set(key, value)
        return value
      },
      get(scopeID: string, id: string) {
        const key = JSON.stringify([sdk.url, scopeID, id])
        const existing = documents.get(key)
        if (existing) {
          documents.delete(key)
          documents.set(key, existing)
          return existing.controller
        }
        return createRoot((dispose) => {
          const client = sdk.client
          const backup = createNoteDraftStorage(
            Persist.workspace(Persist.scopeKey(sdk.url, scopeID), `note:${windowKey}:${id}`),
          )
          const controller = createNoteDocumentController({
            id,
            recover: backup.draft,
            backupAvailable: backup.available,
            persist: backup.write,
            update: async (notePatchInput) => {
              const result = await client.note.update({ id, scopeID, notePatchInput }, { throwOnError: true })
              if (!result.data) throw new Error("Note save returned no document")
              return result.data
            },
          })
          documents.set(key, { controller, dispose, readers: 0 })
          prune(key)
          return controller
        })
      },
    }
  },
})
