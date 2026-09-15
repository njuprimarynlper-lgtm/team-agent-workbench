# 第三方运行组件

- Electron 44.3.0：随两版分发，原许可证及 Chromium notices 保留在应用目录。
- Codex CLI 0.154.0：来自官方 npm `@openai/codex` 与 Windows x64 平台包，Apache-2.0，原许可证放在用户版 `resources/providers/codex/LICENSE`。
- Cursor Agent CLI 2026.09.10-fd3934a：来自 Cursor 官方 Windows 发布包，原运行目录整体保留。用户仍使用自己的 Cursor 账号，产品使用受 Cursor 的条款及账号权限约束。
- React、ssh2、archiver、zod、lucide-react 等依赖版本及来源由 `package-lock.json` 固定。

本项目没有打包任何开发者登录数据、服务器密码或业务会话。第三方组件升级应重新检查原生协议、许可证与打包兼容性。
