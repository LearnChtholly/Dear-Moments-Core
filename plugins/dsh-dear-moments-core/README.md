# Dear Moments Core DSH 插件

精简版 DSH 插件：保留本地 SQLite 记忆查询，并自动捕获 DSH 主会话的用户/助手消息。

## 安装

插件目录需要位于 DSH profile 的 `node_modules` 中，并在 `cordis.patch.yml` 里加入：

```yaml
- insert:
    - id: dsh-dear-moments-core
      name: dsh-dear-moments-core
      config:
        autoCapture: true
```

核心服务必须先启动，默认读取：

```text
%USERPROFILE%\.dear-moments-core\core.json
```

也可以用 `DM_CORE_DESCRIPTOR` 或插件配置 `coreFile` 指定。

## 工具

- `dear_moments_search`
- `dear_moments_source`
- `dear_moments_status`

插件会注入一条简短提示，提醒 DSH 在需要过去对话、偏好、关系、承诺、改口、日期或跨会话上下文时先检索。

## 跨对话记忆

`autoCapture: true` 时：

```text
DSH 用户消息 / 助手消息
→ 插件 session/event
→ POST /ingest
→ SQLite memory unit
→ 后续任意 DSH 会话可检索
```

消息按 DSH `sessionId + event.seq` 去重，工具本身只读，不会把工具结果写回记忆。

## Embedding

Core 默认可使用本地 Ollama，也支持 OpenAI-compatible `/embeddings` 云端接口。云端 Embedding 必须显式授权，API Key 通过环境变量提供，不写入数据库。
0.1.2 会将待提交消息保存到用户目录下的 dsh-outbox.json，默认最多 10000 条。独立实例可用 queueFile 指定独立队列。服务 API 提供 search、source 和 status。
