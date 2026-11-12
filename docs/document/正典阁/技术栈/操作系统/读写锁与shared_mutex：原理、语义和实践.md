---
title: "读写锁与 shared_mutex：原理、语义和实践"
date: 2026-11-12
description: "从互斥与共享状态出发，解释读写锁的状态机、原子快路径、阻塞等待、C++17 SharedMutex 要求、饥饿与性能取舍，并给出可直接使用的 C++ 示例。"
categories:
  - 正典阁
tags: [操作系统, 并发, 读写锁, shared_mutex, C++17, 原子操作, 条件变量]
---

# 读写锁与 `shared_mutex`：原理、语义和实践

读写锁（read-write lock, RW lock）允许多个线程同时读取同一份受保护状态，同时保证写操作独占。它看起来像“读锁可以共享、写锁排他”，但实现上需要协调读者数量、写者等待、唤醒和内存可见性。

本文从同步原语本身讲起，然后说明 C++17 `SharedMutex` 命名要求、标准使用方式、常见错误和性能判断。条件变量的一般等待/唤醒协议见[条件变量原理：从共享状态到等待与唤醒](./条件变量原理：从共享状态到等待与唤醒.md)。

## 1. 先说清楚要保护的状态

假设一张不可变配置表会被许多线程查询，偶尔才整体更新。若所有访问都用普通 mutex，任意两个查询也不能并行；若完全不用锁，更新可能与读取交错，读者看到半更新的数据。

读写锁表达的互斥关系是：

| 已有所有者 | 新读者 | 新写者 |
|---|---|---|
| 无 | 可以取得共享所有权 | 可以取得独占所有权 |
| 一个或多个读者 | 可以或等待，取决于策略 | 等到所有读者退出 |
| 一个写者 | 等待 | 等待 |

核心不变量只有两条：

```text
writer_active  => reader_count == 0
reader_count > 0 => writer_active == false
```

实现可以不同，但任何并发交错都必须维持这两条不变量，并让锁的释放与后续成功获取建立必要的内存同步关系。

## 2. 读写锁内部最小状态机

教学用状态可以写成：

```cpp
struct State {
  bool writer_active;
  unsigned reader_count;
  unsigned waiting_writers;
};
```

这几个字段必须被某种同步机制保护。最直接的教学实现用一把内部 mutex 保护状态，再用条件变量阻塞不能进入的线程：

```text
lock_shared:
  lock(gate)
  waiting_readers++
  while writer_active || (writer_preferred && waiting_writers > 0):
    readers_cv.wait(gate)
  waiting_readers--
  reader_count++
  unlock(gate)

unlock_shared:
  lock(gate)
  reader_count--
  if reader_count == 0 && waiting_writers > 0:
    writers_cv.notify_one()
  unlock(gate)

lock:
  lock(gate)
  waiting_writers++
  while writer_active || reader_count > 0:
    writers_cv.wait(gate)
  waiting_writers--
  writer_active = true
  unlock(gate)

unlock:
  lock(gate)
  writer_active = false
  if waiting_writers > 0:
    writers_cv.notify_one()
  else:
    readers_cv.notify_all()
  unlock(gate)
```

这只是解释状态转换的伪代码，不应当当作完整生产实现：还要处理 try-lock、计数上限、条件变量构造/析构、异常、等待者退出、唤醒策略以及 mutex 的内存序。所有条件变量等待都必须在 `while` 中重检谓词，因为允许虚假唤醒；通知只是“现在可以重新检查”的提示，不代表锁已经交给等待者。

## 3. 两种常见底层结构

### 3.1 内部 mutex 加条件变量

所有进入/退出操作都短暂取得 gate mutex，更新 reader/writer 状态；不满足条件的线程睡在读者或写者条件变量上。优点是状态转换直观、容易维护公平策略；代价是连只读获取也要修改共享 reader count，并争用 gate mutex。频繁的读锁会让 gate 成为串行点。

### 3.2 原子快路径加阻塞慢路径

更偏向读多写少的结构把 writer 位、等待者门闩和 reader count 编进一个原子状态：

```text
state = [ writer bit | waiter/gate bit | reader count ]
```

无竞争读者用 CAS 增加计数，无竞争写者用 CAS 从零取得独占状态。竞争时才进入内部 gate 和条件变量慢路径。它省去了无竞争路径的 mutex，但也没有消灭共享状态：每次读者进入/退出都需要更新同一原子 cache line，多核系统中会发生 cache coherence 流量。读者很多时，一个全局 reader count 仍然可能成为热点。

还有分布式 reader counter、分层计数、队列锁等更复杂设计。它们可能减少热点，但增加合并计数、写者等待、迁移、可移植性和证明正确性的难度。读写锁不是算法免费加速器，必须按照真实读写比和临界区长度测量。

## 4. C++17 的 `SharedMutex` 要求

C++17 定义了 `SharedMutex` 和 `SharedLockable` 命名要求。`std::shared_mutex` 必须提供独占和共享两类操作：

```cpp
void lock();
bool try_lock();
void unlock();

void lock_shared();
bool try_lock_shared();
void unlock_shared();
```

标准语义包括：

- 多个执行线程可以同时拥有 shared ownership。
- shared ownership 和 exclusive ownership 不得同时存在。
- 同一线程不得递归取得同一个 shared mutex 的任一种所有权；不能把它当 recursive mutex 使用。
- 成功的 `lock`、`lock_shared` 与对应 unlock 之间具有标准规定的同步关系，使受保护数据的写入对后续所有者可见。
- `try_lock` 和 `try_lock_shared` 不等待；失败不修改所有权状态。C++ 标准允许 try-lock 即使在锁当前未被占用时仍返回 false，所以它们不是“判断锁空闲”的可靠探针。
- 一个 shared mutex 至少要允许 10,000 个并发 shared owners；实际最大数由实现决定，达到上限时多余读者阻塞。
- `std::shared_mutex` 要满足 standard-layout 要求。
- 在线程仍持有锁时析构对象、线程持锁退出或递归取得所有权都属于未定义行为。

标准**没有**规定 FIFO、公平性、读者或写者最大等待时限、优先级继承、内部必须使用条件变量，也没有要求 `shared_mutex` 一定比 mutex 快。定时共享/独占接口属于 `std::shared_timed_mutex`，不是基础 `std::shared_mutex` 必需接口。

## 5. 标准用法与 RAII

最常见的用法是共享只读区和独占修改区：

```cpp
#include <shared_mutex>
#include <unordered_map>

class ConfigTable {
 public:
  bool Find(int key, Value* out) const {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = values_.find(key);
    if (it == values_.end()) return false;
    *out = it->second;
    return true;
  }

  void Update(int key, Value value) {
    std::unique_lock<std::shared_mutex> lock(mutex_);
    values_[key] = std::move(value);
  }

 private:
  mutable std::shared_mutex mutex_;
  std::unordered_map<int, Value> values_;
};
```

`std::shared_lock` 表示共享所有权；`std::unique_lock` 或 `std::unique_lock<std::shared_mutex>` 表示独占所有权。RAII 能确保异常返回时解锁。只在锁内使用容器迭代器和引用；若要在解锁后继续使用对象，需要明确拷贝、引用计数或其他生命周期方案。

避免手写 `lock()`/`unlock()`，也不要在持有 shared lock 时直接升级为 unique lock。标准 shared mutex 没有原子升级协议；先释放读锁再拿写锁，中间状态可能变化，必须重新验证谓词。设计需要频繁升级时，考虑重新组织数据流、使用单写者、复制后发布或独立的升级锁协议。

## 6. 公平性与饥饿

实现允许多种策略：

- **读者优先**：只要当前没有 writer，新读者继续进入。连续读流可能让 writer 长时间等不到 reader count 归零。
- **写者优先**：一旦 writer 登记，新读者不再进入。持续 writer 流可能让 reader 长期等待。
- **FIFO/队列策略**：按等待顺序或批次排队，降低某一方饥饿概率，但需要更复杂的等待队列与唤醒协议。

不同 C++ 标准库可以选择不同实现策略；调用者不能依赖某一公平规则。实时线程尤其要把等待时限和优先级反转纳入系统设计，不能因为“读锁可共享”就推断高优先级任务延迟有界。

优先级继承通常是互斥锁协议的属性。RW lock 同时有多个读者所有者时，谁应继承等待 writer 的优先级并不简单。除非目标平台文档与实验明确保证，不应假设标准 `shared_mutex` 或自定义实现有 PI。

## 7. 读写锁什么时候有收益

可考虑读写锁的条件：

- 真实工作负载中并发读取占绝大多数，写入很少。
- 读临界区足够长，允许多个读者并行带来的收益大于 reader count 原子更新成本。
- 读侧查询确实受同一数据锁保护，不是更合适的 immutable snapshot、`shared_ptr` 发布或 RCU。
- 基准覆盖读/写比例、线程数、CPU 绑定、临界区长度和 P95/P99，而不是只测单线程 lock/unlock。

不适用或需谨慎的情况：极短读区、写入频繁、同一对象高核数争用、对写者延迟有严格上界、锁需要跨进程、需要读到稳定快照却在锁外保留裸指针。互斥锁实现更简单，低竞争下常常更快。

## 8. 与其他同步方案的边界

| 方案 | 读者 | 写者 | 适合情形 | 主要代价 |
|---|---|---|---|---|
| `mutex` | 串行 | 串行 | 写较多、临界区短、简单可靠 | 读者相互阻塞 |
| `shared_mutex` | 可并发 | 独占 | 读多写少且读区有工作量 | 原子计数/cache line 争用、饥饿风险 |
| immutable snapshot + 原子/`shared_ptr` 发布 | 读侧无锁或少锁 | 构造并替换新版本 | 读极多、更新低频、快照整体替换 | 复制/分配成本、回收延迟和生命周期管理 |
| seqlock/versioned read | 读者乐观重试 | 单写者更新版本 | 读可重算且能检测不一致 | 读期间不能安全持有任意非原子对象；写频繁时重试 |
| RCU/epoch reclamation | 读侧极低同步 | 延迟回收旧对象 | 高读频、成熟平台基础设施 | 回收协议复杂，读者需登记或经过 quiescent state |

“无锁读”不等于“对象安全回收”。原子发布负责可见性；只有 epoch/RCU/reference count/quiescent lifetime 等协议才能解决读者仍使用旧对象时的回收问题。

## 9. 工程审查清单

1. 谓词和被保护数据是否一直由同一同步协议保护？
2. 读者释放后，是否有人在解锁外继续使用借出的引用或指针？
3. 写者等待时，读者是否可能继续插队？业务可接受哪类饥饿？
4. 同一线程是否存在锁递归、读锁转写锁或写锁转读锁？
5. 初始化和错误路径是否能在没有获得所有权时安全返回？
6. 析构前能否证明所有 owners、waiters、callbacks 和裸指针消费者均结束？
7. 性能基准是否含标准库实现对照、多线程和目标平台？
8. 实时场景是否验证优先级反转、超时和尾延迟？

## 10. 延伸阅读

- [条件变量原理：从共享状态到等待与唤醒](./条件变量原理：从共享状态到等待与唤醒.md)
- [QNX SharedMutex 实现与按需等待优化方案](<./QNX/QNX SharedMutex实现与按需等待优化方案.md>)
- C++17 标准草案 N4659：`[thread.sharedmutex.requirements]`、`[thread.sharedmutex.class]`、`[thread.lock.shared]`。
