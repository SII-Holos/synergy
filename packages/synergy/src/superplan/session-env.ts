import { SessionEnvContributor } from "../session/env-contributor"

/**
 * S9c (Blueprint): the superplan product domain contributes its advisory
 * environment hint lines through the SessionEnvContributor registry so the
 * L1 environment prompt stays free of product imports. Loaded through
 * src/product-registration.ts.
 */
export function registerSuperPlanSessionEnv() {
  SessionEnvContributor.register({
    id: "superplan",
    async envHints(session) {
      if (!session?.superplan) return []
      const lines = [`  SuperPlan run: ${session.superplan.runID}`, `  SuperPlan role: ${session.superplan.role}`]
      if (session.superplan.nodeID) lines.push(`  SuperPlan node: ${session.superplan.nodeID}`)
      if (session.superplan.mergeID) lines.push(`  SuperPlan merge: ${session.superplan.mergeID}`)
      return lines
    },
  })
}
