---
title: "Planning 几何缓存 shared_mutex 开销优化记录"
date: 2026-11-12
description: "记录 QNX 7.1 trace 中 Planning 几何缓存 shared_mutex 的对象开销、只读缓存方案 C 的实现、正确性边界与验证结果。"
categories:
  - 纪事寮
tags: [Planning, QNX, shared_mutex, SyncDestroy, 性能优化, 并发缓存]
---

# Planning 几何缓存 shared_mutex 开销优化记录

这次优化针对 Planning 每轮创建和销毁两组几何 manager 缓存时产生的同步对象开销。实现选择**只读阶段缓存方案 C**：缓存命中不再使用 `shared_mutex`，而由稳定槽位中的原子指针发布已创建对象；只有首次构建和未知 key 兼容路径才使用普通 `mutex`。

这里有两个容易混淆的改动：Planning 缓存实际采用方案 C，直接从这两个缓存中移除 `shared_mutex`；公共库中另行实现的 `deeproute::base::SharedMutex` 是独立候选方案，保留读写锁 API，并不等于本次 Planning 已切换到它。公共库分析见 [QNX SharedMutex 实现与按需等待方案](<../正典阁/技术栈/操作系统/QNX/QNX SharedMutex实现与按需等待优化方案.md>)。

## 背景与 trace 现象

`TopologyContext` 中有 lane centerline 和 boundary 两组 `PolylineManager` 缓存，每组原来由 64 个 `shared_mutex` 分片保护。原实现的典型访问是多个并行模型路径读取缓存，未命中时创建并保存 manager；地图更新或对象析构则在安全点清理缓存。

QNX 7.1 本地 libc++ 的 `shared_mutex` 内部布局包含一个 mutex、两个 condition variable 和状态字段。每个 `TopologyContext` 因此有：

```text
2 个缓存 × 64 个分片 × 2 个 condition_variable
= 256 个 condition_variable 析构调用来源 / context 生命周期
```

所给 kerneltrace 约 5 秒包含 50 轮，可见两缓存对应 12,800 次 `SyncDestroy`，数量与上述对象结构及周期吻合。这里识别到的是固定对象生命周期成本，不是 Planning 业务代码显式批量调用 `SyncDestroy`，也不是死锁或线程异常的证据。它不能单独解释 Linux 与 QNX 约 30 ms 的运行时差。

另一个独立现象发生在构造阶段：刚创建的空中心线缓存也会被 `clear()`。旧实现遍历 64 个 shard 并对 `shared_mutex` 独占加锁、解锁；本地 QNX 实现的解锁通知会带来空缓存广播。trace 观测为每轮 64 次左右的 broadcast，与 50 轮、3,200 次总量吻合。这个成本和析构时两个 CV 的 `SyncDestroy` 是两个不同来源。

相关版本：Planning 分支 `optimize/syncdestroy`，实现提交 `14b766bacd43`（`perf(planning): 重构拓扑几何缓存，消除 QNX 每轮条件变量析构和空清理广播`）。

## 使用方式与数据生命周期

manager 缓存服务于并行只读的几何计算。每个 context 根据当前 lane 集合预登记稳定 key：中心线使用 lane id；边界使用完整 `(boundary_id, lane_id)` 组合，以保留同一 boundary 在不同 lane 方向上的几何差异。预登记只创建空槽位，不提前构造 `PolylineManager`。

```text
创建或地图更新
    → 建立排序后的空槽位 key 表

并行查询
    → 校验输入
    → 二分查找槽位
       ├─ 已发布 manager：acquire-load 指针，直接返回
       ├─ 槽位为空：分片 mutex，二次检查，按需构建并 release-store
       └─ 未登记 key：进入加锁的兼容 map

线程池完成且所有指针消费者结束
    → 清理、重建、赋值或析构
```

并行阶段中的命中路径不获取锁、不触碰 `unique_ptr` 所有者字段，也不进行引用计数更新。冷 miss 仍串行化同一分片首次创建，避免相同 key 重复构建。工厂失败不发布结果，可在之后重试；未知 key 仍能通过兼容 map 查询，避免把漏登记 key 错当成无效几何。

cache 维护 manager 的唯一 `unique_ptr` 所有权；返回的裸指针只在该缓存代际内有效。**原子发布只确保完整构造对象对读者可见，不会延长对象寿命，也不允许与读者并发清理。** 调用方必须等并行查询以及用裸指针的后续几何计算全部结束，再执行 `clear`、地图更新、赋值或析构。

## 正确性保护

- 中心线 getter 继续校验 lane id、lane 存在性及中心线点数，并从实际 `cur_lanes_` 几何构建。
- 同 id lane 重复输入仍保留 map 原有的首个 `emplace` 语义。
- 边界 getter 继续校验 boundary 和 lane 几何，使用完整 64 位复合 key，并由原方向判断逻辑生成方向匹配的 polyline。
- 拷贝构造不共享 manager，只为拷贝后的 lane 集合建立空槽位；新旧 context 可以同时存活。
- 地图重算与赋值会同时失效两类几何缓存；这补上原逻辑仅清中心线缓存时边界缓存可能残留旧几何的问题。
- `mutable_cur_lanes()` 在交出可写句柄前同时清理两类缓存。当前调用在串行更新路径中修改现有 lane；调用方不得把可写句柄跨并行只读阶段保留。
- 构造阶段对空缓存调用 `clear()` 现在只遍历零个槽位，不包含 `shared_mutex`，因此不会触发原来的逐 shard 独占解锁广播。

## 为什么采用方案 C

方案 B 把读写锁换成普通 mutex，能去除每 shard 的共享读写锁状态，但缓存命中也会互斥串行。这里读访问多、manager 创建少；命中使用普通 mutex 会改变主要工作负载的并行性。

方案 C 保留“同 key 只成功创建一次”和所有权语义，同时将已发布槽位的读命中变为原子 load。首次创建仍有 mutex，但它只约束冷 miss，不阻塞同 shard 上已经发布 key 的命中。代价是每个预登记 key 有稳定槽位内存和地图更新时排序/建表成本；遗漏 key 走加锁兼容路径。它针对本缓存的读多写少特点，比泛化地把所有访问改为 mutex 更合适。

这不意味着所有 `shared_mutex` 都应换成这种 cache。C 要求 key 集合在一次读阶段固定，且回收点能保证没有指针消费者。若业务需要不停变更索引、锁对象需服务一般读写区间，应该单独选择同步原语和生命周期协议。

## 验证与证据边界

本地验证覆盖：通用缓存并发初始化、同 key 单次成功发布、失败重试、命中绕开同 shard 冷 factory、清理所有权；实际 TopologyContext 的同 id 地图更新、边界方向、拷贝赋值、mutable lane 更新、未知 key 和并行查询。通用测试经 Linux Bazel、ASan/UBSan 和 TSan；TopologyContext 与缓存源文件通过 QNX 7.1 AArch64 交叉编译。TopologyContext 的 QNX 目标对象不引用 `shared_mutex` 或条件变量。

TopologyContext 七项业务几何测试使用实际 `TopologyContext` 和 `PolylineManager`，并隔离链接了从当前工具源码提取的相关函数。完整 Bazel 测试当时被 common/proto 版本接口不匹配挡住（`vx_acc_max_lon_jerk_pts`、`last_passed_crossing_cache_info`），所以隔离测试通过不能写成完整业务集成构建通过。尚未进行 SA8650 目标板回放或优化后 kerneltrace，不能给出整轮延迟收益。

复现和验收应使用相同 QNX 输入，比较 Planning 输出、周期 P50/P95/P99 及优化后 trace 中的 SyncDestroy/broadcast；覆盖正常 lane、同 id 几何变化、地图更新、双向共用 boundary、退化几何和不同候选数。当前结论是：**已从这两套缓存的类型结构中移除了固定 CV 析构来源与空清理广播来源；收益大小和完整业务回归仍需目标板验证。**
