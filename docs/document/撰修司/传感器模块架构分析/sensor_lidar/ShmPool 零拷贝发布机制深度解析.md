---
title: "ShmPool 零拷贝发布机制深度解析"
date: 2026-09-20
description: "代码路径：platform/church/node/shm/"
categories:
  - 撰修司
tags:
  - sensor_lidar
---

# ShmPool 零拷贝发布机制深度解析

> 基准平台：LP8797-V1-SHARE  
> 生成日期：2026-04-16  
> 代码路径：`platform/church/node/shm/`

---

## 1. 设计动机

LiDAR 点云数据量巨大（单帧 \~8MB），如果走标准的 iceoryx 通道，需要在 RouDi 预分配的 mempool 中分配 8MB chunk。这对 RouDi 共享内存资源消耗极大，且不够灵活。

ShmPool 的设计思路：

- **自己管理一块独立的 POSIX 共享内存**，用于存放大体积的点云裸数据
- 通过 iceoryx **只传输一个轻量 protobuf 消息**（\~KB 级），其中包含 SHM block index 和 seq
- 下游进程通过相同的 ShmPool 映射同一块共享内存来直接读取数据

```
Publisher (sensor_lidar)                Subscriber (perception 等)
        │                                       │
        ▼                                       ▼
  ┌─────────────┐                        ┌─────────────┐
  │  ShmPool     │◄── POSIX SHM 共享 ──►│  ShmPool     │
  │  Write block │                        │  Read block  │
  └──────┬──────┘                        └──────┬──────┘
         │                                       │
         ▼                                       ▼
  iceoryx publish(proto)  ──────────►  iceoryx subscribe(proto)
  (仅含 index + seq)                   (取 index + seq → 读 SHM)
```

---

## 2. 类层次结构

```
ShmPool (公共接口)
  └── ShmPoolImpl (平台实现: shm_pool_impl.cc / shm_pool_impl_qnx.cc)
        └── Segment → PosixSegment (POSIX SHM 管理)
              ├── State (元数据: ceiling_msg_size, block_num, seq 计数器)
              ├── Block[N] (每个 block 的锁 + msg_size + seq)
              └── buf[N] (实际数据缓冲区, 每个 block_buf_size 字节)
                    ↕
              ShmBlock (用户持有的 RAII 句柄, 析构时自动释放锁)
```

| 类名 | 文件 | 职责 |
|-|-|-|
| `ShmPool` | `shm_pool.h` | 公共接口，持有 `ShmPoolImpl` |
| `ShmPoolImpl` | `shm_pool_impl.h` / `*_qnx.cc` | 按 topic key 管理多个 Segment |
| `Segment` | `segment.h` / `segment.cc` | 抽象基类，管理 State/Block/buf 数组 |
| `PosixSegment` | `posix_segment.h/.cc` | POSIX SHM 实现（`shm_open` + `mmap`） |
| `ShmBlock` | `shm_block.h/.cc` | RAII 句柄，析构时释放 Block 锁 |
| `Block` | `block.h/.cc` | 单个 block 的原子锁和元数据 |
| `ShmConf` | `shm_conf.h/.cc` | 根据消息大小计算 block_buf_size 和总 SHM 大小 |
| `SegmentFactory` | `segment_factory.h/.cc` | 创建 `PosixSegment` 实例 |

---

## 3. 共享内存布局

```
POSIX SHM: /<hash_of_topic_name>
┌──────────────────────────────────────────────────────────────────────────┐
│                          managed_shm_ (mmap 映射)                        │
│                                                                          │
│  ┌────────────┐ ┌────────────────────────────────┐ ┌────────────────────┐
│  │   State     │ │ Block[0] │ Block[1] │ ... [N-1]│ │ buf[0]    buf[1]  │
│  │            │ │          │          │          │ │   ...     buf[N-1]│
│  │ ceiling_   │ │ lock_num_│ lock_num_│          │ │                    │
│  │ msg_size   │ │ msg_size │ msg_size │          │ │ 每块 block_buf_   │
│  │ block_num  │ │ seq      │ seq      │          │ │ size 字节          │
│  │ seq_counter│ │          │          │          │ │                    │
│  │ ref_count  │ │          │          │          │ │                    │
│  └────────────┘ └────────────────────────────────┘ └────────────────────┘
│  ◄─ 首页 ──►    ◄── block_num × sizeof(Block) ──►  ◄── block_num ×     │
│  mprotect       ≈ N × 48 bytes                       block_buf_size ──►│
│  (PROT_READ)                                                             │
└──────────────────────────────────────────────────────────────────────────┘

总大小 = sizeof(State) + block_num × sizeof(Block) + block_num × block_buf_size + EXTRA_SIZE
```

### sensor_lidar 配置的 3 个 ShmPool 段

| ShmPool | 绑定 Topic | block_num | ceiling_msg_size | 估算总 SHM |
|-|-|-|-|-|
| `shm_pool_` | `/sensors/lidar/combined_point_cloud_proto` | 10 | 8 MB | \~80 MB |
| `shm_pool_with64_` | `/sensors/lidar/combined_point_cloud_with_64_proto` | 10 | 8 MB | \~80 MB |
| `shm_pool_downsample_` | `/sensors/lidar/combined_point_cloud_downsample_proto` | 10 | 4 MB | \~40 MB |

```cpp
// driver/integration/components/lidar_component.cc
shm_pool_ = std::make_unique<ShmPool>();
shm_pool_->AddSegment(kCloudTopic, 10, 8 * 1024 * 1024);

shm_pool_with64_ = std::make_unique<ShmPool>();
shm_pool_with64_->AddSegment(kCloudWith64Topic, 10, 8 * 1024 * 1024);

shm_pool_downsample_ = std::make_unique<ShmPool>();
shm_pool_downsample_->AddSegment(kCloudDownsampleTopic, 10, 4 * 1024 * 1024);
```

---

## 4. 写入路径（Publisher 端）

### 4.1 完整调用链

```
LidarComponent::PublishCloud(proto_cloud_ptr, param)
  │
  ├── 1. shm_pool_->AcquireWritabledBlock(topic, data_size)
  │        └── ShmPoolImpl::AcquireWritabledBlock()
  │              └── Segment::AcquireBlockToWrite(size, &wb)
  │                    ├── 首次调用: PosixSegment::Create()
  │                    │     shm_open(O_RDWR | O_CREAT | O_EXCL, 0666)
  │                    │     ftruncate(fd, managed_shm_size)
  │                    │     mmap(nullptr, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0)
  │                    │     placement new State, Block[], buf[]
  │                    │     mprotect(首页, PROT_READ)
  │                    │
  │                    └── GetNextWritableBlockIndexAndSeq(index, seq):
  │                          while(true):
  │                            try_seq = state_->IncreaseSeq()  // 全局原子递增
  │                            try_idx = try_seq % block_num    // 环形索引
  │                            if Block[try_idx].TryLockForWrite():
  │                              return (try_idx, try_seq)      // CAS 成功
  │
  ├── 2. memcpy(block->mutable_data(), proto.data().c_str(), data.size())
  │        ← 直接写入共享内存，无序列化/反序列化开销
  │
  ├── 3. proto.set_data_storage(DATA_STORAGE_SHM)
  │      proto.set_data(to_string(block->index()))     // 仅保存 index
  │      proto.set_shm_msg_seq(block->seq())           // 保存 seq
  │
  ├── 4. node()->GenerateMessageWithHeader(topic, proto)
  │      onboard_msg->set_source_timestamp(param->timestamp)
  │      onboard_msg->set_dataplane_timestamp(param->published_timestamp)
  │      onboard_msg->set_sequence_num(param->sequence_num)
  │
  └── 5. node()->PublishWithHeader(topic, onboard_msg)
           ← 通过 iceoryx 发布轻量 proto (~KB 级，不含点云裸数据)

  ShmBlock 对象超出作用域 → 析构:
    Segment::ReleaseWrittenBlock()
      Block[index].ReleaseWriteLock()
        lock_num_.fetch_add(1)  // -1 → 0, 释放写锁
```

### 4.2 关键：ShmBlock 的 RAII 生命周期

`AcquireWritabledBlock` 返回 `shared_ptr<ShmBlock>`。ShmBlock 析构时自动调用 `ReleaseWrittenBlock()`，释放 Block 的写锁。这意味着：

- 写锁的持有时间 = ShmBlock 对象的生存期
- 从 `AcquireWritabledBlock()` 到 `PublishCloud()` 函数返回期间，block 被写锁保护
- 在此期间，读者无法获取该 block 的读锁

---

## 5. 读取路径（Subscriber 端）

### 5.1 完整调用链

```
下游进程收到 iceoryx 消息 → 反序列化 proto
  │
  ├── 检查 proto.data_storage() == DATA_STORAGE_SHM
  │
  ├── index = stoi(proto.data())
  │   seq = proto.shm_msg_seq()
  │
  ├── shm_pool_->AcquireReadabledBlock(topic, index, seq)
  │        └── Segment::AcquireBlockToRead(&rb)
  │              ├── 首次调用: PosixSegment::OpenOnly()
  │              │     shm_open(O_RDWR)
  │              │     fstat → 获取 SHM 大小
  │              │     mmap(MAP_SHARED) → 映射到同一物理内存
  │              │
  │              ├── Block[index].TryLockForRead()
  │              │     CAS: lock_num_ 从 N → N+1
  │              │     如果 lock_num_ < 0 (正在写), 返回失败
  │              │
  │              └── 校验 block.seq() == 请求的 seq
  │                    不匹配 = block 已被覆写，返回失败
  │
  ├── const uint8_t* data = block->data()
  │     ← 直接从共享内存地址读取，零拷贝
  │
  └── ShmBlock 析构 → ReleaseReadBlock()
        lock_num_.fetch_sub(1)  // N → N-1
```

### 5.2 多读者并发

多个下游进程可以同时读取同一个 block：

- `TryLockForRead()` 使用 CAS 将 `lock_num_` 从 N 递增到 N+1
- 只要 `lock_num_ >= 0`（非写锁状态），都能成功
- 释放时 `fetch_sub(1)` 递减

---

## 6. Block 锁机制

### 6.1 状态机

```
lock_num_ 值:
  0   (kRWLockFree)      = 空闲
  -1  (kWriteExclusive)  = 独占写锁
  >0                     = N 个读者持有

转换:
  空闲 → 写锁:  CAS(0 → -1)        Writer 获得独占写
  空闲 → 读锁:  CAS(0 → 1)         Reader 获得共享读
  读锁 → 更多读: CAS(N → N+1)      新 Reader 加入
  写锁 → 空闲:  fetch_add(1)        Writer 释放 (-1+1=0)
  读锁 → 空闲:  fetch_sub(1)        最后一个 Reader 释放
```

### 6.2 实现代码

```cpp
// block.cc
bool Block::TryLockForWrite() {
  int32_t rw_lock_free = kRWLockFree;  // 0
  return lock_num_.compare_exchange_weak(
      rw_lock_free, kWriteExclusive,   // CAS(0 → -1)
      std::memory_order_acq_rel,
      std::memory_order_relaxed);
}

bool Block::TryLockForRead() {
  int32_t lock_num = lock_num_.load();
  if (lock_num < kRWLockFree) return false;  // 写锁占用
  while (!lock_num_.compare_exchange_weak(
      lock_num, lock_num + 1,          // CAS(N → N+1)
      std::memory_order_acq_rel,
      std::memory_order_relaxed)) {
    if (++try_times > kMaxTryLockTimes) return false;
    if (lock_num < kRWLockFree) return false;
  }
  return true;
}

void Block::ReleaseWriteLock() { lock_num_.fetch_add(1); }  // -1 → 0
void Block::ReleaseReadLock()  { lock_num_.fetch_sub(1); }  // N → N-1
```

### 6.3 写入时的 block 选择策略

```cpp
// segment.cc
void Segment::GetNextWritableBlockIndexAndSeq(uint32_t& index, uint64_t& seq) {
  while (1) {
    uint64_t try_seq = state_->IncreaseSeq();   // 全局 seq 原子递增
    uint32_t try_idx = try_seq % block_num;       // 环形选择
    if (blocks_[try_idx].TryLockForWrite()) {
      index = try_idx;
      seq = try_seq;
      return;
    }
    // CAS 失败 → block 被 reader 占用 → 跳到下一个 block
  }
}
```

当目标 block 被读者占用时，writer 不会等待，而是递增 seq 尝试下一个 block。在 10 个 block、10Hz 的场景下，只要读者在 1 秒内释放 block，writer 就不会自旋过久。

---

## 7. 与 iceoryx 标准路径对比

| 维度 | ShmPool | iceoryx 标准路径 |
|-|-|-|
| 数据载体 | 独立 POSIX SHM（`shm_open` + `mmap`） | RouDi 预分配的 mempool chunk |
| 消息大小 | 自由配置（8MB/4MB/...） | 受 RouDi `roudi_config.toml` 限制 |
| 锁机制 | 自定义 CAS 读写锁（用户态） | iceoryx lock-free SPSC 队列 |
| 内存管理 | 应用自行 `shm_open` / `mmap` | RouDi 统一管理 |
| SHM 生命周期 | 发布者创建，读者 `OpenOnly` | RouDi 启动时创建 |
| 多 reader | 通过 `lock_num_` 支持并发读 | iceoryx 自身支持多 subscriber |
| 消费者发现 | 需要双方约定 topic key | iceoryx CAPRO 协议自动发现 |
| 适用场景 | **大消息**（>1MB） | 中小消息（<1MB） |

---

## 8. State 首页保护机制

```cpp
// posix_segment.cc
void PosixSegment::ProtectFirstPageOfShmForState() {
  uint32_t mprotect_size = state_->mprotect_size();
  int page_size = getpagesize();
  MCHECK(page_size > 0 && static_cast<uint32_t>(page_size) == mprotect_size);
  int ret = mprotect(managed_shm_, mprotect_size, PROT_READ);
  MCHECK(ret == 0);
}
```

首页（包含 `State` 结构）被 `mprotect` 设为只读。这防止读者进程意外写入 State 区域（如越界写、野指针等），增强安全性。

> 注：J6P SHARE 平台因兼容性问题跳过了此保护。

---

## 9. Segment 动态扩容 (Recreate)

如果实际消息大小超过 `ceiling_msg_size`：

```cpp
bool Segment::AcquireBlockToWrite(std::size_t msg_size, WritableBlock* wb) {
  if (msg_size > state_->ceiling_msg_size()) {
    result = Recreate(msg_size);  // 销毁旧 SHM → 重建更大的
  }
  // ...
}
```

`Recreate` 流程：

1. `Reset()` — 清除内部指针
2. `Remove()` — `shm_unlink` 删除旧 SHM
3. `conf_.Update(msg_size, block_num)` — 重算 block_buf_size
4. `OpenOrCreate()` — 创建新的更大 SHM

> 注：Recreate 会导致所有已有 reader 映射失效（`state_->set_need_remap(true)`）。Reader 端需要检测 `need_remap` 并重新 `mmap`。

---

## 10. 关联文档

<table id="doxcndnEVsAM7ZXod8PmsTnlrbd"><colgroup><col/><col/></colgroup><thead><tr><th vertical-align="top">文档</th><th vertical-align="top">说明</th></tr></thead><tbody><tr><td vertical-align="top"><cite doc-id="Kr67dls4hoNe6YxiEG2cjg6Dnnf" file-type="docx" title="sensor_lidar 数据流详解" type="doc"></cite></td><td vertical-align="top">数据流详解（含 ShmPool 发布路径）</td></tr><tr><td vertical-align="top">thread_list.`md</td>`<td vertical-align="top">线程清单</td></tr><tr><td vertical-align="top"><cite doc-id="FDU3dZN4soBr6mxHc4HcnHkwnhd" file-type="docx" title="sensor_lidar 异常检测机制" type="doc"></cite></td><td vertical-align="top">异常检测机制</td></tr><tr><td vertical-align="top"><cite doc-id="W4Tjd5MScod6LlxxmuHcMhfpnIb" file-type="docx" title="sensor_lidar 模块总览" type="doc"></cite></td><td vertical-align="top">模块总览</td></tr></tbody></table>
