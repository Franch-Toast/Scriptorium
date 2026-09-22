---
title: "2026-09-21 FlameCraft 火焰图全链路审核与 off-CPU 解析缺陷修复"
date: 2026-09-22
description: "用 FlameCraft 查看 perf_ebpf 采集的 on-CPU / off-CPU 火焰图时，前端显示不正确；用外部脚本（对同一份采集文件）渲染的结果"
categories:
  - 撷简台
tags:
  - FlameCraft
  - off-CPU
---

# 2026-09-21 FlameCraft 火焰图全链路审核与 off-CPU 解析缺陷修复

## 起因

用 FlameCraft 查看 perf_ebpf 采集的 on-CPU / off-CPU 火焰图时，前端显示不正确；用外部脚本（对同一份采集文件）渲染的结果与服务端渲染结果不一致。要求按「读取 → 解析 → 符号化 → 存储 → 查询 → 聚合 → 导出/渲染」逐阶段审核，并产出每阶段的审阅文档。

审核基准：`/sandbox/temp/sched_tracker` 的真实采集文件 + 工作区当前源码。

## 结论

服务端的解析/查询/聚合**确实有 bug**，其中 6 项严重问题叠加后完整解释了「外部脚本 ≠ 服务端」；另有 4 项查询口径问题污染指标曲线。本次修复这 10 项。

## 关键证据（都是实测，不是推断）

### 1. off-CPU 的 998 个 section 标记一个都没被识别

`pkg/filereader/offcpu_parser.go` 的 `offcpuSectionTimestampRegex` 只支持 v1（空格分隔、无时区），而真实数据是 v2：

```bash
grep -cP '^==========\s*\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\]\s*==========' 真实文件   # → 0
grep -cP '^==========\s*\[(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}\.\d+([+-]\d{4})?)\]\s*===='   # → 998
```

后果：16 分钟数据塌缩成 1 个零时间戳 section（回退到文件名时间戳）。

### 2. 41.7% 的行被静默丢弃

真实 off-CPU 文件 134,281 行的构成：

| 行类型 | 行数 |
|---|---:|
| 扩展行 `[offcpu_u:...]` | 76,307 |
| **无 metadata 前缀的 DWARF 行** | **56,016** |
| section marker | 998 |
| `Samples:` | 960 |

DWARF 行形如 `mediapipe(2096233);mediapipe;<user 栈> 30926`（由 `generateDwarfFlameGraph` 产出），`parseOffCPULine` 第一步就要求 `[offcpu_u:...]` 前缀 → 全部丢弃。

**被丢弃批次的时长中位数 66,699 µs，保留批次只有 7,777 µs** —— 长等待被系统性丢掉，恰好是最该被看到的部分。

### 3. off-CPU 栈方向与 on-CPU 相反，却套用了同一个反转

- `cputracker.cc` 用 `rbegin()/rend()` 反转 → on-CPU 文件**根在前**（首帧 `libc+0xd162c` = 线程入口）
- `sched_tracker.cc` 不反转 → off-CPU 文件**叶在前**（首帧 `___bpf_prog_run` = 最内层探针，末帧 `el0t_64_sync` = 系统调用入口）

`buildOffCPUSample` 对两者都做 `for i := len(frames)-1; i>=0; i--`，把叶在前的栈翻成根在前，违反 pprof「leaf at location_id[0]」；而 `GenerateFlamegraphArrow` 又把最后一个 location 当根 → **off-CPU 火焰图上下颠倒**。

测试 fixture 是**合成的根在前数据**，与真实数据相反，所以测不出来。

### 4. 导出 folded 时 off-CPU 数值缩小 10⁷ 倍并大量丢帧

`server.go` 的 `foldedValueDivisor` 只要 `fg.Unit == "nanoseconds"` 就 `/10_000_000`。off-CPU 的 unit 也是 nanoseconds，但值是真实等待时长。`selfValue /= divisor` 后小于 10ms 的节点变 0，被 `selfValue > 0` 判断**整行丢弃**。

`/api/flamegraph/export` 正是外部脚本消费的接口（前端不调用它），所以这条 bug 直接造成「外部脚本渲染 ≠ 服务端渲染」。

### 5. 前端把 off-CPU 纳秒值当采样次数

`isCpuNs = unit === 'nanoseconds'` 对 off-CPU 同样成立 → `divide(v, 10_000_000n)` 并标注 "samples"；而同一份数据的 SVG 导出走 `svgFormatValue` 正确显示秒。同一页面两条路径量纲不一致。

### 6. off-CPU 所有 frame 的 mapping 退化成 `[unknown]`

on-CPU 在符号化**前**固化 `FrameBinaries`；off-CPU 在符号化**后**才从文本反推 —— 此时 `[k]` 已被剥掉、用户帧只剩函数名 → 一律 `[unknown]`。丢失 binary 维度，location 去重退化为仅按函数名。

## 修复清单（10 项）

| 编号 | 位置 | 修复 |
|---|---|---|
| A1 | `offcpu_parser.go` | 时间戳正则对齐 v2，时间解析复用 `parseSectionTimestamp()` |
| A2 | `offcpu_parser.go` | 新增 `dwarfOffCPULineRegex` + `parseDwarfOffCPULine`（注意第二个字段是重复 comm，必须跳过）；`Samples:` 行正常跳过 |
| A3 | `offcpu_parser.go` | `buildOffCPUSample` 改正序遍历，不再反转 off-CPU 帧 |
| A4 | `offcpu_parser.go` | `OffCPUStack` 增加 `OffCPUBinaries`/`WakerBinaries`，符号化前固化 |
| A5 | `server.go` | `foldedValueDivisor(profileType)` 按 profile type 判定，仅 cpu/ebpf_cpu 除 10ms |
| A6 | `ProfileFlameGraph/index.tsx` | `isCpuNs` 增加 `sampleType === 'cpu'` 判据 |
| B1 | `querier.go` | `isNanoseconds` 改按 `Unit == "nanoseconds"` 判定 |
| B2 | `folded_parser.go` / `reader.go` | 新增 `FoldedSectionToPprofWithDuration`，1m 聚合传 `time.Minute` |
| B3 | `querier.go` | QueryRange 聚合回退增加 `codes.NotFound` 判定（原先是死代码） |
| B4 | `querier.go` | 非 delta 时间桶改为 `ts / step.Nanoseconds()` |

## 验证

```
go test ./pkg/... -count=1        # 全部通过
go vet ./pkg/filereader/ ./pkg/parcacol/ ./pkg/server/   # 通过
tsc --noEmit -p packages/shared/profile/tsconfig.json    # exit 0
```

真实数据端到端（临时测试，已删除）：

| | 修复前 | 修复后 |
|---|---|---|
| off-CPU Sections | 1（时间戳为零） | **960** |
| off-CPU ParsedLines | 76,307 | **132,323** |
| off-CPU SkippedLines | 1,958 | **0** |
| on-CPU | Sections 737 / Stacks 397,982（未变） | 同左 |

`132,323 = 134,281 − 998 marker − 960 Samples`，与逐行统计完全一致。

## 文档产出

`docs/architecture/flamegraph-review/`：`00-audit-summary.md`（总报告，含全部 30 项发现的分级与未修登记）+ `01`–`07` 逐阶段文档（读取解压 / 解析 / 符号化 / 存储 / 查询 / 聚合与树 / 导出渲染），每份含流程图、代码落点、真实数据对照、问题清单。

同时修正了两份已有文档中被证据推翻的论断：
- `flamecraft-flamegraph-parsing-and-calculation.md` §7.3「采集器和 parser 都会把根到叶表示转换」—— 对 off-CPU 不成立；
- §4.2 补充了无 metadata 前缀的 DWARF 行格式；
- §6.2 补充 `isNanoseconds` 的 unit 判据与 off-CPU 每秒值口径；
- `perf-ebpf-flamegraph-collection.md` 新增 §3.5.1（v2 时间戳）、§3.5.2（DWARF 行）、§3.5.3（帧顺序与 on-CPU 相反）。

## 未修但已登记（择要）

- `DecompressCustomZst` 先按 `compressedSize` 分配再校验（标准 zstd 文件前 8 字节会被当尺寸）
- watch 模式下 `writeCh` 被 close 后仍写入 → panic
- `ParseOffCPUSectionsStream` 不检查 `scanner.Err()`，静默截断且可能连带删源文件
- on-CPU 硬编码 10ms 采样周期
- trim 两遍阈值不一致、截断后 `Total` 与根行 cumulative 不自洽
- 宽范围查询缓存键忽略时间窗口
- 前端自产 folded 无法被后端解析（末列语义/缺 `(pid)`/缺 marker）

## 采集端遗留（本次不改 perf_ebpf，仅记录）

- off-CPU 输出栈方向与 on-CPU 不一致
- DWARF hash 用有符号比较 `>= 0x100000`，真实数据存在负值（如 `offcpu_u:-1919317190`）→ 这类 DWARF trace 掉进扩展路径，用户态栈丢失
- DWARF 行 pid 是 TGID、扩展行 pid 是 TID，口径不同
- `MAX_OFFCPU_EVENTS = 4`：火焰图权重只累加最近 4 次事件，低估真实累计时长
