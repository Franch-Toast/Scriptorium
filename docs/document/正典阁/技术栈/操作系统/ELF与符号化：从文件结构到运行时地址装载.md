---
title: "ELF 与符号化：从文件结构到运行时地址装载"
date: 2026-10-09
description: "从 ELF 文件结构（节、符号表、DWARF、程序头）讲到运行时装载与地址换算：栈回溯产出的运行时虚拟地址如何一步步还原为函数名与源码行。"
categories:
  - 正典阁
tags:
  - 操作系统
  - ELF
  - 符号化
  - PIE
  - 调试
---

# ELF 与符号化：从文件结构到运行时地址装载

> 本文属于「栈回溯」系列，与同系列的 [函数调用与返回：AArch64栈帧与寄存器的逐步变化](./函数调用与返回：AArch64栈帧与寄存器的逐步变化.md)、[三种栈回溯方法总览](./栈回溯方法/index.md) 及其三个方法篇配套：它们回答“调用栈里有哪些地址、这些地址如何被找回”，本文回答“这些地址如何变回函数名与源码行”。主线刻意从静态到动态：先讲清 ELF 文件里装了什么（第 2 节），再讲它如何被装进进程（第 3 节），然后是地址如何在多套坐标系之间换算（第 4 节）、如何匹配到名字（第 5 节），最后是工程上如何守护这些符号材料（第 6 节）。

> 文中以 Linux x86-64 为主线，QNX/AArch64 的思想一致；所有地址都是教学用示例，真实数值随编译器、链接器与 ASLR 变化。示例围绕三个全程自洽的二进制展开：主程序 `stack_demo`（函数 `checksum`/`process`/`main`）、自制共享库 `libcalc.so`（函数 `add`）、系统库 `libstdc++.so.6`。

## 1. 全景：一个地址变成函数名要经过几关

栈回溯的产物是一串运行时虚拟地址，例如：

```text
0x0000555555555148
0x00005555555551e0
0x0000555555555220
```

它们在本次运行中可能对应 `checksum`、`process`、`main`，但 CPU 并不附带这些名字——名字是符号化系统根据 ELF 文件恢复出来的解释。从一串字节到一个函数名，要连续闯五关：

```mermaid
flowchart LR
    A["运行时虚拟地址<br/>(进程世界)"] -->|"1. 查 /proc/pid/maps"| B["所属映射<br/>哪个文件? 哪一段?"]
    B -->|"2. 算文件偏移"| C["file_offset<br/>(文件世界)"]
    C -->|"3. 查 PT_LOAD 图纸"| D["链接虚拟地址<br/>(图纸世界)"]
    D -->|"4. 符号表二分"| E["函数名 + 函数内偏移"]
    E -->|"5. DWARF 行号表"| F["源码文件:行号"]
```

这张图里出现了**三个世界**，它们是全文的主线：

| 世界 | 坐标含义 | 谁在用 |
| --- | --- | --- |
| 进程世界 | 运行时虚拟地址（含 ASLR 基址） | CPU、回溯器、`/proc/<pid>/maps` |
| 文件世界 | `file_offset`：字节在文件里的位置 | `mmap`、十六进制编辑器 |
| 图纸世界 | 链接时虚拟地址（符号表的 `st_value`） | 链接器、符号表、`addr2line` |

三个世界平时互不相等，把它们连起来的换算表就是 ELF 的 `PT_LOAD` 段。后面各节按顺序拆解每一关。

## 2. 概念篇：ELF 文件里到底装了什么

### 2.1 ELF 是什么：一个标准化的集装箱

**ELF（Executable and Linkable Format）**是 Linux/QNX 上可执行文件、共享库、目标文件（`.o`）、内核模块甚至 core dump 共用的容器格式，源自 System V，如今是 Unix 系的事实标准。可以把它想成一个标准化集装箱：机器码、只读常量、可写数据、符号表、调试信息都装在里面，分门别类打上标签。

箱壁上贴着**两张清单**，这是理解 ELF 的第一个关键：

| 清单 | 描述什么 | 谁来读 |
| --- | --- | --- |
| **Section headers**（节表） | “箱里分了哪些格”：内容按用途分类 | 链接器、`nm`/`objdump`、符号化器 |
| **Program headers**（程序头/段表） | “装载器该怎么把箱子搬进进程” | 内核、动态链接器 |

同一个文件，两个视角：**section 是内容分类，segment 是装载打包**。调试符号化主要读 section（符号表、DWARF），装载换算主要读 segment（`PT_LOAD`）。两者通过内容对应起来（见 2.6）。

用 `readelf -h` 看 ELF header 的关键字段：

```bash
$ readelf -h libcalc.so
  Magic:   7f 45 4c 46 02 01 01 ...   <- “\x7fELF” 魔数开头，02=64 位，01=小端
  Type:                              DYN (Shared object file)     <- e_type，2.2 讲
  Machine:                           Advanced Micro Devices X86-64
  Start of program headers:          64 (bytes into file)         <- 段表位置
  Start of section headers:          ...                          <- 节表位置
```

### 2.2 `e_type`：这个文件打算被怎么用（ET_EXEC、ET_DYN 是什么）

“这个文件打算被怎么用”记录在 ELF header 的 `e_type` 字段里，取值是一组 `ET_` 开头的常量（ET 就是 ELF Type 的缩写）：

| e_type | 名字含义 | 典型文件 | 链接时的地址起点 | 装载器怎么处理 |
| --- | --- | --- | --- | --- |
| `ET_REL` = 1 | RElocatable，可重定位 | `.o` 目标文件、内核模块 | 尚未确定，一切待链接 | 不直接装载；先链接成下面两种 |
| `ET_EXEC` = 2 | EXECutable | 用 `-no-pie` 链接的主程序 | 链接时焊死（x86-64 常从 `0x400000` 起） | 按图纸固定地址装载，load bias 恒为 0 |
| `ET_DYN` = 3 | DYNamic，共享对象 | `.so` 共享库、发行版默认的 PIE 主程序 | 从 0 开始摆，运行时才定基址 | 装载到任意基址，ASLR 每次随机 |
| `ET_CORE` = 4 | CORE 转储 | core dump | 保存的是崩溃当时的运行时地址 | 不被装载，而是被调试器/回溯器读取 |

于是“文件 → 角色”的常见对应是：

```text
libc.so.6              ET_DYN  ->  共享库（被动态链接器装载）
/bin/ls（发行版默认）   ET_DYN  ->  PIE 主程序（被 execve 装载，同样随机基址）
-no-pie 链接的程序      ET_EXEC ->  非 PIE 主程序（地址焊死）
main.o                 ET_REL  ->  编译中间产物（不参与运行时）
```

**PIE（Position Independent Executable，位置无关可执行文件）**的动机一句话就能说清：`ET_EXEC` 的固定地址让攻击者总能预测代码在哪，于是现代工具链默认按 `ET_DYN` 方式链接主程序，让内核也能对它做 ASLR——PIE 就是“把自己当作共享库来链接的主程序”。共享库与 PIE 在 ELF 层面同为 `ET_DYN`，唯一区别是运行时角色：一个被动态链接器装载，一个被 `execve` 装载。

最后用一个**搬家的比喻**把整套机制串起来，后文的图会反复用到它：

```text
链接器            = 装箱员：把函数装进集装箱，贴上“箱内位置”标签（符号表的 st_value，从 0 数起）
PT_LOAD          = 装箱清单：哪几格打包成一个箱子（p_offset -> p_vaddr）、放到什么位置、什么权限
内核/动态链接器   = 搬家公司：把箱子卸到某个门牌号（load bias），ASLR 让门牌号每次都不同
回溯器拿到的地址  = 某个包裹此刻的完整门牌号
符号化/归一化     = 从门牌号倒推回“哪个箱子、箱内第几格”，才能对上符号表里的标签
```

### 2.3 Section：链接视角下的“格子”

用 `readelf -S` 列出 libcalc.so 的节（节选）：

```bash
$ readelf -S libcalc.so
  [Nr] Name              Type              Address          Off    Size
  [ 5] .dynsym           DYNSYM            00000000000002c8 0002c8 000090
  [ 6] .dynstr           STRTAB            0000000000000358 000358 000080
  [ 9] .text             PROGBITS          0000000000001000 001000 0000f0
  [10] .fini             PROGBITS          ...
  [11] .rodata           PROGBITS          0000000000002000 002000 00001c
  [17] .data             PROGBITS          0000000000003000 003000 000010
  [18] .got              PROGBITS          ...
  [24] .symtab           SYMTAB            0000000000000000 003058 0001c8
  [25] .strtab           STRTAB            ...
  [26] .gnu_debuglink    PROGBITS          ...
```

常见节的职责：

| 节 | 内容 | 装载进进程吗 |
| --- | --- | --- |
| `.text` | 机器码 | 是（R E 段） |
| `.rodata` | 只读常量、字符串字面量 | 是（R 段） |
| `.data` | 已初始化可写全局变量 | 是（RW 段） |
| `.bss` | 未初始化/零初始化全局变量 | **是，但文件里没有内容**（见 2.6 的 `p_memsz`） |
| `.plt` / `.got` | 动态链接跳板与全局偏移表 | 是 |
| `.symtab` / `.strtab` | 完整符号表 / 名字字符串 | **否**，调试与符号化用 |
| `.dynsym` / `.dynstr` | 动态符号表 | 元数据不装载，但运行时必读 |
| `.debug_info` 等 | DWARF 调试信息 | **否**，见 2.5 |
| `.comment`、`.note.*` | 编译器版本、Build ID 等 | 否（Build ID 由工具读取） |

注意最后几行——`.symtab` 与 `.debug_*` 从不进任何 `PT_LOAD`。运行中的进程内存里根本没有它们；符号化器要回到磁盘上的文件（或独立 debug 文件）里去找。这就是“为什么 strip 只影响事后分析、不影响运行”的根本原因。

### 2.4 符号表：`.symtab` 与 `.dynsym`

ELF 通常同时携带两个符号表，职责完全不同：

| 属性 | `.symtab`（完整符号表） | `.dynsym`（动态符号表） |
| --- | --- | --- |
| 给谁用 | 调试器、符号化器、`addr2line`、静态链接器 | 运行时的动态链接器 |
| 收录范围 | 所有符号：导出、导入、以及 `static` 本地符号 | 只收动态链接需要的：`.so` 的导出符号 + 未定义导入 |
| strip 之后 | 通常被整体删除 | **必须保留**，运行时要用 |
| 何时可删 | 运行时完全用不到它 | 删了程序跑不起来 |

每个符号条目（`Elf64_Sym`）至少有四个字段，正好对应符号化用到的量：

| 字段 | 含义 | 用途 |
| --- | --- | --- |
| `st_name` | 指向字符串表（`.strtab`/`.dynstr`）的偏移 | 函数名来自这里 |
| `st_value` | 符号的链接时虚拟地址 | 二分查找的键（第 4、5 节的主角） |
| `st_size` | 符号大小（函数长度） | 判断地址是否落在该符号范围内 |
| `st_info` | 绑定（GLOBAL/LOCAL/WEAK）与类型（FUNC/OBJECT） | 区分函数与数据、导出与本地 |

一个容易忽略的事实：示例程序里的 `checksum` 是 `static` 函数，它只会出现在 `.symtab` 里（LOCAL 绑定），永远进不了 `.dynsym`：

```bash
$ nm stack_demo | grep checksum        # nm 默认读 .symtab
0000000000401130 t checksum            # 小写 t：本地（LOCAL）代码符号，仅存在于 .symtab
$ nm -D stack_demo | grep checksum     # -D 读 .dynsym
$                                      # 无输出：static 函数不参与动态链接
```

这解释了一个现象：主程序被 `strip --strip-all` 后，`.dynsym` 里的导出符号仍能显示名字，而 `checksum` 这类 static 函数彻底只剩 `stack_demo+0x1148`——它的名字唯一存放地就是被删掉的 `.symtab`。

另一个实用细节：C++ 支持重载，符号表里存的是 **name mangling** 编码名，例如 `_ZN3foo3barEi`；符号化器最后一步要 demangle 才显示为 `foo::bar(int)`。

### 2.5 调试信息：`.debug_*` 家族与 `.eh_frame`

符号表只回答“这个地址属于哪个函数”；要回答“属于源码第几行”，需要 DWARF 调试节：

| 节 | 内容 | 符号化时的用途 |
| --- | --- | --- |
| `.debug_info` | 编译单元/函数/变量的 DIE 树（类型、作用域） | 函数边界、内联层级 |
| `.debug_line` | 行号表：地址 -> 源文件：行 的映射 | `addr2line` 的数据来源 |
| `.debug_abbrev` | DIE 的缩写表（.debug_info 的解码字典） | 间接需要 |
| `.debug_str` | DWARF 字符串池 | 间接需要 |

一次编译产出的三类“解释材料”分工明确：

```text
机器码（.text）       ：做什么
符号表（.symtab）     ：地址 -> 函数名          （粒度：函数）
DWARF（.debug_*）    ：地址 -> 源码行/类型/内联 （粒度：行）
```

**`.eh_frame` 是个特例**：它同样使用 DWARF 的表达方式（CFA 规则），但用途是运行时栈展开（C++ 异常传播、`.eh_frame` 回溯），属于“运行必需”，strip 不删它；而 `.debug_*` 纯粹为调试服务，可以整体搬走。姐妹篇第 6 节的 DWARF 回溯依赖的正是 `.eh_frame`，与本文第 6 节的 debuginfo 拆分互不干扰。

### 2.6 Program header：装载视角的“图纸”

切换到装载视角。`readelf -l` 列出程序头（节选，列依次为 Offset / VirtAddr / Flags / Align）：

```bash
$ readelf -l libcalc.so | grep LOAD
  LOAD           0x000000 0x000000 R      0x1000
  LOAD           0x001000 0x001000 R E    0x1000
  LOAD           0x002000 0x002000 R      0x1000
  LOAD           0x003000 0x003000 RW     0x1000
```

每条 `PT_LOAD` 就是一条装箱指令，完整字段：

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| `p_offset` | 这段内容在**文件里**的起始偏移 | 文件世界坐标 |
| `p_vaddr` | 这段内容应出现的**虚拟地址** | 图纸世界坐标 |
| `p_filesz` | 从文件里读多少字节 | 代码、数据都有 |
| `p_memsz` | 在内存里占多少字节 | **`p_memsz > p_filesz` 的部分补零**——这就是 `.bss`：文件里不占空间，内存里必须存在 |
| `p_flags` | R / W / E 权限 | 内核据此设置页表 |
| `p_align` | 对齐要求 | 常见 0x1000（4K）或 0x10000（64K 大页） |

**为什么拆成四个 LOAD 段？**因为 MMU 按页设置权限：动态元数据只读、代码可执行、常量只读、全局数据可写。把不同权限的内容分装到不同 `PT_LOAD`，装载器才能逐段上锁；这也解释了“一个 ELF 为什么有多条图纸”。

其他常见程序头类型：

| 类型 | 内容 | 与符号化的关系 |
| --- | --- | --- |
| `PT_INTERP` | 动态链接器路径（如 `/lib64/ld-linux-x86-64.so.2`） | 决定装载流程（3.1 第 5 步） |
| `PT_DYNAMIC` | 指向 `.dynamic` 节：依赖列表 `DT_NEEDED`、符号表位置等 | `ld.so` 装载依赖库的依据 |
| `PT_NOTE` | `.note.*` 节，含 `.note.gnu.build-id` | **符号化与 debuginfo 的匹配凭据** |
| `PT_GNU_STACK` | 栈权限/可执行性 | 与符号化无关 |

最后把两个视角拼在一起——section 如何被打包进 segment：

```text
libcalc.so 的 section（内容分类）        装载图纸把它们打包成 segment（装载单元）

.hash      ─┐
.dynsym    ─┼─ 只读元数据            ──>  LOAD#1  R    off 0x0000  vaddr 0x0000
.dynstr    ─┘
.text      ─┐
.plt       ─┴─ 代码                 ──>  LOAD#2  R E  off 0x1000  vaddr 0x1000
.rodata    ─── 只读常量             ──>  LOAD#3  R    off 0x2000  vaddr 0x2000
.data      ─┐
.got       ─┴─ 可写数据             ──>  LOAD#4  RW   off 0x3000  vaddr 0x3000
.symtab    ─── 不进任何 LOAD（调试器/符号化器直接读文件）
.debug_*   ─── 同上，甚至可以被摘到独立文件（第 6 节）
```

## 3. 机制篇一：装载——文件如何变成进程地址空间

概念就位后，先看集装箱如何被卸车。这一节解释 `PT_LOAD` 图纸如何被内核与动态链接器执行，以及执行结果去哪里查看。

### 3.1 `execve` 之后发生了什么

以运行 `stack_demo` 为例，内核与动态链接器接力完成六步：

```text
1. 内核读文件开头，校验 ELF magic（\x7fELF）、e_type、e_machine
2. 遍历 program headers，收集所有 PT_LOAD 条目
3. 对每条 PT_LOAD：按 p_flags 权限 mmap 长度 p_memsz 的内存，
   文件内容取自 p_offset 起 p_filesz 字节，目标地址为 p_vaddr（+ 基址）
4. ET_EXEC：基址 = 0，装到图纸写死的地址；
   ET_DYN ：内核挑一个随机空闲基址（ASLR），整组 PT_LOAD 平移过去
5. 若存在 PT_INTERP：把动态链接器也装进地址空间，把入口交给它
6. ld.so 读主程序的 PT_DYNAMIC，按 DT_NEEDED 递归装载每个依赖 .so
   （对每个 .so 重复第 2–4 步），完成重定位后跳到 main；
   运行期的 dlopen 重复同样的过程
```

对符号化重要的是两件事：**每个 ELF 的装载位置在运行时才确定**（ET_DYN 尤甚），以及**装载结果有权威快照可查**——下一节的 maps。

### 3.2 ASLR 与 load bias

`ET_DYN` 的图纸从 0 开始画，真实落点由装载时的基址决定，这个基址就是 **load bias**（装载基址）：

```text
运行时地址 = load bias + 链接时虚拟地址（st_value 所在的图纸坐标系）
```

ASLR 让 bias 每次运行都不同（所以同一个函数每次采样地址都不同）；`ET_EXEC` 的 bias 恒为 0。回溯器拿到的是“门牌号”，符号表认识的是“箱内位置”，两者相差的正是 bias——第 4 节的归一化就是把它剥离。

### 3.3 装载结果的权威快照：`/proc/<pid>/maps`

maps 的每一行是一个映射，五个字段：

```text
7f20a0000000-7f20a0020000  r-xp  000a3000  08:01 1234567  /lib/libstdc++.so.6
└─── 1 ───┘└─── 2 ───┘     └─3─┘  └── 4 ──┘ └─5─┘   └──── 6 ────┘

1. 映射范围 [map_start, map_end)
2. 权限：r 可读 / w 可写 / x 可执行 / s 共享 / p 私有
3. mapping.file_offset：映射内容在文件里的起始偏移
4. 设备号（主:次）
5. inode
6. 被映射的文件（匿名映射为空，如堆栈）
```

同一份 `libcalc.so` 装载后会得到四行（与 2.6 的图纸一一对应，假设 ASLR 抽中基址 `0x7f20a0000000`）：

```text
7f20a0000000-7f20a0001000 r--p 00000000 libcalc.so    <- LOAD#1：bias + 0x0000
7f20a0001000-7f20a0002000 r-xp 00001000 libcalc.so    <- LOAD#2：bias + 0x1000
7f20a0002000-7f20a0003000 r--p 00002000 libcalc.so    <- LOAD#3：bias + 0x2000
7f20a0003000-7f20a0004000 rw-p 00003000 libcalc.so    <- LOAD#4：bias + 0x3000
```

符号化第一步“地址属于谁”就看这张表。假设回溯得到 `stack_demo` 的运行时地址：

```text
runtime_pc = 0x555555555148
```

它落在 `stack_demo` 的 r-xp 行，**文件偏移**应计算为：

```text
file_offset = runtime_pc - map_start + mapping.file_offset
            = 0x555555555148 - 0x555555555000 + 0x1000
            = 0x1148
```

`+ mapping.file_offset` 不能省略。一个 ELF 的可执行段常常不是从文件偏移 0 映射；把 `runtime_pc - map_start` 误当文件偏移，会在这种情形少算 `0x1000`，导致函数解析系统性偏移。

```mermaid
flowchart LR
    A[运行时 PC<br/>0x555555555148] --> B{落入哪个 maps 区间?}
    B --> C[stack_demo 的 r-xp 映射<br/>start=0x555555555000<br/>file_offset=0x1000]
    C --> D[file offset = PC - start + mapping.file_offset<br/>0x1148]
    D --> E[结合 ELF PT_LOAD 与类型归一化<br/>见第 4 节]
    E --> F[查询符号表 / DWARF<br/>见第 5 节]
```

### 3.4 页对齐细节：`mapping.file_offset` 与 `p_offset` 为什么可能不等

图纸条目（`p_offset`/`p_vaddr`）可以落在页中间，但内核 mmap 必须整页操作。假设某 RW 段声明 `p_offset = p_vaddr = 0x3d70`，内核会**向下取页**再映射：

```text
图纸：    p_offset = 0x3d70    p_vaddr = 0x3d70
实际映射：map_start = bias + 0x3d000（向下取页）
          mapping.file_offset = 0x3d000
```

于是同一字节出现了两套起点：`mapping.file_offset`（整页对齐后的映射起点）与 `p_offset`（图纸声明的段起点），差 `-0x70`。第 4 节归一化公式里那一项修正 `(mapping.file_offset - p_offset)` 就是为这种情形准备的——理想布局下它等于 0，真实二进制上它可能不为 0。

## 4. 机制篇二：地址换算——三套坐标系的对齐

### 4.1 前因：两套坐标系是怎么脱节的

回溯器拿到的是**运行时虚拟地址**——进程地址空间里此刻真实生效的地址，包含动态装载造成的偏移。而符号表每个函数的 `st_value` 是**链接时虚拟地址**——链接器当年摆放函数时使用的坐标。同一个 `checksum`，两种坐标可能完全不同：

```text
链接器视角（ELF 文件内）：        运行时视角（进程地址空间内）：

ET_EXEC 非 PIE 主程序：            内核固定装到链接地址，无重定位
  st_value = 0x401148                runtime = 0x401148          恰好相等

ET_DYN（.so 与 PIE 主程序）：      链接时一切从 0 计，装载时才定基址
  st_value = 0x1148                  runtime = 0x555555555148    差一个加载基址
```

对 `ET_DYN`，链接器把整个文件当作“从地址 0 开始”来布局；真实基址由内核和动态链接器装载时才决定，ASLR 还会让它每次运行都不同。两套坐标之间隔着一个**加载基址**（load bias，见 3.2）。直接拿运行时地址去符号表二分查找，对 `.so` 几乎必然查空。

那么“改用 `file_offset` 查符号表行不行”？——这正是最容易掉进去的坑。`file_offset` 回答“这个字节在**文件**里的哪里”，符号表的 `st_value` 回答“函数被链接到**虚拟地址**的哪里”。两套答案之间没有恒等关系，只有一条由 `PT_LOAD` 段定义的换算规则：

```text
虚拟地址 = file_offset - p_offset + p_vaddr
（p_offset、p_vaddr 是覆盖该 file_offset 的那个 PT_LOAD 段声明的属性）
```

`PT_LOAD` 是 2.6 节的“装载图纸”。**这份图纸在不同二进制上形状不同**，这才是必须区分三种情形的根本原因：

| 情形 | 典型对象 | 图纸的形状 | 直接拿 `file_offset` 查符号表的下场 |
| --- | --- | --- | --- |
| `ET_EXEC` | 非 PIE 主程序 | `p_vaddr` 常比 `p_offset` 大出一个固定基址（如 `0x400000`） | 系统性查空或命中错误符号：拿着 `0x1148` 找 `0x401148`，差 `0x400000` |
| `ET_DYN`（x86-64 常见布局） | `.so` 与多数 PIE 主程序 | 首段 `p_vaddr == p_offset == 0`，此后逐段页对齐 | **碰巧查对**——最危险，因为长期掩盖模型错误，直到换一种二进制才爆发 |
| `ET_DYN`（大页/特殊布局） | aarch64 64K 页构建、自定义 linker script | 段间 padding 使 `p_vaddr ≠ p_offset` | 系统性偏移一个 padding 量，每次都错、且错得“稳定” |

### 4.2 实例：libcalc.so 的三套坐标同屏

图纸（2.6）与装载结果（3.3）都已画过，现在把 `add` 的三套坐标放到同一张图上：

```text
add 的三个坐标：
  文件坐标   file_offset = 0x1100            （字节在文件里的位置）
  符号表坐标 st_value    = 0x1100            （图纸地址；本文件恰好 vaddr==offset）
  运行时坐标 runtime    = 0x7f20a0001100    （= bias + 0x1100，CPU 实际取指处）
```

现在把 3.3 的归属与上面的换算公式在同一个现场走完（采样恰好打在 `add` 内部）：

```text
runtime        = 0x7f20a0001135
1. 查 maps     -> 落在 r-xp 行：map_start = 0x7f20a0001000，mapping.file_offset = 0x1000
2. file_offset = 0x7f20a0001135 - 0x7f20a0001000 + 0x1000 = 0x1135
3. 查图纸      -> 0x1135 落在 LOAD#2（p_offset=0x1000，p_vaddr=0x1000）
4. symbol_addr = 0x1135 - 0x1000 + 0x1000 = 0x1135
5. 查 .dynsym  -> add（st_value=0x1100，st_size=0x60）命中
显示           -> add+0x35
```

对照搬家比喻：门牌号 `0x7f20a0001135` 被逐步还原成“LOAD#2 号箱、箱内第 0x35 格”，而箱子上贴的标签写着 `add`——符号化完成。

### 4.3 换一种图纸就会翻车：大页变体与 `ET_EXEC` 对照

**aarch64 上常按 64K 大页对齐**（`-Wl,-z,max-page-size=65536`），同一个 `add` 的图纸变成：

```text
LOAD#1  Offset 0x0000  VirtAddr 0x00000  R
LOAD#2  Offset 0x1000  VirtAddr 0x10000  R E     <- 文件偏移与图纸地址脱钩了
LOAD#3  Offset 0x2000  VirtAddr 0x20000  R
LOAD#4  Offset 0x3000  VirtAddr 0x30000  RW

add 仍是文件里 0x1100 处的字节，但图纸把它安排到 0x10000 + 0x100 = 0x10100：
  符号表坐标 st_value = 0x10100
  运行时坐标 runtime  = bias + 0x10100

同一现场再做归一化（bias 仍取 0x7f20a0000000，此时 r-xp 映射从 0x7f20a0010000 起、mapping.file_offset = 0x1000）：
  file_offset = 0x7f20a0010135 - 0x7f20a0010000 + 0x1000 = 0x1135
  symbol_addr = 0x1135 - 0x1000 + 0x10000 = 0x10100          -> add+0x35 ✓
  若跳过查图纸这步、直接拿 0x1135 去查 .dynsym               -> 命中无关符号或查空 ✗
```

这就是 4.1 表格第三行的完整实例：`vaddr == offset` 在 x86-64 小页布局里成立，换一种图纸就失效；只有按 `PT_LOAD` 逐段换算的符号化器，两种布局通吃。

**另一端的对照**——把 `stack_demo` 用 `-no-pie` 链接成 `ET_EXEC` 主程序，图纸是：

```text
LOAD  Offset 0x0000  VirtAddr 0x400000  R      <- 门牌号直接焊死在图纸上
LOAD  Offset 0x1000  VirtAddr 0x401000  R E

链接坐标 = 运行坐标（load bias 恒为 0），但文件坐标仍差 0x400000：
  file_offset(checksum) = 0x1148        st_value(checksum) = 0x401148
  这正是 4.1 表格里“拿着 0x1148 找 0x401148”那一行的出处。
```

### 4.4 统一算法与两个完整算例

把规则收拢成符号化器的实际动作（FlameCraft 查询侧的 `NormalizeAddress()` 即此逻辑）：

```text
1. 用 mapping 的 [start, end) 与 file_offset 找到覆盖它的 PT_LOAD 段
2. base = map_start - p_vaddr - (mapping.file_offset - p_offset)
   ET_DYN 上这一步剥离 ASLR 基址；ET_EXEC 上算出的 base 自然为 0
3. symbol_address = runtime_address - base
4. 用 symbol_address 在 .symtab/.dynsym 中做二分查找
```

两个算例验证。先看 `-no-pie` 版本的 `stack_demo`（maps 里可执行映射为 `0x401000-0x402000 r-xp 00001000`，对应 `PT_LOAD: p_offset=0x1000, p_vaddr=0x401000`）：

```text
file_offset    = 0x401148 - 0x401000 + 0x1000 = 0x1148
base           = 0x401000 - 0x401000 - (0x1000 - 0x1000) = 0
symbol_address = 0x401148 - 0 = 0x401148        <- 与 file_offset 差了 0x400000！
```

再看 `libstdc++.so.6`（映射 `0x7f20a0000000-0x7f20a0020000 r-xp 000a3000`，对应 `PT_LOAD: p_offset=0xa3000, p_vaddr=0xa3000`）：

```text
file_offset    = 0x7f20a0004567 - 0x7f20a0000000 + 0xa3000 = 0xa7567
base           = 0x7f20a0000000 - 0xa3000 - (0xa3000 - 0xa3000) = 0x7f209ff5d000
symbol_address = 0x7f20a0004567 - 0x7f209ff5d000 = 0xa7567
```

第二个算例里 `symbol_address` 恰好与 `file_offset` 同值——因为这个库的图纸恰好 `p_vaddr == p_offset`。这正是许多自制符号化器“一直没出事”的原因：把巧合当成了规律，直到遇到 `ET_EXEC` 或大页布局才集体查空。

```mermaid
flowchart LR
    A["运行时虚拟地址<br/>(含 ASLR/加载基址)"] -->|"查 /proc/pid/maps"| B["所属映射<br/>start / file_offset"]
    B -->|"file_offset = addr - start + mapping.file_offset"| C["文件偏移<br/>(字节在文件里的位置)"]
    C -->|"PT_LOAD: vaddr = file_offset - p_offset + p_vaddr"| D["ELF 链接虚拟地址<br/>(符号表坐标系)"]
    D --> E[".symtab/.dynsym 二分查找<br/>函数名 + 偏移"]
```

## 5. 机制篇三：从地址到名字——符号化的两个层次

### 5.1 函数名和源码行号是两个层次

| 目标 | 最少需要什么 | 典型来源 |
| --- | --- | --- |
| 显示 `foo::bar+0x167` | 可匹配 ELF 的函数符号范围 | `.symtab`，回退 `.dynsym` |
| 显示 `src/foo.cc:87` | 匹配 Build ID 的 DWARF line table | `.debug_info`、`.debug_line` 或独立 `.debug` 文件 |
| 显示内联层级 | DWARF inline DIE / call-site 信息 | 完整 DWARF |

因此 release 二进制被 strip 后只显示 `libfoo.so+0xa7567` 不等于采集失败；它常表示地址回溯与模块归属成功，只缺少函数名称材料。若必须做源码级根因定位，应该保留与运行版本 Build ID 匹配的 debuginfo，而不是用另一版本的未 strip 二进制“猜测”。

### 5.2 函数名层：符号表里怎么查

第 4 节的 `symbol_address` 是查表的输入。`.symtab`/`.dynsym` 在文件里是按 `st_value` 排序的数组，查询就是一次二分：

```text
1. 用 symbol_address 在有序符号数组中二分，找到 st_value <= symbol_address 的最后一个符号
2. 若 symbol_address < st_value + st_size -> 命中：
       函数名     = st_name 指向的字符串（demangle 后输出）
       函数内偏移 = symbol_address - st_value            （如 0x167、+0x35）
3. 若落在符号之间的空隙 -> 没有可靠函数名
   （输出“最近的前一符号+偏移”仅作参考，不能当确证——见 5.4）
```

4.4 算例的收尾正是这一步：`symbol_address = 0xa7567` 落在 `symbol.start = 0xa7400`、`symbol.size = 0x220` 的符号内，输出 `函数名+0x167`。C++ 符号是 mangled 名（如 `_ZN3foo3barEi`），最后再 demangle 成 `foo::bar(int)`。

### 5.3 源码行层：DWARF 行号表与 Build ID 匹配

行号还原需要 `.debug_line` 的行号表——它把地址区间映射到“源文件：行”，且随优化、内联而碎裂。使用前提比符号表更苛刻：

1. debuginfo 必须与运行时二进制**逐字节匹配**——凭据是 Build ID（2.6 的 `PT_NOTE`）；版本错位会让行号看似合理实则错行。
2. debuginfo 可以不在主文件里，但要能被找到（第 6 节的配对机制）。
3. 高优化等级下行号会跨语句“跳动”，内联帧需要按 DWARF inline 信息展开。

### 5.4 `addr2line`：验证工具，不是地址公式

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

## 6. 实战篇：符号材料的守护——strip 与 debuginfo 分包

前三节假设“材料都在”。生产环境恰恰相反：镜像越小越好，符号材料要靠制度保住。这一节讲清 `file` 输出在说什么、strip 到底剥掉了什么、debug info 为什么能单独摘出来。

### 6.1 先读懂 `file` 命令的输出

对示例程序执行 `file`：

```bash
$ file /opt/demo/stack_demo
/opt/demo/stack_demo: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV),
dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2,
BuildID[sha1]=8f2a3b..., for GNU/Linux 3.2.0, not stripped
```

每个字段都能对应到本文的某一节：

| 字段 | 含义 | 对应本文 |
| --- | --- | --- |
| `ELF 64-bit LSB pie executable` | 64 位小端 ELF；`e_type=ET_DYN` 的主程序（PIE） | 2.2：链接基址为 0，装载时才定基址 |
| `dynamically linked, interpreter ...` | 存在 `PT_INTERP`，运行前先加载动态链接器 | 3.1：动态装载决定 load bias |
| `BuildID[sha1]=...` | `.note.gnu.build-id` 节的内容 | 6.3：符号化与 debuginfo 的匹配凭据 |
| `not stripped` | 文件里还保留着 `.symtab` | 6.2 的主题 |

“not stripped”的判断标准很朴素：`file` 检查 ELF 里是否还有 `.symtab` 这个节。在就显示 `not stripped`，不在就显示 `stripped`。

### 6.2 stripped 到底意味着什么

`strip`（等价 `objcopy --strip-all`）删除的是：`.symtab`、`.strtab` 与全部 `.debug_*` 节。它不动：

| 保留的内容 | 为什么必须留 | 对本文的影响 |
| --- | --- | --- |
| ELF header 与 program header（`PT_LOAD`） | 内核装载与符号化换算的图纸 | 3.3/4 节照常工作 |
| `.dynsym`/`.dynstr`/`.gnu.version*` | 动态链接器运行时要用 | 导出函数仍可符号化 |
| `.eh_frame` | C++ 异常展开与运行时回溯要用 | 姐妹篇第 5–7 节的回溯完全不受影响 |
| `.note.gnu.build-id` | 调试与符号化的匹配凭据 | 仍可与独立 debug 文件配对 |

所以 **stripped ≠ 不能回溯，也不等于完全不能符号化**。它只意味着：本地符号（static 函数等）的名字来源被切断，符号化降级为 `.dynsym` 能查到的导出符号，或退回 `binary+offset`。

还有一个容易混淆的档位：`strip --strip-debug`（或 `objcopy --strip-debug`）只删 `.debug_*`，保留 `.symtab`。此时 `file` 仍显示 `not stripped`——因为 `file` 只看 `.symtab`，不看 DWARF。两个维度是独立的：

```text
not stripped  ->  .symtab 在（函数名大概率可查）
stripped      ->  .symtab 不在（只剩 .dynsym 里的导出符号）
有无 .debug_* ->  另一个独立维度，决定能否还原源码行号，file 不直接反映
```

### 6.3 debug info 可以单独摘出来吗？可以，而且是标准做法

DWARF 调试信息与运行毫无关系，生产镜像里通常不带它；但崩溃分析与源码级 profile 又需要它。标准做法是构建期把两类材料分家：

**构建期三步（objcopy 流）：**

```bash
# 1. 把调试节完整抽到独立文件（.debug 文件里代码节被置零，只留元数据）
objcopy --only-keep-debug stack_demo stack_demo.debug

# 2. 主文件只去掉调试节，保留 .symtab
objcopy --strip-debug stack_demo

# 3. 在主文件里写一条配对凭据：.gnu_debuglink 节 = 独立文件名 + CRC32
objcopy --add-gnu-debuglink=stack_demo.debug stack_demo
```

**调试器/`addr2line` 怎么把它们重新配对**：两条路任选其一。

1. `.gnu_debuglink`：按固定顺序搜索——独立文件与主文件同目录 → 同目录的 `.debug/` 子目录 → 全局调试目录（如 `/usr/lib/debug` 加主文件绝对路径）。
2. Build ID：独立文件按 Build ID 归档到 `/usr/lib/debug/.build-id/<前两位>/<其余>.debug`，工具拿主文件的 BuildID 直接查表——这也是 5.3 强调“按 Build ID 匹配”的原因。

**包管理器与后处理工具**：Debian 的 `*-dbgsym` 包、Fedora 的 `debuginfo` RPM，都是构建流水线自动执行上述拆分的产物，常用 `eu-strip -f`（elfutils）一步完成“抽取 + 写 debuglink + strip”。LLVM 还提供编译期拆分（`-gsplit-dwarf` 生成 `.dwo` 文件），思路相同：把调试材料从最终产物中分离。

**验证一次完整流程**：

```bash
$ file stack_demo                        # 本流程第 2 步用 --strip-debug，仍显示 not stripped
$ readelf -S stack_demo | grep debug     # 主文件里已无 .debug_* 节
$ addr2line -e stack_demo -f -C 0x1148   # 通过 .gnu_debuglink 自动找到 stack_demo.debug
checksum
/path/to/stack_demo.c:5
```

对工作流意味着：生产环境只部署主程序，把 `stack_demo.debug`（或发行版的 debuginfo 包）归档在符号化服务旁；FlameCraft 拿到 `binary+offset` 后即可按 Build ID 补全函数名与源码行。回溯、符号化，从头到尾都不需要把 debug info 塞回生产镜像。

## 7. 小结与检查清单

把全文收拢成一张图：ELF 文件里，section 视角提供了名字与解释材料（`.symtab`/`.dynsym`、`.debug_*`），program header 视角提供了装载图纸（`PT_LOAD`）；装载过程把图纸变成进程地址空间并留下 maps 快照，同时引入 load bias；符号化就是沿“进程世界 -> 文件世界 -> 图纸世界”把地址还原回符号表坐标系，再用符号表与 DWARF 匹配出名字与行号。

符号化不工作时，按这个清单排查（自上而下，先材料后算法）：

```text
1. 地址是否属于本进程？maps 是否取自同一 PID namespace 的同一时刻？
2. 归属映射时是否补上了 mapping.file_offset？（3.3）
3. 是否按 PT_LOAD 逐段换算，而不是假设 vaddr == offset？（4.1–4.4）
4. ELF 与运行时 Build ID 是否一致？
5. .symtab / .dynsym 还在吗？目标符号是 static（只进 .symtab）吗？（2.4/6.2）
6. 行号查不出：主文件与 debug 文件配对路径/Build ID 归档是否正确？（6.3）
7. 结果只有“最近的前一符号”时，地址是否落在符号 size 之外？（5.2/5.4）
```

## 参考资料与源码入口

- System V ABI / ELF Specification: ELF header、program header、`.symtab`/`.dynsym` 与 DWARF 节的权威定义。
- DWARF Standard: `.debug_info`、`.debug_line` 行号表语义。
- GNU Binutils: `readelf`/`nm`/`objcopy --only-keep-debug`/`--add-gnu-debuglink`、`strip` 的符号与调试节语义；elfutils `eu-strip` 与发行版 debuginfo 分包实践。
- 姐妹篇 [函数调用与返回：AArch64栈帧与寄存器的逐步变化](./函数调用与返回：AArch64栈帧与寄存器的逐步变化.md) 与 [三种栈回溯方法总览](./栈回溯方法/index.md)：调用栈的逐步变化、三种回溯方法与 profile 工作流全景。
- `/sandbox/FlameCraft/pkg/symbolizer/normalize.go`: 归一化 `NormalizeAddress()` 的实现。
- `/sandbox/FlameCraft/pkg/binsymbolizer/symbolizer.go`: 找 ELF、查 `.symtab`/`.dynsym`、demangle。
- `/sandbox/FlameCraft/pkg/symbol/addr2line/`: DWARF/符号表还原函数、文件、行号。
