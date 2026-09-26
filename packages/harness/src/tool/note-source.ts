import { RuntimeContext } from "../lifecycle/context"
/**
 * S9d note source port: the L1 bash virtual-file materializer reads note
 * content through this registered source instead of importing the note
 * product domain. The L4 product manifest registers the concrete source;
 * unregistered, note references fail to materialize with a clear error.
 */
export namespace ToolNoteSource {
  export interface Source {
    noteExtension: string
    readNoteMarkdown(scopeID: string, noteID: string): Promise<string>
  }

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source | undefined): void {
    const instanceState = runtimeState()

    if (instanceState.source === value) return
    RuntimeContext.assertCompositionOpen("tool/note-source")
    if (instanceState.source && value) throw new Error("tool/note-source is already registered")
    instanceState.source = value
  }

  export function get(): Source | undefined {
    const instanceState = runtimeState()

    return instanceState.source
  }
}
