---
title: "QNX 7.1 网络延迟排查指南"
date: 2026-09-20
description: "信息来源: QNX 7.1 官方文档（com.qnx.doc.neutrino.io_sock、com.qnx.doc.core_networking、com."
categories:
  - 正典阁
tags:
  - QNX
  - io-sock
---

# QNX 7.1 网络延迟排查指南

> **文档版本**: 1.0  
> **适用系统**: QNX Neutrino 7.1 (SDP 7.1)  
> **信息来源**: QNX 7.1 官方文档（`com.qnx.doc.neutrino.io_sock`、`com.qnx.doc.core_networking`、`com.qnx.doc.neutrino.sys_arch`、`com.qnx.doc.sat`）  
> **创建时间**: 2026-03-12

---

## 目录

1. io-sock 是什么？QNX 7.1 网络底层服务全景
2. 如何统计网络中断？判断中断缺失
3. 网络驱动程序详解：是用户态程序吗？如何找到？
4. 网络延迟排查方法论

---

## 1. io-sock 是什么？QNX 7.1 网络底层服务全景

### 1.1 io-sock 概述

**io-sock** 是 QNX Neutrino 的**网络管理器（Networking Manager）**，是一个运行在**用户空间**的进程。

> 文档原文（io-sock Overview）："The `io-sock` utility is the QNX Neutrino network manager. This is a **process outside of the kernel space** and executes in the **application space**."

io-sock 的核心职责：

| 职责 | 说明 |
|-|-|
| **TCP/IP 协议栈** | 内置 TCP、UDP、IPv4、IPv6 协议处理 |
| **资源管理器** | 在 `/dev/socket` 注册资源管理器，应用通过 QNX 消息传递 IPC 与协议栈通信 |
| **网络驱动宿主** | 加载和管理网络硬件驱动（`devs-*.so` 共享库） |
| **包过滤** | 内置 BPF（Berkeley Packet Filter）和 PF（Packet Filter）支持 |
| **加密/WiFi** | 内置 IPSec 加密和 WiFi 802.11 支持 |

**io-sock 启动后创建的资源路径**：

```
/dev/socket    — 应用程序通过此路径进行 socket 通信
/dev/io-sock   — 驱动管理路径
/dev/pf        — 包过滤接口
/dev/bpf       — Berkeley Packet Filter 接口
```

### 1.2 io-sock 的架构层次

```
┌──────────────────────────────────────────────────────────┐
│                   用户应用程序                              │
│          (使用 BSD socket API: socket/bind/send/recv)      │
│          应用通过 socket 库 → 转化为 QNX 消息 → 发给 io-sock │
└──────────────┬───────────────────────────────────────────┘
               │ QNX 消息传递 IPC (MsgSend → /dev/socket)
┌──────────────▼───────────────────────────────────────────┐
│                    io-sock 进程（用户态）                    │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  资源管理器层 (Resource Manager)                      │  │
│  │  • 接收来自应用的 open/read/write/ioctl 消息          │  │
│  │  • 线程优先级继承自客户端                              │  │
│  └────────────────────┬────────────────────────────────┘  │
│  ┌────────────────────▼────────────────────────────────┐  │
│  │  TCP/IP 协议栈 (基于 FreeBSD 网络栈代码)              │  │
│  │  • TCP、UDP、IPv4、IPv6、ICMP                        │  │
│  │  • IPSec、PF 包过滤                                  │  │
│  │  • 多线程包处理                                       │  │
│  └────────────────────┬────────────────────────────────┘  │
│  ┌────────────────────▼────────────────────────────────┐  │
│  │  网络驱动层 (动态加载 devs-*.so)                      │  │
│  │  • devs-em.so (Intel E1000)                          │  │
│  │  • devs-ffec.so (NXP i.MX FEC)                       │  │
│  │  • devs-dwceqos.so (Synopsys DesignWare)             │  │
│  │  • devs-re.so (Realtek)                              │  │
│  │  • 每个驱动创建 1~N 个线程处理中断和收发包             │  │
│  └────────────────────┬────────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────┘
                        │ 硬件中断 + DMA
┌───────────────────────▼──────────────────────────────────┐
│                    网络硬件 (NIC)                          │
└──────────────────────────────────────────────────────────┘
```

> 文档原文（Architecture of io-sock）："At the bottom layer are drivers that provide the mechanism for passing data to, and receiving data from, the hardware. The drivers hook into a **multi-threaded packet-processing layer** that passes them to the appropriate multi-threaded IP and upper-layer protocol-processing components (TCP and UDP)."

### 1.3 io-sock 的线程模型

> 文档原文（Threading model and priorities）："The default mode of operation for `io-sock` is to start with multiple threads for: the stack, each CPU, resource managers on each CPU. In addition, each driver creates one or several threads per CPU."

| 线程类型 | 数量 | 默认优先级 | 说明 |
|-|-|-|-|
| **协议栈线程** | 每 CPU 一个 | 21 | 处理 TCP/UDP/IP 协议 |
| **驱动中断线程** | 每驱动每 CPU 1\~N 个 | 21（可配置） | 处理网卡硬件中断、收发包 |
| **资源管理器线程** | 动态创建（最多 700） | **继承客户端优先级** | 处理应用的 socket 请求 |

> 文档原文："By default, the priority of these threads is 21."  
> "Resource manager threads **inherit their priority from the client** making the request."

**关键限制**：

- 资源管理器线程上限：700
- 总线程上限：1000
- 超出上限会阻塞

### 1.4 QNX 7.1 中除 io-sock 外的网络相关底层服务

QNX 7.1 同时保留了**旧版网络栈 io-pkt** 和**新版 io-sock**。

| 服务 | 进程名 | 说明 |
|-|-|-|
| **io-sock** | `io-sock` | 新版高性能网络栈（推荐） |
| **io-pkt** | `io-pkt-v4-hc` / `io-pkt-v6-hc` | 旧版网络栈（仍在 7.1 中可用，8.0 已移除） |
| **pci-server** | `pci-server` | PCI 总线服务，网卡 PCI 设备发现依赖此服务 |
| **io-usb-otg** | `io-usb-otg` | USB 总线服务，USB 网卡依赖此服务 |
| **dhclient** | `dhclient` | DHCP 客户端，自动获取 IP 地址 |
| **wpa_supplicant** | `wpa_supplicant` | WiFi WPA 认证管理 |
| **slogger2** | `slogger2` | 日志服务，io-sock 的诊断信息输出到 slogger2 |
| **Qnet (lsm-qnet)** | 加载到 io-pkt | 透明分布式网络（仅 io-pkt 支持） |

**io-pkt 与 io-sock 的关键区别**：

| 特性 | io-pkt | io-sock |
|-|-|-|
| 驱动前缀 | `devnp-*.so` | `devs-*.so` |
| 代码基础 | NetBSD | FreeBSD |
| 协议栈并发 | 单线程获取"stack context" | 多线程协议处理 |
| Qnet 支持 | 支持 | 不支持 |
| QNX 8.0 | 已移除 | 唯一网络栈 |

> 文档原文（io-pkt Threading model）："Only one thread may acquire the 'stack context' for upper-layer packet processing."  
> io-sock 则是多线程协议处理，性能更高。

---

## 2. 如何统计网络中断？判断中断缺失

### 2.1 网络中断在 QNX 中的机制

在 QNX 微内核架构下，网络中断的处理流程为：

```
网卡硬件产生中断 (IRQ)
    │
    ▼
QNX 内核 (procnto)
    │ 内核分发中断
    ▼
io-sock 中的驱动中断线程被唤醒
    │ 驱动线程处理收包/发包完成
    ▼
数据进入 io-sock 协议栈处理
```

**重要**：在 io-sock 中，中断处理器**不在内核上下文运行**。

> 文档原文（Writing Network Drivers for io-sock - Registering interrupts）："The interrupt handler **does not run in the kernel interrupt context**. Instead, a **dedicated thread** is created to handle the interrupt handling."

这意味着网络中断的响应速度取决于**驱动中断线程的调度**。

### 2.2 查看网络中断统计的方法

#### 方法 1: 使用 `netstat -in` 查看接口统计

```bash
netstat -in
```

输出示例：

```
Name    Mtu   Network     Address         Ipkts Ierrs Opkts Oerrs Coll
em0     1500  10.0.0      10.0.0.100      12345 0     6789  0     0
lo0     16384 127         127.0.0.1       100   0     100   0     0
```

关键指标：

- `Ipkts`: 接收包计数 — 如果在问题时段内不增长，说明没有收到包
- `Ierrs`: 接收错误计数
- `Opkts`: 发送包计数
- `Oerrs`: 发送错误计数

#### 方法 2: 使用 `sysctl` 查看详细网络统计

```bash
# 查看所有网络统计
sysctl net.inet

# 查看 TCP 统计
sysctl net.inet.tcp.stats

# 查看 UDP 统计
sysctl net.inet.udp.stats

# 查看接口统计
sysctl net.link
```

#### 方法 3: 使用 SAT (tracelogger) 追踪中断事件

这是**最精确的方法**，可以看到每一个中断的时间戳。

```bash
# 启动 tracelogger，过滤中断事件
tracelogger -r -b 128 -F intenter,intexit,thread

# 在另一个终端触发网络活动，然后按 Ctrl+C 停止

# 用 traceprinter 分析
traceprinter -f /dev/shmem/tracebuffer | grep -i "int"
```

trace 中可以看到的中断相关事件：

- `INT_DELIVER` — 硬件中断到达内核
- `INT_HANDLER_ENTER` — 中断处理开始
- `INT_HANDLER_EXIT` — 中断处理结束
- 线程状态变化 — io-sock 中断线程从阻塞变为 RUNNING

#### 方法 4: 使用 `pidin` 查看 io-sock 线程状态

```bash
# 查看 io-sock 进程的所有线程
pidin -p io-sock threads

# 查看 io-sock 线程的详细信息（优先级、状态、CPU）
pidin -p io-sock -f abBdehHjJlmnNpqsST
```

这可以帮你判断 io-sock 的中断线程是否处于阻塞状态。

#### 方法 5: 使用 `vmstat` 查看内存/包缓冲区统计

```bash
# io-sock 自带的 vmstat 工具
vmstat
```

### 2.3 判断中断缺失的检查清单

| 检查项 | 命令 | 判断标准 |
|-|-|-|
| 接口是否 UP | `ifconfig em0` | flags 中应有 `UP,RUNNING` |
| 接口计数是否增长 | `netstat -in`（间隔对比） | `Ipkts` 不增长 → 没收到包 |
| 物理链路状态 | `ifconfig em0` | `status: active` 为正常 |
| trace 中是否有网卡中断 | tracelogger 抓取 | 无 INT 事件 → 中断未触发 |
| io-sock 线程是否阻塞 | `pidin -p io-sock threads` | 中断线程长期 RECEIVE/CONDVAR → 调度问题 |

---

## 3. 网络驱动程序详解

### 3.1 网络驱动是用户态程序吗？

**是的。** QNX 是微内核 RTOS，网络驱动**运行在用户空间**，作为**共享库（.so）**被 io-sock 进程加载。

> 文档原文（Overview）："This is a process outside of the kernel space and executes in the application space."

驱动不是独立进程，而是以 DLL 形式加载到 io-sock 进程内：

| 网络栈 | 驱动命名规则 | 驱动类型 |
|-|-|-|
| io-sock | `devs-*.so` | 共享库，加载到 io-sock 进程空间 |
| io-pkt | `devnp-*.so` | 共享库，加载到 io-pkt 进程空间 |

### 3.2 QNX 7.1 自带的网络驱动

QNX 7.1 的 io-sock 自带以下驱动（文档来源：io-sock Utilities and Driver Reference）：

| 驱动文件 | 支持硬件 |
|-|-|
| `devs-em.so` | Intel PRO/1000 Gigabit Ethernet (82540, 82545, 82546, I210, I211, I217, I218, I219...) |
| `devs-re.so` | Realtek 8139C+/8169/8168/8111 Gigabit Ethernet |
| `devs-ixgbe.so` | Intel 10 Gigabit Ethernet (82598, 82599, X540, X550...) |
| `devs-ffec.so` | NXP/Freescale i.MX Fast Ethernet Controller |
| `devs-dwc.so` | Synopsys DesignWare MAC (DWC GMAC) |
| `devs-dwceqos.so` | Synopsys DesignWare EQoS (DWC EQoS GMAC) |
| `devs-genet.so` | Broadcom GENETv5 Ethernet |
| `devs-axe.so` | ASIX Electronics USB Ethernet (AX88178A, AX88772B...) |
| `devs-axge.so` | ASIX Electronics USB 3.0 Ethernet (AX88179...) |
| `devs-cdce.so` | USB Communication Device Class Ethernet |
| `devs-smsc.so` | Microchip/SMSC LAN9500/LAN9514 USB Ethernet |
| `devs-urndis.so` | USB RNDIS (Remote NDIS) Ethernet |
| `devs-vmx.so` | VMware vmxnet3 虚拟网卡 |
| `devs-phy.so` | 通用 PHY 驱动 |
| `devs-libpci.so` | PCI 总线支持库 |
| `devs-libfdt.so` | 设备树（FDT/DTB）解析库 |
| `devs-libusbdci.so` | USB 设备控制接口库 |

### 3.3 自定义网络驱动

如果硬件不在上述列表中，需要自定义驱动。自定义驱动也是 `devs-*.so` 共享库。

> 文档原文（Writing Network Drivers for io-sock）："Drivers for `io-sock` are written using the **same driver APIs as FreeBSD drivers**. This common API allows you to compile FreeBSD driver source code for `io-sock` with few to no code changes."

自定义驱动的关键组件：

```c
// 驱动注册结构
static device_method_t sample_methods[] = {
    DEVMETHOD(device_probe,    sample_probe),     // 检测硬件
    DEVMETHOD(device_attach,   sample_attach),    // 初始化硬件
    DEVMETHOD(device_detach,   sample_detach),    // 卸载
    DEVMETHOD(device_shutdown, sample_shutdown),   // 关闭 DMA
    // MII (PHY) 接口
    DEVMETHOD(miibus_readreg,  sample_miibus_read_reg),
    DEVMETHOD(miibus_writereg, sample_miibus_write_reg),
    DEVMETHOD(miibus_statchg,  sample_miibus_statchg),
    DEVMETHOD_END
};

// 中断注册 — 创建专用中断处理线程
bus_setup_intr(dev, sc->res[1], INTR_TYPE_NET | INTR_MPSAFE,
    NULL, sample_intr, sc, &sc->intr_cookie);
```

### 3.4 如何在系统中找到当前使用的网络驱动

#### 方法 1: 查看已加载的驱动

```bash
# 列出 io-sock 加载的驱动
ls /dev/io-sock/

# 输出示例：
# devs-em.so  devs-libpci.so  devs-phy.so

# 查看驱动下的设备
find /dev/io-sock/

# 输出示例：
# /dev/io-sock/
# /dev/io-sock/devs-em.so
# /dev/io-sock/devs-em.so/em0
# /dev/io-sock/devs-em.so/em1
```

#### 方法 2: 查看设备详细信息

```bash
# 查看单个设备
cat /dev/io-sock/devs-em.so/em0
# 输出: device=em0,interface=em0,options=""

# 查看所有设备
cat /dev/io-sock/*/*

# 使用 devinfo 查看更详细的信息（包含 PCI BDF 地址）
devinfo -v
```

#### 方法 3: 查看 io-sock 启动命令

```bash
# 查看 io-sock 进程的启动参数
pidin -p io-sock args

# 或者查看 /proc
cat /proc/$(pidin -p io-sock -f p | tail -1)/cmdline
```

#### 方法 4: 查看系统中的驱动文件

```bash
# io-sock 驱动存放路径
ls /lib/dll/devs-*.so
ls /proc/boot/devs-*.so

# io-pkt 驱动存放路径
ls /lib/dll/devnp-*.so
ls /proc/boot/devnp-*.so
```

#### 方法 5: 使用 sysctl 查看驱动版本

```bash
sysctl qnx.driver
# 输出示例：
# qnx.driver.libusbdci: 1
# qnx.driver.libpci: 1
# qnx.driver.phy: 1
```

#### 方法 6: 查看接口信息

```bash
# ifconfig 显示接口名称，从名称可以推断驱动
ifconfig
# em0  → devs-em.so (Intel E1000)
# re0  → devs-re.so (Realtek)
# ffec0 → devs-ffec.so (NXP FEC)
```

---

## 4. 网络延迟排查方法论

### 4.1 排查流程总览

```
Step 1: 确认物理层 ──► 链路是否正常？
    │
    ▼
Step 2: 确认中断层 ──► 网卡中断是否在触发？
    │
    ▼
Step 3: 确认驱动层 ──► io-sock 驱动线程是否被调度？
    │
    ▼
Step 4: 确认协议栈层 ──► TCP/UDP 处理是否有延迟？
    │
    ▼
Step 5: 确认应用层 ──► 应用线程是否及时读取数据？
    │
    ▼
Step 6: 确认系统层 ──► 是否有高优先级任务抢占？
```

### 4.2 Step 1: 物理层检查

```bash
# 检查接口状态
ifconfig em0

# 关注：
# - flags 中是否有 UP, RUNNING
# - status: active (正常) vs no carrier (链路断开)
# - 是否有 Ierrs, Oerrs 增长

# 检查链路协商状态
ifconfig em0 media
```

**判断标准**：

- `status: no carrier` → 物理链路问题（网线/光模块/对端设备）
- `Ierrs` 持续增长 → 可能是 CRC 错误、帧长度错误等硬件层问题

### 4.3 Step 2: 中断层检查

这是**判断"网络中断是否缺失"的核心步骤**。

#### 方法 A: 通过 SAT trace 查看中断

```bash
# 1. 启动 tracelogger（ring 模式，128 个 buffer）
tracelogger -r -b 128

# 2. 等待问题发生（或复现问题）

# 3. 按 Ctrl+C 停止 tracelogger

# 4. 用 traceprinter 分析中断事件
traceprinter -f /dev/shmem/tracebuffer > /tmp/trace.txt

# 5. 搜索中断事件
grep "INT" /tmp/trace.txt | head -50

# 6. 查看网卡中断的 IRQ 号
# 先确认 IRQ 号：
cat /proc/$(pidin -p io-sock -f p | tail -1)/irqs
```

trace 中应该看到类似：

```
t:0x1234 CPU:0 INT_DELIVER:irq_num
t:0x1235 CPU:0 INT_HANDLER_ENTER:...
t:0x1236 CPU:0 INT_HANDLER_EXIT:...
```

**判断标准**：

- 延迟时段内无网卡 IRQ 的 INT_DELIVER → 中断未触发（硬件问题或中断路由问题）
- 有 INT_DELIVER 但无 INT_HANDLER → 中断注册问题
- 有中断但线程未变 RUNNING → 调度延迟问题

#### 方法 B: 通过包计数对比

```bash
# 每秒记录一次 Ipkts
while true; do
    date +%H:%M:%S
    netstat -in | grep em0
    sleep 1
done
```

如果 `Ipkts` 在延迟时段内完全不增长，说明驱动层没有收到任何包。

### 4.4 Step 3: 驱动调度检查

即使中断触发了，驱动的中断线程也可能因为**调度延迟**而不能及时处理。

```bash
# 查看 io-sock 所有线程的状态和优先级
pidin -p io-sock -f abeEhHjJlmNpqrRsST

# 查看是否有线程长期处于 READY 状态（说明有 CPU 但被更高优先级任务抢占）
pidin -p io-sock threads
```

**关键检查**：

- io-sock 驱动线程默认优先级 21，如果系统有大量优先级 > 21 的任务，会导致网络处理延迟
- 使用 `pidin tl` 查看全系统线程列表，按优先级排序

```bash
# 查看当前系统中高优先级的线程
pidin tl | sort -k4 -n -r | head -20
```

#### 在 trace 中确认调度延迟

在 SAT trace 中，可以看到线程状态变化的精确时间戳：

```
t:0x1000  THREAD(io-sock:tid3) → READY        ← 线程被唤醒（中断来了）
t:0x5000  THREAD(io-sock:tid3) → RUNNING      ← 线程获得 CPU
                                 ↑
                          这个间隔就是调度延迟
                          0x5000 - 0x1000 = 调度延迟时间
```

### 4.5 Step 4: 协议栈层检查

```bash
# 查看 TCP 重传统计
sysctl net.inet.tcp.stats

# 关注指标：
# - tcps_sndrexmitpack: TCP 重传包数
# - tcps_rcvduppack:    TCP 重复包数
# - tcps_rcvoopack:     TCP 乱序包数

# 查看 socket 缓冲区状态
netstat -an

# 查看 Recv-Q 和 Send-Q
# Recv-Q 很大 → 应用没有及时读取
# Send-Q 很大 → 数据发不出去
```

### 4.6 Step 5: 应用层检查

```bash
# 查看应用进程的线程状态
pidin -p <app_name> threads

# 如果应用线程处于以下状态，可能是读取延迟的原因：
# - MUTEX: 被锁阻塞
# - CONDVAR: 等待条件变量
# - SEND: 在等待某个服务器回复
```

### 4.7 Step 6: 系统级检查

```bash
# 查看 CPU 使用率
pidin times

# 查看是否有 CPU 空闲
hogs -i 1

# 查看是否有优先级反转
# 在 trace 中查看 io-sock 线程 READY → RUNNING 的延迟

# 查看内存压力
pidin mem
```

### 4.8 排查决策树

```
网络延迟发生
│
├─ ifconfig 显示 status: no carrier？
│   └─ YES → 【物理层问题】检查网线/光模块/对端设备
│
├─ netstat -in 中 Ipkts 不增长？
│   ├─ YES → trace 中有网卡 IRQ 的 INT_DELIVER？
│   │   ├─ NO  → 【中断未触发】检查：
│   │   │         1. 硬件是否故障
│   │   │         2. 中断路由是否正确 (DTB/startup 配置)
│   │   │         3. 对端是否在发送
│   │   │
│   │   └─ YES → io-sock 驱动线程是否被调度？
│   │       ├─ 线程长期 READY → 【调度延迟】
│   │       │   提高 io-sock 线程优先级:
│   │       │   io-sock -o if_prio=<更高优先级>
│   │       │
│   │       └─ 线程 RUNNING 但包计数不增长 →
│   │           【驱动 bug 或 DMA 问题】
│   │
│   └─ NO (Ipkts 增长正常) → 问题不在接收层，检查发送
│
├─ Opkts 不增长？
│   └─ YES → 检查发送路径（TCP 重传？路由表？ARP？）
│
├─ 收发包都正常但应用感知到延迟？
│   └─ YES → 【应用层/协议栈层问题】
│       1. 检查 netstat Recv-Q 是否堆积
│       2. 检查应用线程状态
│       3. 检查 TCP 窗口/Nagle 算法配置
│
└─ 间歇性延迟？
    └─ YES → 【调度竞争问题】
        1. 用 trace 抓取延迟时段
        2. 分析 io-sock 线程 READY→RUNNING 间隔
        3. 查看是否有高优先级任务持续占用 CPU
```

### 4.9 常用诊断命令速查表

| 目的 | 命令 |
|-|-|
| 查看网络接口状态 | `ifconfig` |
| 查看网络接口统计 | `netstat -in` |
| 查看 socket 连接状态 | `netstat -an` |
| 查看 TCP/UDP 详细统计 | `sysctl net.inet.tcp.stats` |
| 查看已加载的驱动 | `ls /dev/io-sock/` |
| 查看驱动设备信息 | `devinfo -v` |
| 查看 io-sock 线程状态 | `pidin -p io-sock threads` |
| 查看 io-sock 启动参数 | `pidin -p io-sock args` |
| 抓包分析 | `tcpdump -i em0 -w /tmp/cap.pcap` |
| 抓取 trace | `tracelogger -r -b 128` |
| 分析 trace | `traceprinter -f /dev/shmem/tracebuffer` |
| 查看 CPU 使用情况 | `pidin times` 或 `hogs` |
| 查看全系统线程优先级 | `pidin tl` |
| 查看进程中断注册 | `cat /proc/<pid>/irqs` |
| 检查 sysctl 参数 | `sysctl -a` |

### 4.10 调优建议

#### 提高网络中断线程优先级

```bash
# 启动 io-sock 时指定较高的中断线程优先级
io-sock -o if_prio=50 -d em
```

#### 绑定网络中断线程到特定 CPU

如果系统有多核，可以考虑将网络相关线程绑定到特定核心，避免与应用竞争。

#### 增大缓冲区

```bash
# 增大 socket 缓冲区
sysctl net.inet.tcp.recvspace=262144
sysctl net.inet.tcp.sendspace=262144
```

#### 使用诊断版 io-sock

```bash
# io-sock-diag 提供额外的运行时检查
io-sock-diag -d em
```

> 文档原文（Running io-sock with diagnostic features）："The diagnostic versions add extra checks that are useful when you are developing networking drivers."

---

## 附录：信息来源

| 编号 | 文档 | 路径 |
|-|-|-|
| [1] | io-sock Overview | `com.qnx.doc.neutrino.io_sock` → topic/overview.html |
| [2] | Architecture of io-sock | `com.qnx.doc.neutrino.io_sock` → topic/overview_Architecture_iosock.html |
| [3] | Threading model and priorities | `com.qnx.doc.neutrino.io_sock` → topic/overview_Threading.html |
| [4] | Starting io-sock and Driver Management | `com.qnx.doc.neutrino.io_sock` → topic/start_io-sock.html |
| [5] | Writing Network Drivers for io-sock | `com.qnx.doc.neutrino.io_sock` → topic/native_drvr.html |
| [6] | Running io-sock with diagnostic features | `com.qnx.doc.neutrino.io_sock` → topic/diagnostic.html |
| [7] | Architecture of io-pkt | `com.qnx.doc.core_networking` → topic/overview_Architecture.html |
| [8] | io-pkt Threading model | `com.qnx.doc.core_networking` → topic/overview_Threading.html |
| [9] | Network Drivers (io-pkt) | `com.qnx.doc.core_networking` → topic/drivers.html |
| [10] | SAT User's Guide | `com.qnx.doc.sat` → 多个 topic |
| [11] | QNX System Architecture | `com.qnx.doc.neutrino.sys_arch` → topic/kernel_INTERRUPTHANDLING.html |

> **注意**：部分排查命令和调优参数的具体效果取决于实际硬件平台和 QNX BSP 配置。文档中标注"推理"的部分是基于 QNX 架构原理推导，非文档直接来源。
