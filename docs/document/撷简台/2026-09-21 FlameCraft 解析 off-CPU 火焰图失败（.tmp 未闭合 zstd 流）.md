---
title: "2026-09-21 FlameCraft 解析 off-CPU 火焰图失败（.tmp 未闭合 zstd 流）修复"
date: 2026-09-22
description: "用 FlameCraft 分析 trip trip_1789992987633504093（YR-C01-74_20260917_084448），"
categories:
  - 撷简台
tags:
  - FlameCraft
  - off-CPU
---

# 2026-09-21 FlameCraft 解析 off-CPU 火焰图失败（.tmp 未闭合 zstd 流）修复

## 起因

用 FlameCraft 分析 trip `trip_1789992987633504093`（`YR-C01-74_20260917_084448`），
服务端日志中 sched_tracker 目录下的三个 `.tmp` 文件全部报错，off-CPU 火焰图完全
看不到数据：

```
level=error caller=reader.go:468 file=.../sched.log.20260917.084450.011150.tmp
  err="failed to decompress zst file: neither custom-zst nor standard-zstd: invalid input: magic number mismatch"
level=error caller=reader.go:468 file=.../cpu_profile.log.20260917.085738.839110.tmp
  err="failed to decompress zst file: neither custom-zst nor standard-zstd: unexpected EOF"
level=error caller=reader.go:468 file=.../offcpu_flamegraph.log.20260917.084450.011548.tmp
  err="failed to decompress zst file: neither custom-zst nor standard-zstd: unexpected EOF"
level=info  caller=trip_handler.go:740 msg="filereader finished" processedFiles=1
```

## 定位过程

`.tmp` 是**采集尚未结束**的文件（`trip_handler.go` 的
`profilerFileTmpRegex` 注释也写明 "incomplete, start only"）。要判断到底是数据坏了
还是代码坏了，必须拿到真实文件——用仓库现成的 `pkg/drfile` 客户端写了个
`tmp_tripdump` 小工具把三个文件下到 `/tmp/tripdump/` 复现。

（trip 名不在 URL 里，先从本机 7070 端口的
`/api/trip/job/trip_1789992987633504093` 拿到 `tripName`。）

三个文件**都是完好的标准 zstd**（magic `28 b5 2f fd` 在偏移 0），并不是损坏数据。
用 `klauspost/compress/zstd` 直接解码，实测：

| 文件 | 压缩后 | `DecodeAll` 已解出 | `DecodeAll` 报错 |
|---|---:|---:|---|
| `offcpu_flamegraph.log...tmp` | 6,844,416 B | **173,958,238 B** | `unexpected EOF` |
| `cpu_profile.log...tmp` | 19,636,224 B | **131,127,848 B** | `unexpected EOF` |
| `sched.log...tmp` | 9,547,776 B | **45,045,294 B** | `magic number mismatch` |

## 根因

两个独立问题叠在一起：

**1（主因）· 未闭合的 zstd 流被整体丢弃。**
录制侧每 flush 一次就产出一个完整 zstd frame（实测单文件 1.6k–2.8k 个 frame，
扫 magic 计数即得），但文件永远没有被正常收尾，末帧因此不完整。`DecodeAll` 会把
「已解出的全部完整 frame」**连同末帧的错误一起返回**；而 `DecompressZstAuto` 只
判断 `err != nil` 就丢弃整个输出——174 MB 的真实数据被判为「解压失败」。

**2 · 自定义分块格式的探测先分配后校验。**
`DecompressCustomZst` 会先拿标准 zstd 文件的头 8 字节当 `(originalSize, compressedSize)`。
`sched.log...tmp` 的第 5–8 字节是 `60 9C 05 E5`，即声明 `compressedSize ≈ 3.8 GB`，
原实现先 `make([]byte, 3.8GB)` 再去读、必然失败。这正是上一轮审核文档
`flamegraph-review/01-read-and-decompress.md` 里的 R1（当时标注「本次未修」）。

顺带发现一个性能坑：`DecodeAll(data, nil)` 在这种多 frame 拼接输入上慢得离谱——
单文件 **11–46 秒**，而流式 `zstd.NewReader` 只要 **175–314 毫秒**，
且输出**逐字节相同**。

## 修复

`pkg/filereader/folded_parser.go`

- `DecompressZstAuto` / `DecompressCustomZst` 改为「解出多少留多少」，新增
  `truncated` 返回值；只有**一个完整单元都没解出**时才返回 error（此时才回落到
  另一种格式判断）。
- `DecompressCustomZst` 分配前先校验 `compressedSize <= 剩余字节数`（R1）。
- 标准 zstd 分支改用流式解码，同时解决截断容忍与性能两个问题。
- 顺带删掉 `originalSize` 与实际解压长度比较的死代码块（R2 的空语句块）。

调用方 `reader.go`、`trip_handler.go`（两处）、`snapshot_handler.go`、`server.go`
适配新签名，并在 `truncated` 时打 warn 日志（避免「静默截断」）。

新增 `pkg/filereader/decompress_test.go` 六组用例：完整 zstd、完整自定义分块、
未闭合尾帧、截断 magic、自定义分块切在半块、标准 zstd 误入自定义容器。

## 验证（真实数据）

把三个真实 `.tmp` 喂给 `filereader.Reader` 端到端跑：

```
processedFiles            1 → 3
offcpu: sections=1596 total_stacks=205817 skipped_lines=0
        → process_offcpu 58641 series / process_offcpu_waker 42768 series
cpu_profile(.tmp): sections=788 → process_cpu 11541 / process_cpu_1m 210 series
解压耗时  sched 12s→0.26s，cpu_profile 51s→0.40s，offcpu 29s→0.64s
```

`go test ./pkg/filereader/... ./pkg/foldedresolver/... ./pkg/server/...` 全绿。

## 遗留（本次未修，不属本次回归）

`sched.log` 解压出来是「D 状态调用栈分析」文本 + `[SCHED_STAT_*]` 键值行，
section 标记写成 `# ========== [...]`（带 `# ` 前缀），`timestampRegex` 锚定行首
故不匹配 → `processFoldedFile` 得到 0 个 section。**修复前就是这样**（旧 trip 的
`sched.log.*.folded` 同样 0 section）。`snapshot` 路径另有 `parseDStateAnalysis`
能解析该格式，入库路径暂无对应解析器。

上一轮审核文档里的 R3–R6（全量读入内存、watch 模式写已关闭通道 panic、`.tmp`
空文件行为不一致、事件去重）仍未处理，建议按 R4 → R3 → R5 → R6 顺序跟进。
