# Synergy 插件开发者指南

**版本**: 适配 Synergy v4.1
**目标读者**: 希望开发、发布和维护 Synergy 插件的开发者
**参考源码**:

- `packages/plugin/` — 插件 SDK（`@ericsanchezok/synergy-plugin`）
- `packages/synergy/src/plugin/` — 服务端插件加载、安装、生命周期、权限审批
- `packages/synergy/src/plugin-runtime/` — 运行时隔离（进程/Worker/In-Process）
- `packages/synergy/src/cli/cmd/plugin-*.ts` — CLI 工具链命令

---

## 目录

1. [概述：Plugin 能做什么](#1-概述plugin-能做什么)
2. [快速开始](#2-快速开始)
3. [清单（plugin.json）](#3-清单pluginjson)
4. [后端插件代码](#4-后端插件代码)
5. [运行时隔离](#5-运行时隔离)
6. [权限与审批](#6-权限与审批)
7. [前端 UI 贡献](#7-前端-ui-贡献)
8. [工具链命令](#8-工具链命令)
9. [市场与分发](#9-市场与分发)
10. [测试与验证](#10-测试与验证)
11. [端到端示例](#11-端到端示例)
12. [最佳实践](#12-最佳实践)

---

## 1. 概述：Plugin 能做什么

Synergy 插件可以在**运行时（后端）**和 **Web 客户端（前端）**两方面扩展平台功能。

### 后端扩展

| 能力                     | 说明                                                           |
| ------------------------ | -------------------------------------------------------------- |
| **自定义工具 (Tools)**   | 通过 `tool()` 函数定义新的 AI 工具，在会话中被 LLM 调用        |
| **生命周期钩子 (Hooks)** | 监听和改写会话、消息、笔记、记忆、Agenda、工具执行、权限等事件 |
| **MCP 服务器**           | 声明本地或远程 MCP 服务器，通过标准 MCP 协议访问外部能力       |
| **自定义技能 (Skills)**  | 注册可复用的技能模板，为 Agent 提供领域知识                    |
| **自定义 Agent**         | 注册新的内置子 Agent，定义其提示词、模型和权限                 |
| **CLI 命令**             | 为 `synergy <pluginId>` 注册子命令                             |
| **认证提供方**           | 集成 OAuth / API Key 认证流程                                  |
| **配置与存储**           | 插件专属的 Config、Auth（凭据）、Cache 存储                    |

### 前端扩展

| 能力                                | 说明                                       |
| ----------------------------------- | ------------------------------------------ |
| **工具渲染器 (Tool Renderers)**     | 自定义工具调用结果在聊天气泡中的展示方式   |
| **消息部分渲染器 (Part Renderers)** | 自定义消息组成部分（如图片、代码块）的渲染 |
| **工作区面板 (Workspace Panels)**   | 在项目视图中添加侧边面板                   |
| **全局面板 (Global Panels)**        | 在全局视图中添加跨项目可见的面板           |
| **设置页 (Settings)**               | 在设置对话框中添加插件专属配置页           |
| **聊天气泡组件 (Chat Components)**  | 在聊天流的指定插槽注入自定义 UI 组件       |
| **主题 (Themes)**                   | 提供 CSS 自定义属性来改变 UI 外观          |
| **图标 (Icons)**                    | 注册自定义 SVG 图标                        |
| **路由 (Routes)**                   | 添加完整的页面路由                         |
| **UI 命令 (Commands)**              | 在命令面板中注册可执行命令                 |

### 平台基础设施

插件系统以三条基础设施为支柱：

1. **运行时隔离** — 第三方插件默认运行在独立进程中，与主进程内存隔离。本地/官方插件可配置为 in-process 获得更高性能。
2. **权限与审批 (Consent)** — 插件安装和更新时，系统将解析其声明的权限，生成差异报告并要求用户审批。审批记录持久化，hash 校验确保不可篡改。
3. **市场 (Marketplace)** — 插件可通过 `synergy plugin publish` 发布到注册表，支持签名验证、版本管理和自动更新。

---

## 2. 快速开始

### 前提

- 安装 Synergy（v4.1+）
- 安装 Bun（v1.1+）

### 使用脚手架创建插件

```bash
# 创建默认模板（tool-ui）：后端的 tool + 前端的 Solid.js 渲染器
synergy plugin create my-plugin

# 指定其他模板
synergy plugin create my-plugin --template api-connector
synergy plugin create my-plugin --template workspace-panel
synergy plugin create my-plugin --template theme-icon
```

可用模板：

| 模板              | 说明                                |
| ----------------- | ----------------------------------- |
| `tool-ui`         | 后端工具 + 前端 Solid.js 工具渲染器 |
| `workspace-panel` | 前端 Solid.js 工作区面板            |
| `api-connector`   | 网络请求工具（fetch），声明网络权限 |
| `theme-icon`      | 主题 CSS + 图标 SVG 贡献            |

### 目录结构

```
my-plugin/
├── plugin.json              # 插件清单（必须）
├── package.json             # npm 包信息
├── tsconfig.json            # TypeScript 配置
├── README.md                # 插件说明
└── src/
    ├── index.ts             # 导出 PluginDescriptor 的入口
    ├── tools.ts             # tool() 定义（tool-ui 模板）
    └── ui.tsx               # 前端 UI 组件（Solid.js）
```

### 安装依赖

```bash
cd my-plugin && bun install
```

### 开发

```bash
synergy plugin dev
```

这会验证清单、显示权限预览、显示运行时健康状态，并监听 `src/` 目录的变更自动重载插件。

如果插件包含前端 UI，还需要运行前端构建：

```bash
bun run build   # tsc 编译
```

或在开发时使用 watch 模式：

```bash
bun run dev     # tsc --watch
```

然后启动 Synergy 服务器并在全局配置中引用插件：

```jsonc
// ~/.synergy/config/synergy.jsonc
{
  "plugin": ["file:///path/to/my-plugin"],
}
```

### 构建、打包与签名

```bash
# 1. 构建后端 + 前端
synergy plugin build

# 2. 打包为可分发的 tgz
synergy plugin pack
# 输出: my-plugin-0.1.0.synergy-plugin.tgz

# 3. 签名（可选，用于市场发布）
synergy plugin sign my-plugin-0.1.0.synergy-plugin.tgz
```

### 本地安装

```bash
synergy plugin add file:///path/to/my-plugin
```

或直接编辑全局配置：

```jsonc
{
  "plugin": ["file:///path/to/my-plugin", "my-published-plugin"],
}
```

---

## 3. 清单（plugin.json）

插件清单是插件身份的声明文件，定义了插件的身份、权限、贡献点和运行时偏好。

### 完整结构

```jsonc
{
  // ── 身份标识 ──
  "name": "my-plugin", // 必填，1-128 字符
  "version": "0.1.0", // 必填，semver 格式
  "description": "做什么的插件", // 必填，1-1024 字符
  "author": "Your Name",
  "homepage": "https://example.com",
  "repository": "github:user/repo",
  "license": "MIT",
  "icon": "icon.png", // 相对于插件根目录
  "keywords": ["synergy-plugin", "tool"],

  // ── 兼容性 ──
  "minSynergyVersion": "4.1.0",
  "engines": {
    "synergy": ">=4.1.0",
    "bun": ">=1.1.0",
  },

  // ── 依赖其他插件 ──
  "dependencies": {
    "another-plugin": "^1.0.0",
  },

  // ── 信任层级请求 ──
  "trust": {
    "requestedTier": "trusted-import", // declarative | trusted-import | sandbox
    "reason": "需要访问 DOM API",
  },

  // ── 权限声明 ──
  "permissions": {
    /* 见下方 */
  },

  // ── 贡献点 ──
  "contributes": {
    /* 见下方 */
  },

  // ── 生命周期 ──
  "main": "./src/index.ts",
  "lifecycle": {
    "install": "./scripts/install.ts",
    "uninstall": "./scripts/uninstall.ts",
    "update": "./scripts/update.ts",
  },

  // ── 运行时偏好 ──
  "runtime": {
    "mode": "process", // in-process | worker | process
    "minRuntimeApiVersion": "1.0.0",
    "resources": {
      "memoryMb": 256,
      "startupTimeoutMs": 15000,
      "requestTimeoutMs": 30000,
      "maxConcurrentRequests": 5,
      "maxLogBytesPerMinute": 10240,
    },
  },
}
```

### 权限声明（permissions）

权限字段定义了插件在运行时可以访问的资源。**所有字段都是可选的，默认采用最保守的值。**

```jsonc
"permissions": {
  "tools": {
    "invoke": true,               // 工具可被调用
    "shell": false,                // 执行 shell 命令（高风险）
    "filesystem": "none",          // none | read | write
    "network": false,              // 网络访问
    "mcp": "none"                  // none | invoke | spawn
  },
  "data": {
    "session": "none",            // none | metadata | read
    "workspace": "none",          // none | metadata | read
    "config": "plugin",           // plugin | global
    "secrets": "none"             // none | own
  },
  "network": {
    "connectDomains": ["api.example.com"],   // 插件可连接的域名
    "resourceDomains": ["cdn.example.com"],   // 资源加载域名
    "frameDomains": []                        // iframe 允许的域名
  },
  "ui": {
    "toolRenderers": false,
    "partRenderers": false,
    "workspacePanels": false,
    "globalPanels": false,
    "settings": false,
    "themes": false,
    "icons": false,
    "routes": false,
    "trustedImport": false,        // 允许同域 JS 动态导入
    "sandboxIframe": false         // 允许沙箱 iframe
  },
  "hooks": {
    "events": "selected",          // none | selected | all
    "eventNames": ["session.updated"],
    "toolExecute": "own",          // none | own | declared | all
    "permissionAsk": "none",       // none | own | all
    "promptTransform": false,      // 改写系统提示词（高风险）
    "compactionTransform": false
  }
}
```

#### 风险等级

系统根据权限自动计算插件的整体风险：

| 等级   | 包含的权限                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------- |
| **高** | `shell`、`filesystem:write`、`secrets`、无域名限制的 `network`、`hooks.promptTransform`、`mcp:spawn` |
| **中** | `filesystem:read`、`session_data`、`config:write`、有域名限制的 `network`、`mcp:invoke`              |
| **低** | 其他所有权限                                                                                         |

### 贡献点（contributes）

```jsonc
"contributes": {
  "tools": [
    {
      "id": "my-tool",
      "name": "my_tool",           // 工具名称（LLM 调用时使用的名称）
      "title": "我的工具",          // 显示标题
      "description": "做什么的",     // 工具描述给 LLM 看
      "icon": "wand",               // Lucide 图标名称
      "category": "utility",        // 工具分类
      "kind": "function",           // 工具类型
      "capabilities": {             // 该工具额外的权限声明（叠加在全局权限之上）
        "filesystem": "read",
        "network": true,
        "shell": false,
        "session": "none",
        "workspace": "none",
        "config": "plugin"
      },
      "risk": "low"
    }
  ],
  "skills": [
    {
      "name": "my-skill",
      "description": "使用技能描述",
      "dir": "./skills/my-skill"    // 技能文件目录
    }
  ],
  "agents": [
    {
      "name": "my-agent",
      "description": "Agent 描述",
      "mode": "subagent",           // subagent | primary | all
      "model": "openai/gpt-4o"
    }
  ],
  "commands": [
    {
      "name": "my-command",
      "description": "CLI 命令说明"
    }
  ],
  "config": {
    "schema": {                     // JSON Schema
      "type": "object",
      "properties": {
        "apiKey": { "type": "string" }
      }
    },
    "defaults": {
      "apiKey": ""
    }
  },
  "mcp": {
    "defaults": {                   // 全局默认设置
      "startup": "lazy",
      "required": false
    },
    "my-server": {                  // 具体 MCP 服务器
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      "description": "文件系统 MCP"
    }
  },
  "ui": { /* 见第 7 章 */ }
}
```

关于 `capabilities` 字段的覆盖规则：

- 如果某个 `contributes.tools[]` 没有声明 `capabilities`，则该工具继承 `permissions` 顶层的默认值。
- 如果声明了，则指定的字段覆盖插件级默认值，未指定的字段仍使用插件级默认。
- 工具级的能力声明对系统理解该工具的具体风险等级非常重要。

### 运行时偏好

```jsonc
"runtime": {
  "mode": "process",         // in-process / worker / process
  "resources": {
    "memoryMb": 256,         // 内存上限（MB）
    "startupTimeoutMs": 15000,
    "requestTimeoutMs": 30000,
    "maxConcurrentRequests": 5,
    "maxLogBytesPerMinute": 10240
  }
}
```

- **`in-process`**：插件代码与主进程在同一 V8 隔离区运行，性能最高但无内存隔离。仅适用于官方、本地或用户信任的插件。
- **`worker`**：在 Node.js Worker 线程中运行，适合用户信任且需要轻量隔离的插件。当前 runtime mode resolver 不会仅因插件声明了 shell 或文件写权限就自动禁止 worker；高风险插件仍会被策略提升到 process。
- **`process`**：在独立的 OS 进程中运行，提供完整的资源隔离。**第三方和高风险插件的默认选择。**

---

## 4. 后端插件代码

### PluginDescriptor

插件入口文件必须导出一个 `PluginDescriptor` 对象：

```typescript
import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"

export const myPlugin: PluginDescriptor = {
  id: "my-plugin",
  name: "My Plugin",
  async init(input: PluginInput): Promise<PluginHooks> {
    // 初始化逻辑
    return {
      tool: {
        /* ... */
      },
      skills: [],
      agents: {},
      cli: {},
      auth: {},
      dispose: async () => {
        /* 清理 */
      },
      // 各种钩子
    }
  },
}
export default myPlugin
```

### PluginInput

`init()` 接收到 `PluginInput` 对象，包含插件运行所需的上下文：

```typescript
interface PluginInput {
  client:          // Synergy SDK 客户端，用于调用服务端 API
  scope: {
    type: "global" | "project"
    id: string
    directory: string
    worktree: string
    vcs?: "git"
    name?: string
    icon?: string
    sandboxes?: string[]
    time?: { created: number; updated: number }
  }
  directory: string     // 当前作用域的工作目录
  worktree: string      // 工作树根目录
  serverUrl: URL        // 服务端 URL
  $: BunShell           // Bun 内置 shell（模板字符串形式）
  config: {             // 插件专属配置访问器
    get(): Promise<Record<string, any>>
    set(values: Record<string, any>): Promise<void>
  }
  auth: {               // 凭据存储（明文 JSON，未来将使用系统密钥链）
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
    has(key: string): Promise<boolean>
  }
  cache: {              // 缓存存储
    get<T>(key: string): Promise<T | undefined>
    set(key: string, value: unknown, ttl?: number): Promise<void>
    delete(key: string): Promise<void>
    directory: string   // 缓存目录绝对路径
  }
  pluginDir: string     // 插件根目录绝对路径
}
```

> **警告**：`auth` 存储当前为明文 JSON 文件位于 `~/.synergy/data/plugin/{id}/auth.json`。请保护好你的文件系统。未来版本将使用系统密钥链。

### 定义工具

使用 `tool()` 辅助函数定义工具，它是类型安全的：

```typescript
import { tool } from "@ericsanchezok/synergy-plugin"

export const read_config = tool({
  description: "读取插件配置",
  args: {
    key: tool.schema.string().describe("配置键名"),
  },
  async execute(args, context) {
    // args.key 的类型已推导为 string
    return `配置值: ${args.key}`
  },
})
```

`context` 对象提供了执行上下文：

```typescript
interface ToolContext {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal // 用于取消长时间运行的请求
  directory?: string // 会话的工作目录
  ask?(input: {
    // 请求用户授权
    permission: string
    patterns: string[]
    metadata?: Record<string, any>
  }): Promise<void>
}
```

返回值可以是字符串或 `ToolResult` 对象：

```typescript
interface ToolResult {
  title?: string
  output: string
  metadata?: Record<string, any>
  attachments?: Array<{
    type: "file"
    id: string
    sessionID: string
    messageID: string
    mime: string
    filename?: string
    url: string
    localPath?: string
  }>
}
```

### Hooks（钩子）

钩子（Hooks）是插件观察和改写平台行为的主要机制。在 `init()` 返回的 `PluginHooks` 对象中注册。

**完整钩子列表**（可通过 `synergy plugin hooks` 查看）：

| 钩子名                                 | 类型         | 说明                     |
| -------------------------------------- | ------------ | ------------------------ |
| `tool`                                 | core         | 注册自定义工具           |
| `auth`                                 | core         | 添加认证提供方           |
| `config`                               | core         | 观察运行时配置           |
| `event`                                | core         | 观察总线事件             |
| `chat.message`                         | chat         | 改写用户输入消息         |
| `chat.params`                          | chat         | 调整 LLM 参数            |
| `permission.ask`                       | permission   | 改写权限审批决策         |
| `tool.execute.before`                  | tool         | 改写工具执行参数         |
| `tool.execute.after`                   | tool         | 改写工具输出             |
| `session.turn.after`                   | session      | 观察对话轮完成           |
| `cortex.task.after`                    | cortex       | 观察 Cortex 任务完成     |
| `agenda.run.before`                    | agenda       | 跳过或改写 Agenda 执行   |
| `agenda.run.after`                     | agenda       | 观察 Agenda 成功执行     |
| `agenda.run.error`                     | agenda       | 观察 Agenda 执行失败     |
| `note.create.before`                   | note         | 改写笔记创建             |
| `note.create.after`                    | note         | 观察笔记创建完成         |
| `note.update.before`                   | note         | 改写笔记更新             |
| `note.update.after`                    | note         | 观察笔记更新完成         |
| `note.search.before`                   | note         | 改写笔记搜索参数         |
| `note.search.after`                    | note         | 筛选笔记搜索结果         |
| `engram.memory.search.before`          | engram       | 改写记忆搜索参数         |
| `engram.memory.search.after`           | engram       | 筛选记忆搜索结果         |
| `engram.experience.encode.after`       | engram       | 观察经验编码结果         |
| `experimental.chat.messages.transform` | experimental | 改写发送给模型的消息历史 |
| `experimental.chat.system.transform`   | experimental | 改写系统提示词           |
| `experimental.session.compacting`      | experimental | 自定义会话压缩           |
| `experimental.text.complete`           | experimental | 改写文本补全输出         |

钩子的作用域由 `permissions.hooks` 控制。例如 `toolExecute: "own"` 意味着钩子只触发在插件自己注册的工具上，`toolExecute: "all"` 则可以拦截所有工具（需获批）。

### CLI 命令

插件可以注册 `synergy <pluginId> <subcommand>` 形式的 CLI 命令：

```typescript
return {
  cli: {
    greet: {
      description: "打招呼",
      options: {
        name: {
          type: "string",
          description: "你的名字",
          required: true,
        },
      },
      async execute(args) {
        return `你好, ${args.name}!`
      },
    },
    config: {
      description: "配置管理",
      subcommands: {
        show: {
          description: "显示配置",
          async execute() {
            const cfg = await input.config.get()
            return JSON.stringify(cfg, null, 2)
          },
        },
      },
    },
  },
}
```

### 技能（Skills）

插件可以注册技能，为 Agent 提供领域知识：

```typescript
return {
  skills: [
    {
      name: "my-domain",
      description: "我的领域知识",
      dir: "./skills/my-domain", // 使用目录自动加载
    },
    {
      name: "inline-skill",
      description: "内联技能",
      content: "# 内联知识\n这是一些知识...",
      references: {
        "api.md": "# API 说明\n...",
      },
    },
  ],
}
```

### 自定义 Agent

插件可以注册新 Agent：

```typescript
return {
  agents: {
    "my-helper": {
      name: "my-helper",
      description: "帮助用户的专用 AI",
      prompt: "你是一个乐于助人的助手...",
      mode: "subagent",
      model: "openai/gpt-4o",
      temperature: 0.7,
      hidden: false,
      color: "#FF5733",
    },
  },
}
```

---

## 5. 运行时隔离

### 三种模式

插件运行时隔离有三种模式，按资源隔离级别排列：

| 模式         | 隔离级别   | 性能 | 支持能力                 | 适用场景                       |
| ------------ | ---------- | ---- | ------------------------ | ------------------------------ |
| `in-process` | 无内存隔离 | 最高 | 全部                     | 官方插件、本地开发、低风险插件 |
| `worker`     | 线程级     | 中   | 由权限审批与策略共同控制 | 受信任且需要轻量隔离的插件     |
| `process`    | 进程级     | 较低 | 全部                     | 第三方插件、高风险插件（默认） |

### 模式解析策略

系统通过以下规则（第一匹配获胜）决定最终的运行时模式：

```
1. 调用者强制 process        → "process"
2. 风险等级为 high           → "process"（安全覆盖）
3. 清单请求 process          → "process"
4. 清单请求 worker + 用户已信任 + 策略允许 → "worker"
5. 清单请求 in-process：
   - builtin / official 来源 → "in-process"
   - local 来源 + `allowLocalInProcess` → "in-process"，否则 → "process"
   - 第三方来源 + `allowThirdPartyInProcess` → "in-process"，否则 → "process"
6. 默认：
   - builtin / official → "in-process"
   - local（如果 `allowLocalInProcess=false`）→ "process"
   - npm / git / url → "process"
```

关键的配置在 `synergy.jsonc` 中：

```jsonc
{
  "pluginRuntimePolicy": {
    "thirdPartyDefaultMode": "process", // 第三方插件默认 runtime mode：process 或 worker
    "highRiskRequiresProcess": true, // 高风险插件是否强制 process
    "allowWorkerMode": false, // 是否允许 worker 模式
    "allowLocalInProcess": true, // 本地插件是否允许 in-process
    "allowThirdPartyInProcess": false, // 第三方插件是否允许 in-process
  },
}
```

### 进程桥接协议

当插件运行在 process 模式下时，主进程与插件进程通过标准输入/输出通信，使用 JSON 格式的消息协议：

**主机 → 插件**：

- `init` — 初始化，传递 `IsolatedPluginInputData`
- `invokeTool` — 调用工具
- `triggerHook` — 触发钩子
- `bridgeResponse` — 桥接请求响应
- `reload` / `shutdown` / `ping`

**插件 → 主机**：

- `ready` — 初始化完成，报告注册的工具和钩子
- `response` — 请求响应
- `hostRequest` — 向主进程发起桥接请求（读取文件、网络请求等）
- `log` — 日志
- `heartbeat` — 心跳

### 桥接方法

插件进程可以通过桥接请求以下能力：

| 方法                       | 所需能力                | 说明            |
| -------------------------- | ----------------------- | --------------- |
| `config.get`               | `plugin_config_read`    | 读取插件配置    |
| `config.set`               | `plugin_config_write`   | 写入插件配置    |
| `secret.get/set/delete`    | `plugin_secret_read`    | 管理凭据        |
| `cache.get/set`            | `plugin_invoke`         | 管理缓存        |
| `file.read`                | `plugin_file_read`      | 读取文件        |
| `file.write`               | `plugin_file_write`     | 写入文件        |
| `network.fetch`            | `plugin_network`        | HTTP 请求       |
| `shell.run`                | `plugin_shell`          | 执行 shell 命令 |
| `session.getMetadata/read` | `plugin_session_read`   | 读取会话数据    |
| `workspace.getMetadata`    | `plugin_workspace_read` | 读取工作区信息  |
| `tool.invoke`              | `plugin_invoke`         | 调用其他工具    |
| `permission.request`       | `plugin_invoke`         | 请求权限        |

桥接请求在主进程端由 `bridge-enforcement.ts` 进行权限检查，只有用户在审批中同意的能力才允许通过。

### 运行时管理

```bash
# 查看插件运行时状态
synergy plugin runtime status my-plugin

# 重启运行时
synergy plugin runtime restart my-plugin

# 停止运行时
synergy plugin runtime stop my-plugin

# 查看运行时日志
synergy plugin runtime logs my-plugin
```

### 资源限制

系统对 process 模式插件实施以下资源限制（可通过 `runtime.resources` 配置）：

- **并发请求数**: 默认 5 个同时请求
- **请求超时**: 默认 30 秒
- **启动超时**: 默认 10 秒
- **内存上限**: 默认 256 MB（超出后自动终止）
- **日志速率**: 每分钟 10 KB（超出后丢弃）
- **心跳监控**: 在心跳间隔 \* 最多连续丢失次数 后视为不健康并终止

---

## 6. 权限与审批

### 审批流程

```
插件安装/更新请求
        │
        ▼
解析 manifest → 计算能力集 (capabilities)
        │
        ▼
检查签名 → 决定信任等级 (trust)
        │
        ▼
评估策略 (policy)
   ├─ 高风险第三方 + deny策略 → 拒绝
   ├─ 内置插件 + autoApprove → 自动通过
   ├─ 无签名第三方 + requireSignature → 拒绝
   ├─ 无签名本地 → 需要审批
   └─ 默认 → 需要审批
        │
        ▼
需要审批？ ──是──→ 显示权限差异 → 用户审批 → 写入 approval store
        │                                └── 拒绝则安装中止
        └──否──→ 写入 approval store（自动批准）
```

### 权限差异报告

当插件更新时，系统会对比新旧版本的能力集，生成 `PluginPermissionDiff`：

```json
{
  "pluginId": "my-plugin",
  "fromVersion": "1.0.0",
  "toVersion": "2.0.0",
  "riskBefore": "low",
  "riskAfter": "medium",
  "added": [
    {
      "key": "filesystem:read",
      "category": "files",
      "severity": "medium",
      "title": "读取工作区文件",
      "description": "可以读取工作区中的文件和目录。"
    }
  ],
  "removed": [],
  "unchanged": [
    {
      "key": "plugin_invoke",
      "category": "runtime",
      "severity": "low",
      "title": "调用插件运行时",
      "description": "基本插件执行权限。"
    }
  ],
  "changed": [
    {
      "key": "network",
      "before": "low",
      "after": "medium"
    }
  ],
  "requiresApproval": true
}
```

### 政策配置

管理员可以通过 `pluginApprovalPolicy` 配置审批策略：

```jsonc
{
  "pluginApprovalPolicy": {
    "denyHighRiskThirdParty": true, // 拒绝高风险第三方
    "autoApproveBuiltin": true, // 自动批准内置插件
    "requireSignatureForMarketplace": true, // 要求市场插件有签名
    "allowUnsignedLocal": true, // 允许未签名本地插件
  },
}
```

### 审计日志

所有审批事件记录在 `~/.synergy/data/plugin-audit.json`：

| 事件类型                    | 说明             |
| --------------------------- | ---------------- |
| `install_requested`         | 安装请求发起     |
| `install_approved`          | 安装已批准       |
| `install_blocked`           | 安装被阻止       |
| `update_requested`          | 更新请求发起     |
| `update_approved`           | 更新已批准       |
| `update_blocked`            | 更新被阻止       |
| `update_failed_rolled_back` | 更新失败并回滚   |
| `capability_denied`         | 运行时能力被拒绝 |
| `runtime_started`           | 运行时启动       |
| `runtime_killed`            | 运行时被终止     |
| `runtime_crashed`           | 运行时崩溃       |

### CLI 命令

```bash
# 查看插件权限
synergy plugin permissions my-plugin

# 查看详细状态（含审批信息）
synergy plugin info my-plugin

# 手动批准
synergy plugin approve my-plugin
```

---

## 7. 前端 UI 贡献

### 入口与加载

前端 UI 贡献声明在 `plugin.json` 的 `contributes.ui` 块中：

```jsonc
"contributes": {
  "ui": {
    "entry": "dist/ui.js",           // 前端 JS 包路径
    "minUIApiVersion": "2.0.0",      // 最低 UI API 版本
    "toolRenderers": [],
    "partRenderers": [],
    "workspacePanels": [],
    "globalPanels": [],
    "settings": [],
    "chatComponents": [],
    "themes": [],
    "icons": [],
    "routes": [],
    "commands": []
  }
}
```

### 信任等级

前端代码执行方式由插件的信任等级决定：

| 等级 | 名称                          | 执行方式                                                         | 权限标记                             |
| ---- | ----------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| 1    | **声明式 (Declarative)**      | 不执行前端代码 — UI 清单仅用于声明                               | （默认）                             |
| 2    | **受信导入 (Trusted Import)** | JS Bundle 通过 `import()` 直接加载到网页主进程中，可调用宿主 API | `permissions.ui.trustedImport: true` |
| 3    | **沙箱 Iframe (Sandbox)**     | UI 在隔离的 iframe 中运行，通过 `postMessage` 与宿主通信         | `permissions.ui.sandboxIframe: true` |

- **第三方插件**（从 npm/git/url 安装）自动归类为沙箱等级
- **本地插件**（`file://` 路径）可以使用受信导入
- 受信导入插件有完整的 DOM 和宿主 API 访问权限，**只应对信任的插件开放**

### 工具渲染器

自定义工具调用结果的展示：

```tsx
// 组件接收的 Props
interface PluginToolRendererProps {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  title?: string
  output?: string
  status?: string
  raw?: string
  charsReceived?: number
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
}
```

```jsonc
// manifest 声明
{
  "tool": "my_tool",
  "exportName": "MyToolRenderer",
  "priority": 50,
  "fallback": {
    "icon": "wand",
    "title": "我的工具",
    "subtitleTemplate": "处理 {{input}}",
  },
}
```

### 工作区/全局面板

```tsx
interface PluginPanelProps {
  pluginId: string
  panelId: string
  scope?: { type: "global" | "project"; id: string; directory: string }
  sessionId?: string
}
```

```jsonc
{
  "id": "my-panel",
  "label": "我的面板",
  "icon": "activity",
  "exportName": "MyPanel",
  "sandbox": false, // 设为 true 则使用沙箱 iframe
  "sandboxEntry": "dist/sandbox/panel.js", // 沙箱 JS 入口（可选）
}
```

### 设置页

```tsx
interface PluginSettingsPanelProps {
  pluginId: string
  config: Record<string, unknown>
  onConfigChange: (values: Record<string, unknown>) => Promise<void>
}
```

可以不写组件，使用 JSON Schema 自动生成表单：

```jsonc
{
  "id": "preferences",
  "label": "插件偏好",
  "icon": "settings",
  "group": "插件设置",
  "formSchema": {
    "type": "object",
    "properties": {
      "theme": {
        "type": "string",
        "enum": ["light", "dark"],
        "default": "light",
      },
    },
  },
}
```

### 主题与图标

```jsonc
"themes": [
  {
    "id": "synthwave",
    "label": "Synthwave",
    "path": "themes/synthwave.css"   // CSS 自定义属性文件
  }
],
"icons": [
  {
    "name": "my-logo",
    "path": "icons/logo.svg"
  }
]
```

### 路由

```jsonc
"routes": [
  {
    "path": "analytics",
    "entry": "pages/analytics.html",
    "label": "分析面板",
    "icon": "bar-chart"
  }
]
```

路径在 Web 客户端中映射为 `/plugin/:pluginId/analytics`。

### 懒加载与降级

- **受信导入**的 UI 组件采用懒加载 — 只有在需要展示时才通过 `import()` 加载。
- **沙箱 Iframe**的 UI 通过专门的沙箱端点加载。
- **Tool Renderer** 提供 `fallback` 字段，在 Bundle 加载完成前显示静态图标和标题。

### 沙箱 Iframe 桥

沙箱 iframe 中的 UI 通过 `postMessage` 与宿主通信：

1. 宿主加载 `GET /api/plugins/:pluginId/sandbox/:panelId` 返回的 HTML shell
2. iframe 加载 `sandboxEntry` 指定的 JS bundle
3. JS bundle 使用 `postMessage` 与宿主通信（配置、事件、数据请求）
4. 宿主通过 `POST /api/plugins/:pluginId/interact` 处理沙箱请求

---

## 8. 工具链命令

Synergy 提供完整的 `synergy plugin` 子命令体系：

### `create`

```bash
synergy plugin create <name> [--template <template>]
```

创建新的插件项目。在指定目录下生成 `plugin.json`、`package.json`、`tsconfig.json`、源码文件和 README。

可用模板：`tool-ui`（默认）、`workspace-panel`、`api-connector`、`theme-icon`

### `dev`

```bash
synergy plugin dev [path] [--sandbox-preview]
```

插件开发模式：

- 验证 manifest 合法性
- 显示权限预览（高风险提示）
- 显示运行时健康状态（模式、PID、内存、心跳）
- 显示日志尾部
- 监控 `src/` 目录变化，自动重载
- `--sandbox-preview` 可输出沙箱面板的预览 URL

### `validate`

```bash
synergy plugin validate [path] [--runtime-discovery]
```

验证插件清单：

- JSON Schema 校验
- ID、版本、名称完整性
- 与当前 Synergy 版本的兼容性
- UI 路径存在性检查（entry、icons、themes、routes）
- tool 声明完整性
- config schema 校验
- `--runtime-discovery` 模式：实际加载插件并比对 manifest 声明与运行时工具注册的一致性

### `build`

```bash
synergy plugin build [path]
```

构建插件：

1. 用 Bun 构建后端（target: bun）
2. 如果声明了 `contributes.ui.entry`，构建前端（target: browser）
3. 输出规范化 manifest（`dist/plugin.normalized.json`）
4. 生成权限摘要（`dist/permissions.summary.json`）
5. 复制 `public/assets/` 到 `dist/assets/`
6. 计算完整性哈希（`dist/integrity.json`）

### `pack`

```bash
synergy plugin pack [path]
```

将构建产物打包为 `.synergy-plugin.tgz` 格式的分发包。输出 `{name}-{version}.synergy-plugin.tgz`。

### `sign`

```bash
synergy plugin sign <tarball>
```

对打包的插件进行 Ed25519 签名：

1. 读取或生成签名密钥对（存储在 `~/.synergy/keys/`）
2. 计算 tarball、manifest、permissions 的哈希
3. 使用私钥签名
4. 输出签名元数据 JSON（可重定向到 `.sig` 文件）

### `add`

```bash
synergy plugin add <spec>
```

安装并激活插件。`spec` 格式：

- `my-plugin` — npm 包名
- `my-plugin@1.2.3` — 指定版本
- `file:///path/to/plugin` — 本地路径
- `github:user/repo` — GitHub 仓库

安装过程会进行签名验证、策略评估、权限审批请求。

### `remove`

```bash
synergy plugin remove <id> [--force]
```

卸载插件并清理配置。

### `update`

```bash
synergy plugin update [id] [--auto-approve]
```

更新插件到最新版本。无参数时更新所有已安装插件：

- 解析新版本的 manifest
- 计算权限差异
- 需要用户审批（除非 `--auto-approve`）
- 更新失败时自动回滚 lockfile

### `list`

```bash
synergy plugin list [--verbose] [--json]
```

列出已安装的插件和加载状态。

### `search`

```bash
synergy plugin search <query>
```

搜索 npm 注册表中的 Synergy 插件（自动加上 `synergy-plugin` 关键字）。

### `info`

```bash
synergy plugin info <plugin>
```

显示插件的详细状态和元数据，包括信任等级、风险、完整性验证状态、工具、UI 贡献、运行时信息和审批记录。

### `permissions`

```bash
synergy plugin permissions <plugin>
```

以用户语言格式显示插件的已解析权限和风险等级。

### `approve`

```bash
synergy plugin approve <plugin>
```

批准插件的审批请求（安装或更新后需要手动批准时使用）。

### `runtime`

```bash
synergy plugin runtime status <plugin>    # 运行时状态
synergy plugin runtime restart <plugin>   # 重启运行时
synergy plugin runtime stop <plugin>      # 停止运行时
synergy plugin runtime logs <plugin>      # 查看运行时日志
```

### `hooks`

```bash
synergy plugin hooks [--json] [--category <category>]
```

列出所有支持的插件钩子及说明。

### `publish`

```bash
synergy plugin publish <tarball>
```

将插件包发布到注册表。

### `test`

```bash
synergy plugin test [path]
```

运行插件目录下的测试文件（`test/*.test.ts`）。

---

## 9. 市场与分发

### 注册表 API 概念

Synergy 插件可以通过注册表进行分发。目前注册表 API 是本地模式（`http://localhost:3000`），支持以下操作：

| 端点                        | 方法 | 说明       |
| --------------------------- | ---- | ---------- |
| `/plugins/publish`          | POST | 发布新版本 |
| `/plugins/search?q=<query>` | GET  | 搜索插件   |

### 包签名与完整性

插件包签名提供以下保证：

1. **来源验证** — 使用 Ed25519 密钥对签名，公钥可验证发布者身份
2. **完整性校验** — 签名包含了 tarball、manifest 和 permissions 的哈希
3. **防篡改** — 安装时验证签名，任何修改都会导致验证失败

签名流程：

```bash
# 生成密钥对并签名
synergy plugin sign my-plugin-1.0.0.synergy-plugin.tgz > my-plugin-1.0.0.synergy-plugin.tgz.sig

# 安装时自动验证签名
synergy plugin add my-plugin
```

签名元数据格式（`.sig` 文件）：

```json
{
  "signatureVersion": 1,
  "pluginId": "my-plugin",
  "version": "1.0.0",
  "algorithm": "ed25519",
  "signer": "<公钥 hex>",
  "signature": "<签名 hex>",
  "signedAt": 1700000000000,
  "payload": {
    "tarballHash": "sha256-...",
    "manifestHash": "sha256-...",
    "permissionsHash": "sha256-..."
  }
}
```

### 发布/搜索/安装/更新流程

**发布者**：

1. `synergy plugin build` — 构建
2. `synergy plugin pack` — 打包为 tgz
3. `synergy plugin sign <tgz>` — 签名
4. `synergy plugin publish <tgz>` — 发布

**消费者**：

1. `synergy plugin search <query>` — 搜索
2. `synergy plugin add <name>` — 安装
3. `synergy plugin update` — 更新所有
4. `synergy plugin update <id>` — 更新指定

### Lockfile

安装信息存储在 `~/.synergy/plugin.lock` 中，包含：

```json
{
  "version": 1,
  "plugins": {
    "my-plugin": {
      "spec": "my-plugin@1.0.0",
      "version": "1.0.0",
      "resolved": "...",
      "integrity": "sha256-...",
      "permissionsHash": "sha256-...",
      "manifestHash": "sha256-...",
      "signature": {
        "algorithm": "ed25519",
        "signature": "...",
        "signer": "..."
      },
      "runtimeMode": "process"
    }
  }
}
```

### 回滚行为

当插件更新失败时，系统自动：

1. 保留旧的 lockfile 条目
2. 重新安装旧版本
3. 记录 `update_failed_rolled_back` 审计事件
4. 使用 `synergy plugin info` 可查看是否有未成功的更新尝试

### Verified Badge

插件如果通过了签名验证，会在状态显示中标记 `verified`。未来版本将通过注册表 API 支持 `verified` 和 `official` 徽章。

---

## 10. 测试与验证

### Manifest 验证

```bash
synergy plugin validate .
```

执行以下检查：

- ✅ Manifest JSON Schema 校验
- ✅ ID 格式（字母开头，允许连字符和数字）
- ✅ 与 Synergy 版本兼容性检查
- ✅ 引擎版本检查（Bun 版本）
- ✅ 工具声明时必需的权限声明
- ✅ UI 入口文件存在性
- ✅ 导出名称与源文件匹配
- ✅ 图标/主题/路由文件存在性
- ✅ 工具能力声明完整性
- ✅ Config Schema 合法性
- ✅ 运行时策略合规性

### 运行时发现验证

```bash
synergy plugin validate . --runtime-discovery
```

这会**实际加载**插件的编译产物的模块，调用 `init()`，然后比对：

- Manifest 中声明的工具与实际注册的工具是否一致
- 标记**未声明**的工具（在运行时注册但不在 manifest → 错误）
- 标记**声明但缺失**的工具（在 manifest 中但未在运行时注册 → 警告）

### 编写插件测试

```bash
synergy plugin test .
```

在插件目录的 `test/` 目录下编写标准 Bun 测试：

```typescript
// test/my-plugin.test.ts
import { describe, it, expect } from "bun:test"
import { myPlugin } from "../src/index"

describe("my-plugin", () => {
  it("should export PluginDescriptor", () => {
    expect(myPlugin.id).toBe("my-plugin")
    expect(typeof myPlugin.init).toBe("function")
  })

  it("should return hooks on init", async () => {
    // 使用最小化的 PluginInput
    const hooks = await myPlugin.init({
      client: {} as any,
      scope: { type: "global", id: "test", directory: "/tmp", worktree: "/tmp" },
      directory: "/tmp",
      worktree: "/tmp",
      serverUrl: new URL("http://localhost"),
      $: null as any,
      pluginDir: process.cwd(),
      config: {
        get: async () => ({}),
        set: async () => {},
      },
      auth: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        has: async () => false,
      },
      cache: {
        directory: "/tmp/.cache",
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      },
    })

    expect(hooks.tool).toBeDefined()
  })
})
```

### UI 渲染器测试

前端 UI 组件使用 Solid.js 编写，可以使用标准 Solid Testing Library 测试。

### 安全检查清单

发布前检查：

- [ ] **最小权限原则** — 只声明插件真正需要的权限，不声明 `shell: true` 除非绝对必要
- [ ] **`capabilities` 声明** — 每个 `contributes.tools[]` 都声明了所需的工具级权限
- [ ] **$（Bun Shell）使用** — 只在必要时使用 shell，优先使用原生 JS API
- [ ] **运行时模式** — 需要高隔离性时使用 `process` 模式并配置资源限制
- [ ] **UI 降级** — 为工具渲染器提供 `fallback`，在 Bundle 未加载时也有可用的 UI
- [ ] **权限描述** — manifest 中的描述清晰准确，便于用户审批时理解
- [ ] **凭证安全** — 敏感信息使用 `input.auth` 存储，不要硬编码
- [ ] **输入验证** — 工具参数使用 Zod schema 验证
- [ ] **消毒建议** — 使用 input.$（Bun Shell）执行命令时构建 clean 的 shell 表达式
- [ ] **日志简洁** — 不要输出大量日志，尊重日志速率限制

---

## 11. 端到端示例

### `send_meme` 插件

一个能从网络上获取表情包并在聊天中展示的插件。

### 目录结构

```
send-meme-plugin/
├── plugin.json
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts     # PluginDescriptor
│   ├── tools.ts     # send_meme tool
│   └── ui.tsx       # 前端工具渲染器（Solid.js）
└── icons/
    └── meme.svg     # 图标
```

### plugin.json

```jsonc
{
  "name": "send-meme",
  "version": "1.0.0",
  "description": "从网络获取并展示表情包",
  "author": "Plugin Dev",
  "keywords": ["synergy-plugin", "meme", "fun"],

  "minSynergyVersion": "4.1.0",

  "permissions": {
    "tools": {
      "invoke": true,
      "network": true,
    },
    "network": {
      "connectDomains": ["api.memegen.link", "img.memegen.link"],
    },
    "ui": {
      "toolRenderers": true,
      "trustedImport": true,
    },
  },

  "contributes": {
    "tools": [
      {
        "name": "send_meme",
        "title": "Send Meme",
        "description": "生成一个自定义表情包图片并返回图片链接。参数：template（模板名），top（顶部文字），bottom（底部文字）",
        "icon": "image",
        "capabilities": {
          "network": true,
        },
        "risk": "low",
      },
    ],
    "ui": {
      "entry": "dist/ui/index.js",
      "toolRenderers": [
        {
          "tool": "send_meme",
          "exportName": "MemeRenderer",
          "priority": 50,
          "fallback": {
            "icon": "image",
            "title": "表情包",
            "subtitleTemplate": "发送中...",
          },
        },
      ],
    },
  },

  "runtime": {
    "mode": "in-process",
  },
}
```

### src/index.ts

```typescript
import type { PluginDescriptor } from "@ericsanchezok/synergy-plugin"
import { send_meme } from "./tools"

export const SendMemePlugin: PluginDescriptor = {
  id: "send-meme",
  name: "Send Meme Plugin",
  async init(input) {
    return {
      tool: { send_meme },
    }
  },
}

export default SendMemePlugin
```

### src/tools.ts

```typescript
import { tool } from "@ericsanchezok/synergy-plugin"

const TEMPLATES = [
  "drake", // Drake 点赞/不点赞
  "disastergirl", // 灾难女孩
  "doge", // 狗
  "buzz", // Buzz Lightyear 满墙都是
  "monkey", // 猴子分心
] as const

export const send_meme = tool({
  description: "生成一个自定义表情包图片。支持模板: " + TEMPLATES.join(", "),
  args: {
    template: tool.schema.string().describe(`表情包模板名称，可选: ${TEMPLATES.join(", ")}`),
    top: tool.schema.string().optional().default("").describe("顶部文字（支持 URL 编码）"),
    bottom: tool.schema.string().optional().default("").describe("底部文字（支持 URL 编码）"),
  },
  async execute(args, context) {
    const template = args.template.toLowerCase()
    if (!TEMPLATES.includes(template as any)) {
      return `不支持的模板 "${args.template}"。可用: ${TEMPLATES.join(", ")}`
    }

    const topText = encodeURIComponent(args.top || "_")
    const bottomText = encodeURIComponent(args.bottom || "_")
    const imageUrl = `https://api.memegen.link/images/${template}/${topText}/${bottomText}.png`

    return {
      title: `${args.template} memes`,
      output: imageUrl,
    }
  },
})
```

### src/ui.tsx

```tsx
import type { Component } from "solid-js"

interface MemeRendererProps {
  tool: string
  output?: string
  metadata?: Record<string, unknown>
  status?: string
}

const MemeRenderer: Component<MemeRendererProps> = (props) => {
  const imageUrl = () => props.output || ""

  return (
    <div style={{ padding: "8px", "text-align": "center" }}>
      {imageUrl() ? (
        <img
          src={imageUrl()}
          alt="表情包"
          style={{
            "max-width": "100%",
            "max-height": "400px",
            "border-radius": "8px",
            "box-shadow": "0 2px 8px rgba(0,0,0,0.15)",
          }}
        />
      ) : (
        <span>正在生成表情包...</span>
      )}
    </div>
  )
}

export default MemeRenderer
```

### 开发与安装

```bash
# 进入插件目录
cd send-meme-plugin

# 安装依赖
bun install

# 构建
bun run build   # tsc 编译 TS → JS
synergy plugin build  # 构建分发产物

# 本地安装
synergy plugin add file:///path/to/send-meme-plugin
```

## 12. 最佳实践

### 最小权限原则

只声明插件真正需要的权限。例如，一个只读 API 的工具不需要 `shell: true` 或 `filesystem: write`：

```jsonc
// ✅ 好的：声明实际需要的最小权限
"permissions": {
  "tools": {
    "network": true
  },
  "network": {
    "connectDomains": ["api.example.com"]
  }
}

// ❌ 不好的：过度声明权限
"permissions": {
  "tools": {
    "shell": true,
    "filesystem": "write",
    "network": true
  }
}
```

### 避免使用 shell 除非绝对必要

优先使用原生 JS API：

```typescript
// ✅ 好的：使用原生 fetch
const res = await fetch("https://api.example.com/data")
const data = await res.json()

// ❌ 不好的：用 shell 调用 curl
const result = await input.$`curl -s https://api.example.com/data`
```

仅在确实需要 shell 能力时（如调用系统工具、编译等）才使用 `input.$`。声明 `shell: true` 会将插件风险等级提升为 **高**，用户审批门槛大大提高。

### 第三方/高风险插件使用 process 模式

```jsonc
// ✅ 好的：高风险插件明确声明 process 模式
"runtime": {
  "mode": "process",
  "resources": {
    "memoryMb": 256,
    "startupTimeoutMs": 15000,
    "requestTimeoutMs": 30000
  }
}

// ❌ 不好的：高风险插件未声明模式，依赖系统默认
// 第三方插件默认会被自动分配 process 模式，
// 但明确声明更有利于用户理解和审批
```

### 保持 UI 降级有用

Tool renderer 的 `fallback` 在 JS Bundle 加载完成前展示。确保其有用：

```jsonc
// ✅ 好的：描述性的降级信息
"fallback": {
  "icon": "search",
  "title": "网络搜索",
  "subtitleTemplate": "搜索: {{query}}"
}

// ❌ 不好的：空的降级信息
"fallback": {}
```

### 编写审批友好的权限描述

权限描述会展示在用户的审批对话框中。清晰准确的描述有助于用户理解和同意：

```jsonc
// ✅ 好的：清晰描述
"description": "从 Meme Generation API 获取自定义表情包图片。需要访问 api.memegen.link 生成图片。",

// ❌ 不好的：模糊描述
"description": "The meme plugin.",
```

### 保持运行时日志简洁

日志速率有限制（默认每分钟 10 KB），过量的日志会被丢弃。仅在必要时记录：

```typescript
// ✅ 好的：关键事件日志
console.info("[my-plugin] config updated")

// ❌ 不好的：逐行日志
for (const item of items) {
  console.debug("[my-plugin] processing item", item.id)
}
```

### 各能力的风险评估

| 能力                    | 风险等级 | 说明                     |
| ----------------------- | -------- | ------------------------ |
| `shell`                 | 🔴 高    | 可以在系统上执行任意命令 |
| `filesystem:write`      | 🔴 高    | 可以创建/修改/删除文件   |
| `secrets`               | 🔴 高    | 可以读取存储的凭据       |
| `hooks.promptTransform` | 🔴 高    | 可以改写 LLM 提示词      |
| `network`（无域名限制） | 🔴 高    | 可以访问任意网络 URL     |
| `filesystem:read`       | 🟡 中    | 可以读取工作区文件       |
| `session_data`          | 🟡 中    | 可以读取会话消息         |
| `config:write`          | 🟡 中    | 可以修改全局配置         |
| `network`（有域名限制） | 🟡 中    | 可以访问指定域名         |
| `mcp:invoke`            | 🟡 中    | 可以调用 MCP 工具        |
| `mcp:spawn`             | 🟡 中    | 可以启动 MCP 进程        |
| `config:read`           | 🟢 低    | 可以读取配置             |
| `workspace_data`        | 🟢 低    | 可以读取工作区元数据     |
| `plugin_invoke`         | 🟢 低    | 基本插件执行             |
| UI 贡献                 | 🟢 低    | UI 渲染相关              |
| `toolExecute: "own"`    | 🟢 低    | 拦截自己的工具           |
| `events: "selected"`    | 🟢 低    | 观察选中事件             |

### 兼容性检查清单

- [ ] `minSynergyVersion` 设为你测试过的最新版本
- [ ] 工具名称使用蛇形命名法（`snake_case`），LLM 更容易正确调用
- [ ] 不要假设插件运行在 `in-process` 模式 — 使用 `input.$` 或 `input.config` 等注入的对象
- [ ] 工具返回结构化 `ToolResult`（含 `metadata`）而非纯字符串，便于前端渲染器使用
- [ ] 在 `contributes.tools[].capabilities` 中声明工具级权限，帮助系统精确评估风险
- [ ] 测试插件在隔离模式（`--runtime-mode process`）下正常工作
- [ ] 插件 ID 只使用小写字母、数字和连字符
