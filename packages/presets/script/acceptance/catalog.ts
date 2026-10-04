import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { AcceptanceCase, digest } from "./evidence"

type CaseInput = Omit<AcceptanceCase, "checks" | "verification"> & {
  facts: Record<string, boolean | number | string>
  bytes?: Record<string, string>
}
function scenario(input: CaseInput): AcceptanceCase {
  const { facts, bytes = {}, ...spec } = input
  return AcceptanceCase.parse({
    ...spec,
    verification:
      "Compare product state, independently observed files/processes/database state, and recorded transport; validate every declared oracle and fault barrier.",
    checks: [
      ...Object.entries(facts).map(([key, equals]) => ({ evidence: "observations.json", pointer: [key], equals })),
      ...Object.entries(bytes).map(([evidence, text]) => ({ evidence, sha256: digest(text) })),
    ],
  })
}

export const cases: AcceptanceCase[] = [
  ...(["home", "project", "workspace"] as const).map((scope) =>
    scenario({
      id: `attachments-${scope}`,
      units: ["A", "B", "C", "D"],
      agent: PrimaryAgentIdentity.names.lightweight,
      live: true,
      risk: "Managed attachments inherit native Workspace restrictions; a failed input poisons the next task.",
      preconditions: [
        `Fresh ${scope} session`,
        "Managed upload and inline attachment with random content",
        "Missing attachment",
      ],
      actions: [
        "Submit missing attachment before valid task",
        "Exercise task, steer and context lanes",
        "Try an explicit local file reference",
      ],
      fault: "Attachment resolution fails before model input materialization",
      expected: [
        "Failed input keeps every original part",
        "No partial input reaches provider",
        "Healthy successor completes",
        "Local references obey Workspace selection",
      ],
      barriers: [
        "failed-input-parked",
        "successor-completed",
        "steer-checked",
        "context-checked",
        "local-reference-checked",
      ],
      factors: [scope, "managed-attachment", "failed-input-successor", "task", "steer", "context"],
      facts: {
        markerRecovered: true,
        partialInputSent: false,
        failedInputRetained: true,
        queueProgressed: true,
        localReferencePolicy: true,
        allocatedCompute: 0,
        managedBytesPreserved: true,
      },
    }),
  ),
  scenario({
    id: "attachment-policy",
    units: ["A", "B", "C"],
    agent: PrimaryAgentIdentity.names.general,
    live: true,
    risk: "Capability routing loses attachment policies, filenames or original bytes.",
    preconditions: ["Synthetic PNG/JPEG, text, PDF, DOCX, XLSX and PPTX", "Excluded text", "Audio/video byte fixtures"],
    actions: ["Read random content through a real model", "Inspect projected inputs and stored original bytes"],
    fault: "Mixed attachment policies and media capabilities",
    expected: [
      "Content markers recovered without prompt leakage",
      "Excluded content absent",
      "Audio/video retained as binary without claiming decoding",
    ],
    barriers: ["documents-extracted", "images-read", "excluded-checked", "binary-checked"],
    factors: ["mixed-attachments", "capabilities", "policy"],
    facts: { markersRecovered: true, excludedLeaked: false, namesPreserved: true, binaryPreserved: true },
  }),
  scenario({
    id: "vision-child",
    units: ["A", "B", "C"],
    agent: PrimaryAgentIdentity.names.coding,
    live: true,
    risk: "A text-only parent cannot deliver managed visual bytes to its vision child without a Workspace.",
    preconditions: [
      "Frozen DeepSeek vision model",
      "Text-only parent capability profile",
      "Fresh Workspace-free session",
    ],
    actions: ["Delegate image reading through look_at", "Read actual child trajectory and parent result"],
    fault: "Visual delegation from a text-only parent",
    expected: ["Child receives original image", "Parent waits for actual child result", "Both requests recorded"],
    barriers: ["child-invoked", "child-completed", "parent-completed"],
    factors: ["no-workspace", "vision", "delegation", "deepseek"],
    facts: { imageMarkerRecovered: true, childRecorded: true, parentWaited: true },
  }),
  scenario({
    id: "api-lazy",
    units: ["A", "B", "C", "D"],
    agent: PrimaryAgentIdentity.names.lightweight,
    live: true,
    risk: "Business API work accidentally allocates compute or depends on unavailable files.",
    preconditions: [
      "No Environment, selected idle Environment and unavailable Workspace variants",
      "Local business API, MCP and plugin fixtures",
    ],
    actions: ["Call business APIs", "Request first Bash", "Reclaim compute and call API again"],
    fault: "Unavailable Workspace and reclaimed allocation",
    expected: [
      "API calls require zero allocations",
      "First system operation allocates once",
      "Subsequent API work succeeds without compute",
    ],
    barriers: ["api-completed", "first-bash-completed", "reclaimed", "api-after-reclaim"],
    factors: ["api", "lazy-compute", "unavailable-workspace"],
    facts: { apiOnlyAllocations: 0, firstBashAllocations: 1, apiAfterReclaim: true, allThreeEntries: true },
  }),
  scenario({
    id: "shared-delegation",
    units: ["B", "C", "D", "E"],
    agent: PrimaryAgentIdentity.names.coding,
    live: true,
    risk: "Shared Workspace writers, child tasks and resource switches bypass generation fencing or deadlock.",
    preconditions: ["Two sessions sharing one Workspace", "Two independent Git worktrees", "External editor writer"],
    actions: [
      "Delegate parent and sibling work",
      "Cancel and rebind a concurrent child at an observed command barrier",
      "Make a competing external edit",
    ],
    fault: "Cancellation before a child writes its result, followed by a binding switch",
    expected: [
      "No cross-write or lost external edit",
      "Stale binding rejected",
      "Parent completion follows child completion",
    ],
    barriers: ["children-running", "commands-concurrent", "binding-switched", "cancelled", "children-settled"],
    factors: ["shared-workspace", "parent-child", "cancel-or-switch", "worktree"],
    facts: { externalEditPreserved: true, crossWrites: 0, staleRejected: true, parentWaited: true, remainingClaims: 0 },
  }),
  scenario({
    id: "execution-drain",
    units: ["D", "E"],
    agent: PrimaryAgentIdentity.names.general,
    live: true,
    risk: "Quiet or background work is reclaimed early, or output/save is truncated at disconnect.",
    preconditions: ["Bash, PTY and background commands", "Explicit quiet-work barrier", "Short isolated idle timeout"],
    actions: [
      "Disconnect client while work is active",
      "Attempt idle reclaim",
      "Drain output and save",
      "Allocate replacement and read files",
    ],
    fault: "Client disconnect and idle sweep during live work",
    expected: ["Active uses prevent reclaim", "Output hash matches full stream", "Checkpoint precedes release"],
    barriers: [
      "quiet-running",
      "client-disconnected",
      "reclaim-refused",
      "output-drained",
      "replacement-read",
      "runtime-closed",
    ],
    factors: ["pty", "background", "disconnect", "idle-reclaim"],
    facts: { activeReclaimed: false, outputComplete: true, savedBeforeRelease: true, replacementConsistent: true },
  }),
  scenario({
    id: "file-services",
    units: ["C", "D", "E"],
    live: false,
    risk: "Tools, watcher, LSP, formatter and plugins observe or write different file generations.",
    preconditions: ["Native and remote active Workspace views", "Real formatter and language-service processes"],
    actions: [
      "Alternate Read/Edit/Bash/diff/undo/tree/watch/LSP/formatter/plugin access",
      "Switch binding with callbacks pending",
    ],
    fault: "Old-generation callback arrives after resource switch",
    expected: ["All consumers agree on bytes", "Late writes rejected", "Recovery preserves newer edits"],
    barriers: ["consumers-exercised", "callback-held", "binding-switched", "callback-released"],
    factors: ["file-tools", "native-services", "binding-generation"],
    facts: { sameView: true, oldWrites: 0, newEditsPreserved: true },
  }),
  scenario({
    id: "permission-targets",
    units: ["C", "D"],
    live: false,
    risk: "Approval targets one filesystem while execution reaches another or silently falls back locally.",
    preconditions: [
      "guarded, autonomous and full_access",
      "Symlink, protected path and external read-only mount fixtures",
    ],
    actions: [
      "Deny guarded operation",
      "Exercise paths in each profile",
      "Disconnect remote host",
      "Select remote Browser and Computer",
    ],
    fault: "Denied capability or unavailable/unsupported remote target",
    expected: [
      "Denial has no side effects",
      "No controller execution fallback",
      "Unsupported capability explicitly rejected",
    ],
    barriers: ["denied", "symlink-checked", "mount-checked", "remote-offline", "native-only-rejected"],
    factors: ["permissions", "remote-target", "symlink", "external-mount"],
    facts: { deniedEffects: 0, controllerEffects: 0, targetConsistent: true, nativeOnlyRejected: true },
  }),
  ...(["sqlite", "postgres"] as const).map((backend) =>
    scenario({
      id: `storage-${backend}`,
      units: ["A", "C", "E", "F"],
      live: false,
      risk: "Commit uncertainty produces duplicate effects, half history or lost/shared file references.",
      preconditions: [
        backend === "sqlite" ? "Fresh isolated SQLite store" : "Isolated PostgreSQL 18 namespace",
        "Two references to one saved file",
      ],
      actions: [
        "Interrupt durable write or connection",
        "Retry same submitted identity",
        "Restart, export/import and delete one reference",
      ],
      fault: "Commit response lost and user repeats submission",
      expected: ["One canonical input and effect", "No half commit", "Shared file survives one reference deletion"],
      barriers: ["commit-interrupted", "same-input-retried", "restarted", "archive-restored", "reference-deleted"],
      factors: [backend, "commit", "lost-response", "retry", "shared-reference"],
      facts: { canonicalInputs: 1, effects: 1, partialCommits: 0, sharedFilePreserved: true, continued: true },
    }),
  ),
  scenario({
    id: "desktop-input",
    units: ["A", "B", "C", "D"],
    agent: PrimaryAgentIdentity.names.lightweight,
    live: true,
    risk: "The actual composer loses attachments/drafts or projects incorrect pause, continue and cancel state.",
    preconditions: ["Production Web build", "Isolated Desktop user-data directory", "Independent Runtime"],
    actions: [
      "Upload through actual composer",
      "Pause/continue/cancel and submit new input",
      "Switch resources and inspect persisted state",
    ],
    fault: "Pause/cancel during active input, followed by resource selection",
    expected: [
      "Attachment and draft preserved",
      "UI matches stored state",
      "Plain pause glyph and correct control actions",
    ],
    barriers: ["ui-uploaded", "paused", "continued", "cancelled", "new-input-completed", "resources-switched"],
    factors: ["desktop", "upload", "controls", "resource-selection"],
    facts: { attachmentRead: true, draftPreserved: true, controlsCorrect: true, persistedStateMatches: true },
  }),
  scenario({
    id: "desktop-remote",
    units: ["C", "D", "E"],
    agent: PrimaryAgentIdentity.names.general,
    live: true,
    risk: "Product resource selection diverges from execution, allocates eagerly or loses files when releasing compute.",
    preconditions: ["Production Desktop", "Object Workspace with random file content", "Independent TLS Docker daemon"],
    actions: [
      "Select Workspace and create a remote Environment through product dialogs",
      "Run the first Bash through the composer",
      "Refresh and inspect selections",
      "Save and release compute through the product",
    ],
    fault: "Product reload and compute release after a remote file operation",
    expected: [
      "Selection alone allocates nothing",
      "One remote side effect",
      "Selection and saved bytes survive release",
    ],
    barriers: ["selected-idle", "remote-task-completed", "reloaded", "reclaimed"],
    factors: ["desktop", "remote-target", "object-workspace", "resource-selection", "release"],
    facts: {
      idleAllocations: 0,
      taskAllocations: 1,
      markerRecovered: true,
      selectionPreserved: true,
      effects: 1,
      savedBytesPreserved: true,
      remainingAllocations: 0,
    },
  }),
  scenario({
    id: "web-reconnect",
    units: ["A", "B", "C"],
    agent: PrimaryAgentIdentity.names.general,
    live: true,
    risk: "Reconnect replaces older history or loses pending input and attachments.",
    preconditions: ["Production Web browser", "Multiple history pages", "Unfinished input and draft attachment"],
    actions: ["Disconnect transport", "Refresh and reconnect", "Page old history and complete pending task"],
    fault: "UI reconnect with multi-turn history and unfinished input",
    expected: ["Old replies remain", "Pending input and draft survive", "Error remains attached to correct input"],
    barriers: ["history-paged", "input-pending", "disconnected", "refreshed", "reconnected", "input-completed"],
    factors: ["web-reconnect", "multi-turn-history", "unfinished-input"],
    facts: { oldRepliesPreserved: true, pendingInputPreserved: true, draftPreserved: true, errorAttribution: true },
  }),
  scenario({
    id: "resource-cycles",
    units: ["A", "B", "C", "D", "E", "F"],
    agent: PrimaryAgentIdentity.names.coding,
    live: true,
    risk: "Compaction and repeated resource recovery lose facts or accumulate orphan resources across Runtime owners.",
    preconditions: ["Real model/tool history", "Attachments and delegated task", "Second Runtime continuously working"],
    actions: [
      "Trigger two real compactions",
      "Reclaim and rebuild compute three times",
      "Recover controller three times",
      "Measure resources throughout",
    ],
    fault: "Repeated controller death and compute turnover",
    expected: ["Critical facts retained", "Correct ownership on close", "No unexplained sustained resource growth"],
    barriers: [
      "compacted-twice",
      "compute-cycled-thrice",
      "controller-recovered-thrice",
      "other-runtime-continued",
      "cleanup-checked",
    ],
    factors: ["compaction", "resource-turnover", "runtime-ownership", "long-history"],
    facts: {
      compactions: 2,
      computeCycles: 3,
      controllerRecoveries: 3,
      criticalFactsRetained: true,
      otherRuntimeHealthy: true,
      orphanResources: 0,
    },
  }),
  ...(
    [
      [
        "allocation-ack",
        "Container creation completed before allocation response is lost",
        ["container-created", "reply-lost", "allocation-reconciled"],
        { allocations: 1, identityPreserved: true },
      ],
      [
        "command-crash",
        "Command side effect occurs before the entire controller is killed",
        ["effect-written", "controller-killed", "controller-restarted", "continued"],
        { effects: 1, reexecutions: 0, continued: true },
      ],
      [
        "save-crash",
        "Process exited, checkpoint upload fails, then controller is killed",
        ["process-exited", "save-blocked", "controller-killed", "save-retried", "continued"],
        { effects: 1, retainedUniqueBytes: true, saveOnlyRetry: true, continued: true },
      ],
      [
        "publication-ack",
        "Bytes uploaded before metadata commit or its response is interrupted",
        ["bytes-uploaded", "metadata-interrupted", "read-checked", "reconciled"],
        { halfPublishedReads: 0, referencesConsistent: true },
      ],
      [
        "release-ack",
        "Checkpoint committed before release acknowledgement is lost",
        ["save-committed", "release-reply-lost", "release-reconciled"],
        { effects: 1, reexecutions: 0, remainingUses: 0 },
      ],
      [
        "remote-loss",
        "Network loss, Execution Host exit and allocation removal are distinct failures",
        ["network-lost", "missing-query-cancelled", "host-exited", "container-removed", "continued"],
        { localFallbacks: 0, staleReads: 0, uncertaintiesDistinguished: true, continued: true },
      ],
      [
        "cancel-phases",
        "Cancel while waiting, acquired, executing and draining output",
        ["cancel-waiting", "cancel-acquired", "cancel-running", "cancel-draining"],
        { unexpectedEffects: 0, orphanProcesses: 0, remainingClaims: 0 },
      ],
      [
        "model-stream",
        "Model transport fails before bytes, during tool arguments and after tool completion",
        ["before-bytes", "during-tool-arguments", "after-tool-result", "continued"],
        { inputPreserved: true, partialEvidencePreserved: true, effects: 1, continued: true },
      ],
      [
        "model-timeout",
        "Withheld provider bytes trigger actual TTFB and idle watchdogs before bytes, within tool arguments and after a tool",
        ["before-timeout-completed", "before-bytes", "during-tool-arguments", "after-tool-result", "continued"],
        { inputPreserved: true, partialEvidencePreserved: true, effects: 1, continued: true, timeoutWatchdogs: 3 },
      ],
    ] as const
  ).map(([id, fault, barriers, facts]) =>
    scenario({
      id: `fault-${id}`,
      units: ["model-stream", "model-timeout"].includes(id)
        ? ["A", "C", "D"]
        : id === "publication-ack"
          ? ["A", "C", "E"]
          : ["A", "C", "D", "E"],
      live: ["command-crash", "save-crash", "remote-loss", "model-stream", "model-timeout"].includes(id),
      agent: PrimaryAgentIdentity.names.general,
      risk: fault,
      preconditions: [
        "Fresh owned Runtime and exact operation identity",
        "Observable stage barrier",
        "Independent file/counter/process verifier",
      ],
      actions: [
        "Wait for the declared physical stage",
        "Inject exactly one declared fault",
        "Reconcile without blind resubmission",
        "Verify state and normal continuation",
      ],
      fault,
      expected: [
        "No lost bytes or duplicate side effects",
        "Unknown outcomes remain explicit and recoverable",
        "No stale/local fallback",
        ...(id === "remote-loss"
          ? [
              "Explicit import of independently verified retained bytes continues the same Session while original unavailable views remain recorded",
            ]
          : []),
      ],
      barriers: [...barriers],
      factors: [
        ["model-stream", "model-timeout"].includes(id)
          ? "model-transport"
          : id === "publication-ack"
            ? "object-publication"
            : "remote-execution",
        id,
        "recovery",
      ],
      facts,
      ...(["command-crash", "save-crash", "model-stream", "model-timeout"].includes(id)
        ? { bytes: { "effects.txt": "once\n" } }
        : {}),
    }),
  ),
  scenario({
    id: "current-dev-upgrade",
    units: ["A", "B", "C", "D", "E", "F"],
    agent: PrimaryAgentIdentity.names.lightweight,
    live: true,
    risk: "The integrated version cannot continue data created by the current dev installation.",
    preconditions: [
      "Synthetic fresh Home created with frozen current-dev artifact",
      "Saved task, attachment and Workspace file",
    ],
    actions: ["Close old fixture", "Open with final installation", "Continue same task and verify prior data"],
    fault: "Upgrade between completed and subsequent user work",
    expected: ["Existing data retained", "New user task succeeds", "Personal historical Homes are never read"],
    barriers: ["old-fixture-saved", "upgraded", "continued"],
    factors: ["current-dev", "upgrade", "continuation"],
    facts: { oldMessagesPreserved: true, attachmentPreserved: true, filesPreserved: true, continued: true },
  }),
  scenario({
    id: "installed-entrypoints",
    units: ["A", "B", "C", "D"],
    agent: PrimaryAgentIdentity.names.lightweight,
    live: true,
    risk: "Source composition works while installed CLI, SDK or embedded entrypoints miss resources.",
    preconditions: ["Frozen core/full distributions and inventory", "Independent directory outside checkout"],
    actions: [
      "Run task through CLI, generated SDK and in-process public embedding",
      "Verify files and process shutdown",
    ],
    fault: "Independent clean installations",
    expected: ["All three entrypoints execute real tasks", "Installed assets complete", "No checkout dependency"],
    barriers: ["cli-completed", "sdk-completed", "embedding-completed", "outside-checkout-verified"],
    factors: ["installed", "cli", "sdk", "embedding"],
    facts: { entrypoints: 3, assetInventoryValid: true, checkoutDependency: false },
  }),
  scenario({
    id: "object-protocols",
    units: ["C", "E"],
    live: false,
    risk: "Object adapter errors publish partial content or mishandle authentication and integrity.",
    preconditions: ["Local blob repository", "Deterministic S3 and OSS protocol endpoints"],
    actions: ["Interrupt upload and retrieval", "Corrupt a returned object", "Check manifest and references"],
    fault: "Protocol, hash and upload failures",
    expected: ["No half publication", "Integrity violations rejected", "Provider failures stay attributable"],
    barriers: ["s3-checked", "oss-checked", "hash-corrupted", "upload-failed"],
    factors: ["objects", "s3", "oss", "protocol-fault"],
    facts: { halfPublished: 0, corruptReads: 0, providerErrorsPreserved: true },
  }),
]

export function selectCases(selection: string): AcceptanceCase[] {
  if (selection === "all") return cases
  const ids = selection.split(",")
  if (!selection || new Set(ids).size !== ids.length) throw new Error("Select explicit, unique case IDs or all")
  return ids.map((id) => {
    const match = cases.find((entry) => entry.id === id)
    if (!match) throw new Error(`Unknown acceptance case: ${id}`)
    return match
  })
}
