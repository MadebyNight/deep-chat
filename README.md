# Deep Chat · DeepSeek 第三方聊天客户端（Android）

基于 DeepSeek 官方开源示例 [chat-demo](https://github.com/deepseek-ai/chat-demo)（v0.1.1，commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`，MIT）构建的独立第三方 Android 客户端：使用用户自己的 DeepSeek API Key 直连官方 API，聊天界面按同机官方 App（com.deepseek.chat 2.8.0）实测对齐。

- 独立身份：应用名「Deep Chat」，包名 `app.deepchat.mobile`，与官方客户端无隶属关系，不冒充官方客户端。
- 不收款、不代充、不转售额度、不自建后端；请求从设备直连 `https://api.deepseek.com`。
- API Key 经 Android Keystore（AES/GCM）加密后存入本机 SharedPreferences，不用 localStorage 明文保存，不写入日志、崩溃信息或导出文件。

## 环境要求

- Node.js 20+、pnpm 9+
- JDK 21、Android SDK（compileSdk 36、Build-Tools 35/36）
- 本地工具链统一放在工作区 `.toolchain/`（不进代码仓）：`source tools/env.sh` 后即有好 JAVA_HOME / ANDROID_HOME / GRADLE_USER_HOME / adb / pnpm。
- Android SDK Platform-Tools 用于安装与采集（仅开发用途），不是使用 App 的前置条件。

## 构建

```bash
source tools/env.sh      # Git Bash；配置 JAVA_HOME/ANDROID_HOME/GRADLE_USER_HOME
pnpm install             # 锁文件 pnpm-lock.yaml，版本锁定
pnpm build               # rspack 生产构建，输出 dist/
pnpm exec cap sync android   # 同步 Web 资源与 Capacitor 插件到 android/
cd android
./gradlew assembleDebug  # 输出 android/app/build/outputs/apk/debug/app-debug.apk
```

调试签名：默认使用 AGP 标准调试密钥（`~/.android/debug.keystore`，缺失时自动生成）。也可用标准参数自行生成后放到 `.toolchain/debug.keystore`（storepass/keypass 均为 `android`，别名 `androiddebugkey`）：

```bash
keytool -genkeypair -alias androiddebugkey -keypass android -storepass android \
  -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000 \
  -keystore .toolchain/debug.keystore
```

应用图标与启动图由 `tools/generate_icon.py` 生成（`python tools/generate_icon.py`，需 Pillow），修改后需重新构建。

## 安装

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## 首次连接 DeepSeek

App 不要求注册本 App 账号。首次发送（或设置 → 连接 DeepSeek）进入可自动接续的向导：

1. **使用 DeepSeek 账号连接**：通过 Custom Tabs 打开官方创建 Key 页 `https://platform.deepseek.com/api_keys`（复用浏览器登录态）；未登录先在官方页登录或注册，创建并复制密钥。
2. **回到 App 自动恢复到「粘贴并连接」**：点「粘贴并连接」才读取剪贴板（不监听剪贴板），自动校验 Key 并查询余额，成功后加密存入本机。
3. **余额分流**：有余额直接回到原会话与草稿；余额不足在向导内提示去官方充值页，从充值页返回自动刷新一次余额，到账后恢复原草稿。
4. 中断（离开、取消、无网络、Key 无效、限流）都会保留进度与草稿；取消不删除已有会话。设置中可查余额、换 Key、移除 Key。

官方登录、验证码、授权与付款均由用户在官方页面确认；App 不代登录、不代付、不注入网页脚本。

## 聊天能力

- 流式增量、停止生成、继续生成、编辑重试、重新生成与消息分支；Markdown / 代码块 / LaTeX 公式 / 表格渲染，联网搜索引用与来源面板。
- 深度思考、智能搜索开关；附件（图片/文件）与语音转写沿用上游能力；朗读与自动朗读（顶栏开关）。
- 主题：浅色 / 深色 / 跟随系统；语言：简体中文 / English。

## 历史数据

- 会话、草稿、附件索引在本机 IndexedDB 持久化，杀进程重开可恢复。
- 设置 → 数据管理：导出为官方网页端同格式 ZIP（不含 Key）；导入前显示可读预览，默认保留已有会话、可勾选导入、重复自动跳过、失败不影响本地数据。

## 验证

- `pnpm type`、`pnpm lint`、`pnpm build` 全部通过。
- 真机（OPPO PGAM10，Android 14）安装、首启、连接向导各分支、发送/停止、历史抽屉、设置、主题与返回键见交付报告 `FINAL_REPORT.md`。

## 许可

- 上游 chat-demo：MIT，见 `licenses/chat-demo-LICENSE`。
- 本项目其余代码以相同 MIT 条款发布。
