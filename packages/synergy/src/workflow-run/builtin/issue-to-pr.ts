import { CharterValidate } from "../charter-validate"
import { CharterStore } from "../charter-store"
import { WorkflowError } from "../error"
import { WorkflowTypes } from "../types"

/**
 * Built-in charter: Issue → PR → Test, driven by a Boss session. Parallel
 * executor pool per issue branch, a review loop that sends changes back to
 * the executor, a single tester seat that serialises integration
 * verification, and a terminal test_passed state signalling the entity is
 * ready for human merge. Merge itself happens outside the workflow.
 *
 * This is the Phase-1 acceptance charter and (until charter authoring lands)
 * the canonical example of how to compose the fixed predicate/effect libraries.
 */
export namespace IssueToPrCharter {
  export const CHARTER_ID = "cht_builtin_issue_to_pr"

  const EXECUTOR_CHARTER = [
    "You are an execution engineer. For each issue handed to you:",
    "1. Investigate the issue in your worktree, implement a fix, and commit it.",
    "2. Keep the change scoped to the issue; do not expand scope without a gate.",
    "3. When the change is complete and the worktree is clean (committed), record a 'deliverable'",
    "   submission via workflow_submit including the PR/branch reference in refs.",
    "If review sends the entity back to you, address every comment in the review submission, then re-submit.",
  ].join("\n")

  const REVIEWER_CHARTER = [
    "You are a PR reviewer. When an entity is handed to you, review the executor's change against the issue.",
    "Follow the standard review process: correctness, scope, tests, and conventions.",
    "Record a 'review_verdict' submission via workflow_submit with verdict 'passed' or 'changes_requested'.",
    "When requesting changes, put concrete, actionable comments in the submission summary.",
  ].join("\n")

  const TESTER_CHARTER = [
    "You are the integration tester. Entities reach you only after passing review.",
    "Rebase onto the latest integration base, run the full test/verification suite, and validate the change end to end.",
    "Record a 'test_report' submission via workflow_submit with verdict 'passed' or 'changes_requested' and the evidence in refs.",
  ].join("\n")

  function build(): CharterValidate.Draft {
    const states = [
      "queued",
      "executing",
      "pr_open",
      "reviewing",
      "changes_requested",
      "review_passed",
      "testing",
      "test_passed",
      WorkflowTypes.BLOCKED_STATE,
    ]

    const transitions: WorkflowTypes.TransitionDef[] = [
      {
        id: "assign_executor",
        from: "queued",
        to: "executing",
        trigger: { kind: "event" },
        // Only leave the queue when the budget allows AND an executor is free —
        // otherwise the entity waits in "queued" instead of moving to
        // "executing" and immediately blocking on a full pool.
        guards: [
          { name: "budget_available", args: {} },
          { name: "seat_available", args: { seat: "executor" } },
        ],
        effects: [
          { name: "assign_entity", args: { seat: "executor" } },
          {
            name: "send_handoff",
            args: {
              seat: "executor",
              task: "Implement a fix for this issue in your worktree and commit it.",
              expectedSubmission: "deliverable",
              acceptance: ["Change is committed", "Scope limited to the issue"],
            },
          },
        ],
      },
      {
        id: "executor_opens_pr",
        from: "executing",
        to: "pr_open",
        trigger: { kind: "intent", allowedSeats: ["executor"] },
        guards: [{ name: "worktree_clean", args: {} }],
        effects: [{ name: "set_binding", args: { key: "prReady", value: "true" } }],
      },
      {
        id: "open_pr_to_review",
        from: "pr_open",
        to: "reviewing",
        trigger: { kind: "event" },
        guards: [{ name: "seat_available", args: { seat: "reviewer" } }],
        effects: [
          {
            name: "send_handoff",
            args: {
              seat: "reviewer",
              task: "Review the executor's change for this issue and record a verdict.",
              expectedSubmission: "review_verdict",
              includeLastSubmission: true,
              acceptance: ["Verdict recorded via workflow_submit"],
            },
          },
        ],
      },
      {
        id: "review_request_changes",
        from: "reviewing",
        to: "changes_requested",
        trigger: { kind: "intent", allowedSeats: ["reviewer"] },
        guards: [],
        effects: [],
      },
      {
        id: "review_pass",
        from: "reviewing",
        to: "review_passed",
        trigger: { kind: "intent", allowedSeats: ["reviewer"] },
        guards: [{ name: "submission_recorded", args: { kind: "review_verdict", verdict: "passed", fresh: "true" } }],
        effects: [],
      },
      {
        id: "rework_back_to_executor",
        from: "changes_requested",
        to: "executing",
        trigger: { kind: "event" },
        guards: [{ name: "seat_available", args: { seat: "executor" } }],
        effects: [
          {
            name: "send_handoff",
            args: {
              seat: "executor",
              task: "Address the review comments and re-submit.",
              expectedSubmission: "deliverable",
              includeLastSubmission: true,
            },
          },
        ],
      },
      {
        id: "review_passed_to_testing",
        from: "review_passed",
        to: "testing",
        trigger: { kind: "event" },
        guards: [{ name: "seat_available", args: { seat: "tester" } }],
        effects: [
          {
            name: "send_handoff",
            args: {
              seat: "tester",
              task: "Rebase and run integration verification for this change.",
              expectedSubmission: "test_report",
              includeLastSubmission: true,
            },
          },
        ],
      },
      {
        id: "test_pass",
        from: "testing",
        to: "test_passed",
        trigger: { kind: "intent", allowedSeats: ["tester"] },
        guards: [{ name: "submission_recorded", args: { kind: "test_report", verdict: "passed", fresh: "true" } }],
        // The entity has passed review and testing — it is ready for human
        // merge.  Release the tester so testing continues for other entities
        // and notify the boss.  There is no gate: merge is a human decision
        // that happens outside the workflow.
        effects: [
          { name: "release_seat", args: {} },
          { name: "notify_boss", args: { message: "An entity passed testing and is ready to merge." } },
        ],
      },
      {
        id: "test_fail_to_rework",
        from: "testing",
        to: "changes_requested",
        trigger: { kind: "intent", allowedSeats: ["tester"] },
        guards: [
          { name: "submission_recorded", args: { kind: "test_report", verdict: "changes_requested", fresh: "true" } },
        ],
        effects: [],
      },
      {
        id: "unblock",
        from: WorkflowTypes.BLOCKED_STATE,
        to: "queued",
        trigger: { kind: "intent", allowedSeats: [] },
        // Only the Boss may unblock via workflow_entity_unblock (which calls
        // submitIntent with fromBoss: true, bypassing the seat check).
        // Returning to "queued" lets the full event chain re-run with the
        // current state of seats, budget, and other resources.
        guards: [],
        effects: [],
      },
    ]
    return {
      name: "Issue → PR → Test",
      entityType: "issue",
      entityInitialState: "queued",
      states,
      terminalStates: ["test_passed"],
      transitions,
      seats: [
        {
          name: "executor",
          agent: "synergy-max",
          charterPrompt: EXECUTOR_CHARTER,
          controlProfile: "autonomous",
          interaction: "unattended",
          pool: 3,
          worktree: "per_entity",
        },
        {
          name: "reviewer",
          agent: "synergy",
          charterPrompt: REVIEWER_CHARTER,
          controlProfile: "autonomous",
          interaction: "unattended",
          pool: 1,
          worktree: "none",
        },
        {
          name: "tester",
          agent: "synergy",
          charterPrompt: TESTER_CHARTER,
          controlProfile: "autonomous",
          interaction: "unattended",
          pool: 1,
          worktree: "shared",
        },
      ],
      gates: [],
      budget: { maxModelCalls: 0 },
    }
  }

  /** Idempotently seed the built-in charter (v1) into the current scope. */
  export async function ensureSeeded(scopeID: string): Promise<WorkflowTypes.Charter> {
    const existing = await CharterStore.getOrUndefined(scopeID, CHARTER_ID)
    if (existing) return existing

    const draft = build()
    const validation = CharterValidate.validate(draft)
    if (!validation.valid) throw new WorkflowError.CharterInvalid({ errors: validation.errors })

    return CharterStore.put(scopeID, {
      id: CHARTER_ID,
      version: 1,
      name: draft.name,
      entityType: draft.entityType,
      entityInitialState: draft.entityInitialState,
      states: draft.states,
      terminalStates: draft.terminalStates ?? [],
      seats: draft.seats,
      transitions: draft.transitions,
      gates: draft.gates ?? [],
      budget: draft.budget ?? { maxModelCalls: 0 },
      time: { created: Date.now() },
    })
  }

  export function draft(): CharterValidate.Draft {
    return build()
  }
}
