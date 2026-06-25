import { EOL } from "os"
import { Skill } from "../../../skill"
import { withScopeContext } from "../../scope"
import { cmd } from "../cmd"

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
