import CONTENT from "./content.txt"

export const qizhiSynergyLink = {
  name: "qizhi-synergy-link",
  description:
    "Deploy, verify, diagnose, and recover Synergy Link v2 hosts on the Qizhi platform: shared-filesystem containers and multi-instance hosts, per-instance namespace isolation, identity and singleton checks, sender target setup and testing, safe remote yield, incident recovery, and credential rotation or relink.",
  content: CONTENT,
  builtin: true as const,
}
