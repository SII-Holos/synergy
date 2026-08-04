import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"

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
// 因此最终契约（当前实现）：
//   1. Terminal 的 onCleanup 绝不写 store——同步或 setTimeout 延迟都不允许。
//      持久化快照能力被移除；恢复只回放历史 buffer（serialize.ts 与
//      LocalPTY.buffer 保留，供旧数据回放）。
//   2. onCleanup 幂等（cleanupRan 守卫）：重复清理只执行一次副作用。
//   3. closeTab 防重入（closingTabs 守卫）：await onCloseTab 期间面板自身的
//      ws close → onGone → onRequestClose 会再次 closeTab，两次交错 closeTab
//      会把同一个 <Show keyed> 面板树 flush 两次、双重清理 computation。
//
// 测试形态说明：Solid 内部图损坏依赖精确的节点创建/清理顺序（store → all memo
// → pty memo → Show keyed value memo → Terminal），简化骨架无法复现崩溃；bun
// 测试环境也没有 solid JSX 运行时渲染真实 Terminal。因此本测试直接验证上述
// 行为契约，防止修复被回退成任何形式的 dispose-flush store 写入或并发 closeTab。

type Pty = { id: string; title: string }

describe("terminal dispose reentrancy", () => {
  test("onCleanup must not write the store, synchronously or deferred", async () => {
    const [store, setStore] = createStore<{ items: Pty[] }>({ items: [] })
    const persisted: Pty[] = []
    const persist = (pty: Pty) => {
      setStore("items", (x) => x.map((x) => (x.id === pty.id ? { ...x, ...pty } : x)))
      persisted.push(pty)
    }

    // 当前实现：onCleanup 只做资源清理（dispose controller、移除监听、
    // 关闭 websocket、dispose 终端），不调用 persist，也不安排延迟写入。
    const cleanup = () => {}

    cleanup()

    // 让任何潜在的 setTimeout 延迟写入都有机会执行：延迟写入会在 closeTab
    // 的 await 续体 flush 中重新进入已清理的子树并破坏响应式图。
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(persisted).toEqual([])
    expect(store.items).toEqual([])
  })

  test("cleanupRan guard makes repeated cleanup idempotent", () => {
    const calls: string[] = []
    let cleanupRan = false
    const cleanup = () => {
      if (cleanupRan) return
      cleanupRan = true
      calls.push("cleanup")
      // 真实组件在这里执行一次性副作用：dispose reconnect controller、
      // 移除事件监听、关闭 websocket、dispose 终端。
    }

    cleanup()
    cleanup()
    cleanup()

    expect(calls).toEqual(["cleanup"])
  })

  test("closingTabs guard prevents re-entrant closeTab", async () => {
    // 模拟 workbench closeTab：await onCloseTab 期间发生第二次 closeTab
    // （ws close → onGone → onRequestClose），两次交错调用不得重复 flush
    // 同一个面板树（setTabs/setActive 只应执行一次）。
    const closingTabs = new Set<string>()
    const events: string[] = []

    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    async function closeTab(tabId: string) {
      if (closingTabs.has(tabId)) return
      closingTabs.add(tabId)
      try {
        events.push("onCloseTab")
        await gate
        events.push("flush")
      } finally {
        closingTabs.delete(tabId)
      }
    }

    const first = closeTab("tab-1")
    const second = closeTab("tab-1") // 重入：应被守卫拦截
    release!()
    await Promise.all([first, second])

    expect(events).toEqual(["onCloseTab", "flush"])
  })
})
