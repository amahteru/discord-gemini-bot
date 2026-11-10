# Discord Gemini Bot

基于 Cloudflare Workers 和 Google Gemini API 构建的 Discord 聊天机器人。

## 配置

| 环境变量名 | 描述 | 是否必须 | 默认值 |
| --- | --- | --- | --- |
| `DISCORD_APPLICATION_ID` | Discord 应用的 Application ID | 是 | - |
| `DISCORD_PUBLIC_KEY` | Discord 应用的 Public Key | 是 | - |
| `GEMINI_API_KEY` | Google Gemini API 密钥 | 是 | - |
| `GEMINI_MODEL` | 使用的 Gemini 模型版本 | 否 | - |
| `OPENROUTER_API_KEY` | OpenRouter API 密钥 | 否 | - |
| `OPENROUTER_MODEL` | 使用的 OpenRouter 模型版本 | 否 | - |
| `API_PROVIDER` | 控制使用哪个 API，可选 `OPENROUTER` 或 `GEMINI` | 否 | OPENROUTER |
| `SYSTEM_PROMPT` | 机器人行为设定 (System Prompt) | 否 | - |

## 使用

在部署并完成 Endpoint 配置后，将机器人邀请至您的 Discord 服务器。

在任意有权限的聊天框中输入：
```
/ask prompt: 你要说的话
```

## 协议

本项目采用 [MIT 许可证](./LICENSE) 开源。