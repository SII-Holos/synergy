import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const sections = [
  {
    requiredTools: ["boss_spawn", "boss_assign", "boss_status", "boss_cancel"],
    text: "协调工作时先用 boss_status 检查已有 worker，适合时复用；用 boss_spawn 创建专业 worker、boss_assign 派发任务，用 boss_cancel 停止工作。独立任务可以并行派发，汇报后核实结果。",
  },
  {
    requiredTools: ["boss_project", "session_send"],
    text: "项目尚未建立时用 boss_project 创建项目。已有项目的请求通过 session_send 交给项目负责人，并附原始请求和必要上下文。",
  },
  {
    requiredTools: ["session_read", "session_list", "session_search", "scope_list"],
    text: "用 scope_list、session_list 和 session_search 定位项目与会话；需要核实进展时用 session_read 阅读相关会话，优先接收负责人摘要。",
  },
  {
    requiredTools: ["session_control", "session_read"],
    text: "session_control 用于创建和整理会话、终止执行及调整会话配置。先用 session_read 确认操作目标。",
  },
  {
    requiredTools: ["memory_search", "memory_write", "memory_edit"],
    text: "身份记忆纪律：先用 memory_search 查找已记录的项目归属、任务、决策和约束；用 memory_write 保留新事实，用 memory_edit 精炼已有事实。用户、关系和自身角色的稳定事实保持简洁，避免近似重复。",
  },
  {
    requiredTools: [
      "agenda_list",
      "agenda_schedule",
      "agenda_watch",
      "agenda_update",
      "agenda_cancel",
      "agenda_trigger",
      "agenda_logs",
    ],
    text: "日程管理：用 agenda_list 检查已有任务，agenda_schedule 安排周期工作，agenda_watch 安排一次性跟进；agenda_update 和 agenda_cancel 维护任务，agenda_trigger 手动触发，agenda_logs 核实执行结果。",
  },
  {
    requiredTools: ["bash"],
    text: "仅用 bash 执行只读查询，例如 git status。文件修改、安装、推送和删除交给负责执行的 worker。",
  },
] as const

export function registerBossPrompts() {
  AgentPromptContributions.register(
    "boss",
    sections.map((section) => ({
      requiredTools: section.requiredTools,
      render: (_agent, identity) => (identity?.owner === "boss" ? section.text : ""),
    })),
  )
}
