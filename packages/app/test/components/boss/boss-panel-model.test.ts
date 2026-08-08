import { describe, expect, test } from "bun:test"
import {
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

  test("renderTreeText includes roles, status, and current task", () => {
    const text = renderTreeText(tree)
    expect(text).toContain("[idle] Boss (boss, ses_boss)")
    expect(text).toContain("  - [idle] Boss · code (worker(code), ses_worker)")
    expect(text).toContain("task-1: Review the PR")
  })
})
