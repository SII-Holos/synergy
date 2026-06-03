/**
 * 完整测试: 直接调用 financial_search tool
 * 跳过 LLM 决策，直接 execute({ question }) 验证完整链路:
 * tool.execute → Cortex.launch(financial agent) → sub-agent(financial-explorer) → agent-browser → 结果
 *
 * 用法: bun run packages/synergy/test/tool/financial-search.test.ts
 */

import { bootstrap } from "../../src/cli/bootstrap"
import { FinancialSearchTool } from "../../src/tool/financial-search"
import { runMigrations } from "../../src/migration"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/scope/instance"

const QUESTION = "查询贵州茅台最新公告"

async function main() {
  const cwd = process.env.SYNERGY_CWD || process.cwd()

  await bootstrap(cwd, async () => {
    await runMigrations()

    console.log("=== Financial Search Tool 直接调用测试 ===\n")
    console.log(`问题: ${QUESTION}\n`)

    // 创建真实 session，生成合法格式的 message ID
    const session = await Session.create({ title: "financial-search-test" })
    const messageID = Identifier.descending("message")

    // 初始化 tool
    const tool = await FinancialSearchTool.init()

    // 构造 ctx
    const ctx = {
      sessionID: session.id,
      messageID,
      agent: "synergy",
      abort: new AbortController().signal,
      metadata(input: any) {
        console.log(`[metadata] ${input.title}`)
      },
      async ask(_input: any) {
        // 自动允许权限
      },
    }

    console.log("正在执行 financial_search...\n")

    const result = await tool.execute({ question: QUESTION }, ctx as any)

    console.log("\n=== 结果 ===\n")
    console.log(`Title: ${result.title}`)
    console.log(`Output:\n${result.output}`)
  })
}

main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
