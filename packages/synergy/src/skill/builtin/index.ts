import { synergySkillCreator } from "./synergy-skill-creator"
import { clarusAgentParticipation } from "./clarus-agent-participation"
import { synergyConfig } from "./synergy-config"

export interface BuiltinSkill {
  name: string
  description: string
  content: string
  builtin: true
  references?: Record<string, string>
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [synergySkillCreator, synergyConfig, clarusAgentParticipation]
