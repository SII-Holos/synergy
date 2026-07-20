import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { catalogTranslations, changedCatalogPaths, missingTranslationIds } from "./i18n-check"

describe("i18n catalog drift check", () => {
  test("reports changed, added, and removed catalogs in stable order", () => {
    const before = new Map([
      ["zh-CN/messages.po", "old translation"],
      ["en/messages.po", "source"],
      ["obsolete/messages.po", "obsolete"],
    ])
    const after = new Map([
      ["en/messages.po", "updated source"],
      ["zh-CN/messages.po", "old translation"],
      ["new/messages.po", "new"],
    ])

    expect(changedCatalogPaths(before, after)).toEqual(["en/messages.po", "new/messages.po", "obsolete/messages.po"])
  })

  test("accepts deterministic extraction output", () => {
    const catalogs = new Map([
      ["en/messages.po", "source"],
      ["zh-CN/messages.po", "translation"],
    ])

    expect(changedCatalogPaths(catalogs, new Map(catalogs))).toEqual([])
  })
})

describe("i18n translation completeness", () => {
  test("reports missing and blank translations while ignoring the PO header", () => {
    const source = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"

msgid "app.complete"
msgstr "Complete"

msgid "app.blank"
msgstr "Blank"

msgid "app.missing"
msgstr "Missing"
`
    const target = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"

msgid "app.complete"
msgstr "完整"

msgid "app.blank"
msgstr ""
`

    expect(missingTranslationIds(source, target)).toEqual(["app.blank", "app.missing"])
  })

  test("keeps the English source catalog complete", async () => {
    const source = await readFile(new URL("../src/locales/en/messages.po", import.meta.url), "utf-8")

    expect(missingTranslationIds(source, source)).toEqual([])
  })

  test("uses consistent user-facing product language in Simplified Chinese", async () => {
    const chinese = await readFile(new URL("../src/locales/zh-CN/messages.po", import.meta.url), "utf-8")
    const translations = catalogTranslations(chinese)

    expect(translations.get("app.plugin.builtin.library")).toBe("知识库")
    expect(translations.get("app.shell.mobile.tool.library")).toBe("知识库")
    expect(translations.get("prompt.ws.home")).toBe("全局空间")
    expect(translations.get("prompt.ws.mainCheckout")).toBe("主工作区")
    expect(translations.get("prompt.toolbar.worktree")).toBe("隔离工作区")
    expect(translations.get("prompt.toolbar.worktreeDesc")).toBe("为当前会话创建独立工作区")
    expect(translations.get("session.permission.mode.guarded")).toBe("受控")
    expect(translations.get("session.permission.mode.autonomous")).toBe("无人值守")
    expect(translations.get("session.permission.mode.autonomous.short")).toBe("无人值守")
    expect(translations.get("session.permission.mode.fullAccess")).toBe("全权限")
    expect(translations.get("session.permission.mode.fullAccess.short")).toBe("全权限")
    expect(translations.get("settings.controlProfile.autonomous.label")).toBe("无人值守")
    expect(translations.get("settings.controlProfile.fullAccess.label")).toBe("全权限")
    expect(translations.get("settings.catalog.controlProfile.searchTerms")).toBe("权限模式 | 受控 | 无人值守 | 全权限")
    expect(translations.get("settings.permissions.page.desc")).toBe("默认权限模式和智能放行策略。")
    expect(translations.get("settings.library.learning.page.title")).toBe("学习")
    expect(translations.get("settings.library.learning.capture.title")).toBe("自动整理")
    expect(translations.get("settings.library.learning.autonomyRow.title")).toBe("后台反思与规划")
    expect(translations.get("settings.library.memory.recall.title")).toBe("使用记忆")
    expect(translations.get("settings.library.memoryCount.full")).toBe("最多")
    expect(translations.get("settings.modelRole.fallbackChain")).toBe("备用顺序")
    expect(translations.get("settings.modelRole.resolution")).toBe("实际使用")
    expect(translations.get("app.note.blueprint.status.waiting")).toBe("等待你回复")
    expect(translations.get("app.context.breakdown.title")).toBe("上下文占用分布")
    expect(translations.get("app.context.breakdown.exactInputShare")).toBe("占实际输入的 {percent}")
    expect(translations.get("app.context.details.contextUsage")).toBe("上下文占用")
    expect(translations.get("app.context.details.contextWindow")).toBe("上下文上限")
    expect(translations.get("app.context.details.remainingInput")).toBe("剩余空间")
    expect(translations.get("app.context.developer.messages")).toBe("消息总数")
    expect(translations.get("app.context.developer.estimatorKind")).toBe("估算方式")
    expect(translations.get("app.context.developer.estimatorEncoding")).toBe("分词编码")
    expect(translations.get("app.context.developer.reconciliationMode")).toBe("校准方式")
    expect(translations.get("app.context.developer.attributedTotal")).toBe("分配后总量")
    expect(translations.get("app.context.usage.usedInput")).toBe("已用上下文")
    expect(translations.get("app.context.status.warning")).toBe("上下文空间即将不足")
    expect(translations.get("app.context.status.critical")).toBe("上下文空间几乎用尽")
    expect(translations.get("app.lattice.config.title")).toBe("设置 Lattice")
    expect(translations.get("app.lattice.config.mode")).toBe("运行方式")
    expect(translations.get("app.lattice.config.mode.auto")).toBe("自主推进")
    expect(translations.get("app.lattice.config.mode.collaborative")).toBe("与你协作")
    expect(translations.get("app.lattice.config.budget")).toBe("模型调用预算")
    expect(translations.get("app.lattice.config.budgetDescription")).toBe(
      "Lattice 在继续推进前检查预算；计入当前 Lattice 会话的模型调用，而不是 Pathway 步骤。0 表示不设置预算。",
    )
    expect(translations.get("app.lattice.config.stepsCompleted")).toBe("已完成 {done}/{total} 个步骤")
    expect(translations.get("app.lattice.config.modelCalls")).toBe("模型调用次数")
    expect(translations.get("app.lattice.panel.calls")).toBe("模型调用")

    const toolActionTitles = new Map([
      ["classifier.label.shell", "执行命令"],
      ["classifier.label.web", "访问网页"],
      ["classifier.label.browser", "操作浏览器"],
      ["classifier.label.memory", "管理记忆"],
      ["classifier.label.note", "管理笔记"],
      ["classifier.label.blueprint", "管理 Blueprint"],
      ["classifier.label.task", "执行任务"],
      ["classifier.label.dag", "管理 DAG"],
      ["classifier.label.schedule", "管理日程"],
      ["classifier.label.session", "管理会话"],
      ["classifier.label.session-control", "控制会话"],
      ["classifier.label.community", "访问 Agora"],
      ["classifier.label.network", "管理连接"],
      ["classifier.label.communication", "发送内容"],
      ["classifier.label.config", "更改设置"],
      ["classifier.label.skill", "使用技能"],
      ["classifier.label.research", "开展研究"],
      ["classifier.label.generic", "调用工具"],
      ["browser.title.action", "操作页面"],
      ["browser.title.assets", "查看页面资源"],
      ["browser.title.audit", "审查页面"],
      ["browser.title.browser-view", "查看浏览器"],
      ["browser.title.clipboard", "读写剪贴板"],
      ["browser.title.console", "查看控制台"],
      ["browser.title.dialog", "处理网页对话框"],
      ["browser.title.downloads", "查看下载任务"],
      ["browser.title.emulate", "模拟设备"],
      ["browser.title.evaluate", "执行网页脚本"],
      ["browser.title.inspect", "检查页面"],
      ["browser.title.navigation", "浏览网页"],
      ["browser.title.network", "查看网络请求"],
      ["browser.title.performance", "分析页面性能"],
      ["browser.title.read", "读取页面"],
      ["browser.title.screenshot", "截取页面"],
      ["browser.title.snapshot", "获取页面快照"],
      ["browser.title.upload", "上传文件"],
      ["browser.title.wait", "等待页面"],
      ["anysearch.title.search", "使用 Anysearch 搜索"],
      ["anysearch.title.batch-search", "使用 Anysearch 批量搜索"],
      ["anysearch.title.extract", "使用 Anysearch 提取内容"],
      ["anysearch.title.domains", "查看搜索域"],
      ["message-part.part-render-error", "无法显示此内容："],
      ["message-part.search-early-stop", "搜索已提前结束"],
      ["message-part.search-reflection", "搜索过程"],
      ["tool.title.agenda", "查看日程"],
      ["tool.title.agenda-logs", "查看日程记录"],
      ["tool.title.arxiv-download", "下载 arXiv 论文"],
      ["tool.title.arxiv-search", "搜索 arXiv"],
      ["tool.title.ast-search", "搜索 AST"],
      ["tool.title.attach", "添加附件"],
      ["tool.title.availability", "查看可用资源"],
      ["tool.title.batch", "批量执行"],
      ["tool.title.blueprint-search", "搜索 Blueprint"],
      ["tool.title.blueprints", "查看 Blueprint"],
      ["tool.title.claim", "管理研究论点"],
      ["tool.title.control-session", "管理会话"],
      ["tool.title.dag", "更新 DAG"],
      ["tool.title.dag-patch", "更新 DAG"],
      ["tool.title.diagram", "生成图表"],
      ["tool.title.dismiss-question", "取消提问"],
      ["tool.title.edit", "编辑文件"],
      ["tool.title.email-inbox", "查看收件箱"],
      ["tool.title.enter-worktree", "进入隔离工作区"],
      ["tool.title.exhibit", "管理研究图表"],
      ["tool.title.expand-tools", "加载工具"],
      ["tool.title.experiment", "管理实验"],
      ["tool.title.file-search", "搜索文件"],
      ["tool.title.glob", "按 Glob 匹配文件"],
      ["tool.title.gpu-usage", "查看 GPU 用量"],
      ["tool.title.grep", "使用 Grep 搜索"],
      ["tool.title.hpc-usage", "查看 HPC 用量"],
      ["tool.title.idea", "管理研究想法"],
      ["tool.title.image-detail", "查看镜像详情"],
      ["tool.title.inference-detail", "查看推理服务"],
      ["tool.title.job-detail", "查看作业详情"],
      ["tool.title.job-logs", "查看作业日志"],
      ["tool.title.job-metrics", "查看作业指标"],
      ["tool.title.jobs", "查看作业"],
      ["tool.title.leave-worktree", "退出隔离工作区"],
      ["tool.title.list", "列出目录内容"],
      ["tool.title.look-at", "分析文件"],
      ["tool.title.lsp", "查询代码信息"],
      ["tool.title.memory-get", "读取记忆"],
      ["tool.title.model-detail", "查看模型详情"],
      ["tool.title.models", "查看模型"],
      ["tool.title.notebooks", "查看笔记本"],
      ["tool.title.notes", "查看笔记"],
      ["tool.title.paper", "管理研究论文"],
      ["tool.title.patch", "应用补丁"],
      ["tool.title.plan", "管理研究计划"],
      ["tool.title.platform-status", "查看平台状态"],
      ["tool.title.process", "管理进程"],
      ["tool.title.profile", "查看个人资料"],
      ["tool.title.questions", "向你提问"],
      ["tool.title.read", "读取文件"],
      ["tool.title.read-blueprint", "读取 Blueprint"],
      ["tool.title.research-state", "管理研究状态"],
      ["tool.title.runtime-reload", "重新加载运行环境"],
      ["tool.title.scopes", "查看 Scope"],
      ["tool.title.session-status", "查看会话状态"],
      ["tool.title.sessions", "查看会话"],
      ["tool.title.shell", "执行命令"],
      ["tool.title.skill", "使用技能"],
      ["tool.title.status-catalog", "查看状态列表"],
      ["tool.title.submission", "管理研究投稿"],
      ["tool.title.task", "调用子智能体"],
      ["tool.title.task-cancel", "取消任务"],
      ["tool.title.task-list", "查看任务"],
      ["tool.title.task-output", "查看任务结果"],
      ["tool.title.timeline", "管理研究进展"],
      ["tool.title.to-dos", "更新待办"],
      ["tool.title.tracked-jobs", "查看跟踪作业"],
      ["tool.title.trigger-agenda", "立即执行日程"],
      ["tool.title.watch", "监控日程"],
      ["tool.title.web-search", "搜索网页"],
      ["tool.title.webfetch", "读取网页"],
      ["tool.title.wiki", "管理研究资料"],
      ["tool.title.workspaces", "查看工作区"],
      ["tool.title.worktrees", "查看隔离工作区"],
      ["tool.title.write", "写入文件"],
      ["tool.title.write-blueprint", "写入 Blueprint"],
      ["tool.misc.cascaded", "已同步更新"],
      ["tool.misc.changed-fields", "变更字段"],
      ["tool.misc.live-applied", "已立即生效"],
      ["ui.anchoredTool.currentScope", "当前 Scope"],
      ["ui.anchoredTool.recovery.safelyMapped", "已根据当前文件重新定位"],
      ["ui.anchoredTool.summary.pattern", "匹配模式"],
      [
        "ui.anchoredTool.conflictResolutionHint",
        "{count} 个文件或区域{pluralSuffix}需要先解决冲突，才能进行精确编辑。",
      ],
    ])

    for (const [id, title] of toolActionTitles) expect(translations.get(id)).toBe(title)

    const agentRoleNames = new Map([
      ["app.agent.role.advisor", "技术顾问"],
      ["app.agent.role.apiCompatibilityReviewer", "API 兼容性审查员"],
      ["app.agent.role.apiContractDesigner", "API 契约设计师"],
      ["app.agent.role.codeCartographer", "代码结构分析师"],
      ["app.agent.role.dependencyTracer", "依赖关系分析师"],
      ["app.agent.role.developer", "软件开发工程师"],
      ["app.agent.role.docsResearcher", "文档调研员"],
      ["app.agent.role.documentationEngineer", "技术文档工程师"],
      ["app.agent.role.documentationReviewer", "文档审查员"],
      ["app.agent.role.explore", "探索分析师"],
      ["app.agent.role.fixtureBuilder", "测试数据工程师"],
      ["app.agent.role.implementationEngineer", "功能实现工程师"],
      ["app.agent.role.inspector", "质量检查员"],
      ["app.agent.role.integrationEngineer", "集成工程师"],
      ["app.agent.role.literatureAnalyst", "文献分析师"],
      ["app.agent.role.literatureSearcher", "文献检索员"],
      ["app.agent.role.maintainabilityReviewer", "可维护性审查员"],
      ["app.agent.role.memoryCurator", "记忆整理员"],
      ["app.agent.role.migrationArchitect", "迁移架构师"],
      ["app.agent.role.noteLibrarian", "笔记管理员"],
      ["app.agent.role.performanceReviewer", "性能审查员"],
      ["app.agent.role.propertyTestEngineer", "属性测试工程师"],
      ["app.agent.role.pythonQualityEngineer", "Python 质量工程师"],
      ["app.agent.role.qualityGatekeeper", "质量把关员"],
      ["app.agent.role.refactoringEngineer", "重构工程师"],
      ["app.agent.role.requirementsEngineer", "需求分析师"],
      ["app.agent.role.researchMethodologist", "研究方法专家"],
      ["app.agent.role.researchScout", "前沿调研员"],
      ["app.agent.role.rustQualityEngineer", "Rust 质量工程师"],
      ["app.agent.role.scholar", "学术研究员"],
      ["app.agent.role.scout", "信息调研员"],
      ["app.agent.role.scribe", "内容记录员"],
      ["app.agent.role.securityReviewer", "安全审查员"],
      ["app.agent.role.sessionHistorian", "会话档案员"],
      ["app.agent.role.solutionArchitect", "解决方案架构师"],
      ["app.agent.role.supervisor", "任务监督员"],
      ["app.agent.role.testStrategist", "测试策略师"],
      ["app.agent.role.typescriptQualityEngineer", "TypeScript 质量工程师"],
      ["app.agent.role.typeTestEngineer", "类型测试工程师"],
    ])

    for (const [id, roleName] of agentRoleNames) expect(translations.get(id)).toBe(roleName)
  })
})
