---
title: "io-sock resmgr worker 优先级异常变更分析报告"
date: 2026-09-20
description: "在 QNX 7.1 系统中，io-sock 进程的 resmgr worker 线程出现了优先级异常变更："
categories:
  - 正典阁
tags:
  - QNX
  - io-sock
---

# io-sock resmgr worker 优先级异常变更分析报告

## 1. 问题描述

### 1.1 观察到的现象

在 QNX 7.1 系统中，`io-sock` 进程的 `resmgr worker` 线程出现了优先级异常变更：

- **线程 100**（resmgr worker）由**线程 87**（另一个 resmgr worker，优先级 45）动态创建
- 线程 100 从创建开始一直运行在**优先级 45**
- 经过数十次正常工作流后，线程 100 和另一个 resmgr worker 发生了 **FreeBSD 内部 mutex 争用**
- **在 `SyncMutexUnlock` 调用过程中**，线程 100 的优先级从 **45 降至 30**
- 此后线程 100 的优先级**永久保持在 30**，再也没有恢复

### 1.2 背景条件

- io-sock 使用 `_NTO_CHF_FIXED_PRIORITY` 创建通道，禁用了消息通信时的优先级继承
- io-sock 默认线程优先级为 **21**
- 用户在系统启动初期通过 `SchedSet` 将初始 resmgr worker 线程的优先级从 21 修改为 **45**（仅修改了一次，仅修改了初始线程）
- 动态创建的线程 100 **未被用户直接修改过优先级**

### 1.3 Trace 事件中的关键信息

ThreadCreate 事件显示线程 100 的创建参数：

```
Event 143220: ThreadCreate (64) Enter
Owner: io-sock resmgr worker (线程 87)
  policy:             2 (SCHED_RR)
  sched_priority:     21          ← pthread_attr_t 中的默认值
  sched_curpriority:  21
  stacksize:          0
  flags:              0x1
  guardsize:          4096
```

**关键矛盾**：attr 中 `sched_priority=21`，但线程 100 从第一个状态起就是 45。

---

## 2. 根因分析

### 2.1 线程创建时的优先级继承

**[文档证据]** QNX `pthread_attr_init()` 默认设置 `PTHREAD_INHERIT_SCHED`。

ThreadCreate 事件中 `sched_priority=21` 是 `pthread_attr_t` 结构体的字面值。由于 `PTHREAD_INHERIT_SCHED`，QNX 内核忽略此值，使用父线程 87 的当前优先级 45。

**结论**：线程 100 的 QNX `sched_priority` = 45（继承自父线程 87）。

### 2.2 `_NTO_CHF_FIXED_PRIORITY` 的精确含义

**[文档证据]** 来源：`channelcreate.html`

> `_NTO_CHF_FIXED_PRIORITY` — "Suppress priority inheritance when receiving messages."

此标志**仅禁止消息通信时的优先级继承**，不影响：

- Mutex-based 优先级继承（`PTHREAD_PRIO_INHERIT`）
- FreeBSD 内部的 turnstile 优先级传播
- Server Boost
- 显式的 `SchedSet`/`pthread_setschedparam` 调用

### 2.3 核心问题：FreeBSD 与 QNX 双层优先级管理的不同步

io-sock 内部运行着 FreeBSD 13.0 的网络内核代码，拥有独立的线程优先级管理系统。

#### 2.3.1 FreeBSD 的优先级体系

**[源码证据]**`FreeBSD/freebsd-src/sys/sys/priority.h`

```c
#define PRI_MIN         (0)     /* 最高优先级 */
#define PRI_MAX         (255)   /* 最低优先级 */

#define PRI_MIN_REALTIME  (48)  /* RT线程 48-79 */
#define PRI_MIN_KERN      (80)  /* 内核线程 80-119 */
#define PSOCK             (PRI_MIN_KERN + 24)  /* = 104，网络socket优先级 */
#define PRI_MIN_TIMESHARE (120) /* 分时线程 120-223 */
```

**关键：FreeBSD 数字越小 = 优先级越高（与 QNX 相反）。**

#### 2.3.2 FreeBSD 线程的优先级字段

**[源码证据]**`FreeBSD/freebsd-src/sys/sys/proc.h`（第 322-326 行）

```c
u_char td_base_pri;       /* (t) Thread base kernel priority. */
u_char td_priority;       /* (t) Thread active priority. */
u_char td_pri_class;      /* (t) Scheduling class. */
u_char td_user_pri;       /* (t) User pri from estcpu and nice. */
u_char td_base_user_pri;  /* (t) Base user pri */
```

- `td_base_pri`：FreeBSD 认为的"base priority"，turnstile 恢复的基准
- `td_priority`：FreeBSD 认为的当前实际运行优先级

---

## 3. FreeBSD mutex unlock 时的完整优先级恢复链

以下为基于 `/sandbox/FreeBSD/freebsd-src/` 本地源码的完整调用链分析。

### 3.1 调用链总览

```
mtx_unlock()
  → __mtx_unlock_sleep()        [kern_mutex.c:1002-1060]
    → turnstile_broadcast()      [kern_mutex.c:1052]
    → turnstile_unpend()         [kern_mutex.c:1058]
      → turnstile_calc_unlend_prio_locked()  [subr_turnstile.c:989]
      → sched_unlend_prio()      [subr_turnstile.c:991]
        → sched_prio()           [sched_4bsd.c:888]
          → td->td_base_pri = prio   [sched_4bsd.c:899]
          → sched_priority()     [sched_4bsd.c:910]
            → td->td_priority = prio  [sched_4bsd.c:849]
```

### 3.2 第 1 步：`__mtx_unlock_sleep()` — 争用的 mutex 释放

**[源码证据]**`sys/kern/kern_mutex.c`（第 1042-1059 行）

```c
/* 有争用时的 mutex 释放 */
turnstile_chain_lock(&m->lock_object);
_mtx_release_lock_quick(m);
ts = turnstile_lookup(&m->lock_object);
MPASS(ts != NULL);
turnstile_broadcast(ts, TS_EXCLUSIVE_QUEUE);  // 唤醒所有等待者
turnstile_unpend(ts);                          // ← 调整释放者的优先级
turnstile_chain_unlock(&m->lock_object);
```

**网络协议栈中触发此路径的 mutex 全部是 `MTX_DEF`（sleep mutex）**，包括：

| 锁名 | 定义位置 | 用途 |
|-|-|-|
| `"socket"` | `uipc_socket.c:419` | socket 对象主锁 |
| `"so_snd"` | `uipc_socket.c:420` | 发送缓冲区锁 |
| `"so_rcv"` | `uipc_socket.c:421` | 接收缓冲区锁 |
| `"pcbinfohash"` | `in_pcb.c:524` | PCB 哈希表锁 |
| `"netisr_mtx"` | `netisr.c:1263` | netisr 工作队列锁 |
| `"tcp_sc_head"` | `tcp_syncache.c:284` | TCP syncache bucket 锁 |

### 3.3 第 2 步：`turnstile_unpend()` — 重新评估释放者的优先级

**[源码证据]**`sys/kern/subr_turnstile.c`（第 947-992 行）

```c
void turnstile_unpend(struct turnstile *ts)
{
    // ...
    /*
     * Adjust the priority of curthread based on other contested
     * locks it owns.  Don't lower the priority below the base
     * priority however.
     */
    td = curthread;
    thread_lock(td);
    mtx_lock_spin(&td_contested_lock);
    if (ts->ts_owner != NULL) {
        ts->ts_owner = NULL;
        LIST_REMOVE(ts, ts_link);   // 从争用列表中移除
    }
    pri = turnstile_calc_unlend_prio_locked(td);  // 计算目标优先级
    mtx_unlock_spin(&td_contested_lock);
    sched_unlend_prio(td, pri);   // ← 执行优先级恢复
    thread_unlock(td);
    // ... 唤醒等待线程 ...
}
```

注意源码注释说："Don't lower the priority below the **base priority**"。但这里说的 base priority 是 FreeBSD 内部的 `td_base_pri`，**不是** QNX 的 `sched_priority`。

### 3.4 第 3 步：`turnstile_calc_unlend_prio_locked()` — 计算恢复目标

**[源码证据]**`sys/kern/subr_turnstile.c`（第 924-940 行）

```c
static u_char turnstile_calc_unlend_prio_locked(struct thread *td)
{
    struct turnstile *nts;
    u_char cp, pri;

    pri = PRI_MAX;   // = 255（FreeBSD 最低优先级）
    LIST_FOREACH(nts, &td->td_contested, ts_link) {
        cp = turnstile_first_waiter(nts)->td_priority;
        if (cp < pri)   // FreeBSD: 更小 = 更高优先级
            pri = cp;
    }
    return (pri);
}
```

遍历线程仍持有的所有争用锁。**如果没有其他争用锁，返回 `PRI_MAX = 255`。**

### 3.5 第 4 步：`sched_unlend_prio()` — 核心决策

**[源码证据]**`sys/kern/sched_4bsd.c`（第 876-891 行）

```c
void sched_unlend_prio(struct thread *td, u_char prio)
{
    u_char base_pri;

    if (td->td_base_pri >= PRI_MIN_TIMESHARE &&    // >= 120
        td->td_base_pri <= PRI_MAX_TIMESHARE)       // <= 223
        base_pri = td->td_user_pri;
    else
        base_pri = td->td_base_pri;  // ← RT 线程走这个分支

    if (prio >= base_pri) {           // 255 >= 任何 base_pri → 总成立
        td->td_flags &= ~TDF_BORROWING;
        sched_prio(td, base_pri);     // ← 恢复到 td_base_pri
    } else
        sched_lend_prio(td, prio);
}
```

对于 SCHED_RR（PRI_REALTIME）线程，`base_pri = td->td_base_pri`。当没有其他争用锁时（`prio=255`），条件 `prio >= base_pri` 恒成立，执行 `sched_prio(td, base_pri)`。

### 3.6 第 5 步：`sched_prio()` — 永久性修改

**[源码证据]**`sys/kern/sched_4bsd.c`（第 893-918 行）

```c
void sched_prio(struct thread *td, u_char prio)
{
    /* First, update the base priority. */
    td->td_base_pri = prio;            // ← 更新 base（在此场景下是恢复确认）

    if (td->td_flags & TDF_BORROWING && td->td_priority < prio)
        return;

    /* Change the real priority. */
    oldprio = td->td_priority;
    sched_priority(td, prio);           // ← 修改实际运行优先级
}
```

`sched_priority()` 最终设置 `td->td_priority = prio`，并在 QNX 适配层中映射为对 QNX `sched_priority` 的修改。

---

## 4. `sched_sleep()` 对 RT 线程无影响的确认

**[源码证据]**`sys/kern/sched_4bsd.c`（第 965-976 行）

```c
void sched_sleep(struct thread *td, int pri)
{
    td->td_slptick = ticks;
    td_get_sched(td)->ts_slptime = 0;
    if (pri != 0 && PRI_BASE(td->td_pri_class) == PRI_TIMESHARE)
        sched_prio(td, pri);    // 仅 TIMESHARE 类才修改
    if (TD_IS_SUSPENDED(td) || pri >= PSOCK)
        td->td_flags |= TDF_CANSWAP;
}
```

`sched_sleep()` 仅对 `PRI_TIMESHARE` 类线程调用 `sched_prio()`。resmgr worker 使用 `SCHED_RR`（对应 `PRI_REALTIME`），**不受影响**。

**[排除]** 网络栈中 `sbwait()` → `msleep(... PSOCK ...)` → `sched_sleep()` 不是导致优先级变为 30 的原因。

---

## 5. 能修改 `td_base_pri` 的唯一代码路径

**[源码证据]** 在整个 FreeBSD 调度器代码中，修改 `td_base_pri` 的**唯一语句**在 `sched_prio()` 第 899 行：

```c
td->td_base_pri = prio;
```

调用 `sched_prio()` 的所有路径：

| 调用者 | 条件 | 是否影响 SCHED_RR 线程 |
|-|-|-|
| `sched_sleep()` | 仅 PRI_TIMESHARE | **否** |
| `sched_unlend_prio()` | mutex 释放 | **是** |
| `sched_lend_user_prio()` | 用户优先级借出 | 主要 TIMESHARE |
| `sched_userret_slowpath()` | 返回用户态 | 仅用户进程 |

**结论：对 SCHED_RR 的 resmgr worker 线程，能修改 `td_base_pri` 的唯一代码路径是 `sched_unlend_prio()` → `sched_prio()`。**

---

## 6. 双层优先级管理冲突模型

### 6.1 两套独立的优先级状态

```
┌────────────────────────────────┐  ┌──────────────────────────────┐
│     QNX 内核层                 │  │   FreeBSD 层（io-sock 内部）  │
│                                │  │                              │
│  sched_priority = 45           │  │  td_base_pri = X             │
│  sched_curpriority = 45        │  │  td_priority = ?             │
│                                │  │                              │
│  可被 SchedSet 修改            │  │  不受 QNX SchedSet 影响       │
│  被 _NTO_CHF_FIXED_PRIORITY    │  │  受 sched_prio() 控制        │
│  保护不被消息继承修改           │  │  受 turnstile 机制控制        │
└────────────────────────────────┘  └──────────────────────────────┘
          ↑                                    ↑
          │    两者不同步！                      │
          └────────────────────────────────────┘
```

### 6.2 冲突发生的完整时间线

```
T0: io-sock 启动
    → QNX: resmgr worker 优先级 = 21（默认）
    → FreeBSD: td_base_pri = 初始值（由适配层设置，对应某个 FreeBSD 优先级）

T1: 用户 SchedSet → QNX sched_priority = 45
    → QNX 侧更新成功
    → FreeBSD 侧 td_base_pri 未被更新（SchedSet 无法触达 FreeBSD 内部字段）

T2: 线程 87（已被 SchedSet 改为 45）触发线程池扩展，创建线程 100
    → QNX: PTHREAD_INHERIT_SCHED → 线程 100 继承 45
    → FreeBSD: td_base_pri 由适配层初始化（可能对应 QNX ~30 的值）

T3: 线程 100 正常运行在 QNX 45，数十次工作循环
    → FreeBSD 侧不干预，td_base_pri 未被触及

T4: 两个 resmgr worker 争用 FreeBSD 内部 MTX_DEF mutex
    → turnstile 的 propagate_priority() 设置 TDF_BORROWING
    → sched_lend_prio() 临时调整 td_priority（不改 td_base_pri）

T5: mutex 释放 → __mtx_unlock_sleep()
    → turnstile_broadcast() + turnstile_unpend()
    → turnstile_calc_unlend_prio_locked() 返回 PRI_MAX(255)
    → sched_unlend_prio():
        base_pri = td->td_base_pri（FreeBSD 内部值，≠ QNX 45）
        255 >= base_pri → true
        → sched_prio(td, base_pri)
          → td->td_base_pri = base_pri（确认）
          → sched_priority(td, base_pri)
            → td->td_priority = base_pri
            → QNX 适配层映射：sched_priority = 30  ← !!!

T6: 此后永久保持 30
    → _NTO_CHF_FIXED_PRIORITY 阻止消息继承恢复
    → 没有新的 mutex 争用触发 lending
    → QNX sched_priority 被永久覆盖为 30
```

---

## 7. 网络协议栈中可触发此问题的 mutex 清单

以下 mutex 全部为 `MTX_DEF`（sleep mutex），争用时触发 turnstile 机制。

**[源码证据]** 来自 `/sandbox/FreeBSD/freebsd-src/` 的完整搜索结果：

### 7.1 每个 socket 上的锁（最可能被 resmgr worker 争用）

| 锁名 | 文件 | 初始化方式 |
|-|-|-|
| `"socket"` | `uipc_socket.c:419` | `mtx_init(&so->so_lock, "socket", NULL, MTX_DEF\|MTX_DUPOK)` |
| `"so_snd"` | `uipc_socket.c:420` | `SOCKBUF_LOCK_INIT(&so->so_snd, "so_snd")` → `MTX_DEF` |
| `"so_rcv"` | `uipc_socket.c:421` | `SOCKBUF_LOCK_INIT(&so->so_rcv, "so_rcv")` → `MTX_DEF` |

### 7.2 全局/每 bucket 锁（多线程可能争用）

| 锁名 | 文件 | 类型 |
|-|-|-|
| `"pcbinfohash"` | `in_pcb.c:524` | `MTX_DEF` |
| `"tcp_sc_head"` | `tcp_syncache.c:284` | `MTX_DEF` |
| `"tcp_hc_entry"` | `tcp_hostcache.c:239` | `MTX_DEF` |
| `"netisr_mtx"` | `netisr.c:1263` | `MTX_DEF` |
| `"IP reassembly"` | `ip_reass.c:569` | `MTX_DEF\|MTX_DUPOK` |
| `"mp_ring lock"` | `mp_ring.c:286` | `MTX_DEF` |

---

## 8. 关于优先级恰好是 30 的分析

### 8.1 io-sock 适配层源码不可见

**[事实]**`/sandbox/toolchains_qnx/target/qnx7/usr/include/devs/sys/priority.h` 和 `proc.h` 包含与 FreeBSD 完全一致的优先级定义和 `td_base_pri` 字段，证明 io-sock 内部使用了 FreeBSD 的 turnstile 和调度器代码。但实际的适配层 `.c` 源码（将 FreeBSD `sched_priority()` 映射到 QNX `pthread_setschedparam()` 的代码）是闭源的。

### 8.2 可能的映射

30 这个值可能来源于：

1. **io-sock 内部初始化**时为 resmgr worker 设置的 FreeBSD `td_base_pri` 值经过适配层的逆映射后对应 QNX 30
2. FreeBSD 网络内核中某个特定的优先级常量（如与 `PSOCK=104` 相关的映射）
3. io-sock 启动参数中的默认优先级经过某种变换后的结果

### 8.3 验证方法

1. **对照实验**：不使用 SchedSet，让所有 resmgr worker 保持默认优先级 21，然后触发 mutex 争用，观察优先级是否变化
2. **查看初始状态**：在 SchedSet 之前用 `pidin -p <io-sock-pid> thread` 确认 resmgr worker 的原始优先级
3. **向高通确认**：在 QC case 中询问 FreeBSD `td_base_pri` 与 QNX 优先级的映射关系

---

## 9. 证据来源总结

| 结论 | 来源类型 | 具体来源 |
|-|-|-|
| MTX_DEF mutex 争用使用 turnstile | **源码证据** | `kern_mutex.c:1046-1058` |
| turnstile_unpend 调用 sched_unlend_prio | **源码证据** | `subr_turnstile.c:989-991` |
| sched_unlend_prio 使用 td_base_pri 恢复 | **源码证据** | `sched_4bsd.c:881-888` |
| sched_prio 永久修改 td_base_pri 和 td_priority | **源码证据** | `sched_4bsd.c:898-910` |
| 网络栈所有 socket/PCB mutex 均为 MTX_DEF | **源码证据** | `uipc_socket.c`, `in_pcb.h` 等 |
| sched_sleep 不影响 RT 线程 | **源码证据** | `sched_4bsd.c:972` |
| \_NTO_CHF_FIXED_PRIORITY 仅禁用消息继承 | **文档证据** | `channelcreate.html` |
| QNX SchedSet 不更新 FreeBSD td_base_pri | **推断** | 基于双层架构分析 |
| 优先级 30 来自适配层映射 | **推断** | 适配层源码不可见 |
| 外部修改 io-sock 优先级不安全 | **推断** | 基于完整调用链分析 |

---

## 10. 结论

**io-sock resmgr worker 线程的优先级从 45 降至 30 并永久保持，是由 FreeBSD 内核的 turnstile 优先级恢复机制与 QNX 优先级管理系统不同步导致的。**

具体原因链：

1. 用户通过 QNX `SchedSet` 修改了 resmgr worker 的 QNX 优先级为 45
2. 但 FreeBSD 内部维护的 `td_base_pri` 未被同步更新
3. 当两个 resmgr worker 争用 FreeBSD 内部的 `MTX_DEF` mutex 时，turnstile 机制被触发
4. mutex 释放时，`sched_unlend_prio()` 使用 FreeBSD 的 `td_base_pri`（而非 QNX 的 sched_priority）恢复优先级
5. 这通过适配层永久性地覆盖了 QNX 的线程优先级为 30
6. `_NTO_CHF_FIXED_PRIORITY` 进一步阻止了后续的自动恢复

**这是 QNX 与 FreeBSD 双层优先级管理系统之间的架构性同步缺陷，不是某一方的 bug。从外部修改 io-sock 线程优先级在当前架构下是不安全的。**

---

## 附录 A：FreeBSD 优先级常量参考

```
FreeBSD 优先级范围（数字越小 = 优先级越高）：

  0 ─── 47   中断线程 (PRI_ITHD)
      PI_NET = 8 (网络中断)
      PI_SOFT = 24 (软中断)

 48 ─── 79   实时用户线程 (PRI_REALTIME)

 80 ─── 119  内核顶半部线程 (PRI_KERN)
      PSWP  = 80  (交换)
      PVM   = 84  (虚拟内存)
      PRIBIO = 92  (块I/O)
      PZERO = 100 (默认)
      PSOCK = 104 (socket操作)  ← 网络相关
      PWAIT = 108 (等待)
      PLOCK = 112 (锁等待)

120 ─── 223  分时用户线程 (PRI_TIMESHARE)
      PUSER = 120

224 ─── 255  空闲线程 (PRI_IDLE)
      PRI_MAX = 255
```

## 附录 B：关键源码文件索引

| 文件 | 路径 | 关键内容 |
|-|-|-|
| priority.h | `sys/sys/priority.h` | FreeBSD 优先级常量定义 |
| proc.h | `sys/sys/proc.h` | `td_base_pri` 等字段定义 |
| kern_mutex.c | `sys/kern/kern_mutex.c` | `__mtx_unlock_sleep` 实现 |
| subr_turnstile.c | `sys/kern/subr_turnstile.c` | turnstile 完整实现 |
| sched_4bsd.c | `sys/kern/sched_4bsd.c` | `sched_unlend_prio`/`sched_prio` |
| uipc_socket.c | `sys/kern/uipc_socket.c` | socket/sockbuf mutex 初始化 |
| uipc_sockbuf.c | `sys/kern/uipc_sockbuf.c` | `sbwait()` 使用 PSOCK |
| in_pcb.h | `sys/netinet/in_pcb.h` | PCB 锁定义 |
