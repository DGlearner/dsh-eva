# Company DSH

公司 DSH 协作平台 Monorepo。架构与范围见 `dsh二开融合设计.md`，并发开发规则见
`三Worktree并发开发启动基线.md`。

三个长期开发槽：

- `feat/core-platform`
- `feat/company-web`
- `feat/business-services`

真实 RAG 的管理页面/API 适配仍是后续工作；Runner 到现有 Streamable HTTP MCP 的每用户
PAT 调联已经实现。当前已用 `wdl` 验证身份握手，生产启用前仍需完成双用户 ACL、检索引用、
超时恢复和 PAT 撤销验收。
