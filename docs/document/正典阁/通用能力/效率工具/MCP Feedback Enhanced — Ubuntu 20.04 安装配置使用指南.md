---
title: "MCP Feedback Enhanced — Ubuntu 20.04 安装配置使用指南"
date: 2026-09-20
description: "适用模式：Web UI 模式（桌面应用模式因 GLIBC ≥ 2.34 和 WebKit 依赖不兼容，Ubuntu 20.04 不可用）"
categories:
  - 正典阁
tags:
  - MCP
---

# MCP Feedback Enhanced — Ubuntu 20.04 安装配置使用指南

> 适用系统：Ubuntu 20.04 LTS（GLIBC 2.31 / 内核 5.15）  
> 适用模式：**Web UI 模式**（桌面应用模式因 GLIBC ≥ 2.34 和 WebKit 依赖不兼容，Ubuntu 20.04 不可用）

---

## 目录

- 

1. 前提条件

- 

1. 安装

- 

1. Cursor 中配置 MCP

- 3.1 基础配置（PyPI 发布版）
- 3.2 高级配置（自定义环境变量）
- 3.3 本地开发配置（克隆源码）
- 3.4 SSH 远程开发配置
- 

1. Prompt 规则配置（推荐）

- 

1. 验证安装

- 

1. 使用方式

- 6.1 工作流程
- 6.2 Web UI 功能
- 6.3 快捷键
- 

1. 环境变量参考

- 

1. 常见问题

- 

1. 关于桌面应用模式（Ubuntu 20.04 不可用）

---

## 1. 前提条件

### 安装 Python ≥ 3.11

Ubuntu 20.04 默认 Python 版本为 3.8，需要安装 3.11+：

```bash
sudo apt update
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt install -y python3.11 python3.11-venv python3.11-dev
```

### 安装 uv（Python 包管理器）

```bash
# 方式一：通过 pip 安装
pip install uv

# 方式二：通过官方脚本安装（推荐）
curl -LsSf https://astral.sh/uv/install.sh | sh
```

验证安装：

```bash
uv --version
```

### 安装 Cursor

从 [https://www.cursor.com](https://www.cursor.com) 下载并安装 Cursor 编辑器。

---

## 2. 安装

MCP Feedback Enhanced **无需手动安装**，Cursor 会通过 `uvx` 命令自动拉取并运行。

如果想提前验证是否可用：

```bash
# 检查版本
uvx mcp-feedback-enhanced@latest version

# 测试 Web UI 是否能正常启动
uvx mcp-feedback-enhanced@latest test --web
# 启动后浏览器打开 http://127.0.0.1:8765 查看界面
# 按 Ctrl+C 停止
```

---

## 3. Cursor 中配置 MCP

### 配置文件位置

| 级别 | 路径 | 说明 |
|-|-|-|
| **全局配置** | `~/.cursor/mcp.json` | 所有项目通用 |
| **项目配置** | `<项目根目录>/.cursor/mcp.json` | 仅当前项目生效 |

**打开方式**：Cursor 中按 `Ctrl+Shift+P` → 搜索 `Cursor Settings` → 点击左侧 **MCP** 选项卡 → **Add new global MCP server**

### 3.1 基础配置（PyPI 发布版）

最简单的配置，直接从 PyPI 拉取最新版：

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "uvx",
      "args": ["mcp-feedback-enhanced@latest"],
      "timeout": 600,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

### 3.2 高级配置（自定义环境变量）

可自定义端口、语言、调试模式等：

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "uvx",
      "args": ["mcp-feedback-enhanced@latest"],
      "timeout": 600,
      "env": {
        "MCP_DESKTOP_MODE": "false",
        "MCP_WEB_HOST": "127.0.0.1",
        "MCP_WEB_PORT": "8765",
        "MCP_LANGUAGE": "zh-CN",
        "MCP_DEBUG": "false"
      },
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

### 3.3 本地开发配置（克隆源码）

适合需要修改源码或调试的开发者：

```bash
# 克隆项目
git clone https://github.com/Minidoracat/mcp-feedback-enhanced.git
cd mcp-feedback-enhanced
uv sync
```

配置文件：

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "uvx",
      "args": [
        "--no-cache",
        "--with-editable",
        "/path/to/mcp-feedback-enhanced",
        "mcp-feedback-enhanced"
      ],
      "timeout": 600,
      "env": {
        "MCP_DESKTOP_MODE": "false",
        "MCP_WEB_HOST": "127.0.0.1",
        "MCP_WEB_PORT": "8765",
        "MCP_DEBUG": "false"
      },
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

> ⚠️ 将 `/path/to/mcp-feedback-enhanced` 替换为实际的本地项目路径。

### 3.4 SSH 远程开发配置

通过 SSH 远程连接服务器开发时，需要允许远程访问：

```json
{
  "mcpServers": {
    "mcp-feedback-enhanced": {
      "command": "uvx",
      "args": ["mcp-feedback-enhanced@latest"],
      "timeout": 600,
      "env": {
        "MCP_DESKTOP_MODE": "false",
        "MCP_WEB_HOST": "0.0.0.0",
        "MCP_WEB_PORT": "8765",
        "MCP_DEBUG": "false"
      },
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

然后在本地浏览器打开：`http://<远程服务器IP>:8765`

**或者使用 SSH 端口转发（更安全）**：

1. 保持 `MCP_WEB_HOST` 为 `127.0.0.1`（默认）
2. 在本地终端执行端口转发：

   ```bash
   ssh -L 8765:127.0.0.1:8765 user@remote-host
   ```
3. 本地浏览器打开：`http://localhost:8765`

---

## 4. Prompt 规则配置（推荐）

在 Cursor 的 Rules 设置中添加以下内容（`.cursorrules` 文件或 Cursor Settings → Rules），引导 AI 主动使用反馈工具：

```
# MCP Interactive Feedback Rules
follow mcp-feedback-enhanced instructions
```

这会让 AI 在需要确认操作时调用 MCP 反馈工具，而不是自行猜测。

---

## 5. 验证安装

### 步骤一：检查 MCP 状态

1. 打开 Cursor Settings（`Ctrl+Shift+P` → `Cursor Settings`）
2. 点击左侧 **MCP** 选项卡
3. 确认 `mcp-feedback-enhanced` 状态为 **🟢 绿色**（已连接）
4. 如果不是绿色，点击刷新按钮 🔄 等待重连，或重启 Cursor

### 步骤二：测试调用

在 Cursor 的 AI 对话框中输入：

```
请调用 mcp-feedback-enhanced 工具测试一下连接
```

AI 会调用 `interactive_feedback` 工具，浏览器自动弹出 Web UI 界面。在界面中输入反馈并提交，AI 即可收到。

### 步骤三：终端手动测试（可选）

```bash
# 测试 Web UI
uvx mcp-feedback-enhanced@latest test --web

# 带调试信息测试
MCP_DEBUG=true uvx mcp-feedback-enhanced@latest test --web

# 指定语言测试
MCP_LANGUAGE=zh-CN uvx mcp-feedback-enhanced@latest test --web
```

---

## 6. 使用方式

### 6.1 工作流程

```
AI 调用工具 → 浏览器自动弹出 Web UI → 你输入反馈/上传图片 → AI 实时收到 → 继续执行
```

1. **AI 调用** → `interactive_feedback` 工具，传递工作摘要
2. **浏览器弹出** → 自动打开 `http://127.0.0.1:8765` 显示 Web UI
3. **用户交互** → 在界面中输入文字、上传图片、选择预设 Prompt
4. **实时回传** → 通过 WebSocket 将反馈即时送回 AI
5. **流程继续** → AI 根据反馈调整行为或结束任务

### 6.2 Web UI 功能

| 功能 | 说明 |
|-|-|
| **文字反馈** | 输入框支持多行文字输入 |
| **图片上传** | 拖拽文件、Ctrl+V 粘贴剪贴板图片，支持 PNG/JPG/GIF/BMP/WebP |
| **预设 Prompt** | 管理常用提示语，支持增删改查、使用统计、智能排序 |
| **自动定时提交** | 1\~86400 秒灵活定时，支持暂停/恢复/取消 |
| **自动命令执行** | 新建会话或提交后自动执行预设命令 |
| **会话管理** | 历史记录追踪、导出（JSON/CSV/Markdown） |
| **连接监控** | WebSocket 状态监控、自动重连、质量指示 |
| **音频通知** | 内置多种提示音，支持自定义上传、音量调节 |
| **多语言** | 简体中文、繁体中文、英文，即时切换 |
| **AI 摘要渲染** | 支持 Markdown 格式渲染（标题、代码块、列表等） |

### 6.3 快捷键

| 快捷键 | 功能 |
|-|-|
| `Ctrl+Enter` | 提交反馈 |
| `Ctrl+V` | 粘贴剪贴板图片 |
| `Ctrl+I` | 快速聚焦输入框 |

---

## 7. 环境变量参考

| 变量 | 用途 | 可选值 | 默认值 |
|-|-|-|-|
| `MCP_DESKTOP_MODE` | 桌面应用模式 | `true` / `false` | `false` |
| `MCP_WEB_HOST` | Web UI 绑定地址 | IP 地址 | `127.0.0.1` |
| `MCP_WEB_PORT` | Web UI 端口 | `1024-65535` | `8765` |
| `MCP_LANGUAGE` | 强制 UI 语言 | `zh-CN` / `zh-TW` / `en` | 自动检测 |
| `MCP_DEBUG` | 调试模式 | `true` / `false` | `false` |

**语言检测优先级**：用户界面设置 > `MCP_LANGUAGE` > 系统环境变量 > 系统默认语言 > 繁体中文

---

## 8. 常见问题

### Q: MCP 状态不是绿色？

**A:** 依次尝试：

1. 在 MCP 设置页面点击刷新按钮 🔄
2. 反复切换 MCP 工具开关，等几秒
3. 完全关闭并重启 Cursor

### Q: 浏览器没有自动弹出？

**A:** 手动在浏览器中打开 `http://127.0.0.1:8765`。如果页面无法访问，检查端口是否被占用：

```bash
lsof -i :8765
```

可通过修改 `MCP_WEB_PORT` 换一个端口。

### Q: 出现 "Unexpected token 'D'" 错误？

**A:** 调试输出干扰，确保 `MCP_DEBUG` 设为 `false` 或移除该变量。

### Q: WebSocket 连接断开，收不到新反馈？

**A:** 直接刷新浏览器页面即可重连。

### Q: UV 缓存占用磁盘空间过大？

**A:** 定期清理：

```bash
# 查看缓存大小
uv cache info

# 清理缓存
uv cache clean
```

### Q: 想固定版本而不是用 latest？

**A:** 将 `args` 中的 `@latest` 改为具体版本号，如：

```json
"args": ["mcp-feedback-enhanced@2.6.0"]
```

---

## 9. 关于桌面应用模式（Ubuntu 20.04 不可用）

MCP Feedback Enhanced v2.5.0 引入了基于 Tauri 框架的原生桌面应用，但 **Ubuntu 20.04 不兼容**，原因：

| 依赖 | 需要版本 | Ubuntu 20.04 版本 |
|-|-|-|
| GLIBC | ≥ 2.34 | 2.31 ❌ |
| libwebkit2gtk-4.1 | 需要安装 | 不可用 ❌ |
| libsoup-3.0 | 需要安装 | 不可用 ❌ |

**如需使用桌面应用**，需升级到 Ubuntu 22.04+（推荐 24.04），然后：

```bash
sudo apt install libwebkit2gtk-4.1-0 libsoup-3.0-0
```

并将配置中 `MCP_DESKTOP_MODE` 设为 `"true"`。

**Web UI 模式与桌面应用功能完全一致**，在 Ubuntu 20.04 上推荐使用 Web UI 模式。

---

> 📚 更多信息参考：[项目 GitHub 仓库](https://github.com/Minidoracat/mcp-feedback-enhanced)
