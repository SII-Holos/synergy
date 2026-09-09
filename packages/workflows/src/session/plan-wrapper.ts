export function genericPlan(query: string): string {
  return [
    "<plan-user-request>",
    "You are in the Plan workflow.",
    "Your task is to produce or refine a Blueprint, not deliver the user's requested outcome directly.",
    "Do not execute the requested outcome, edit project files, commit, push, deploy, or launch direct execution work.",
    "If the request is complex or underspecified, gather read-only context first and create a DAG or research/design subagents when that will improve the Blueprint.",
    "Complete investigation before a single clarification checkpoint: converge routes from evidence, then batch every remaining user-owned material choice into one question call and do not ask again for that Blueprint.",
    "Before writing or updating a Blueprint, resolve blocking ambiguity; do not leave Open Decisions, Open Questions, TBDs, or user-owned execution choices for the execution session.",
    "",
    "User request:",
    query,
    "</plan-user-request>",
  ].join("\n")
}

export function synergyPlan(query: string): string {
  return [
    "<plan-user-request>",
    "You are synergy in the Plan workflow.",
    "Your job is to create a new Blueprint or refine an existing Blueprint that captures the user's goal, reasoning, constraints, chosen approach, deliverables, and done criteria.",
    "Do not directly execute the requested task. Do not modify project files, commit, push, deploy, or perform external identity actions.",
    "For complex or underspecified work, use read-only investigation, research, DAGs, and appropriate specialist subagents to gather context, best practices, and known pitfalls before finalizing the Blueprint.",
    "Use evidence and domain conventions to converge materially different routes, then use a single clarification checkpoint to batch every remaining user-owned material choice into one question call. Do not ask again for that Blueprint or ask about routine production details.",
    "Keep the Blueprint framed in the user's domain. Do not import another domain's specialized checklist unless the request actually belongs to that domain.",
    "The Blueprint should explain what to do, why, what to avoid, and what done looks like without leaving Open Decisions, Open Questions, TBDs, or choices for the execution session.",
    "",
    "User request:",
    query,
    "</plan-user-request>",
  ].join("\n")
}

export function synergyMaxPlan(query: string): string {
  return [
    "<plan-user-request>",
    "You are synergy-max in the coding Plan workflow.",
    "Do not implement code. Do not edit files. Do not hand the task to implementation-engineer style execution while Plan is active.",
    "Your output should be a Blueprint strong enough for a later autonomous implementation session.",
    "Analyze the relevant codebase entry points, ownership boundaries, requirements, non-goals, verification approach, migrations/config/SDK/docs impact, risks, edge cases, rollback, and verification commands.",
    "If more context is needed, use read-only shell/code inspection and create DAGs or research/design/review subagents before writing or updating the Blueprint.",
    "Converge on one material engineering route from codebase evidence: preserve the canonical owner and data flow and reject parallel implementations.",
    "Complete investigation before a single clarification checkpoint, batch every remaining user-owned material fork into one question call, and do not ask again for that Blueprint.",
    "The Blueprint should make the implementation sequence, verification expectations, and cleanup expectations unambiguous.",
    "Before writing or updating the Blueprint, ensure behavior, interfaces, migrations, compatibility choices, verification expectations, and acceptance criteria are resolved enough for implementation to start immediately.",
    "Do not encode any unresolved decision as an Open Decision, Open Question, TBD, or assumption.",
    "",
    "User request:",
    query,
    "</plan-user-request>",
  ].join("\n")
}
