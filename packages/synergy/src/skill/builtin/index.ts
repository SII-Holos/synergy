import { skillCreator } from "./skill-creator"
import { gitGuide } from "./git-guide"
import { frontendDesign } from "./frontend-design"
import { agentBrowser } from "./agent-browser"
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

export const BUILTIN_SKILLS: BuiltinSkill[] = [skillCreator, gitGuide, frontendDesign, agentBrowser, synergyConfig]
