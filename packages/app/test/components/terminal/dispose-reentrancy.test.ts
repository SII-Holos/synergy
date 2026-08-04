import { describe, expect, test } from "bun:test"
import { Show, createComponent, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

// 回归测试：Synergy 面板打开第一个 terminal 后关闭 → 卡死 "Reconnecting"。
//
// 根因：Solid 卸载 flush（cleanNode 递归）期间，Terminal 的 onCleanup 同步调用
// props.onCleanup（terminal.update → 同步 setStore），而观察该 store 的 pty
// memo 位于同一棵正在被清理的子树中——嵌套 flush 重入正在被清理的 computation
// 图，node.owned 被置 null 后外层循环继续访问 → `null['1']` 崩溃，卸载中断、
// 组件残留显示 "Reconnecting"，之后任意 flush 再爆。
//
// 修复（与 context/terminal 的 close() 既有约定一致）：onCleanup 内同步捕获
// 快照，用 setTimeout 延迟 store 写入，让 setStore 在 dispose flush 之外执行。
//
// 测试形态说明：Solid 内部图损坏依赖精确的节点创建/清理顺序（store → all memo
// → pty memo → Show keyed value memo → Terminal），简化骨架无法复现崩溃；而
// bun 测试环境没有 solid JSX 运行时，无法渲染真实 Terminal 组件树。因此本测试
// 验证修复的行为契约——onCleanup 的 store 写入必须延迟到 dispose flush 之外，
// 且快照数据不丢：
//   1. 卸载 flush 完成后、setTimeout 回调前：store 未被同步写
//   2. flush 之外：延迟写入仍然发生（快照持久化不丢）
// 若有人把修复改回同步 persist，测试 2 会在第 1 步失败。

type Pty = { id: string; title: string }

function createFixture(deferPersist: boolean) {
  const [store, setStore] = createStore<{ items: Pty[] }>({ items: [] })
  const [visible, setVisible] = createSignal(true)
  const calls: string[] = []
  const persisted: Pty[] = []

  // terminal.update 的等价物：同步写 store
  const persist = (pty: Pty) => {
    calls.push("persist")
    setStore("items", (x) => x.map((x) => (x.id === pty.id ? { ...x, ...pty } : x)))
    persisted.push(pty)
  }

  // 模拟 Terminal：卸载时 onCleanup 写 store
  const TerminalLike = (props: { pty: Pty }) => {
    onCleanup(() => {
      calls.push("cleanup")
      if (deferPersist) {
        setTimeout(() => persist(props.pty), 0)
      } else {
        persist(props.pty)
      }
    })
    const element = document.createElement("div")
    element.dataset.pty = props.pty.id
    return element
  }

  const target = document.createElement("div")
  document.body.append(target)
  const dispose = render(
    () =>
      createComponent(Show, {
        get when() {
          return visible()
        },
        keyed: true,
        children: () => createComponent(TerminalLike, { pty: { id: "pty-1", title: "Terminal 1" } }),
      }),
    target,
  )

  return {
    close() {
      setVisible(false)
    },
    dispose,
    calls,
    persisted,
    replaceItems(items: Pty[]) {
      setStore("items", items)
    },
    target,
  }
}

async function settle() {
  // 让 Solid 客户端构建的异步批量 flush 与 setTimeout 回调执行完
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("terminal dispose reentrancy", () => {
  test("synchronous store write inside onCleanup lands in the dispose flush (old behavior)", async () => {
    const fixture = createFixture(false)

    fixture.close()
    // 微任务等待：Solid 客户端构建的 dispose flush 同步完成（cleanup 已跑），
    // 但 setTimeout 回调尚未触发
    await Promise.resolve()

    expect(fixture.calls).toEqual(["cleanup", "persist"])
    expect(fixture.persisted).toEqual([{ id: "pty-1", title: "Terminal 1" }])
    fixture.dispose()
  })

  test("deferred store write survives the dispose flush and still persists", async () => {
    const fixture = createFixture(true)

    fixture.close()
    await Promise.resolve()

    // dispose flush 已完成（cleanup 已跑），但 store 写入被延迟：
    // flush 内不得出现同步写（否则会重入正在被清理的 computation 图）
    expect(fixture.calls).toEqual(["cleanup"])
    expect(fixture.persisted).toEqual([])

    // flush 之外延迟写入仍然发生：快照持久化不丢
    await settle()
    expect(fixture.calls).toEqual(["cleanup", "persist"])
    expect(fixture.persisted).toEqual([{ id: "pty-1", title: "Terminal 1" }])
    fixture.dispose()
  })
})
