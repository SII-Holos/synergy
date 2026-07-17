import type { ControlProfileId } from "@/context/input"
import type { PromptDraftSnapshot } from "@/utils/prompt"
import type { BlueprintSlot, PromptInputMode } from "@/components/prompt-input/types"
import type { NewSessionWorkspaceSelection } from "./worktree-session"

export type NewSessionRecovery = {
  draft: PromptDraftSnapshot
  mode: PromptInputMode
  workspaceSelection: NewSessionWorkspaceSelection
  controlProfile: ControlProfileId
  plan: boolean
  lattice: { mode: "auto" | "collaborative"; maxModelCalls: number } | null
  lightLoop: boolean
  blueprintSlot: BlueprintSlot | null
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  autoSubmit: boolean
}

type NewSessionRecoveryActionsInput = {
  recovery: NewSessionRecovery
  setRecovery: (recovery: NewSessionRecovery) => void
  deleteSession: () => Promise<void>
  clearTransition: () => void
  navigateToComposer: () => void
}

export function createNewSessionRecoveryActions(input: NewSessionRecoveryActionsInput) {
  let started = false
  const recover = async (autoSubmit: boolean) => {
    if (started) return
    started = true
    input.setRecovery({ ...input.recovery, autoSubmit })
    await input.deleteSession()
    input.clearTransition()
    input.navigateToComposer()
  }

  return {
    retry: () => recover(true),
    dismiss: () => recover(false),
  }
}

type RestoreNewSessionRecoveryInput = {
  recovery: NewSessionRecovery
  setDraft: (draft: PromptDraftSnapshot) => void
  setMode: (mode: PromptInputMode) => void
  setWorkspaceSelection: (selection: NewSessionWorkspaceSelection) => void
  setControlProfile: (profile: ControlProfileId) => void
  setPlan: (enabled: boolean) => void
  setLattice: (config: NewSessionRecovery["lattice"]) => void
  setLightLoop: (enabled: boolean) => void
  setBlueprintSlot: (slot: BlueprintSlot | null) => void
  setAgent: (agent: string) => void
  setModel: (model: NewSessionRecovery["model"]) => void
  setVariant: (variant: string | undefined, model: NewSessionRecovery["model"]) => void
}

export function restoreNewSessionRecovery(input: RestoreNewSessionRecoveryInput) {
  const recovery = input.recovery
  input.setDraft(recovery.draft)
  input.setMode(recovery.mode)
  input.setWorkspaceSelection(recovery.workspaceSelection)
  input.setControlProfile(recovery.controlProfile)
  input.setPlan(recovery.plan)
  input.setLattice(recovery.lattice)
  input.setLightLoop(recovery.lightLoop)
  input.setBlueprintSlot(recovery.blueprintSlot)
  input.setAgent(recovery.agent)
  input.setModel(recovery.model)
  input.setVariant(recovery.variant, recovery.model)
  return recovery.autoSubmit
}
