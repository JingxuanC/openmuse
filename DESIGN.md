# OpenMuse × LangAlpha：国内个人 AI 助手平台整体方案

> 状态：v1.1（评审修订版）· 2026-10-02
> v1.0 经独立评审（结论：方向成立，需修订后开工），本版已落实全部 P0/P1 修订。
> 评审关键结论：分工铁律站得住；事实核查 10 条中 8 条完全成立，2 条已修正。

## 1. 产品定位

面向国内用户的个人 AI 助手平台：**金融研究能力专业级**（LangAlpha + 量化 MCP 服务族），**通用事务能力够用**（浏览器、终端、邮件日历、网页监控），**形态是住在手机里的助手**（iOS/Android/Web 三端 + 微信通道）。

差异化：有工位（浏览器/终端）、有记忆、有纪律——任务后台跑、写操作必须人批、金融判断过闸门。

## 2. 总体架构与分工铁律

**大脑在 LangAlpha，外壳在 OpenMuse fork。** 连接器、金融工具、记忆挂 LangAlpha 侧（微信通道用户同享）；OpenMuse fork 只管三端 UI、任务引擎、审批、浏览器/终端工位。

```
OpenMuse App（RN 三端）/ LangAlpha Web / 微信
        │ AG-UI（对话流，透传用户 JWT）      │ REST/SSE（现有）
OpenMuse fork（外壳：UI/任务引擎/审批/浏览器工位）
        │            ▲
        │            └─ LangAlpha 直连工具反向调外壳 /api/*（delegate_task 等）
   LangAlpha（大脑：PTC + Flash，MCP 插件，记忆，Daytona 沙箱）
        │ MCP / 内置工具
量化 MCP 服务族 ×8 · wechat-mcp · 国内连接器 · web 工具 · causal-memory
共享基建：Supabase（Auth+Postgres）· Redis · 沙箱管理 · S3 兼容存储
```

## 3. 统一身份与多租户

### 3.1 身份（唯一身份源 = Supabase Auth）

- LangAlpha 现状：Supabase Auth + `/api/v1/auth/sync`（`src/server/app/users.py`）；`jwt_bearer` 验 JWKS（RS256/ES256，`audience="authenticated"`，`sub`=user_id），见 `LangAlpha/src/server/auth/jwt_bearer.py:39-58`。
- 邮箱注册用 Supabase Auth 原生能力（验证邮件/找回密码）。国内 SMTP 送达率上线前解决（自定义 email provider 或改验证码流程）。
- **OpenMuse fork**：删 access key，Hono 加 JWT 中间件（jose 验同一 Supabase 项目 JWKS），`sub` 即 user_id，与 LangAlpha UUID 天然一致。
- **RN 端鉴权重写**（Phase 1 清单内，评审 P1-3）：Expo 端现为 access-key 换 session（`apps/mobile/src/api.ts:33-44`），需替换为 Supabase Auth 登录/注册/验证码/token 刷新/secure-store。
- **AG-UI 透传是待写代码**（评审修正）：上游 `HttpAgent` 只发静态 `AGENT_TOKEN`（`apps/server/src/agent.ts:46-50`），透传用户 JWT 需自行扩展。
- **服务端到服务端认证是两边都要新写的路径**（评审 P1-3）：LangAlpha `jwt_bearer` 只认用户 JWT，service role + `X-User-Id` 需新增。
- **部署炸弹警示**：生产 `HOST_MODE` 绝不能为 `oss`——该模式 `jwt_bearer.py:77-78` 对所有请求返回固定本地用户，等于无认证。
- 微信通道绑定关系改为关联 Supabase UUID。

### 3.2 租户隔离

| 层 | 做法 |
|---|---|
| Postgres | 同一实例；OpenMuse 表独立 schema `openmuse.*`；RLS 兜底 |
| Store 改造（评审 P1-4，Phase 1 独立工作项） | OpenMuse 的 Store 是共享 `pg.Pool` 裸查询（`apps/server/src/db.ts:116-119`），无 per-request 连接上下文，`SET app.user_id` 不可靠；须改为"请求路径 checkout-per-request/事务包裹 + 后台 worker 用 BYPASSRLS 角色"。自托管 PG 无 `auth.uid()`，需自设 `request.jwt.claims`。注：store 的 `owner` 列已贯穿所有方法，多数改造是把常量 `"local-user"` 换成 JWT sub |
| Redis | 共用实例，key 前缀 `openmuse:` 且含 user_id |
| Vault | KEK/DEK per-user 数据密钥 |
| 任务引擎 | SQL 租约不动；加 per-user 并发上限 + 公平调度 |
| 审批/通知 | 按 user 路由；可选公众号模板消息 |
| PGlite→Postgres | **零迁移**（评审 P2-1）：`DATABASE_URL` 已支持（`db.ts:126-129`） |

## 4. Phase 0：摘除外云依赖（go/no-go 验证性手术）

**技术路线（评审 P0-2 修订版）：不另写持久化层，而是实现 CopilotKitIntelligence 接口。**
依据：`CopilotRuntime` 构造必传 `intelligence`（`apps/server/src/agent.ts:58-66`），聊天线程存 CopilotKit 云且与 AGENT_BACKEND 无关；但 `tests/rich-threads.test.ts:41-175` 证明 Intelligence 是边界清晰的可替换接口（`getOrCreateThread/listThreads/updateThread/archiveThread/getThreadMessages` 五个方法 + 运行期消息持久化）。照 LangAlpha 重写持久化是错的（机制完全不同：CopilotKit runtime 托管流式/重放 vs LangGraph checkpoint）。
- 用自家 Postgres 实现 `CopilotKitIntelligence` 完整方法面 + 放开 `apps/server/src/config.ts:130` 的必填。
- RN 端 `useThreads`/`useAgent`、runtime 全部零改动。
- 顺手改设置页 "CopilotKit Intelligence / Not connected" 文案（`screens.tsx:1354`）。

**同期 spike（评审 P0-1）：量化 MCP 沙箱通路验证（半天到一天）。**
已确认的三条断路：① 非 OAuth http MCP 由沙箱内生成客户端直连 `server.url`（`tool_generator.py:655-666`）；② trusted(bundled) 服务器的 headers **不带进沙箱**（`tool_generator.py:661-665`）——bundled quant_suite 的 license header 会被静默丢弃；③ user/workspace 路径可带 header 但撞 `validate_remote_url` 的 https+公网强制（`mcp_server.py:182-220`）。且前置未知：**Daytona 沙箱网络能否到达内网 50052-50062**。
spike 内容：实测沙箱 curl 内网 MCP；确定最小改造点（候选：给 `generate_client_config` 的 trusted-remote 分支补 headers 透传，或 bundled 插件显式 SSRF 豁免）。M3 硬前置。

**✅ spike 已完成（2026-10-02），结论：走 hub 公网 https，内网直连方案废弃。**
证据：① 服务在线、license key 有效（47.90.253.85 上 50052-50062 全部 `auth:true`）；② `https://causal-memory.com/hub/mcp/*` 公网可达且讲 MCP（401 OAuth 标准错误）；③ 生产沙箱 provider=daytona 云，出公网无障碍；④ hub URL 是 https+公网，合法通过 `validate_remote_url`；⑤ 用户态添加的 server headers 会嵌入沙箱客户端配置。
落地路径 A（零改动，推荐）：用户添加 `https://causal-memory.com/hub/mcp/alpha|data` + 自己的 Bearer key（天然 per-user 计量）。路径 B（运营内置）：`tool_generator.py` trusted-remote 分支补 headers 透传（几十行），bundled quant_suite 可用。
遗留部署缺口：服务器未部署 news-mcp / causal-chain-mcp，接连接器时需补。

**验收**：不配 `CPK_INTELLIGENCE_API_KEY` 全功能可跑；聊天历史在自家 Postgres；现有测试基线通过（开工先跑基准确认用例数，验收引用实测值，评审 P2-2）。

## 5. Phase 1：多租户地基（3–4 周，评审修正工期）

1. JWT auth 中间件（含 RN 端鉴权重写，§3.1）
2. 全部集合 owner 列接通 JWT sub + Postgres 迁移
3. **Store 改造**（checkout-per-request + 后台 BYPASSRLS 角色）→ 然后上 RLS
4. per-user vault（KEK/DEK）
5. 任务引擎：per-user 并发上限 + 公平调度
6. 审批/通知按用户路由
7. 最小管理后台（用户列表、封禁、用量）

## 6. Phase 2：每用户容器沙箱（1–2 周，参考 LangAlpha）

| 设计 | LangAlpha 参照 | OpenMuse fork 实现 |
|---|---|---|
| 生命周期 | User → Workspace 1:1，首用创建，空闲回收 | `sandbox-manager`：`om-sbx-{user_uuid}`，首用创建，30min 空闲停 |
| 密钥隔离 | **专用 relay JWT**（非用户 JWT，`egress_relay.py:5-7`），且 relay 是 OAuth vendor 专用通道 | 同模式；注意：**小红书场景凭证在浏览器 profile，不经过 relay**——隔离靠 worker profile + worker 已有出口代理（`apps/worker/src/browser.ts:119`） |
| 持久化 | 命名卷 + 记忆在沙箱外 | 每用户命名卷；元数据全在 Postgres |
| 资源限制 | rlimit + 容器 quota | per-container cpu/mem/pids + per-user 活跃上限 |

**容量重规划（评审 P1-5）**：浏览器 worker 的 maxSessions=3 / 20 profile 是**进程级全局值**（`apps/worker/src/browser.ts:41,161`），per-user 化意味着 3N 个 Chromium——需按用户分片 worker 或调低 per-user 上限 + worker 池化。

定位差异（评审 P2-3）：外壳 computer 容器**无网络**（`computer-tools.ts:12`），是"无网事务工位"；LangAlpha Daytona 是"有网金融分析环境"——两者并存不混用。

选型：优先评估复用 Daytona；不满足则扩现有 docker-spawn。

## 7. Phase 3：LangAlpha 侧整合

1. **AG-UI 适配层（独立里程碑，评审 P1-1）**：LangAlpha 无任何 AG-UI 痕迹，且其 agent 不是裸 graph——是每请求现建的 `create_agent()` + 中间件 + 沙箱 + 准入/运行账本/Redis SSE/错误漏斗。`/agui` 端点需写 AG-UI↔自有运行管线适配器（否则丢重连/恢复/审批中断）。先做半天 `ag-ui-langgraph` 可行性 spike。**工期 1–2 周，是全方案技术含量最高的一块，排期不得与其他项简单并行压缩。**
2. **量化插件包** `plugins/quant_suite/`：8 服务（astock-data:50052 / factor-miner:50053 / causal:50057 / global-data:50058 / news:50059 / kronos / causal-chain / workbench:50062）。**依赖 Phase 0 spike（P0-1）确定的通路方案**（headers 透传或 SSRF 豁免）。
3. **skills 包**：quant-agent-skills 24 个 SKILL.md 打成 skills-only bundle（照 `langalpha_research` 格式）；纯文件 skill 无需进 `SKILL_REGISTRY`（registry docstring 明示），只有工具门控才改代码。
4. **OpenMuse REST 反向封装**：LangAlpha 直连工具调外壳 `/api/*`（带用户身份）。**工具面需逐一对照 `engine/conversation.ts:156-292` 的 10+ 工具补全**（search_mail/read_mail_thread/browse_web/delegate_task/agent_status/create_goal/watch_page/remember_fact/computer 系列），并明确 RN 富卡片（mail-tool-card/jev-tool-card）哪些保留渲染、哪些降级文本（评审 P1-2）。**（2026-10-03 修订：降级为可选，见 §7A——主从关系反转后，仅当 LangAlpha 需主动调外壳能力时才做）**
5. ~~executeModelTask 走 AGENT_URL~~（**评审 P0-3 删除**：`engine/model.ts` 366 行耐久执行循环含幂等缓存/checkpoint/宿主工具装配，远程 agent 无法承接；后台任务仍走外壳本地模型，大脑指挥外壳一律走第 4 条 REST 封装）。

## 8. Phase 4：国内平台连接器

连接器 = 认证 + 工具 + 审批 + 监控，**挂 LangAlpha 侧**（微信通道同享）：

| 平台 | 路径 | 要点 | 工期 |
|---|---|---|---|
| 公众号 | 官方 API，wechat-mcp 已有 | reviewed writes：草稿→人批准→群发。**前置依赖：已认证服务号**（个人订阅号无接口权限；微信认证有审核周期，评审 P1-6） | ~3 天（账号就绪后） |
| 小红书 | 持久浏览器：扫码登录一次，session 存 per-user profile，自动化发笔记/回评论/抓数据 | session 失效→推送重扫码为一等流程（takeover 机制）；反爬是最大风险；凭证隔离走 worker profile + 出口代理 | 1–2 周 |
| 抖音 | 开放平台 API + 浏览器抓创作者中心；视频用多模态沙箱分析 | 认证门槛 | ~1 周 |

连接器优先做成 LangAlpha 工具/插件，不动 fork（LangAlpha 已有完整 MCP registry）。

## 7A. 架构修订：OpenMuse 为大脑，垂直 agent 插件化（2026-10-03 方向决策）

**背景**：Phase 1 接线用 `AGENT_BACKEND=agui` 把全部对话透传 LangAlpha，验证了身份与事件通路，但让 OpenMuse 退化成透明代理——自有 ConversationAgent（browse_web / delegate_task 持久任务 / computer 浏览器接管 / workspace 文件 / 审批 / 监控 / jev）全部闲置。方向修订：**外壳即产品，大脑在 OpenMuse；LangAlpha 及其他垂直 agent 作为可插拔的委派目标**。后续任何垂直领域（投研、小红书运营、电商……）都以同一机制接入，不改主架构。

**架构**：

- 新 `AGENT_BACKEND=hybrid`：ConversationAgent（TanStack 引擎 + 国内模型）为唯一主大脑，每个垂直 agent 注册为一个委派工具。
- **垂直 agent 注册表**：env `VERTICAL_AGENTS`（JSON 数组）：
  ```json
  [{"name":"finance_agent","description":"投研/选股/因子/回测/市场数据，委派给 LangAlpha","url":"http://47.90.253.85:8000/api/v1/agui/run","timeoutMs":300000,"maxResultChars":20000}]
  ```
  启动时校验：name 不得与内置工具重名、url 必填、name 全局唯一。
- **委派工具行为**（`apps/server/src/engine/vertical-agent.ts` 新模块）：
  - 入参 `{task, context?}`；task 作为单条 user message 发到垂直 agent 的 AG-UI run；**threadId 复用 OpenMuse 的 threadId**（垂直侧保有跨轮上下文），runId 每次新。
  - 通道复用 `agui.ts` 的 `createLangAlphaAgent`（HttpAgent + adaptAguiFrame 修正 RUN_FINISHED.outcome）。
  - 聚合 TEXT_MESSAGE_* 为文本返回（截断 maxResultChars）；TOOL_CALL/THINKING 事件计数以摘要形式附在结果头部。
  - **身份透传**：agents factory 从 request.headers 取调用者 Supabase JWT 传入 ConversationAgent，委派时作为 Bearer 转发（沿用"AGENT_TOKEN 不设"原则，避免多用户塌缩成一人）；无 JWT → 工具返回明确错误。
  - 取消/超时：主 run abort 经 AbortSignal 传入 sub-run fetch；默认超时 300s。
- **Prompt 路由**：主 prompt 追加每个垂直 agent 的描述与触发场景（金融问题一律委派、不得自行编造行情数据）；删除旧文案 "Health/finance connectors beyond Google are unavailable"。
- **与旧 Phase 3 的关系**：第 1 条 AG-UI 适配层已完成，正是委派的通道；第 4 条降级可选；第 5 条（executeModelTask 留在本地）不变且更成立。

**里程碑**：

- M1：hybrid 后端 + finance_agent 委派工具 + 全量测试（配置解析校验 / JWT 透传 / 委派 e2e mock fetch / 取消与超时 / 与内置工具重名拒绝）
- M2：生产翻转 `.env`（AGENT_BACKEND=hybrid + VERTICAL_AGENTS），实测：金融问题走委派、网页总结走 browse_web、任务类走 delegate_task
- M3：量化 MCP hub（data/alpha/memory）挂为主 agent MCP 工具
- M4：第二个垂直 agent 验证插件化（候选：小红书运营）

**M1/M2 验收**：全量测试绿；hybrid 模式下金融请求触发 finance_agent 工具且返回 LangAlpha 实际内容；非金融请求不触发委派；生产实测三类路由各一条。

## 7B. 垂直 agent 富产出透传与渲染（2026-10-03 用户反馈立项）

**问题**：M1 委派是纯文本聚合——`runVerticalAgent` 只拼 TEXT_MESSAGE_CONTENT，TOOL_CALL/THINKING 只计数，LangAlpha 的产出物（报告/图表/文件）、数据来源、中断选择全部丢在缝里，OpenMuse 层无法渲染。

**已核实的事实**：
- LangAlpha AG-UI 网关已把富事件以 CUSTOM 发出（`src/gateway/agui/sse.py` CUSTOM_EVENTS）：`langalpha.artifact`（产出物，帧形 `{artifact_type, artifact_id, agent, status, payload, tool_call_id?}`）、`langalpha.provenance`（来源）、`langalpha.interrupt`（HITL）、`langalpha.workflow_status`、`langalpha.agent_text`（子 agent 文本）等。
- 产出物文件内容有现成 API：`GET /api/v1/workspaces/{id}/files/download`（Supabase JWT 鉴权，与 OpenMuse 同一身份体系）。
- interrupt 只有发出、AG-UI 侧尚无 resume 协议。

**分层方案**：

- **P1 产出物透传（先做，LangAlpha 零改动）**
  - `runVerticalAgent` 收集 CUSTOM 事件：artifacts/provenance/agent_text 摘要，不再丢弃。
  - 委派工具结果结构化：`{ report, artifacts: [{type, id, title, status, path}], sources: [...], truncated }`。
  - 文件内容走 OpenMuse 服务端代理：`GET /api/vertical/{name}/file?path=...`，服务端持调用者 JWT 转发到 LangAlpha files/download（JWT 不下发前端、CORS 不用动）。
  - 前端：CopilotKit `useRenderToolCall` 为 finance_agent 注册渲染器——工具卡片内联展示报告 markdown + 产出物列表（报告/CSV/图表 PNG 点击预览下载）。图表 widget 降级：LangAlpha 沙箱已把 chart 存为 workspace 文件时按文件渲染；widget spec 渲染器后置。
- **P2 选择/审批（interrupts）** — ✅ 已完成（2026-10-03，且走了比原简化路径更好的方案）
  - 实际发现：AG-UI 网关只发不收，但 LangAlpha 主 threads API 有真 resume 协议（`POST /api/v1/threads/{id}/messages` + `hitl_response={interrupt_id:{decisions|order_decisions}}`），故直接用真协议而非"用户选择当新消息发回"。
  - 实现：`vertical-events.ts` 解析 `langalpha.interrupt`/`langalpha.thread` 帧（澄清/审批/未知三形态）→ 工具结果 `awaiting_input` + 中文 guidance；`vertical-resume.ts` 自写主流 SSE 解析器（`@ag-ui/client` 读不了 `event:` 行格式）执行 resume，支持多轮再问；审批类带 `resumeKind`/`resumeAttemptId` → `order_decisions`。
  - 实测（webbridge 真实浏览器）：6 轮 interrupt→resume 链路全通（投资期限→风险偏好→金额→存量口径→分批时点→细节确认），最终跑出完整 HTML 报告（13 artifacts 卡片）。timeoutMs 从 300s 提到 900s（对齐 LangAlpha AGUI_TURN_TIMEOUT_SEC），注意 138 的 `.env` VERTICAL_AGENTS 显式配了 timeoutMs 会覆盖代码默认。
- **P3 过程流式透传**
  - 委派中的 TOOL_CALL_*/agent_text 转成主 run 的工具进度展示（"正在调 hub_data / 正在跑回测"），消灭 5 分钟干等黑盒。

**P1 验收**：委派一次真实投研任务，OpenMuse 聊天里出现产出物卡片（≥1 个文件可下载/预览）+ 报告正文；332+ 测试全绿（新增 CUSTOM 事件收集与结构化结果的专项测试）。

## 9. 国内化合规

- 大脑在 LangAlpha，LLM 国内化主要在其 manifest 加模型；外壳 TanStack 层可 `OPENAI_BASE_URL` 指国内兼容网关（备注，评审 P2-6）
- 发布强制人工审批（reviewed writes 天然满足）
- 算法备案、生成内容标识、ICP
- 数据不出境：Supabase 自托管或国内 PG 兼容部署
- Expo 生产构建：`EXPO_PUBLIC_API_URL` 注入（评审 P2-4）

## 10. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | Phase 0 摘云 + 沙箱通路 spike | 不配 CPK key 全功能跑通；spike 报告确定量化 MCP 通路方案 |
| M1 | Phase 1 多租户 | 两邮箱账号并发使用，数据互不可见（含 RLS 负向测试） |
| M2 | Phase 2 沙箱 | 两用户独立容器与浏览器 profile；密钥不出 host |
| M3 | Phase 3 整合 | OpenMuse App 对话由 LangAlpha 回答；能调量化工具；约定的卡片渲染清单兑现 |
| M4 | 公众号（前置：已认证服务号） | App 内说"发公众号"→草稿→手机批准→群发成功 |
| M5 | 小红书 | 扫码登录保持 7 天；代发笔记经审批上线 |

## 11. 风险登记

1. Intelligence 接口的实现面可能比 mock 显示的大（运行期消息持久化细节）——Phase 0 验证
2. 量化 MCP 沙箱通路 spike 结果可能要求 LangAlpha 核心改动（tool_generator）——P0-1 已提前暴露
3. 小红书反爬/session 稳定性——takeover 重登 + 失败降级"辅助人工"模式
4. OpenMuse alpha 质量（Android 未真机、Google 集成未实测）——M 系列验收全部真机真账号
5. 不追上游 → 安全补丁自盯，每季度 diff 上游安全 commit
6. Supabase 国内可达性/邮件送达——自托管 + 国内 SMTP

## 12. 工作原则（沿用 LangAlpha AGENTS.md）

真机真接口先验证，测试只锁稳定契约；修根因不修症状；docstring 写 why 不写 what；多 worker truth 在 Postgres，进程内存只是执行上下文。
