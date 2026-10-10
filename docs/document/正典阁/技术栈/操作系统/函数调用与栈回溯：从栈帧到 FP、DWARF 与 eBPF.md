---
title: "函数调用与栈回溯：从栈帧到 FP、DWARF 与 eBPF"
date: 2026-10-09
description: "面向初学者逐步讲解函数调用如何改变栈帧，如何以帧指针、DWARF CFI 和 eBPF 采样回溯调用栈，以及运行时地址如何还原为函数与源码。"
categories:
  - 正典阁
tags:
  - 操作系统
  - 调用栈
  - 栈帧
  - 栈回溯
  - DWARF
  - eBPF
  - 符号化
---

# 函数调用与栈回溯：从栈帧到 FP、DWARF 与 eBPF

> 本文以 Linux x86-64 的常见 ABI 为主线，因为它最适合把内存变化画清楚；AArch64/QNX 与它的基本思想一致，但保存返回地址的寄存器和具体指令不同。文中所有地址、汇编和栈内容都是教学用示例，真实数值会随编译器、优化等级、ASLR 和运行环境变化。

> **适用范围**：想理解 CPU profile、off-CPU profile、崩溃栈、`perf`、eBPF、`addr2line` 或 FlameCraft 中“调用栈从哪里来”的读者。看完本文再阅读 [从堆栈回溯到火焰图：perf_ebpf 与 FlameCraft 教学](../../../撷简台/2026-10-09%20从堆栈回溯到火焰图：perf_ebpf%20与%20FlameCraft%20教学.md)，可以把基础原理与项目实际数据链对应起来。

## 1. 先给出一个准确的全景模型

把“调用栈”想成一叠写有回程信息的便签并不算错，但不够准确。程序运行时，CPU 只持有寄存器和内存；函数名、源码行、调用关系都是我们根据这些原始状态恢复出来的解释。

```mermaid
flowchart LR
    A[源代码中的函数] --> B[编译器生成机器指令、符号表、可选 DWARF]
    B --> C[运行时: PC/SP/FP/寄存器/线程栈]
    C --> D[回溯: 找到当前帧和调用者的返回位置]
    D --> E[地址归属: 运行时地址 -> ELF 文件内地址]
    E --> F[符号化: 函数、文件、行号、inline 链]
    F --> G[采样聚合或崩溃报告]
```

这五层分别回答不同问题：

| 层次 | 典型问题 | 需要的材料 | 常见失败现象 |
| --- | --- | --- | --- |
| 函数调用 | 当前执行点如何回到调用者？ | ABI、寄存器、线程栈 | 返回后跳错位置，程序崩溃 |
| 栈回溯 | 此刻有哪些物理调用帧？ | PC、SP、FP 或 CFI | 只有一两层、栈中断、乱码地址 |
| 地址归属 | 地址属于哪个模块？ | `/proc/<pid>/maps`、ELF load segment | 只剩 `0x...`，找不到 `.so` |
| 符号化 | 该地址是什么函数、哪一行？ | `.symtab`/`.dynsym`/DWARF/debug info | `libfoo.so+0x1234`，没有函数名 |
| 聚合展示 | 哪条路径最重？ | 带权重的样本序列 | 火焰图宽度错误、方向颠倒 |

特别要牢记这一点：**回溯与符号化不是同一个动作。** 回溯先产出一串程序地址；即使地址一个不缺，二进制被 strip、映射找错或 debug info 缺失时，仍然无法得到源码函数名。

### 1.1 本文使用的名词

| 名词 | 含义 | 可以怎样直观理解 |
| --- | --- | --- |
| PC / IP | Program Counter / Instruction Pointer，当前正在执行的机器指令地址 | “你现在站在哪一页的哪一行” |
| SP | Stack Pointer，当前栈顶地址 | 当前这叠便签最上方的位置 |
| FP / BP | Frame Pointer / Base Pointer，当前栈帧的稳定锚点 | 当前便签的页眉，能找到上一张便签 |
| 返回地址，RA | 被调函数结束后，调用者继续执行的位置 | 返程票上的目的地 |
| 栈帧，frame | 一次函数调用在栈上的现场记录 | 一张便签：局部变量、保存寄存器、返回地址 |
| CFA | Canonical Frame Address，DWARF 用的“调用者栈顶基准” | 用统一坐标描述不同函数里的栈布局 |
| CFI | Call Frame Information，调用帧规则 | “本段指令中，怎样根据当前寄存器找回调用者” |
| ELF | Linux/QNX 常用可执行/共享库格式 | 装着机器码、符号、段和调试信息的文件容器 |
| ASLR | Address Space Layout Randomization | 同一个库每次运行被放到不同的虚拟地址 |

## 2. 从一个可复现实验开始

后面的全部图示都围绕同一个极小程序。它故意关闭内联、尾调用优化和帧指针省略，让每个源代码函数都有一个清晰可见的物理栈帧。

### 2.1 示例代码

将以下内容保存为 `stack_demo.c`：

```c
#include <stdio.h>

__attribute__((noinline))
static int checksum(int x) {
    volatile int local = x * 3;
    return local + 7;
}

__attribute__((noinline))
static int process(int x) {
    int result = checksum(x + 1);
    return result * 2;
}

int main(void) {
    int answer = process(10);
    printf("answer = %d\\n", answer);
    return 0;
}
```

当程序停在 `checksum()` 的 `return local + 7` 时，逻辑调用链为：

```text
_start -> libc_start_main -> main -> process -> checksum
```

通常分析业务代码时，我们关注 `main -> process -> checksum`；但一个真实进程并不是从 `main` 凭空开始，`_start` 和 C 运行时先建立初始环境，再调用 `main`。

### 2.2 为教学保留“可回溯形状”的编译配置

下面的配置适合学习、调试或需要高质量 profile 的目标，不是所有生产模块都应机械套用的默认配置：

```bash
gcc -O0 -g \
  -fno-omit-frame-pointer \
  -fno-optimize-sibling-calls \
  -fno-inline \
  -o stack_demo stack_demo.c
```

也可在 CMake 中对专门的诊断目标配置：

```cmake
target_compile_options(stack_demo PRIVATE
  -O0 -g
  -fno-omit-frame-pointer
  -fno-optimize-sibling-calls
  -fno-inline)
```

每个选项的作用不同：

| 配置 | 教学中得到什么 | 关闭它后可能看到什么 |
| --- | --- | --- |
| `-O0` | 指令和源码较接近，局部变量常留在栈中 | 重排、寄存器化、删除无用变量，布局变化很大 |
| `-g` | DWARF 调试信息，可还原文件/行号 | 仍可有函数名，但通常没有可靠源码行 |
| `-fno-omit-frame-pointer` | 生成可链式遍历的 FP | FP 回溯常只能得到当前帧或中断 |
| `-fno-optimize-sibling-calls` | 避免尾调用把一个调用帧“折叠掉” | 某个源码函数不形成物理栈帧 |
| `-fno-inline` | 避免函数直接嵌入调用者 | 调用关系仍可在 DWARF inline 信息中出现，但栈上没有独立帧 |

这里有一个工程取舍：帧指针会占用一个通用寄存器，关闭优化会严重影响性能，因此通常只在诊断构建、性能敏感度可接受的服务或特定模块启用。保留 `-g` 并不意味着必须把完整 debug info 装进最终镜像，可以按 Build ID 将 debug package 单独归档。

### 2.3 先观察三种视角下的同一条调用链

同一时刻，调用链可以有三种等价但方向不同的表示：

```text
源码调用方向（外层调用内层）
main -> process -> checksum

栈回溯输出的自然方向（当前帧回到调用者）
checksum <- process <- main

pprof 的 Location 列表惯例（leaf first）
checksum, process, main
```

之后看到“反转调用栈”时，先问清楚是在适配哪一种表示，不能只凭“看起来反了”判断 bug。

## 3. 函数调用前，CPU 与调用者分别负责什么

以 Linux x86-64 System V ABI 为例。ABI 可以理解成编译器之间的合同：即使一个函数由 GCC 编译、另一个函数由 Clang 编译，只要都遵守合同，就能相互调用。

### 3.1 调用前的约定

当 `process(10)` 调用 `checksum(11)` 时，调用者 `process` 大致要完成：

1. 将参数放到约定位置。第一个整型参数通常放入 `rdi`；浮点参数使用另一组寄存器。
2. 若寄存器参数不够，将额外参数放到栈上。
3. 按 ABI 保持栈对齐。x86-64 上，调用边界通常要求满足 16 字节对齐约束。
4. 将控制权交给 `checksum`，同时留下回来的位置。

被调函数 `checksum` 则需要：

1. 若使用了调用者期望保留的寄存器，先保存它们。
2. 为局部变量、临时值和进一步调用预留栈空间。
3. 算完结果后恢复现场，跳回返回地址。

不是所有寄存器都需要保存。ABI 会区分 caller-saved（调用者若在意，调用前自己保存）和 callee-saved（被调者若要改，必须恢复）。这个合同使函数可以独立编译，也使异常处理器、调试器和回溯器有共同规则可依。

### 3.2 `call` 做了什么

在 x86-64 中，`call checksum` 的效果可以抽象为两步：

```text
1. RSP = RSP - 8
2. [RSP] = “call 指令之后那条指令的地址”
3. RIP = checksum 的入口地址
```

也就是说，`call` 自动把**返回地址**压入栈顶，再跳转。假设执行前：

```text
RIP = 0x4011DB  （call checksum 所在位置）
RSP = 0x7fff_ef90
```

`call` 之后可能变为：

```text
RIP = 0x401130  （checksum 的入口）
RSP = 0x7fff_ef88
[0x7fff_ef88] = 0x4011E0  （process 中 call 之后继续执行的位置）
```

此时还没有“完整的新栈帧”；只有一张关键的返程票已经压入栈中。是否建立稳定的 FP 链，要看被调函数的序言（prologue）。

### 3.3 典型函数序言如何建立栈帧

为了讲解清晰，假设 `checksum()` 生成如下近似汇编：

```asm
checksum:
    push   rbp              ; 保存 process 的帧指针
    mov    rbp, rsp         ; rbp 成为 checksum 栈帧的锚点
    sub    rsp, 0x20        ; 预留 32 字节局部空间
    ...                     ; 计算 local = x * 3
    leave                   ; mov rsp, rbp; pop rbp
    ret                     ; pop RIP，跳回 process
```

下面逐条画出变化。栈向低地址增长，因此图的下方是更新、更内层的栈内容。

#### 时刻 A：`process` 即将调用 `checksum`

```text
高地址
0x7fff_f000  ┌─────────────────────────────────────┐
              │ process 的局部变量 result（未赋值）│
0x7fff_efc8  ├─────────────────────────────────────┤
              │ 返回到 main 的地址                 │
0x7fff_efc0  ├─────────────────────────────────────┤ <- RBP = 0x7fff_efc0
              │ 保存的 main.RBP = 0x7fff_f000      │
0x7fff_efb8  ├─────────────────────────────────────┤
              │ process 自己的局部空间/对齐填充    │
              └─────────────────────────────────────┘ <- RSP（示意）
低地址
```

#### 时刻 B：执行 `call checksum`

`call` 把“回到 process 的下一条指令”压入栈：

```text
高地址
              │ ... process 原有栈帧 ...           │
0x7fff_ef90  ├─────────────────────────────────────┤
              │ 0x4011E0：返回到 process 的地址    │ <- RSP
              └─────────────────────────────────────┘
低地址
```

此刻 `RIP` 已跳进 `checksum`。若异步采样恰好发生在这里，回溯器仍然可以从栈顶拿到 process 的返回地址，但没有 `checksum.RBP` 可用，FP 回溯需要知道当前 PC 正处于 prologue 的哪个阶段；这正是 DWARF CFI 的价值之一。

#### 时刻 C：执行 `push rbp; mov rbp, rsp`

```text
高地址
              │ ... process 的局部变量 ...         │
0x7fff_efc8  ├─────────────────────────────────────┤
              │ 返回到 main 的地址                 │
0x7fff_efc0  ├─────────────────────────────────────┤
              │ 保存的 main.RBP = 0x7fff_f000      │
0x7fff_efb8  ├─────────────────────────────────────┤ <- process.RBP
              │ 返回到 process 的地址 0x4011E0     │
0x7fff_efb0  ├─────────────────────────────────────┤ <- checksum.RBP = checksum.RSP
              │ 保存的 process.RBP = 0x7fff_efc0   │
              └─────────────────────────────────────┘
低地址
```

现在形成了经典 FP 链：`checksum.RBP` 指向一个单元，其中存有 `process.RBP`；而紧邻的 `checksum.RBP + 8` 是返回到 `process` 的地址。

#### 时刻 D：执行 `sub rsp, 0x20` 并运行函数体

```text
高地址
              │ ... process 的栈帧 ...             │
0x7fff_efb8  ├─────────────────────────────────────┤
              │ 返回到 process 的地址 0x4011E0     │
0x7fff_efb0  ├─────────────────────────────────────┤ <- RBP，整个函数期间保持稳定
              │ 保存的 process.RBP = 0x7fff_efc0   │
0x7fff_efa8  ├─────────────────────────────────────┤
              │ padding / 对齐                      │
0x7fff_ef90  ├─────────────────────────────────────┤
              │ local（或编译器给 local 分配的位置）│
              ├─────────────────────────────────────┤
              │ 临时值、溢出参数、保存寄存器等     │
0x7fff_ef90  └─────────────────────────────────────┘ <- RSP（示意）
低地址
```

严格来说，局部变量是否真的在栈上、具体偏移是多少，完全由编译器决定；`volatile` 和 `-O0` 只是让本教程中的情形更容易观察。回溯并不需要理解每个局部变量，它首先只需要能找回“上一帧在哪里”和“应该返回到哪条指令”。

### 3.4 返回过程：`leave; ret` 如何撤销这一帧

`leave` 等价于：

```asm
mov rsp, rbp   ; 丢弃 checksum 的局部空间
pop rbp        ; 恢复 process 的 RBP
```

随后 `ret` 等价于：

```text
RIP = [RSP]    ; 取出 0x4011E0
RSP = RSP + 8
```

控制权回到 `process` 中 `call checksum` 之后的位置，`process` 才能把返回值乘以 2。换句话说，栈帧是严格后进先出（LIFO）的：最后调用的 `checksum` 必须最先撤销。

### 3.5 同样的概念在 AArch64 上有什么不同

不要把 x86 的 `call` 压栈行为误当成普遍规律。在 AArch64 上：

```text
bl checksum         把返回地址写进 x30（LR），跳转到 checksum
stp x29, x30, [sp,#-16]!   常见序言：同时压入旧 FP 和 LR
mov x29, sp         将 x29 设为当前 FP
```

因此 AArch64 的返回地址先在链接寄存器 `x30` 中，函数若还要调用别人或需要可回溯，通常会将 `x29/x30` 成对保存到栈。概念没有变：仍然需要保存调用者的恢复点和稳定锚点；只是由哪条指令、哪个寄存器完成不同。

## 4. 为什么“源码函数”不一定等于“物理栈帧”

初学时很容易期待一行源代码函数调用就增加一帧、函数返回就减少一帧。优化编译器会合法地打破这种直觉。

### 4.1 内联：源码有函数，机器码没有调用

若 `checksum()` 足够小，编译器可能直接把它的乘法和加法复制进 `process()`：

```text
源码：process -> checksum
机器码：process 内直接完成 x * 3 + 7
物理栈：只有 process，没有 checksum 帧
```

带完整 DWARF 的调试器仍可能把这段机器码解释为“逻辑上位于 `checksum`，并且它被内联进 `process`”，这叫 **inline frame**。它是调试信息推导出的逻辑帧，不是 CPU 栈上的独立物理帧。

### 4.2 尾调用：返回前直接跳进下一个函数

若函数最后的动作只是返回另一个函数的结果，例如：

```c
int relay(int x) {
    return checksum(x);
}
```

编译器可能把 `call checksum; ret` 优化成一次跳转：`jmp checksum`。这样 `checksum` 结束时会直接返回到 `relay` 的调用者，`relay` 的独立帧不存在。这叫尾调用优化。

### 4.3 结论：回溯是“当时真实机器状态”的证据

因此，看到某个源码函数不在 CPU profile 中，不能立即断言采集器漏帧。它可能被内联、尾调用消除、异常路径改写，或者处在异步信号/协程/语言运行时建立的非标准栈上。分析时应区分：

- **物理回溯**：实际栈和寄存器里可恢复的帧。
- **逻辑调用链**：结合 DWARF inline 信息、运行时信息后展示的源码层级。

接下来三种方法的差异，正是它们依赖哪些物理或逻辑证据来恢复这条链。

## 5. 方法一：帧指针（FP）链回溯

FP 回溯是最容易在纸上执行的方法。它不需要理解每一条机器指令，只依赖编译器保持一个约定俗成的链表形状。

### 5.1 FP 链的内存布局规则

继续使用第 3 节的 x86-64 示例。每个使用传统序言的帧都遵守：

```text
[当前 RBP + 0] = 上一帧的 RBP
[当前 RBP + 8] = 返回地址（调用者中 call 后的下一条指令）
```

把 `main -> process -> checksum` 停在 `checksum` 中的那一刻展开：

```text
地址              内容                              所属帧
────────────────────────────────────────────────────────────────────
0x7fff_efb0       0x7fff_efc0  = process.RBP       checksum: saved FP
0x7fff_efb8       0x0000004011e0 = 返回到 process  checksum: return address
                  ↑
                  checksum.RBP = 0x7fff_efb0

0x7fff_efc0       0x7fff_f000  = main.RBP          process: saved FP
0x7fff_efc8       0x000000401220 = 返回到 main     process: return address

0x7fff_f000       0x00007fff_f120 = libc 的 FP      main: saved FP
0x7fff_f008       0x00007f... = 返回到 libc/start  main: return address
```

这不是“函数名字串”，而是一个单向链表。链表结点地址就是 FP 值，结点第一个字存 next 指针，第二个字存返回地址。

### 5.2 人工执行一次 FP 回溯

假设异步采样时寄存器现场是：

```text
RIP = 0x401148     （checksum 内部的一条指令）
RBP = 0x7fff_efb0
RSP = 0x7fff_ef90
```

回溯器按如下步骤工作：

1. **当前帧**：先把 `RIP=0x401148` 记录为第 0 帧。这个 PC 属于 `checksum`。
2. **读当前 FP**：`fp = RBP = 0x7fff_efb0`。
3. **读返回地址**：`ra = *(fp + 8) = *(0x7fff_efb8) = 0x4011e0`。这个地址属于 `process`。
4. **读上一帧 FP**：`next_fp = *fp = *(0x7fff_efb0) = 0x7fff_efc0`。
5. **推进**：把 `PC=ra`、`FP=next_fp`，重复第 2 到第 4 步。
6. 最终得到地址栈：`0x401148, 0x4011e0, 0x401220, ...`，再交给符号化阶段显示 `checksum, process, main, ...`。

伪代码如下。真实实现还必须检查内存可读性、地址对齐和边界：

```c
frames.push(current_rip);
for (fp = current_rbp; valid(fp); fp = *(uint64_t *)fp) {
    uint64_t return_address = *(uint64_t *)(fp + 8);
    if (!valid_code_address(return_address)) {
        break;
    }
    frames.push(return_address);
}
```

```mermaid
flowchart TD
    A[寄存器现场: PC=checksum 内部, FP=0x...efb0] --> B[记录当前 PC]
    B --> C[读取 fp+8: 返回地址 process+offset]
    C --> D[读取 fp+0: 上一帧 FP=0x...efc0]
    D --> E[将 PC=返回地址, FP=上一帧 FP]
    E --> F{FP 和返回地址是否有效?}
    F -- 是 --> C
    F -- 否 --> G[得到 checksum <- process <- main]
```

### 5.3 FP 回溯为什么快

每一层只做两个固定偏移的内存读取：一个读上一个 FP，一个读返回地址。它不需要遍历大量规则，不需要解释函数中间任意位置的寄存器变化。因此：

- 适合低开销 profiler、崩溃处理器和受限运行环境。
- 适合在 eBPF 中作为用户栈 fallback 的概念基础。
- 对正常 C/C++ 业务代码，保留 FP 后通常稳定、速度很高。

但“快”来自于它假设所有函数都保持相同形状。一旦这个假设不成立，就会错。

### 5.4 FP 回溯会在哪里断掉

#### 情况 A：编译器省略帧指针

在 x86-64 优化构建中，编译器可能把 `rbp` 当普通寄存器用，而不是在入口生成：

```asm
push rbp
mov  rbp, rsp
```

此时 `rbp` 不再是“下一帧指针”，`[rbp]` 和 `[rbp+8]` 没有回溯语义。FP walker 若继续读，可能会得到随机局部数据，表现为异常大地址、调用链突然跳到无关库，或只剩当前一帧。

#### 情况 B：采样落在 prologue/epilogue 的中间

即使启用 FP，异步采样也可能发生在：

```text
call 后、push rbp 前
push rbp 后、mov rbp,rsp 前
leave 的两个子动作之间
```

此时新帧的 FP 链尚未完全建立，或已经开始拆除。可靠回溯器不能只看“函数入口/出口”，而要知道当前 PC 对应哪一种栈状态。DWARF CFI 能描述这种指令级变化。

#### 情况 C：栈损坏、栈切换或非标准运行时

递归越界、错误指针写入可能覆盖保存的 FP 或返回地址；协程、纤程、语言运行时也可能主动切换到另一块栈。此时链表可能不连续，或 `next_fp` 跳出线程栈的合法地址区间。健壮的实现应至少验证：

```text
next_fp > current_fp        （x86-64 向高地址回到外层帧）
next_fp 位于该线程的栈映射范围内
next_fp 按指针宽度对齐
return address 落在已执行代码映射中
```

### 5.5 应如何看待 `-fno-omit-frame-pointer`

它不是让程序“自动有完整调用栈”的魔法开关。它做的是让**编译器生成的普通函数**保留 FP 链，显著提高 FP 回溯的成功率。仍可能缺失：

- 内联或尾调用优化掉的逻辑函数。
- 未按该选项构建的第三方库。
- 信号 trampoline、JIT 代码、语言运行时或手写汇编。
- 栈已经损坏的异常现场。

所以生产 profiling 的常见策略是：优先使用 DWARF/CFI，FP 作为低成本回退；若系统只支持 FP 回溯，则对关键业务二进制统一开启 `-fno-omit-frame-pointer`。

## 6. 方法二：DWARF CFI 回溯

DWARF CFI 的核心思想与 FP 链完全不同。它不假定每个函数都使用相同布局，而是让编译器写下“在当前机器指令处，如何恢复调用者”的规则表。

### 6.1 为什么没有 FP 仍能回溯

看看一个省略 FP 的简化函数：

```asm
checksum:
    sub rsp, 0x28
    mov DWORD PTR [rsp+0x1c], edi
    ...
    add rsp, 0x28
    ret
```

这里没有 `rbp`，但 `ret` 仍必须能找到返回地址：它位于当前 `rsp + 0x28` 的位置。编译器比回溯器更清楚每条指令怎样改了 `rsp`，于是它可以在 `.eh_frame` 或 `.debug_frame` 写规则，例如：

```text
PC 范围 checksum+0x00 .. checksum+0x04：
  CFA = rsp + 8
  返回地址 RA 在 CFA - 8

PC 范围 checksum+0x04 .. checksum+0x30：
  CFA = rsp + 0x30
  返回地址 RA 在 CFA - 8
```

这里的 CFA 可以理解为“调用者在调用之前的栈顶基准”。函数把 `rsp` 减了 `0x28`，而 `call` 曾压入 8 字节返回地址，所以当前 `rsp + 0x30` 就回到了调用者的栈顶。

### 6.2 用 CFI 逐步回溯同一个例子

假设采样时：

```text
PC  = checksum + 0x18
RSP = 0x7fff_ef90
RBP = 某个普通工作寄存器，不可信
```

解析器查到 `checksum+0x18` 的 CFI 规则：

```text
CFA = RSP + 0x30 = 0x7fff_efc0
RA  = memory[CFA - 8] = memory[0x7fff_efb8] = 0x4011e0
caller.RSP = CFA = 0x7fff_efc0
```

于是可以恢复：

```text
当前：checksum + 0x18
调用者 PC：0x4011e0（process）
调用者 SP：0x7fff_efc0
```

接着用 `process` 的返回地址范围再查它自己的 CFI，反复执行。你会发现它从不依赖 `rbp` 是不是 FP；只要 CFI 正确，就能跨越不同函数各异的栈布局。

```mermaid
flowchart TD
    A[当前 PC、寄存器现场] --> B[在 .eh_frame/.debug_frame 查 PC 所在规则行]
    B --> C[计算 CFA，例如 RSP + 0x30]
    C --> D[按规则恢复 RA 和被保存寄存器]
    D --> E[得到 caller 的 PC/SP/必要寄存器]
    E --> F{caller PC 有 CFI 且仍在合法栈?}
    F -- 是 --> B
    F -- 否 --> G[停止并输出已恢复帧]
```

### 6.3 `.eh_frame`、`.debug_frame` 与“DWARF 能做什么”

这几个概念容易混淆：

| 数据 | 常见位置 | 主要目的 | 没有它的后果 |
| --- | --- | --- | --- |
| `.eh_frame` | 可执行文件/共享库，常保留在 release | 异常展开、运行时回溯 | C++ 异常与可靠 runtime unwind 可能受影响 |
| `.debug_frame` | 通常在 debug info | 调试器的调用帧规则 | 调试/离线分析信息变少 |
| `.debug_info` / `.debug_line` | debug info | 函数、类型、源码行、inline 信息 | 可能仍能回溯 PC，但难以显示行号 |
| `.symtab` / `.dynsym` | ELF 符号表 | 名称与地址范围 | 可能只能显示 binary+offset |

严格地说，**CFI 负责“怎样回到调用者”**；而 **DWARF 的函数/行号信息负责“这个地址在人类看来叫什么”**。两者常一起被称为“DWARF”，实际职责不同。

### 6.4 DWARF 回溯的优点与代价

优点：

- 对省略帧指针、复杂栈调整、保存多个寄存器的优化代码更可靠。
- 可在函数 prologue/epilogue 的中间根据 PC 使用不同规则。
- 与异常处理、调试器、许多语言运行时的标准机制兼容。

代价：

- 规则是压缩的字节码/状态机，解析和执行都比读两个指针复杂。
- 在 eBPF 内核程序中会遇到验证器限制：循环、内存访问、程序大小和 map 交互都受约束。
- 目标二进制必须保存足够的 CFI，且采集器必须拿到与运行中模块匹配的映射/规则。
- JIT 代码、加载后生成的代码或已卸载模块仍需额外的运行时支持。

### 6.5 perf_ebpf 的对应实现

`perf_ebpf` 中的 `EnhancedUnwinder` 会读取目标进程映射，解析二进制的 EH frame/unwind delta，并同步到 BPF map；native unwinder BPF 在 perf event/调度事件上下文中根据这些规则展开，并通过 `nu_trace` 送回用户态。若 native/DWARF 展开得到的用户帧为空或很浅，`CPUTracker::processEnhancedTrace()` 会使用 `user_stack_id` 的 FP/stack-map 结果作为 fallback。

因此在该项目里，“DWARF 回溯”和“后端 FlameCraft 的符号化”也要分开：前者发生在采集端，用来从现场得到更多地址帧；后者消费已经写出的 `binary+offset`，尝试把它们变成人类可读的函数名。

## 7. 方法三：eBPF/perf 栈采样

第三种常见说法“eBPF 回溯”实际上要再拆开：BPF 程序通常不自己从头扫描用户内存，而是调用内核提供的 helper，由内核收集当前上下文的栈地址并存进 stack trace map。

### 7.1 最小 eBPF 栈采样模型

典型的 on-CPU BPF 逻辑是：

```c
int kstack_id = bpf_get_stackid(ctx, &stack_traces, 0);
int ustack_id = bpf_get_stackid(ctx, &stack_traces,
                                BPF_F_USER_STACK);
```

它返回的不是函数名，也通常不是地址数组本身，而是一个 stack ID。概念数据结构如下：

```text
stack_counts:
  (tgid, comm, user_stack_id, kernel_stack_id) -> count

stack_traces (BPF_MAP_TYPE_STACK_TRACE):
  user_stack_id   -> [0x7f..., 0x7f..., 0, ...]
  kernel_stack_id -> [0xffffffff..., 0xffffffff..., 0, ...]
```

用户态采集器稍后根据 stack ID 读取地址数组，结合 PID 的 `/proc/<pid>/maps` 和 ELF 才能显示为 `libfoo.so+0x1234 [u]` 或内核函数名。

### 7.2 这个方法与 FP/DWARF 的关系

`bpf_get_stackid()` 是一个**采集接口**，不是第四种独立的数学原理。底层能回溯出多深、如何处理用户栈，依赖内核、架构、当前上下文和实现能力；结果仍是一串地址。更准确的对比是：

```text
FP 回溯：       根据 FP 链，从用户态或采集器自己读取调用者。
DWARF 回溯：    根据 CFI 规则，从寄存器/栈恢复调用者。
bpf_get_stackid：请求内核在 BPF 上下文中帮忙捕获一个地址栈，并以 ID 保存。
```

在实际系统中，它们可以组合：采集器优先使用 native/DWARF 获得用户栈，失败时让 BPF stack map 提供 FP/内核栈 fallback；这正是 `perf_ebpf` 当前 on-CPU 主路径的策略。

### 7.3 eBPF 采样的一次完整生命周期

```mermaid
sequenceDiagram
    participant CPU as 某个 CPU
    participant Perf as perf event / tracepoint
    participant BPF as eBPF 程序
    participant Map as BPF maps
    participant Agent as perf_ebpf 用户态
    participant Sym as 映射与符号化

    CPU->>Perf: 周期采样或调度事件到达
    Perf->>BPF: 传入当前上下文 ctx
    BPF->>Map: bpf_get_stackid(user/kernel)
    BPF->>Map: 聚合 key 的 count 或 duration
    Agent->>Map: 读取 stack ID 对应地址数组
    Agent->>Sym: 用 pid maps 把地址变为 binary+offset
    Sym-->>Agent: 函数名或保留 binary+offset
    Agent-->>Agent: 写 folded 栈/发送 profile
```

### 7.4 深度限制和数据质量

`BPF_MAP_TYPE_STACK_TRACE` 有固定 value size。例如 perf_ebpf 的兼容 `profile.bpf.c` 设置 127 个 `u64` 地址。深度不是越大越好：内核有 `kernel.perf_event_max_stack` 限制，超过限制可能使 map 创建或采集失败。

另外，读取栈地址数组时不要只看到 `0` 才结束。有效帧后的 map 槽位在异常情况下可能留下非零垃圾；对 x86-64 还应校验 canonical address。用户地址通常不高于 `0x00007FFFFFFFFFFF`，内核地址通常不低于 `0xFFFF800000000000`；落在中间空洞的“大地址”不可能是合法指令地址，应在进入符号化前过滤。

### 7.5 on-CPU 与 off-CPU 如何分别使用它

| 场景 | 触发点 | 栈的意义 | 权重 |
| --- | --- | --- | --- |
| on-CPU | 每 CPU 的 `PERF_COUNT_SW_CPU_CLOCK` | CPU 被打断那一刻正在执行的路径 | 样本次数，后续乘采样 period 估算 CPU 时间 |
| off-CPU | `sched_switch` 保存睡眠起点，`sched_wakeup` 完成事件 | 线程进入等待时的路径；还可记录唤醒者路径 | `wakeup - sleep_start` 的等待时长 |

off-CPU 的一个特殊点是：必须在 `sched_switch` 时抓被切出线程的用户栈，因为那时它还是 current task，用户态上下文可用；等到它睡眠后再读取该用户栈，往往已经不可靠。

## 8. 三种方法的完整对比与选型

### 8.1 核心差异表

| 维度 | FP 链回溯 | DWARF CFI 回溯 | eBPF/perf stack capture |
| --- | --- | --- | --- |
| 直接依据 | 栈中的 saved FP + return address | CFI 规则 + 当前 PC/寄存器/栈 | 内核 helper 返回的 stack ID/地址数组，或 BPF native unwinder 输出 |
| 是否依赖 `-fno-omit-frame-pointer` | 强依赖 | 不依赖 FP | 取决于内核/采集器底层路径；FP 常是 fallback |
| 能否处理优化代码 | 经常较差 | 通常较好 | 取决于内核能力和是否整合 DWARF/native unwinder |
| 实现开销 | 每层两个读，极低 | 需要查表和执行规则，中等/高 | BPF 侧较低，但 map、用户态归属、符号化组成完整成本 |
| 适合何处 | crash handler、轻量 profiler、FP 保留的服务 | 调试器、离线分析、完整 profiler | 生产系统在线采样、内核/用户态联合观测 |
| 常见失败 | FP 被省略、栈损坏、prologue 中间 | CFI 缺失/不匹配、JIT/模块映射缺失 | 权限、深度上限、PID namespace、地址/栈 map 数据质量 |
| 能直接得到函数名吗 | 不能 | 不能；仍需符号化 | 不能；通常先得到地址或 binary+offset |

### 8.2 选型建议

```text
需要极低开销，且你能控制编译选项？
  -> 保留 FP，使用 FP 回溯；必要时加 DWARF 兜底。

需要在优化代码上尽量完整地调试/离线分析？
  -> 提供 .eh_frame / debuginfo，优先 DWARF CFI。

需要在线观测任意进程的 on-CPU/off-CPU 行为？
  -> eBPF/perf 做事件采集；用户栈采用 native/DWARF + FP fallback；服务端做映射和符号化。

需要源码文件和行号？
  -> 无论前面怎样回溯，都还需要匹配 Build ID 的 DWARF debug info。
```

最现实的工程答案往往是“组合”，不是三选一：保留关键服务的帧指针，采集器优先走 DWARF，无法展开时回退到 stack map/FP；同时将未 strip 二进制或独立 debuginfo 按 Build ID 保存，供后续符号化。

## 9. 回溯结束后：地址如何变成函数和源码行

回溯器输出的是 PC/返回地址序列，例如：

```text
0x0000555555555148
0x00005555555551e0
0x0000555555555220
```

它们在本次运行中可能对应 `checksum`、`process`、`main`，但 CPU 并不附带这些名字。符号化至少分成两个不可省略的计算：**找到地址所属映射**，再**转换到 ELF 的符号坐标系**。

### 9.1 先用 `/proc/<pid>/maps` 找模块

假设进程 PID 为 4242，看到以下映射：

```text
555555554000-555555555000 r--p 00000000 ... /opt/demo/stack_demo
555555555000-555555556000 r-xp 00001000 ... /opt/demo/stack_demo
555555556000-555555557000 r--p 00002000 ... /opt/demo/stack_demo
7f20a0000000-7f20a0020000 r-xp 000a3000 ... /lib/libstdc++.so.6
```

每行最重要的字段是：

```text
地址范围 [map_start, map_end)     文件内起始偏移 file_offset        映射到的文件
555555555000-555555556000          00001000                       stack_demo
```

若回溯得到运行时地址：

```text
runtime_pc = 0x555555555148
```

它落在第二行，因此属于 `stack_demo` 的可执行映射。**文件偏移**应计算为：

```text
file_offset = runtime_pc - map_start + mapping.file_offset
            = 0x555555555148 - 0x555555555000 + 0x1000
            = 0x1148
```

`+ mapping.file_offset` 不能省略。一个 ELF 文件的可执行段常常不是从文件偏移 0 映射；把 `runtime_pc - map_start` 误当文件偏移，会在这种情形少算 `0x1000`，导致函数解析系统性偏移。

```mermaid
flowchart LR
    A[运行时 PC<br/>0x555555555148] --> B{落入哪个 maps 区间?}
    B --> C[stack_demo 的 r-xp 映射<br/>start=0x555555555000<br/>file_offset=0x1000]
    C --> D[file offset = PC - start + file_offset<br/>0x1148]
    D --> E[结合 ELF PT_LOAD 与类型归一化]
    E --> F[查询符号表 / DWARF]
    F --> G[checksum+0x18<br/>stack_demo.c:5]
```

### 9.2 为什么还要区分 PIE、共享库和 ELF 的 load segment

`file_offset` 已经足以解释很多 profile 文本中的 `binary+0x...`。但符号表 `st_value` 使用的是 ELF 虚拟地址坐标，而不是永远等于文件偏移。因此通用符号化器还必须考虑 ELF 类型和 `PT_LOAD` 段：

| ELF 类型 | 常见对象 | 特点 | 地址归一化要点 |
| --- | --- | --- |
| `ET_EXEC` | 非 PIE 主程序 | 链接时已有固定虚拟地址布局 | 需要考虑最小 load virtual address |
| `ET_DYN` | `.so`，以及多数 PIE 主程序 | 运行时加载基址随机化 | 从 runtime address 扣除实际映射基址并对齐段偏移 |
| `ET_REL` | `.o` 目标文件 | 尚未完成运行时装载 | 通常不直接作为进程映射符号化对象 |

FlameCraft 的查询侧 `NormalizeAddress()` 会依据 mapping 的 start/limit/offset 与 ELF program header 计算 base，再执行：

```text
symbol_address = runtime_address - base
```

这个看起来不起眼的步骤决定了“拿到了正确 ELF 却查不到符号”的问题能否被避免。ASLR 只改变运行时装载位置，不会改变函数在 ELF 内的相对位置；归一化正是在剥离 ASLR。

### 9.3 一个共享库的算例

继续使用 maps 中 `libstdc++.so.6` 的映射：

```text
map_start   = 0x7f20a0000000
map_end     = 0x7f20a0020000
file_offset = 0x000a3000
runtime_pc  = 0x7f20a0004567
```

先得到：

```text
file_offset = 0x7f20a0004567 - 0x7f20a0000000 + 0xa3000
            = 0xa7567
```

然后以该库自己的 ELF load segment 规则转换到符号表地址，才能在 `.symtab` 或 `.dynsym` 中做二分查询。若命中某个符号范围：

```text
symbol.start = 0xa7400
symbol.size  = 0x220
target       = 0xa7567
```

则：

```text
函数 = symbol.name
函数内偏移 = target - symbol.start = 0x167
显示 = symbol.name + 0x167
```

函数的完整名字可能被 C++ name mangling 编码，例如 `_ZN3foo3barEi`；demangle 后才显示为 `foo::bar(int)`。

### 9.4 函数名和源码行号是两个层次

| 目标 | 最少需要什么 | 典型来源 |
| --- | --- | --- |
| 显示 `foo::bar+0x167` | 可匹配 ELF 的函数符号范围 | `.symtab`，回退 `.dynsym` |
| 显示 `src/foo.cc:87` | 匹配 Build ID 的 DWARF line table | `.debug_info`、`.debug_line` 或独立 `.debug` 文件 |
| 显示内联层级 | DWARF inline DIE / call-site 信息 | 完整 DWARF |

因此 release 二进制被 strip 后只显示 `libfoo.so+0xa7567` 不等于采集失败；它常表示地址回溯与模块归属成功，只缺少函数名称材料。若必须做源码级根因定位，应该保留与运行版本 Build ID 匹配的 debuginfo，而不是用另一版本的未 strip 二进制“猜测”。

### 9.5 `addr2line` 是验证工具，不是地址公式

对一个已确认匹配的未 strip ELF，可以用：

```bash
addr2line -e /opt/demo/stack_demo -f -C 0x1148
```

预期会打印函数名与 `stack_demo.c:行号`。但以下前提缺任何一个，结果都可能误导：

1. 地址必须已经是该 ELF 的正确文件/符号坐标，不是另一进程的 ASLR 运行时虚拟地址。
2. ELF 必须与运行时 Build ID 相同。
3. `addr2line` 不会凭空恢复已 strip 掉的本地函数名和 DWARF 行表。
4. 即使工具显示“最近的前一符号”，地址若落在该符号 size 之外的巨大间隙，也不能把它当作确证。

这也是 FlameCraft 导入时保留 `binary+offset` 的原因：解析失败时保留可复核的证据，比编造一个看似合理的函数名安全得多。

## 10. 把同一个现场分别交给三种回溯法

仍假设程序停在 `checksum` 内：

```text
PC  = checksum + 0x18 = 0x555555555148
SP  = 0x7fff_ef90
FP  = 0x7fff_efb0（仅 FP 未省略时有意义）
```

### 10.1 FP 方法看到的证据

```text
寄存器：FP = 0x7fff_efb0
内存：
  [0x7fff_efb0] = 0x7fff_efc0   -> 上一帧 FP
  [0x7fff_efb8] = 0x5555555551e0 -> process 的返回 PC

输出地址序列：
  checksum+0x18 <- process+0x30 <- main+0x20
```

它没有读取 `.eh_frame`，也没有读 `/proc/<pid>/maps`。它只依赖当前栈和 FP 链，因此最快，也最依赖编译器没有破坏这个形状。

### 10.2 DWARF 方法看到的证据

```text
寄存器：PC = checksum+0x18, SP = 0x7fff_ef90
.eh_frame 对 checksum+0x18 的规则：
  CFA = RSP + 0x30
  RA  = [CFA - 8]

计算：
  CFA = 0x7fff_efc0
  RA  = [0x7fff_efb8] = process+0x30

输出地址序列：
  checksum+0x18 <- process+0x30 <- main+0x20
```

这一次即使 `RBP` 被拿去存临时值，仍然可回溯，因为规则明确告诉了回溯器如何从 `RSP` 找到返回地址。

### 10.3 eBPF stack-map 方法看到的证据

```text
BPF helper 结果：
  user_stack_id = 391

stack_traces[391]：
  [0] = 0x555555555148
  [1] = 0x5555555551e0
  [2] = 0x555555555220
  [3] = 0

用户态再做：
  地址 -> /proc/4242/maps -> stack_demo+offset -> 符号化
```

这里 eBPF 程序本身只拿到了地址数组和 stack ID。它的优点是可以在 perf event、tracepoint 等内核观测点低侵入地收集大量样本；代价是仍要由用户态或服务端完成地址归属、符号化、聚合与质量过滤。

### 10.4 为什么三者会给出不同深度的栈

同一次采样出现以下现象是可能且正常的：

```text
FP：       checksum <- process
DWARF：    checksum <- process <- main <- libc_start_main
eBPF：     checksum <- process <- main（深度上限或内核策略截断）
```

它不自动说明其中某一个实现有 bug。首先检查：目标是否省略 FP、是否存在 CFI、采样时机是否在 prologue、是否达到 stack 深度上限、所用运行时是否有 JIT/协程栈、映射是否还可读。只有排除这些证据差异后，才应怀疑实现错误。

## 11. 与 perf_ebpf 和 FlameCraft 的精确对应

这一节把基础概念落回两个项目，帮助从源码验证前面的图不是抽象故事。

### 11.1 perf_ebpf 在哪里做了什么

| 项目位置 | 做的工作 | 对应本文哪一步 |
| --- | --- | --- |
| `bpf_common/profile.bpf.c` | `bpf_get_stackid()` 收集用户/内核 stack ID，并按 key 计数 | 第 7 节的最小 eBPF 栈采样 |
| `src/plugins/cputracker/cputracker_program.cc` | 每 CPU 创建 `PERF_COUNT_SW_CPU_CLOCK` perf event 并 attach BPF | on-CPU 的触发机制 |
| `src/plugins/cputracker/enhanced_unwinder.cc` | 同步进程 maps、解析/加载 unwind 信息、接收 `nu_trace` | DWARF/native 回溯的采集端实现 |
| `src/plugins/cputracker/cputracker.cc` 的 `processEnhancedTrace()` | 解码 frame data；DWARF 不足时读 `user_stack_id` fallback；写 on-CPU folded 行 | 地址栈 -> `binary+offset [u]` 文本 |
| `bpf_common/sched_tracker.bpf.c` | 在 `sched_switch` 保存睡眠起点/栈，在 wakeup 计算时长 | off-CPU 状态机 |
| `src/plugins/sched/sched_tracker.cc` | 读 stack map、生成 blocked/waker 或 DWARF 行 | off-CPU 文本输出 |

当前 on-CPU 主路径优先获得 native/DWARF frame data；当用户展开为空或很浅、而 `user_stack_id` 的 FP 栈更深时，才回退到 stack map。这正是“组合方案”的实际例子。

### 11.2 FlameCraft 在哪里做了什么

| 项目位置 | 做的工作 | 对应本文哪一步 |
| --- | --- | --- |
| `pkg/filereader/folded_parser.go` | 解析 on-CPU `process(pid);thread;frames count` | 文本调用栈 -> 结构化帧 |
| `pkg/filereader/offcpu_parser.go` | 解析扩展 blocked/waker 行与无前缀 DWARF 行；us 转 ns | off-CPU 语义与单位统一 |
| `pkg/binsymbolizer/symbolizer.go` | 找 ELF、查 `.symtab`/`.dynsym`、demangle | `binary+offset -> function+offset` |
| `pkg/symbolizer/normalize.go` | 用 mapping 与 ELF segment 归一化 runtime address | 处理 ASLR/ET_EXEC/ET_DYN |
| `pkg/symbol/addr2line/` | 用 DWARF/符号表还原函数、文件、行号 | 源码级符号化 |
| `pkg/query/flamegraph_arrow.go` | 合并相同调用路径，计算 cumulative/flat | 结构化 profile -> 火焰图 |

请特别注意方向约定：`cputracker.cc` 写 on-CPU folded 文本时从根到叶，所以 FlameCraft 导入 pprof 时需要反转为 leaf first；`sched_tracker.cc` 的 off-CPU stack map 帧是叶到根，FlameCraft 不应再反转。这里的“方向适配”完全独立于 FP/DWARF/eBPF 哪一种方法获得了地址。

## 12. 学习与排障时的检查清单

遇到“调用栈不完整”或“全是地址”时，按以下顺序检查，能避免把不同层的问题混到一起：

```text
1. 是否真的采到了样本/事件？
2. 回溯是从 PC/SP/FP/CFI 中得到几层地址？在哪一层断了？
3. 目标模块是否省略 FP、缺 CFI、被内联/尾调用，或使用非标准栈？
4. 地址是否能在同一进程、同一 PID namespace 的 maps 中找到？
5. file offset 是否包含 mapping 的 offset，并经过正确 ELF base 归一化？
6. ELF 是否与运行时 Build ID 匹配？有 `.symtab`、`.dynsym` 或 DWARF 吗？
7. 火焰图输入方向、单位和聚合权重是否符合该 profile 类型？
```

不要跳到第 6 步就断言“符号缺失”。如果第 2 步已经把一个错误进程的地址拿去查另一个进程的 maps，或者第 5 步漏掉 `mapping.file_offset`，再完整的 debug info 也会给出错误结果或完全无法命中。

## 13. 总结

函数调用的本质是保存恢复现场并跳转；栈帧是这些恢复信息与局部状态的组织方式。回溯的本质是从当前 PC 和寄存器出发，重复恢复调用者的 PC 与栈状态：

```text
FP 方法：    “上一帧 FP 和返回地址总在固定位置。”
DWARF 方法： “编译器告诉我，在当前 PC 处它们分别在哪里。”
eBPF 方法：  “在内核观测点，请内核把当前地址栈捕获下来。”
```

三种方法不是简单的谁替代谁：FP 给低成本稳定路径，DWARF 处理优化代码的复杂布局，eBPF 提供在线、低侵入的事件采样入口。之后的地址归属、ELF 符号查询、DWARF 源码行恢复和火焰图聚合，构成了另一条同样不能省略的解释链。

## 参考资料与源码入口

- System V AMD64 ABI: x86-64 参数、寄存器保存与栈对齐约定。
- DWARF Standard: Call Frame Information、CFA、`.eh_frame` 与调试信息语义。
- `/sandbox/platform/perf_ebpf/bpf_common/profile.bpf.c`
- `/sandbox/platform/perf_ebpf/src/plugins/cputracker/cputracker.cc`
- `/sandbox/platform/perf_ebpf/src/plugins/cputracker/enhanced_unwinder.cc`
- `/sandbox/platform/perf_ebpf/bpf_common/sched_tracker.bpf.c`
- `/sandbox/FlameCraft/pkg/binsymbolizer/symbolizer.go`
- `/sandbox/FlameCraft/pkg/symbolizer/normalize.go`
- `/sandbox/FlameCraft/pkg/symbol/addr2line/`
- `/sandbox/FlameCraft/pkg/query/flamegraph_arrow.go`
