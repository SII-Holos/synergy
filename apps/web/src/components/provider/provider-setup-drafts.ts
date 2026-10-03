import { createStore } from "solid-js/store"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

export type ProviderSetupDraft = {
  id: string
  name: string
  endpoint: string
  apiKey: string
  targetID?: string
  credentialsSaved?: boolean
}

export function nextProviderAccountName(names: string[], format: (number: number) => string) {
  const occupied = new Set(names)
  let number = 2
  while (occupied.has(format(number))) number++
  return format(number)
}

export function createProviderSetupDrafts() {
  const [drafts, setDrafts] = createStore<Record<string, ProviderSetupDraft>>({})
  const [view, setView] = createStore({
    selectedID: undefined as string | undefined,
    addingSourceID: undefined as string | undefined,
    catalogOpen: false,
    query: "",
    accountQuery: "",
    origin: undefined as { catalog: boolean; providerID?: string; scroll: number } | undefined,
  })
  return {
    view,
    setView,
    peek(key: string) {
      return drafts[key]
    },
    get(key: string) {
      if (!drafts[key]) setDrafts(key, { id: `account-${generateUUID()}`, name: "", endpoint: "", apiKey: "" })
      return drafts[key]
    },
    update(key: string, value: Partial<ProviderSetupDraft>) {
      setDrafts(key, value)
    },
    remove(key: string) {
      setDrafts(key, undefined!)
    },
    clear() {
      for (const key of Object.keys(drafts)) setDrafts(key, undefined!)
      setView({
        selectedID: undefined,
        addingSourceID: undefined,
        catalogOpen: false,
        query: "",
        accountQuery: "",
        origin: undefined,
      })
    },
  }
}

export type ProviderSetupDrafts = ReturnType<typeof createProviderSetupDrafts>
