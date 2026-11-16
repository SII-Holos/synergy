import { z } from "zod"
import { capability, definePlugin, tool } from "@ericsanchezok/synergy-plugin"

export default definePlugin({
  id: "agent-shell-sequence-fixture",
  version: "1.0.0",
  description: "Two native shells in one Agent Tool invocation",
  capabilities: [capability("shell.execute")],
  contributions: [
    tool({
      id: "two-shells",
      description: "Execute two independently owned shell calls",
      requiresWorkspace: false,
      requires: ["shell.execute"],
      input: z.object({ executable: z.string() }),
      async handler(input, context) {
        const shell = context.shell
        if (!shell) throw new Error("The shell capability was not composed")
        const first = await shell.run({
          command: [
            input.executable,
            "-e",
            "await Bun.write('first.txt', 'first native effect'); process.stdout.write('first')",
          ],
        })
        const second = await shell.run({
          command: [
            input.executable,
            "-e",
            "await Bun.write('second.txt', 'second native effect'); process.stdout.write('second')",
          ],
        })
        return { output: JSON.stringify({ first, second }) }
      },
    }),
  ],
})
