import z from "zod"

export namespace SessionInteraction {
  export const Mode = z.enum(["interactive", "unattended"]).meta({
    ref: "SessionInteractionMode",
  })
  export type Mode = z.infer<typeof Mode>

  export const Info = z
    .object({
      mode: Mode,
      source: z.string().optional().describe("Why this interaction mode applies, e.g. 'agenda' or 'channel:feishu'"),
    })
    .meta({
      ref: "SessionInteraction",
    })
  export type Info = z.infer<typeof Info>

  export function interactive(source?: string): Info {
    return {
      mode: "interactive",
      source,
    }
  }

  export function unattended(source?: string): Info {
    return {
      mode: "unattended",
      source,
    }
  }

  export function isUnattended(input?: Pick<Info, "mode"> | null): boolean {
    return input?.mode === "unattended"
  }
}
