# LangAlpha AG-UI 联调

OpenMuse 把对话路由交给 LangAlpha 时，走的是 LangAlpha 的 AG-UI 网关：`AGENT_BACKEND=agui`，
`AGENT_URL` 指向 `POST /api/v1/agui/run`。这一页是怎么起两边、怎么验、该看到什么。

本文只覆盖联调步骤，不覆盖真机压测与多租户语义（见文末「已知差异」）。

## 接线

```
移动端/Web ──▶ OpenMuse  :8787  ──▶ LangAlpha :8000
              /api/copilotkit/            /api/v1/agui/run
              agent/default/run           （AG-UI SSE）
```

- OpenMuse 用 `@ag-ui/client` 的 `HttpAgent` 发起一次 run，`AGENT_URL` 就是那次 POST 的地址。
- 出站是标准 `RunAgentInput`（camelCase），入站是 AG-UI 事件流：SSE 帧形如
  `data: {"type":"TEXT_MESSAGE_CONTENT",...}\n\n` —— **类型在 data 载荷里，没有 `event:` 行**。
- 适配层在 `apps/server/src/agui.ts`，契约测试在 `tests/agui.test.ts`。

## 起 LangAlpha

网关默认关闭，必须显式打开（否则 `/api/v1/agui/*` 一律 503）：

```bash
cd /Users/didi/LangAlpha
make setup-db
AGUI_ENABLED=1 make dev
```

`ptc` 模式还需要 Postgres + Redis 和一个可用的 workspace；只想打通链路时用 `flash` 模式即可绕开沙箱。

## 起 OpenMuse

`.env` 里至少要这几项（`pnpm dev` 会读）：

```bash
WORKSPACE_MODE=sample
AUTH_MODE=local
AGENT_BACKEND=agui
AGENT_URL=http://127.0.0.1:8000/api/v1/agui/run
```

然后：

```bash
cd /Users/didi/openmuse
pnpm dev
```

`AUTH_MODE=local` 会在启动时打印一个 dev access key；也可以现取一个会话 token：

```bash
TOKEN=$(curl -sS -X POST http://localhost:8787/api/session \
  -H 'Content-Type: application/json' \
  -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

## 直接 curl LangAlpha

先证明网关本身是通的，再看 OpenMuse 这一侧——两段分开验，故障就不用猜是哪边。

```bash
curl -sS http://127.0.0.1:8000/api/v1/agui/status
```

预期：`{"enabled":true}`。

```bash
curl -N -sS -X POST http://127.0.0.1:8000/api/v1/agui/run \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{
    "threadId": "e2e-thread-1",
    "runId": "e2e-run-1",
    "messages": [{"id": "m1", "role": "user", "content": "用一句话说明你是什么"}],
    "tools": [],
    "context": [],
    "state": {},
    "forwardedProps": {"agentMode": "flash"}
  }'
```

`-N` 关掉 curl 自己的缓冲，否则你会以为服务没在流式输出——它只是被 curl 攒着了。

开一个线程（可选，用于第一条 run 之前就拿到 thread id）：

```bash
curl -sS -X POST http://127.0.0.1:8000/api/v1/agui/threads \
  -H 'Content-Type: application/json' \
  -d '{"first_query": "hello", "agent_mode": "flash"}'
```

预期：`{"thread_id":"...","workspace_id":""}`。

## 经过 OpenMuse 走一遍

```bash
curl -N -sS -X POST http://localhost:8787/api/copilotkit/agent/default/run \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{
    "threadId": "om-thread-1",
    "runId": "om-run-1",
    "messages": [{"id": "m1", "role": "user", "content": "用一句话说明你是什么"}],
    "tools": [],
    "context": [],
    "state": {},
    "forwardedProps": {"agentMode": "flash"}
  }'
```

注意这里的响应已经是 CopilotKit runtime 自己的事件格式，不是 LangAlpha 的原始帧——中间隔着一次
翻译。想看 LangAlpha 的原始帧，只有上一节那条 curl。

`threadId` 会一路带下去：runtime 在跑之前把 `agent.threadId = input.threadId`，`RunAgentInput`
再用它当 `threadId`。同一个 `threadId` 第二次调用就是同一段对话。

## 预期事件序列

一次纯文本、无推理、无工具的 run，LangAlpha 侧（也就是上一节 curl 的输出）应当按这个顺序：

```
RUN_STARTED                      {"threadId","runId"}
CUSTOM   name=langalpha.thread   只在 threadId 对 LangAlpha 是新的时出现一次
TEXT_MESSAGE_START                {"messageId":"<runId>:1","role":"assistant"}
TEXT_MESSAGE_CONTENT              {"messageId":"<runId>:1","delta":"..."}   重复 N 次
TEXT_MESSAGE_END                  {"messageId":"<runId>:1"}
RUN_FINISHED                      {"outcome":"success"}
```

分支：

- 开了推理：`THINKING_START` → `THINKING_TEXT_MESSAGE_START` → `THINKING_TEXT_MESSAGE_CONTENT` × N
  → `THINKING_TEXT_MESSAGE_END` → `THINKING_END`，夹在文本之前。
- 用了工具：`TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` → `TOOL_CALL_RESULT`。
  工具调用会**先关掉**已经打开的文本消息，所以 `TEXT_MESSAGE_END` 可能出现在 `TOOL_CALL_START` 之前。
- 子 agent 的旁白不进正文，走 `CUSTOM name=langalpha.agent_text`。
- 失败：`RUN_ERROR {"message","code"}`。它同样会先关掉打开中的块，之后不会再有 `RUN_FINISHED`。

`RUN_FINISHED` 是**唯一**需要 OpenMuse 侧改写的帧，见下节。

## 排查

| 现象 | 原因 |
|------|------|
| `503 agui gateway is disabled` | LangAlpha 没设 `AGUI_ENABLED=1` |
| `401 Missing authentication` | LangAlpha 跑在 platform host mode，需要 `Authorization: Bearer <Supabase JWT>`；本地联调可改用 oss host mode，它不校验 |
| 答案流完了，最后报一个 zod / schema 错 | `RUN_FINISHED.outcome` 的适配丢了，见下节 |
| `RUN_ERROR` 说 `carried no user message` | `messages` 里没有 `role:"user"` 且 `content` 为非空字符串的条目 |
| 每轮都当新对话 | `threadId` 没传到 `HttpAgent`；确认是走 runtime 的 run 路径（它会设 `agent.threadId`），而不是自己 new 了一个 agent |
| 起了 ptc 但报 workspace 相关错 | ptc 需要一个 workspace；`forwardedProps.workspaceId` 没给时会取该用户最近一个，没有就新建，失败不降级 |

## 已知差异

OpenMuse 侧对 LangAlpha 只做了一处改写（`apps/server/src/agui.ts`）：

**`RUN_FINISHED.outcome` 的形状。** AG-UI 0.0.59 把 `outcome` 定型成判别对象
（`{"type":"success"}`），而 LangAlpha 的 `events.run_finished` 默认发的是裸字符串 `"success"`，
`translate.Translator` 也从不传别的值。`@ag-ui/client` 在事件到达订阅者之前会先用
`EventSchemas` 校验每一帧，**校验失败是整条流报错，而不是丢一个事件**——所以不修的话，每轮对话都会
把答案完整推完，然后在最后一个事件上失败。适配层因此把这一帧改写掉，只在 `outcome === "success"`
时改写；interrupt 类的结果还需要 `interrupts` 数组，这里造不出来，宁可让它响亮地失败。

请求体不需要适配：`@ag-ui/client` 发的 `threadId`/`runId`/`messages`/`tools`/`context`/`state`/
`forwardedProps` 与网关的 `RunAgentInput` 一致，多出来的 `context` 被网关的 `extra="allow"` 收下。

其余几处是**语义**差异，不是 bug，但会影响 M3：

- **身份。** `AGENT_TOKEN` 一旦设置，`Authorization` 就被钉在服务端配置的那个 token 上——
  CopilotKit 让服务端配置的 header 覆盖入站 header，于是调用者自己的 `authorization` 不再转发，
  所有用户塌缩成同一个 LangAlpha 用户。不设 `AGENT_TOKEN` 时，runtime 会把调用者的 token 转发过去，
  这正是让每次 run 落在对应用户 workspace 里的方式。两侧的 Supabase `sub` 是同一个 UUID，所以这条
  链路是通的。
- **`agentMode` / `workspaceId`。** 网关从 run 的 `forwardedProps` 里读这两个后端专属选项；不传就是
  `ptc` + 调用者最近一个 workspace。OpenMuse 目前不注入它们，需要时得让客户端在 run 请求里带
  `forwardedProps`。
- **消息内容必须是字符串。** 网关的 `AguiMessage.content` 是 `str | None`，多模态 content part 数组
  会被 422。当前 OpenMuse 的附件是拼进文本里发的（"Attached documents: …"），所以还没踩到。
