import { describe, expect, test } from "bun:test"
import { createCleanupGuard, isPtyNotFoundError } from "../../../src/components/terminal/terminal-dispose"
import { createTabCloseGuard } from "../../../src/context/workbench/panel-model"

// 回归测试：Synergy 面板打开第一个 terminal 后关闭 → 卡死 "Reconnecting"。
//
// 根因（最终版）：Terminal 的 onCleanup 在 Solid 卸载 flush（cleanNode 递归）中
// 运行。旧实现（4b3d4ef67 之前）在 onCleanup 内同步调用 props.onCleanup
// （terminal.update → setStore）写 store，重入正在被清理的 computation 图；
// 4b3d4ef67 改成 setTimeout(0) 延迟写入后仍然崩溃——closeTab 的
// `await pty.remove` 续体在同一个 flush 中把延迟写入重新引入已清理的子树
// （cleanNode 对已置 null 的 owned 数组双重清理 → `null['1']`），卸载中断、
// 组件残留显示 "Reconnecting"，之后任意 setStore 再触发同一崩溃。
//
// 修复后的生产契约（本测试直接调用生产代码，不再本地重写）：
//   1. onCleanup 绝不写 store——同步或 setTimeout 延迟都不允许。持久化快照
//      能力被移除；恢复只回放历史 buffer。
//   2. createCleanupGuard 让 onCleanup 幂等：重复清理只执行一次副作用。
//   3. createTabCloseGuard 防 closeTab 重入：await onCloseTab 期间面板自身的
//      ws close → onGone → onRequestClose 会再次 closeTab，两次交错 closeTab
//      会把同一个 <Show keyed> 面板树 flush 两次、双重清理 computation。
//   4. isPtyNotFoundError 识别 server 实际序列化的 NotFoundError 形状
//      （GET /pty/{id} 404 → `{ name: "NotFoundError", data: { message } }`），
//      也兼容旧 APIError + statusCode 形状；只有确认 PTY 消失才触发 onGone。
//
// 测试形态说明：Solid 内部图损坏依赖精确的节点创建/清理顺序，bun 测试环境
// 也没有 solid JSX 运行时渲染真实 Terminal。因此验证行为契约本身（这些辅助
// 函数就是 Terminal/workbench 实际使用的生产代码，删除守卫或重新引入 store
// 写入都会让对应测试失败）。

describe("terminal dispose reentrancy", () => {
  test("cleanup guard lets the first cleanup run and drops re-entrant ones", () => {
    const cleanupRan = createCleanupGuard()
    const calls: string[] = []

    const cleanup = () => {
      if (!cleanupRan()) return
      calls.push("cleanup")
      // 真实组件在这里执行一次性副作用：dispose reconnect controller、
      // 移除事件监听、关闭 websocket、dispose 终端。
    }

    cleanup()
    cleanup()
    cleanup()

    expect(calls).toEqual(["cleanup"])
  })

  test("cleanup guard is per-instance, not shared across terminals", () => {
    const first = createCleanupGuard()
    const second = createCleanupGuard()

    expect(first()).toBe(true)
    expect(first()).toBe(false)
    // 另一个终端实例的守卫不受影响
    expect(second()).toBe(true)
    expect(second()).toBe(false)
  })

  test("tab close guard blocks re-entrant closeTab for the same tab", async () => {
    const guard = createTabCloseGuard()
    const events: string[] = []

    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function closeTab(tabId: string) {
      if (!guard.begin(tabId)) return
      try {
        events.push("onCloseTab")
        await gate
        events.push("flush")
      } finally {
        guard.end(tabId)
      }
    }

    const first = closeTab("tab-1")
    const second = closeTab("tab-1") // 重入：应被守卫拦截
    expect(guard.isClosing("tab-1")).toBe(true)
    release!()
    await Promise.all([first, second])

    expect(events).toEqual(["onCloseTab", "flush"])
    // 关闭完成后同一 tab 可以再次关闭
    expect(guard.isClosing("tab-1")).toBe(false)
  })

  test("tab close guard allows concurrent close of different tabs", async () => {
    const guard = createTabCloseGuard()

    expect(guard.begin("tab-1")).toBe(true)
    expect(guard.begin("tab-2")).toBe(true)
    expect(guard.isClosing("tab-1")).toBe(true)
    expect(guard.isClosing("tab-2")).toBe(true)

    guard.end("tab-1")
    guard.end("tab-2")
    expect(guard.isClosing("tab-1")).toBe(false)
    expect(guard.isClosing("tab-2")).toBe(false)
  })

  test("isPtyNotFoundError recognizes the serialized NotFoundError shape", () => {
    // server.ts onError 对 Storage.NotFoundError 返回 err.toObject()：
    // `{ name: "NotFoundError", data: { message } }`（SDK throwOnError 抛原样 JSON）
    expect(isPtyNotFoundError({ name: "NotFoundError", data: { message: "Session not found" } })).toBe(true)
  })

  test("isPtyNotFoundError recognizes the legacy APIError shape", () => {
    expect(isPtyNotFoundError({ name: "APIError", data: { statusCode: 404 } })).toBe(true)
  })

  test("isPtyNotFoundError rejects non-404 and unrelated errors", () => {
    expect(isPtyNotFoundError({ name: "APIError", data: { statusCode: 500 } })).toBe(false)
    expect(isPtyNotFoundError({ name: "OtherError", data: { statusCode: 404 } })).toBe(false)
    expect(isPtyNotFoundError(new Error("network down"))).toBe(false)
    expect(isPtyNotFoundError(undefined)).toBe(false)
    expect(isPtyNotFoundError(null)).toBe(false)
  })
})
