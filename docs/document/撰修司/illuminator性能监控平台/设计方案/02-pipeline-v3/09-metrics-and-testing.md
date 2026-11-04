---
title: 02-09 指标与测试
date: 2026-11-04
description: Pipeline 专属指标的精确口径、同步时机、关键测试走读与覆盖缺口。
categories: [撰修司]
tags: [Illuminator, Pipeline v3, 指标, 测试]
---

# 02-09 指标与测试

指标如果口径不清，排障时会得出相反结论。本篇先给出每个 Pipeline 指标的精确含义，再走读关键测试，最后列出“测试证明了什么、没证明什么”。

返回 [Pipeline v3 总览](./index.md)。

## 1. Pipeline 指标

```cpp
uint64_t BatchesProcessed() const;
uint64_t RecordsProcessed() const;
uint64_t ErrorCount() const;
```

| 指标 | 增加时机 | 不包含 |
| --- | --- | --- |
| `BatchesProcessed` | 批次交给 Aggregator 或 Sink 之后 | 被 Processor 过滤/报错的批次；但包含 Aggregator Add 失败、SinkPool 过载丢弃 |
| `RecordsProcessed` | 进入 Processor 链之前，按输入 `Size()` | 处理后的记录数；被过滤的记录仍计入 |
| `ErrorCount` | Processor 错误、Sink 写错误、SinkPool >256 丢弃 | 通道丢弃、Collect 错误、Aggregator Add/Flush 错误 |

因此：

- `RecordsProcessed` 是**输入口径**，不是输出口径。
- `BatchesProcessed` 不是“成功写入 Sink 的批次数”。
- `ErrorCount == 0` 不代表没有数据丢失。

## 2. Channel 指标

| 指标 | 含义 | 注意事项 |
| --- | --- | --- |
| `ChannelEnqueued` | `TryEnqueue` 成功次数 | 不含 Sentinel |
| `ChannelDequeued` | 出队成功次数 | 含 Sentinel |
| `ChannelDropped` | 丢弃操作次数 | 含 DropOldest/InjectFlush 驱逐；可能双计 |
| `ChannelFlushInjected` | Sentinel 入队成功次数 | 不代表已经 Flush |
| `ChannelBackpressureEvents` | 进入反压的次数 | 不含解除次数 |
| `ChannelSize` | `SizeApprox()` | 近似值 |
| `ChannelCapacity` | 实际容量（2 的幂） | 请求 4096 通常就是 4096 |

`enqueued - dequeued` 不能当队列长度，因为 `dequeued` 包含 Sentinel，且并发下两个计数不是同一时刻的快照。

## 3. SinkPool 指标

| 指标名 | 类型 | 来源 |
| --- | --- | --- |
| `pipeline_<name>_sink_pool_pending` | Gauge | `sink_pool_->PendingTasks()` |
| `pipeline_<name>_sink_pool_backpressure` | Gauge | `pending > 128` 时为 1 |
| `pipeline_<name>_sink_drops_total` | Counter | `pending > 256` 整批丢弃 |
| `pipeline_<name>_sink_pool_pending` | Gauge | 每 100 个有数据的循环同步一次 |

`PendingTasks()` 只统计排队任务，不含正在执行的任务。多个 Pipeline 共享同一个池时，这个值是全局排队数。

## 4. 指标同步时机

```cpp
while (running_) {
    MaybeForceFlush();
    auto item = Dequeue(100ms);

    if (!item) {
        if (++loop_count % 100 == 0) SyncChannelMetrics();
        continue;
    }

    // 处理 item ...

    if (++loop_count % 100 == 0) {
        SyncChannelMetrics();
        SyncSinkPoolMetrics();
        ResourceLimiter::Check();
    }
}
```

- 空闲时：每 100 次 100ms 超时，约 10 秒同步一次通道指标。
- 有数据时：每 100 个事件同步一次。
- 不是固定时间采样，不能拿时间戳差值直接算瞬时速率。
- `ResourceLimiter` 只在有数据分支检查；长时间空闲不会更新 RSS 告警。

## 5. InternalMetrics 与 ResourceLimiter

`InternalMetrics` 是全局单例，所有映射共享一个 mutex：

| 类型 | 操作 | 边界 |
| --- | --- | --- |
| Counter | `Inc(name, delta)` | 只增不减 |
| Gauge | `SetGauge(name, value)` | 可增可减 |
| Histogram | `RecordLatency(name, us)` | 只有 count/sum/min/max，无 P95/P99 |

导出：

- `ExportPrometheus()`：文本格式，指标名前加 `illuminator_`。
- `ExportJson()`：JSON 对象。
- **没有 HTTP `/metrics` 端点**；宿主需要自己提供传输层。

`ResourceLimiter`：

- 读取 `/proc/self/statm` 的 RSS。
- 默认阈值 512MiB。
- 超限只打 WARN 并设置 `rss_bytes` gauge，**不阻止分配**。

## 6. 关键测试走读

### 6.1 `ChannelFullDropsDataAndUpdatesStats`

验证：小容量通道 + 慢 Sink 时，`ChannelDropped` 增加，`ChannelEnqueued` 与实际入队一致。

证明了：

- 满队列会按 `DropNewest` 丢弃。
- 统计计数会更新。

没证明：

- DropOldest 的驱逐顺序。
- 多生产者并发下的精确丢失数。

### 6.2 `BackpressureSignalsHighAndClearsNearLowWatermark`

验证：入队超过高水位触发 `backpressured`，消费到低水位以下解除。

证明了：

- 滞回状态机的基本行为。
- 回调只在状态变化时触发。

没证明：

- 多生产者同时触发时只计一次（CAS 分支有覆盖，但压力不足）。
- 没有新 Enqueue 时的解除通知（实际上不会发生）。

### 6.3 `InjectFlushUsesPrioritySlotWhenFull`

验证：队列满时 `InjectFlush` 驱逐一个旧条目并成功注入 Sentinel。

证明了：

- 满队列下 Sentinel 有“优先入队”的机会。

没证明：

- 被驱逐的是数据还是另一个 Sentinel。
- 第二次入队失败的分支。
- 并发生产者抢占导致 Sentinel 丢失。

### 6.4 `MaybeForceFlushFlushesAggregatorWithoutSentinel`

验证：没有 Sentinel 时，超过 3×`FlushIntervalMs()` 会强制刷新。

证明了：

- `MaybeForceFlush` 的兜底路径。

没证明：

- 宿主注册了正常定时器的路径。
- `FlushIntervalMs()==0` 时不会刷新。
- `Flush` 失败的错误传播（当前没有）。

### 6.5 `SinkPoolOverloadDropsBatchesAndUpdatesMetrics`

验证：用门闩阻塞 SinkPool，使 `PendingTasks()` 超过 256，整批丢弃并更新 `sink_drops_total` 与 `ErrorCount`。

证明了：

- 输出池过载保护存在。
- 丢弃发生在扇出前。

没证明：

- `pending == 128/256` 的精确边界。
- 多 Pipeline 共享池时的配额隔离。

### 6.6 `DrainsWritesBeforeStoppingSinkAndLeavesPoolUsable`

验证：16 批、每批 10ms Write；`Pipeline::Stop()` 后没有 Write-after-Stop，且共享池仍可执行新任务。

证明了：

- `pending_writes_` 屏障有效。
- Stop 不会提前停止共享池。

没证明：

- Write 永不返回时 Stop 的行为（会永久等待）。
- 动态移除 Sink 的在途写。

### 6.7 `ConcurrentAddRemoveWrite`

验证：动态增删 Sink 与写入并发时，列表访问不崩溃。

证明了：

- `sinks_mutex_` 保护了列表本身。

没证明：

- 被移除 Sink 的在途写已经完成。
- Add 与 Stop 的竞态。

### 6.8 `lock_free_queue_test`

覆盖多生产者单消费者、容量、顺序。

没证明：

- 多消费者 MPMC（实现支持，但没有压力测试）。
- 析构时并发 Pop 的安全性。

### 6.9 `timer_wheel_test`

覆盖重复、一次性、取消、生命周期、多个定时器并发。

没证明：

- catch-up 的连续补触发。
- `Cancel` 不唤醒导致的最长 1 秒清理延迟。
- `interval=0` 的忙循环。

## 7. 测试矩阵

| 领域 | 目标 | 重点 |
| --- | --- | --- |
| 公共契约 | `config_test`、`status_test` 等 | YAML 默认值、校验、错误码 |
| 内存/队列 | `arena_test`、`lock_free_queue_test` | 对齐、Reset、并发队列 |
| 线程池 | `thread_pool_test` | future、异常、PendingTasks、Drain |
| 引擎 | `async_channel_test`、`data_batch_test`、`timer_wheel_test`、`pid_manager_test` | 通道、数据、定时、PID |
| Pipeline | `pipeline_integration_test` | 转换链、反压、过载、强制刷新 |
| 停机 | `pipeline_shutdown_test` | 写入屏障、共享池复用 |
| 动态 Sink | `pipeline_dynamic_sink_test` | 增删、并发列表访问 |
| 压力 | `stress_test` | 高吞吐、多 Pipeline、RSS |
| 基础设施 | `infrastructure_manager_test` | 单例、启停、默认线程数 |
| 插件 | `plugin_registry_test`、`test_source_plugin.so` | 工厂、动态库 |
| 存储 | `sqlite_backend_test` | 写入、查询、Prune、只读 SQL |
| CLI | `smoke_test.sh` | demo、run、配置错误、信号退出 |

旧基线记录为 18/18 测试目标通过；这是 2026-11-04 的历史记录，不表示本轮重新执行。

## 8. 调优观测清单

| 观测项 | 用途 |
| --- | --- |
| `ChannelDropped / ChannelEnqueued` | 输入丢失率 |
| `ChannelSize / Capacity` | 通道利用率 |
| `BatchesProcessed` 增速 | 处理吞吐 |
| `RecordsProcessed / BatchesProcessed` | 平均批大小 |
| `sink_pool_pending` | 输出排队 |
| `sink_drops_total` | 输出过载丢失 |
| `rss_bytes` | 内存驻留 |
| Sink 单次 Write 耗时 | 判断是否需要更多写线程 |
| Collect 单次耗时 | 判断 CollectPool 是否不足 |
| 端到端延迟 | 采集时间戳到写入完成的时间差 |

## 小结

- 三个 Pipeline 计数器的口径不同：输入记录、已交付批次、部分错误。
- Channel 与 SinkPool 指标不是同一时间快照，不能做精确守恒计算。
- 指标同步是“每 100 次循环”，不是固定周期。
- 测试覆盖了主要路径，但没有覆盖 catch-up、MPMC、动态 Sink 在途写、停止边界。

## 边界与后续

- 没有 HTTP 指标端点。
- 直方图没有分位数。
- `InternalMetrics` 全局锁在高频写时可能成为竞争点。
- `ResourceLimiter` 只告警，不限制分配。
- 压力测试使用大容量通道且只要求丢失率低于阈值，不能当作零丢失证明。

返回 [Pipeline v3 总览](./index.md) · 上一篇：[插件走读](./08-plugin-walkthrough.md)
