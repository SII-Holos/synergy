/**
 * S9c source inversion: the L1 session recovery pass reaches blueprint note
 * projections (active-loop binding on notes) through this registry instead
 * of importing the note product domain. The L4 product manifest registers
 * the implementation; unregistered access degrades quietly (no notes).
 */
export namespace SessionNoteAccess {
  export interface BlueprintNote {
    noteID: string
    activeLoopID?: string
  }

  export interface Provider {
    /** Blueprint projection of a note; undefined when missing or not a
     * blueprint note. */
    getBlueprintNote(scopeID: string, noteID: string): Promise<BlueprintNote | undefined>
    /** All blueprint-note projections in the scope, archived included. */
    listBlueprintNotes(scopeID: string): Promise<BlueprintNote[]>
    setBlueprintActiveLoop(scopeID: string, noteID: string, activeLoopID: string | null): Promise<void>
  }

  let provider: Provider | undefined

  export function register(value: Provider): void {
    provider = value
  }

  export function get(): Provider | undefined {
    return provider
  }

  export async function getBlueprintNote(scopeID: string, noteID: string): Promise<BlueprintNote | undefined> {
    return provider?.getBlueprintNote(scopeID, noteID).catch(() => undefined)
  }

  export async function listBlueprintNotes(scopeID: string): Promise<BlueprintNote[]> {
    return provider?.listBlueprintNotes(scopeID).catch(() => []) ?? []
  }

  export async function setBlueprintActiveLoop(
    scopeID: string,
    noteID: string,
    activeLoopID: string | null,
  ): Promise<void> {
    await provider?.setBlueprintActiveLoop(scopeID, noteID, activeLoopID)
  }
}
