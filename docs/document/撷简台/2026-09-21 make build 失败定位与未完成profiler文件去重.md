---
title: "2026-09-21 make build 失败定位 + 未完成/完整 profiler 文件去重"
date: 2026-09-22
description: "make build → ui/build go/bin → go/bin: go/deps → go mod tidy 退出码 1："
categories:
  - 撷简台
---

# 2026-09-21 make build 失败定位 + 未完成/完整 profiler 文件去重

## 一、`make build` 为什么失败

`make build` → `ui/build go/bin` → `go/bin: go/deps` → **`go mod tidy` 退出码 1**：

```
go: finding module for package gopkg.srv.deeproute.cn/drplatform/drfile/v2/tests/suite_tests
go: github.com/parca-dev/parca/pkg/drfile imports
	gopkg.srv.deeproute.cn/drplatform/drfile/v2/drfile imports
	gopkg.srv.deeproute.cn/drplatform/drfile/v2/drfile/drhelper tested by
	gopkg.srv.deeproute.cn/drplatform/drfile/v2/drfile/drhelper.test imports
	gopkg.srv.deeproute.cn/drplatform/drfile/v2/tests/suite_tests:
	module ... found (v2.1.2, replaced by ./vendor-deps/drfile-sdk-go-v2),
	but does not contain package ...
```

`vendor-deps/drfile-sdk-go-v2/drfile/drhelper/file_test.go` 仍然
`import ".../v2/tests/suite_tests"`，而 `FORK.md` §4 写明 `tests/` 已随 fork
一起删除（SDK 团队的开发脚手架）。**fork 瘦身时漏掉的一个文件。**

为什么 `go build ./...` 过、`make build` 不过：

- `go build` 只编译被 import 的包，依赖包的 `_test.go` 不参与构建；
- `go mod tidy` 必须解析主模块依赖图的**测试依赖**，于是去找
  `tests/suite_tests` → 本地 fork 里不存在 → 报错。

与 `b4a33cf`（.tmp 解压修复）无关，HEAD 上同样失败。

### 处理

按用户确认，删除 `vendor-deps/drfile-sdk-go-v2/drfile/drhelper/file_test.go`
（与 FORK.md §4 既定策略一致），并在 FORK.md §4 补上这条记录 + 一句提醒：
**从上游同步时删掉 `tests/` 必须一并删掉 import 它的 `_test.go`**，
否则 `go build` 照过、`go mod tidy` 报错，很难一眼看出关联。

副作用：`go mod tidy` 顺手清掉 go.sum 里两条不再需要的 v2.1.1 校验和
（模块已被 `replace` 到本地目录）。`go.mod` 未变。

验证：`make go/bin` 与 `make build` 均退出码 0，`bin/flamecraft` 已重建。

## 二、未完成/完整 profiler 文件去重

### 背景

数据文件从车上上传，上传次数和时间不定。远端命名规则：

- `.*.log.*<YYYYMMDD.HHMMSS.ffffff>` —— 未写完，只有开始时间（如 `.tmp`）
- `.*.log.*<YYYYMMDD.HHMMSS.ffffff>-<YYYYMMDD.HHMMSS.ffffff>` —— 已写完

第一次上传可能只有 `.tmp`，第二次上传才有完整文件。

### 现状（改动前）

`trip_handler.go` 的 `deduplicateFoldedFiles` **已经实现了这个规则的雏形**，
但「完整」是用 **`.zst` 后缀**判定的，且有 4 个缺口：

| # | 缺口 | 后果 |
|---|---|---|
| 1 | 完整与否看 `.zst` 后缀，不看文件名有没有结束时间戳 | 完整但非 `.zst`（`.folded`/无后缀）不抑制 `.tmp` |
| 2 | 只丢 `.tmp` | 其他「只有开始时间」的命名不参与 |
| 3 | snapshot 路径 `listModuleFiles` 完全没去重 | `.tmp` 与完整文件双双进快照，数据重复 |
| 4 | `reader.go` 扫目录时没去重 | 「加载本地目录」等入口重复入库 |

### 改动（按用户确认的口径）

1. **层次**：三处全覆盖 —— trip 分析路径 + snapshot 路径 + filereader 读取侧兜底
2. **完整判定**：文件名含两段时间戳（与后缀无关）
3. **匹配键**：起始时间**精确到微秒**完全相同
4. **可见性**：只在服务端日志里说明

新增 `pkg/filereader/profiler_files.go`：

- `profilerFileRecordingRegex = \.log\.(\d{8}\.\d{6}\.\d{6})(?:-(\d{8}\.\d{6}\.\d{6}))?`
- `ParseProfilerFileRecording(name) (ProfilerFileRecording, bool)`
  —— `Key` = 文件名到开始时间戳为止（含模块前缀），`Finished` = 是否带结束时间戳
- `ProfilerFileIndex` / `NewProfilerFileIndex` / `SupersededBy(name) (string, bool)`

Key 含模块前缀，所以 `cpu_profile.log.<t>` 与 `offcpu_flamegraph.log.<t>`
即使起始时间恰好相同也不会互相取代。

接入点：

- `trip_handler.go`：`deduplicateFoldedFiles` → 改名 `deduplicateProfilerFiles`，
  改成 `*Handler` 方法（要打日志），两条分析路径 `:391`/`:1130` 同步改
- `snapshot_handler.go` `listModuleFiles`：**先对整份列表去重、再做时间窗过滤**
  （完整副本可能落在窗口外，而未完成文件无结束时间、按开到 2099 处理，会命中窗口）
- `reader.go` `processExistingFiles`：新增 `dropSupersededProfilerFiles`

### ⚠️ 行为变更（需要留意）

原来按「起始时间到秒」匹配，测试 `trip_handler_test.go` 里有一条
`microsecond difference` 用例断言「差 1 微秒也算同一份、丢 `.tmp`」。
按用户选定的「精确到微秒」，该断言**反转**为「差 1 微秒视为两次录制，都保留」。
若当初那条用例是踩过真实坑才写的，需要回退成到秒匹配。

### 验证

真实 trip `YR-C01-74_20260917_084448` 的 cpu_tracker 目录三个文件：

```
cpu_profile.log.20260917.084449.936443.tmp                          ← 有完整孪生
cpu_profile.log.20260917.084449.936443-20260917.085738.818440.zst   ← 完整
cpu_profile.log.20260917.085738.839110.tmp                          ← 无孪生
```

跑 `filereader.Reader` 端到端：

```
level=info msg="skipping unfinished profiler file, superseded by finished copy"
  file=cpu_profile.log.20260917.084449.936443.tmp
  finished=.../cpu_profile.log.20260917.084449.936443-20260917.085738.818440.zst
processedFiles=2
  cpu_profile.log.20260917.085738.839110.tmp                        ← 保留（唯一副本）
  cpu_profile.log.20260917.084449.936443-20260917.085738.818440.zst ← 保留
```

新增测试：`pkg/filereader/profiler_files_test.go`（解析 + 真实 trip 布局）、
`pkg/filereader/dedup_e2e_test.go`（走完整 Reader 链路）、
`pkg/foldedresolver/trip_handler_test.go` 六组用例（含跨模块不误删、非约定命名不受影响）。
