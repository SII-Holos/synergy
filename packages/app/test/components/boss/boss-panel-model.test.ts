import { describe, expect, test } from "bun:test"
import {
  bossNodeLabel,
  bossTreePath,
  bossTreeToDagNodes,
  directIdleWorkers,
  flattenTree,
  renderTreeText,
  workerCount,
  type BossTreeNodeVM,
} from "../../../src/components/boss/boss-panel-model"

const leaf: BossTreeNodeVM = {
  sessionID: "ses_worker",
  title: "Boss · code",
  role: "worker",
  workerRole: "code",
  status: "idle",
  children: [],
}

const tree: BossTreeNodeVM = {
  sessionID: "ses_boss",
  title: "Boss",
  role: "boss",
  status: "idle",
  children: [
    leaf,
    {
      sessionID: "ses_review",
      title: "Boss · review",
      role: "worker",
      workerRole: "review",
      status: "running",
      currentTask: { taskID: "task-1", taskTitle: "Review the PR" },
      children: [],
    },
  ],
}

const nestedTree: BossTreeNodeVM = {
  ...tree,
  children: [
    tree.children[0],
    {
      ...tree.children[1],
      children: [
        {
          sessionID: "ses_citations",
          title: "Boss · citations",
          role: "worker",
          workerRole: "citations",
          status: "queued",
          children: [],
        },
      ],
    },
  ],
}

describe("boss-panel-model", () => {
  test("flattenTree walks depth-first with depth labels", () => {
    const flat = flattenTree(tree)
    expect(flat.map((item) => [item.node.sessionID, item.depth])).toEqual([
      ["ses_boss", 0],
      ["ses_worker", 1],
      ["ses_review", 1],
    ])
  })

  test("workerCount counts every worker node in the subtree", () => {
    expect(workerCount(tree)).toBe(2)
    expect(workerCount(leaf)).toBe(1)
  })

  test("directIdleWorkers returns only direct idle worker children", () => {
    const parentWithNested: BossTreeNodeVM = {
      sessionID: "ses_parent",
      title: "Boss · parent",
      role: "worker",
      workerRole: "parent",
      status: "idle",
      children: [
        {
          sessionID: "ses_grandchild",
          title: "Boss · lint",
          role: "worker",
          workerRole: "lint",
          status: "idle",
          children: [],
        },
      ],
    }
    expect(directIdleWorkers(tree).map((node) => node.sessionID)).toEqual(["ses_worker"])
    // The nested worker is a direct child of parentWithNested; its own idle
    // grandchild is one level deeper and must not appear in the direct list.
    expect(directIdleWorkers(parentWithNested).map((node) => node.sessionID)).toEqual(["ses_grandchild"])
  })

  test("bossTreeToDagNodes preserves hierarchy through dependency IDs", () => {
    const nodes = bossTreeToDagNodes(nestedTree)
    const byID = new Map(nodes.map((node) => [node.id, node]))

    expect(nodes).toHaveLength(4)
    expect(byID.get("ses_boss")?.deps).toEqual([])
    expect(byID.get("ses_worker")?.deps).toEqual(["ses_boss"])
    expect(byID.get("ses_review")?.deps).toEqual(["ses_boss"])
    expect(byID.get("ses_citations")?.deps).toEqual(["ses_review"])
  })

  test("bossTreeToDagNodes keeps queued and archived states visually neutral", () => {
    const queuedNodes = bossTreeToDagNodes(nestedTree)
    const archivedNodes = bossTreeToDagNodes({ ...nestedTree, status: "archived" })
    const queuedByID = new Map(queuedNodes.map((node) => [node.id, node]))
    const archivedByID = new Map(archivedNodes.map((node) => [node.id, node]))

    expect(queuedByID.get("ses_boss")?.status).toBe("pending")
    expect(queuedByID.get("ses_review")?.status).toBe("running")
    expect(queuedByID.get("ses_citations")?.status).toBe("pending")
    expect(queuedByID.get("ses_review")?.task_id).toBe("task-1")
    expect(archivedByID.get("ses_boss")?.status).toBe("pending")
  })

  test("bossNodeLabel prefers worker role and keeps the Boss title", () => {
    expect(bossNodeLabel(tree)).toBe("Boss")
    expect(bossNodeLabel(leaf)).toBe("code")
  })

  test("bossTreePath returns the selected node ancestry", () => {
    expect(bossTreePath(nestedTree, "ses_citations")?.map((node) => node.sessionID)).toEqual([
      "ses_boss",
      "ses_review",
      "ses_citations",
    ])
    expect(bossTreePath(nestedTree, "missing")).toBeUndefined()
  })

  test("renderTreeText includes roles, status, and current task", () => {
    const text = renderTreeText(tree)
    expect(text).toContain("[idle] Boss (boss, ses_boss)")
    expect(text).toContain("  - [idle] Boss · code (worker(code), ses_worker)")
    expect(text).toContain("task-1: Review the PR")
  })
})
