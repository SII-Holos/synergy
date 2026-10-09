import z from "zod"
import { StoredToolOutput } from "./stored-output"
import { Tool } from "./tool"

export const ReadToolOutputTool = Tool.define(
  "read_tool_output",
  {
    description:
      "Read a persisted full tool output using its tool-output:// reference or an exact imported historical reference. Offset and limit are bytes; continue at the returned nextOffset. This reads only the current runtime's stored outputs, never arbitrary files, and requires no Workspace or execution environment.",
    parameters: z.object({
      reference: z.string().min(1).max(4096),
      offset: z.number().int().nonnegative().safe().optional(),
      limit: z
        .number()
        .int()
        .min(4)
        .max(8 * 1024)
        .default(8 * 1024),
    }),
    async execute(input, ctx) {
      ctx.abort.throwIfAborted()
      const result = await StoredToolOutput.read(input)
      ctx.abort.throwIfAborted()
      return {
        title: "Saved tool output",
        output: JSON.stringify(result),
        metadata: {
          truncated: result.truncated,
          reference: result.reference,
          nextOffset: result.nextOffset,
          totalBytes: result.totalBytes,
        },
      }
    },
  },
  { requiresWorkspace: false },
)
