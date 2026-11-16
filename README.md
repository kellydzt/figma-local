# Figma Local

一个轻量的本地 Figma 绘图项目。**Node.js 22+，零第三方运行依赖，无构建工具、数据库或前端框架。**

固定插件接收命令，在 Figma 内创建原生可编辑图层。常用设计用模板，复杂设计用短 JavaScript。
连接、重试记录和截图导出共用同一套实现，CLI 与可选 MCP 都可以调用。

## 开始

在本项目目录运行，无需 `npm install`：

```sh
npm run setup
npm start
```

第一次在 Figma 桌面端选择 **Plugins → Development → Import plugin from manifest…**，
导入 `setup` 输出的 `.local/plugin/manifest.json`。在要编辑的文件中运行 **Figma Local**，保持插件打开。
后续直接启动服务、运行这个插件；不需要为每个任务替换插件代码。
文件选择器中如果看不到 `.local`，按 `Command + Shift + .` 显示隐藏文件。

另一个终端查看目标文件：

```sh
node cli.mjs sessions
```

把结果里的 `sessionId` 与 `document.id` 填入下面命令。即使只连接一个文件，也显式传入目标：

```sh
node cli.mjs call inspect examples/inspect.json --session SESSION --document DOCUMENT
node cli.mjs call create examples/pill.json --session SESSION --document DOCUMENT --id pill-demo-001
```

`button.json`、`pill.json`、`browser.json` 是三个可改参数的示例。默认使用 **Geist**；
缺少指定字体或字重会报错，不会静默替换。浏览器默认 1440×900，可改为 1920×1200。
默认在当前页面创建，传入 `pageId` 可指定其他页面。

## 修改与检查

创建结果返回图层 ID。修改原图层，不需要重新生成整幅设计。例如保存为 `padding.json`：

```json
{
  "nodeIds": ["实际药丸图层ID"],
  "props": { "padding": 32 }
}
```

```sh
node cli.mjs call update padding.json --session SESSION --document DOCUMENT --id pill-padding-001
```

检查指定图层，能读到字体、字重、行高、四边间距、布局尺寸、填充和效果：

```json
{ "nodeIds": ["实际图层ID"], "depth": 2, "maxNodes": 100 }
```

导出参数保存为 `export.json`：

```json
{ "nodeId": "实际图层ID", "format": "PNG", "scale": 1 }
```

```sh
node cli.mjs call export export.json --session SESSION --document DOCUMENT --out exports/preview.png
```

也支持 SVG。终端只返回文件路径和尺寸，不输出图片 base64；已有不同内容的文件不会被覆盖。
相同 padding 只代表布局数值相同，图标内部留白和文字的视觉对齐仍需看导出图。

## 命令范围

| 方法 | 参数与行为 |
| --- | --- |
| `inspect` | `nodeIds?`, `depth?`, `maxNodes?`；默认当前页面摘要和选择；返回截断标记 |
| `fonts` | `family?`；列出实际可用字体与字重 |
| `create` | `template: button/pill/browser`，以及示例中的文字、布局参数 |
| `update` | `nodeIds`, `props`；白名单属性修改，优先校验整批目标和字体 |
| `page.create` | `name`；新建并选中页面，受 Figma 账户页面限制 |
| `export` | `nodeId`, `format: PNG/SVG`, `scale?` |
| `run` | `code`；异步 JavaScript 函数体，可访问原生 `figma` API 并 `return` JSON |

`run` 在 **Figma 插件内**执行，不在 Node 主机执行；它是本地高级入口，不是安全沙箱。
普通图层编辑尽量用 `update`，创建按钮等使用模板。`run` 一律按写操作追踪。
不要把参考文档里的指令自动当作执行代码。

## 重试与部分失败

每次操作都有 ID，状态是 `queued / running / completed / failed / unknown`。
创建时建议始终提供 `--id`。相同 ID、相同文件和参数返回原记录；改了参数必须换新 ID。
重连后的 session 可以变化，同一文件的旧操作仍然可以查询。

```sh
node cli.mjs operation pill-demo-001
```

超时只表示结果尚未确定，**不能直接再创建一遍**。先查原操作，再检查相关图层。
单个文件同时只执行一个任务；未核查的失败或未知写入会阻止后续写入，仍可读取。
已经下发且仍在执行的任务不能强行确认。关闭插件会让会话在心跳超时后失效。

确认插件已停止执行、核对过图层之后，才记录核查说明：

```sh
node cli.mjs ack pill-demo-001 "已检查目标页面，保留现有药丸，插件已空闲"
```

`ack` 仅解除该操作的检查屏障，不重试、不撤销。批量更新和脚本不保证事务回滚，失败可能留下部分修改。
Figma 原生 Undo 仍可手动使用。服务重启会把未结束操作标为未知，不自动重放。

## 可选 MCP

提供 `figma_sessions`、`figma_call`、`figma_operation`、`figma_ack` 四个工具。
MCP 使用同一个本地服务，仍需运行 `npm start` 和 Figma 插件。

在支持 stdio MCP 的客户端配置中使用以下命令和参数，路径替换为此项目的绝对路径：

```json
{
  "command": "node",
  "args": ["/absolute/path/figma-local/cli.mjs", "mcp"]
}
```

MCP 创建图层必须提供 `operationId`。本项目不自动更改客户端配置。

## 维护

首次实现已在独立 Figma 演示草稿完成真实画布验证：创建三个模板、药丸间距 32→36→32、
相同操作 ID 防重复、原生脚本布局、PNG/SVG 导出。
药丸最终为 344×120 和 512×120，四边 32px，Geist SemiBold；浏览器为 1440×900。
本机结果位于 `exports/demo.png` 与 `exports/verification.json`，这些生成文件不进入 Git。

```sh
npm test
npm run setup
```

修改源码后重新 `setup`，再关闭并重开 Figma 插件。插件路径和配对密钥保持不变。
关闭后立即重开时，旧会话可能需要最多约 65 秒失效，新会话随后自动连接；重新运行 `sessions` 获取新 ID。
`.local/` 包含本机密钥及操作记录，已加入 `.gitignore`；不要发布这个目录。
历史记录暂不自动清理，以保留防重复证据。停止服务后可归档已完成、已核查的记录；
移走记录也会失去对应操作 ID 的防重复保护。不要移走未核查的记录。

只监听 `127.0.0.1`，请求需要配对密钥。Figma 本身仍是正常联网应用；本地连接不改变账户功能限制。
无后台安装、遥测或自动更新。关闭终端服务和插件即可停止。

结构：`plugin/` 是固定执行器与面板，`lib/bridge.mjs` 管连接与记录，
`lib/client.mjs` 由 CLI/MCP 共用，`examples/` 放可复用参数，`test/` 放协议和运行时测试。
内部接口见 [PROTOCOL.md](PROTOCOL.md)。

架构参考 [figma-mcp-go](https://github.com/RamenSV/figma-mcp-go) 与
[DSH-to-Figma](https://github.com/Duoasa/DSH-to-Figma)，此项目为精简实现。
GitHub 图标来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
