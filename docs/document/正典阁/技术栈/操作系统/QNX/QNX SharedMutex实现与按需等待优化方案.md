---
title: "QNX SharedMutex 实现与按需等待优化方案"
date: 2026-11-12
description: "对照 QNX 7.1 libc++ shared_mutex 布局和 Planning trace，解释固定条件变量生命周期成本，并记录公共 C++17 SharedMutex 的原子快路径、门闩协议和适用边界。"
categories:
  - 正典阁
tags: [QNX, shared_mutex, 读写锁, libc++, SyncDestroy, 并发, 实时系统]
---

# QNX `SharedMutex` 实现与按需等待优化方案

本文串起两个层次：QNX 7.1 自带 C++ `shared_mutex` 的具体 libc++ 对象布局，以及 common 中实现的独立跨 Linux/QNX `deeproute::base::SharedMutex`。后者避免使用 `std::shared_mutex` 的固定实现布局，但保留 C++17 共享/独占锁接口。它仍使用标准 mutex 和 condition variable 作为阻塞慢路径，并不直接调用 QNX 内核 API，也没有接入 Planning 缓存方案 C。

读写锁通用语义见[读写锁与 shared_mutex：原理、语义和实践](../读写锁与shared_mutex：原理、语义和实践.md)；条件变量通用等待语义见[条件变量原理](../条件变量原理：从共享状态到等待与唤醒.md)。

## 1. QNX 7.1 libc++ 的实现证据

分析使用本地 QNX 7.1 SDK 的 libc++ 头文件：

```text
/sandbox/toolchains_qnx/target/qnx7/usr/include/c++/v1/shared_mutex
```

其中 `std::__shared_mutex_base` 的成员如下：

```cpp
struct __shared_mutex_base {
  mutex              __mut_;
  condition_variable __gate1_;
  condition_variable __gate2_;
  unsigned           __state_;
};
```

`shared_mutex` 包含一个 `__shared_mutex_base`。独占与共享加锁接口转发给这个 base；QNX 7.1 的 `shared_mutex` 本身因此固定携带两个 `condition_variable` 子对象，即使该锁从未发生阻塞等待。QNX 7.1 libc++ 实测 `sizeof(shared_mutex) == 28` 字节；这只是该工具链和 ABI 的实测尺寸，不是 C++ 标准承诺。

### 1.1 两道 gate 表达了什么

头文件中的实现状态用最高位表示 writer 已进入或 writer 门闩，其余低位保存 reader 数。整体算法意图可以概括为：

```text
exclusive lock:
  先确保没有 writer 门闩
  登记 writer 门闩，阻止新 reader 无限插入
  等待 reader 数归零
  取得 writer 所有权

shared lock:
  如果已有 writer 门闩或 reader 数到上限，则等待 gate1
  否则增加 reader 数

last reader unlock:
  reader 数变为零时通知 gate2 上等待的 writer

writer unlock:
  清除 writer 状态并通知 gate1 上的后来者
```

QNX libc++ 的两个条件变量不是“标准规定 shared_mutex 必须有两个 CV”，而是该实现用于协调读者进入、写者等待和状态变化的具体选择。其他标准库可以使用 pthread rwlock、mutex/CV、原子状态或不同等待结构，只要实现满足 C++ 的同步语义。

SDK 头文件内对 `shared_timed_mutex` 的模板等待逻辑可以看到 `gate1` 用于等待 writer 门闩解除，`gate2` 用于等待 reader 计数归零。普通 `shared_mutex` 的运行期实现位于标准库二进制中，不能仅从模板片段推断其所有内部指令和调度策略。

## 2. Planning trace 中为什么每轮出现 SyncDestroy

被分析的 `TopologyContext` 原有两个 `ShardedConcurrentPtrMap`，每个有 64 个 `shared_mutex` shard。对象生命周期每轮重建，析构时按成员/分片顺序销毁这些锁。按本地 QNX 7.1 libc++ 布局计算：

```text
2 缓存 × 64 shard × 每个 shared_mutex 的 2 个 condition_variable
= 256 个条件变量析构来源 / context
```

所给 kerneltrace 约 5 秒包含 50 轮，观察到两缓存对应的 12,800 次 `SyncDestroy`，总量与布局、地址间隔和生命周期节奏匹配。此处的 executor owner 为 `_NTO_SYNC_COND`，对应条件变量。统计只建立了同步对象析构来源的高置信关联；不能据此把约 30 ms 的平台耗时差归因于这一个因素。

另外，构造新 context 时原代码无条件清理空的中心线缓存。旧缓存 `clear()` 会逐一对 64 个分片加独占锁再解锁；QNX 该 shared_mutex 路径会发广播。因此每轮还会有约 64 次空清理广播，50 轮对应约 3,200 次。它与析构的 256 次 CV `SyncDestroy` 是不同事件来源。

同一 trace 在相关 CV 地址上没有匹配到 `SyncCondvarWait`，说明该观测窗口没有看到这些对象的 condition-variable 阻塞，不代表控制 mutex 从未竞争，也不代表其他负载下 CV 永不等待。

## 3. 两条优化路线必须区分

### 3.1 Planning 实际落地：专用只读缓存方案 C

Planning 提交 `14b766bacd43` 将两套缓存改为 `ReadMostlyPtrCache`，直接移除了这些热点缓存中的 `shared_mutex`。排序槽位表在地图或 context 重建时建立；已发布 manager 的缓存命中采用原子 acquire-load，不再取得共享锁。空槽位首次构建使用分片普通 mutex；未预登记的合法 key 走受 mutex 保护的兼容 map。`PolylineManager` 仍按需创建。

方案 C 的状态流是：

```text
empty slot
  → cold miss 取得 shard mutex
  → 二次检查
  → 工厂成功并把 unique_ptr 放入唯一 owner
  → release-store 发布裸指针
  → 多个查询者 acquire-load 后只读

工厂返回空或抛异常
  → 不发布，槽位保持 empty，后续可重试
```

它不仅避免固定 256 个 CV 析构对象，也避免查询命中时共享锁的 reader count 原子更新。`clear()`、`reset_keys()`、赋值、地图更新和析构仍必须位于 reader 及裸指针消费者都结束后的安全点；原子发布不实现并发回收。

### 3.2 公共库候选：保留读写锁 API，重写锁的内部策略

common 中另行增加 `deeproute::base::SharedMutex`，目标是让通用读多写少代码可以使用 C++17 SharedMutex/SharedLockable 接口，而不绑定 QNX `std::shared_mutex` 的两个 eager CV 布局。它不是 Planning 方案 C 的内部组件，也没有证据表明已接入或跑过 SA8650 实机负载。

新锁的组成如下：

```text
SharedMutex 对象：
  atomic<uint32_t> state
  atomic<SlowState*> slow

首次竞争后才创建的 SlowState：
  std::mutex gate
  optional<condition_variable> readers
  optional<condition_variable> writers
  reader/writer waiter counts
```

其中两个条件变量分别可选；仅当相应等待者已经登记，并在 gate 保护下发现谓词仍不满足、马上要睡眠时才构造。若没有实际等待，CV 子对象不被构造，也就没有它们的 CV 析构调用来源。发生真实阻塞后，创建过的 CV 会在 `SharedMutex` 析构时正常析构；这不是“从此所有 SyncDestroy 为零”。

## 4. 公共 SharedMutex 的状态编码与快路径

32 位状态被划分为：

```text
bit 31      独占 writer 持有
bit 30      有慢路径等待者，关闭新快路径获取
bits 0..29  shared owner 数量
```

30 位 reader count 可表达超过 10,000 的并发读者，满足 C++17 至少 10,000 个并发 shared owners 的要求。实现使用 `static_assert` 检查计数宽度、32 位原子和指针原子均为 always lock-free；当前 QNX 7.1 AArch64 工具链可以通过这些约束的交叉编译。

### 4.1 无竞争获取

- `try_lock()` 对空状态执行 CAS，把 state 变为 writer-owned；成功用 acquire 语义。
- `lock_shared()` 在没有 writer/waiter 且计数未满时，CAS 增加 reader count；成功用 acquire 语义。
- `unlock`/`unlock_shared` 用 release CAS 更新状态。
- `try_lock_shared()` 只做一次原子尝试，不分配状态、不等待、不抛异常。竞争下 CAS 失败即返回 false，符合 try-lock 可失败的语义。

因此未竞争 `SharedMutex` 对象没有 `std::mutex`/CV 慢状态，也不会为了共享 reader count 进入内部 mutex。它仍会让所有 reader 更新同一个原子 cache line；多核读者很多时，cache-line 一致性成本可能主导耗时。

### 4.2 首次竞争与可选等待对象

首次进入慢路径时用 `atomic<SlowState*>` 发布唯一、稳定的慢状态地址。多个线程可以同时尝试分配候选状态，CAS 胜者成为 owner，其余候选释放。候选 `SlowState` 默认只有 gate mutex 和空 optional，不含已构造 CV。

等待者取得 gate 后先登记计数并原子设置 waiter bit。它和正在释放锁的 owner 必须遵守同一个门闩：

```text
owner release CAS 若先成功
  → waiter 随后设置门闩，重新检查状态，可直接获得锁

waiter 设置门闩若先成功
  → owner 的快路径 CAS 失败，改走 gate 慢路径
  → waiter 在 gate 下检查谓词并原子释放 gate 进入 cv.wait
  → owner 取得 gate、更新状态并通知
```

注册、谓词重检、条件变量等待以及 notifier 检查都用同一个 gate 保护。等待后总是重新检查谓词，以处理虚假唤醒。这个协议防止“waiter 检查后、真正睡下前 notifier 已经过”的丢失唤醒窗口。不能只靠一个 atomic flag 加无条件 notify 来替代完整等待注册协议。

有 writer 登记后，新 reader 被 gate 阻挡；最后一个 reader 退出时唤醒一个 writer。writer 释放后，优先通知另一 writer；没有等待 writer 时才广播唤醒读者。notify 不会交出锁，醒来的线程仍要重新竞争 gate 和重新检查状态。

如 slow state 或确实需要等待时的 CV 分配失败，阻塞 `lock`/`lock_shared` 抛 `std::system_error(resource_unavailable_try_again)`，且不取得所有权。`try_lock*` 路径不会走这些分配。

## 5. 为什么该方案有优势，以及优势的边界

### 优势

1. **对象冷态轻。** `SharedMutex` 常驻字段只有两个原子变量；不竞争、不阻塞的对象不会创建两把 CV。这针对 QNX libc++ 固定在每对象内的两个 CV 生命周期成本。
2. **常见操作短。** 无竞争路径是少量 CAS/load，不取得 gate mutex；实现不在读快路径上串行保护 reader count。
3. **条件变量按需。** 即使已经创建慢状态，只发生状态竞争但 waiter 进入慢路径时发现条件立即成立，也不必构造 CV。只有谓词不满足而要真正睡眠才初始化对应 CV。
4. **等待协议可审计。** 单一 gate 覆盖等待登记、predicate 和通知判断；状态变化使用 atomic RMW，释放与后续获取有明确的 acquire/release 关系。
5. **跨平台源码统一。** 状态机用 C++17 原子和标准库阻塞原语表达，不依赖 QNX 私有 ABI 或直接 syscall。Linux 和 QNX 使用同一库代码。

### 不能忽略的成本

- 有真实 waiter 时仍创建 `std::condition_variable`；QNX 底层依旧可以产生 `SyncDestroy`。
- 首次慢路径有 heap allocation、`std::mutex` gate 和条件变量初始化成本；RT 热路径不可接受首次分配时，需要提前预热/预留状态或继续使用静态同步对象。
- reader count 单点共享，跨核原子争用可能比系统 `std::shared_mutex` 更慢。原子并不等于免费，也不等于读锁无锁容器。
- 写者优先策略阻止新读者持续插队，能避免长期 reader stream 饿死 writer；但持续 writer stream 可使 reader 饥饿。C++ 标准未要求公平性，但业务可能要求有界等待。
- 内部 gate 使用 `std::mutex`，没有建立 priority inheritance 协议。面向 QNX RT priority 的用法必须测试优先级反转，不能用 mutex API 表面相似就假定 PI。
- `condition_variable` 和 mutex 仍由目标 C++ runtime 提供；这是跨平台调用标准库阻塞机制，不是完全避开 QNX libc。

所以“更好”特指**无竞争对象不付出 eager CV 的构造/析构成本，并使无竞争操作走原子快路径**。它不保证全负载下快于平台库，也不保证公平或实时优先级继承。

## 6. 两条方案的适用范围

| 问题形态 | 建议方案 | 理由 |
|---|---|---|
| key 集合在一个并行读阶段固定，命中占绝大多数，读阶段结束后可以统一回收 | Planning `ReadMostlyPtrCache` 方案 C | 命中不用锁，状态/生命周期能用稳定槽位明确建模 |
| 通用读写临界区，希望保留 `lock/lock_shared` 标准接口，且实测 QNX 平台实现的空对象成本值得优化 | 评估公共 `deeproute::base::SharedMutex` | 可直接作为 lockable 类型，但公平性/PI/尾延迟需逐平台验收 |
| 写入频繁、临界区极短或多核 reader count 高争用 | 先测 `mutex` 与系统实现 | 自定义 RW lock 可能把 cache line 争用变成瓶颈 |
| 可整体复制数据并低频发布、读侧生命周期能延长 | immutable snapshot / 原子发布 | 读侧可避免 per-access reader count，代价转为复制和回收 |

不要为了消除单个 trace 现象全局替换所有 `std::shared_mutex`。对象布局开销、无竞争读延迟、等待时的 scheduler 行为是三个不同维度，需要分开测量。

## 7. 验证状态和上线检查

截至 2026-11-12，本公共库已通过 Linux `//base/synchronization:shared_mutex_test` 8 项 Bazel 测试；同版测试通过 ASan/UBSan 和 TSan；实现及测试源文件通过 QNX 7.1 AArch64 交叉编译。测试包括 RAII 适配、读写互斥、写者登记后禁止新读者插队、混合读写压力、128 个同时持有读锁的线程，以及竞争后析构。

与 `std::shared_mutex` 的 benchmark target 已构建，覆盖 1–16 个线程的 shared、exclusive 和 mixed 模式；当前没有可用于结论的 SA8650 实机 benchmark 数值，也尚无 Planning 集成结果。单线程短跑或 DEBUG-linked benchmark 不能替代目标负载比较。

目标板验收至少比较：

- 空对象构造/析构、只读无竞争命中、写锁无竞争的 CPU 与 SyncDestroy。
- 真实 reader/writer 比、热点 reader count 的多核扩展性、冷启动首次竞争成本。
- 高优先级 reader/writer 与低优先级 owner 交错时的反转和 P99/P999 wait time。
- 连续 writer 与连续 reader 两类负载下的饥饿边界。
- 生命周期：析构前无 owner/waiter，锁对象不被移动或销毁，裸指针消费者不越过 cache generation。

只有在目标 QNX 版本、标准库、编译器、优化等级和实际线程优先级下通过这些测试，才应把该库作为对应使用点的替代方案。
