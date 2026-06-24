# Synergy 插件文档

## 开发者指南

| 文档                                         | 说明                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[developer-guide.md](developer-guide.md)** | 综合开发者指南。从概念到实践，覆盖所有 12 章：概述、快速开始、Manifest、后端代码、运行时隔离、权限审批、前端 UI、工具链、市场分发、测试验证、端到端示例、最佳实践。**新开发者从这里开始**。 |

## 参考文档

| 文档                                                           | 说明                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [01-platform-overview.md](01-platform-overview.md)             | 平台概述：插件能力、信任层级、安装方式、Manifest 概览                     |
| [02-manifest-reference.md](02-manifest-reference.md)           | `contributes.ui` 完整参考：工具渲染器、面板、设置、主题、图标、路由、命令 |
| [03-trust-tiers.md](03-trust-tiers.md)                         | 信任层级详解：声明式、受信导入、沙箱 iframe                               |
| [04-tool-renderer-guide.md](04-tool-renderer-guide.md)         | 工具渲染器开发指南                                                        |
| [05-workspace-panels.md](05-workspace-panels.md)               | 工作区面板开发指南                                                        |
| [06-settings-themes-icons.md](06-settings-themes-icons.md)     | 设置页、主题、图标贡献指南                                                |
| [07-sandbox-guide.md](07-sandbox-guide.md)                     | 沙箱 Iframe 开发指南                                                      |
| [08-migration-guide.md](08-migration-guide.md)                 | 迁移指南（从旧版本迁移）                                                  |
| [09-security-best-practices.md](09-security-best-practices.md) | 安全最佳实践                                                              |

## 架构文档集

| 文档                               | 说明                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `../plugin/runtime-isolation.md`   | 运行时隔离架构：in-process / worker / process 三种模式、桥接协议、资源限制 |
| `../plugin/permissions-consent.md` | 权限与审批架构：能力解析、差异报告、审批存储、审计日志                     |
| `../plugin/toolchain.md`           | 工具链架构：CLI 命令体系、打包签名、发布流程                               |
| `../plugin/marketplace.md`         | 市场与分发架构：注册表 API、签名验证、版本管理                             |

---

> **最近更新**: 2026-06-23 · 开发者指南适配 v4.1 实现
