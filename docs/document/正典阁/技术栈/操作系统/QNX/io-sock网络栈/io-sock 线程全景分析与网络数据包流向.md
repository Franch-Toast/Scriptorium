---
title: "io-sock 线程全景分析与网络数据包流向"
date: 2026-09-20
description: "本文档基于对 QNX 7.1 系统中 io-sock 进程的 74 个线程的详细分析，解释每个线程的作用、线程间的协作关系，以及网络数据包从网卡到达用户应用的完"
categories:
  - 正典阁
tags:
  - QNX
  - io-sock
---

# io-sock 线程全景分析与网络数据包流向

## 一、概述

本文档基于对 QNX 7.1 系统中 io-sock 进程的 74 个线程的详细分析，解释每个线程的作用、线程间的协作关系，以及网络数据包从网卡到达用户应用的完整流转路径。

**分析依据说明**：

- **[文档]**：来自 QNX 7.1 io-sock 官方 Eclipse HTML 文档
- **[头文件]**：来自 `toolchains_qnx/target/qnx7/usr/include/` 下的头文件
- **[FreeBSD]**：io-sock 基于 FreeBSD 13.0 代码库，从 FreeBSD 内核源码/手册推导
- **[推测]**：文档中未明确记录，根据线程名称和上下文进行的合理推测

## 二、线程分类总览

| 类别 | 数量 | 优先级来源 |
|-|-|-|
| 框架核心 (main, kthread, unblock) | 3 | 进程默认优先级 |
| softirq（per-CPU 延迟任务） | 8 | [推测] isr_pulse_prio 或内部固定 |
| netisr（协议栈处理） | 1 | [推测] 栈内部默认，可能 21 |
| clock/timer（定时器） | 1 | timer_pulse_prio（默认 21） |
| taskqueue（延迟任务） | 7 | taskq_pulse_prio（默认 21） |
| crypto（IPSec 加解密） | 17 | [推测] 栈内部默认 |
| PF（包过滤） | 3 | [推测] 栈内部默认 |
| EMAC 驱动（硬件驱动层） | 16 | isr_pulse_prio（中断线程），其他为驱动内部设置 |
| resmgr worker（资源管理器） | 18 | 继承客户端优先级 |
| **合计** | **74** |  |

## 三、各类线程详细分析

### 3.1 io-sock 框架核心线程（3 个）

| 线程名 | 作用 | 依据 |
|-|-|-|
| `io-sock main` | io-sock 进程的主线程，负责初始化整个网络栈、加载驱动、创建 channel 和线程池 | **[文档]** io-sock 是一个用户态进程 |
| `qnx_kthread_context` | QNX 对 FreeBSD kthread API 的兼容层。FreeBSD 内核中许多子系统用 `kthread_create()` 创建内核线程，在 io-sock（用户空间）中被映射为 QNX 的 pthread | **[推测]** 名称含 kthread 表明这是 FreeBSD→QNX 的 kthread 适配上下文 |
| `unblock handler` | QNX 资源管理器框架的 unblock handler 线程。当客户端被信号中断（如 SIGINT）而需要取消阻塞时，此线程处理 `_PULSE_CODE_UNBLOCK` 脉冲 | **[文档]** QNX resmgr 框架标准组件 |

### 3.2 softirq 线程（8 个）— per-CPU 延迟任务处理

| 线程名 | 作用 | 依据 |
|-|-|-|
| `softirq_0` \~ `softirq_7` | grouptask queue 的 per-CPU 工作线程。处理网络栈中的延迟任务，包括以太网层处理、协议分发（DIRECT 模式）、定时器回调等。8 个线程对应 8 个 CPU | **[头文件]**`gtaskqueue.h` 中 `TASKQGROUP_DECLARE(softirq)` 声明了 softirq taskqueue group |

**关键发现**：softirq 在 io-sock 中不是 Linux 意义上的软中断，而是 FreeBSD iflib 框架的 grouptask queue。它是通用的 per-CPU 延迟执行框架，详见后文"softirq 与 netisr 的关系"章节。

### 3.3 netisr 和 clock 线程（2 个）— 协议栈核心

| 线程名 | 作用 | 依据 |
|-|-|-|
| `netisr 0` | 网络 ISR 分发线程，负责处理 IP 层和上层协议（TCP/UDP）。`0` 表示只有 1 个 netisr 线程（默认值）。可通过 `netisr_threads` 选项调整 | **[文档]**`netisr_threads` 选项：*"The number of netisr (kernel network dispatch service) threads to run. Default is 1. -1 specifies the maximum, which is the number of CPUs."* |
| `clock (0)` | 定时器线程。处理网络栈中的所有定时器事件：TCP 重传、keepalive、TIME_WAIT 超时、ARP 缓存老化等 | **[文档]**`timer_pulse_prio` 选项：*"The priority used by the receive thread to handle timer pulses. Default is 21."* |

### 3.4 taskqueue 线程（7 个）— 延迟任务处理

| 线程名 | 作用 | 依据 |
|-|-|-|
| `fast_taskqueue` | FreeBSD 的 `taskqueue_fast`，处理高优先级的快速延迟任务（通常从中断上下文排入），典型用途：驱动的 TX 完成清理 | **[FreeBSD]** taskqueue_fast 是 FreeBSD 内建的快速任务队列 |
| `thread taskq` | FreeBSD 的 `taskqueue_thread`，通用线程化任务队列 | **[FreeBSD]** 标准 FreeBSD taskqueue |
| `Giant taskq` | 在 FreeBSD Giant 锁保护下运行的任务队列。Giant 锁是 FreeBSD 的全局内核锁（遗留机制），某些旧代码路径仍需要它 | **[FreeBSD]** taskqueue_giant |
| `task queue` | 另一个通用任务队列实例 | **[FreeBSD]** |
| `in6m_free taskq` | IPv6 多播组释放的延迟处理。释放多播组成员资格是一个可能阻塞的操作，因此延迟到 taskqueue 中执行 | **[FreeBSD]** in6m = IPv6 multicast membership |
| `kqueue_ctx taskq` | kqueue 事件上下文的延迟处理。kqueue 是 FreeBSD 的事件通知机制 | **[FreeBSD]** |
| `inm_free taskq` | IPv4 多播组释放的延迟处理 | **[FreeBSD]** inm = IPv4 multicast membership |

**[文档]** io-sock 启动选项 `taskq_pulse_prio`：*"The priority of the taskqueue and gtaskqueue thread pulses. Default is 21."*

### 3.5 crypto 线程（17 个）— IPSec/TLS 加解密

| 线程名 | 数量 | 作用 | 依据 |
|-|-|-|-|
| `crypto_0` \~ `crypto_7` | 8 | 加解密工作线程，每 CPU 一个。处理实际的加密/解密运算（AES、SHA 等） | **[FreeBSD]** opencrypto(9) 框架 |
| `crypto` | 1 | 加解密调度/协调线程，负责将加密请求分发到各 CPU 的 worker 线程 | **[FreeBSD]** 主调度线程 |
| `crypto returns 0` \~ `crypto returns 7` | 8 | 加解密回调线程，每 CPU 一个。当加密操作完成时，执行回调函数，将加密后的数据包送回网络栈 | **[FreeBSD]** crypto_ret_proc，完成回调与请求处理分离避免死锁 |

**[文档]** io-sock Overview：*"The utility has full encryption and Wi-Fi capability built in."*，*"Included services: ... IPSec"*

### 3.6 PF 包过滤线程（3 个）

| 线程名 | 作用 | 依据 |
|-|-|-|
| `pf purge` | PF 状态清理线程。周期性清除过期的防火墙连接跟踪状态、过期的 NAT 表项等 | **[FreeBSD]** pf_purge_thread()。**[文档]** io-sock 使用 FreeBSD PF 实现 |
| `pf send` | PF 数据包发送线程。当 PF 需要主动发送包（如 TCP RST 拒绝连接、ICMP Unreachable 等）时，由此线程执行 | **[FreeBSD]** PF 生成的回应包延迟到专用线程 |
| `pfsync` | PF 状态同步线程。用于多节点间的 PF 防火墙状态同步（高可用场景） | **[FreeBSD]** pfsync(4) 协议 |

### 3.7 EMAC 网络驱动线程（16 个）— 硬件驱动层

EMAC = Ethernet MAC controller，推测为高通/Qualcomm 平台的以太网控制器驱动（devs-emac.so）。

#### 中断处理线程

| 线程名 | 作用 | 依据 |
|-|-|-|
| `emac0 irq 978` | EMAC0 的主中断处理线程，IRQ 号 978 | **[文档]** native_drvr.html: *"The interrupt handler does not run in the kernel interrupt context. Instead, a dedicated thread is created."*，`isr_pulse_prio` 控制其优先级 |
| `emac0 irq 814` | EMAC0 的辅助中断处理线程，IRQ 号 814 | **[推测]** 可能是 Wake-on-LAN、PHY 中断或 PTP/IEEE 1588 时间戳中断 |

#### 收包（RX）线程

| 线程名 | 作用 | 依据 |
|-|-|-|
| `emac_rx_thread_hand` | EMAC RX 线程处理器。从 DMA 描述符中读取已填充的接收缓冲区，构建 mbuf，执行 DMA 同步 | **[文档]** native_drvr.html: *"filled received packets are drained from the hardware"* |
| `emac_rx_if_inp_thre` | EMAC RX 接口输入线程。调用 `(*ifp->if_input)(ifp, m)` 将 mbuf 交给 io-sock 协议栈 | **[文档]** native_drvr.html: 通过 `if_input` 传递 |

#### 发包（TX）线程

| 线程名 | 作用 | 依据 |
|-|-|-|
| `emac_tx_thread_hand` | EMAC TX 线程处理器。将 mbuf 映射到 DMA 描述符，启动硬件发送 | **[文档]** native_drvr.html: transmit callback + DMA 映射 |
| `emac_tx_cleanup_thr` | EMAC TX 清理线程。回收已完成传输的 DMA 描述符和 mbuf | **[推测]** 对应 FreeBSD 驱动中的 TX completion 处理 |
| `tx task` | TX taskqueue 线程。硬件资源不足时暂停，资源可用时重试发送 | **[文档]** native_drvr_sample.html 中 `taskqueue_enqueue(sc->tq, &sc->tx)` 示例 |

#### 驱动管理/监控线程

| 线程名 | 作用 | 依据 |
|-|-|-|
| `Emac Resmgr thread` | EMAC 驱动自己的资源管理器线程 | **[推测]** 处理驱动级别的 devctl/ioctl |
| `link monitor thread` | 链路状态监控，检测网线插拔 | **[文档]** native_drvr.html MII/PHY 回调 |
| `Health timer thread` | 驱动健康检查定时器/看门狗 | **[推测]** 类似 FreeBSD 的 watchdog timer |
| `AC Diagnostic thread` | 自动完成/自协商诊断 | **[推测]** AC 可能指 Auto-Calibration |
| `AUX0 notify thread` | 辅助接口 0 事件通知 | **[推测]** 可能是管理通道 |
| `AUX0 capture thread` | 辅助接口 0 数据包捕获 | **[推测]** 调试/带外管理 |
| `EMAC0 Tbs Log thread` | TBS (Time-Based Scheduling) 日志 | **[推测]** 与 IEEE 802.1Qbv 时间敏感网络相关 |
| `M_SYS_POW_MON_THREAD` | 系统电源监控 | **[推测]** 低功耗模式下暂停/恢复网络 |
| `0_smmu_callback_wait` | SMMU 回调等待 | **[推测]** 等待 DMA 地址映射完成 |

### 3.8 resmgr worker 线程（18 个）

| 线程名 | 数量 | 作用 | 依据 |
|-|-|-|-|
| `resmgr worker` | 18 | 资源管理器工作线程池。接收并处理应用程序的 socket API 请求 | **[文档]***"Resource manager threads inherit their priority from the client making the request."*，*"There is a limit of 700 resource manager threads and 1000 total threads."* |

resmgr worker 线程的关键特性：

- 使用 QNX thread_pool 框架动态管理
- 在 QNX Channel 的 Receive 队列中以 LIFO 顺序等待消息
- 收到消息时继承客户端线程的优先级（Priority Inheritance）
- LIFO 调度导致"热线程/冷线程"分化：经常活跃的线程在队列顶部反复循环，底部的线程可能从未被激活

## 四、网络数据包到达时的完整流转路径

### 4.1 收包（RX）路径全流程

```
                     硬件层                  驱动层                  协议栈层                应用层
                 ┌──────────┐        ┌─────────────────┐    ┌──────────────────┐    ┌──────────────┐
网络包 ──→ [网卡] │ DMA 写入  │─IRQ─→ │ 驱动中断/RX 线程  │─→ │ softirq → netisr │─→ │ resmgr worker│─→ App
                 │ RX Buffer│        │                 │    │ IP/TCP 处理      │    │ MsgReply()   │
                 └──────────┘        └─────────────────┘    └──────────────────┘    └──────────────┘
```

#### 阶段 1: 硬件接收 & DMA

```
┌────────────────────────────────────────────────────────────┐
│ 数据包从网线到达网卡 (EMAC 控制器)                           │
│                                                            │
│ ① 网卡通过 DMA 将数据包写入预先分配的 RX Buffer（物理内存） │
│    → 完全由硬件完成，不涉及 CPU                             │
│ ② 网卡设置 RX 描述符的"完成"标志                           │
│ ③ 网卡触发硬件中断 (IRQ 978)                               │
└────────────────────────────────────────────────────────────┘
```

**依据**: **[文档]** native_drvr.html: *"At the bottom layer are drivers that provide the mechanism for passing data to, and receiving data from, the hardware."*

#### 阶段 2: 中断处理 — `emac0 irq 978`

```
┌────────────────────────────────────────────────────────────┐
│ 线程: emac0 irq 978                                        │
│ 优先级: isr_pulse_prio (默认 21)                            │
│                                                            │
│ ④ QNX 内核收到 IRQ 978，发送 pulse 到 io-sock              │
│    → 中断线程 "emac0 irq 978" 被唤醒                       │
│                                                            │
│ ⑤ 中断处理函数执行：                                       │
│    - 读取中断状态寄存器，确定中断原因                       │
│    - 清除或屏蔽中断源                                      │
│    - 如果是 RX 中断 → 通知 RX 处理线程                     │
│    - 如果是 TX 中断 → 通知 TX 清理线程                     │
└────────────────────────────────────────────────────────────┘
```

**依据**: **[文档]** native_drvr.html: *"The interrupt handler does not run in the kernel interrupt context. Instead, a dedicated thread is created to handle the interrupt handling."*，*"After the interrupt is fired, the driver should clear or mask the interrupt source before it returns."*

#### 阶段 3: 驱动 RX 处理 — `emac_rx_thread_hand`

```
┌────────────────────────────────────────────────────────────┐
│ 线程: emac_rx_thread_hand                                   │
│                                                            │
│ ⑥ 执行 DMA 同步（CPU 可以安全访问 DMA 内存）：             │
│    bus_dmamap_sync(rxdesc_tag, rxdesc_map,                 │
│                    BUS_DMASYNC_POSTREAD)                    │
│                                                            │
│ ⑦ 遍历 RX 描述符环（ring）：                              │
│    for each completed descriptor:                          │
│      - 从描述符中提取数据包长度、校验和状态等               │
│      - 将 DMA buffer 中的数据封装为 mbuf                   │
│      - 分配新的空 DMA buffer 给硬件（重填描述符）          │
│                                                            │
│ ⑧ 将填充好的 mbuf 传递给下一阶段                          │
└────────────────────────────────────────────────────────────┘
```

**依据**: **[文档]** native_drvr.html: *"filled received packets are drained from the hardware, new empty packets are passed to the hardware"*

#### 阶段 4: 接口输入 — `emac_rx_if_inp_thre`

```
┌────────────────────────────────────────────────────────────┐
│ 线程: emac_rx_if_inp_thre                                   │
│                                                            │
│ ⑨ 调用 (*ifp->if_input)(ifp, m)                           │
│    → 数据包从"驱动领域"进入"协议栈领域"                    │
│    → 进入 ether_input()                                    │
│                                                            │
│    在 ether_input() 中执行：                               │
│    - BPF tap（如果有 tcpdump 监听，复制数据包）            │
│    - PF 入站规则匹配（防火墙检查）                         │
│    - VLAN 解封（如有 802.1Q tag）                          │
│    - ether_demux() 根据 EtherType 分类                     │
│    - 调用 netisr_dispatch(NETISR_IP, mbuf)                 │
└────────────────────────────────────────────────────────────┘
```

**依据**: **[文档]** native_drvr.html: `(*ifp->if_input)(ifp, m)` 示例代码

#### 阶段 5: netisr 分发（取决于分发模式）

netisr 支持 4 种分发策略（来自头文件 `netisr.h`）：

| 模式 | 含义 | 行为 |
|-|-|-|
| DEFERRED | 始终延迟 | 数据包排入 netisr 队列，由 netisr 0 线程处理 |
| DIRECT | 始终直接 | 协议处理在调用线程上下文中直接执行 |
| HYBRID | 混合 | 条件允许时直接分发，否则延迟 |
| DEFAULT | 使用全局默认 | 由 sysctl net.isr.dispatch 决定 |

```
情况 A: DIRECT/HYBRID 模式 ← [推测: 可能是默认]
┌──────────────────────────────────────────────────────┐
│ 协议处理直接在当前线程上下文中执行                      │
│ （可能是 emac_rx_if_inp_thre 或 softirq_N）           │
│ → ip_input() → tcp_input() → socket buffer           │
│                                                       │
│ 优点: 无线程切换开销，延迟最低                         │
│ 缺点: 驱动线程被协议处理占用更长时间                   │
└──────────────────────────────────────────────────────┘

情况 B: DEFERRED 模式
┌──────────────────────────────────────────────────────┐
│ mbuf 被放入 netisr 的工作队列                          │
│ [netisr 0] 线程被唤醒（通过 QNX pulse）               │
│ → ip_input() → tcp_input() → socket buffer           │
│                                                       │
│ 优点: 驱动线程快速释放，可处理更多中断                 │
│ 缺点: 额外的线程切换开销                              │
└──────────────────────────────────────────────────────┘
```

#### 阶段 6: 协议栈处理 — `netisr 0`（DEFERRED 模式）或调用线程

```
┌────────────────────────────────────────────────────────────┐
│ ⑩ IP 层处理：                                              │
│    - 检查 IP 头（版本、校验和、TTL）                       │
│    - IP 分片重组（如需要）                                 │
│    - 路由查找（确定是本地递交还是转发）                     │
│    - 如果是 IPSec 包 → 送入 crypto 线程解密               │
│                                                            │
│ ⑪ TCP 层处理：                                             │
│    - TCP 校验和验证                                        │
│    - TCP 状态机处理（SYN/ACK/FIN 等）                      │
│    - 序列号检查、窗口更新                                  │
│    - 将 payload 数据追加到 socket 接收缓冲区 (so_rcv)      │
│                                                            │
│ ⑫ 如果有应用在等待（REPLY-blocked 的 recv()）：           │
│    → 直接 MsgReply(saved_rcvid, data) 唤醒客户端          │
│    如果没有应用在等待：                                    │
│    → 数据留在 socket 缓冲区                               │
└────────────────────────────────────────────────────────────┘
```

**依据**: **[文档]** Architecture: *"passes them to the appropriate multi-threaded IP and upper-layer protocol-processing components (TCP and UDP)"*

#### 阶段 7（条件）: IPSec 加解密 — `crypto_N`

```
┌────────────────────────────────────────────────────────────┐
│ 仅在 IPSec 启用时触发                                       │
│                                                            │
│ ⑬ crypto 主调度线程将解密请求分发到对应 CPU 的 crypto_N    │
│ ⑭ crypto_N 执行实际的 AES/SHA 等解密运算                   │
│ ⑮ crypto returns N 线程执行完成回调                        │
│    → 将解密后的明文数据包送回 netisr 继续协议处理          │
└────────────────────────────────────────────────────────────┘
```

#### 阶段 8: 应用层交付 — `resmgr worker`

```
┌────────────────────────────────────────────────────────────┐
│ 场景 A: 应用已在 recv() 等待 (REPLY-blocked)               │
│    → 阶段 6 中直接 MsgReply 唤醒应用                      │
│                                                            │
│ 场景 B: 应用还没调用 recv()：                              │
│ ⑯ 应用调用 recv(fd, buf, len, 0)                          │
│    → libc 将 recv 翻译为 io_read 消息                     │
│    → MsgSend() 到 io-sock channel                         │
│ ⑰ resmgr worker 被唤醒（LIFO 顶部）                       │
│    → 继承客户端优先级                                      │
│    → 检查 socket buffer → 有数据                          │
│    → MsgReply(rcvid, data) → 数据到达用户 buf             │
└────────────────────────────────────────────────────────────┘
```

**依据**: **[文档]***"Resource manager threads inherit their priority from the client making the request."*

### 4.2 收包路径时序图

```
时间 →
          ┃
  网卡    ┃ DMA写入 ─── 触发IRQ 978
          ┃                │
emac0     ┃                └──→ ████ 中断处理 ████
irq 978   ┃                     (读寄存器,清中断,通知RX线程)
          ┃                          │
emac_rx_  ┃                          └──→ ████████ RX处理 ████████
thread_   ┃                               (DMA同步,读描述符,构建mbuf,
hand      ┃                                重填描述符)
          ┃                                        │
emac_rx_  ┃                                        └──→ ████ if_input ████
if_inp_   ┃                                             (mbuf 交给协议栈)
thre      ┃                                                  │
          ┃                                                  │
softirq_N ┃                                                  └──→ ████ BPF+PF+分发 ████
(或在调用 ┃                                                       (包过滤,VLAN解封,
线程上下文)┃                                                        netisr_dispatch)
          ┃                                                            │
netisr 0  ┃                                                            └──→ ████████████ IP+TCP ████████████
(DEFERRED)┃                                                                 (IP头解析,TCP状态机,
          ┃                                                                  放入socket buffer)
          ┃                                                                       │
resmgr    ┃                                                                       └──→ ████ MsgReply ████
worker    ┃                                                                            (唤醒客户端)
          ┃
用户App   ┃                                                                                 └──→ recv()返回
```

### 4.3 发包（TX）路径

```
用户 App 调用 send()
    │
    ↓
resmgr worker ── 接收 io_write 消息，继承客户端优先级
    │
    ↓
netisr 0 ── TCP 封装（加 TCP 头、计算校验和）→ IP 封装（加 IP 头、路由查找）
    │
    ↓
softirq_N ── PF 出站规则匹配 → BPF 捕获
    │
    ↓
emac_tx_thread_hand ── mbuf → DMA 映射 → 写入 TX 描述符 → 启动硬件发送
    │
    ↓
emac0 irq 978 ── TX 完成中断
    │
    ↓
emac_tx_cleanup_thr ── 回收 TX 描述符和 mbuf
    │
    ↓（如果之前因资源不足暂停了）
tx task ── 重试队列中积压的发送请求
```

## 五、softirq 与 netisr 的关系（深度分析）

### 5.1 本质区别

```
                  softirq_N                          netisr 0
            ┌──────────────────┐              ┌──────────────────┐
本质        │ per-CPU 的通用    │              │ 网络协议专用的   │
            │ grouptask 工作线程│              │ 分发/处理线程    │
            └──────────────────┘              └──────────────────┘
数量        │ 8 个（每CPU一个） │              │ 1个（默认）      │
            │ 始终存在          │              │ 可通过            │
            │                  │              │ netisr_threads调整│
            └──────────────────┘              └──────────────────┘
处理内容    │ 任何排入 softirq  │              │ IP/TCP/UDP/ARP  │
            │ taskqueue group   │              │ 协议处理         │
            │ 的延迟任务        │              │                  │
            └──────────────────┘              └──────────────────┘
触发方式    │ grouptaskqueue_   │              │ netisr_dispatch()│
            │ enqueue() 排入    │              │ 排入协议处理请求 │
            │ → pulse/signal    │              │ → pulse 唤醒     │
            └──────────────────┘              └──────────────────┘
在收包路径  │ 可能执行 ether 层 │              │ 执行 IP/TCP 层   │
中的角色    │ 处理，或在 DIRECT │              │（仅在 DEFERRED   │
            │ 模式下执行完整    │              │  模式下使用）    │
            │ 协议栈            │              │                  │
            └──────────────────┘              └──────────────────┘
```

### 5.2 softirq 在 QNX 中的触发机制

```
┌──────────────────────────────────────────────────────────────┐
│ FreeBSD 内核中（原始机制）                                    │
│                                                              │
│ 硬件中断处理 → swi_sched(swi_net) → 软中断线程被调度执行     │
└──────────────────────────────────────────────────────────────┘
                            ↓ 在 io-sock/QNX 中映射为 ↓
┌──────────────────────────────────────────────────────────────┐
│ io-sock/QNX 适配（实际机制）                                  │
│                                                              │
│ ① 某个线程有延迟工作需要执行                                  │
│    ↓                                                         │
│ ② 调用 grouptaskqueue_enqueue()                              │
│    → 将 grouptask 放入对应 CPU 的 softirq 任务队列           │
│    ↓                                                         │
│ ③ 内部机制发送 QNX pulse 或 condvar signal                   │
│    唤醒该 CPU 的 softirq_N 线程                              │
│    ↓                                                         │
│ ④ softirq_N 从任务队列中取出 grouptask 并执行回调函数        │
└──────────────────────────────────────────────────────────────┘
```

**[头文件证据]**`isr_pulse_prio` 在 `nw_datastruct.h` 中定义，说明 io-sock 使用 QNX pulse 机制通知内部线程。

### 5.3 你的系统中 softirq 和 netisr 的实际角色

由于你的 EMAC 驱动有自己的 RX/TX 线程（不使用 iflib 框架），softirq 线程可能不在主要收包路径上。

实际的主收包路径为：

```
emac0 irq 978 → emac_rx_thread_hand → emac_rx_if_inp_thre → netisr 0（或直接分发）
```

softirq 线程更多地处理：

- io-sock 框架内部的延迟任务
- 协议层的异步操作和定时器回调
- 如果有 iflib 驱动被加载，则直接处理其 RX/TX

### 5.4 潜在性能瓶颈

你只有 1 个 netisr 线程（默认配置）。如果使用 DEFERRED 模式，所有协议处理都串行化到 `netisr 0`，可能成为高吞吐场景的瓶颈。

可以通过以下命令查看和调整：

```bash
# 查看当前 netisr 分发模式
sysctl net.isr.dispatch

# 查看 netisr 统计
sysctl net.isr.proto

# 如需增加 netisr 线程数（在 io-sock 启动时）
io-sock -o netisr_threads=-1 ...   # -1 = 每 CPU 一个
```

## 六、io-sock 可配置的线程优先级参数

| 参数 | 默认值 | 影响的线程 |
|-|-|-|
| `isr_pulse_prio` | 21 | 驱动中断线程 (emac0 irq 978/814) |
| `timer_pulse_prio` | 21 | clock (0) 定时器线程 |
| `taskq_pulse_prio` | 21 | 所有 taskqueue 和 gtaskqueue 线程 |
| `netisr_threads` | 1 | netisr 线程数量（-1 = CPU 数量） |
| （无选项） | — | resmgr worker 线程：继承客户端优先级 |
| （无选项） | — | softirq 线程：[推测] 跟随 isr_pulse_prio 或内部固定 |
