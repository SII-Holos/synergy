import z from "zod"
import { Tool } from "../tool"
import { Config } from "../../config/config"

const VALID_KEYS = [
  "defaultProject",
  "defaultWorkspace",
  "defaultComputeGroup",
  "defaultImage",
  "defaultPriority",
  "defaultShm",
  "commandPrefix",
] as const

type ConfigKey = (typeof VALID_KEYS)[number]

const KEY_DESCRIPTIONS: Record<ConfigKey, string> = {
  defaultProject: "默认项目名称（如 '大模型时代下的多智能体系统'）",
  defaultWorkspace: "默认工作空间（如 '分布式训练空间'）",
  defaultComputeGroup: "默认计算组（如 'cuda12.8版本H100'）",
  defaultImage: "默认训练镜像（完整地址，如 'docker-qb.sii.edu.cn/inspire-studio/xxx:v1'）",
  defaultPriority: "默认任务优先级（数字 1-10，通常为项目最大值）",
  defaultShm: "默认共享内存 MB（推荐 1200，多卡训练必须）",
  commandPrefix:
    "命令前缀（如 'source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/xxx/code'）。设置后 inspire_submit 的 command 自动拼接此前缀",
}

const DESCRIPTION = `Read or write SII 启智平台 default configuration values. These defaults simplify subsequent tool calls — when a default is set, the corresponding parameter becomes optional across all inspire_* tools.

Available configuration keys:
- defaultProject: ${KEY_DESCRIPTIONS.defaultProject}
- defaultWorkspace: ${KEY_DESCRIPTIONS.defaultWorkspace}
- defaultComputeGroup: ${KEY_DESCRIPTIONS.defaultComputeGroup}
- defaultImage: ${KEY_DESCRIPTIONS.defaultImage}
- defaultPriority: ${KEY_DESCRIPTIONS.defaultPriority}
- defaultShm: ${KEY_DESCRIPTIONS.defaultShm}
- commandPrefix: ${KEY_DESCRIPTIONS.commandPrefix}

Typical first-time setup flow:
1. Call inspire_status to discover projects, workspaces, compute groups
2. Call inspire_config(action="set", key="defaultProject", value="...") for each default
3. After setup, inspire_submit only needs name + command (everything else uses defaults)

The commandPrefix is especially valuable — it eliminates the need to type conda init + cd every time. With it set, inspire_submit automatically prepends it to your command.`

const parameters = z.object({
  action: z.enum(["get", "set"]).describe("'get' to view current defaults, 'set' to update a value"),
  key: z
    .string()
    .optional()
    .describe(
      "Config key to set (required for 'set'). One of: defaultProject, defaultWorkspace, defaultComputeGroup, defaultImage, defaultPriority, defaultShm, commandPrefix",
    ),
  value: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Value to set (required for 'set'). Use empty string to clear a default"),
})

export const InspireConfigTool = Tool.define("inspire_config", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const config = await Config.get()
    const sii = config.sii ?? {}

    if (params.action === "get") {
      const lines = ["=== SII 启智平台默认配置 ===", ""]
      lines.push(`启用状态: ${sii.enable ? "✅ 开启" : "❌ 关闭"}`)
      lines.push("")

      let hasAny = false
      for (const key of VALID_KEYS) {
        const val = sii[key]
        const desc = KEY_DESCRIPTIONS[key]
        if (val !== undefined && val !== "") {
          lines.push(`${key}: ${val}`)
          lines.push(`  └ ${desc}`)
          hasAny = true
        }
      }

      if (!hasAny) {
        lines.push("（尚未配置任何默认值）")
        lines.push("")
        lines.push("建议先调用 inspire_status 查看可用项目和空间，然后使用:")
        lines.push('  inspire_config(action="set", key="defaultProject", value="项目名")')
        lines.push("逐一设置常用默认值。")
      }

      lines.push("")
      lines.push("未设置的字段:")
      for (const key of VALID_KEYS) {
        const val = sii[key]
        if (val === undefined || val === "") {
          lines.push(`  ${key}: (未设置) — ${KEY_DESCRIPTIONS[key]}`)
        }
      }

      return {
        title: "SII 配置",
        output: lines.join("\n"),
        metadata: { action: "get", configured_keys: VALID_KEYS.filter((k) => sii[k] !== undefined) } as Record<
          string,
          any
        >,
      }
    }

    if (params.action === "set") {
      if (!params.key) {
        return {
          title: "缺少 key",
          output: `请指定要设置的配置项。可选项:\n${VALID_KEYS.map((k) => `  - ${k}: ${KEY_DESCRIPTIONS[k]}`).join("\n")}`,
          metadata: { error: "missing_key" } as Record<string, any>,
        }
      }

      if (!VALID_KEYS.includes(params.key as ConfigKey)) {
        return {
          title: "无效的 key",
          output: `"${params.key}" 不是有效的配置项。可选项:\n${VALID_KEYS.map((k) => `  - ${k}`).join("\n")}`,
          metadata: { error: "invalid_key" } as Record<string, any>,
        }
      }

      const key = params.key as ConfigKey
      const value = params.value === "" ? undefined : params.value

      const patch: Record<string, any> = { sii: { ...sii, [key]: value } }
      await Config.updateGlobal(patch as any)

      const displayValue = value === undefined ? "(已清除)" : String(value)
      const lines = [`✅ 已设置 ${key} = ${displayValue}`, "", `说明: ${KEY_DESCRIPTIONS[key]}`]

      if (key === "commandPrefix" && value) {
        lines.push("")
        lines.push("效果: 后续 inspire_submit 的 command 参数将自动拼接此前缀。")
        lines.push('例如 command="python train.py" 实际执行:')
        lines.push(`  ${value} && python train.py`)
      }

      return {
        title: `设置 ${key}`,
        output: lines.join("\n"),
        metadata: { action: "set", key, value: displayValue } as Record<string, any>,
      }
    }

    return {
      title: "错误",
      output: 'action 必须是 "get" 或 "set"',
      metadata: { error: "invalid_action" } as Record<string, any>,
    }
  },
})
