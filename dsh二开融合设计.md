# DeepSeek Harness 公司 AI 协作平台融合设计

> 状态：v0.8 三 Worktree 开发冻结稿，尚未实施  
> 日期：2026-08-19  
> 目标：将 DeepSeek Harness（下文简称 DSH）作为公司 AI 运行底座，建设统一的 Web 协作平台，覆盖多用户对话、知识库、需求任务和日报，员工不需要在本地拉取或运行二开代码。

并发开发的技术栈、目录所有权、API/DB v1、fixtures、首批任务和质量门以 `三Worktree并发开发启动基线.md` 为准；本文负责产品目标、架构理由和演进边界。两份文档与 `packages/contracts`、`packages/db/baseline`、`packages/test-fixtures/fixture-v1.json` 共同构成同一冻结基线。

## 1. 背景与结论

计划建设的不是“每位员工一份 DSH 源码”，而是一个统一的公司 Web 系统：

- 公司只维护一份 DSH 基础镜像和一份公司扩展代码；
- 员工通过统一 Web 页面登录；
- 每位员工可以使用自己的模型 API URL、API Key、Settings、Skill、MCP 和会话；
- 完整保留每位员工的历史会话窗口和窗口内全部对话记录；
- 公司提供公共/个人知识库，并让对话在权限范围内检索知识内容；
- 主管可以发布需求、拆分子任务、查看任务看板和自动化审核结果；
- 员工可以维护日报，主管可以按部门和日期查看日报；
- 公司提供公共 Skill 和受控 MCP；
- DSH 上游更新时，公司代码尽量不直接修改 DSH 核心，降低后续升级和合并成本。

当前推荐采用：

```text
同一份公司镜像
    +
公司公共 Profile / Skill / MCP
    +
每个活跃用户一个按需 Runner
    +
每个用户独立 DSH_HOME、数据卷和 Workspace
    +
Gateway 统一负责登录、授权、Session 归属和 Runner 路由
    +
P0 使用官方 DSH Web 承载对话，公司 Workbench 承载业务页面
```

暂不推荐首版直接使用完全共享的 Runner Pool。DSH 当前的 Settings、Credentials、Skill 扫描目录和进程环境更接近单用户运行模型。强行在同一个长期进程中动态切换多个用户，会要求公司重写较多 Provider 和运行时上下文传播逻辑，也更容易发生凭据或文件串用。

### 1.1 已确认的首版决策

| 决策项 | 首版选择 | 说明 |
|---|---|---|
| 部署形态 | 单台 Linux Runner 宿主机 | 二十人左右规模先避免引入集群编排；数据库和备份可以使用公司已有服务 |
| 常驻服务编排 | Docker Compose | 管理 Web、Control Plane、Runner Manager、PostgreSQL、Redis 和反向代理 |
| 员工认证 | 系统内置账号密码 | 公司目前没有可用 SSO/LDAP/AD；首版不实现 MFA，禁止公开注册 |
| 用户 Runner | Runner Manager 通过 Docker Engine API 动态创建 | Runner 不作为静态 Compose 副本声明 |
| Runner 隔离 | 每个活跃用户最多一个独立容器 | 容器只挂载当前用户数据卷和授权的只读公共目录 |
| 会话存储 | 每用户独立 JSONL 根目录 | PostgreSQL 只保存会话索引、所有权和运行状态 |
| 控制面状态 | PostgreSQL + Redis | PostgreSQL 保存权威业务数据，Redis 保存短租约、互斥和临时路由 |
| 凭据读取 | P0 使用每用户 `.credentials.yaml` | 固定 Profile 关闭 Shell/文件等高风险 Tool，只保留 fake 只读知识工具；接入真实 MCP 或扩大 Tool 范围前升级凭据方案 |
| DSH 集成 | 锁定版本，通过公开扩展点接入 | 必须修改上游核心时维护独立小补丁 |
| Web 过渡方案 | P0 官方 DSH Web + 自研 Company Workbench | DSH Web 暂时承载对话/历史；自研 Web 承载登录、设置、知识、任务和日报，后续再替换对话 UI |
| 知识检索 | P0 使用契约一致的 fake 数据，预留远程 MCP 槽位 | 开发和自动测试不连接现有 RAG；后续接入集中在启用开关、MCP URL、认证和用户绑定，不改业务模块 |
| 组织业务权限 | `manager/member` | 与平台管理角色 `admin/member` 分开，只服务任务和日报链路 |

Docker Compose 不提供跨宿主机调度。首版如果部署多台服务器，应只有一台承担 Runner 宿主机角色；高可用和跨节点 Runner 调度属于后续演进范围。

### 1.2 首版范围与非目标

首版核心范围：

- 简单本地账号密码登录，并建立可信 `tenant_id`、`user_id` 和角色上下文；
- 浏览器中的会话创建、全部历史窗口、窗口内完整消息/事件、继续对话、停止生成和流式响应；
- 用户模型 API URL、API Key 配置，并自动发现该凭据可访问的全部模型；
- 每用户 Runner 的按需启动、健康检查、空闲停止和异常恢复；
- 使用 fake 数据完成公司/个人知识库分类、文件总览、入库状态和对话检索；真实 RAG/MCP 接入后复用相同界面和契约；
- 主管发布需求、拆分子任务、指派人员、看板跟踪和自动化审核结果；
- 员工日报创建/提交、编辑、AI 改写、删除，以及主管按部门和日期查看；
- Settings、Credentials、Session、Workspace、上传文件、Skill、MCP 和业务资源的用户/部门边界；
- 足够支撑主业务链路的密钥脱敏、基础审计和隔离验收。

首版明确不做：

- 完整自研对话 UI；P0 先使用官方 DSH Web，后续通过独立 `chat-replacement` 模块替换；
- 用户上传或执行任意 Skill、`stdio` MCP 代码；
- 员工填写任意远程 MCP URL；
- 开发阶段连接或修改现有 `freshpi-ai/rag-mcp`；
- PostgreSQL SessionPersistence Provider；
- 跨节点 Runner 调度、Runner Pool 和自动扩缩容；
- TOTP/WebAuthn MFA 和外部身份源接入；
- 邮件邀请、自助找回、复杂 RBAC 和审批工作流引擎；
- 多地域、双活和自动故障转移。

四个产品域都在 MVP 范围内，但集成顺序分层：先用 fake 数据跑通“模型配置 -> 完整会话历史 -> 知识工具调用/引用展示”，任务和日报基于已冻结契约用独立 worktree 并行开发。真实 MCP 接入作为独立切换步骤，不阻塞这些模块的开发和自动测试。

### 1.3 DSH 上游核对基线

2026-08-18 只读核对的上游基线为：

```text
repository: https://github.com/deepseek-ai/deepseek-harness
default branch: master
reviewed commit: 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
```

该 commit 已冻结为当前三个 worktree 的开发基线，包版本为 `0.1.0-rc.7`，以 Git submodule 引入。它仍不是未经验证即可上线的生产批准版本；阶段 0 需要通过 ADR 记录构建、补丁和兼容测试结果，后续换 commit 必须走独立升级变更。

已核对事实：

- DSH 官方标记为 developer preview，并明确提示会发生兼容性破坏；
- 上游已有 `apps/web` 和客户端连接包；P0 可直接使用锁定版本的官方 Web 验证 Agent 事件、Session 和工具调用，公司业务页仍采用自研 UI；
- 浏览器连接层通过 HTTP POST 完成请求/响应，通过两条下行 WebSocket 接收 `events.mux` 和 `events.host`；
- DSH 采用 Cordis composition 和插件装配，Web、Settings、Credentials、Session、Skill、MCP、Sandbox 等均以插件形式组合；
- 文件 Settings Provider 支持外部编辑热加载和跨进程写锁；
- Credentials seam 在每次模型操作开始时重新解析引用，可以由自定义 Provider 支持下一次请求立即使用新密钥；
- 官方本地 Credentials Provider 明确说明 `.credentials.yaml` 不能防止同 UID 的 Bash/文件工具读取；
- JSONL Session Provider 明确要求一个 Session 同时只有一个 live writer，且当前不提供删除 API。

因此，公司 P0 先把锁定版本的 DSH Web 作为对话工作台，由 Gateway 增加身份、授权和每用户 Runner 路由；知识、任务、日报和设置使用公司自研 Workbench。公司自研对话层和 `dsh-client-adapter` 后移到主链路验证后实施；生产开放高风险 Tool 前必须实现公司 Credentials Provider，不能把 `.credentials.yaml` 的 `0600` 权限误认为对 Agent 的隔离。

### 1.4 P0 主业务链路

首要目标不是先完成所有管理能力，而是尽快跑通下面这条可重复验证的纵向链路：

```text
1. admin 创建员工账号
2. 员工使用账号密码登录
3. 员工在 Company Workbench 只保存模型 API URL 和 API Key，Control Plane 通过 `GET /models` 发现并持久化完整模型目录
4. 员工访问受保护的 `/chat`，Gateway 根据 user_id 调用 Runner Manager 启动或定位独立 Runner
5. Runner 加载用户 Settings、Credentials、JSONL Session 和可配置的知识工具入口；开发期指向 fake provider
6. Gateway 把 DSH Web 及协议流量固定路由到该 Runner，员工看到自己的全部历史窗口
7. 员工在 DSH Web 创建 Workspace/Session，只能写入当前用户卷
8. Session Index Bridge 把新 Session 幂等登记到 Company PostgreSQL，后台 reconcile 作为兜底
9. DSH Web 通过 Gateway 代理的 DSH 协议发送消息
10. Agent 按需调用 search_knowledge，fake provider 按当前测试用户返回公司公共与本人个人数据
11. DSH 调用模型，把流式事件和知识引用返回浏览器
12. 全部 Session Event、知识引用和 Workspace 写入用户卷
13. 重新打开任意历史窗口时加载完整记录
14. Runner 空闲停止并重建后，原 Session 仍可继续对话
15. 员工可从 DSH Web 的“公司工作台”入口进入 `/workbench`，并从 Workbench 返回对话
```

P0 开发完成标准：使用两个测试账号，分别配置模型并完成包含 fake 知识检索的真实模型对话；可创建多个会话窗口并重新打开任意窗口的完整记录；两个账号互相看不到 Session/Workspace/fake 个人知识；停止并重建 Runner 后可以恢复各自会话；浏览器、日志和 Tool 结果中不出现完整 API Key。该标准只证明平台链路和预留契约可用，不宣称真实 RAG 的网络、认证、ACL、延迟或检索质量已经验收。

为了尽快验证链路，P0 只支持一个 OpenAI-compatible Provider 配置，但该 Provider 下可包含 `GET /models` 返回的多个模型；DSH Web 使用官方原生模型选择器为会话选型。P0 仍使用一个固定 Agent Profile、无个人 Skill、无用户自定义 MCP 和单 Workspace，但必须支持多会话窗口、完整历史以及一个可从 fake 切换为远程 MCP 的知识入口。任务与日报不阻塞 P0 联调，可以基于已合并契约和 fake 在独立 worktree 中并行开发。

## 2. 需要先澄清的三个概念

### 2.1 镜像、Runner 和 Session 不是同一层

| 概念 | 含义 | 推荐数量 |
|---|---|---|
| 公司镜像 | DSH 运行时、P0 DSH Web 入口补丁、Company Workbench、公共 Profile/Skill 和审核过的 MCP | 一份，多版本滚动升级 |
| Runner | 一个正在运行的 DSH 进程或容器 | 每个活跃用户最多一个 |
| Session | 某位用户的一条对话及其事件历史 | 一个 Runner 可以承载多条 |

二十位员工不意味着构建二十份镜像。所有 Runner 都从同一镜像启动，只挂载不同的用户数据卷。无操作的 Runner 可以停止，用户再次访问时按需恢复。

### 2.2 DSH 不直接等于多租户公司系统

DSH 可以作为 Agent 运行底座，但以下能力应由公司控制面负责：

- 登录、员工、部门和角色；
- 用户配置保存和密钥加密；
- Runner 启动、停止和路由；
- Session 所有权校验；
- Skill/MCP 的审批和授权；
- 配额、审计、限流、网络策略和资源限制；
- 知识库、需求任务、日报等公司业务页面。

不能仅依赖 DSH 内部的目录命名实现多用户安全。

### 2.3 “每个用户一个 Profile”不是最准确的边界

更合适的拆分是：

- 公司 Profile：定义统一 Agent 行为和公司公共能力，随镜像发布，默认只读；
- 用户 Settings/Credentials：保存用户自己的模型和偏好；
- 用户 Skill/MCP：仅加载该用户被允许使用的扩展；
- 用户 Session/Workspace：保存该用户的对话事件和工作文件。

公司可以允许用户选择不同 Agent Profile，但 Profile 本身不应成为唯一的隔离手段。

## 3. 总体架构

```text
浏览器
  |
  | 登录 Cookie / Access Token
  v
公司反向代理 + Gateway
  |- /workbench -> Company Web
  |                 `-> Knowledge / Tasks / Daily Reports 业务 API
  `- /chat -> 认证当前 user_id / tenant_id
              -> 校验资源所有权
              -> 启动或定位该用户 Runner
              -> 代理 DSH Web 静态资源、HTTP RPC 和 WebSocket
         |                                  |
         |                                  `-> PostgreSQL / 文件存储 / 检索索引
         v
用户专属 Runner
  |- P0 DSH Web 对话界面
  |- DSH_HOME=/dsh-user
  |- 只读公司公共目录
  |- 仅挂载当前用户数据卷
  |- 仅加载当前用户模型凭据和 MCP
  `- 调用第三方或官方模型 API
         |
         +-- 用户 Settings / Credentials
         +-- 用户 Skills
         +-- 用户 Sessions
         +-- 用户 Workspaces
         `-- 用户 Storage
```

### 3.1 首版部署拓扑

```text
                         Docker Compose 管理的常驻服务

浏览器 -> 反向代理 -> /workbench -> Company Web
                    `-> /chat + /company-api -> Control Plane / Gateway -> PostgreSQL / Redis
                              |              `-> Business API（Knowledge / Tasks / Daily Reports）
                              |                         |
                              |                         `-> P0 fake providers / 后续真实知识服务
                              |              `-> Runner 内 P0 本地 Knowledge Tool / 后续 remote-mcp
                              `-> Runner Manager -> Docker Engine API
                                        |
                                        `-> 按需创建用户 Runner 容器
                                                   |- 用户独立读写卷
                                                   |- 公司能力只读挂载
                                                   `- Runner 内部网络
```

组件的网络和权限边界：

- 反向代理是浏览器访问系统的唯一入口，终止 TLS，并设置请求体大小和连接超时；
- Company Web 提供品牌化 Workbench、设置和业务页，不在浏览器持久保存或回显用户模型密钥；
- Control Plane/Gateway 校验身份、资源所有权和业务权限，并代理所有 Runner 流量；
- P0 DSH Web 必须通过 Gateway 访问，其静态资源、HTTP RPC 和 WebSocket 不得使用可绕过登录的 Runner 直连地址；
- Knowledge、Tasks 和 Daily Reports 是 `business-api` 模块化单体中的逻辑模块，不直接信任浏览器提供的 owner/部门身份；
- Runner Manager 只接受 Control Plane 的内部请求，是唯一允许访问 Docker Engine API 或受限 Docker Socket 的业务服务；
- 用户 Runner 不映射宿主机公开端口，只连接内部 Runner 网络；
- PostgreSQL 和 Redis 不向公网暴露，Runner 默认不能直接访问控制面数据库；
- Runner 访问模型 API 和受控远程 MCP 时采用出站网络策略，不能访问 Docker 宿主机管理面。

直接挂载 Docker Socket 等价于给服务很高的宿主机权限。生产部署应将 Runner Manager 单独运行、限制其 API、文件权限和调用来源，并评估使用受限 Docker Socket Proxy；Control Plane 不得透传任意镜像名、挂载路径、环境变量或容器命令。

### 3.2 组件职责与禁止事项

| 组件 | 负责 | 不负责/禁止 |
|---|---|---|
| Company Web / Workbench | 登录后外壳、模型设置、知识、任务、日报、管理页和返回对话入口 | P0 不自行实现对话事件渲染，不直接连接 Runner，不保存或回显完整密钥 |
| DSH Web（P0 过渡） | 会话列表、对话交互、流式事件和 Tool 过程展示 | 不决定公司身份/业务权限，不保存知识、任务或日报业务事实，不作为长期公司 UI 基座 |
| Control Plane/Gateway | 身份认证、授权、所有权校验、配置 API、会话索引、审计、Runner 路由 | 不直接操作 Docker，不信任客户端提供的用户路径或 Runner 地址 |
| Business API / Knowledge 模块 | 提供契约一致的 Knowledge fake API 和 Provider；后续适配真实知识服务 | fake 不冒充真实解析、ACL、向量检索或 MCP 联调结果；真实接入前不调用或修改现有 RAG |
| Business API / Tasks 模块 | 需求、子任务、指派、状态历史和审核结果 | 不根据前端传入的 `manager=true` 决定权限，不把 AI 输出直接当作已发布任务 |
| Business API / Daily Reports 模块 | 日报 CRUD、AI 改写、日期筛选和部门视图 | 不让普通成员查看他人日报，不让 AI 改写自动发布 |
| Runner Manager | Runner 生命周期、租约、健康检查、资源限制、容器网络和挂载 | 不处理公司业务权限，不接受浏览器请求，不决定用户是否有权访问 Session |
| DSH Runner | 执行单个用户的 Agent、Tool、Session Persistence 和 Workspace 操作 | 不根据请求切换用户，不访问其他用户卷，不作为公网服务 |
| PostgreSQL | 用户、授权、资源所有权、配置密文、审计和状态索引 | 首版不存储完整 Session Event 流 |
| Redis | Runner 路由缓存、Session 写租约、短期限流和分布式锁 | 不作为权威持久化数据库，不单独决定访问权限 |

### 3.3 请求信任链

每次转发到 Runner 的请求都应沿同一条信任链处理：

```text
已验证的本地 Web Session / 未来身份提供方声明
  -> Control Plane 映射内部 user_id / tenant_id
  -> Runner Manager ensureRunner(user_id)
  -> 把所有 DSH Web 流量固定到该用户 runner_id
  -> 已有 session/workspace：校验 PostgreSQL 归属或固定 Runner 内的用户命名空间
  -> 新建 session/workspace：只允许写入该 Runner 的用户卷，创建后幂等登记所有权
  -> Gateway 向该 Runner 注入短期内部身份
  -> Runner 校验 audience、runner_id、user_id 和过期时间
```

`user_id`、`tenant_id`、卷路径、镜像、容器命令和 Runner 地址都不能由浏览器自由提交。Runner 的用户身份在容器创建时固定，运行期间不可通过普通请求切换。

对于 `/company-api/v1/knowledge|requirements|tasks|daily-reports`，Gateway 先验证浏览器 Session/CSRF，再用不超过 60 秒的签名 Actor Token 将 `tenant_id/user_id/department/role/request_id` 传给 `business-api`。Gateway 必须删除浏览器伪造的内部 Header，`business-api` 必须验证 token 并再次按资源 owner/部门授权；它不直接依赖 `platform.web_sessions`，因此两个 worktree 可以只依赖冻结身份 claims 并行实现。

对话 Agent 查询业务数据时使用同一套 Business API 和 PostgreSQL 权限，不复制业务表，也不依赖 RAG 同步。固定用户 Runner 只能向 Control Plane 内部 `Agent Tool Gateway` 提交白名单只读意图；Runner 用派生身份密钥签发 60 秒 JWT，Control Plane 重新验证活跃 Runner、账号、租户和部门身份，再签发同样的 Business Actor Token。模型不能提交 `user_id`、`tenant_id`、`department_id`、服务 URL、Header 或 Token，也不能构造任意上游路径。

P0 官方 DSH Web 不会先调用 Company Sessions API 再创建会话，因此新 Session 的归属采用“固定用户 Runner/卷先隔离，创建后立即登记”。公司 DSH 插件优先上报 Session 创建/更新事件，Control Plane 定时扫描当前用户的 Session 列表兜底；登记和 reconcile 都必须幂等。Gateway 永远先由登录用户定位 Runner，不得根据浏览器提交的 `session_id` 反向选择其他 Runner。

### 3.4 MVP 本地账号

登录只作为主业务链路的入口，不单独拆分身份服务。首版由 Control Plane 提供最小可用的本地账号密码登录，DSH Runner 不保存员工密码，也不处理浏览器登录。

```text
首次部署通过 CLI 创建 admin
  -> admin 在后台创建员工账号和临时密码
  -> 员工登录并修改临时密码
  -> Control Plane 创建 Web Session
  -> 员工进入 DSH 对话主链路
```

首版只实现：

- 用户名在公司内唯一，密码最少 8 位；
- 使用成熟库的 Argon2id 保存密码哈希，不保存明文或可解密密码；
- `admin` 和 `member` 两种角色；
- `active` 和 `disabled` 两种账号状态；
- admin 可以创建、停用账号和重置临时密码；
- 修改或重置密码后撤销该用户现有 Web Session；
- 登录接口按账号和来源地址做基础限流；
- 随机不透明 Session Cookie，设置 `HttpOnly`、`Secure` 和 `SameSite=Lax`；
- Gateway 在普通 HTTP 和 WebSocket 握手时校验 Session，且不把员工 Cookie 或密码转发给 Runner。

首版不实现公开注册、邮件邀请、自助找回密码、MFA、复杂密码规则、细粒度权限点和独立认证服务。第一个 admin 通过宿主机 CLI 创建；后续账号全部在 admin 页面管理。Web 入口建议仅部署在公司内网/VPN并使用 TLS，未来需要公网开放时再增强认证安全。

业务资源始终关联内部稳定 `user_id`。未来接入 SSO/OIDC/LDAP 时再增加外部身份映射，不影响现有 Session、Workspace 和授权数据。

宿主机或持久卷建议采用以下逻辑结构：

```text
/data/dsh-users/<user-id>/
├── settings.yaml
├── .credentials.yaml              # 仅 P0，生产开放 Tool 前移除
├── skills/
├── sessions/
├── storage/
└── workspaces/
```

容器内可以统一挂载为 `/dsh-user`。这样镜像启动命令不需要知道宿主机真实目录：

```text
用户 A Runner：/data/dsh-users/user-a -> /dsh-user
用户 B Runner：/data/dsh-users/user-b -> /dsh-user
```

用户 A 的容器中不应出现用户 B 的卷或路径。隔离必须由容器挂载、服务端授权和文件权限共同保证，不能只靠路径中的用户名。

## 4. Settings 与 Credentials 隔离

DSH 的用户级配置默认围绕 `DSH_HOME` 工作：

```text
$DSH_HOME/settings.yaml
$DSH_HOME/.credentials.yaml
```

P0 为了先跑通主链路，使用官方本地 Provider 和每用户独立 `.credentials.yaml`。生产开放 Shell、文件 Tool、个人 Skill 或 `stdio` MCP 前，再切换为公司 Credentials Provider，并从用户卷移除该文件。

用户 Runner 启动时，把 `DSH_HOME` 固定到该用户挂载点：

```bash
DSH_HOME=/dsh-user
```

因此，虽然每个容器内都使用 `/dsh-user`，底层实际对应不同用户卷。

### 4.1 Settings 保存什么

普通 Settings 可以保存：

- 默认模型供应商；
- API Base URL；
- 自动发现的模型目录和后台选出的默认模型；
- 温度、最大输出等模型参数；
- 用户界面或 Agent 偏好；
- 已启用的受控 Skill/MCP 标识。

示意配置：

```yaml
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  model: deepseek-chat

preferences:
  language: zh-CN
  temperature: 0.7
```

用户自定义模型 `baseUrl` 与自定义远程 MCP URL 具有相同的 SSRF 风险。首版应优先让用户选择管理员登记的模型端点；如果必须允许自由填写，则请求必须经过统一出站策略，执行 DNS 解析、私网/环回/link-local/metadata 地址拦截、重定向后复查、协议和端口限制，并记录实际目标。仅在表单保存时检查 URL 不足以防止 DNS rebinding。

### 4.2 Credentials 保存什么

密钥不要混入普通 Settings。P0 使用每用户 `.credentials.yaml`，由 Settings API 依据服务端 `user_id` 写入固定路径，文件权限为 `0600`；浏览器不能提交文件路径，也不能再次读取完整 Key。

DSH 官方本地 Provider 创建的 `.credentials.yaml` 虽然是 `0600`，但 Runner 中的 Bash、文件工具和其他同 UID 子进程仍能读取它；官方文档也明确说明这不是对 Agent 的安全边界。每用户容器只能防止用户之间串读，不能防止该用户的 Agent 读取自己的 Provider Key 后将其输出或发送到外部。

因此 P0 固定 Agent Profile 必须关闭 Bash、PowerShell、文件读取、个人 Skill、自定义 MCP 和任意子进程，只保留开发/测试专用的本地只读 fake 知识 Tool，验证“模型对话、Session 持久化、Tool 事件、引用和用户隔离”。这个方案只用于纵向链路验证，不作为真实 MCP 或扩大 Tool 范围后的生产凭据方案。

生产开放 Tool 前，公司 Provider 应从数据库和 KMS/Vault 按固定 Runner 身份读取，并遵循 DSH 的“配置只保存 credential reference、每次操作重新解析”模型：

```text
Settings 只保存 apiKeyRef
  -> LLM/MCP 操作开始时调用 Credentials Provider.resolve(ref)
  -> Provider 使用 Runner 的短期内部身份向 Secret Broker 请求
  -> Broker 校验 tenant_id、user_id、runner_id、ref 和 scope
  -> 仅在当前操作内返回密钥
  -> 不写磁盘、不进入子进程环境、不进入日志和 Session Event
```

生产凭据方案最低安全要求：

- 磁盘和备份加密；
- 数据库只保存密文；
- 浏览器 API 不返回完整密钥；
- 日志、错误和审计记录不打印密钥；
- 支持密钥轮换和撤销；
- Provider 不跨操作缓存解密值；
- Bash、文件 Tool 和 `stdio` MCP 子进程不继承模型/MCP 密钥；
- Runner 停止后使其 Secret Broker 身份和租约立即失效。

### 4.3 不需要为每个用户维护服务器 `.env`

环境变量只是配置注入方式之一，不是隔离机制本身。P0 流程是：

```text
用户在 Web 设置页填写 API URL / Key
  -> 公司 Settings API 校验输入
  -> 按可信 user_id 原子写入该用户的 0600 Credentials 文件
  -> 用户 Runner 通过官方 Local Credentials Provider 读取
```

生产开放 Tool 前演进为：

```text
用户在 Web 设置页填写 API URL / Key
  -> API Key 加密保存
  -> Settings 只向 Runner 提供 credential reference
  -> 每次模型请求由公司 Credentials Provider 按固定 Runner 身份解析
```

在“每用户一个 Runner”架构中，进程环境虽然彼此独立，但它仍可能被同一 Runner 内的 Tool 和子进程读取。因此，普通环境变量只能注入不敏感的运行配置或短期、受众受限的 Runner 身份，不能注入模型 API Key 和 MCP Token。

## 5. Skill 隔离

DSH 文件 Skill Provider 可以从多个根目录扫描 Skill，包括：

```text
<projectRoot>/.dsh/skills
<projectRoot>/.agents/skills
customSkillDirs
<dshHome>/skills
<agentsHome>/skills
```

公司部署时不应无条件启用所有默认扫描根。建议明确配置允许的 Skill 目录，并在强隔离模式下使用：

```yaml
skill:
  dshHome: /dsh-user
  customSkillDirs:
    - /opt/company-dsh/company-skills
    - /dsh-user/skills
  includeDefaultRoots: false
```

Skill 分层建议：

| 类型 | 目录示例 | 可见范围 | 可修改者 |
|---|---|---|---|
| DSH 内置 Skill | 镜像内置 | 全员 | DSH 上游 |
| 公司公共 Skill | `/opt/company-dsh/company-skills` | 全员 | 公司开发者 |
| 部门 Skill | `/opt/company-dsh/department-skills/<department-id>` | 部门成员 | 公司管理员 |
| 个人 Skill | `/dsh-user/skills` | 当前用户 | 当前用户或管理员 |

部门 Skill 不一定要复制到每个用户卷。Gateway/Runner Manager 可以根据登录用户的部门和授权，给 Runner 增加对应的只读挂载。

需要禁止普通用户自行提交任意服务器绝对路径作为 `customSkillDirs`。用户只能选择系统已经登记和授权的 Skill，或操作自己卷中的个人 Skill。

## 6. MCP 隔离

DSH MCP Client 的每个 MCP Server 是一个插件实例，常见传输方式包括 `streamable-http` 和 `stdio`。两种方式的风险边界不同。

### 6.1 远程 MCP

每位用户可以拥有不同的：

- MCP Server URL；
- HTTP Header 和 Token；
- 启用状态；
- 可使用的 Tool；
- 超时和调用配额。

推荐保存在公司数据库，而不是让用户直接编辑 Runner 文件：

```text
user_mcp_configs
├── id
├── user_id
├── server_name
├── transport
├── url
├── encrypted_headers
├── enabled
└── policy_id
```

Runner 启动时只生成或加载当前用户的 MCP 插件配置。

自定义远程 URL 必须防止 SSRF，至少阻止访问：

- `127.0.0.0/8`、`::1` 等本机地址；
- 云平台 metadata 地址；
- 未授权的公司内网地址；
- 重定向后进入的私有地址；
- 非允许协议和异常端口。

更稳妥的首版是只允许管理员登记的 MCP Server，员工只能连接、授权和启停，不能填写任意 URL。

### 6.2 本地 stdio MCP

`stdio` MCP 是 Runner 启动的本地子进程。其隔离要求包括：

- 在当前用户 Runner 容器或更严格的临时沙箱中运行；
- `cwd` 只能指向当前用户 Workspace；
- 只传必要的环境变量，不继承全部 Runner 环境；
- 只挂载允许访问的用户目录；
- 不挂载宿主机根目录或其他用户卷；
- 不挂载 Docker Socket；
- 限制 CPU、内存、进程数、执行时间和网络；
- 不允许普通用户上传并执行未经审核的 MCP Server 代码。

即使 Settings 和 Session 已分开，一个拥有过大文件权限的 `stdio` MCP 仍可能突破用户隔离，因此它必须纳入容器安全边界。

### 6.3 知识入口与 fake 实现（P0 开发路径）

P0 不连接、部署或修改现有 `freshpi-ai/rag-mcp`，也不启动任何 fake MCP Server。平台先固化与它兼容的知识工具契约和配置槽位，由 `extensions/company-dsh` 注册同名的本地只读 Tool，并让 `FakeKnowledgeProvider` 从 fixtures 返回结果。这样可以测试 Agent 调用、Tool 事件、引用和 Session，但明确不测试 MCP 传输、认证或真实 ACL。

逻辑配置只允许管理员或部署系统修改：

```yaml
knowledge:
  provider: fake | remote-mcp
  remote_mcp_enabled: false
  mcp_url: <reserved; unused in fake mode>
  auth_secret_ref: <reserved; unused in fake mode>
  allowed_tools:
    - get_current_user
    - search_knowledge
    - list_knowledge_documents
```

普通员工不能填写 MCP URL、Header 或 Token。当前开发实现 `provider: fake` 的运行路径，同时保留 `remote-mcp` 配置 schema、Runner 配置物化入口和默认关闭的启用开关，但不连接服务器、不签发 Token、不执行真实 MCP 测试。缺少显式启用、URL 或密钥时选择 `remote-mcp` 必须启动失败，不能静默回退 fake；生产配置也禁止 `provider: fake`。

工具名称和输入输出以已核对的现有 RAG 基线为目标契约：

```text
get_current_user()
search_knowledge(query, category?, top_k?)
list_knowledge_documents(status?, category?, limit?)
```

`search_knowledge` 的结果保持 `query + count + results[]` 结构，结果项至少包含 `document_id`、`knowledge_id`、`version`、`title`、`file_name`、`category`、`visibility`、`heading_path`、`content`、`line_start`、`line_end` 和 `score`。Tool 参数始终不包含 `user_id`、部门 ID、服务 URL 或 Token。

fake 调用链如下，不经过 MCP Client 或网络：

```text
官方 DSH Web
  -> 当前用户的 DSH Runner / Agent Loop
  -> company-dsh 本地 search_knowledge Tool
  -> KnowledgeToolPort
  -> FakeKnowledgeProvider
  -> 固定 fixtures：公司公共知识 + 当前测试用户个人知识
```

Runner 启动时把固定的测试 `user_id` 注入 `KnowledgeToolContext`；`FakeKnowledgeProvider` 用该上下文选择 fixtures，不从 Tool 参数或浏览器读取用户。测试数据至少包含两名用户、三类公司文件、两组互不相同的个人文件、可命中和无结果查询，以及带行号和标题路径的引用。搜索规则保持确定性，同样输入必须返回同样排序，确保 E2E 不受随机性影响。

Company Workbench 通过 `/company-api/v1/knowledge/*` 访问公司 Knowledge API 契约。开发期由 fake handler 返回文件列表、上传进度、失败重试、归档和重建索引等状态；前端不得直接导入 fixture 文件或根据 `provider` 写两套页面逻辑。后续真实接入时，由 Gateway 将该契约代理或适配到真实知识服务。

建议目录为：

```text
packages/contracts/knowledge/       # MCP Tool schema + Company Knowledge API schema
packages/test-fixtures/fixture-v1.json # 确定性公司/个人样例和检索预期
services/business-api/               # Knowledge fake Provider/API 实现
```

### 6.4 真实 MCP 接入边界与当前状态

目标 RAG 基线已经核对：

```text
repository: /Users/freshpi/Documents/freshpi-ai/rag-mcp
branch: main
reviewed commit: ef68e4d59519992c72b0b9c8053d89f602760669
transport: Streamable HTTP MCP at /mcp
```

该基线已有 FastAPI、FastMCP、PostgreSQL/pgvector、MinIO、异步入库、混合检索、公司/个人知识 ACL 和审计能力。当前公司知识分类固定为 `company-information`、`xiaopai-design`、`patent-document`，个人知识不分类；fake fixtures 和契约应按这个现状构造，减少后续切换差异。

截至 2026-08-28，Runner 到现有 MCP 的读链路已经实现：

1. `platform.knowledge_provider_configs` 保存受控 HTTPS MCP URL 和只读 Tool 白名单。
2. `platform.rag_user_bindings` 将平台 `user_id` 绑定到 RAG 员工身份，PAT 使用现有 AES-256-GCM 密钥加密保存在 `platform.secrets`。
3. Control Plane 只在物化该用户 Runner 时解密 PAT；PAT 只进入权限 `0600` 的用户 `.env`，Cordis 配置只引用环境变量。
4. 固定 Company Agent preset 通过官方 `@deepseek-ai/dsh-mcp-client` 连接 Streamable HTTP MCP。
5. 当前只允许 `get_current_user`、`search_knowledge`、`list_knowledge_documents`，其他 MCP 工具执行被 Runner 策略拒绝。
6. Runner 配置版本合并模型、租户知识源和员工绑定版本；PAT 轮换后下次打开 `/chat` 会自动换用新 Runner。

已用平台测试用户 `wdl` 完成运行态验证：Company preset 能创建 DSH Session，MCP `get_current_user` 返回同一名 `wdl` 员工。这证明身份、PAT 和 DSH MCP Client 装配链路可用；生产启用仍必须完成 14.4 的双用户 ACL、真实检索/引用、超时恢复和撤销测试。

切换到 `remote-mcp` 时关闭本地 fake Tool，再由 DSH MCP Client 加载真实 MCP 的同名工具，避免同名冲突。若真实 MCP 与已锁定契约一致，切换不修改 Company Web、DSH Session、Agent Prompt 或工具结果解析。只有契约测试证明存在差异时，才在 `integrations/rag-mcp` 增加薄适配。

### 6.5 Agent 查询系统业务内容

“系统内容可由对话 Agent 查询”在首版定义为：Agent 可以读取当前登录用户在 Company Workbench 中有权限看到的非秘密业务数据。首批统一注册一个本地只读 Tool：

```text
query_company_system(resource, record_id?, work_date?, date?, view?, status?, from?, to?, cursor?, limit?)

resource:
  requirements | requirement
  tasks | task
  daily_reports | daily_report
  department_daily_reports
```

知识仍使用 `get_current_user`、`search_knowledge` 和 `list_knowledge_documents`，不重复塞进统一 Tool。系统查询的具体权限与 Web 完全一致：员工可查自己可见的需求/任务和本人日报；只有组织 `manager` 能查自己部门的部门日报，且部门 ID 由服务端绑定。详情查询继续由 Business API 校验资源可见性，知道 UUID 不等于有权读取。

```text
DSH Agent
  -> Runner 内 query_company_system
  -> Runner 派生密钥签发 60 秒身份 JWT
  -> Control Plane /internal/v1/agent-tools/query-company-system
  -> 校验 tenant/user/runner/request + 活跃状态
  -> 按白名单映射固定 Business API GET 路径
  -> 签发 Business Actor Token
  -> Business API 权限策略
  -> PostgreSQL 最新业务数据
```

这条链路无需 RAG：需求、任务和日报是结构化业务数据，Web 修改成功后，Agent 下一次查询直接读到同一数据库中的最新结果，不维护第二份索引或同步队列。RAG/MCP 只负责知识文档检索；后续接入真实 RAG 不改变系统业务查询链路。

首版明确禁止以下内容进入 Tool：账号密码、密码哈希、模型 URL 配置中的完整 API Key、内部服务 Token、Runner 派生密钥、MCP/RAG 凭据和其他用户秘密。首版也不允许 Agent 通过该 Tool 创建、修改、发布或删除需求、任务、日报；写操作继续在 Company Workbench 中由用户明确确认。Tool 调用和结果写入当前 DSH Session Event，便于历史恢复和问题追踪，但不得记录任何完整密钥。

## 7. Session 与上下文隔离

DSH 的 JSONL Session Persistence 需要明确配置存储根目录。每个用户 Runner 使用：

```text
root=/dsh-user/sessions
```

持久化结构大致为：

```text
/dsh-user/sessions/
└── --<normalized-workspace>--/
    └── <encoded-session-id>/
        └── session.jsonl.zstd
```

### 7.1 上下文不只是聊天文字

需要隔离的上下文通常包括：

- 用户消息；
- Assistant 回复和流式分块；
- Tool 调用及返回值；
- Turn 和 Step；
- 选用的 Agent Profile；
- 模型选择和请求历史；
- Skill 注入内容；
- 与 Workspace 文件有关的上下文。

Session Event 负责持久化对话和运行事件；Skill、MCP、Credentials 和 Workspace 由各自的用户边界隔离。只隔离聊天记录而共享 Workspace，仍会造成文件上下文串用。

### 7.2 Gateway 必须再次校验 Session 所有权

即使每个用户拥有独立 Session 目录，Gateway 仍应维护集中索引：

```text
sessions
├── session_id
├── user_id
├── tenant_id
├── runner_id
├── workspace_id
├── title
├── status
├── last_event_position
├── created_at
└── updated_at
```

对已登记 Session 的普通 HTTP 或 WebSocket 请求都必须验证：

```text
当前登录 user_id
  + 请求中的 session_id
  -> 查询 session.user_id 是否等于当前 user_id
  -> 通过后只能路由到当前用户固定 Runner
```

P0 官方 DSH Web 创建新 Session 时尚没有 PostgreSQL 记录，Gateway 必须先根据当前登录 `user_id` 固定 Runner，只允许在该 Runner/用户卷内创建，再由 Session Index Bridge 登记。如果已有 Session 在 PostgreSQL 中暂时缺失，只能在当前用户固定 Runner 的 Session Provider 中 reconcile 并补登记，不得根据 `session_id` 扫描或选择其他 Runner。

不能因为 Session 文件位于用户目录中，就直接信任客户端传入的 `session_id`。客户端也不应提交实际文件路径。

### 7.3 单 Session 单写者

同一 Session 同一时间应只有一个活动 writer，避免两个请求并发追加事件造成顺序混乱。每用户专属 Runner 可以明显简化这一约束，但 Gateway 仍应为同一 `session_id` 做连接互斥、租约或顺序队列。

### 7.4 Runner 停止后如何恢复上下文

```text
用户一段时间无操作
  -> Runner 完成当前响应并刷新 Session Event
  -> Runner Manager 优雅停止容器
  -> 用户卷继续保留

用户再次访问
  -> Gateway 启动同一镜像的新 Runner
  -> 重新挂载该用户卷
  -> DSH 从 Session Persistence 加载会话
  -> 用户继续对话
```

停止 Runner 只释放计算资源，不删除持久化会话。运行中的流式回复、Tool 调用或 `stdio` MCP 子进程不能被直接强制回收；空闲判定需要考虑当前活动任务。

首版建议使用“每用户独立 JSONL 根目录”。如果后续需要跨节点调度、集中搜索、统计和高可用，再开发 PostgreSQL SessionPersistence Provider。SQLite 也可以每用户单独建库，但不适合作为未来高并发集中会话层的默认选择。

### 7.5 历史窗口和完整记录保证

产品中的一个“对话窗口”对应一个 DSH Session。PostgreSQL `sessions` 是侧边栏和检索用的窗口索引，用户卷中的 DSH JSONL 是消息和运行事件的权威记录。

首版必须保证：

- 侧边栏默认列出当前用户的全部未归档窗口，并可查看已归档窗口；
- 窗口标题、更新时间、运行状态和最后一条消息摘要可从 PostgreSQL 快速列表；
- 打开窗口时按事件顺序还原用户消息、Assistant 回复、Tool 过程、审批、错误和知识引用；
- 当历史较大时可分页/分段加载，但不得只保留最近 N 条；
- 首版不设自动过期或自动删除策略；归档只改变列表可见性，不删除 JSONL；
- 知识检索结果的 `file_id/chunk_id/title/citation` 跟随 Session Event 保存，即使知识索引后续重建，仍能说明当时回答依据。

如果索引与 JSONL 因异常不一致，后台任务从 JSONL 重建标题之外的会话元数据；不用 PostgreSQL 中的摘要覆盖事件正文。

## 8. Workspace 与上传文件隔离

Workspace 必须与 Session 同等级隔离：

```text
/data/dsh-users/user-a/workspaces/<workspace-id>
/data/dsh-users/user-b/workspaces/<workspace-id>
```

Runner 内可以统一映射成：

```text
/dsh-user/workspaces/<workspace-id>
```

Gateway 根据数据库中的 `workspace_id -> user_id` 关系选择路径，不能接受用户传入任意路径。上传文件也要绑定 `user_id`、`workspace_id` 和访问策略。

公司共享知识库不应通过把整个公司文件目录可写挂载给 Runner 来实现。P0 由 fake provider 返回当前测试用户 fixtures；后续由真实 RAG/MCP 执行权限过滤和检索。两种模式都只向 Runner 返回当前身份可见的结果。

### 8.1 Runner 沙箱基线

已核对的 DSH 基础 composition 默认包含 Bash、PowerShell、文件、子进程和本地 Sandbox 等插件。DSH 的权限与 Sandbox 插件属于纵深防御，生产隔离仍必须由容器和宿主机策略兜底。

Runner 容器至少采用：

- 固定的非 root UID/GID，禁止 privileged、host PID/IPC/network namespace；
- `no-new-privileges`、drop all Linux capabilities、受控 seccomp/AppArmor/SELinux profile；
- 只读根文件系统，临时目录使用限额 tmpfs；
- 只挂载当前用户 Workspace/Session/Storage 和授权的只读公司制品；
- 不挂载 Docker Socket、宿主机根目录、SSH agent、云凭据目录和生产密钥文件；
- 限制 CPU、内存、PIDs、打开文件数、单次运行时间、Workspace 容量和上传大小；
- 默认拒绝访问控制面网络、宿主机地址、metadata、其他 Runner 和数据库；
- 出网通过受控 DNS/代理或防火墙策略，只允许模型 API 和已授权远程服务；
- 对进程环境使用 allowlist，不把 Runner Manager、数据库或长期模型/MCP 密钥传给 Tool 子进程。

上传文件落盘前校验大小、类型和文件名，服务端生成存储键；解压缩时限制文件数量、展开总大小、路径穿越、符号链接和硬链接。用户上传的压缩包、Git 仓库和 Skill 都不能通过链接指向 `/dsh-user` 中非 Workspace 区域。

首版应定义至少两个权限 Profile：默认的受限对话 Profile 不开放任意 Shell；确有编码需求的 Workspace Profile 才开放受控 Shell/文件工具，并展示相应审批。是否让全体员工默认拥有代码执行能力属于产品安全决策，不能由 DSH 默认 composition 隐式决定。

## 9. Runner 生命周期

建议状态：

```text
stopped -> starting -> ready -> busy -> idle -> stopping -> stopped
                    \-> failed
```

一次请求的主要流程：

1. 用户登录公司 Web，Gateway 得到可信 `user_id` 和 `tenant_id`。
2. Gateway 根据登录用户固定 Runner；已有 Session/Workspace 校验归属，新建资源则绑定该 Runner 的用户卷并在创建后登记。
3. Runner Manager 查找该用户是否已有健康 Runner。
4. 没有则从统一镜像启动，并只挂载该用户卷及其有权使用的公共只读目录。
5. Runner 加载用户 Settings、Credentials、Skill、MCP 和 Session Provider。
6. Gateway 将请求转发到该 Runner，并记录审计信息。
7. Runner 只使用该用户凭据调用第三方或官方 API。
8. Runner 刷新 Session Event；达到空闲时间后优雅停止。

建议约束：

- 同一用户同一时刻最多一个主要 Runner，减少 Session writer 冲突；
- Runner 端口和内部地址不直接暴露给浏览器；
- 浏览器始终连接 Gateway；
- Runner 原则上使用短期内部身份向公司服务请求资源；P0 fake 从固定 Runner 上下文读取测试身份，不使用网络 Header，真实接入后再绑定员工 PAT 或短期 Token；
- 禁止 Runner 根据请求参数切换到另一个 `user_id`；
- 设置 CPU、内存、磁盘、网络和并发配额。

### 9.1 外部 API 边界

浏览器只连接 Company Gateway 的同源地址，不直接连接 Runner。Gateway 同时承载版本化的公司 REST API 和经过授权的 DSH 原生协议代理。首版至少需要以下资源语义，具体公司 API 路径由 OpenAPI 文件固化：

| 资源组 | 主要能力 | 关键授权规则 |
|---|---|---|
| Identity | 当前用户、租户、角色、退出登录 | 身份来自服务端会话或受信任 Token |
| Model Settings | 查询/修改模型 URL 和 API Key，发现可用模型目录 | Key 只允许写入、轮换、撤销和测试，不返回明文；模型 ID 不由用户手填 |
| Sessions | 创建、列表、读取元数据、归档、继续会话 | 每次按 `tenant_id + user_id + session_id` 校验 |
| Session Stream | 发送消息、接收事件、停止生成、断线恢复 | 获取 Session 写租约；通过 DSH 原生连接协议代理 |
| Workspaces | 创建、列表、上传、下载和删除用户文件 | 客户端只能提交资源 ID，不能提交服务器路径 |
| Organization | 部门、成员和主管关系 | 只有 admin 维护组织；业务端使用服务端部门关系 |
| Knowledge | 知识库/分类/文件列表、上传、删除、入库状态、重建索引 | 公司库全员可见、管理员维护；个人库仅本人管理/检索 |
| Requirements/Tasks | 需求草稿、子任务拆分、发布、指派、状态、审核结果 | 主管管理本部门需求；成员只更新已指派任务 |
| Daily Reports | 草稿、提交、编辑、AI 改写、删除、日期/成员筛选 | 员工管理自己日报；主管只查看本部门 |
| Extensions | 查询授权 Skill/MCP、启停、发起 OAuth/Token 授权 | 只能选择目录中已登记并获授权的条目 |
| Admin | 用户状态、授权、配额、Runner 状态和审计查询 | 仅管理员角色，所有变更写审计事件 |

`Sessions` 资源组定义公司控制面的稳定语义，不要求 P0 DSH Web 在创建前直接调用 Company REST API。P0 由固定用户 Runner 中的 DSH 创建 Session，Session Index Bridge 再把它登记为同一资源模型；后续自研对话页可直接使用公司契约。

已核对的 DSH 原生连接协议使用 HTTP POST 承载 unary/respond RPC，并分别使用下行 WebSocket 承载 `events.mux` 和 `events.host`。P0 由官方 DSH Web 直接消费这些事件，公司业务页不实现另一套对话协议；后续自研对话页才通过 `packages/dsh-client-adapter` 复用该协议。Gateway 必须代理 WebSocket 升级、连接关闭和背压，同时在建立连接前完成用户与 Runner 路由绑定。

DSH 当前的 `/api` Host fence 以 loopback/trusted host 为信任边界，官方说明真正的认证层尚不存在；它不能替代公司登录和资源授权。特别是 settings、credentials、打开本地路径等高权限 RPC，不得因为 Host 校验通过就暴露给远程浏览器。首版采用以下分面：

- 阶段 0 根据官方 DSH Web 的实际请求得到最小 RPC allowlist，覆盖对话、会话、必要事件和必要的只读配置；
- 模型设置、Credentials、Skill/MCP 授权和管理员操作只走 Company REST API；
- DSH Runtime 通过 composition/拦截器禁用不需要的高权限 Host RPC，Gateway 再做第二层 method allowlist；
- Gateway 无法可靠解析或过滤的协议方法默认拒绝，不允许透明转发整个 `/api`；
- 断线后能否恢复正在生成的运行由阶段 0 PoC 验证；不能恢复时必须把运行明确标记为中断。

### 9.1.1 Web 集成策略

公司采用“过渡双 Web”方案：P0 不重复开发对话 UI，而是把锁定版本的官方 DSH `apps/web` 作为对话工作台；Company Workbench 使用公司 Logo 和品牌规范，承载登录、模型设置、知识管理、任务、日报和管理页。这里的 DSH Web 指官方 `apps/web`，不是社区 `dsh-web-ui`。

首选使用同源路由：

```text
/login      -> Company Web 登录
/workbench  -> Company Web 知识/任务/日报/设置
/chat       -> Gateway 根据已登录 user_id 定位 Runner -> 官方 DSH Web
/company-api/v1/* -> Company Gateway 版本化业务 API
```

官方 DSH Host 自身使用 `/api`，公司 REST API 不得与它共用未分区的 `/api/*`。只有当 DSH Web 的静态资源、HTTP RPC 和 WebSocket 都支持 base path 时，才使用 `/chat/*` 完整前缀并将其内部 `/api` 限定在该前缀内。如果上游不支持，阶段 0 改用同站点的 `chat.<company-domain>` 和 `app.<company-domain>`，让聊天子域名独占自己的 `/api`。两种方式都必须经过同一 Gateway 信任链，不允许浏览器直连 Runner。路径前缀、静态资源、WebSocket 升级、Cookie 作用域和断线恢复是阶段 0 必测项。

两个 Web 之间只使用明确导航链接，不使用 iframe：

- DSH Web 增加一个“公司工作台”入口，跳转到 `/workbench`；
- Company Workbench 增加“返回对话”入口，跳转到 `/chat`；
- 两个入口的实际目标由服务端 `workbench_entry_url` / `chat_entry_url` 配置，不在构建产物中写死，以便路径和子域名方案切换；
- DSH Web 当前没有适合主导航按钮的稳定公开 Slot，P0 允许在锁定 commit 上维护一个最小补丁，或使用受契约测试保护的临时 DOM 注入；
- 该补丁只允许包含导航入口和必要的品牌标识，不写入知识、任务、日报、权限或数据访问逻辑；
- 补丁必须以独立 patch 文件保存，构建时应用，升级 DSH 时通过应用失败和 UI 烟雾测试显式暴露兼容性问题。

P0 模型 URL 和 API Key 的唯一可写入口是 Company Workbench Settings API。Control Plane 保存前请求该 Provider 的 `GET /models`，持久化完整模型目录并物化到 DSH Settings；DSH Web 只通过官方原生模型选择器选择当前会话模型。DSH Web 自带的 Credentials/高权限 Settings 写入入口应隐藏或由 Gateway 拒绝，防止出现公司数据库和用户卷两套互相覆盖的配置。阶段 0 开发调试可临时使用官方设置页，但不作为 P0 用户流程。

业务数据必须保持单一权威来源：

| 数据 | 权威来源 | DSH Web 的角色 |
|---|---|---|
| 对话正文、Tool 事件和原始引用 | 用户卷中的 DSH Session Event | 创建、继续和展示 |
| 会话归属、索引和状态 | Company PostgreSQL | 不做授权决策 |
| 模型配置和凭据 | Company Settings/Secret Service；P0 物化到当前用户卷 | 只读使用 |
| P0 知识 fixtures 与模拟状态 | `packages/test-fixtures/fixture-v1.json` + fake provider | 只用于开发测试，不作为生产业务事实 |
| 后续真实知识文件、分类、ACL 和索引 | 真实 RAG Service | DSH 只通过受控 remote MCP 检索；Workbench 通过 Company API 契约访问 |
| 需求、子任务和审核 | `business-api` Tasks 模块 | 后续可通过受控 Tool/MCP 读写 |
| 日报和修订 | `business-api` Daily Reports 模块 | 后续可通过受控 Tool/MCP 读写 |

| DSH 能力 | P0 决策 | 后续目标 |
|---|---|---|
| Agent Loop / Runner | 使用 | 继续使用 |
| Session / Event | 使用 | 继续使用，历史无需迁移 |
| Profile / Plugin / Provider / MCP | 使用 | 继续使用 |
| 官方 DSH `apps/web` | 作为对话工作台 | 自研对话页稳定后退回开发/升级对照用途 |
| `packages/dsh-client-adapter` | 只做接口调研，不阻塞 P0 | 自研对话页对 DSH 协议的唯一适配层 |
| 社区 `dsh-web-ui` | 不安装为主站依赖 | 只参考交互和已验证的连接方式 |

后续替换对话层时，自研页面优先将锁定版本的 `@deepseek-ai/dsh-client-connection` 封装到 `packages/dsh-client-adapter`，对业务页提供创建/恢复会话、发送消息、订阅统一事件和停止生成等稳定能力。若官方客户端包无法承载所需能力，则在 `dsh-runtime` 中增加公司适配 API。切换只改变 `/chat` 的前端路由，不更换 Runner、Session Provider、MCP 或业务数据来源。

2026-08-18 对用户补充的 UI 参考仓库进行了只读核对：

```text
repository: https://github.com/zhu1090093659/dsh-web-ui
default branch: main
reviewed commit: 878a66b5fbc3b32fad199bfc9cbac2dcd05d826d
license: Apache-2.0
```

该仓库定位为 DSH Web GUI 的插件/皮肤集合，并非可独立嵌入公司应用的完整 Web 框架。其 `dsh-task-board` 包确实包含 React 看板、Host 调度、本地存储和 DSH Session 执行代码，但通过 DSH profile/Cordis patch 注入官方 `dsh web`，且数据模型面向单 Host 个人任务，没有公司所需的部门权限、需求/子任务关系、多人指派和结构化审核。

因此首版选择：

- 不直接安装 `dsh-web-ui-all` 作为公司前端；
- 不复用该仓库的背景、皮肤、品牌、颜色和页面视觉；
- 只参考截图中的信息架构：左侧主导航 + 会话列表 + 主内容区，以及看板的状态列、顶部筛选和任务卡片；
- 如后续选择性移植某个通用代码片段，必须固定上游版本、保留 Apache-2.0 许可与归属声明，并重写视觉层和公司业务数据适配层。

### 9.2 Control Plane 与 Runner Manager 契约

Runner Manager 的内部接口只表达受控意图，不暴露通用 Docker 参数：

```text
ensureRunner(user_id, tenant_id, config_version)
  -> runner_id, state, internal_endpoint, lease_expires_at

getRunner(runner_id)
  -> state, health, active_runs, last_activity_at

stopRunner(runner_id, reason, grace_period)
  -> operation_id

reconcileRunner(runner_id)
  -> actual_state
```

接口必须具备以下性质：

- `ensureRunner` 幂等；同一用户的并发调用只能得到同一个主要 Runner；
- Runner Manager 根据服务端模板生成镜像、命令、挂载和资源限制，不接受调用方覆盖；
- `config_version` 用于判断 Settings、Credentials 或 MCP 变更后是否需要重启 Runner；
- 创建成功后先通过健康检查，再把内部路由标记为 `ready`；
- 停止操作先阻止新运行，等待活动运行结束或达到宽限期，再停止容器；
- Manager 定期 reconcile PostgreSQL/Redis 记录和 Docker 实际状态，清理失效租约和孤儿容器。

### 9.3 Gateway 与 Runner 契约

Gateway 向 Runner 发放短期、限定受众的内部身份，至少包含：

```text
issuer, audience, tenant_id, user_id, runner_id,
session_id, workspace_id, scopes, config_version,
issued_at, expires_at, request_id
```

Runner 必须验证签名、`audience`、过期时间、`runner_id` 以及请求资源是否与固定用户身份一致。内部身份有效期应覆盖一次请求但保持足够短；长时间 Tool 任务采用可续租的运行租约，不能使用永久内部 Token。

## 10. 产品功能与业务链路

### 10.1 Company Workbench 信息架构

首屏直接进入可使用的工作台，不做营销落地页。Company Workbench 使用公司 Logo、主辅色、字体和图标规范重建 Design Tokens，不沿用 DeepSeek 或参考仓库的皮肤、动漫背景和装饰。P0 的 DSH Web 保留官方对话布局，只增加公司 Logo/工作台入口所需的最小变更，不在过渡页上重做整套主题。

```text
公司 Logo + 主导航
├── AI 对话 -> /chat（P0 官方 DSH Web）
├── 知识库
│   ├── 公司知识
│   └── 个人知识
├── 需求与任务
│   ├── 我发布的
│   ├── 分配给我的
│   ├── 未完成 / 已完成
│   └── 看板 / 任务详情 / 自动审核
├── 日报
│   ├── 我的日报
│   └── 部门日报（主管）
└── 设置 / 管理
    ├── 模型 URL、API Key、自动发现的模型目录
    └── 用户、部门和 Runner（admin）
```

截图中的左侧导航和主看板可作为 Company Workbench 布局参考。知识库以可扫描的分类/文件列表为主；任务使用看板；日报使用按日期分组的紧凑卡片或列表。三者共享顶部筛选和详情抽屉的交互规则，但不强行把所有数据都做成卡片。

### 10.2 AI 对话与历史（P0 使用官方 DSH Web）

对话页承担 DSH 主链路，而不是普通的一问一答页。P0 先使用官方 DSH Web 已有的交互和事件渲染，阶段 0 应验证它能表达：

- 用户消息、Assistant 流式回复、思考/运行状态；
- Tool 调用、结果、用户审批、用户问题和错误；
- 附件、Workspace 文件和子 Agent/子流程事件；
- 知识检索引用，点击可查看文件名、分类和引用片段；
- 停止生成、断线重连、失败重试和中断状态。

P0 的固定 Profile 为了保护本地 Credentials 会暂时禁用高风险 Tool，但验收不应因此简化成只支持纯文本；fake `search_knowledge` 的 Tool 调用、结果和引用，以及只读 `query_company_system` 的调用和业务结果，都必须可见并写入 Session。待公司 Credentials Provider 完成后，再接入真实知识 MCP 并恢复经审核的其他 DSH Tool 能力。

会话窗口至少支持新建、打开和保留全部历史；重命名、归档和按标题搜索先核对官方 Web 已有能力，缺失项不通过大规模 fork 补齐，而是按业务必要性在 Company Session API 或后续自研对话页实现。首版不提供硬删除。任何会话的重新打开都必须从权威 Session Event 恢复全部历史，而不是只显示数据库摘要。

### 10.3 公司与个人知识库

知识库管理和 Agent 检索使用两类契约、同一批 fake fixtures；真实接入后再落到同一套 RAG 权限数据：

```text
Web 管理页 -> Company Knowledge API -> fake handler
DSH Agent   -> 本地 Knowledge Tool   -> FakeKnowledgeProvider

后续切换：fake handler/本地 Tool -> 真实 RAG HTTP API + /mcp
```

管理页最少展示：

| 视图 | 用户可见内容 | 可执行操作 |
|---|---|---|
| 公司知识 | fake 中的三个固定分类、文件名、类型、大小、更新时间、审核/入库状态 | 全员浏览/搜索；平台 admin 可在 fake 流程中测试上传、审核、归档/恢复和重建索引，不做移动分类 |
| 个人知识 | 当前测试用户未分类的 fake 文件和入库状态 | 本人在 fake 流程中测试上传、归档/恢复、重建索引和检索 |

Workbench 契约沿用目标 RAG 的文档审核状态和异步入库任务状态，并可把 `queued/running/succeeded/failed` 等技术状态显示为更易懂的阶段。fake handler 只模拟状态迁移，不承担真实解析或向量计算。失败必须展示可理解原因并允许重试；后续切换真实服务时页面状态模型不变。

### 10.4 需求、子任务和自动审核

需求是业务目标，子任务是可指派和执行的最小单元，两者不合并为一张表。推荐的发布链路为：

```text
主管创建需求草稿
  -> AI 根据目标/验收条件生成子任务草稿
  -> 主管调整标题、顺序、依赖、负责人和验收条件
  -> 确认发布
  -> 成员执行并提交结果/证据
  -> 自动审核产生结构化结果
  -> 主管验收或退回
```

“AI 先拆分，主管确认后再发布”是首版冻结规则。AI 不得在无人确认的情况下直接指派给员工，因为需求边界和工作量在草稿阶段最容易需要人工调整。

任务看板列固定为：

```text
planning -> todo -> in_progress -> review -> done
                              \-> failed
planning/todo/in_progress/review/failed -> cancelled
failed -> in_progress
review -> in_progress
```

看板顶部提供“我发布的、分配给我的、未完成、已完成”快速视图，并可按需求、负责人、状态和时间筛选。任务卡片显示标题、所属需求、负责人、更新时间、截止时间和最新审核结论；详情页显示描述、验收条件、依赖、状态历史、提交证据和审核记录。

自动审核结果至少包含 `result(pass/fail/needs_review)`、摘要、检查项、证据链接/附件、模型/规则版本和执行时间。首版自动审核只提供结论和证据，不默认静默将任务改为 `done`。

### 10.5 个人与部门日报

首版建议限制为“每位员工每个工作日一份日报”，状态使用 `draft/published/deleted`。删除采用软删除，首版 UI 不提供恢复入口，但保留审计和必要的运维恢复能力。

员工可以：

- 选择工作日创建日报，保存草稿或提交；
- 在权限范围内编辑或软删除自己的日报；
- 请 AI 对当前草稿进行润色、缩写或结构化，对比后由用户确认覆盖；
- 查看自己按日期分组的历史日报。

主管可以查看自己所管部门全部成员的今日日报，并按日期范围、成员和状态筛选。“今日”按公司时区计算，不使用浏览器时区推导。部门视图默认按成员排列紧凑摘要卡片，点击后查看全文；未提交成员可以在同一视图中显示为“未提交”，但首版不自动发消息催报。

日报正文固定为“今日完成、下一步计划、阻塞/风险、其他说明”，并保留可空自由文本；首版不支持附件。

### 10.6 最小组织与业务权限

登录仍然只使用简单的 `admin/member`，但“上级”不能用平台 admin 猜测。首版增加最小组织模型：

```text
departments
  -> department_members(user_id, department_id, org_role)
  -> org_role = manager | member
```

| 身份 | 主要能力 |
|---|---|
| 平台 `admin` | 创建/停用账号，维护部门与主管关系，管理公司知识文件 |
| 组织 `manager` | 发布本部门需求/任务，验收结果，查看本部门日报 |
| 组织 `member` | 执行分配给自己的任务，管理自己的日报 |

平台 admin 不因为管理账号就默认拥有所有员工的个人会话和个人知识读取权；这些仍按资源 owner 校验。首版不做通用权限点配置器，上述规则固定在服务端并用自动化测试覆盖。

## 11. 公司代码如何与 DSH 保持独立

为了后续跟进 DSH 上游更新，公司能力应尽量放在边界层：

```text
company-web/
├── Web 页面
├── Gateway 与认证
├── Runner Manager
├── 用户设置和凭据服务
├── Session/Workspace 所有权服务
└── 公司业务 API

company-dsh-extensions/
├── Profiles
├── Skills
├── Credentials Provider
├── SessionPersistence Provider（后续）
└── 审核过的 MCP 集成

deepseek-harness/
└── 尽量保持上游源码原样
```

依赖方式建议：

1. 锁定一个经过验证的 DSH commit/tag；
2. 公司扩展通过 DSH 的 Profile、Plugin、Provider、Skill 和 MCP 接口接入；
3. 不把登录、组织权限、任务业务和知识库状态机写进 DSH 核心；
4. 必须修改核心时，保持为少量独立补丁，并记录原因和上游对应版本；
5. 升级时构建一个候选镜像，跑兼容测试后逐步替换 Runner；
6. 用户卷和公司数据库独立于镜像，升级镜像不重建用户数据。

这里的“公司代码独立”不是单纯换一个目录，而是让依赖方向保持为：

```text
公司系统 -> 调用 DSH 扩展接口
DSH 核心  -> 不反向依赖公司业务
```

### 11.1 推荐的 Monorepo 模块

首版使用一个 pnpm Monorepo 保存公司自研代码，DSH 上游以 Git submodule 固定到已冻结 commit。submodule 保持自己的 workspace/lockfile，不进入公司根 workspace；公司入口补丁存放在 `runtimes/dsh-runner/patches`，不直接修改 submodule。

```text
company-dsh/
├── apps/company-web/                # Workbench 页面、导航、路由和权限门
├── services/
│   ├── control-plane/               # Gateway、授权、配置和资源所有权
│   ├── runner-manager/              # Docker Runner 生命周期
│   └── business-api/                # 模块化单体
│       └── src/modules/
│           ├── knowledge/           # Knowledge fake API / Provider
│           ├── tasks/               # 需求、子任务、状态和审核
│           └── daily-reports/       # 日报 CRUD、AI 改写和部门查询
├── integrations/
│   └── rag-mcp/                     # 目标版本锁、契约映射和后续真实接入适配点
├── runtimes/
│   └── dsh-runner/                  # Runner 镜像、DSH Web 桥接/最小补丁和运行时装配
├── extensions/
│   └── company-dsh/                 # Profile、Provider、Skill、本地 fake Tool 和远程 MCP 配置槽位
├── packages/
│   ├── contracts/                   # company/internal OpenAPI、Tool schema、生成类型
│   ├── db/                          # 冻结 DDL 基线、platform/business migrations
│   ├── test-fixtures/               # fixture-v1，MSW/fake/test 共同消费
│   ├── dsh-client-adapter/          # P0 后自研对话页对 DSH 协议的唯一适配层
│   ├── ui/                          # 公司 Logo、Design Tokens 和通用组件
│   └── observability/               # 日志、指标和 trace 公共约定
├── deploy/
│   ├── compose/                     # 常驻服务编排
│   ├── images/                      # 镜像构建
│   └── policies/                    # 网络、资源和安全策略
├── tests/
│   ├── contract/                    # 跨组件契约测试
│   ├── integration/                 # 数据库、Redis、Docker 集成测试
│   └── e2e/                         # 浏览器和多用户隔离验收
├── vendor/deepseek-harness/         # 锁定 commit 的 Git submodule
└── docs/
    ├── design/                      # 本设计及专题设计
    └── adr/                         # 已确认的架构决策
```

上述目录保持清晰的逻辑模块，但前期不把每个模块拆成长期 worktree。二十人左右的首版项目固定使用三个并发工作槽；`business-api` 内三个业务域共享 Fastify 外壳和身份策略，但通过 module/repository/provider 边界隔离。

启动时直接消费以下冻结文件，不得在任一长期功能分支中单方面修改：

```text
三Worktree并发开发启动基线.md
packages/contracts/openapi/company-api.v1.yaml
packages/contracts/openapi/internal-api.v1.yaml
packages/contracts/schemas/tools/knowledge.v1.schema.json
packages/db/baseline/platform-v1.sql
packages/db/baseline/business-v1.sql
packages/db/baseline/business-fake-v1.sql
packages/test-fixtures/fixture-v1.json
```

### 11.2 Worktree 拆分与目录所有权

首次并行开发前，先用一个短期 bootstrap 分支完成 Git 初始化、Monorepo 骨架、根依赖、基础 Contracts/DB 目录和空的服务/页面入口，合并后再从同一个基线 commit 创建三个 worktree。bootstrap 是一次性前置步骤，不占用长期并发槽。

| 并发 worktree/分支 | 主要负责目录 | 前期交付顺序 |
|---|---|---|
| `feat/core-platform` | 根工程配置、`services/control-plane`、`services/runner-manager`、`runtimes/dsh-runner`、`extensions/company-dsh`、`deploy`、平台 Contracts/DB/observability | 登录与模型配置 -> 每用户 Runner -> DSH Web 桥接 -> 可配置 Knowledge MCP 槽位/fake 模式 -> Session 索引/恢复 -> P0 集成 |
| `feat/company-web` | 全部 `apps/company-web`、`packages/ui` | Workbench 外壳/品牌 -> 登录和设置 -> `/chat` 双向入口 -> 知识 UI -> 任务/日报 UI；后端未完成前使用契约 mock |
| `feat/business-services` | `services/business-api`、`integrations/rag-mcp`、`packages/test-fixtures`、业务 migrations | 先完成知识本地 fake Provider/API -> 再完成需求任务 -> 最后完成日报；当前阶段不修改外部 RAG |

这三个名称表示并发工作槽，不要求一条分支长期堆积所有功能。每个工作槽可在一个里程碑合并后，从最新 `main` 切换到下一条短期功能分支，但目录所有权不变。

`freshpi-ai/rag-mcp` 是独立 Git 仓库，当前开发阶段保持只读，不创建它的 worktree，也不连接其运行服务。`business-services` 工作槽只在新 Monorepo 中提交目标版本锁、契约、fixtures 和 fake；开发交付后的真实接入若需要修改 RAG，再单独创建短期 worktree。不能为了方便 fake 或并行而把 RAG 源码复制进 `services/knowledge`。

各 worktree 为自己所有的目录编写单元和局部集成测试。跨域 `tests/contract`、`tests/integration`、`tests/e2e` 不再设第四个长期 worktree，而是在关键里程碑合并后由短期 `integration/p0` 或 `integration/mvp` 分支补齐。后续自研对话 UI 复用 `company-web` 工作槽，切换到 `feat/chat-replacement` 分支，不新增第四个并发槽。

如果实际只有两个开发者/代理，则将 `company-web` 和 `business-services` 合并为 `feat/company-product`；`core-platform` 仍保持独立，因为 DSH/Gateway/Runner 链路的调试方式与业务页明显不同。

并行开发约束：

- bootstrap 先将 Contracts 和 DB 按 `platform` / `business` 命名空间分开；`core-platform` 不修改业务 schema，`business-services` 不修改 Runner/身份 schema；
- Company Web 只消费生成类型或 mock，不手工修改后端 OpenAPI/schema；
- 根 `package.json`、workspace 配置和 lockfile 由 `core-platform` 维护；其他 worktree 需要公共依赖时，用小型同步提交先合并到 `main`，再继续开发；
- `packages/ui` 只提供与业务无关的通用组件；业务专用卡片/表单留在自己的 feature 目录；
- `company-web` 独占全局导航、路由和所有前端 feature；其他 worktree 不修改 `apps/company-web`；
- 每条分支必须通过自己的单元测试和契约测试后再进入集成分支；
- `main` 始终保持可构建，集成问题在短期 `integration/*` 分支解决，不长期堆积在 `main`；
- 数据库迁移只向前追加，已被其他 worktree 使用的迁移不得改写历史。

### 11.3 推荐的合并波次

```text
Wave 0（短期 bootstrap，不并行）:
  -> Git/Monorepo 骨架、命名空间 Contracts/DB、空服务/页面和根依赖

Wave 1（3 个并发 worktree）:
  -> core-platform（登录、模型配置、Gateway、Runner、DSH Web、Knowledge MCP 槽位/fake 模式和 Session）
  -> company-web（公司 Workbench 全部前端，基于契约 mock）
  -> business-services（知识契约、本地 fake Tool/API、fixtures，再做 Tasks 和 Daily Reports）

Wave 2（短期 integration/p0）:
  -> 串起登录、DSH Web 路由、模型配置、完整历史和 fake 知识检索
  -> 完成双用户 fixture 隔离、Tool 事件和引用持久化验收

Wave 3（复用 company-web + business-services 工作槽）:
  -> 接入需求/任务看板和自动审核
  -> 接入个人/部门日报

Wave 4（短期 integration/mvp）:
  -> 全域回归、备份恢复、性能和上游兼容验收

Post-dev handoff（不占当前开发 worktree）:
  -> 部署方把 Knowledge Provider 从 fake 切换为真实 remote-mcp
  -> 运行契约、身份、ACL 和引用回归，必要时再开短期 rag-mcp 适配分支

Wave 5（P0 后，复用 company-web 工作槽）:
  -> chat-replacement 基于官方 Web 兼容基准实现公司对话 UI
  -> 切换 /chat 路由，官方 DSH Web 保留为内部调试面
```

在没有 Git 仓库和基础目录之前不能创建 worktree。正式开工时应先初始化主仓库、提交文档和 bootstrap 骨架，再从同一个基线 commit 创建 3 个 worktree；若人手只支持 2 个，则按上述规则合并为 `core-platform` 和 `company-product`。

## 12. 推荐的数据边界

```text
公司共享，只读，跟随镜像或版本化配置发布
├── DSH 运行时
├── Company Workbench 和 DSH Web 最小入口补丁
├── 公司公共 Profile
├── 公司公共 Skill
└── 审核过的 MCP 程序

用户独立，持久化
├── Settings
├── Credentials 文件（仅 P0，固定 Profile 禁用高风险 Tool）
├── 个人 Skill
├── MCP 启用配置
├── Session Event
├── Workspace
└── Workspace 上传文件

公司控制面，集中管理
├── 员工、部门和角色
├── Runner 状态和租约
├── Session/Workspace 所有权
├── Knowledge Provider 配置和后续 RAG 身份绑定槽位
├── 需求、子任务、状态历史和审核结果
├── 日报、修订记录和软删除状态
├── Skill/MCP 授权
├── 用户模型 API Key 和 MCP Token 密文
├── 配额和限流
├── 审计日志
└── 加密密钥管理

后续接入的现有 RAG 服务，集中持久化（不属于当前 fake 开发数据）
├── RAG 员工、Token、部门和知识权限
├── 公司/个人知识元数据、入库任务和 ACL
├── 公司知识库原文
├── 个人知识库原文（按 RAG employee owner 隔离）
└── 文本分块、向量与可重建索引
```

### 12.1 首版核心实体

| 实体 | 关键字段/关系 | 权威存储 |
|---|---|---|
| `tenants` | `id`、名称、状态 | PostgreSQL |
| `users` | 稳定内部 `id`、唯一用户名、显示名、`platform_role`、状态 | PostgreSQL |
| `local_password_credentials` | `user_id`、Argon2id 哈希与参数、修改时间、是否必须重置 | PostgreSQL |
| `web_sessions` | Session Token 哈希、`user_id`、认证时间、活动/绝对过期、撤销时间 | PostgreSQL；Redis 缓存 |
| `departments` | `tenant_id`、名称、状态 | PostgreSQL |
| `department_members` | `department_id + user_id`、`org_role(manager/member)` | PostgreSQL |
| `model_configs` | `user_id`、provider、base URL、默认 `model`、完整 `models[]`、参数、`config_version` | PostgreSQL |
| `secrets` | owner、purpose、ciphertext、key version、状态 | PostgreSQL + KMS/Vault |
| `sessions` | `session_id`、owner、`workspace_id`、标题、状态、最后事件位置/时间 | PostgreSQL；事件正文在用户卷 |
| `workspaces` | `workspace_id`、`tenant_id`、`user_id`、逻辑名称、存储引用 | PostgreSQL + 用户卷/对象存储 |
| `knowledge_provider_configs` | `provider(fake/remote-mcp)`、受控 endpoint、allowed tools、auth secret ref、`config_version` | Company PostgreSQL/部署配置 + Secret Service |
| `rag_user_bindings`（后续启用） | 平台 `user_id`、RAG `employee_id`、PAT/Token secret ref、状态、版本 | Company PostgreSQL + Secret Service |
| RAG `employees` / `employee_tokens`（外部） | 真实 MCP 调用身份、部门/角色和 Token 生命周期 | 后续接入的现有 RAG PostgreSQL |
| RAG `knowledge_documents` / versions / chunks / ingestion jobs（外部） | 公司/个人范围、固定分类、文件版本、入库状态、片段、向量和引用 | 后续接入的现有 RAG PostgreSQL/pgvector + MinIO |
| `requirements` | 发布人、部门、标题、目标、验收条件、草稿/发布状态 | PostgreSQL |
| `tasks` | `requirement_id`、负责人、父子/依赖、状态、截止时间、验收条件 | PostgreSQL |
| `task_status_history` | task、from/to status、actor、reason、time | PostgreSQL |
| `task_review_runs` | task、`pass/fail/needs_review`、检查项、证据、执行器/模型版本、时间 | PostgreSQL + 对象存储 |
| `daily_reports` | `user_id + work_date` 唯一、部门快照、结构化正文、状态、提交/删除时间 | PostgreSQL |
| `daily_report_revisions` | report、editor、修订前后内容/差异、来源(manual/ai)、时间 | PostgreSQL |
| `runner_instances` | `runner_id`、`user_id`、镜像版本、状态、启动/停止时间 | PostgreSQL |
| `runner_leases` | user、runner、holder、过期时间、fencing token | Redis 短租约；必要字段回写 PostgreSQL |
| `skill_catalog` / `skill_grants` | 版本化 Skill 及用户/部门授权 | PostgreSQL + 只读制品 |
| `mcp_catalog` / `mcp_grants` | MCP 定义、策略和用户/部门授权 | PostgreSQL |
| `mcp_credentials` | 用户授权产生的 Token 密文引用 | PostgreSQL + KMS/Vault |
| `audit_events` | actor、action、resource、result、request id、时间 | PostgreSQL 或公司审计平台 |

所有用户资源表都必须显式保存 `tenant_id` 和 owner，所有部门业务资源必须保存 `department_id`，不能仅依赖当前用户关系或目录位置推导。即使首版只有一个公司租户，也保留 `tenant_id`，但不实现跨租户共享或租户自助管理。

### 12.2 PostgreSQL、Redis 与用户卷的一致性

- PostgreSQL 是资源所有权、配置版本和审计记录的权威来源；
- Redis 中的路由和租约丢失后必须能从 PostgreSQL 与 Docker 实际状态重建；
- 用户卷中的 Session Event 是首版会话正文的权威来源，PostgreSQL 保存可重建的索引；
- P0 由官方 DSH Web 在固定用户 Runner/卷中创建 Session；公司 DSH 插件在创建后立即幂等上报所有权和索引，Control Plane 定时 reconcile 用户卷与 PostgreSQL，修复遗漏索引并标记损坏/孤立记录；
- 删除 Session 默认采用软删除和延迟物理清理，避免数据库与文件系统跨介质事务导致不可恢复的数据丢失；
- Runner 写入事件后更新最后事件位置；异常退出时以 JSONL 可读取的最后完整事件为恢复边界；
- 配置变更每次递增 `config_version`，旧 Runner 不得加载比自身身份声明更新的配置后继续静默运行。

## 13. 首版实施建议

| 阶段 | 目标 | 退出条件 |
|---|---|---|
| 0. Foundation/PoC | 初始化仓库，锁定 DSH，验证官方 Web 经 Gateway 的路径/静态资源/WebSocket、会话恢复、最小入口补丁，以及 DSH 调用本地 `FakeKnowledgeProvider` | 四域 Contracts v1、DB v1、Knowledge Tool/fake 接入 ADR、必要 RPC、UI 品牌输入清单均已评审 |
| 1. P0 DSH Web 对话与完整历史 | 简单登录、Workbench 模型 URL/Key、独立 Runner、`/chat`、多窗口和全事件恢复 | 两个用户分别通过自己的 DSH Web 完成真实对话，重建 Runner 后可打开任意历史窗口 |
| 2. P0/P1 fake 知识链路 | 公司/个人知识总览、状态操作、Agent 检索和引用全部使用确定性 fake 数据 | 对话命中当前测试用户可见 fixtures、无法命中另一用户个人 fixtures，引用随 Session 恢复；切换槽位和契约已固化 |
| 3. P2 需求与任务 | 需求草稿、AI 拆分、主管发布、指派、看板、提交和自动审核 | 主管/成员权限、全状态迁移、四个快速视图和审核证据验收通过 |
| 4. P3 个人与部门日报 | 创建/提交、编辑、AI 改写、软删除、部门今日和日期筛选 | 员工只管理自己日报，主管只查看所管部门，时区/日期边界测试通过 |
| 5. P4 开发集成与交付 | 全域 fake 回归、限流、备份恢复、监控、升级和容量，提供真实 MCP 切换说明 | 主业务链路 E2E、故障演练、隔离和容量测试通过；生产构建不能误启 fake |
| 6. 后续真实 MCP 接入（不属于当前开发完成条件） | 部署方配置 RAG URL、身份/Token，关闭本地 fake Tool/Provider 并执行契约/ACL 回归 | 真实公司/个人知识、引用、权限、延迟和凭据保护验收通过后才允许知识能力上线 |
| 7. 后续对话 UI 替换（不阻塞 MVP） | 自研 Chat + `dsh-client-adapter`，保持现有 Runner/Session/MCP | 与官方 DSH Web 兼容基准对齐，切换 `/chat` 后历史和工具链路无回归 |

首版不建议同时开放“任意 Skill 目录、任意 MCP 程序、任意 MCP URL、任意 Workspace 路径”。这些功能会显著扩大远程代码执行、SSRF 和越权文件访问风险。

阶段 0 必须先于大规模并行编码。契约和数据库基线合并后，任务和日报可以与 P0 对话/知识联调并行开发，但线上集成顺序仍按表中优先级执行。

## 14. 验收清单

### 14.1 P0 主链路验收

- admin 可以创建 `member` 账号，员工能用临时密码登录并修改密码；
- 员工只填写 OpenAI-compatible 模型 URL 和 API Key；系统发现、去重并保存全部可用模型，查询接口不返回完整 Key；
- 员工访问 `/chat` 时只会被路由到自己 Runner 的 DSH Web，未登录、停用账号和伪造 Runner/Session ID 均被拒绝；
- DSH Web 可跳转到公司 Workbench，Workbench 也可返回对话，入口补丁不包含业务数据逻辑；
- 员工创建 Session 并发送消息后，系统按需启动该员工的 Runner；
- DSH Web 创建的 Session 能幂等登记到 Company PostgreSQL，上报失败后 reconcile 可以补齐，不会登记到其他用户；
- DSH 使用该员工配置完成真实模型调用，浏览器可以持续收到响应事件；
- 员工可以创建多个会话窗口，列表可看到全部历史与正确更新时间；
- 打开任意窗口可恢复全部消息、Tool/错误事件和知识引用；
- 两个测试平台用户看到同一批 fake 公司知识，但只会命中各自的 fake 个人知识，回答展示可追溯 fixture 引用；
- 调用 `search_knowledge` 时模型无法指定或伪造 `user_id`，用户 A 无法命中用户 B 的个人 fixtures；
- 调用 `query_company_system` 时，Agent 可查询当前用户有权查看的需求、任务、本人日报；主管可查询本部门日报，普通成员和跨部门主管不能越权；
- 需求、任务或日报通过 Web 修改后，Agent 下一次查询从同一 Business API/PostgreSQL 返回最新数据，不依赖 RAG 或异步复制；
- `query_company_system` 只允许白名单 GET 查询，模型不能提交身份、部门、URL、Header、Token，也不能通过对话修改、发布或删除业务记录；
- Session Event 和 Workspace 写入该员工目录，停止并重建 Runner 后仍可继续对话；
- 测试用户 A 和 B 不能读取、路由或挂载到对方的 Session、Workspace、模型配置和个人知识；
- 浏览器响应、应用日志、Session Event 和 Tool 结果中不出现完整模型 API Key；fake 模式不创建或要求 RAG PAT；
- admin 停用员工后，该员工不能继续登录或创建新的 Runner。

### 14.2 知识、任务与日报验收

- 全员可浏览 fake 公司知识的分类/文件概览，每位员工只能管理自己的 fake 个人知识；
- fake 上传后可看到确定性的入库进度，失败可重试，归档/恢复和重建索引页面流程可完成；不宣称发生了真实解析或向量计算；
- 主管可创建需求、获取子任务草稿、调整并发布，成员能看到分配给自己的任务；
- “我发布的、分配给我的、未完成、已完成”四个视图返回正确集合；
- 任务所有状态变更有历史，自动审核结果包含结论、检查项、证据和执行版本；
- 员工可创建/提交、编辑、AI 改写和软删除自己日报，AI 改写不会自动发布；
- 主管可查看本部门成员今日日报和未提交状态，日期范围/成员/状态筛选正确；
- 跨部门主管和普通成员调用 API 时不能越权查看他人日报或管理他人任务。
- Agent 与 Workbench 使用相同的业务权限和结果语义；Agent 查询结果不包含密码、完整模型 Key、内部 Token 或其他秘密字段。

### 14.3 扩展与上线验收

- 同一 Session 的并发写入受到互斥或顺序控制；
- DSH WebSocket 断线重连不会重复提交用户消息，无法恢复的运行会明确标记为中断；
- 用户只能加载授权的公司、部门和个人 Skill；
- `knowledge.provider=fake` 在非开发/测试环境启动时失败，生产构建不能携带默认启用的 fake 数据；
- Knowledge MCP URL、Header 和 Token 不能由普通用户提交或覆盖；
- `stdio` MCP 无法读取其他用户文件或 Docker Socket；
- Control Plane 和用户 Runner 均无法访问 Docker Socket；
- Redis 数据被清空后，可以从 PostgreSQL 和 Docker 实际状态恢复 Runner 路由；
- 配置版本变化后，旧 Runner 不会继续使用已撤销的 Credentials；
- 升级 DSH 镜像不会覆盖用户卷和 Session。

### 14.4 后续真实 MCP 接入验收

- 把 Provider 从 `fake` 切换为 `remote-mcp` 只修改受控配置和身份/密钥绑定，不修改 Company Web、Agent Prompt、Session 或工具结果解析；
- 真实 MCP 通过已冻结的 Tool schema 和 Company Knowledge API 契约测试；
- 两个真实测试员工都能检索公司知识，只能检索自己的个人知识，模型参数无法伪造用户身份；
- 真实引用可以展示并随 Session 恢复，浏览器、日志、Session Event 和 Tool 结果中不出现 PAT/Token；
- 本地 fake Tool/Provider 和 fixtures 在真实环境不可用；真实 MCP 稳定性、延迟、错误恢复和上游版本兼容达到上线基线。

## 15. 非阻塞 PoC 验证与后续事项

当前没有阻止三个 worktree 从同一基线并发编码的产品或契约决策。账号密码、技术栈、DSH commit/submodule、任务确认、自动审核不自动完成、日报“一人一天一份”和无附件均已冻结。公司正式 Logo/标准色尚未提供，`company-web` 先实现可替换 Logo Slot 和 Design Tokens，不因此暂停功能开发。

以下是 `core-platform` 在阶段 0 通过代码和测试回答的 PoC 问题，不允许三个 worktree 各自更改契约规避：

- P0 固定 Agent Profile、Settings 和 Credentials Provider 的实际装配入口；
- Session Persistence 在 Runner 异常退出时的最后事件完整性；
- DSH Web 在 `/chat` 路径前缀下的静态资源、HTTP/WebSocket、Cookie 和断线恢复，以及不支持时的同站点子域名备选；
- 官方 DSH Web 完成对话所需的最小 RPC allowlist，隐藏/拒绝原生 Credentials 写入后是否影响对话主链路；
- “公司工作台”最小补丁能否稳定应用于锁定 commit，以及升级时的失败检测；
- DSH 是否有稳定的 Session 创建/更新事件可供公司插件上报索引；若没有，确定基于 Session Provider 列表的 reconcile 周期、断点和一致性行为；
- `@deepseek-ai/dsh-client-connection` 是否足以支撑后续公司自研对话 UI（不阻塞 P0）；
- Runner 冷启动耗时和公司二十多人并发时的资源上限；
- `company-dsh` 注册本地 fake Tool 的公开扩展点，以及关闭 fake 后避免与真实 MCP 同名工具冲突的开关；
- `search_knowledge` fake 引用在官方 DSH Web 中如何展示并固化到 Session Event；

P0 用户卷固定使用 Runner 宿主机本地目录 `/data/dsh-users/<user_id>`，根路径可配置，代码只持久化 `storage_ref`；替换共享存储是后续部署演进。fake `KnowledgeToolContext` 固定从 Runner 身份绑定用户，Tool 参数不能包含用户字段。Company Knowledge API 与 Tool v1 已由机器可读契约冻结。

每用户 PAT 绑定、密文物化和下次访问自动刷新 Runner 已完成。剩余上线工作为：

- 实现 PAT 撤销运维命令，并补齐平台账号停用时与 RAG Token 的联动；
- 真实 RAG 开放的文件类型、单文件大小、OCR 配置和知识治理权限；
- 真实 MCP 的 ACL 绕过、稳定性、额外延迟、错误恢复和版本升级测试；
- 是否继续直接使用 MCP，或因已复现的兼容问题增加 Host Tool Adapter。

同用户多并发 Session、上游升级兼容性、集中 Session Provider 和高可用仍需后续验证。

### 15.1 P4 生产基线推进状态（2026-08-23）

当前已经新增不依赖真实 MCP 的生产化第一批基线：

- `deploy/compose.production.yaml` 与开发 Compose 分离，常驻服务固定 `NODE_ENV=production`，不包含 fixture seed，Business Repository 固定 PostgreSQL，Redis 开启 AOF；
- Knowledge 和 Automation 新增显式 `disabled` 模式。生产预验收可以关闭这两项并继续验证登录、模型、DSH 对话、Session、Runner、任务、日报和 `query_company_system`；被关闭能力统一返回 503，不允许回退 fake/stub；
- 空数据库通过一次性 Platform Bootstrap 创建首个本地管理员，重复执行和非空平台均失败，初始密码强制首次登录修改；
- 生产配置检查使用 Docker Compose 解析后的结构化 JSON，验证无 seed、无 fake/stub、无开发迁移、Redis 持久化、端口和 Docker Socket 边界；
- PostgreSQL 与 Runner 用户目录提供停写窗口备份/恢复脚本，备份带 SHA-256 manifest；恢复要求显式替换数据库确认和空 Runner 目标目录；
- `dsh-lock.json` 固定 DSH commit、tag、package version、补丁和 11 个允许修改的上游文件，候选 DSH checkout 可在不改 submodule 的情况下执行补丁预检。

这批能力只把“不接 MCP 的预生产环境”从开发 fake 中分离出来，不代表已经完成正式上线。P4 仍需完成集中指标/告警、生产 TLS/密钥注入、容量与故障测试，并在独立恢复环境用包含历史 Session 和用户工作区的代表性数据重复备份恢复演练。完整知识能力上线仍需通过 14.4 的真实 MCP 验收。

### 15.2 业务自动化直连模型（2026-08-24）

需求拆分、任务审核和日报 AI 改写属于一次性、无会话状态的结构化生成，不通过 DSH Runner 执行。Business API 仍通过内部自动化契约创建和轮询运行；Control Plane 的 `ModelAutomationExecutor` 根据 `actor_user_id` 读取该用户已经保存的 OpenAI-compatible URL、模型名和加密 API Key，临时解密后直接请求 `/chat/completions`。这样不会为一次日报润色启动 Runner，也不会把用户密钥下发给 Business API。

后台按 `purpose` 维护固定 Prompt，并对模型结果执行目的对应的结构校验。当前三个 purpose 是 `task_split`、`task_review` 和 `daily_rewrite`；模型输出只形成子任务草稿、辅助审核意见或日报改写预览，仍需用户确认后才能写入或发布业务事实。DSH Runner 继续只承担有完整 Session、历史、Tool、Skill 或 MCP 上下文的 Agent 对话，因此这条能力不增加 DSH 上游升级的融合面。

### 15.3 模型目录自动发现（2026-08-24）

Workbench 模型设置页只接受 `API Base URL` 和 `API Key`。保存和“测试连接”均由 Control Plane 携带新提交的 Key，或在 Key 留空时解密复用已保存的 Key，请求 `{baseUrl}/models`；只接受 OpenAI-compatible 的 `data[].id`，过滤空值、去重并按 ID 排序。发现失败、响应无效或目录为空时保存返回明确错误，原生效配置、凭据和 Runner 不变。

完整 `models[]` 与内部默认 `model` 同时保存在 `platform.model_configs` 和配置暂存表中，Runner 重建不依赖再次访问模型服务。原默认模型仍存在时继续沿用，否则自动使用发现目录第一项。物化器将同一个 Company Provider 下的全部模型写入 DSH `llm-pi-ai.providers.company-model.models`，并用 `agent-default-model` 指向内部默认模型；官方 DSH Web 的原生模型选择器负责对话 Session 的具体选择，不新增公司补丁或自研对话模型选择控件。

需求拆分、任务审核和日报改写等无状态自动化仍读取内部默认 `model`，不会因对话 Session 选择其他模型而改变。模型目录只在用户测试或保存配置时访问上游，普通进入设置页和 Runner 重启均读取 PostgreSQL 中已保存的目录。

### 15.4 每用户 Remote MCP 调联（2026-08-28）

Control Plane 已实现租户级 MCP Provider 和用户级 RAG 身份绑定。`deploy/scripts/provision-remote-mcp-user.mjs` 从本地 `config.toml` 读取指定 MCP Server 的 HTTPS URL 和 Bearer PAT，用 `MODEL_SECRET_KEY_BASE64` 加密 PAT 后写入 Platform PostgreSQL，不打印密钥也不产生明文临时文件。重复执行相同绑定不增加配置版本。

Runner 物化时使用模型版本、Knowledge Provider 版本和 RAG 用户绑定版本之和作为聚合版本。任意一项单调递增都会在下次 `/chat` 访问时重新物化配置并替换旧 Runner；不再要求管理员进入用户目录修改 `.env`。租户 MCP URL/白名单变化会刷新受影响的用户，单个 PAT 轮换只刷新该用户。

`wdl` 运行态 smoke 已通过：平台账号可登录，专属 Runner 健康，`company` preset 可成功创建 Session，`.env` 权限为 `0600`，Cordis 使用官方 MCP Client 且不包含 PAT 明文，同一 PAT 的 `get_current_user` 返回 `wdl` 员工身份。

## 16. 参考位置

以下链接固定到本次审阅 commit，避免默认分支变化造成文档内容漂移：

- [DeepSeek Harness 审阅基线](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca)
- [DSH Web App](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/apps/web)
- [Client Connection 协议](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/connection/README.md)
- [Settings File Provider](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/settings/settings-file/README.md)
- [Credentials 接口](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/credentials/credentials/README.md)
- [Local Credentials Provider 及安全边界](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/credentials/credentials-local/README.md)
- [Filesystem Skill Provider](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/skill/skill-filesystem/README.md)
- [Skill Registry](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/skill/skill)
- [MCP Client](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/mcp/mcp-client/README.md)
- [JSONL Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/session/session-persistence-jsonl/README.md)
- [SQLite Session Persistence](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/session/session-persistence-sqlite)
- [`dsh-web-ui` 参考仓库审阅基线](https://github.com/zhu1090093659/dsh-web-ui/tree/878a66b5fbc3b32fad199bfc9cbac2dcd05d826d)
- [`dsh-task-board` 源码（仅作交互与实现参考）](https://github.com/zhu1090093659/dsh-web-ui/tree/878a66b5fbc3b32fad199bfc9cbac2dcd05d826d/packages/dsh-task-board)

目标 RAG 基线位于 `/Users/freshpi/Documents/freshpi-ai/rag-mcp`，关键入口为 `src/rag_mcp/server.py`、`src/rag_mcp/runtime.py`、`src/rag_mcp/mcp/tools.py`、`src/rag_mcp/services/knowledge.py` 和 `src/rag_mcp/auth/provider.py`。当前新平台已连接其运行中的 Streamable HTTP MCP，但没有修改或复制该独立仓库源码。

## 附录 A. 设计上下文摘要

可以让新的讨论从以下结论继续，不必重新判断基础路线：

```text
目标：用 DeepSeek Harness 做公司集中部署的 AI Web 系统，员工只使用浏览器。

已选架构：所有用户共享同一公司镜像；每个活跃用户一个按需 Runner；每个 Runner
拥有独立 DSH_HOME、Settings、Skill、MCP、Session 和 Workspace；公司
Gateway 负责登录、Session 所有权校验、Runner 路由和审计。公司 Profile/Skill/MCP
以只读方式共享。P0 使用每用户独立 Credentials 文件，并用固定 Profile 关闭 Shell、
文件 Tool 和自定义扩展；生产开放 Tool 前切换为公司 Credentials Provider。首版使用每用户独立 JSONL Session 根，保留所有会话窗口和完整事件，后续再根据
并发和集中检索需求考虑 PostgreSQL SessionPersistence Provider。公司业务放在 Web、
Gateway、Provider、Skill 和 MCP 扩展层，尽量不修改 DSH 核心，以便跟进上游更新。

产品范围包含四个域：完整对话/历史；公司和个人知识管理与 Agent 检索；
主管发布需求、拆分子任务、看板跟踪和自动审核；个人日报 CRUD/AI 改写与
主管部门/日期视图。P0 使用官方 DSH Web 承载对话和历史，仅增加最小“公司工作台”入口；
Company Workbench 使用 Logo 相关的自研品牌 UI，承载设置、知识、任务、日报和管理。
社区 dsh-web-ui 不作为主站依赖，只作信息架构和可选代码参考。
后续自研对话 UI 只替换 /chat 前端，继续使用 DSH Runner、Session 和 MCP。

P0 知识链路不连接、部署或修改 /Users/freshpi/Documents/freshpi-ai/rag-mcp。新平台先冻结
与其兼容的 get_current_user、search_knowledge、list_knowledge_documents 契约，预留可配置
Knowledge MCP 槽位，并用开发/测试专用本地 FakeKnowledgeProvider 和确定性 fixtures 完成 Tool
事件、引用、知识管理页及双用户隔离测试。开发交付后关闭本地 fake Tool，再实现并启用真实
MCP 配置、身份和密钥。真实 ACL、延迟、检索质量和版本兼容必须另行验收，fake 通过不能
替代真实接入通过。

首版部署在单台 Linux Runner 宿主机。Docker Compose 管理常驻服务，Runner Manager
通过受控 Docker Engine API 按需创建用户 Runner。PostgreSQL 保存权威业务数据，
Redis 保存短租约、互斥和临时路由。代码按 Monorepo 管理，bootstrap 合并后前期仅保留
core-platform、company-web 和 business-services 三个并发 worktree；只有两个开发槽时将后两者
合并为 company-product。跨域 E2E 使用短期 integration 分支，后续 chat-replacement 复用
company-web 工作槽，都不新增长期并发 worktree。现有 rag-mcp 保持独立且在当前开发阶段只读；
core-platform 工作槽负责 Runner 内本地 fake Tool，business-services 负责 Knowledge fake API、业务模块和 fixtures；两者只消费冻结契约，不把 RAG 源码
复制进新 Monorepo，也不为当前开发创建 RAG worktree。

公司当前没有可用 SSO、LDAP 或 AD。首版只做 admin 创建账号、至少 8 位密码、
admin/member 两种角色和简单 Session Cookie，不实现 MFA、邀请、邮件或自助找回。
P0 优先跑通登录、模型配置、启动用户 Runner、真实模型对话、完整历史、
fake 知识工具/引用、持久化和重启恢复的主链路；真实知识在开发交付后接入。
```
