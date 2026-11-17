# Dear Moments Core

独立的长期记忆核心，使用 SQLite 保存带来源的原话、事实及派生索引，提供本机 HTTP API、Web 管理台和 DSH 插件。

## 安装和运行

需要 Node.js 22.13.0 或更高版本，推荐 Node.js 24。

完整解压后双击启动脚本，或执行：

```sh
node server.mjs
```

终端会显示本机管理台地址。运行服务仅使用 Node.js 内置模块。参与开发时执行：

```sh
npm ci
npm run lint
npm run format:check
npm test
node smoke.mjs
```

## 数据和配置

默认数据目录为项目下的 data，数据库为 memory.sqlite。用 DM_CORE_DATA_DIR 修改位置。DM_CORE_PORT 可固定端口。DM_CORE_TOKEN 可指定本机认证令牌，留空时每次启动生成随机值。令牌和地址写入 data/core.json 及 ~/.dear-moments-core/core.json。

配置本地事实整理模型前，先部署 Ollama 与模型，然后设置：

```powershell
$env:DM_CORE_MEMORY_MODEL="qwen3.5:9b-q4_K_M"
node server.mjs
```

Embedding 可在 Web 管理台配置。本地默认使用 Ollama。兼容云端 Embedding 需要显式授权，密钥从 DM_EMBEDDING_API_KEY 读取。模型切换后，后台按模型身份重新补全旧分块。

## HTTP API

所有 POST API 使用 Bearer 令牌并返回 {ok,value}，错误返回 {ok:false,error}。地址限本机，管理台同源访问可以使用 API，外部浏览器 Origin 被拒绝。

以下示例使用描述文件：

```powershell
$core=Get-Content ./data/core.json -Raw | ConvertFrom-Json
$headers=@{Authorization="Bearer $($core.token)"}
$body=@{sessionId="example";eventId="example:1";role="user";text="我喜欢桂花茶"} | ConvertTo-Json
Invoke-RestMethod ($core.url+"/ingest") -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

| 路由                      | 请求字段                                               | 返回内容                                  |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| POST /ingest              | sessionId、eventId、role、text，可选 time、interrupted | 接纳结果、消息 ID、重复标志和后台索引状态 |
| POST /search              | query、可选 limit                                      | 带来源、角色和时间的检索证据              |
| POST /context             | query                                                  | 预算内的证据上下文字符串                  |
| POST /source              | id、可选 chunkId、offset、limit                        | 回合来源或手动记忆，支持分块分页          |
| POST /status              | 空对象                                                 | 记录计数和后台状态                        |
| POST /jobs/status         | 空对象                                                 | 任务状态计数、处理中标志和通用错误状态    |
| POST /embedding/config    | 空对象                                                 | Embedding 配置及密钥是否配置              |
| POST /embedding/configure | kind、baseUrl、model、cloudConsent、可选 apiKeyEnv     | 保存配置                                  |
| GET /health               | Bearer 认证                                            | 服务健康信息                              |

后台失败日志包含阶段、通用错误码和时间。/status 保留原有计数字段，并增加 background。关闭信号会取消后台请求并关闭数据库。

## 架构

- server.mjs 管理 HTTP、认证及静态资源。
- core-runtime.mjs 协调接纳事务、增量历史回填、索引与后台生命周期。
- memory.mjs 管理记忆语义、检索与事实操作，memory-worker.mjs 管理本地抽取任务。
- long-text-index.mjs 管理分块索引，providers.mjs 管理本地及兼容模型调用。
- source-reader.mjs 统一来源读取，store.mjs 管理 SQLite 和备份，schema-migration.mjs 管理历史表迁移。
- settings.mjs 提供 Core 配置，legacy-settings.mjs 支持历史配置的备份恢复。
- public 下的 HTML、CSS 和 JavaScript 构成管理台。

原始消息和派生结构分开保存。接纳失败可重试，Embedding 分批补全。启动先初始化历史回填，随后只处理发生变化的会话。检索使用现有 FTS5、向量及 RRF 排序。

diaries 作为有来源的叙述保留，personas 作为历史人格或用户模型提案保留，tasks 作为任务审计保留。这些表继续参与备份恢复。独立 Core 的后台自动任务负责本地整理和向量索引，云端总管自动调用由桌面项目管理。

## DSH

插件位于 plugins/dsh-dear-moments-core。服务提供 search、source、status 方法。配置 coreFile 可指定描述文件，多实例使用独立 queueFile。插件队列持久化并按稳定事件 ID 重试，默认容量为 10000 条。

## 兼容和备份

原 HTTP 路由和 DSH 调用方式保留。新版本采用附加表和触发器记录脏会话，首次维护迁移前创建 backups/before-core-maintenance-\*.sqlite。完整数据库备份保留旧表和旧 meta 配置。需要回滚时先关闭 Core，保存当前库，再恢复与旧版本匹配的备份。

## 验证

npm test 为可自动复现的测试，CI 在 Windows、Linux 和两个 Node.js 版本运行。早期本地 Ollama、LongMemEval 抽样题和 DSH 真实模型调用属于人工联调，需要独立部署外部环境。

## License

MIT
