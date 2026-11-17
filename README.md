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

## 当前验证

- SQLite 写入和 memory unit 生成：通过
- 5 个 Benchmark 抽样题的回放、检索和来源读取：通过
- 本地 Ollama Embedding 检索：通过
- 云端 Embedding 未授权保护：通过
- OpenAI-compatible Embedding 联调：通过
- Web 管理台页面返回和关键组件检查：通过
- DSH profile 插件安装、发现和导入：通过
- DSH 实际模型调用 `dear_moments_search`：通过
- DSH 实际模型调用 `dear_moments_source`：通过
- DSH 实际模型调用 `dear_moments_status`：通过
- 未明确要求调用工具时，DSH 依据插件提示词自动检索：通过
- DSH 主会话用户消息自动写入 Core：通过
- 新 DSH 会话检索上一会话内容：通过

端到端验证中，DSH 模型检索到测试暗号 `BLUE-WHALE-8472`，读取原始来源并正确回答。`dear_moments_status` 返回消息、记忆单元、分块和索引数量。

## License

MIT