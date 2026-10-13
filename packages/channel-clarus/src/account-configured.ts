import { Config } from "@ericsanchezok/synergy-harness/config/config"
export async function ensureClarusChannelAccount(agentId: string): Promise<boolean> {
  const stored = await Config.domainGet("channels")
  const existing = stored.channel?.clarus
  if (existing?.type === "clarus" && existing.accounts[agentId]) return false
  await Config.domainUpdate("channels", {
    channel: {
      clarus: {
        type: "clarus",
        accounts: {
          ...(existing?.type === "clarus" ? existing.accounts : {}),
          [agentId]: { enabled: false },
        },
      },
    },
  })
  return true
}
