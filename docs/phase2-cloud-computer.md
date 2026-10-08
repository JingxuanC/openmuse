# Phase 2：每用户云电脑（per-user cloud computer）设计

状态：已评审修订（评审 5 条阻断级全部闭环）。前置决策：宿主机升配（见 §6）。

## 0. 一句话

把 OpenMuse 现有的 per-user 无网工位容器体系，扩展为**每用户一台真正的云电脑**（4C8G Linux、有网受控、持久卷、空闲自动回收），并把容器做成通用 agent 运行时，为下一步异构多 agent 编排打底。

## 1. 现状盘点（已核实）

**ComputerService 已是 per-user 结构**（`apps/server/src/computer.ts`）：
- 命名：`openmuse-{deploymentHash16}-{ownerHash24}-computer` + 独立卷 + owner 标签
- 巡检契约（`inspect()`）：镜像、uid 1000、entrypoint、标签、readonly rootfs、cap-drop ALL、no-new-privileges、network=none、mem≤512M、cpu≤1、pids≤128、单卷挂载、无端口映射——任一不符 409 拒 attach
- 租约/幂等/中断隔离完备（CAS lease 180s、命令回执、stop 两阶段确认：先把 running 命令标 interrupted 再 docker stop）
- 约束：30s 命令上限、256KB 文件上限（天然防磁盘滥用）、files.py 网关、无网
- Env 巡检白名单：PATH/HOME/LANG/NODE_VERSION/YARN_VERSION（`computer.ts:253`）
- `runDocker` 透传 DOCKER_HOST（`computer.ts:56-65`）——远程宿主开箱即用，多宿主未来只值一个配置项

**浏览器 worker 是共享进程**（`apps/worker/src/browser.ts`）：maxSessions=3、20 profile 全局；但有三层防护：出口代理（:46,184）、路由级 validatePublicUrl（:215-222）、WebSocket 掐断（:223）。

**LangAlpha 参照**：User → Workspace 1:1 → Daytona 沙箱；密钥走 relay 不进沙箱。

**威胁模型基线**（现有工位赖以成立、本设计显式继承或显式改变的）：
1. 容器内无任何凭证（env 白名单巡检强制）
2. network=none，内容不可外传
3. 文件网关限尺寸，磁盘不可滥用
4. 共享 worker 的浏览器有出口代理+URL 校验+WS 掐断

## 2. 目标形态与威胁模型变化

每个注册用户一台云电脑：

| 维度 | 规格 |
|---|---|
| 容器 | `openmuse-{deployment}-{ownerHash}-cloud`（沿用现有前缀，managed 标签值 `cloud-v1` 区分档） |
| 资源 | 4 vCPU / 8 GB（limit）、memory-swap=8G（禁 swap）、pids 512 |
| 系统 | Ubuntu 24.04 + python3/node20/git/ripgrep/ffmpeg/sqlite + 中文字体 + Chromium（§5），单镜像 v1 |
| 用户 | uid 1000、cap-drop ALL、no-new-privileges |
| 卷 | 每用户命名卷挂 `/home/user`（持久）；rootfs 可写层在 stop 后保留（Docker 事实），视为半持久：契约版本不匹配或磁盘超限才 rm 重建（§3） |
| 网络 | 有网，**显式代理 + 默认拒绝**（§4）；入站零端口映射 |
| 生命周期 | 首用创建 → 空闲回收（§3）→ 秒级 start；卷永存 |

**双档并存**：`computer` 无网工位不变（主 agent 默认执行环境，提示注入风险最高的路径坚持零网络零凭证）；`cloud` 云电脑是用户显式启动的持久个人环境。

**Provider 选型（评审后增补，回应"为什么不能像金融 agent"）**：能像，而且应该是第一条路。`CloudComputerService` 的巡检/lease/调度语义（§3）与 provider 解耦，两个 provider：

| | daytona provider（先上） | docker-local provider（后上，可切换） |
|---|---|---|
| 容量 | 沙箱不占 138，**4C8G 每用户立刻成立，无需升配** | 必须升配 16C64G（§6） |
| 生命周期 | 白送（auto_stop/snapshot/持久卷/恢复，LangAlpha 生产在跑） | 自己写（本设计 §3 已自洽） |
| 出口白名单 | Daytona `networkAllowList/networkBlockAll`（创建参数） | squid + DOCKER-USER（§4） |
| 凭证 | API key 只存服务端；沙箱内零凭证原则不变 | 同左 |
| 数据主权 | **沙箱在第三方云（海外）：用户文件/浏览器 cookies 出境，国内延迟与合规成本** | 全在自己机器 |
| 成本 | 按沙箱时长计费，随用户线性涨 | ECS 升配包月，固定 |
| 浏览器 CDP | 需经 Daytona signed preview URL 或隧道（P2c 再定） | 内网 backplane，天然安全 |
| 团队现状 | 已跑通线上、有账号、有 entitlements 经验 | 从零 |

**路径：先 daytona provider 上线（P2a 直接可用，绕开升配阻塞）；docker-local 作为数据主权/成本优化时的切换项保留在设计上。**调度/巡检/审批矩阵两层一致，切换对用户无感。

**威胁模型的三处显式改变（接受并监控，而非假装没变）**：
1. 有网 ⇒ 内容可经**白名单内可写域名**（GitHub/npm 等）外泄。白名单防"连任意服务器"，防不住"往白名单域名上传"。残余风险显式接受：出口日志全量记录、按用户可审计、异常上传量告警。
2. 浏览器 profile/cookies 落容器内用户卷 ⇒ **profile 目录显式列为"容器内凭证"**（小红书/公众号/抖音场景价值最高的资产）。防护：容器内 Chromium 仍由 worker 经 CDP 驱动（Playwright route hooks + validatePublicUrl 在 worker 侧继续生效）+ 网络层 egress 代理兜底 + §4 白名单。
3. rootfs 可写层跨 stop 持久 ⇒ 被篡改二进制可存活；用契约版本化重建 + 磁盘配额（§3）收敛。

**多 agent CLI 的凭证困境（评审 B2 裁决）**：容器内预装 Claude/Grok 需要模型 key，但 §4 零凭证原则不允许 env 塞 key。**裁决：agents 镜像层在 per-user relay 落地（v2）之前不启用**，本轮只把 relay 列为 P2d 硬前置。容器巡检的 env 白名单永不放行任何 key。

## 3. 生命周期与调度（与现有 lease/CAS 机制自洽）

新增 `CloudComputerService`，复用 ComputerService 的 create/inspect/verifyVolume 模式，**复用同一条 lease/CAS 协调路径**（评审 B5 裁决）：

- **巡检契约版本化**：managed 标签带 `contract=v1`；契约不符不抛 409，而是 **rm 容器重建（卷保留）**——契约可演化，不砖存量。
- **全局并发闸门**：`maxRunning = floor((hostCores-2)/4)`。现有 CAS 全是 per-owner 粒度，全局槽位用 **Redis**（基础设施已有）：`INCR` 占位、`DECR` 释放、超限拒启或触发 LRU；API 崩溃恢复=启动时对账（扫 managed 容器实际状态重建计数）。
- **空闲回收 sweeper**（每分钟）：条件是 **idle>30min 且无 running 命令**——心跳只在提交时刷一次，10min 长任务跑一半离开不会被杀（评审 S2）。回收与 LRU 抢占**都走与 `stop()` 相同的两阶段路径**（先 CAS 隔离 running 命令回执，再 docker stop），不允许绕过状态机直接 stop（评审 B5）。
- **长任务 lease 语义**：cloud_exec 异步命令 = 提交时取 lease、执行中周期续租（heartbeat）；lease 过期即与 stop 路径联动隔离。180s 固定 lease 不适用长命令，cloud 档 lease 改为可续租。
- **磁盘配额**（评审 B4）：先核实宿主 fs（xfs+pquota 才支持 `--storage-opt size`；ext4 无效）。可移植方案：sweeper 周期 `du` 各用户卷+可写层，超 20G 先告警、超 30G 走两阶段 stop + rm 重建。镜像体积计入预算。
- **CPU 公平配额**：v1 只做 docker stats 采样计量进 store（指标），不做硬停机（cgroup cpu.stat 随重建归零，硬限形同虚设——评审 S4）；首个滥用事件后再上硬限。
- **rootfs 容量**：可写层计入上述 du 口径。

## 4. 网络与凭证（重写，评审 S1/B2/B3）

1. **容器内零凭证**：env 白名单同现有（PATH/HOME/LANG/NODE_VERSION/YARN_VERSION），巡检强制；用户密钥未来一律 per-user relay（v2）。
2. **出口 = 显式代理 + 默认拒绝**（不用透明代理：443 的 SNI 可伪造、ECH 致盲，ssl_bump 不值得）：
   - squid forward-proxy 容器（每 deployment 一个），CONNECT + dstdomain ACL；容器注入 `HTTP_PROXY/HTTPS_PROXY`。
   - **DOCKER-USER iptables：容器出向默认 DROP，仅放行到 squid**——绕过显式代理的直连出不去（容器 uid 1000 + cap-drop 改不了宿主规则）。
   - **DNS 只走受控 resolver**（只能解析白名单域名），否则 DNS 隧道就是现成外泄通道。
   - **sandbox 网络显式禁 IPv6**（iptables 规则不管 v6）。
   - apt/80 端口同样只经代理。
3. **白名单 v1（静态）**：模型 API 域名、npm/pypi/apt 镜像、`causal-memory.com`（MCP hub）、GitHub。
4. **容器间隔离**（评审 B3）：每用户独立 docker network（egress 走各自网→squid）；worker→云电脑 CDP 走独立 backplane 网络，**iptables 只允许 worker 容器 IP → 对应云电脑 9222，其余容器间互访全 DROP**。CDP 无鉴权，绝不出现在任何共享网络上。
5. **入站**：零端口映射；用户访问全走 API 反代 + JWT（8787）。

## 5. 浏览器：搬进云电脑，但切换前不双写

**Daytona 化后的两处修订（P2a 探针实锤后更新）**：
1. **驱动模型改为"箱内驱动"**：Daytona 沙箱在远端（us 区），没有设计时的内网 backplane；把 CDP 暴露到公网（即使 signed URL）不值得。云电脑本身是完整 Linux——Playwright 直接装在箱内，agent 经 `cloud_exec` 驱动浏览器，cookies 不出箱。worker 侧的 route hooks 模型不适用于箱内驱动；URL 校验下沉为箱内 CLI 的白名单参数（v1 默认全放行——云电脑本来就是用户自己的地盘，与工位威胁模型不同）。
2. **区域风险（连接器场景的硬约束）**：Daytona 沙箱在美区，实测百度 connection reset。小红书/公众号/抖音等国内平台对境外 IP 的限流/封锁很可能让**连接器场景在 Daytona 上根本不可用**。裁决：连接器账号类浏览**长期留在国内**（现有 worker 或未来 docker-local/自托管 runner），云电脑浏览器只做通用浏览。这反过来强化了 docker-local provider 的长期价值。

- 每箱 1 个 Chromium（headless，noVNC 后评），profile 落箱内 `/home/daytona/.om-browser`（Daytona 沙箱磁盘跨 stop/start 持久，autoDelete 关闭）。
- **不保留共享 worker 降级双写**（评审 S6）：连接器留在现有 worker 直到（如果）国内沙箱就绪，不存在两处 cookie 分叉期。
- 通用浏览能力在云电脑就绪后优先走云电脑（未启动则先启动）。

## 6. 容量规划（docker-local provider 的约束；daytona provider 不受此限）

**138 现状：4 vCPU / 7 GB / 45G 空闲磁盘——一台 4C8G 都放不下。**用 daytona provider 则沙箱不占本机，本节约束全部不生效。

- **A. 升配宿主机**（推荐）：ECS 升 16C64G + 200G 数据盘 → `maxRunning=3` 台活跃 + 空闲停止超配 ~20 注册用户。成本用户确认。
- **B. 降规格过渡**：2C4G 档现机也只能 1 台活跃，只适合单人开发期。
- **C. 第二台宿主**：横向扩展正路，v1 不做；`runDocker` 透传 DOCKER_HOST 已使远程宿主近乎免费，届时一个 host 配置项即可，不提前建调度抽象（评审 O3）。

建议 A 扛到 ~20 用户（仅 docker-local 路径需要）。P2a 代码不阻塞于升配（单机 2C4G 档即可开发联调）。

## 7. API / 工具面与审批矩阵

- `computer_*` 工具族加 `tier: "sandbox" | "cloud"`（默认 sandbox，行为不变）。
- 新工具 `cloud_status / cloud_start / cloud_stop / cloud_exec`（异步提交 + 轮询/SSE；单命令上限 10min、输出上限沿用 128KB 分片）。
- 文件面沿用 files.py 网关模式（路径白名单 `/home/user`）。
- 设置页"我的云电脑"卡片（状态/规格/最近活动/手动停止）。

**审批矩阵**（评审 S7，对照现有 reviewed-writes 机制）：

| 操作 | 审批 |
|---|---|
| cloud_start / cloud_stop | 免审批（用户自己发起或 agent 代发均可，视为状态操作） |
| cloud_exec（bash） | 沿用 computer 现状：免审批（容器即用户地盘，与工位同模型） |
| 文件读写 `/home/user` | 免审批（同上） |
| 容器内对外发送类动作（发消息/下单/发布） | 走各连接器既有 reviewed-writes，与云电脑无关 |
| sweeper/LRU 自动停止 | 系统行为，通知用户 |

## 8. 为多 agent 编排预留（本轮只留接口，不实现）

- **P2d 硬前置：per-user relay**（agent CLI 的模型 key 注入唯一合法通道，见 §2 裁决）。
- 容器内约定：`/opt/agents/<name>/`（bin+config）目录占位；镜像 v1 单层，agents 落地时再分层（评审 O2）。
- `cloud_exec` 的 target 语义预留 `container:agentName`，调度不假设单进程。
- 通信层下一轮选型（Redis pub/sub vs ag2/crewai 等），硬需求：跨容器、跨模型、人在审批环。**不设 unix socket 目录**（过不了容器边界，与跨容器硬需求矛盾——评审 O1）。

## 9. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| P2a | cloud 镜像 + CloudComputerService（契约版本化创建/巡检/启停/续租 lease/sweeper 无任务才收/Redis 全局槽位/磁盘 du 口径）+ tier 参数 | 两邮箱账号各自启动，卷/进程互不可见；超限容器被杀宿主无恙；带 running 命令不被回收、空闲 30min 被回收；测试基线全绿（开工先实测当前值，本文撰写时为 372） |
| P2b | squid + DOCKER-USER 默认拒绝 + 受控 DNS + 禁 IPv6 + 零凭证巡检 | 容器内 curl npm 镜像**通**、curl 百度**拒**、直连 IP（绕代理）**拒**、env 无任何 key、容器 A 无法连通容器 B 任意端口 |
| P2c | 浏览器入容器 + worker CDP 路由 + backplane 隔离 + profile 一次性迁移 | 云电脑内 CDP 可操作且 route hooks 生效；profile 重启仍在；两用户 cookie 互不可见；worker→A 容器 CDP 通、A→B CDP 拒 |
| P2d（下一步） | per-user relay + agents 镜像层 + 通信层选型 + 首个多 agent 场景 | 另行设计 |

**上线前置（用户侧）**：① 宿主机升配决策（§6）；② 安全组保持零入站。

## 10. 明确不做（本轮）

多 agent 编排本体与 agents 镜像层（relay 前置，见 §2）；Web 终端/noVNC；per-user relay 凭证注入（v2）；跨宿主调度抽象；CPU 硬配额（只采集指标）。
