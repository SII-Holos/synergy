import { resolvePathInput } from "@ericsanchezok/synergy-util/path"
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"

export type DirectoryBrowserStatus = "idle" | "loading" | "ready" | "empty" | "error"

export interface DirectorySearchResolution {
  path: string
  query: string
}

export interface DirectoryBrowserState {
  draft: string
  submitted: string
  resolved: DirectorySearchResolution
  status: DirectoryBrowserStatus
  results: string[]
  error?: string
  requestID: number
}

export interface DirectoryBrowserStatusCopy {
  title: string
  description: string
  icon: SemanticIconTokenName
}

export function resolveDirectorySearch(input: string, home: string): DirectorySearchResolution {
  return resolvePathInput(input, home || "/")
}

export function createInitialDirectoryBrowserState(home = "/"): DirectoryBrowserState {
  return {
    draft: "",
    submitted: "",
    resolved: resolveDirectorySearch("", home),
    status: "idle",
    results: [],
    requestID: 0,
  }
}

export function directoryBrowserCanSubmit(state: Pick<DirectoryBrowserState, "status">, home: string | undefined) {
  return !!home && state.status !== "loading"
}

export function directoryBrowserSetDraft(state: DirectoryBrowserState, draft: string): DirectoryBrowserState {
  return { ...state, draft }
}

export function directoryBrowserClearDraft(state: DirectoryBrowserState, home: string): DirectoryBrowserState {
  if (state.draft) return { ...state, draft: "" }
  return { ...createInitialDirectoryBrowserState(home), requestID: state.requestID + 1 }
}

export function directoryBrowserSubmitStart(
  state: DirectoryBrowserState,
  home: string | undefined,
): DirectoryBrowserState {
  if (!directoryBrowserCanSubmit(state, home)) return state
  const submitted = state.draft.trim()
  return {
    ...state,
    submitted,
    resolved: resolveDirectorySearch(submitted, home ?? "/"),
    status: "loading",
    error: undefined,
    requestID: state.requestID + 1,
  }
}

export function directoryBrowserSubmitSuccess(
  state: DirectoryBrowserState,
  requestID: number,
  results: string[],
): DirectoryBrowserState {
  if (requestID !== state.requestID) return state
  return {
    ...state,
    status: results.length > 0 ? "ready" : "empty",
    results,
    error: undefined,
  }
}

export function directoryBrowserSubmitError(
  state: DirectoryBrowserState,
  requestID: number,
  error: unknown,
): DirectoryBrowserState {
  if (requestID !== state.requestID) return state
  return {
    ...state,
    status: "error",
    error: error instanceof Error ? error.message : "Browse failed",
  }
}

export function directoryBrowserStatusCopy(state: Pick<DirectoryBrowserState, "status" | "submitted" | "results">) {
  switch (state.status) {
    case "loading":
      return {
        title: "Searching folders",
        description: "Checking nearby server directories first.",
        icon: "action.search",
      } satisfies DirectoryBrowserStatusCopy
    case "ready":
      return {
        title: `${state.results.length} folder${state.results.length === 1 ? "" : "s"} found`,
        description: "Choose a folder to open it as a Synergy project.",
        icon: "state.success",
      } satisfies DirectoryBrowserStatusCopy
    case "empty":
      return {
        title: "No folders found",
        description: "Try a more specific path, such as ~/projects, or search from a different parent folder.",
        icon: "state.empty",
      } satisfies DirectoryBrowserStatusCopy
    case "error":
      return {
        title: "Search failed",
        description: "The server could not browse that folder. Check the path and try again.",
        icon: "state.error",
      } satisfies DirectoryBrowserStatusCopy
    case "idle":
    default:
      return {
        title: "Search the server filesystem",
        description:
          "Type a folder path or project name, then search. Use paths like ~/projects or C:\\Users\\you\\code to narrow the scan.",
        icon: "action.search",
      } satisfies DirectoryBrowserStatusCopy
  }
}
