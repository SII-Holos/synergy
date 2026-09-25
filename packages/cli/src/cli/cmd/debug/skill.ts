import { EOL } from "os"
import { Skill } from "@ericsanchezok/synergy-local-runtime/skill"
import { withScopeContext } from "@ericsanchezok/synergy-local-runtime/cli/scope"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"

export const SkillCommand = cmd({
  command: "skill",
  describe: "list all available skills",
  builder: (yargs) => yargs,
  async handler() {
    await withScopeContext(process.cwd(), async () => {
      const skills = await Skill.all()
      process.stdout.write(JSON.stringify(skills, null, 2) + EOL)
    })
  },
})
