import z from "zod"
import { Worktree } from "./worktree"

export namespace WorktreeCommand {
  export const Input = z.discriminatedUnion("action", [
    z.object({ sessionID: z.string(), action: z.literal("list") }),
    z.object({
      sessionID: z.string(),
      action: z.literal("new"),
      target: z.string().optional(),
      force: z.boolean().optional(),
    }),
    z.object({
      sessionID: z.string(),
      action: z.literal("enter"),
      target: z.string().min(1),
      force: z.boolean().optional(),
    }),
    z.object({ sessionID: z.string(), action: z.literal("status") }),
    z.object({ sessionID: z.string(), action: z.literal("leave") }),
    z.object({
      sessionID: z.string(),
      action: z.literal("remove"),
      target: z.string().min(1),
      force: z.boolean().optional(),
    }),
  ])
  export type Input = z.infer<typeof Input>

  const argRegex = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g
  const quoteTrimRegex = /^["']|["']$/g

  export function parse(sessionID: string, argumentsText: string): Input {
    const parts = (argumentsText.match(argRegex) ?? []).map((part) => part.replace(quoteTrimRegex, ""))
    const action = parts.shift() ?? "status"
    const forceIndex = parts.findIndex((part) => part === "--force" || part === "-f")
    const force = forceIndex >= 0
    if (forceIndex >= 0) parts.splice(forceIndex, 1)
    return Input.parse({ sessionID, action, target: parts.join(" ") || undefined, force })
  }

  function formatList(items: Worktree.Info[]) {
    if (items.length === 0) return "No git worktrees found."
    return items
      .map((item) => {
        const markers = [
          item.isMain ? "main" : undefined,
          item.managed ? "managed" : "external",
          item.stale ? "stale" : undefined,
        ]
          .filter(Boolean)
          .join(", ")
        const branch = item.branch ? ` @ ${item.branch}` : item.detached ? " @ detached" : ""
        return `- ${item.name}${branch} (${markers})\n  ${item.path}`
      })
      .join("\n")
  }

  export async function run(input: Input): Promise<Worktree.CommandResult> {
    switch (input.action) {
      case "list": {
        const items = await Worktree.list()
        return { title: "Git worktrees", output: formatList(items), metadata: { worktrees: items } }
      }
      case "new": {
        const created = await Worktree.create({
          name: input.target,
          sessionID: input.sessionID,
          baseRef: "current",
          bind: true,
        })
        return {
          title: `Created worktree ${created.name}`,
          output: `Bound this session to ${created.path}`,
          metadata: { worktree: created },
        }
      }
      case "enter": {
        const entered = await Worktree.enter({
          sessionID: input.sessionID,
          target: input.target,
          force: input.force ?? false,
        })
        return {
          title: `Entered worktree ${entered.name}`,
          output: `Bound this session to ${entered.path}`,
          metadata: { worktree: entered },
        }
      }
      case "status": {
        const current = await Worktree.status(input.sessionID)
        const workspace = current.workspace
        return {
          title: "Worktree status",
          output: workspace
            ? [
                `Workspace: ${workspace.type}`,
                `Path: ${workspace.path}`,
                current.dirty === undefined ? undefined : `Dirty: ${current.dirty ? "yes" : "no"}`,
              ]
                .filter(Boolean)
                .join("\n")
            : "This session is using the main workspace.",
          metadata: current,
        }
      }
      case "leave": {
        const updated = await Worktree.leave(input.sessionID)
        return {
          title: "Left worktree",
          output: `Bound this session back to ${updated.workspace?.path}`,
          metadata: { session: updated },
        }
      }
      case "remove": {
        const removed = await Worktree.remove({
          sessionID: input.sessionID,
          target: input.target,
          force: input.force ?? false,
        })
        return {
          title: `Removed worktree ${removed.name}`,
          output: `Removed ${removed.path}`,
          metadata: { worktree: removed },
        }
      }
    }
  }
}
