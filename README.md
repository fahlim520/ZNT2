# 智能体 · 顶部滑出任务管家

一款 Windows 桌面待办工具，复刻经典 QQ 的顶部贴边体验：鼠标移到窗口所在位置的屏幕顶部，任务窗口自动滑出；移开后快速收回。支持自然语言添加任务、本地保存和提醒回复。

## 下载试用

适用于 Windows 10 / 11，64 位。试用者无需安装 Node.js 或下载源码。

**[前往 Releases 下载试用版](https://github.com/fahlim520/zhinengti/releases/latest)**

- `zhinengti-0.1.0-windows-x64-portable.exe`：便携版，下载后双击运行。
- `zhinengti-0.1.0-windows-x64-setup.exe`：安装版，可选择安装目录并创建快捷方式。
- `SHA256SUMS.txt`：下载文件的 SHA-256 校验值。

首次启动会展示设置。可填写**自己的 DeepSeek API Key**，点击“测试连接”后保存；也可以先跳过，用“手动添加”创建任务。程序内及安装文件的产品名称沿用“轻任务 / QQ 滑出任务管家”。

这是早期试用版，安装文件暂未进行代码签名。应用需要保持运行才能发出提醒；隐藏窗口后仍在系统托盘运行，通过托盘菜单“退出轻任务”可完全退出。

## 使用方式

- 鼠标移到窗口所在位置的屏幕顶部展开；移开后自动收回。也可点击顶部标签或托盘图标展开。
- 拖动标题区域或顶部标签，沿屏幕顶部移动窗口。
- 拖动右边调宽、底边调高、右下角同时调整宽高；位置和尺寸会自动保存。设置中可“恢复默认大小”。
- **Enter 发送，Shift+Enter 换行**；中文输入法确认选字时不会发送。
- 支持勾选完成、编辑、删除、搜索以及工作 / 生活 / 学习等分类。
- 点击“贴边自动隐藏”可固定展开，再点一次恢复自动隐藏。

## 提醒示例

日期和时间按中国时区 `Asia/Shanghai` 理解。

| 输入 | 提醒行为 |
| --- | --- |
| 今天 15.05 提醒我整理电脑 | 今天 15:05 提醒，不改成一小时后；若该时刻已过，运行中的应用会补提醒 |
| 今天我要整理电脑 | 创建今天的任务，通常在一小时后首次提醒；临近当天结束时会提前安排 |
| 明天下午 3 点开会 | 截止明天 15:00，默认 14:00 提醒 |
| 明天下午 3 点开会，提前 10 分钟提醒 | 明天 14:50 提醒 |
| 整理书架，不要提醒 | 保留待办，不安排提醒 |

提醒弹出后，可以回复“好”“OK”“我会执行的”将任务标记完成，或回复“30 分钟后再提醒我”“明天上午 9 点再提醒我”延后。没有回复时，五分钟后再次提醒。AI 解析失败会保留原始输入，供手动确认。

## API Key 与隐私

- 项目源码和发行包均不包含开发者的 API Key、个人任务或本机设置。每位使用者自行配置 Key，API 费用由自己的 DeepSeek 账号承担。
- Key 仅在 Electron 主进程使用，通过 Windows `safeStorage` 加密后保存在当前用户的应用数据目录；设置页可以修改或删除。
- 任务默认只保存在本机，没有账号系统或云端同步。
- 使用自然语言解析时，输入的任务描述和解析所需的当前时间会通过 HTTPS 发给 DeepSeek；测试连接也会向 DeepSeek 发送请求。手动添加任务不调用 AI。
- 本地配置、任务数据、日志和工作目录已加入 `.gitignore`。请不要在 Issue、截图、日志或代码中提交任何真实 Key。

## 本地开发

建议使用 Node.js 22 LTS，在 Windows PowerShell 中运行：

```powershell
git clone https://github.com/fahlim520/zhinengti.git
cd zhinengti
npm ci
npm run dev
```

如 Electron 运行包下载超时，请在网络恢复后重新运行 `npm ci`。开发运行仍需自己在设置页填写 Key，无需创建任何密钥文件。

## 验证与打包

```powershell
npm run typecheck
npm test
npm run build

# 分别输出，避免两种安装包的默认文件名互相覆盖。
npx electron-builder --win nsis --config.directories.output=release-nsis
npx electron-builder --win portable --config.directories.output=release-portable
```

安装版生成于 `release-nsis/`，便携版生成于 `release-portable/`。打包配置只收录构建后的程序及必要依赖，不收录本机应用数据。

## 反馈

欢迎在 [Issues](https://github.com/fahlim520/zhinengti/issues) 提交试用反馈，请说明系统版本、操作步骤、预期行为和实际结果。截图前请遮住 Key 和个人任务内容。首版以主显示器为准，暂不提供云端同步。

MIT License，见 [LICENSE](LICENSE)。
