# 三 Worktree 并发开发启动基线

> 状态：v1.0 冻结基线  
> 日期：2026-08-19  
> 适用设计：`dsh二开融合设计.md` v0.8 及以后  
> 目的：让 `core-platform`、`company-web`、`business-services` 从同一 commit 并行开发，不在分支内重新决定技术栈、接口、数据模型或 fake 语义。

## 1. 启动结论

本文件冻结三 worktree 启动所需的开发决策。创建 worktree 后允许在各自所有权范围内补充实现细节，但以下内容不能由单个 worktree 单方面修改：

- Node、pnpm、TypeScript 和 DSH 锁定版本；
- 服务边界、目录所有权和数据库 schema 所有权；
- `/company-api/v1`、`/internal/v1`、Knowledge Tool v1 的名称和核心字段；
- ID、时间、分页、错误、幂等和乐观锁约定；
- 任务、日报和 fake 知识的状态机；
- 三个 worktree 的首批交付物和集成门禁。

需要修改冻结项时，先从最新主线创建小型 `contract/*` 或 `adr/*` 分支，更新契约、生成类型、迁移和 fixture，合并后三个 worktree 再同步。禁止在功能分支中先改实现、后补契约。

真实 RAG/MCP 网络接入不属于当前三个 worktree 的完成条件。当前只实现本地 `FakeKnowledgeProvider` 和远程 MCP 配置槽位。

### 1.1 设计启动门

以下项目全部满足时，设计状态为 `worktree-ready`：

| 启动输入 | 当前状态 | 权威位置 |
|---|---|---|
| 产品默认值与非目标 | 已冻结 | 本文件第 3 节、主设计第 1/10 节 |
| 技术栈与 DSH 版本 | 已冻结 | 本文件第 2 节 |
| Browser/Internal API | 已冻结并完成 YAML/ref/path 检查 | `packages/contracts/openapi/*.yaml` |
| Knowledge Tool 输入输出 | 已冻结并完成 JSON/ref 检查 | `packages/contracts/schemas/tools/knowledge.v1.schema.json` |
| Platform/Business DB 边界 | 已冻结为 DDL 基线 | `packages/db/baseline/*.sql` |
| Web/MSW/Provider 共用数据 | 已冻结并完成引用完整性检查 | `packages/test-fixtures/fixture-v1.json` |
| 三分支目录所有权 | 已冻结 | 本文件第 4/13/14 节 |
| 每分支验收与合并门 | 已冻结 | 本文件第 13/15 节 |

`worktree-ready` 表示三个分支无需再做跨分支产品/契约决策，不表示代码已经实现。实际执行 `git worktree add` 仍要求先完成第 17 节的一次性 Git/Monorepo bootstrap commit。

## 2. 冻结技术栈

### 2.1 运行时与工程工具

| 类别 | 冻结选择 | 约束 |
|---|---|---|
| Node.js | `22.19.x` | 与锁定 DSH 的 `^22.19.0` 一致；不使用 Node 24 专属 API |
| 包管理器 | `pnpm 11.7.0` | 根 `packageManager` 固定；CI 使用 frozen lockfile |
| TypeScript | `6.0.3` | ESM、`strict: true`、Project References |
| Monorepo | pnpm workspaces | 不引入 Turborepo/Nx；使用 `pnpm --filter` 和根脚本 |
| 格式/静态检查 | Prettier + Oxlint | 根配置由 `core-platform` 所有；禁止各包独立改风格 |
| 单元/集成测试 | Vitest 4 | Node 服务和 React 组件统一使用 Vitest |
| 浏览器 E2E | Playwright | 只在短期 `integration/*` 分支维护跨域 E2E |
| API 描述 | OpenAPI 3.1 | YAML 为浏览器 API 的权威契约 |
| 类型生成 | `openapi-typescript` + `openapi-fetch` | 生成文件禁止手改；CI 检查生成结果无差异 |

锁定 DSH 基线：

```text
repository: https://github.com/deepseek-ai/deepseek-harness
commit: 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
package version: 0.1.0-rc.7
package manager: pnpm 11.7.0
node: ^22.19.0 || >=24.0.0
web: React 18 + Vite 6
tests: Vitest 4
```

### 2.2 Company Web

| 能力 | 冻结选择 |
|---|---|
| UI | React 18、Vite 6、TypeScript |
| 路由 | React Router 7，使用显式 route objects |
| 服务端状态 | TanStack Query 5 |
| 表单/校验 | React Hook Form + Zod |
| 图标 | `lucide-react` |
| 样式 | CSS Variables + CSS Modules；共享 Design Tokens 位于 `packages/ui` |
| 无障碍基础组件 | Radix Primitives，仅按实际控件引入 |
| API Mock | MSW，响应来自 `packages/test-fixtures` |

不引入完整后台模板、主题系统或第二套状态管理框架。全局客户端状态仅保存导航折叠、临时筛选等 UI 状态；服务端数据全部由 TanStack Query 管理。

### 2.3 公司后端

| 能力 | 冻结选择 |
|---|---|
| 语言/运行时 | TypeScript、Node 22、ESM |
| HTTP | Fastify 5 |
| 数据库访问 | Drizzle ORM + `pg` |
| 数据库 | PostgreSQL 16 |
| 临时状态/租约 | Redis 7 + `ioredis` |
| 密码 | Argon2id |
| 日志 | Pino JSON，统一字段见 5.7 |
| Docker Engine | `dockerode`，仅 Runner Manager 使用 |
| 后台周期任务 | 服务内受租约保护的 scheduler；首版不引入独立队列平台 |

为了控制首版部署复杂度，Tasks 和 Daily Reports 是 `business-api` 内的逻辑模块，不分别部署微服务。只有 Runner Manager 因 Docker Engine 权限边界独立进程。

### 2.4 部署与上游引入

- 常驻服务由 Docker Compose 管理：`reverse-proxy`、`company-web`、`control-plane`、`business-api`、`runner-manager`、`postgres`、`redis`。
- 反向代理使用 Nginx，负责同源路由和 WebSocket upgrade；TLS 可由公司现有入口终止，Compose 开发环境只提供 HTTP。
- `vendor/deepseek-harness` 使用 Git submodule 固定到上述 commit，不复制到公司源码目录。
- DSH 保持自己的 pnpm workspace 和 lockfile；公司根 workspace 不包含 `vendor/deepseek-harness/**`。
- DSH 入口补丁保存在 `runtimes/dsh-runner/patches/`，构建镜像时应用；不直接提交 submodule 内改动。
- 公司代码根 lockfile 由 `core-platform` 所有。启动基线应一次性声明三 worktree 已知依赖，减少并行期间 lockfile 冲突。

## 3. 冻结产品默认值

以下选择视为首版已确认，不再作为并行开发阻塞项：

| 产品项 | 首版默认值 |
|---|---|
| 登录 | admin 创建本地账号；用户名 + 至少 8 位密码；无公开注册、SSO、LDAP、MFA、自助找回 |
| 平台角色 | `admin/member` |
| 组织角色 | `manager/member`，部门内唯一关系 |
| 任务拆分 | AI/fake 只生成草稿，主管确认后才能发布和指派 |
| 自动审核 | 生成 `pass/fail/needs_review` 和证据；不自动把任务改为 `done`，主管最终验收 |
| 日报 | 每位员工每个工作日一份；字段为今日完成、下一步计划、阻塞/风险、其他、自由文本 |
| 日报删除 | 软删除；首版无用户恢复入口；同日期重新编辑会复用原记录并新增修订 |
| 日报附件 | 首版不支持，后续扩展 |
| 知识 | 当前开发全部使用 fake；公司三个固定分类，个人知识不分类 |
| 自动化能力 | 并行开发使用 `FakeAutomationProvider`；真实 DSH 自动化适配在 P0 对话链路稳定后接入 |
| 公司时区 | `Asia/Shanghai`；数据库统一存 UTC，`work_date` 按公司时区计算 |
| UI 品牌 | 先实现可替换 Design Tokens 和 Logo Slot；缺少正式 Logo 不阻塞功能开发 |

## 4. 运行模块与目录所有权

```text
company-dsh/
├── apps/company-web/                   # company-web 独占
├── services/
│   ├── control-plane/                  # core-platform 独占
│   ├── runner-manager/                 # core-platform 独占
│   └── business-api/                   # business-services 独占
│       └── src/modules/
│           ├── knowledge/
│           ├── tasks/
│           └── daily-reports/
├── runtimes/dsh-runner/                # core-platform 独占
├── extensions/company-dsh/             # core-platform 独占
├── integrations/rag-mcp/               # business-services 独占；当前只放契约映射/说明
├── packages/
│   ├── contracts/
│   │   ├── openapi/company-api.v1.yaml # bootstrap 冻结；三个 worktree 只读
│   │   ├── openapi/internal-api.v1.yaml# bootstrap 冻结；三个 worktree 只读
│   │   ├── schemas/common/             # bootstrap 冻结；后续 contract 分支修改
│   │   ├── schemas/tools/              # bootstrap 冻结；后续 contract 分支修改
│   │   └── generated/                  # 生成，不手改
│   ├── db/
│   │   ├── baseline/                   # bootstrap 冻结 DDL，三个 worktree 只读
│   │   ├── migrations/platform/        # core-platform 所有
│   │   ├── migrations/business/        # business-services 所有
│   │   └── test-support/               # bootstrap 冻结
│   ├── test-fixtures/                   # business-services 所有；其他 worktree 只读消费
│   ├── ui/                              # company-web 独占
│   └── observability/                   # core-platform 所有
├── deploy/                              # core-platform 独占
├── tests/
│   ├── contract/                        # 各 owner 写本域；跨域只在 integration 分支
│   ├── integration/                     # 各 owner 写本域
│   └── e2e/                             # integration 分支独占
├── docs/                                # 按对应域所有；架构 ADR 用 contract/adr 小分支
└── vendor/deepseek-harness/             # Git submodule；所有 worktree 禁止直接修改
```

`business-api` 是模块化单体。代码依赖方向固定为：

```text
route -> application service -> domain -> repository/provider interface
                                  ^
                      fake / postgres / automation adapter
```

知识 fake、任务自动化 fake 和日报改写 fake 都通过 Provider 接口注入。Route 或 React 组件不得根据 `provider=fake` 分叉业务逻辑。

## 5. Contracts v1 通用约定

### 5.1 URL 与版本

- 浏览器 API：`/company-api/v1/*`。
- 服务间 API：`/internal/v1/*`，浏览器和反向代理公网路由不得暴露。
- DSH 原生 Host API 保留其 `/api`，不得与公司 API 合并。
- v1 内只允许向后兼容新增 optional 字段和新 endpoint；删除、重命名或改变含义需要 v2。

### 5.2 身份与 Cookie

- 登录成功设置随机 opaque Session Cookie `company_session`。
- Cookie 属性：`HttpOnly`、`Secure`（非本地环境）、`SameSite=Lax`、`Path=/`。
- 空闲过期 12 小时，绝对过期 7 天；退出、停用账号和改密撤销现有 Session。
- 所有 mutation 请求要求 `X-CSRF-Token`；值由 `GET /company-api/v1/me` 返回，不能从 Cookie 本身推导。
- 浏览器不能提交可信 `user_id`、`tenant_id`、`department_id` 或角色来覆盖服务端身份。

Browser-facing Business API 仍使用同一个 `company_session` 契约，但部署时所有 `/company-api/v1/*` 请求先经过 Control Plane/Gateway。Gateway 校验 Cookie、CSRF 和账号状态，移除浏览器提供的内部身份 Header，再向 `business-api` 注入短期签名 Actor Token；`business-api` 不直接读取 `platform.web_sessions`，也不接受浏览器直连。

Actor Token 固定使用非 Cookie 的内部 Bearer/JWT，`audience=company-business-api`，有效期不超过 60 秒，至少包含：

```text
issuer, audience, tenant_id, user_id, session_id,
platform_role, department_id|null, org_role|null,
request_id, issued_at, expires_at
```

`business-api` 验证签名、audience、过期时间和 `request_id`，再按资源的 tenant/department/owner 做授权；它绝不根据请求 JSON/query 中的角色或 owner 覆盖 Token 身份。账号停用或组织关系变更由 Control Plane 立即撤销 Web Session，最多只允许已经签发的 60 秒内部 Token 自然过期。开发测试使用固定测试签名密钥注入，不把密钥写进 fixture。

### 5.3 ID、时间与文本

- 资源 ID 为 UUID 字符串，由服务端生成。
- 时间戳为 UTC RFC 3339，例如 `2026-08-19T08:00:00Z`。
- 工作日为 `YYYY-MM-DD`，按 `Asia/Shanghai` 解释。
- 标题最大 200 字符；普通说明字段最大 20,000 字符；服务端和 OpenAPI 同时校验。
- 空字符串在进入 domain 前 trim；可选文本使用 `null`，不使用空字符串表示缺失。

### 5.4 响应、分页与错误

- 单资源成功响应直接返回资源对象，不包 `data`。
- 列表统一返回：

```ts
type Page<T> = {
  items: T[];
  next_cursor: string | null;
};
```

- 默认 `limit=50`，最大 100；cursor 为服务端 opaque 字符串，客户端不得解析。
- 错误统一使用 `application/problem+json`：

```ts
type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  request_id: string;
  field_errors?: Array<{ field: string; code: string; message: string }>;
};
```

- 预期状态码：`400` 参数、`401` 未登录、`403` 越权、`404` 不存在、`409` 状态/唯一冲突、`412` 版本冲突、`422` 业务校验、`429` 限流、`503` 依赖不可用。

### 5.5 幂等与并发

- 创建、发布、提交、启动审核等非天然幂等 POST 要求 `Idempotency-Key`。
- 服务端按 `tenant_id + actor_user_id + route + key` 保存 24 小时结果摘要。
- 所有可变业务资源包含整数 `version`，初始为 1。
- 修改/状态迁移请求携带 `expected_version`；不匹配返回 `412 version_conflict` 和当前版本。
- 前端收到 `412` 后重新获取资源，不静默覆盖。

### 5.6 审计

以下动作必须写 `audit_events`：登录成功/失败、改密、账号状态、模型配置/Key 变更、Runner 创建/停止、知识状态模拟操作、需求发布/取消、任务迁移/提交/验收、日报发布/删除、管理员操作。

### 5.7 请求与日志字段

- Gateway 接受或生成 `X-Request-Id`，响应原样返回。
- JSON 日志固定字段：`timestamp`、`level`、`service`、`request_id`、`tenant_id`、`actor_user_id`、`route`、`status_code`、`duration_ms`、`error_code`。
- API Key、密码、Cookie、CSRF Token、PAT、Authorization Header 和正文原文不得写日志。

### 5.8 固定权限矩阵

| 资源 | member | manager | platform admin |
|---|---|---|---|
| Session/Workspace/模型配置 | 仅本人 | 仅本人 | 仅本人；admin 身份不授予读取他人内容 |
| 公司知识 | 浏览、检索 | 浏览、检索 | 浏览、检索、上传和状态操作 |
| 个人知识 | 仅本人浏览、检索和状态操作 | 仅本人，不因 manager 读取成员个人知识 | 仅本人，不因 admin 读取他人个人知识 |
| 需求 | 查看本部门已发布需求 | 创建/编辑/拆分/发布/取消本部门需求 | 除非同时是该部门 manager，否则无业务写权限 |
| 任务 | 查看并更新分配给自己的任务、提交证据 | 查看本部门任务、验收/退回；自己的已分配任务同 member | 除非同时具备对应组织关系，否则无业务写权限 |
| 日报 | 管理本人日报 | 管理本人日报并只读查看本部门成员日报 | 仅本人；除非同时是部门 manager，否则不能查看他人日报 |
| 用户/部门/Runner 管理 | 无 | 无 | 管理；全部动作审计 |

身份没有隐式叠加：platform admin 不等于组织 manager。对象查询应在 repository 层同时带 tenant/owner/department 条件，不能先按 ID 取出后再依赖页面隐藏。

## 6. Platform API v1

权威文件：`packages/contracts/openapi/company-api.v1.yaml`。三个长期 worktree 只读契约源；需要修改时先走短期 `contract/*` 分支。下表中 Platform 路由由 `core-platform` 实现。

| Method | Path | Request | Response | 关键规则 |
|---|---|---|---|---|
| POST | `/company-api/v1/auth/login` | `LoginRequest` | `Me` + Cookie | 禁止已停用账号；失败不区分用户名/密码 |
| POST | `/company-api/v1/auth/logout` | 无 | `204` | 撤销当前 Session |
| POST | `/company-api/v1/auth/change-password` | `ChangePasswordRequest` | `204` | 至少 8 位；撤销其他 Session |
| GET | `/company-api/v1/me` | 无 | `Me` | 返回 CSRF Token、平台/组织角色 |
| GET | `/company-api/v1/model-config` | 无 | `ModelConfig` | 不返回 API Key，只返回 `has_api_key` 和 hint |
| PUT | `/company-api/v1/model-config` | `UpdateModelConfigRequest` | `ModelConfig` | URL/model/key 写入；递增 config version |
| POST | `/company-api/v1/model-config/test` | `TestModelConfigRequest` | `ModelConfigTestResult` | 不在日志/响应回显 Key |
| GET | `/company-api/v1/sessions` | cursor/limit/status | `Page<SessionSummary>` | 仅当前用户 |
| GET | `/company-api/v1/sessions/{session_id}` | 无 | `SessionSummary` | 当前用户 + Runner 固定归属 |
| POST | `/company-api/v1/sessions/{session_id}/archive` | `VersionedCommand` | `SessionSummary` | P0 软归档，不删 JSONL |
| GET | `/company-api/v1/admin/users` | cursor/limit/status | `Page<UserAdminView>` | admin |
| POST | `/company-api/v1/admin/users` | `CreateUserRequest` | `UserAdminView` | admin；要求 Idempotency-Key |
| PATCH | `/company-api/v1/admin/users/{user_id}` | `UpdateUserRequest` | `UserAdminView` | admin；停用立即撤销 Session/Runner |
| POST | `/company-api/v1/admin/users/{user_id}/reset-password` | `ResetUserPasswordRequest` | `204` | admin；至少 8 位；撤销现有 Session |
| GET | `/company-api/v1/admin/departments` | cursor/limit | `Page<Department>` | admin |
| POST | `/company-api/v1/admin/departments` | `CreateDepartmentRequest` | `Department` | admin；要求 Idempotency-Key |
| PUT | `/company-api/v1/admin/departments/{department_id}/members/{user_id}` | `DepartmentMembershipRequest` | `DepartmentMember` | admin；一个用户首版只属于一个部门；新建/移动 expected_version=0 |
| GET | `/company-api/v1/admin/runners` | cursor/limit/state | `Page<RunnerView>` | admin |
| POST | `/company-api/v1/admin/runners/{runner_id}/stop` | `StopRunnerRequest` | `OperationAccepted` | admin；优雅停止 |

核心 schema：

```ts
type PlatformRole = "admin" | "member";
type OrgRole = "manager" | "member";

type Me = {
  user: { id: UUID; username: string; display_name: string; platform_role: PlatformRole };
  department: null | { id: UUID; name: string; org_role: OrgRole };
  csrf_token: string;
};

type LoginRequest = { username: string; password: string };
type ChangePasswordRequest = { current_password: string; new_password: string };

type ModelConfig = {
  base_url: string;
  model: string;
  temperature: number;
  max_output_tokens: number | null;
  has_api_key: boolean;
  api_key_hint: string | null;
  version: number;
  updated_at: Timestamp;
};

type UpdateModelConfigRequest = {
  base_url: string;
  model: string;
  temperature?: number;
  max_output_tokens?: number | null;
  api_key?: string;
  expected_version: number;
};

type SessionSummary = {
  id: string; // DSH Session ID，不重新生成
  workspace_id: string;
  title: string | null;
  status: "active" | "archived" | "interrupted" | "corrupted";
  last_event_position: number | null;
  last_event_at: Timestamp | null;
  version: number;
};
```

内部 Runner/Automation API 的权威文件为 `packages/contracts/openapi/internal-api.v1.yaml`：

| Method | Path | Owner/Caller | 语义 |
|---|---|---|---|
| POST | `/internal/v1/runners/ensure` | Control Plane -> Runner Manager | 幂等启动/定位用户 Runner |
| GET | `/internal/v1/runners/{runner_id}` | Control Plane -> Runner Manager | 健康、活动运行、最后活动 |
| POST | `/internal/v1/runners/{runner_id}/stop` | Control Plane -> Runner Manager | 优雅停止 |
| POST | `/internal/v1/runners/{runner_id}/reconcile` | Control Plane -> Runner Manager | 以 Docker 实际状态修复记录 |
| POST | `/internal/v1/automation-runs` | Business API -> Control Plane | 后续调用 DSH 受控 Profile；开发期可用 fake |
| GET | `/internal/v1/automation-runs/{run_id}` | Business API -> Control Plane | 查询结构化结果 |

```ts
type AutomationPurpose = "task_split" | "task_review" | "daily_rewrite";
type AutomationRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

type CreateAutomationRun = {
  actor_user_id: UUID;
  purpose: AutomationPurpose;
  correlation_id: UUID;
  input: Record<string, unknown>;
  output_schema_id: string;
};

type AutomationRun = {
  id: UUID;
  purpose: AutomationPurpose;
  status: AutomationRunStatus;
  output: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
};
```

外部 operation 与内部自动化 purpose/output schema 的映射固定为：

| Browser operation kind | Internal purpose | `output_schema_id` | 成功结果 schema |
|---|---|---|---|
| `requirement_split` | `task_split` | `company.requirement-split.v1` | `RequirementSplitResult` |
| `task_review` | `task_review` | `company.task-review.v1` | `TaskReviewAutomationResult` |
| `daily_rewrite` | `daily_rewrite` | `company.daily-rewrite.v1` | `DailyRewriteResult` |

`business-api` 负责把内部通用 `AutomationRun.output` 校验并转换成浏览器契约中的 typed result；校验失败一律把外部 operation 标为 `failed/provider_contract_invalid`，不能把未知 JSON 透传到页面。

## 7. Business API v1

权威文件：`packages/contracts/openapi/company-api.v1.yaml`。三个长期 worktree 只读契约源；下表中 Business 路由由 `business-services` 实现。

### 7.1 Knowledge fake API

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/company-api/v1/knowledge/categories` | `scope=company|personal` | `KnowledgeCategory[]` |
| GET | `/company-api/v1/knowledge/documents` | scope/category/status/cursor/limit | `Page<KnowledgeDocument>` |
| POST | `/company-api/v1/knowledge/uploads` | `FakeKnowledgeUploadRequest` | `KnowledgeUpload` |
| GET | `/company-api/v1/knowledge/uploads/{upload_id}` | 无 | `KnowledgeUpload` |
| POST | `/company-api/v1/knowledge/documents/{document_id}/archive` | `VersionedReasonCommand` | `KnowledgeDocument` |
| POST | `/company-api/v1/knowledge/documents/{document_id}/restore` | `VersionedReasonCommand` | `KnowledgeDocument` |
| POST | `/company-api/v1/knowledge/documents/{document_id}/reindex` | `VersionedCommand` | `KnowledgeUpload` |

P0 上传只接收元数据和可选小型测试文件，不执行解析、OCR 或 embedding。状态按 fixture 场景确定性变化；生产环境禁止 fake provider。

fake 异步操作不依赖墙上时间，按同一测试仓库中的查询次数推进，fixture reset 后计数归零：

```text
upload/reindex success: POST queued(0) -> GET running(35) -> GET running(80) -> GET succeeded(100)
upload/reindex fail:    POST queued(0) -> GET running(35) -> GET failed(35, fixture_parse_failed)
automation success:     POST queued -> GET running -> GET succeeded(typed result)
automation fail:        POST queued -> GET running -> GET failed(error)
```

重复 GET 到终态后保持终态；相同 Idempotency-Key 返回同一 operation/upload，不新增计数器。MSW 与真实 fake handler 必须复用上述序列，测试不得使用 `setTimeout` 等待状态变化。

### 7.2 Requirements 与 Tasks

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/company-api/v1/requirements` | mine/department/status/cursor/limit | `Page<Requirement>` |
| POST | `/company-api/v1/requirements` | `CreateRequirementRequest` | `Requirement` |
| GET | `/company-api/v1/requirements/{id}` | 无 | `RequirementDetail` |
| PATCH | `/company-api/v1/requirements/{id}` | `UpdateRequirementRequest` | `Requirement` |
| POST | `/company-api/v1/requirements/{id}/split-runs` | `VersionedCommand` | `AutomationOperation` |
| POST | `/company-api/v1/requirements/{id}/apply-split` | `ApplySplitRequest` | `RequirementDetail` |
| POST | `/company-api/v1/requirements/{id}/publish` | `VersionedCommand` | `RequirementDetail` |
| POST | `/company-api/v1/requirements/{id}/cancel` | `VersionedReasonCommand` | `Requirement` |
| GET | `/company-api/v1/tasks` | view/requirement/assignee/status/from/to/cursor | `Page<TaskSummary>` |
| GET | `/company-api/v1/tasks/{id}` | 无 | `TaskDetail` |
| POST | `/company-api/v1/tasks/{id}/transitions` | `TaskTransitionRequest` | `TaskDetail` |
| POST | `/company-api/v1/tasks/{id}/submissions` | `CreateTaskSubmissionRequest` | `TaskSubmission` |
| POST | `/company-api/v1/tasks/{id}/review-runs` | `StartTaskReviewRequest` | `AutomationOperation` |
| POST | `/company-api/v1/tasks/{id}/accept` | `VersionedReasonCommand` | `TaskDetail` |
| POST | `/company-api/v1/tasks/{id}/return` | `VersionedReasonCommand` | `TaskDetail` |
| GET | `/company-api/v1/automation-operations/{id}` | 无 | `AutomationOperation` |

固定状态机：

```text
requirement: draft -> published -> cancelled

task:
planning -> todo -> in_progress -> review -> done
                              \-> failed
planning/todo/in_progress/review/failed -> cancelled
failed -> in_progress
review -> in_progress            # 主管退回
```

只有发布人/本部门 manager 可以修改需求、应用拆分、发布、取消和最终验收。成员只能对分配给自己的任务执行允许的状态迁移和提交证据。

### 7.3 Daily Reports

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/company-api/v1/daily-reports` | from/to/status/cursor/limit | `Page<DailyReport>`；普通用户只看自己 |
| PUT | `/company-api/v1/daily-reports/{work_date}` | `UpsertDailyReportRequest` | `DailyReport` |
| GET | `/company-api/v1/daily-reports/{work_date}` | 无 | `DailyReport` |
| POST | `/company-api/v1/daily-reports/{work_date}/publish` | `VersionedCommand` | `DailyReport` |
| POST | `/company-api/v1/daily-reports/{work_date}/rewrite-runs` | `DailyRewriteRequest` | `AutomationOperation` |
| POST | `/company-api/v1/daily-reports/{work_date}/apply-rewrite` | `ApplyDailyRewriteRequest` | `DailyReport` |
| DELETE | `/company-api/v1/daily-reports/{work_date}` | `expected_version` query | `204` |
| GET | `/company-api/v1/departments/{department_id}/daily-reports` | date/from/to/member/status/cursor | `DepartmentDailyReportView` |

部门日报范围响应按 `user + work_date` 展开，每行的 `report` 可以为 `null` 表示未提交，并返回 `from/to/next_cursor`；`date` 与 `from/to` 互斥，传 `date` 等价于 `from=to=date`。`PUT` 对已软删除的同日期记录执行“重新打开为 draft + 新增 revision”，不创建第二行。AI 改写只生成 preview，必须调用 apply 才覆盖正文，且不会自动发布。

## 8. Business 核心 schema

```ts
type KnowledgeScope = "company" | "personal";
type KnowledgeDocumentStatus =
  | "pending_review" | "ready" | "rejected"
  | "archived" | "pending_purge" | "purging";
type KnowledgeUploadStatus = "queued" | "running" | "succeeded" | "failed";

type KnowledgeDocument = {
  id: UUID;
  knowledge_id: string;
  scope: KnowledgeScope;
  owner_user_id: UUID | null;
  category: "company-information" | "xiaopai-design" | "patent-document" | null;
  title: string;
  file_name: string;
  media_type: string;
  size_bytes: number;
  status: KnowledgeDocumentStatus;
  version: number;
  updated_at: Timestamp;
};

type KnowledgeSearchItem = {
  document_id: UUID;
  knowledge_id: string;
  version: number;
  title: string;
  file_name: string;
  category: KnowledgeDocument["category"];
  visibility: KnowledgeScope;
  heading_path: string[];
  content: string;
  line_start: number;
  line_end: number;
  score: number;
  vector_score?: number | null;
  lexical_score?: number | null;
};

type KnowledgeSearchResult = {
  query: string;
  count: number;
  results: KnowledgeSearchItem[];
};

type RequirementStatus = "draft" | "published" | "cancelled";
type TaskStatus = "planning" | "todo" | "in_progress" | "review" | "done" | "failed" | "cancelled";
type ReviewResult = "pass" | "fail" | "needs_review";

type Requirement = {
  id: UUID;
  department_id: UUID;
  publisher_user_id: UUID;
  title: string;
  objective: string;
  acceptance_criteria: string[];
  status: RequirementStatus;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
};

type TaskSummary = {
  id: UUID;
  requirement_id: UUID;
  parent_task_id: UUID | null;
  assignee_user_id: UUID | null;
  title: string;
  status: TaskStatus;
  due_at: Timestamp | null;
  latest_review_result: ReviewResult | null;
  position: number;
  version: number;
  updated_at: Timestamp;
};

type TaskSubmission = {
  id: UUID;
  task_id: UUID;
  submitter_user_id: UUID;
  summary: string;
  evidence: Array<{ kind: "url" | "text" | "file_ref"; label: string; value: string }>;
  created_at: Timestamp;
};

type TaskReviewRun = {
  id: UUID;
  task_id: UUID;
  submission_id: UUID;
  status: AutomationRunStatus;
  result: ReviewResult | null;
  summary: string | null;
  checks: Array<{ name: string; passed: boolean | null; detail: string }>;
  evidence: Array<{ label: string; value: string }>;
  executor_version: string;
  created_at: Timestamp;
  completed_at: Timestamp | null;
};

type DailyReportStatus = "draft" | "published" | "deleted";
type DailyReportContent = {
  completed_today: string;
  next_plan: string;
  blockers: string;
  other: string;
  free_text: string | null;
};

type DailyReport = {
  id: UUID;
  user_id: UUID;
  department_id: UUID;
  work_date: DateString;
  content: DailyReportContent;
  status: DailyReportStatus;
  version: number;
  published_at: Timestamp | null;
  updated_at: Timestamp;
};

type AutomationOperation = {
  id: UUID;
  kind: "requirement_split" | "task_review" | "daily_rewrite";
  status: AutomationRunStatus;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
};
```

## 9. Knowledge Tool v1

权威 schema：`packages/contracts/schemas/tools/knowledge.v1.schema.json`。

本地 fake Tool 与后续 MCP 必须保持以下名称：

```text
get_current_user()
search_knowledge(query, category?, top_k?)
list_knowledge_documents(status?, category?, limit?)
```

规则：

- `search_knowledge.top_k` 默认 5，范围 1–20。
- `query` trim 后长度 1–2,000。
- Tool 参数没有 `user_id`、`department_id`、URL、Header 或 Token。
- 本地 Tool 从 `KnowledgeToolContext` 获取固定 Runner 用户。
- `FakeKnowledgeProvider` 返回 `KnowledgeSearchResult`，字段与目标 RAG 一致。
- 同一 query、用户和 fixture 版本必须得到同一排序。
- 引用唯一键使用 `document_id + version + line_start + line_end`。
- 知识正文视为不可信证据，不能作为 Agent 指令执行。

`fixture-v1` 的 fake 检索顺序固定为：

1. 从可信 `KnowledgeToolContext` 取得用户，先保留公司文档和 `owner_user_id` 等于当前用户的个人文档；
2. `search_knowledge` 只检索 `status=ready`，再应用可选 category；个人文档 category 固定为 `null`；
3. query 执行 trim 和 Unicode 小写归一化；命中同 actor/query/category 的 `query_cases` 时按 `expected_document_ids` 返回；
4. 非固定 case 使用标题和 chunk content 的简单词项包含匹配，不做 embedding，不宣称检索质量；
5. 排序为 `score DESC, document_id ASC, line_start ASC`，最后应用 `top_k`；
6. `list_knowledge_documents` 未传 status 时默认只返回 `ready`，排序为 `updated_at DESC, document_id ASC`。

任何步骤都不得在过滤后补入另一用户个人文档来凑满 `top_k`。固定 case 是测试协议的一部分，不允许 MSW、Runner Tool 和 Business fake 各自改写 expected order。

## 10. DB v1

冻结 DDL 位于：

```text
packages/db/baseline/platform-v1.sql
packages/db/baseline/business-v1.sql
packages/db/baseline/business-fake-v1.sql
```

这些文件是设计基线，不作为运行时 migration 直接反复执行。`core-platform` 和 `business-services` 分别把自己的基线转成 Drizzle forward-only migration；`business-fake-v1.sql` 只进入开发/测试 profile。

### 10.1 通用规则

- 单个 PostgreSQL 实例、单个数据库，使用 `platform`、`business` 两个 schema。
- 所有表使用 UUID 主键、`timestamptz`、snake_case。
- 业务状态使用 `text + CHECK`，不用 PostgreSQL ENUM，便于后续前向迁移。
- 所有 mutable 表包含 `version integer not null default 1` 和 `updated_at`。
- migration 只前向追加；合并后禁止改写已有文件。
- 平台迁移先执行，再执行业务迁移。业务表允许 FK 到已冻结的 `platform.users/departments`。

### 10.2 Platform schema

| 表 | 必需字段/约束 | 关键索引 |
|---|---|---|
| `platform.tenants` | id、name、status、created_at | unique lower(name) |
| `platform.users` | tenant_id、username、display_name、platform_role、status、version、timestamps | unique `(tenant_id, lower(username))`; status |
| `platform.local_password_credentials` | user_id PK/FK、password_hash、must_change、changed_at | 无 |
| `platform.web_sessions` | token_hash、user_id、csrf_hash、idle_expires_at、absolute_expires_at、revoked_at | unique token_hash；user active sessions |
| `platform.departments` | tenant_id、name、status、version、timestamps | unique active `(tenant_id, lower(name))` |
| `platform.department_members` | department_id、user_id、org_role、timestamps | PK `(department_id,user_id)`；unique user_id |
| `platform.model_configs` | user_id unique、base_url、model、temperature、max_output_tokens、api_key_secret_id、config_version、version | unique user_id |
| `platform.secrets` | owner_user_id、purpose、ciphertext、key_version、hint、revoked_at、timestamps | owner/purpose active |
| `platform.sessions` | session_id text PK、tenant_id、user_id、workspace_id、title、status、last_event_position、last_event_at、version | `(user_id,last_event_at desc)` |
| `platform.workspaces` | workspace_id text PK、tenant_id、user_id、logical_name、storage_ref、version | `(user_id,created_at)` |
| `platform.runner_instances` | user_id、container_id、image_version、state、internal_endpoint、config_version、timestamps | partial unique active user_id；state |
| `platform.knowledge_provider_configs` | tenant_id unique、provider、remote_mcp_enabled、endpoint、auth_secret_id、allowed_tools jsonb、config_version | unique tenant_id |
| `platform.rag_user_bindings` | user_id unique、rag_employee_id、token_secret_id、status、version | unique user_id；unique rag_employee_id |
| `platform.idempotency_records` | tenant_id、actor_user_id、route、key、request_hash、status_code、response_json、expires_at | unique tenant/actor/route/key；expires_at |
| `platform.audit_events` | tenant_id、actor_user_id、action、resource_type/id、result、request_id、details jsonb、created_at | actor/time；resource/time；request_id |

Redis keys：

```text
runner-route:{user_id}                  -> runner_id, ttl 60s
runner-lease:{user_id}                  -> holder + fencing_token, ttl 30s
session-writer:{session_id}             -> run_id + fencing_token, renewable
rate-limit:{scope}:{key}:{window}       -> counter
```

### 10.3 Business schema

| 表 | 必需字段/约束 | 关键索引 |
|---|---|---|
| `business.requirements` | tenant_id、department_id、publisher_user_id、title、objective、acceptance_criteria jsonb、status、version、published_at、timestamps | department/status/updated；publisher/updated |
| `business.tasks` | requirement_id、parent_task_id、department_id、assignee_user_id、title、description、acceptance_criteria jsonb、status、position、due_at、latest_review_result、version、timestamps | requirement/position；assignee/status/updated；department/status |
| `business.task_dependencies` | task_id、depends_on_task_id | PK pair；禁止 self dependency |
| `business.task_status_history` | task_id、from_status、to_status、actor_user_id、reason、created_at | task/time |
| `business.task_submissions` | task_id、submitter_user_id、summary、evidence jsonb、created_at | task/time |
| `business.task_review_runs` | task_id、submission_id、automation_run_id、status、result、summary、checks/evidence jsonb、executor_version、timestamps | task/time；automation_run_id unique |
| `business.daily_reports` | tenant_id、user_id、department_id、work_date、content jsonb、status、version、published_at、deleted_at、timestamps | unique `(tenant_id,user_id,work_date)`；department/date/status |
| `business.daily_report_revisions` | report_id、editor_user_id、source、before_content、after_content、created_at | report/time |
| `business.automation_operations` | kind、actor_user_id、resource_type/id、provider、provider_run_id、status、result/error jsonb、timestamps | resource/time；provider_run_id |
| `business.fake_knowledge_documents` | fixture_key、owner_user_id、scope、category、title、file metadata、status、version、updated_at | scope/owner/category/status |
| `business.fake_knowledge_uploads` | document_id、owner_user_id、status、progress、error_code、timestamps | owner/time；status |

fake 知识表只在开发/测试 migration profile 中创建，生产 migration 不包含它们。

## 11. 冻结 fixtures

`packages/test-fixtures/fixture-v1.json` 已提供一套可复位、无随机值的冻结 fixture：

### 11.1 组织与账号

- 一个 tenant：`小派公司`。
- 两个部门：`研发部`、`产品部`。
- 一个平台 admin。
- 研发部一个 manager、两个 member；产品部一个 manager、一个 member。
- 测试密码只通过 test seed 参数注入，不写入仓库 fixture JSON。

### 11.2 知识

- 三个公司分类各至少 2 个 ready 文档。
- 研发 member A、研发 member B 各至少 2 个个人文档，内容必须可用不同关键词区分。
- 至少 1 个 `pending_review`、1 个 `archived`、1 个模拟上传失败文档。
- 至少 6 个查询用例：公司命中、A 个人命中、B 个人命中、分类过滤、无结果、同分排序。
- 所有知识结果包含稳定 UUID、version、行号、heading path 和 score。

### 11.3 任务

- 一个 draft requirement，带 AI 拆分 preview。
- 一个 published requirement，至少 6 个 tasks，覆盖 `todo/in_progress/review/done/failed/cancelled`。
- 至少一个依赖关系、一个 submission、三个 review 结果。
- 四个快速视图都有非空结果，并含一个合法空状态场景。

### 11.4 日报

- 固定基准日期 `2026-08-18`。
- 当前用户有 draft、published 历史；同部门至少一人已提交、一人未提交。
- 包含一次 rewrite preview 和至少两条 revision。
- 测试时钟通过 Clock 接口注入，禁止读取开发机器当前日期决定断言。

## 12. Company Web 路由与页面状态

| Route | 页面 | 必须覆盖的状态 |
|---|---|---|
| `/login` | 登录 | 默认、提交中、凭据错误、账号停用 |
| `/workbench` | 工作台默认跳转 | 跳转到 `/workbench/tasks` 或最近模块 |
| `/workbench/settings/model` | 模型设置 | 无配置、已配置、测试中、测试失败、保存冲突 |
| `/workbench/knowledge/company` | 公司知识 | loading、列表、筛选、空、上传/审核状态、错误 |
| `/workbench/knowledge/personal` | 个人知识 | loading、列表、空、上传、归档、失败重试 |
| `/workbench/requirements` | 需求列表 | 我发布的、部门、draft/published/cancelled |
| `/workbench/requirements/:id` | 需求详情 | 编辑、拆分运行中/失败/preview、发布冲突 |
| `/workbench/tasks` | 任务看板 | 四快速视图、筛选、每个状态列、空列、无权限 |
| `/workbench/tasks/:id` | 任务详情 | 历史、提交、审核运行中/结果、退回/验收 |
| `/workbench/daily-reports` | 我的日报 | 当日无记录、draft、published、rewrite preview、deleted |
| `/workbench/daily-reports/department` | 部门日报 | 今日、日期范围、成员筛选、未提交、无主管权限 |
| `/workbench/admin/users` | 用户管理 | 列表、创建、停用、冲突、无权限 |
| `/workbench/admin/runners` | Runner 管理 | 状态、停止中、失败、无权限 |
| `/chat` | 跳转/代理官方 DSH Web | Runner 启动中、失败、进入聊天 |

页面只能通过生成 API Client 或 MSW 调用契约。组件不得直接导入后端 repository 类型。所有 command 按钮要处理 pending、防重复提交、`412` 冲突和权限禁用。

## 13. Worktree 首批任务

### 13.1 `feat/core-platform`

按顺序交付：

1. 根 pnpm workspace、Node/pnpm pin、TypeScript/Oxlint/Prettier/Vitest 配置和完整依赖 lockfile。
2. 契约生成脚本、platform migration、test seed；只消费冻结的 OpenAPI，不在功能分支改契约源。
3. Control Plane：登录/Session、`/me`、模型配置、admin 用户/部门、审计。
4. Runner Manager：Docker API wrapper、ensure/stop/reconcile、Redis lease、资源模板。
5. DSH submodule/镜像、Gateway `/chat` 代理、HTTP/WebSocket allowlist、每用户卷。
6. Session Index Bridge 和 reconcile。
7. `company-dsh` 本地 Knowledge Tool + `KnowledgeToolPort` + `RunnerFakeKnowledgeProvider` 装配；`remote-mcp` 配置槽位默认关闭。
8. internal automation endpoint 和仅供内部契约测试的 `StubAutomationExecutor`；真实 DSH executor 可在 P0 chat 稳定后补。

分支完成门：

- 两个 test user 的登录、模型配置、Runner 隔离、Session 恢复集成测试通过；
- 本地 `search_knowledge` Tool 产生可持久化事件；
- 未登录/跨用户/高权限 DSH RPC 被拒绝；
- 仅此 worktree 修改根 lockfile、deploy 和 platform migrations。

### 13.2 `feat/company-web`

按顺序交付：

1. React/Vite 应用外壳、路由、权限门、Query Client、生成 API Client。
2. `packages/ui` Design Tokens、Logo Slot、导航、表单、表格、看板、抽屉、对话框和 toast。
3. MSW 使用 `fixture-v1` 覆盖 Platform/Business API，不自行发明字段。
4. 登录、模型设置、聊天双向入口。
5. 公司/个人知识页面和所有 fake 状态。
6. 需求、任务看板/详情/审核页面。
7. 个人/部门日报和 admin 页面。
8. 桌面与移动 Playwright 组件/页面 smoke tests；跨真实服务 E2E 留给 integration 分支。

分支完成门：

- 所有第 12 节路由可通过 MSW 完整操作；
- loading/empty/error/forbidden/conflict 状态都有测试；
- 不修改 OpenAPI、后端目录、根 lockfile；新增依赖需先走同步提交；
- 无嵌套卡片、无业务说明型首屏、无 DeepSeek/dsh-web-ui 视觉复用。

### 13.3 `feat/business-services`

按顺序交付：

1. Knowledge Tool schema 消费/生成检查、business migrations；只消费冻结契约，不在功能分支改契约源。
2. `business-api` Fastify 外壳、平台身份验证 middleware、业务权限 policy。
3. Knowledge API fake handler、fixtures、确定性状态和 `FakeKnowledgeRepository` 测试数据支持。
4. Requirements/Tasks CRUD、状态机、拆分 preview、submission、review run 和验收/退回。
5. Daily Reports CRUD、revision、rewrite preview、部门查询和未提交视图。
6. `AutomationPort` + 产品级 `FakeAutomationProvider`；实现 internal automation client，但可在 integration 波次才启用真实 DSH provider。
7. 本域 audit、幂等、乐观锁和集成测试。

分支完成门：

- API contract tests、PostgreSQL integration tests、权限矩阵和状态机测试通过；
- 同一幂等键不重复创建/发布/提交；
- 普通成员无法跨用户/跨部门读取或修改；
- 不修改 `apps/company-web`、platform migrations、Runner/DSH 或根 lockfile。

## 14. 并发依赖与合并协议

### 14.1 三分支可以同时做什么

```text
core-platform      -> 真实 Platform API + DSH/Runner + 本地 fake Tool
company-web        -> 基于冻结 OpenAPI/fixtures 的完整 Workbench
business-services  -> 真实 Business API + DB + fake Provider/Automation
```

Company Web 不等待后端即可完成；Business API 不等待 Runner 即可通过 `AutomationPort` fake 完成；Core 不等待 Business API 即可使用冻结 Knowledge Tool schema 验证 DSH Tool 事件。

两条 knowledge fake adapter 都只读同一个冻结 fixture，但实现归各自 worktree：Core 的 `RunnerFakeKnowledgeProvider` 产生 DSH Tool 结果，Business 的 `FakeKnowledgeRepository` 产生 Company API 状态。Business 的 `FakeAutomationProvider` 是产品开发替身；Core 的 `StubAutomationExecutor` 只验证 `/internal/v1`，不得成为业务 API 的数据源。

### 14.2 禁止的跨分支写入

- company-web 不修改任何 OpenAPI/DB/service 文件。
- business-services 不修改 root config/lockfile、Platform schema、DSH/Runner 或 Web。
- core-platform 不修改 Business schema、Business API 和业务页面。
- 任一分支不得直接修改 DSH submodule、生成文件或另一 owner 的 migration。

### 14.3 同步点

只设置三个必须同步点：

1. `integration/p0`：登录、模型配置、Runner、官方 DSH Web、Session、Knowledge Tool fake。
2. `integration/business`：Company Web 切换 MSW 到真实 Platform/Business API。
3. `integration/mvp`：任务自动化、日报改写、备份恢复、权限与全域 E2E。

发现契约差异时停止集成，不在 integration 分支写永久 adapter；回到 `contract/*` 修正基线并同步三分支。

## 15. 每分支统一质量门

至少提供以下根命令，具体 filter 由 owner 配置：

```text
pnpm install --frozen-lockfile
pnpm contracts:check
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
```

合并要求：

- 受影响包 typecheck/lint/unit test 全绿；
- API 或 Tool 变更通过契约检查，生成文件无 diff；
- migration 在空库和上一基线库都能向前执行；
- 不提交 `.env`、密钥、真实账号数据、构建产物或本机绝对路径；
- 新增日志经过密钥/正文泄漏检查；
- 分支 README 写明启动命令、环境变量、测试命令和已知未完成项。

## 16. 非阻塞后续项

以下事项不阻止三个 worktree 立即开发：

- 正式 Logo、字体和品牌色：Company Web 先使用 token 和可替换 Logo Slot。
- DSH `/chat` base path 是否可用：Core PoC 可退回聊天子域名，不影响 Business/Web 契约。
- 真实 RAG PAT、ACL、OCR、延迟和版本兼容：开发交付后接入。
- `@deepseek-ai/dsh-client-connection` 的自研 Chat 适配：不属于当前三个分支首批交付。
- 高可用、跨宿主机调度、集中 Session Provider：P0 后再设计。

## 17. 创建 worktree 前的机械步骤

设计冻结后，主目录需要先成为有基线 commit 的 Git 仓库。执行下面命令前，一次性 bootstrap 必须已经创建：

- 根 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.node-version`；
- `tsconfig.base.json`、`.prettierrc.json`、`oxlint.json`、`vitest.config.ts` 和根质量命令；
- `apps/company-web`、三个 service/runtime/extension 入口及其最小 `package.json`；
- `packages/contracts/generated`，由两份 OpenAPI 生成且生成检查无 diff；
- Platform/Business migration 空目录、test-support、deploy/tests/docs 基础目录。

这些骨架与已冻结文档/契约/DDL/fixture 必须进入同一个 commit。不要从三个不同时间点创建 worktree：

```bash
git init -b main
git add dsh二开融合设计.md 三Worktree并发开发启动基线.md package.json pnpm-workspace.yaml pnpm-lock.yaml .node-version .gitignore
git add tsconfig.base.json .prettierrc.json oxlint.json vitest.config.ts
git add apps services runtimes extensions integrations packages deploy tests docs
git commit -m "chore: bootstrap three-worktree development baseline"

git worktree add -b feat/core-platform ../dsh-core-platform main
git worktree add -b feat/company-web ../dsh-company-web main
git worktree add -b feat/business-services ../dsh-business-services main
git worktree list
```

本节命令展示 Git 顺序，不替代一次性 bootstrap。三个 worktree 创建后立即记录相同的基线 SHA；任何一个 worktree 不得使用尚未合并的本地目录作为起点。
