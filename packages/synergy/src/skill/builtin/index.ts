import { clarusAgentParticipation } from "./clarus-agent-participation"
import { skillCreator } from "./skill-creator"
import { synergyConfig } from "./synergy-config"

export interface BuiltinSkill {
  name: string
  description: string
  content: string
  builtin: true
  references?: Record<string, string>
  scripts?: Record<string, string>
  condition?: () => Promise<boolean> | boolean
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [clarusAgentParticipation, skillCreator, synergyConfig]
