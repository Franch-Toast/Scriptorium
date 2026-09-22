---
title: "移除 -mL (superlocking) 标志对系统的影响分析"
date: 2026-09-20
description: "基于 QNX 7.1 官方文档（System Architecture + Utilities Reference）的系统性分析。"
categories:
  - 正典阁
tags:
  - QNX
---

# 移除 -mL (superlocking) 标志对系统的影响分析

> 基于 QNX 7.1 官方文档（System Architecture + Utilities Reference）的系统性分析。

## 一、`-mL` 在当前系统中做了什么

根据 QNX 7.1 文档，`-mL` 是 `procnto` 的 `-m` 选项的子标志，其效果是：

```Plain
  <dd class="dd">Lock and superlock (<span class="keyword option">L</span>) or don't lock and superlock (<span class="keyword option">~L</span>) all memory.
    Locking and superlocking all memory acts as if
    <samp class="ph codeph">ThreadCtl(_NTO_TCTL_IO,0)</samp> were specified at the start of
    every program (but only insofar as locking the memory;
    programs don't actually get I/O privileges).
    ...
    The default is not to lock and superlock all memory (<span class="keyword option">~L</span>).
```

即：**全局强制所有进程进入 Superlocked 状态**，等价于每个进程启动时自动执行了 `ThreadCtl(_NTO_TCTL_IO, 0)`（仅内存锁定部分，不包含 I/O 权限）。

QNX 内存有三种锁定级别，`-mL` 使系统处于最高级别：

```Plain
The levels of locking are as follows:

<dl class="dl">

<dt class="dt dlterm">Unlocked</dt>

<dd class="dd">Unlocked memory can be paged in and out.
  Memory is allocated when it's mapped, but page table entries aren't created.
  The first attempt to access the memory fails, and the thread stays in the
  WAITPAGE state while the memory manager initializes the memory and creates
  the page table entries.
  ...
  Failure to initialize the page results in the receipt of a
  <span class="keyword const">SIGBUS</span> signal.
</dd>


<dt class="dt dlterm">Locked</dt>

<dd class="dd">Locked memory may not be paged in or out.
  Page faults can still occur on access or reference, to maintain
  usage and modification statistics.
  Pages that you think are <span class="keyword const">PROT_WRITE</span> are still actually
  <span class="keyword const">PROT_READ</span>.
  This is so that, on the first write, the kernel may be alerted that a
  <span class="keyword const">MAP_PRIVATE</span> page now is different from the shared backing
  store, and must be privatized.
</dd>


<dt class="dt dlterm">Superlocked</dt>

<dd class="dd">(A <span class="keyword">QNX Neutrino</span> extension)
  No faulting is allowed at all; all memory must be initialized and
  privatized, and the permissions set, as soon as the memory is mapped.
  Superlocking covers the process's whole address space.
```

| 级别 | 缺页是否允许 | 内存分配时机 | 写时复制私有化 |
|-|-|-|-|
| Unlocked（默认） | 允许 | 首次访问时缺页分配 | 首次写入时缺页私有化 |
| Locked | 不允许换出，但允许缺页 | 同上 | 首次写入时缺页私有化 |
| Superlocked（`-mL`） | **完全禁止** | 映射时立即全量分配+私有化 | 映射时立即完成 |

---

## 二、移除 `-mL` 后发生的变化

移除 `-mL` 后，系统恢复到默认的 **Unlocked** 状态，QNX 的默认行为是"按需调页"（demand paging）：

```Plain
<p class="p">
The default behavior is faulting and paging on demand;
faults can occur in various situations corresponding to the numbers in the above diagram:
</p>


<ol class="ol">
<li class="li">The first time you access a region created with <span class="keyword apiname">mmap()</span>, a fault occurs,
  and the memory manager associates the map with a virtual page and a physical page.
</li>
```

### 2.1 核心变化：缺页中断恢复

| 变化项 | `-mL` 开启时 | 移除 `-mL` 后 |
|-|-|-|
| 首次访问内存 | 立即完成（已预分配） | 触发缺页中断 → 线程进入 `STATE_WAITPAGE` → 内核分配物理页并清零 → 恢复执行 |
| 线程状态 | 不会进入 WAITPAGE | 首次访问时**会进入 WAITPAGE** |
| 物理内存分配 | `mmap` 时立即全量分配 | 延迟到首次访问，按页分配 |
| `MAP_LAZY` | 失效（被迫全量分配） | **恢复生效**：不预留，不分配，首次访问时缺页 |
| `POSIX_MADV_DISCARD_NP` | 失效（不能释放） | 恢复生效：可丢弃 MAP_LAZY 区域的物理页 |
| 写时复制（COW） | `fork` 时立即私有化 | `fork` 后首次写入时缺页私有化 |

### 2.2 `STATE_WAITPAGE` 是什么

```Plain
<dt class="dt dlterm"><span class="keyword const">STATE_WAITPAGE</span></dt>

<dd class="dd">The thread is waiting for physical memory to be
  allocated for a virtual address.
</dd>
```

移除 `-mL` 后，线程在首次访问内存页时会短暂进入 `STATE_WAITPAGE` 状态，等待内核分配物理内存并清零。这是**正常行为**，是 QNX 默认运行方式。

---

## 三、潜在副作用与风险

### 3.1 实时性影响（最主要风险）

| 风险项 | 详细说明 | 严重程度 |
|-|-|-|
| **缺页延迟不可预测** | 每次首次访问新页面都会触发缺页中断，时长取决于内核内存管理器状态（查找空闲物理页、清零、建立页表映射） | 🔴 **高** |
| **WAITPAGE 阻塞** | 高优先级线程可能在 WAITPAGE 状态等待，而低优先级线程持有内存管理器锁，造成优先级反转 | 🔴 **高** |
| **实时周期抖动** | 原本 `-mL` 下内存访问是确定性的（无缺页），移除后每次内存分配-使用-释放周期都可能引入随机缺页延迟 | 🔴 **高** |

### 3.2 ISR / 关中断区域的风险

QNX 文档明确警告：

```Plain
<p class="p">

For <span class="keyword const">MAP_LAZY</span> mappings, memory isn't allocated or mapped
until the memory is first referenced for any of the above types.
Once it's been referenced, it obeys the above rules—it's a
programmer error to touch a <span class="keyword const">MAP_LAZY</span>
area in a critical region (where interrupts are disabled or in an ISR)
that hasn't already been referenced.
</p>
```

**关键**：如果在 ISR 或关中断临界区中访问了尚未被触碰过的 `MAP_LAZY` 内存，会触发缺页中断，而缺页处理需要内核参与（可能涉及调度），在关中断/ISR 上下文中这是**严重错误**，可能导致系统崩溃。

**缓解措施**：移除 `-mL` 后，所有使用 `MAP_LAZY` 的内存区域必须在进入 ISR 或关中断临界区**之前**预先触碰（pre-touch），例如通过 `memset` 触发缺页分配。

### 3.3 SIGBUS 风险

```Plain
<p class="p">
The fact that memory is lazily backed (that is, reserved and then backed when it's needed) can cause some
confusion about the <span class="keyword const">MAP_LAZY</span> flag for <span class="keyword apiname">mmap()</span>.
If you set this flag, then the memory isn't even reserved; a fault then causes a <span class="keyword const">SIGBUS</span>.
</p>
```

| 风险项 | 详细说明 | 严重程度 |
|-|-|-|
| **`MAP_LAZY` + 内存耗尽** | 若使用 `MAP_LAZY` 且首次访问时物理内存不足，进程收到 `SIGBUS` 并终止（默认行为是 kill + dump） | 🟡 **中**（测试环境内存充足时可规避） |
| **`SIGBUS` 不可恢复** | `SIGBUS` 是同步信号，默认终止进程。即使捕获，从 SIGBUS 处理函数返回后指令会重新执行并再次触发 SIGBUS，形成死循环 | 🟡 **中** |

### 3.4 栈内存的缺页

```Plain
  <p class="p">
  Assuming that you haven't explicitly allocated a lazy stack,
  specifying <span class="keyword option">-n</span> guarantees that page faults on stacks won't result in a <span class="keyword const">SIGBUS</span>
  if the system runs out of memory.
  When combined with <span class="keyword option">-mL</span> (superlocking), this option ensures that stack memory is prefaulted
  to the maximum size, which means that there shouldn't be any page faults for (legitimate) access to stack memory.
  </p>
```

| 风险项 | 详细说明 | 严重程度 |
|-|-|-|
| **栈增长触发缺页** | 移除 `-mL` 后，线程栈不再预分配物理内存，栈增长时（函数调用、局部变量分配）会触发缺页中断 | 🟡 **中** |
| **与 `-n` 选项的交互** | 若当前配置同时启用了 `-n`（nonlazy stack），栈内存仍会预留，但不再预分配物理页，需结合测试 | 🟢 **低** |

### 3.5 全局页面置换

```Plain
<li class="li">a global page replacement algorithm to select pages to discard under memory pressure.
  If swap storage is implemented, this allows all non-wired pages to be potential candidates for replacement; the previous memmgr only allowed replacing pages with file system backing storage.
</li>
```

| 风险项 | 详细说明 | 严重程度 |
|-|-|-|
| **非 wired 页面可被回收** | 移除 `-mL` 后页面不再 wired，在内存压力下可能被全局页面置换算法选中回收 | 🟢 **低**（无 swap 设备时不会发生） |
| **与 swap 的交互** | 若系统配置了 swap，匿名页面可能被换出，换入时产生额外缺页延迟 | 🟢 **低**（嵌入式系统通常无 swap） |

### 3.6 写时复制（COW）私有化延迟

Locked 级别下，`PROT_WRITE` 页面实际是 `PROT_READ`，首次写入时触发缺页以完成私有化：

```Plain
<dd class="dd">Locked memory may not be paged in or out.
  Page faults can still occur on access or reference, to maintain
  usage and modification statistics.
  Pages that you think are <span class="keyword const">PROT_WRITE</span> are still actually
  <span class="keyword const">PROT_READ</span>.
  This is so that, on the first write, the kernel may be alerted that a
  <span class="keyword const">MAP_PRIVATE</span> page now is different from the shared backing
  store, and must be privatized.
```

- `-mL` 开启时：COW 私有化在 `mmap` 时立即完成，后续写入无延迟。
- 移除 `-mL` 后：`fork()` 后的子进程首次写入共享页面时触发 COW 缺页，分配新物理页并复制数据。

---

## 四、副作用总结

| 类别 | 具体影响 | 严重程度 | 是否可规避 |
|-|-|-|-|
| **实时性** | 首次内存访问触发缺页，延迟不可预测 | 🔴 高 | 可通过预触碰（pre-touch）规避 |
| **ISR/临界区** | `MAP_LAZY` 区域在 ISR 中访问 → 崩溃 | 🔴 高 | 必须确保 ISR 中只访问已触碰过的内存 |
| **SIGBUS** | `MAP_LAZY` 首次访问时内存不足 → 进程终止 | 🟡 中 | 测试环境内存充足可规避 |
| **栈缺页** | 栈增长时触发缺页中断 | 🟡 中 | 预触碰栈空间可规避 |
| **页面置换** | 非 wired 页面可被回收 | 🟢 低 | 无 swap 时无影响 |
| **COW 延迟** | `fork` 后首次写入触发 COW 缺页 | 🟢 低 | 影响 fork 场景，非主要路径 |

## 五、结论

**移除 `-mL` 是 QNX 的默认行为**（`~L`），绝大多数 QNX 系统都在此模式下运行。主要风险集中在**实时性**和**ISR/临界区安全**两个方面：

1. **对于测试环境**：内存充足、无 ISR 场景、无严格实时性要求，移除 `-mL` 是安全的，且是测试三种内存方案的**必要条件**。
2. **对于生产环境**：需要评估是否有 ISR 或关中断代码访问 `MAP_LAZY` 内存，以及是否有纳秒级实时性要求。如果有，需要在移除 `-mL` 后采用预触碰策略，或对关键路径使用 `mlockall()` 逐进程锁定。
3. **建议的测试方案**：移除 `-mL` 后，先做基础功能验证（确保所有进程正常启动），再进行内存方案性能对比测试，最后恢复 `-mL` 配置。
