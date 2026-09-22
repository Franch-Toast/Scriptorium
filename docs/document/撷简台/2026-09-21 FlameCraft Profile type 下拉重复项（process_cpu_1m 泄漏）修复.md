---
title: "2026-09-21 FlameCraft Profile type 下拉重复项（process_cpu_1m 泄漏）修复"
date: 2026-09-22
description: "前端 Profile type 下拉里同时出现「On-CPU」和一条原始串"
categories:
  - 撷简台
tags:
  - FlameCraft
---

# 2026-09-21 FlameCraft Profile type 下拉重复项（process_cpu_1m 泄漏）修复

## 起因

前端 Profile type 下拉里同时出现「On-CPU」和一条原始串
`process_cpu_1m:cpu:nanoseconds:cpu:nanoseconds:delta`。用户观察：两者其实是同一个东西，
为什么会有两个？在哪里设计的？是否该修？

## 结论

不是前端设计出来的重复，而是**存储层内部实现细节从通用 API 泄漏到了 UI**。

`process_cpu_1m` 是 v1.6.0（`cf90a7d`「查询性能优化」）引入的按分钟预聚合 rollup，
仅供查询路由内部使用，从未被设计成用户可选的 profile 类型。泄漏点是
`Querier.ProfileTypes()` —— 它对存储表的 `name` 列做**裸 DISTINCT**，枚举的是
「存储里出现过哪些 name」，而不是「用户可选哪些类型」。

## 根因链

| # | 位置 | 行为 |
|---|---|---|
| ① 写入 | `pkg/filereader/reader.go:811` / `:897` | 同一份 folded CPU 数据写两遍，`__name__` 分别为 `process_cpu`（逐秒细粒度）与 `process_cpu_1m`（按分钟聚合） |
| ② 枚举 | `pkg/parcacol/querier.go:865-874`（原） | `ProfileTypes()` 对 `name/sample_type/...` 做 `Distinct`，无「内部名」概念 → `process_cpu_1m` 原样返回 |
| ③ 路由 | `pkg/parcacol/querier.go:1829-1836` | `routeToAggregatedQuery()` 在 >60s 时自动把 `process_cpu:` 改写成 `process_cpu_1m:`，空结果再回退（`QueryRange` `:355`、`QueryMerge` `:1521`）——**粗细切换本来就是透明的** |
| ④ 显示 | `ui/.../ProfileTypeSelector/index.tsx:84-87` / `:145` | `wellKnownProfiles` 只给 `process_cpu:...` 配了 "On-CPU"，无 `process_cpu_1m:...` 条目 → 落到兜底分支直接渲染原始冒号串 |

## 关键证据（实测）

线上 `/api/profiles/types` 返回确实只有这两条，且就是这一对：

```json
{"name":"process_cpu_1m","sampleType":"cpu","sampleUnit":"nanoseconds","periodType":"cpu","periodUnit":"nanoseconds","delta":true},
{"name":"process_cpu","sampleType":"cpu","sampleUnit":"nanoseconds","periodType":"cpu","periodUnit":"nanoseconds","delta":true}
```

`QueryRange` 同窗口对比：

| 范围 | `process_cpu` | `process_cpu_1m` |
|---|---|---|
| > 60s | 逐秒序列 | **与左侧逐字节相同**（`process_cpu` 已被自动路由到 1m） |
| ≤ 60s | 15s 粒度，正确 | 只剩一个 `duration=60s` 粗桶，值 `327230000000` 是**整分钟**量，覆盖范围溢出查询窗口 |

即：用户说「实际上是一样的」在 >60s 时完全成立；只有 ≤60s 时两者不同，而那时
`process_cpu_1m` **反而是错的**（粒度丢失 + 数据越界）——所以暴露它不只是「难看」，
是能产生错误分析结论的。

## 修改

后端单点过滤（未动前端）。`pkg/parcacol/querier.go`：

```go
// internalProfileNames are storage-level rollup names written by the file
// reader alongside their fine-grained counterparts ...
var internalProfileNames = map[string]struct{}{
	"process_cpu_1m": {},
}
```

`ProfileTypes()` 循环内 `name` 读出后即跳过内部名。

连带影响已核对：

- `HasProfileData()` 复用该函数，过滤后仍有 `process_cpu`，无影响；
- 带 `process_cpu_1m:` 的历史 URL 仍可直接查询（`routeToAggregatedQuery` 的 guard 已处理），
  只是不再出现在下拉里；
- `pkg/query/columnquery_test.go` 原有 `TestColumnQueryAPITypes` 只断言 memory 类型，不冲突；
- 首页/trip 页硬编码 `process_cpu:...:delta`，从不使用 1m，不受影响。

新增回归测试 `TestColumnQueryAPITypesExcludesInternalRollups`（`pkg/query/columnquery_test.go`）：
写入 `process_cpu` 与 `process_cpu_1m` 两个 series，断言 `ProfileTypes` 只返回前者。

验证：

```
go build ./...                                              # ok
go test ./pkg/query/ ./pkg/parcacol/ -count=1               # ok
go test ./pkg/filereader/ -count=1                          # ok
```

反向验证（临时 stash 掉 querier.go 的修复后跑测试）确认测试确实能捕获该缺陷：

```
[]string{"process_cpu", ..., "process_cpu_1m", ...} should not contain "process_cpu_1m"
--- FAIL: TestColumnQueryAPITypesExcludesInternalRollups
```

## 未修但已登记

- `ui/.../ProfileTypeSelector/index.tsx:126-136` 的 `flexibleWellKnownProfileMatching` 是**死代码**
  （`flexibleKnownProfilesDetection` 无任何调用方传值，恒为 `false`）。若哪天启用，它会把
  `process_cpu_1m:...` 模糊匹配成 "On-CPU"，重复会更隐蔽（两条都叫 "On-CPU"）。
- `wellKnownProfiles` 中 `process_cpu:...:delta`、`parca_agent:...:delta`、
  `parca_agent_cpu:...:delta` 等多个**不同来源**的类型都显示为 "On-CPU" / "CPU Samples"，
  数据源不同但标签相近，属于另一类下拉歧义（本次未处理）。
- 若后续再引入 `_5m` / `_1h` 等聚合粒度，需同步扩充 `internalProfileNames`。
