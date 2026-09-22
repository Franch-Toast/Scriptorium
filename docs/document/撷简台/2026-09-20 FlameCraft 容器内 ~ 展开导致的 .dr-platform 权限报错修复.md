---
title: "2026-09-20 FlameCraft 容器内 \\~ 展开导致的 /.dr-platform 权限报错修复"
date: 2026-09-20
description: "FlameCraft 服务端启动时 stderr 输出："
categories:
  - 撷简台
tags:
  - FlameCraft
---

# 2026-09-20 FlameCraft 容器内 \~ 展开导致的 /.dr-platform 权限报错修复

## 现象

FlameCraft 服务端启动时 stderr 输出：

```
Failed to write to log, can't make directories for new logfile: mkdir /.dr-platform: permission denied
```

## 定位过程

1. 错误串 `can't make directories for new logfile` 来自 `gopkg.in/natefinch/lumberjack.v2`（logrus 的文件输出后端），  
`Failed to write to log, ` 前缀来自 logrus 在 `Out.Write` 失败时往 `os.Stderr` 的兜底打印。
2. `/.dr-platform` 这个根目录路径来自 DrFile SDK 的常量：  
`drconst.DrpLogsPath = "~/.dr-platform/temp/drfile-go/logs"`。
3. 展开 `~` 的是 `vendor-deps/drfile-sdk-go-v2/drfile/internal/paths/path.go` 的 `AbsPath()`：

   ```go
   userHomeDir, _ := os.UserHomeDir()   // ← error 被丢弃
   path = filepath.Join(userHomeDir, strings.TrimPrefix(path, "~/"))
   ```
4. 发布镜像 `Dockerfile.release` 以 `USER nobody` 运行。alpine 的 nobody 家目录是 `/`，  
docker 据此注入 `HOME=/`，于是 `filepath.Join("/", ".dr-platform/...")` = `/.dr-platform/...`，  
`nobody` 对 `/` 无写权限 → mkdir 被拒。

复现（本地一条命令即可）：

```bash
env HOME=/ GOCACHE=/tmp/gocache go test ./pkg/drfile/ -run <触发 drlog.InitLogger 的用例> -v
# Failed to write to log, can't make directories for new logfile: mkdir /.dr-platform: permission denied
```

> 注意 `HOME` 缺失（而非为 `/`）时表现不同：`filepath.Join("", ".dr-platform/...")` 是相对路径，  
> 经 `filepath.Abs` 后落在 **当前工作目录** 下（容器里是 `/mnt/.dr-platform`）。  
> 两种退化配置都会失败，只是报错路径不同。

## 修复

| 文件 | 改动 |
|-|-|
| `vendor-deps/drfile-sdk-go-v2/drfile/internal/paths/path.go` | 新增 `HomeDir()`：`os.UserHomeDir()` 报错 / 空串 / 返回根目录时回退 `os.TempDir()` |
| `vendor-deps/drfile-sdk-go-v2/drfile/internal/paths/path_test.go` | 新增回归测试（`HOME=""`、`HOME=/`、正常家目录三种情形） |
| `vendor-deps/drfile-sdk-go-v2/FORK.md` | 记录为 fork 补丁 3，并加入「上游 issue 待提」第 4 条 |
| `Dockerfile.release` | 新建 `/home/flamecraft` 并 chown 给 nobody，`ENV HOME=/home/flamecraft` |
| `pkg/drfile/bsp_extractor.go` | 抽出 `defaultBspCacheDir()`，家目录不可用时回落 `/mnt/bsp-libs` |

两层保险：SDK 侧保证 `~` 永远展开到可写目录（根因），镜像侧给运行用户一个正常的可写家目录  
（部署契约），使 SDK 状态落到 `/home/flamecraft/.dr-platform/...` 而不是 `/tmp`。

## 同类问题排查

同一根因（`~` 在容器里解析成 `/.xxx`）的全部落点：

| 位置 | 路径 | 状态 |
|-|-|-|
| SDK `drlog` | `~/.dr-platform/temp/drfile-go/logs` | 本次报错，已修 |
| SDK `filecyle` | `~/.dr-platform/temp/drfile-go/data/filecyle` | 潜伏（`Upload*` 首次调用即炸），已修 |
| SDK `drconfig` | `~/.dr-platform/{credentials,config}` | 潜伏（ini 读写），已修 |
| `pkg/drfile/bsp_extractor.go` | `~/.flamecraft/bsp-libs` | 潜伏，已修 |
| `pkg/foldedresolver/driver_manager.go` | `~/.flamecraft/drivers` | 已有 err 检查 + 写权限探测 → `/mnt/drivers`，无需改 |

已排除的非问题：`pkg/traceviewer/handler.go`、`pkg/filereader/reader.go` 用的是 `os.TempDir()`，  
本来就可写。

## 验证

- `go test ./vendor-deps/drfile-sdk-go-v2/drfile/internal/paths/ -v` → 3 个用例全过
- `env HOME=/ go test ./pkg/drfile/ -run <触发用例> -v` → 报错消失，日志落到 `/tmp/.dr-platform/...`
- `NewBspExtractor("")` 在 `HOME=""` / `HOME=/` 下均解析为 `/mnt/bsp-libs`
- `go build ./...` + `go test ./pkg/drfile/... ./pkg/foldedresolver/...` 全过

## 待办

- 上游 issue 第 4 条：SDK 的日志/缓存目录硬编码在 `~/.dr-platform`，建议支持配置或直接按 `os.TempDir()` 回退。
- 若后续希望 SDK 日志持久化，可把 `HOME` 指到挂载卷（如 `/mnt/home`）而非 `/home/flamecraft`。
