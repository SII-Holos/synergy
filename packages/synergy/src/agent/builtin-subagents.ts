import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"
import { createApiCompatibilityReviewerAgent } from "./prompt/api-compatibility-reviewer/builder"
import { createApiContractDesignerAgent } from "./prompt/api-contract-designer/builder"
import { createCodeCartographerAgent } from "./prompt/code-cartographer/builder"
import { createDependencyTracerAgent } from "./prompt/dependency-tracer/builder"
import { createDocsResearcherAgent } from "./prompt/docs-researcher/builder"
import { createDocumentationEngineerAgent } from "./prompt/documentation-engineer/builder"
import { createDocumentationReviewerAgent } from "./prompt/documentation-reviewer/builder"
import { createFixtureBuilderAgent } from "./prompt/fixture-builder/builder"
import { createImplementationEngineerAgent } from "./prompt/implementation-engineer/builder"
import { createIntentAnalystAgent } from "./prompt/intent-analyst/builder"
import { createIntegrationEngineerAgent } from "./prompt/integration-engineer/builder"
import { createMaintainabilityReviewerAgent } from "./prompt/maintainability-reviewer/builder"
import { createMigrationArchitectAgent } from "./prompt/migration-architect/builder"
import { createPerformanceReviewerAgent } from "./prompt/performance-reviewer/builder"
import { createPropertyTestEngineerAgent } from "./prompt/property-test-engineer/builder"
import { createPythonQualityEngineerAgent } from "./prompt/python-quality-engineer/builder"
import { createQualityGatekeeperAgent } from "./prompt/quality-gatekeeper/builder"
import { createRefactoringEngineerAgent } from "./prompt/refactoring-engineer/builder"
import { createRegressionReproducerAgent } from "./prompt/regression-reproducer/builder"
import { createRequirementsEngineerAgent } from "./prompt/requirements-engineer/builder"
import { createResearchMethodologistAgent } from "./prompt/research-methodologist/builder"
import { createRustQualityEngineerAgent } from "./prompt/rust-quality-engineer/builder"
import { createSecurityReviewerAgent } from "./prompt/security-reviewer/builder"
import { createSolutionArchitectAgent } from "./prompt/solution-architect/builder"
import { createTestStrategistAgent } from "./prompt/test-strategist/builder"
import { createTypeTestEngineerAgent } from "./prompt/type-test-engineer/builder"
import { createTypescriptQualityEngineerAgent } from "./prompt/typescript-quality-engineer/builder"
import { createWorkflowDesignerAgent } from "./prompt/workflow-designer/builder"

const FACTORIES = [
  createIntentAnalystAgent,
  createRequirementsEngineerAgent,
  createCodeCartographerAgent,
  createDependencyTracerAgent,
  createSolutionArchitectAgent,
  createApiContractDesignerAgent,
  createMigrationArchitectAgent,
  createWorkflowDesignerAgent,
  createTestStrategistAgent,
  createRegressionReproducerAgent,
  createFixtureBuilderAgent,
  createPropertyTestEngineerAgent,
  createTypeTestEngineerAgent,
  createImplementationEngineerAgent,
  createRefactoringEngineerAgent,
  createIntegrationEngineerAgent,
  createDocumentationEngineerAgent,
  createQualityGatekeeperAgent,
  createPythonQualityEngineerAgent,
  createRustQualityEngineerAgent,
  createTypescriptQualityEngineerAgent,
  createMaintainabilityReviewerAgent,
  createSecurityReviewerAgent,
  createPerformanceReviewerAgent,
  createApiCompatibilityReviewerAgent,
  createDocumentationReviewerAgent,
  createDocsResearcherAgent,
  createResearchMethodologistAgent,
]

export function createBuiltinSubagents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  const result: Record<string, Agent.Info> = {}
  for (const factory of FACTORIES) {
    const agent = factory(ctx)
    result[agent.name] = agent
  }
  return result
}
