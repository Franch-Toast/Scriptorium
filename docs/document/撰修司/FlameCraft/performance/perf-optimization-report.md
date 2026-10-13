---
title: "FlameCraft 全链路并行/缓存优化效果测试报告"
date: 2026-09-20
categories:
  - 撰修司
tags:
  - FlameCraft
---

# FlameCraft 全链路并行/缓存优化效果测试报告

<blockquote id="doxcnTL1WYzU37fFJKEdHSCVuGc"><p id="doxcnRi86s24Ro6RWRoQ99fTwaf">历史性能报告：测试于 2026-03-20，数据和版本基线不代表当前性能承诺。当前实现细节以 <cite doc-id="MiPedhglZoUJ9Lx22iQcblCbnug" file-type="docx" title="FlameCraft 当前架构" type="doc"></cite> 和源码为准。</p></blockquote>

**测试日期**: 2026-03-20  
**测试行程**: `YR-LPA10-45_20260317_134454`  
**基线行程**: `YR-C01-46_20260313_002708`（v1.5.0 基线数据来自 `docs/perf-report-YR-C01-46_20260313_002708.md`）

---

## 一、优化项总览

FlameCraft v1.6.0 实施了以下并行/缓存/算法优化：

| # | 优化项 | 类型 | 涉及文件 |
|-|-|-|-|
| 1 | 文件并行下载（concurrency=4 信号量） | 并行 | `trip_handler.go` |
| 2 | BSP 提取与文件下载并行执行 | 并行 | `trip_handler.go` |
| 3 | 时间范围并行扫描（max 8 workers） | 并行 | `trip_handler.go` |
| 4 | 符号索引并行生成（8 goroutine） | 并行 | `symindex.go` |
| 5 | pprof 异步写入管道 | 并行 | `reader.go` |
| 6 | 分钟级预聚合（`process_cpu_1m`） | 算法 | `reader.go`, `querier.go` |
| 7 | QueryRange 自动路由到聚合表 | 算法 | `querier.go` |
| 8 | QueryMerge/QueryRange 内存缓存 | 缓存 | `columnquery.go` |
| 9 | 分析后自动预热缓存 | 缓存 | `columnquery.go` |
| 10 | Driver 包本地缓存（`.done` 标记） | 缓存 | `trip_handler.go` |
| 11 | 符号索引缓存（`.symindex.json.gz`） | 缓存 | `symindex.go` |
| 12 | FrostDB RowGroupSize 8192→65536 | 算法 | `parca.go` |
| 13 | 堆栈偏移地址去除（唯一堆栈 -26%） | 算法 | `symbolizer.go` |
| 14 | 自适应 Trim（大火焰图动态裁剪） | 算法 | `flamegraph_arrow.go` |
| 15 | 前端 step_count 自适应（pixelsPerPoint 10→5 + minStepCount） | 前端 | `useQueryRange.ts` |
| 16 | FrostDB 入库前数据去重（DropDB + 重建） | 算法 | `parca.go`, `trip_handler.go` |
| 17 | sync.Pool 复用 gzip.Writer + klauspost BestSpeed | 算法 | `reader.go` |
| 18 | 查询缓存按 trip 粒度失效 | 缓存 | `columnquery.go` |

---

## 二、测试环境

| 项目 | 值 |
|-|-|
| 服务器 | Docker 容器（flamecraft），单节点 |
| Go 版本 | 1.22+ |
| FrostDB | 内嵌，RowGroupSize=65536 |
| 测试 Trip | `YR-LPA10-45_20260317_134454` |
| 文件数 | 1（cpu_profile，569MB，1425 sections） |
| FrostDB 行数 | 284,528 |
| 火焰图节点数 | 547,855 |

---

## 三、数据入库阶段性能

### 3.1 各步骤耗时

| 步骤 | 耗时 (ms) | 占比 | 并行/缓存优化 |
|-|-|-|-|
| Step1: 列举文件 | 1,191 | 1.9% | — |
| Step2: Driver 下载+解压 | **432** | **0.7%** | Driver 缓存命中，跳过 4.5GB 下载 |
| Step3: 文件下载+解压 | 2,682 | 4.3% | 并行下载 concurrency=4 |
| Step3b: 符号索引生成 | **0** | **0%** | `.symindex.json.gz` 缓存命中 |
| Step4: 时间范围扫描 | 900 | 1.4% | 并行扫描 max 8 workers |
| Step5: 解析+入库 | 35,830 | 57.5% | 异步写入 + 分钟级预聚合 |
| 缓存预热 | 7,221 | 11.6% | 自动预热 merge/range 缓存 |
| **Pipeline 总计** | **62,260** | **100%** |  |

### 3.2 Step5 解析+入库细项

| 子步骤 | 耗时 (ms) | 说明 |
|-|-|-|
| 文件读取 | 1,523 | 569MB 文件 I/O |
| 解析+符号化 | 8,430 | 1425 sections，symindex 缓存命中 |
| 堆栈聚合 | 5,684 | 847,995 行 → 分钟级预聚合 73 个桶 |
| pprof 转换+写入 | 21,178 | 1425 sections，sync.Pool + klauspost |
| **文件处理总计** | **31,131** |  |

### 3.3 与基线对比（入库阶段）

基线来自 `YR-C01-46_20260313_002708`（3 个文件，v1.5.0 初始版本）。

| 步骤 | 基线 (ms) | 当前 (ms) | 变化 | 优化原因 |
|-|-|-|-|-|
| Driver 下载+解压 | 36,657 | 432 | **-98.8%** | 缓存命中 |
| 符号索引生成 | 9,472 | 0 | **-100%** | 缓存命中 |
| 解析+入库 | 14,090 | 35,830 | +154% | 文件更大（569MB vs 99MB），sections 更多（1425 vs 203） |
| **Pipeline 总计** | 63,620 | 62,260 | **-2.1%** | 缓存节省 46s，但文件更大抵消 |

> 注：当前测试 trip 的单文件（569MB, 1425 sections）远大于基线 trip 的 cpu_profile（99MB, 203 sections），因此 Step5 耗时更长。按单位数据量计算，pprof 转换效率提升约 42%（sync.Pool + klauspost 优化）。

---

## 四、查询阶段性能

### 4.1 首次查询（无缓存，分析完成后自动预热）

| 子步骤 | 耗时 (ms) | 说明 |
|-|-|-|
| **QueryRange（时间线）** |  |  |
| FrostDB scan（聚合表） | 1,283 | 路由到 `process_cpu_1m`，73 行 |
| QueryRange 总计 | 1,283 |  |
| **QueryMerge（火焰图）** |  |  |
| selectMerge FrostDB scan | 4,455 | 284,528 行 |
| symbolizeLocations | 3 | 91,801 locations |
| resolveStacks | 1,744 | 284,528 stacks |
| QueryMerge 总计 | 6,208 |  |
| **前端渲染** |  |  |
| 自适应 Trim | — | 547,855 → 裁剪后节点 |
| Arrow IPC 序列化 | 17 | 13.2MB |
| generateFlamegraphArrow | 1,013 |  |
| **Query E2E 总计** | **7,221** |  |

### 4.2 缓存命中查询（第二次打开同一 Trip）

| 子步骤 | 耗时 | 说明 |
|-|-|-|
| QueryRange（时间线） | **\~0ms** | 内存缓存命中 |
| QueryMerge（火焰图） | **\~0ms** | 预热缓存命中 |
| **Query E2E 总计** | **\~0ms** | 秒级响应 |

### 4.3 与基线对比（查询阶段）

| 指标 | 基线 v1.5.0 (ms) | 当前 v1.6.0+ (ms) | 变化 | 优化原因 |
|-|-|-|-|-|
| FrostDB scan（全时段） | 39,400 | 4,455 | **-88.7%** | 预聚合 + RowGroupSize 65536 |
| Query E2E（首次） | 48,400 | 7,221 | **-85.1%** | 预聚合 + 偏移去除 + Trim |
| Query E2E（缓存命中） | 48,400 | \~0 | **-100%** | 预热缓存 |
| Arrow IPC 大小 | 139MB | 13.2MB | **-90.5%** | 自适应 Trim |
| 火焰图节点数 | 1,940,000 | 547,855 | **-71.8%** | 偏移去除（唯一堆栈 -26%）+ Trim |

---

## 五、前端优化效果

### 5.1 自适应 Trim

| 指标 | 基线 | 当前 | 变化 |
|-|-|-|-|
| FrostDB 行数 | 146,481 | 284,528 | +94%（数据更大） |
| 火焰图树节点 | 1,940,000 | 547,855 | **-71.8%** |
| 原始 trim 阈值 | 0.000513 | 0.000000 | — |
| 自适应 trim 阈值 | — | 0.018262 | 动态提升 |
| Arrow IPC 大小 | 139MB | 13.2MB | **-90.5%** |
| 渲染耗时 | \~2,050ms | 1,013ms | **-50.6%** |

### 5.2 折线图 step_count 修复

| 指标 | 修复前 | 修复后 | 说明 |
|-|-|-|-|
| pixelsPerPoint | 10 | 5 | 默认 step_count 翻倍 |
| 默认 step_count（1920px 屏幕） | 146 | 292 | 更细粒度 |
| minStepCount | 无 | `ceil(durationSec / 60)` | 保证 step <= 60s |
| 稀疏数据区域显示 | 断裂/无数据 | 连续 | 修复 gap 问题 |

---

## 六、各优化项量化收益汇总

```
入库阶段:
  Driver 缓存命中        36,657ms → 432ms     -98.8%   ████████████████████████████████████████
  符号索引缓存命中         9,472ms → 0ms       -100%    ████████████████████████████████████████
  pprof 转换优化          3,874ms → 2,249ms    -42.0%   ████████████████░░░░░░░░░░░░░░░░░░░░░░░░
  符号索引并行生成         9,472ms → ~4,000ms   -58%     ███████████████████████░░░░░░░░░░░░░░░░░ (估算)

查询阶段:
  FrostDB scan (预聚合)   39,400ms → 4,455ms   -88.7%   ███████████████████████████████████░░░░░
  Query E2E (首次)        48,400ms → 7,221ms   -85.1%   ██████████████████████████████████░░░░░░
  Query E2E (缓存命中)    48,400ms → ~0ms      -100%    ████████████████████████████████████████

前端:
  Arrow IPC 大小           139MB → 13.2MB      -90.5%   ████████████████████████████████████░░░░
  火焰图节点数          1,940,000 → 547,855    -71.8%   ████████████████████████████░░░░░░░░░░░░
  渲染耗时               ~2,050ms → 1,013ms    -50.6%   ████████████████████░░░░░░░░░░░░░░░░░░░░
```

---

## 七、全链路时间线对比

### 基线（v1.5.0，首次分析 + 首次查询）

```
入库 63.6s ──────────────────────────────────────────────────────────────────────────────────
查询 48.4s ─────────────────────────────────────────────────────────────
前端  2.0s ──
─────────────────────────────────────────────────────────────────────────────────────────────
总计 ~114s
```

### 当前（v1.6.0+，缓存命中 + 首次查询）

```
入库 62.3s ─────────────────────────────────────────────────────────────────────────────────
查询  7.2s ──────
前端  1.0s ─
─────────────────────────────────────────────────────────────────────────────────────────────
总计 ~70.5s (↓38%)
```

### 当前（v1.6.0+，缓存命中 + 缓存命中查询）

```
入库 62.3s ─────────────────────────────────────────────────────────────────────────────────
查询 ~0.0s
前端 ~0.5s
─────────────────────────────────────────────────────────────────────────────────────────────
总计 ~62.8s (↓45%)  ← 查询阶段几乎零开销
```

### 当前（已分析 Trip 直接打开）

```
入库  0.0s  ← 已分析，无需入库
查询 ~0.0s  ← 缓存命中
前端 ~0.5s
─────────────────────────────────────────────────────────────────────────────────────────────
总计 ~0.5s (↓99.6%)  ← 秒级打开
```

---

## 八、测试原始数据

### 入库阶段 PERF 日志

```
[PERF] step1_list_files                    duration_ms=1191
[PERF] step2_driver_download_extract       duration_ms=432      (缓存命中)
[PERF] step3_download_decompress_files     duration_ms=2682     file_count=1
[PERF] step3b_symbol_index                 duration_ms=0        (缓存命中)
[PERF] step4_scan_time_range               duration_ms=900
[PERF] file_read                           duration_ms=1523     size_bytes=568925413
[PERF] folded_parse_symbolize              duration_ms=8430     sections=1425
[PERF] folded_agg_stacks                   before_merge=847995  after_merge=847995
[PERF] folded_pprof_convert_agg_1m         duration_ms=5684     minutes=73
[PERF] folded_pprof_convert_fine           duration_ms=21178    sections=1425
[PERF] folded_total                        duration_ms=29608
[PERF] file_total                          duration_ms=31131
[PERF] step5_parse_and_ingest              duration_ms=35830    files=1
[PERF] total_pipeline                      duration_ms=62260
```

### 缓存预热 PERF 日志

```
[PERF] cache_warm_start                    query=process_cpu:...:delta{trip="YR-LPA10-45_20260317_134454"}
[PERF] queryRangeDelta_frostdb_scan        duration_ms=1283     rows=73
[PERF] QueryRange_total                    duration_ms=1283
[PERF] cache_warm_range_done               duration_ms=1283
[PERF] selectMerge_frostdb_scan            duration_ms=4455     rows=284528
[PERF] selectMerge_total                   duration_ms=4456
[PERF] symbolizeLocations                  duration_ms=3        locations=91801
[PERF] resolveStacks_total                 duration_ms=1744     stacks=284528
[PERF] QueryMerge_SymbolizeArrowRecord     duration_ms=1751
[PERF] QueryMerge_total                    duration_ms=6208
[PERF] flamegraph_pre_trim                 frostdb_rows=284528  tree_nodes=547855  adaptive_trim=0.018262
[PERF] arrow_ipc_serialize                 duration_ms=17       size_bytes=13233648
[PERF] GenerateFlamegraphArrow_total       duration_ms=1013
[PERF] Query_total                         duration_ms=7221     mode=MODE_MERGE
[PERF] cache_warm_merge_done               duration_ms=7221
[PERF] cache_warm_all_done                 total_duration_ms=7221
```

### 缓存命中查询日志

```
[PERF] QueryRange_cache_hit   key=range:...:YR-LPA10-45_20260317_134454  age_ms=60911
[PERF] QueryRange_cache_hit   key=range-wide:...:YR-LPA10-45_20260317_134454  age_ms=168470
[PERF] QueryRange_cache_hit   key=range:...:YR-LPA10-45_20260317_134454:[comm]  age_ms=61147
```

---

## 九、缓存粒度优化

### 9.1 问题

重新分析某个 trip 时，`InvalidateMergeCache()` 会清除**所有 trip** 的查询缓存（merge + range），导致其他 trip 的缓存也被丢弃，用户打开其他 trip 时需要重新查询。

### 9.2 方案

新增 `InvalidateCacheForTrip(tripName string)` 方法，通过匹配缓存 key 中的 trip 名称，只删除被重新分析的 trip 的缓存条目，其他 trip 的缓存保持不变。

| 行为 | 优化前 | 优化后 |
|-|-|-|
| 重新分析 trip A | 清除所有 trip 的缓存 | 只清除 trip A 的缓存 |
| trip B/C/D 的缓存 | 丢失，需重新查询 | 保留，秒级响应 |
| tripName 为空时 | — | 回退到全量清除（兼容） |

### 9.3 涉及文件

| 文件 | 修改 |
|-|-|
| `pkg/query/columnquery.go` | 新增 `InvalidateCacheForTrip(tripName)` |
| `pkg/foldedresolver/handler.go` | `OnDataReset` 签名改为 `func(tripName string)` |
| `pkg/foldedresolver/trip_handler.go` | 调用 `onDataReset(tripName)` 传递 trip 名称 |
| `pkg/server/server.go` | `queryCacheInvalidator` 签名同步更新 |
| `pkg/flamecraft/parca.go` | 注入 `InvalidateCacheForTrip` 替代 `InvalidateMergeCache` |

---

## 十、结论

1. **查询性能提升最显著**：FrostDB scan 从 39.4s 降到 4.4s（-89%），缓存命中后 Query E2E 从 48.4s 降到 \~0ms（-100%）。核心优化是分钟级预聚合 + 查询结果缓存 + 自动预热。
2. **前端渲染大幅改善**：自适应 Trim 将 Arrow IPC 从 139MB 降到 13.2MB（-90%），渲染耗时从 \~2s 降到 \~1s（-50%）。
3. **入库阶段缓存效果突出**：Driver 缓存和符号索引缓存在重复分析时节省 46s（-72%）。首次分析仍受网络/IO 限制。
4. **折线图显示修复**：step_count 从 146 提升到 292，稀疏数据区域不再断裂。
5. **已分析 Trip 秒级打开**：缓存命中时全链路从 \~114s 降到 \~0.5s（-99.6%），用户体验从"等待一分钟"变为"即时响应"。
6. **缓存粒度优化**：重新分析 trip 时只清除该 trip 的缓存，其他 trip 的查询结果保留，避免全量缓存失效。
