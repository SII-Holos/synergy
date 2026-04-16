import z from "zod"
import { Tool } from "./tool"
import { HolosProfile } from "../holos/profile"
import DESCRIPTION_GET from "./profile-get.txt"
import DESCRIPTION_UPDATE from "./profile-update.txt"

export const ProfileGetTool = Tool.define("profile_get", {
  description: DESCRIPTION_GET,
  parameters: z.object({}),
  async execute() {
    const profile = await HolosProfile.get()
    if (!profile) {
      return {
        title: "profile_get",
        output: "No profile exists yet.",
        metadata: {} as Record<string, any>,
      }
    }
    return {
      title: "profile_get",
      output: [`Name: ${profile.name}`, "", profile.bio].join("\n"),
      metadata: { name: profile.name, initialized: profile.initialized } as Record<string, any>,
    }
  },
})

const updateParams = z.object({
  name: z.string().describe("The agent's display name"),
  bio: z.string().describe("A short natural-language description of this agent (1-3 paragraphs)"),
})

export const ProfileUpdateTool = Tool.define("profile_update", {
  description: DESCRIPTION_UPDATE,
  parameters: updateParams,
  async execute(params: z.infer<typeof updateParams>) {
    const profile = await HolosProfile.update({
      name: params.name,
      bio: params.bio,
      initialized: true,
      initializedAt: Date.now(),
    })
    return {
      title: "profile_update",
      output: `Profile updated.\n\nName: ${profile.name}\n\n${profile.bio}`,
      metadata: { name: profile.name } as Record<string, any>,
    }
  },
})
