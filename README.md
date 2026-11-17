# Dear Moments Core

独立的本地长期记忆核心：SQLite、回合级记忆、混合检索、可选本地/云端 Embedding、DSH 插件和本地 Web 管理台。

## 启动

请先**完整解压**压缩包，不要直接在压缩包预览窗口里双击启动脚本。

解压后双击 `启动 Dear Moments Core.cmd`，或运行：

```powershell
node server.mjs
```

打开终端输出的 `http://127.0.0.1:<port>/`。

## 设计

参考 LongMemEval 的 indexing / retrieval / reading 三阶段设计，以对话回合作为原始证据粒度，保留时间戳和来源，记忆内容作为不可信数据提供给 Agent。

## DSH

插件位于 `plugins/dsh-dear-moments-core/`，提供 `dear_moments_search`、`dear_moments_source` 和 `dear_moments_status`。插件会注入一条简短的本地记忆使用政策，提醒模型在需要跨会话信息时主动检索。

## Embedding

默认可使用本地 Ollama，也支持 OpenAI-compatible `/embeddings` 云端接口。云端 Embedding 必须显式授权，API Key 通过环境变量提供，不写入数据库。

## 0.1.3 运行和恢复

最低 Node.js 版本为 22.13.0，推荐维护中的 Node.js 24。根包保持 private，通过 GitHub 源码和压缩包分发。DSH 插件可独立打包。

Core 启动会对既有原始消息回填记忆单元并同步索引。消息和去重回执、记忆派生在同一事务提交。失败重试会恢复已有回执对应的派生处理。Embedding 由后台分批补全，入站接口的 indexed=false 表示尚未确认全部分块完成。

后台 MemoryWorker 已启动。用 DM_CORE_MEMORY_MODEL 指定本机已部署的 Ollama 整理模型，例如 qwen3.5:9b-q4_K_M。仅配置 Embedding 时，独立索引任务继续处理每批 8 个分块，包括超过一批的长记录和中途失败的任务。失败保留未完成分块，后续定时重试。退出信号会取消后台请求并等待数据库操作结束。

描述文件保存在 data/core.json，同时在 ~/.dear-moments-core/core.json 维护稳定发现入口。DSH 可用 coreFile 或 DM_CORE_DESCRIPTOR 显式指定。多实例使用独立 descriptor 和 queueFile。

插件队列写入 ~/.dear-moments-core/dsh-outbox.json。去重、失败重试和跨 DSH 重启恢复均使用同一稳定 eventId。最多积压 10000 条，达到上限时报告错误，需恢复 Core 连接后继续。

检索先查询缺少索引状态的记录并增量更新，启动时执行全量一致性同步。检索向量相似度计算仍随索引规模增长。

## 验证

npm test 为可自动复现的回归。GitHub Actions 在 Windows、Linux 及 Node 22.13.0、24 上运行回归和 smoke。

早期的本地 Ollama、5 个 LongMemEval 抽样题及 DSH 实际模型调用属于人工联调记录。它们需要外部模型和宿主，本仓库的 npm test 不包含这些端到端过程。

## License

MIT
