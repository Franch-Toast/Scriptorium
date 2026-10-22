---
title: "从堆栈回溯到火焰图：perf_ebpf 与 FlameCraft 教学"
date: 2026-10-09
description: "从程序调用栈、地址与符号的基本原理出发，拆解 perf_ebpf 的 on-CPU/off-CPU 栈采集，以及 FlameCraft 的文件解析、符号化、pprof 转换和火焰图构建过程。"
categories:
  - 撷简台
tags:
  - eBPF
  - 堆栈回溯
  - 符号化
  - 火焰图
  - FlameCraft
  - perf_ebpf
---

# 从堆栈回溯到火焰图：perf_ebpf 与 FlameCraft 教学

> 本文面向第一次接触性能剖析、栈回溯和符号化的读者。它以当前工作区的 `/sandbox/platform/perf_ebpf` 与 `/sandbox/FlameCraft` 源码为依据，解释一条样本怎样从 CPU 或调度器事件，最终变成 FlameCraft 中可交互的一格火焰图。
>
> 读完后应能回答五个问题：程序的“栈”是什么；为什么采集到的通常只是地址；on-CPU 和 off-CPU 各在测量什么；为什么两者的栈方向不同；火焰图的宽度到底表示什么。

> **先修教程**：若希望先从函数调用、逐指令的栈帧变化，以及 FP、DWARF、eBPF 三种回溯方法的差异学起，请先阅读 [函数调用与返回：AArch64栈帧与寄存器的逐步变化](../正典阁/技术栈/操作系统/函数调用与返回：AArch64栈帧与寄存器的逐步变化.md) 与 [三种栈回溯方法总览](../正典阁/技术栈/操作系统/栈回溯方法/index.md)（含 FP、DWARF-CFI、eBPF 三个方法篇的导航）。本文在此基础上聚焦 perf_ebpf 和 FlameCraft 的真实实现。

> **专项深读**：本文只给出全链路概览；如果要逐步理解 `perf_event`、BPF 内 CFI 执行、CFA 计算和每一帧如何恢复，请阅读 [perf_event 与 BPF 内轻量化 DWARF CFI 堆栈回溯：从一次采样到完整调用链](./2026-10-12%20perf_event与BPF内轻量化DWARF-CFI堆栈回溯通俗教程.md)。

## 1. 先建立全景图

性能火焰图不是直接从源码生成的。它是一条逐层“翻译”的数据链：

```text
程序正在运行 / 线程正在等待
        │
        ├─ on-CPU：perf event 周期性打断当前 CPU
        └─ off-CPU：sched_switch 记下睡眠，sched_wakeup 记下唤醒
        │
        ▼
eBPF 得到栈的地址或展开线索
        │
        ▼
perf_ebpf 用户态读取 map / perf buffer，写入文本调用栈
        │             cpu_profile.log.* / offcpu_flamegraph.log.*
        ▼
FlameCraft 解压、分段、解析 folded 行
        │
        ├─ 本地 ELF 符号表：binary+offset -> function+offset
        └─ debuginfo/DWARF：PC -> 函数、源文件、行号（查询侧能力）
        │
        ▼
转换为 pprof -> 标准化存储为 Arrow/FrostDB
        │
        ▼
按调用路径合并为树，计算 cumulative / flat
        │
        ▼
火焰图
```

这里至少有四件不同的事，必须分开理解：

| 阶段 | 输入 | 输出 | 解决的问题 |
| --- | --- | --- | --- |
| 栈采集/回溯 | 寄存器、线程栈、内核栈 | 返回地址序列 | 当时正在或曾经经过哪些调用层级？ |
| 地址归属 | 虚拟地址、`/proc/<pid>/maps` | 二进制文件 + 文件内偏移 | 这个地址属于哪个可执行文件或 `.so`？ |
| 符号化 | 二进制、符号表、DWARF | 函数名、源码文件、行号 | 这个偏移对应哪段代码？ |
| 聚合/可视化 | 带权重的调用栈 | 调用树和矩形 | 哪条调用路径消耗/等待得最多？ |

“栈回溯成功”只说明拿到了地址序列，不代表一定有函数名；“有函数名”也不代表一定有源码行号。后文排障时，这个区分非常重要。

## 2. 背景：函数调用为什么能形成一条栈

### 2.1 调用栈与栈帧

考虑下面的 C++ 代码：

```cpp
int readSensor();

int filter() {
    return readSensor();
}

int plan() {
    return filter();
}

int main() {
    return plan();
}
```

当 `readSensor()` 正在执行，逻辑调用链是：

```text
main -> plan -> filter -> readSensor
```

CPU 不能只记住“当前在 `readSensor`”。之后它还要知道 `readSensor` 返回到哪里、`filter` 的局部变量在哪里。因此，函数调用会在每个线程自己的内存栈上压入一个 **栈帧（stack frame）**。概念上可以这样看：

```text
高地址
┌──────────────────────────┐
│ main 的栈帧              │  最早调用，最外层/root
├──────────────────────────┤
│ plan 的栈帧              │
├──────────────────────────┤
│ filter 的栈帧            │
├──────────────────────────┤
│ readSensor 的栈帧        │  当前执行，最内层/leaf
└──────────────────────────┘
低地址（多数架构的栈向下增长）
```

一个栈帧通常涉及：

- **返回地址（return address）**：`call` 指令跳进被调函数前，硬件或 ABI 约定保存的“返回后继续执行的位置”。
- **栈指针（SP）**：当前栈顶的位置。
- **帧指针（FP，某些编译选项/架构使用）**：指向当前帧，并能链到调用者帧。
- **保存的寄存器和局部变量**。

所谓 **栈回溯（stack unwinding）**，就是从当前现场开始，一层层找回调用者的返回地址，恢复出 `readSensor <- filter <- plan <- main` 这条链。

### 2.2 PC、返回地址与“地址不是函数名”

CPU 正在执行的位置由 **程序计数器（PC / instruction pointer）** 表示，它是一个数，例如：

```text
0x7f12ab345678
```

这个数只是当前进程虚拟地址空间中的位置。CPU 并不知道源码里的 `readSensor` 字样。要变成人能读的名字，需要额外数据：

```text
运行时虚拟地址
  -> 通过 /proc/<pid>/maps 判断落在哪个内存映射
  -> 得到 ELF 文件和该映射的 file offset
  -> 按 ELF 装载规则归一化为符号表地址
  -> 在 .symtab / .dynsym / DWARF 中查询
  -> 函数名、偏移、可选的源码文件和行号
```

例如某个共享库在进程 A 中加载到 `0x7f00_1000_0000`，进程 B 中加载到 `0x7f20_5000_0000`。同一个 `libfoo.so` 里的 `foo()` 在两个进程的运行时虚拟地址不同，但文件内偏移相同。这是 ASLR（地址空间布局随机化）造成的正常现象。因此跨机器、跨进程保存 profile 时，`libfoo.so+0x1234` 通常比裸地址 `0x7f001234` 更有意义。

### 2.3 三种常见回溯方法

没有一种回溯方式在所有二进制上都完美。常见方法如下：

| 方法 | 依据 | 优点 | 局限 |
| --- | --- | --- | --- |
| FP 回溯 | 链式 frame pointer | 快、实现简单 | 编译器省略帧指针、栈损坏、协程/语言运行时都可能使其不完整 |
| DWARF CFI 回溯 | `.eh_frame` / `.debug_frame` 的调用帧规则 | 面对优化代码更可靠 | 规则复杂，内核 eBPF 验证器限制下难做；需要有效 unwind 信息 |
| 采样器保存的栈 | 内核 `bpf_get_stackid()` | eBPF 接入直接 | 深度有限；拿到的是地址，用户栈质量受映射、权限、栈可读性影响 |

`perf_ebpf` 的当前 on-CPU 主路径是“native/DWARF 展开器 + FP fallback”，同时仓库保留了一个直接 `bpf_get_stackid()` 的兼容采样路径。off-CPU 则主要在调度事件处用 `bpf_get_stackid()` 抓取睡眠/唤醒相关的地址栈，也能走 native/DWARF 路径。

### 2.4 内核栈、用户栈、进程与线程

一次系统调用的调用链可能跨越用户态与内核态：

```text
用户态：业务函数 -> libc -> syscall 指令
内核态：entry_SYSCALL -> do_syscall -> vfs_read -> 驱动
```

因此 profile 中常见注记：

- `[u]`：用户态帧。
- `[k]`：内核态帧。
- `[u/fp]`：用户态帧，但来自 frame-pointer fallback。

还要分清两个标识：

- **TGID**：通常就是用户所说的“进程 PID”。同一进程的线程共享 TGID。
- **TID/PID（内核调度语境）**：具体线程 ID。调度器切换、off-CPU 事件通常天然以线程为单位。

这也是为什么文本首字段经常同时保存 `process(pid)` 和线程名：火焰图可以按进程过滤，也不能丢掉真正被调度的线程上下文。

## 3. 性能剖析的两种时间：on-CPU 与 off-CPU

### 3.1 on-CPU：CPU 此刻正在执行谁

on-CPU 采样的思路是“每隔一段时间看一眼 CPU 正在跑什么”。如果采样频率为 100 Hz，每 10 ms 取一个样本：

```text
t=0ms     sample: main -> plan -> filter -> readSensor
t=10ms    sample: main -> plan -> filter -> readSensor
t=20ms    sample: main -> plan -> filter -> readSensor
t=30ms    sample: main -> plan -> log
```

前三个样本经过 `readSensor`，可以估计它占了约 `3 * 10ms = 30ms` 的 CPU 时间。这里的“约”不能省略：采样是统计估计，不是逐条指令记账。

`perf_ebpf` 使用每 CPU 的 `PERF_COUNT_SW_CPU_CLOCK` software perf event。`attr.freq = 1` 且 `sample_freq` 取配置值；每个在线 CPU 通过 `perf_event_open(..., pid=-1, cpu=N, ...)` 建立一个系统级事件。因此它问的是：**被筛选目标线程在任何 CPU 上实际运行时，调用栈是什么？**

### 3.2 off-CPU：线程为什么没有在 CPU 上运行

off-CPU 不靠周期采样，而是测一段明确的等待区间：

```text
t0: 线程 A 在 sched_switch 中从 CPU 切出，进入睡眠
        记录 {t0, A 的栈, 调度状态}

t1: A 收到 sched_wakeup / sched_wakeup_new
        duration = t1 - t0
        将 duration 归属给 A 在 t0 的阻塞调用栈
```

例如线程在 `futex_wait()` 处睡了 50 ms，off-CPU 火焰图会把约 50 ms 的宽度归属给这条等待路径。这回答的是“为什么业务慢却没有 CPU 热点”：它可能在等锁、I/O、条件变量、另一个线程或调度资源。

> 重要边界：这里的 off-CPU 是“线程离开运行态到被唤醒”的等待区间。它与“已经 runnable、但在 runqueue 中等待 CPU”的 scheduler latency 不是同一个指标。

### 3.3 火焰图的宽度不是调用深度

火焰图中：

- 纵向：调用层级。
- 横向宽度：权重的累计值。
- x 轴的左右位置：通常只是布局与相邻合并结果，**不代表时间先后**。

on-CPU 的权重是样本数乘采样周期；off-CPU 的权重是累计等待时长。二者都可最终用纳秒保存，但物理含义不同：前者是 CPU 使用时间估计，后者是阻塞/等待时间。

## 4. perf_ebpf 如何采集 on-CPU 栈

本节中的实现入口主要在：

- `src/plugins/cputracker/cputracker.cc`
- `src/plugins/cputracker/enhanced_unwinder.cc`
- `src/framework/symbolizer.cc`
- 兼容路径：`bpf_common/profile.bpf.c` 与 `src/plugins/cputracker/cputracker_program.cc`

### 4.1 当前主路径：EnhancedUnwinder

`CPUTracker::initialize()` 创建 `EnhancedUnwinder`，`CPUTracker::start()` 调用它的 `attach()`，并启动 `enhancedWorkerFunction()`。因此当前产出 `cpu_profile.log.*` 的主链路不是简单 map 轮询，而是：

```text
每 CPU PERF_COUNT_SW_CPU_CLOCK
  -> native_unwinder BPF 的 nu_tracer_entry
  -> BPF 展开/编码 nu_trace
  -> nu_trace_events perf buffer
  -> EnhancedUnwinder::pollTraces()
  -> CPUTracker::processEnhancedTrace()
  -> dataSink 写出 folded 文本
```

`EnhancedUnwinder::attach()` 会为每个在线 CPU 创建 perf event，并把 `nu_tracer_entry` BPF 程序附着上去。随后它用 `perf_buffer__new()` 订阅 `nu_trace_events`。这就是“内核侧不能直接写普通文件，事件通过 perf buffer 交给用户态”的典型 eBPF 架构。

### 4.2 为什么采样前要同步 `/proc/<pid>/maps`

用户态地址只有在知道它属于哪个映射时才可解释。`EnhancedUnwinder::setTargetPids()` 会调用 `synchronizeProcess(pid)`：

```text
/proc/<pid>/maps
  -> 每段 VMA 的 [start, end)、file offset、文件路径
  -> file_id、EH frame / unwind delta
  -> 送入 BPF map，并缓存 file_id -> path
```

这一步有两层价值：

1. BPF 的 native unwinder 需要 `.eh_frame` 等调用帧规则（unwind delta）来回溯优化过的本地代码。
2. 用户态在消费 `nu_trace` 时需要将 `file_id + offset` 写成可移植的 `binary+offset` 文本。

如果映射没有同步、进程刚 `exec`、动态库刚加载，或权限不允许读取 `/proc/<pid>/maps`，回溯仍可能抓到地址，但无法可靠地写出二进制名。

### 4.3 `nu_trace` 到 folded 行

`CPUTracker::processEnhancedTrace()` 做了几个关键动作：

1. 写入 `进程名(trace.pid);线程名;` 前缀。
2. 从 `nu_kernel_stackmap` 取内核栈。若 `Symbolizer` 可用，尝试把内核地址转为内核符号；否则保留十六进制地址加 `[k]`。
3. 解码 `trace.frame_data`。native 帧包含 `file_id` 与文件内 offset，于是构造如 `libc.so+0x857644 [u]` 的帧；还会识别 Python、HotSpot、V8 等运行时帧类型。
4. 若 DWARF 用户帧为空或过浅，而 `user_stack_id` 有效，则从 `nu_user_stackmap` 取地址，用 `/proc/<pid>/maps` 归属到二进制，作为 `[u/fp]` fallback。
5. 将收集到的帧用 `rbegin()` 到 `rend()` **反转**后写出，最后加权重 `1`。

输出形态如下：

```text
========== [2026-03-19T11:54:49.105505+0000] ==========
perception(391063);worker;libc-2.31.so+0x857644 [u];mainboard+0x11282812 [u];schedule [k] 1
```

这是一种 folded stack 文本：分号左边是从根到叶的调用路径，最后一个空格后的 `1` 是此调用栈的采样权重。时间标记把连续文件切成约一秒的 section，供后续时间范围查询使用。

### 4.4 为什么 on-CPU 输出是“根在前、叶在后”

采集期间得到的数组顺序和最终文本的语义不必相同。`processEnhancedTrace()` 明确反向迭代 `stack_symbols` 后写文件，意图是输出：

```text
线程入口;调用者;被调者;当前最内层帧 1
```

这很适合 folded 格式，也易于人读。但 pprof 的 `location_id` 约定是 **leaf first**，所以 FlameCraft 导入 on-CPU 文件时还要再反转一次。这不是重复工作，而是在适配两个不同格式的约定。

### 4.5 兼容/简化路径：`profile.bpf.c`

仓库还保留了更容易学习的直观实现：`bpf_common/profile.bpf.c`。

```c
stack_key.kstack_id = bpf_get_stackid(ctx, &stack_traces, ...);
stack_key.ustack_id = bpf_get_stackid(ctx, &stack_traces,
    BPF_F_USER_STACK | ...);
stack_counts[(pid, comm, ustack_id, kstack_id)] += 1;
```

它的工作方式是：

```text
perf event 触发
  -> 检查 PID 白名单
  -> bpf_get_stackid() 将地址栈放入 BPF_MAP_TYPE_STACK_TRACE
  -> 返回的 stack ID 加上 pid/comm 组成聚合 key
  -> stack_counts 中的 count 加 1
```

其中：

- `stack_traces` 是“stack ID -> 最多 127 个地址”的字典。
- `stack_counts` 是“某个进程的用户栈 + 内核栈组合 -> 出现次数”的哈希表。
- 栈深度是 127，不应随意加为 128；它需满足内核 `kernel.perf_event_max_stack` 限制。

这条路径很适合理解 eBPF 栈 map，但不要把它和当前 EnhancedUnwinder 的 `nu_trace` 主路径混为一谈：后者试图通过 DWARF/native 机制拿到比 FP 栈更完整的用户调用链。

## 5. perf_ebpf 如何采集 off-CPU 栈

关键源码：

- BPF：`bpf_common/sched_tracker.bpf.c`
- 用户态：`src/plugins/sched/sched_tracker.cc`

### 5.1 它是一个“睡眠开始/唤醒结束”的状态机

off-CPU 的最小状态机如下：

```text
目标线程正在运行
  │
  ├─ sched_switch(prev=目标线程，且 prev 要睡眠)
  │     保存 start_time、state、user_stack_id、kern_stack_id
  │     到 offcpu_sleep_start[tid]
  │
  ├─ 线程处于睡眠/等待状态
  │
  └─ sched_wakeup / sched_wakeup_new(目标线程)
        查 offcpu_sleep_start[tid]
        duration = now - start_time
        采集当前唤醒者的栈和身份
        若 duration 达阈值，聚合进 offcpu_time_stats_extended
        删除 offcpu_sleep_start[tid]
```

代码中的 BPF tracepoint 入口是 `tp_btf/sched_switch`、`tp_btf/sched_wakeup` 和 `tp_btf/sched_wakeup_new`。目标进程由 `dynamic_target_pids` 控制，空集合时不会接受 off-CPU 样本。

### 5.2 为什么在 `sched_switch` 就抓被阻塞者的用户栈

当线程已经睡眠后，它不再是当前正在使用用户页表的任务。再去抓它的用户栈可能失败或失真。因此实现会在 `sched_switch` 时、`prev` 仍是当前任务的窗口保存其用户栈 ID。这是 off-CPU 回溯与 on-CPU 定时采样的一个关键差异。

### 5.3 聚合 key、保留事件和准确性边界

`offcpu_time_stats_extended` 的 key 主要包含：

```text
(pid, tgid, state, offcpu_user_stack_id, offcpu_kern_stack_id, comm)
```

value 中既有完整的 `count`，也保存 wakeup 侧栈、唤醒者信息和一个大小为 `MAX_OFFCPU_EVENTS=4` 的近期事件环形数组。

这带来一个容易忽略的限制：`SchedTracker::outputOffCpuTimeStatsExtended()` 生成火焰图权重时，是对最多 4 个保留事件的 `(end_time - start_time)` 求和，再除以 1000 写成微秒。因此：

- `count` 可以表示这条 key 出现过很多次。
- 输出到 `offcpu_flamegraph.log` 的 duration 却最多覆盖最近 4 次。
- 所以它适合定位等待路径，但当同一 key 高频重复时，不能把它当作完全精确的累计等待总时长。

### 5.4 普通 stack-ID 路径与 waker 视角

在普通路径下，用户态 `generateCombinedFlameGraphEntry()` 从 `stack_trace_map` 读出：

1. 被阻塞线程睡眠瞬间的用户栈和内核栈。
2. 唤醒线程在 `sched_wakeup` 时的用户栈和内核栈。

它把二者写进一行，并用 `--- WAKER ---` 分隔：

```text
[offcpu_u:3,k:5|waker_u:2,k:4] blocked(100)->waker(200);\
blocked_frame [u];schedule [k];--- WAKER ---;wake [k];waker_frame [u] 106917
```

行尾 `106917` 的单位是微秒。它回答两个不同问题：

- blocked 栈：线程在哪里开始等待？
- waker 栈：是哪条路径唤醒了它？

FlameCraft 会把它导入为两个 profile：`process_offcpu` 与 `process_offcpu_waker`，不能把二者直接相加，否则会对同一事件重复计数。

### 5.5 DWARF off-CPU 路径

当 native/DWARF unwinder 参与 off-CPU 采集时，用户栈不一定使用普通 `bpf_get_stackid()` 的 ID。BPF 对 `nu_trace.frame_data` 做 FNV-1a hash，并设置 `0x100000` 位，使它和普通 stack map ID 区分开来。

用户态发现 `offcpu_user_stack_id >= 0x100000` 时，从 pending DWARF trace 中取原始 `nu_trace`，调用 `generateDwarfFlameGraph()` 写出无 metadata 前缀的行：

```text
mediapipe(2096233);mediapipe;libpthread.so+0xe420 [u];libc.so+0xd162c [u] 30926
```

注意第二个 `mediapipe` 是重复的进程名，而不是栈帧；这类行没有 waker 部分。它若被错误地当成普通帧，会在图中凭空多出一层；若被整个丢弃，会系统性漏掉一部分长等待。

### 5.6 off-CPU 栈方向为何与 on-CPU 相反

`addStackFramesToVector()` 按 `bpf_get_stackid()` 返回的数组顺序直接追加，没有像 on-CPU 那样 `rbegin()` 反转。因此当前 off-CPU 文件是：

```text
叶（最内层） -> ... -> 根（最外层）
```

这恰好已经符合 pprof 的 `location_id[0]` 是 leaf 的要求。所以 FlameCraft 对 off-CPU 输入 **不能再反转**。这是理解“火焰图上下颠倒”问题时最重要的源码事实。

## 6. FlameCraft：如何从文件读到可查询 profile

主要入口：

- `pkg/filereader/reader.go`
- `pkg/filereader/folded_parser.go`
- `pkg/filereader/offcpu_parser.go`
- `pkg/filereader/profiler_files.go`

### 6.1 文件识别、压缩和去重

`Reader.processFile()` 的大致决策如下：

```text
文件名是 .zst 或 .tmp？
  -> 先尝试自定义分块 zstd
  -> 失败后尝试标准 zstd stream
  -> 未闭合流已经解出前缀时，保留前缀继续处理

offcpu_flamegraph.log.* 或检测到 off-CPU metadata？
  -> processOffCPUFile()
否则 cpu_profile.log.* / qnx_profiler.log.* 或含时间 marker？
  -> processFoldedFile()
否则
  -> 按普通 pprof 处理
```

`.tmp` 不意味着“必然不可用”：它可以是仍在写入的记录。当前解压逻辑会尽量保留已经完整解出的部分。另一方面，`ProfilerFileIndex` 依据文件名起始时间识别同一录制：若同一开始时间已有带结束时间的完整文件，则跳过它的未完成副本，避免导入重复样本；若只有 `.tmp`，仍会读取它。

### 6.2 on-CPU folded parser

`ParseFoldedFormatWithSymbolizer()` 按下面两种时间标记切 section：

```text
========== [2025-11-12 06:47:52.470525] ==========
========== [2026-03-19T11:54:49.105505+0000] ==========
```

每个非空数据行由 `parseStackLine()` 解析：

```text
process_name(pid);thread_name;frame1;frame2;... count
```

得到的 `FoldedStack` 保留：进程名、PID、线程名、帧列表、每帧二进制归属和 count。注意 **先提取二进制归属，再尝试符号化**：

```text
libfoo.so+0x1234 [u]
  -> FrameBinaries[i] = libfoo.so
  -> 若符号化成功，Frames[i] = foo+0x34
```

如果反过来，`foo+0x34` 已经不含 `libfoo.so`，后续无法正确建立 pprof mapping。这是保留 mapping 信息的关键细节。

### 6.3 off-CPU parser

`ParseOffCPUSectionsStream()` 是流式 parser；它逐行扫描、遇 timestamp 提交上一 section。它兼容：

- 带 blocked/waker metadata 的扩展行。
- 不带 waker 的 `[u:N,k:N]` 行。
- 没有 `[...]` 前缀的 DWARF 行。
- `Samples: N` 元数据行（跳过，不当作调用栈）。

行尾 duration 从微秒乘以 1000，保存在 `DurationNs` 中，统一到 pprof 的纳秒约定：

```text
duration_ns = duration_us * 1000
```

解析完成后，`processOffCPUFile()` 先按 `BlockedProcess|BlockedPID` 分组，再把每组写成 blocked 与 waker 两类 `RawProfileSeries`。

### 6.4 为什么 pprof 是中间格式

FlameCraft 没有直接把文本堆栈塞给 UI，而是转换成 pprof protobuf。pprof 把一份 profile 表达为：

```text
Profile
  SampleType / PeriodType / TimeNanos / DurationNanos
  Mapping：二进制文件
  Function：函数名
  Location：地址处的函数/行号
  Sample：一条 location 列表 + Value + Labels
```

它的优点是：调用栈、样本权重、进程标签、二进制 mapping 都变成明确的数据模型；之后无论查询、合并、差分还是导出，都是同一种 profile 语义。

#### on-CPU 到 pprof

`FoldedSectionToPprofWithDuration()` 为每条 stack 创建 sample：

```text
Period        = 10,000,000 ns  （10ms）
SampleType    = cpu:nanoseconds
Value         = Count * 10,000,000
DurationNanos = 1 秒（分钟聚合版本为 60 秒）
```

on-CPU 文件是根到叶，pprof 要叶到根，所以代码倒序写 locations。线程名还作为根侧位置加入（QNX 线程格式除外）。`comm`、`pid`、`thread` 同时写入 sample labels。

> 前提：这个 10 ms 换算假定采集器实际采样周期就是 10 ms。若采样频率改变、但导入端仍硬编码 10 ms，最终 CPU 宽度会成比例偏大或偏小。

#### off-CPU 到 pprof

`OffCPUStacksToPprof()` 创建 `offcpu:nanoseconds` profile：

```text
Value = DurationNs
```

off-CPU 文件当前已经是叶到根，`buildOffCPUSample()` 顺序写入，不反转。blocked/waker profile 还加 `role`、`comm`、`pid` 等标签，方便从两个视角查询同一批事件。

### 6.5 存储和一分钟聚合

`processFoldedFile()` 写两层 on-CPU 数据：

1. `process_cpu`：保留每个原始 section 的细粒度 profile。
2. `process_cpu_1m`：`BucketSectionsByMinute()` 将同一分钟内相同进程、线程、PID、调用栈的 count 合并。

分钟 profile 的 `DurationNanos` 必须设为 60 秒，不能仍是 1 秒。因为范围查询会用累计 value 除以 profile 覆盖的墙钟时长来得到每秒值；若错填 1 秒，会在切换到一分钟数据时放大约 60 倍。

这些 pprof 原始数据随后通过 `WriteRawRequest` 进入标准化流程，写成 Arrow/FrostDB 可检索的 profile 表。

## 7. FlameCraft 中的两层符号化

“FlameCraft 如何符号化”有两层答案，来源不同、信息量也不同。

### 7.1 导入时：本地 binary+offset 到函数名

`pkg/binsymbolizer/symbolizer.go` 的 `SymbolizeWithHint()` 面向 perf_ebpf 文本中的形式：

```text
libfoo.so+0x1234
```

它做的事是：

```text
二进制基名 + 进程名 hint
  -> 在 BinariesDir / ExtraBinDirs 建路径索引
  -> 找到正确 ELF（同名库可能有多个）
  -> 读取 .symtab，失败则读取 .dynsym
  -> 按符号起始地址二分查找
  -> demangle C++ 名称
  -> foo::bar(int)+0x34
```

它带两类缓存：ELF 缓存（包括负缓存）和 `hint + binary+offset` 符号结果缓存，避免大量重复打开同一 ELF。对于一些错误地把十进制 offset 写成 `0x` 前缀的采集数据，它会先按十六进制尝试，再对纯数字回退十进制。

这一层没有 matching binary、没有符号表时，正确行为是保留 `libfoo.so+0x1234`，不是伪造函数名。

### 7.2 查询时：Build ID + debug info 到源文件行

FlameCraft 还保留来自 Parca 的通用 `pkg/symbolizer`。它面向标准 profile 内带 mapping / build ID / runtime 地址的情形：

```text
Location.Address + Mapping(start, limit, offset) + ELF 类型
  -> NormalizeAddress()
  -> 得到 ELF 的符号地址
  -> 获取该 Build ID 的 debuginfo
  -> 选择 DWARF、Go pclntab、.symtab/.dynsym 或外部 addr2line
  -> PCToLines()
  -> 函数名、系统名、源文件名、行号，可能还有 inline 调用链
```

`NormalizeAddress()` 的存在是为了解决 PIE/共享库的加载基址随机化。`ET_EXEC`、`ET_DYN`、`ET_REL` 的基址算法不同；跳过这一步会造成“ELF 是对的，地址却查不到符号”。

信息优先级可以这样理解：

| 可用信息 | 通常能得到什么 |
| --- | --- |
| 裸地址 | 只能显示地址 |
| binary + offset | 至少可定位 ELF，可能得到函数名 |
| `.dynsym` | 常能得到导出动态符号，覆盖不完整 |
| `.symtab` | 更多函数名，通常无精确源码行 |
| DWARF | 函数、文件、行号、inline 链，信息最完整 |

## 8. 从 profile 到火焰图树

查询侧核心在 `pkg/query/flamegraph_arrow.go` 的 `GenerateFlamegraphArrow()`。

它并不是把每条 sample 画成一条独立柱子，而是把**共享前缀/路径**合并成树：

```text
样本 1: main -> plan -> filter -> readSensor, value=30
样本 2: main -> plan -> filter -> validate,   value=10

合并后：
main (40)
└─ plan (40)
   └─ filter (40)
      ├─ readSensor (30)
      └─ validate   (10)
```

节点的两个最重要数值：

```text
cumulative(node) = 经过该节点的全部样本值之和
flat(node)       = 调用栈正好在该节点结束的样本值
```

在上例中，`filter` 的 cumulative 是 40；若没有任何 sample 正好停在 `filter`，则 flat 是 0。前端把 cumulative 映射为矩形宽度，所以框宽代表“包含所有子调用在内的总权重”，而非单纯函数自身耗时。

同时，生成器会保存 parent、children、depth、labels、mapping/function metadata 以及 diff 信息；在节点过多时按阈值裁剪，并重新计算父节点宽度，避免裁剪后出现无意义的空白带。

## 9. 一个完整的手算例子

假设 on-CPU 文件某一秒有：

```text
app(42);worker;main [u];plan [u];readSensor [u] 3
app(42);worker;main [u];plan [u];validate [u] 1
```

按当前导入逻辑，10 ms period 下：

```text
readSensor 路径：3 * 10ms = 30ms = 30,000,000ns
validate 路径：1 * 10ms = 10ms = 10,000,000ns
main / plan 累计：40ms
```

生成树：

```text
root
└─ worker                cumulative=40ms
   └─ main               cumulative=40ms
      └─ plan            cumulative=40ms
         ├─ readSensor   cumulative=30ms, flat=30ms
         └─ validate     cumulative=10ms, flat=10ms
```

如果是 off-CPU 文件：

```text
[u:1,k:1] app(42);futex_wait [u];schedule [k] 50000
```

行尾是微秒，导入后：

```text
50,000us * 1000 = 50,000,000ns = 50ms
```

它表示这条阻塞调用路径累计等待 50 ms。即使 on-CPU 与 off-CPU 都显示“50 ms”，前者表示 CPU 占用估计，后者表示不能执行的等待时长，解释时不能混用。

## 10. 最常见的问题与排查顺序

### 10.1 图为空

按数据链从前向后检查，而不是直接怀疑 UI：

```text
目标线程是否存在且行为符合预期？
  -> BPF perf event / tracepoint 是否 attach？
  -> BPF map 或 perf buffer 是否真的有样本？
  -> 原始 log 是否出现合法 folded 行？
  -> FlameCraft 是否识别、解压并解析出 section/stacks？
  -> WriteRaw 是否成功？查询的 profile name / labels / 时间范围是否匹配？
  -> 是否生成了 locations 与 flamegraph rows？
```

“进程启动成功”“perf fd 创建成功”“文件被扫描到”都只是链路中的早期条件，不能单独证明火焰图可用。

### 10.2 只有地址、没有函数名

先确认样本存在，再分层定位：

| 现象 | 优先检查 |
| --- | --- |
| `0x... [u]` | `/proc/<pid>/maps` 映射是否找到；地址是否可归属到 binary；FP/DWARF 回溯是否只拿到原始地址 |
| `libfoo.so+0x...` | FlameCraft 的 `BinariesDir`/额外二进制目录是否含匹配 ELF；ELF 是否有 `.symtab` 或 `.dynsym` |
| 有函数、无文件行号 | 是否有匹配 Build ID 的 DWARF debuginfo |
| `[k]` 仍是地址 | 内核符号来源/权限（如 `/proc/kallsyms`）以及内核版本是否匹配 |

不要把“符号化失败”误判为“没采到样本”。`binary+offset` 已经说明采样和地址归属可能成功，只是最后的名字恢复缺少材料。

### 10.3 栈方向反了、图上下颠倒

先问文件来源：

| 输入 | 文件帧方向 | pprof 写入策略 |
| --- | --- | --- |
| on-CPU `cpu_profile.log` | 根 -> 叶 | 反转，变成 leaf first |
| off-CPU `offcpu_flamegraph.log` | 叶 -> 根 | 保持原序 |

对 off-CPU 再套用 on-CPU 的反转，会产生反向火焰图。

### 10.4 off-CPU 总时长和 `count` 对不上

先确认比较的是不是同一语义：

- `value.count` 是聚合 key 完整出现次数。
- 火焰图行尾 duration 是最多 4 个保留事件区间的时长和。
- `Samples: N` 是 section 元数据，不是总等待时长，也不是调用栈。
- blocked 与 waker 是同一事件的两种观察视角，不能相加成“总等待”。

### 10.5 出现很大的怪地址

BPF stack trace map 的有效地址后方可能残留非零数据，不能只以 `0` 作为结束条件。x86_64 上，用户态地址应不高于 `0x00007FFFFFFFFFFF`，内核态地址应不低于 `0xFFFF800000000000`；中间的非规范区间地址不应进入符号化和火焰图。正确做法是在读取 map 时加入 canonical-address 校验。

## 11. 源码导读路线

建议按下面顺序阅读，比从大型文件开头硬读更容易建立模型：

1. `perf_ebpf/bpf_common/profile.bpf.c`：最小化理解 `bpf_get_stackid()`、stack map 与 count 聚合。
2. `perf_ebpf/src/plugins/cputracker/cputracker_program.cc`：理解每 CPU perf event 如何 attach。
3. `perf_ebpf/src/plugins/cputracker/cputracker.cc` 的 `processEnhancedTrace()`：理解当前主路径怎样把 `nu_trace` 写成 on-CPU folded 行。
4. `perf_ebpf/bpf_common/sched_tracker.bpf.c` 中的 `sched_switch` / `sched_wakeup`：理解 off-CPU 状态机。
5. `perf_ebpf/src/plugins/sched/sched_tracker.cc` 的 `outputOffCpuTimeStatsExtended()`、`generateCombinedFlameGraphEntry()`、`generateDwarfFlameGraph()`：理解 off-CPU 文本格式。
6. `FlameCraft/pkg/filereader/folded_parser.go` 与 `offcpu_parser.go`：观察两类文本如何得到结构体和 pprof。
7. `FlameCraft/pkg/binsymbolizer/symbolizer.go`：理解导入时本地 ELF 符号查询。
8. `FlameCraft/pkg/symbolizer/normalize.go` 与 `pkg/symbol/addr2line/`：理解 Build ID/DWARF 查询时的地址归一化和源码行恢复。
9. `FlameCraft/pkg/query/flamegraph_arrow.go`：最后看 profile 如何合并成带 cumulative/flat 的树。

## 12. 结论：用正确的问题理解一张图

面对 profile 数据，最有效的思考顺序通常是：

```text
1. 这是 on-CPU 还是 off-CPU？它的权重代表什么时间？
2. 这是地址、binary+offset、函数名，还是已经有源码行？缺的是哪一层信息？
3. 原始文本的栈方向是什么？进入 pprof 时是否做了正确的适配？
4. 火焰图宽度来自 count、采样 period，还是等待 duration？单位是否一致？
5. 这是采集误差、回溯失败、符号缺失，还是解析/聚合错误？
```

掌握这五个问题后，堆栈回溯、符号化和火焰图就不再是一个黑盒：它们是对“运行现场”逐层保真、逐层赋予语义的工程链路。采样决定能看到什么，回溯决定调用链是否完整，映射与符号决定人能否读懂，解析与聚合决定图的宽度是否正确。

## 参考源码

- `/sandbox/platform/perf_ebpf/bpf_common/profile.bpf.c`
- `/sandbox/platform/perf_ebpf/src/plugins/cputracker/cputracker.cc`
- `/sandbox/platform/perf_ebpf/src/plugins/cputracker/enhanced_unwinder.cc`
- `/sandbox/platform/perf_ebpf/bpf_common/sched_tracker.bpf.c`
- `/sandbox/platform/perf_ebpf/src/plugins/sched/sched_tracker.cc`
- `/sandbox/FlameCraft/pkg/filereader/folded_parser.go`
- `/sandbox/FlameCraft/pkg/filereader/offcpu_parser.go`
- `/sandbox/FlameCraft/pkg/filereader/reader.go`
- `/sandbox/FlameCraft/pkg/binsymbolizer/symbolizer.go`
- `/sandbox/FlameCraft/pkg/symbolizer/symbolizer.go`
- `/sandbox/FlameCraft/pkg/symbolizer/normalize.go`
- `/sandbox/FlameCraft/pkg/query/flamegraph_arrow.go`
