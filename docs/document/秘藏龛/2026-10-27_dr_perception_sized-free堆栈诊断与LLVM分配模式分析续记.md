---
title: "dr_perception sized-free 排查续记：堆栈诊断与 LLVM 分配模式分析"
date: 2026-10-27
description: "记录 tcmalloc 堆栈诊断版本、QNX SDP8 重编结果、perception OpenCL 初始化栈与日志统计，并分析对象头加附加数据分配如何产生大跨度 size-class 错配。"
categories:
  - "秘藏龛"
tags: [tcmalloc, QNX, crash分析, sized-delete, OpenCL, LLVM]
---

# dr_perception sized-free 排查续记：堆栈诊断与 LLVM 分配模式分析

**后续台架运行已捕获大量 sized-free mismatch，其中一批可以定位到 perception 启动时的 OpenCL program 编译。大跨度 class 错配使排查从 realloc 扩展到“对象头与附加数据一起分配”的候选模式；历史 CentralFreeList 崩溃仍未定因。**

本文接续 [2026-10-22 排查记录](./2026-10-22_dr_perception_sized-free错配排查记录.md)。前篇保留历史 SIGSEGV 的寄存器、反汇编和运行包身份，并已补充错误 class 回收到 Span 后的真实破坏机制。本文记录 2026-10-26～27 的诊断版本演进、编译交付、堆栈与新假设，不重复完整解释中央链表。

## 1. 从主动 abort 改为主动采集堆栈

### 1.1 为什么改诊断方式

最初补丁在 sized free 使用 hint 的路径上，比较 hint class 与 PageMap 查到的 Span class，不同则输出字段并 `abort()`。台架测试中没有得到预期的堆栈和 tombstone，因此后续改为在诊断点直接采集当前栈，输出后继续原释放路径，以观察哪些位置会报告错配。

`abort()` 本身负责触发异常终止，不承诺打印可读调用栈。是否有 FailureWriter、信号处理器和 tombstone，还取决于进程初始化、注册时机和崩溃处理流程。后续确认部分 mismatch 位于程序加载初始化期间，因此“尚未注册到预期处理器”是合理候选；但没有取得当时处理器状态，不能把缺少 tombstone 确认为该原因。

### 1.2 源码提交与实际行为

参考仓库 `/sandbox/google-gperftools`，分支 `feat/free_sized_test`：

| 提交 | 日期 | 行为 |
| --- | --- | --- |
| `0b07e0cf56fd09037bb7220a28343d82103249f1` | 10-22 | mismatch 输出字段后 abort |
| `18b526f5d70d92d17a52ab4a23ca751a37a80445` | 10-26 | 直接采集当前栈，尝试输出模块偏移，外层 mismatch 不再主动 abort |
| `196b50c4b67f2da339e729f64212152b10dee7dc` | 10-26 | 逐帧格式对齐 spdlog 风格 |

当前诊断字段包括：

```text
ptr、size_hint、hint_class、actual_class、span、page_id
stack depth
#帧号 PC [in 符号] [at 模块路径] [(+模块偏移)]
```

`libtcmalloc_minimal` 编译启用 `TCMALLOC_HAVE_STACKTRACE` 后，通过 gperftools `GetStackTrace` 采集最多 32 帧；完整库的分支使用 `GrabBacktrace`。再逐帧调用 `dladdr`，以 `PC - dli_fbase` 计算模块偏移。可取得符号时输出符号，无法解析时仍保留原始 PC。单帧使用栈上字符缓冲区拼接并写入 stderr，不调用外部符号化程序。

实际日志样式，例如：

```text
src/tcmalloc.cc:1529] tcmalloc: sized free size-class mismatch; ptr= 0x56cd04f000 size_hint= 24
src/tcmalloc.cc:1532] hint_class= 3 actual_class= 45
src/tcmalloc.cc:1535] span= 0x56cb4b1290 page_id= 91017295
src/tcmalloc.cc:1545] tcmalloc: sized free stack depth= 12
#0 4836c44df4 in _ZdlPvm at /opt/usr/oem/opt/deeproute/common/lib/libtcmalloc_minimal.so.10 (+0xddf4)
#1 484392cd74 in _Z12dumpOBJToASMP15clcifOBJBufType18cl_compiler_targetP21QGPUDebugSrcLineCache at /ifs/lib64/libllvm-qcom-full.so (+0x1617d74)
```

模块偏移可以在有匹配 ELF 时直接离线解析，通常不必额外保存完整 maps 才能解析每帧；但要记录模块版本/Build ID。`dladdr` 只能提供其已知的符号，可能返回距离较远的导出符号，不能把每个 `in ...` 都当成精确函数名。

### 1.3 “继续原路径”的含义与扰动

外层 mismatch 报告结束后，没有按真实 class 纠正，而是继续：

```cpp
heap->Deallocate(ptr, hint_class);
```

这保留了错误对象进入错误缓存的机会，适合观察后续现象，但也意味着日志中的后来调用者可能已受到污染。当前检查只覆盖实际采用小对象 hint 的路径；hook、大尺寸、完整库采样相关回退等路径不能概括为全部覆盖。

线程局部重入标志防止诊断递归；重入期间若再发现 mismatch，对可识别的小对象改用真实 class，找不到 Span 则走 invalid-free 处理，class 0 走页释放路径。这与外层故意保留错误 hint 的行为不同。堆栈采集、动态加载器解析和日志耗时也会改变执行时序，因此该版本不是完全无扰动观测。

诊断代码没有显式逐次 `open` 文件、创建 pipe 或启动符号化子进程，当前不能由源码认定它泄漏 FD。用户另报告反复启动进程时 DEM 出现 `posix_spawn() failed: Bad file descriptor[sensor_camera]`，还需定位 DEM 的 spawn file-actions、FD 有效性和错误进程，不能直接归因到这段 stderr 输出。底层回溯器/加载器内部行为也不能仅凭外层没有 open 就全部排除。

## 2. QNX SDP8 重新编译与实验库身份

### 2.1 保留诊断并启用 SMALL_BUT_SLOW

为加快错误对象进入 Span 层的验证，2026-10-26 基于 `196b50c` 重新交叉编译，关键参数为：

```text
目标：QNX SDP8 / aarch64
CC：qcc -Vgcc_ntoaarch64le
CXX：q++ -Vgcc_ntoaarch64le
CFLAGS/CXXFLAGS：-D_QNX_SOURCE -DTCMALLOC_SMALL_BUT_SLOW -O2
configure：--host=aarch64-unknown-nto-qnx8.0.0
           --enable-shared --enable-static
           --with-tcmalloc-pagesize=4
           --with-tcmalloc-alignment=16
           --enable-sized-delete
```

`TCMALLOC_SMALL_BUT_SLOW` 禁用 transfer cache，并将默认 overall thread-cache 预算从 32MiB 降至 4MiB。**它没有取消 ThreadCache**，不能等价为每次 free 都立即操作 Span。它使相关错误更容易经过 `ReleaseToSpans`，也明显改变内存使用和并发时序，属于实验配置。

宏通过此次构建的 CFLAGS/CXXFLAGS 加入，未写回 `build_tcmalloc_sdp8.bash`。原脚本会重新设置这些变量；直接再次执行原脚本不会自动复现本次宏配置。QNX 环境脚本要求在 bash 中 source，不能在 zsh 中直接 source 后假定工具链配置成功。

### 2.2 产物与验证范围

| 项目 | 结果 |
| --- | --- |
| minimal 实体库 | `/sandbox/google-gperftools/.libs/libtcmalloc_minimal.so.10` |
| minimal 软链接 | `/sandbox/google-gperftools/.libs/libtcmalloc_minimal.so` |
| 完整库 | `/sandbox/google-gperftools/.libs/libtcmalloc.so.10` |
| minimal 大小 | 211424 bytes |
| ELF | 64 位 ARM aarch64 动态库，not stripped |
| minimal Build ID | `cc9bc953901df0177cf646b6a7bcb5c9` |
| minimal SHA256 | `cf7ed2f75f14bc857bc0e5451ee1c2e87b8fc21d7922a8a09c6afb8f50550c8e` |
| 已核对内容 | `_ZdlPvm`、`tc_free_sized` 导出和 mismatch 字符串存在；构建参数含宏 |
| 动态依赖 | `libunwind.so.8`、`libc++.so.2`、`libm.so.3`、`libc.so.6`、`libgcc_s.so.1` |

整体 `make -j12` 在测试程序 `sampler_test` 链接时失败，报缺少 `MallocExtension::instance()` 和 `TCMallocGuard` 等符号。两个共享库已成功生成，随后单独复核 `libtcmalloc_minimal.la`、`libtcmalloc.la` 目标成功。**这不是“全部构建和单测通过”**；QNX aarch64 测试未在 Linux 宿主机执行，本文也没有记录该 SMALL_BUT_SLOW 实验库的目标机复现结果。

上述身份是此次本地实验产物的记录，后续重新构建可能覆盖同一路径。它与 10-22 历史崩溃库不是同一个构建，也不能据此认定下节日志就是使用它采集的。

## 3. 堆栈定位：perception 启动时编译 OpenCL program

### 3.1 本次核对的源码版本

用于业务调用链核对的相关仓库切换到 `release_candidate/prod_159478_Release_LP_8797_0912`：

| 仓库 | commit |
| --- | --- |
| `/sandbox/perception` | `7dac7622df` |
| `/sandbox/platform` | `5fa32867b0` |
| `perception/submodules/lidar` | `78534e7b42` |
| `perception/submodules/aeb` | `139e2c4ecc` |
| `perception/submodules/base` | `a589d32f6e` |

这些是分析源码快照，不是新日志所用全部 ELF 的源码身份证明，也不代表整个多仓工作区已同步。源码行号以这些 commit 为准。

### 3.2 实际调用链

`platform/base/hpc_hal/context/cl_ctx_manager.h:172` 的 `REGISTER_PROGRAM_2` 生成带 `__attribute__((constructor))` 的函数：

```cpp
CLContextManager::Instance().RegisterProgram(program_name, kernel_source);
```

它在程序加载初始化阶段执行，转发到 `Context::RegisterProgram`。该函数在 `cl_ctx_manager.cc:54` 创建源程序，在第 63 行调用 `clBuildProgram`。原始日志还出现 `_init_array`，与以下路径一致：

```text
程序加载初始化数组
  → REGISTER_PROGRAM 生成的初始化函数
  → CLContextManager::RegisterProgram
  → Context::RegisterProgram
  → clBuildProgram
  → libOpenCL_Adreno.so：qCLDrvAPI_clBuildProgram
  → libCB-full.so：cb_build_program / cl_program_build_immediate
  → libllvm-qcom-full.so：源码编译、内置运行库链接、内部对象清理
  → operator delete(void*, size_t)，_ZdlPvm
  → tcmalloc mismatch 诊断
```

这类 stack 不需要先执行一帧实际点云处理，也不代表 OpenCL kernel 已在 GPU 上发生越界。上层是算子的 program 编译，错误释放发生在同一进程中的 CPU 侧编译器代码路径。

### 3.3 与业务模块和 program 名称对应

`perception_modules_impl` 引入 lidar、AEB 等 processor。QNX 下的检测前后处理链接相应 OpenCL 算子；公共 `GatherNDCalculator` 则依赖 `gather_nd_opencl`。这些源码中的注册宏会提前触发 program 编译。

| program | 业务归属 | 注册位置，相对 `/sandbox/perception` |
| --- | --- | --- |
| `points_in_box` | lidar 点与检测框关系计算 | `submodules/lidar/accel_ops/opencl/points_in_box.cpp:331` |
| `detector_utils` | lidar 检测解码、voxelize 等工具算子 | `submodules/lidar/accel_ops/opencl/detector_utils.cpp:2150` |
| `point_sample` | lidar 点云采样 | `submodules/lidar/accel_ops/opencl/point_sample.cpp:621` |
| `occupancy` | lidar occupancy 算子 | `submodules/lidar/accel_ops/opencl/occupancy/occupancy.cpp:1997` |
| `anomalies` | lidar 异常检测算子 | `submodules/lidar/accel_ops/opencl/anomalies/anomalies.cpp:222` |
| `gather_nd` | 公共 GatherND 算子 | `submodules/base/ops/opencl/gather_nd.cpp:186` |
| `points_in_box_aeb` | AEB 点与检测框关系计算 | `submodules/aeb/accel_ops/opencl/points_in_box.cpp:407` |
| `detector_utils_aeb` | AEB 检测后处理工具算子 | `submodules/aeb/accel_ops/opencl/detector_utils.cpp:449` |

运行时 `GatherNDCalculator` 在 `gather_nd_calculator.cc:238` 调用 `GatherND4D`，但这不是上述初始化编译栈必须经过的业务入口。

## 4. 已有日志说明了什么

分析文件 `/sandbox/temp/perception_stdout.log`，包含 2026-10-26 台架运行输出。原始文件前段的 program 开始标记不完整，不能假定第一个可见 mismatch 就是进程首次错配。

### 4.1 按 program 编译区间统计

全文件有 731 条 mismatch 起始标记，730 条可以完整解析出指针及两种 class。按 `RegisterProgram` 与 `Build program success` 标记划分：

| program 区间 | mismatch 标记数 |
| --- | ---: |
| `points_in_box`，仅有成功标记及 kernel 名，推断归组 | 16 |
| `detector_utils` | 44 |
| `point_sample` | 25 |
| `occupancy` | 63 |
| `anomalies` | 30 |
| `gather_nd` | 13 |
| `points_in_box_aeb` | 23 |
| `detector_utils_aeb` | 34 |
| 上述注册区间之外 | 483 |
| 合计 | 731 |

启动编译区间合计 248 条；其余 483 条不能全部归到该初始化调用链。时间区间分组也不等于每条日志都已取得完整对象历史，多线程输出可能交错，栈还可能被 32 帧上限截断。

### 4.2 重复地址与释放栈

730 条完整记录涉及 366 个不同地址，其中 133 个地址重复出现。例如 `0x56d6925c00` 出现 22 次，11 次 hint 为 24，11 次 hint 为 32，actual class 都是 23。

这与错误大对象进入小对象缓存后被反复复用的机制相容，不能将 22 次日志等同为 22 个独立错误源；也不能仅凭地址相同排除正常复用、重复释放或不同分配代次。

首条可完整解析记录位于原日志第 277 行：

```text
ptr=0x56cbe18680, size_hint=24, hint_class=3, actual_class=24
释放上层：clang::StdCLRuntime::buildBuiltinFromStaticBC(...)
```

此外还有 `CodeGenTypes`、`SourceManager` 析构，以及内置运行库链接、`llvm::Module` 析构等调用栈。这些定位说明“检测发生在何处”，没有直接说明对象最初从何处分配。

### 4.3 符号化结果的限制

- `_ZdlPvm` 支持“走到了 sized delete 入口”的判断。
- `_sub_I_65535_2.2` 与初始化相关，但不是唯一 program 标识；需要原始模块偏移对应具体调用点。
- 解析出的 `PrintStats(int)`、低置信度 `__do_global_dtors_aux`，以及大量 `sigaction`、`__cxa_throw` 可能是符号覆盖不足或 ELF 不匹配下的结果，不能直接据此编造业务调用链。
- 没有 Qualcomm DWARF 不妨碍先看动态符号与反汇编，但本次尚未核对这些库的精确机器码。
- 要保留采集时的 ELF 身份；后来重编库的偏移不能套用到原日志。

## 5. 为什么大跨度 class 错配使 realloc 假设不足

`hint_class` 是由本次释放参数计算出的类别；`actual_class` 是当前 PageMap 所指 Span 的类别，**不是该对象最近一次分配时的原始请求大小**。

按当前 `SizeMap::Init` 算法，在系统页和 allocator 页均为 4KB、最小对齐为 16B、默认 transfer 参数时计算，class 3 为 32B，class 24 为 576B。此表是源码计算结果，不是目标进程直接导出的映射；运行时页大小或 override 可改变结果。

旧 realloc 的保留区间为 `[old_size/2, old_size]`，小幅增长则可能按约 1.25 倍重新分配。`old_size` 是实际可用容量，因此在堆尚正常、释放 hint 确实等于最后一次 realloc 请求的前提下：

```text
实际容量约 576B → realloc 请求 24B
```

会触发重新分配，不应因 hysteresis 一直保留 576B。连续小幅缩容也不会无限扩大差距，因为每次比较的还是实际容量。

因此，大差距日志不能直接证明旧 realloc 在该对象上触发；同时不能排除更早的 realloc 错配先污染缓存，后来其他对象作为受害者出现大差距。只有分配历史才能区分。

## 6. 新候选：一次分配“对象头＋附加数据”

### 6.1 不经过 realloc 也能形成大差距

某些库为了减少分配次数，把对象头、名称和数据放在同一块存储中。下例用于解释机制，不代表已恢复的 Qualcomm 源码：

```cpp
struct Header {
  virtual ~Header() = default;
  const char* begin;
  const char* end;
};  // 常见 64 位布局：24B

void* raw = ::operator new(sizeof(Header) + 500);
Header* p = new (raw) Header;  // placement new，只构造，不另分配。
// ...使用对象及附加存储...
delete p;
```

最初分配器看到约 524B 的请求；析构路径可能生成 `operator delete(p, sizeof(Header))`，即 24B 的 hint。在上述映射下，就形成 actual class 24、hint class 3。

```mermaid
flowchart LR
    A["申请整块存储<br/>对象头 24B + 附加数据"] --> B["在首部 placement new<br/>构造 Header"]
    B --> C["析构 Header<br/>sized delete 参数可能为 24"]
    C --> D["tcmalloc 按 24 的 class 释放<br/>与整块存储的 Span class 不同"]
```

这类做法必须有与其分配契约匹配的释放实现，才能与严格信任 hint 的替换分配器兼容。问题不是看到 sized delete 就能认定“编译器传错大小”，而是对象大小与实际存储申请大小存在两种含义，释放接口需要正确处理。第 6.4 节补充的 CWG 2248 专门讨论了这个模式：在其规定的 sized-deallocation 条件下，这不仅是某个 allocator 的兼容问题，还可能违反标准释放函数的前置条件。

宿主 GCC 的代表性编译检查中，24B 对象的 deleting destructor 确实设置参数 24 并跳转 `_ZdlPvm`。该检查只验证机制可能性，没有在 QNX 目标或 Qualcomm 编译器上验证该具体对象。

### 6.2 公开旧版 LLVM MemoryBuffer 的对应写法

公开 [LLVM release_34 的 MemoryBuffer.cpp](https://github.com/llvm-mirror/llvm/blob/release_34/lib/Support/MemoryBuffer.cpp#L130) 中，`getNewUninitMemBuffer` 的核心步骤为：

```cpp
AlignedStringLen = RoundUpToAlignment(
    sizeof(MemoryBufferMem) + BufferName.size() + 1, sizeof(void*));
RealLen = AlignedStringLen + Size + 1;
Mem = static_cast<char*>(operator new(RealLen, std::nothrow));
// 在对象头后保存名称和数据。
return new (Mem) MemoryBufferMem(StringRef(Buf, Size), true);
```

同文件还存在 `NamedBufferAlloc` 重载：申请 `N + Name.size() + 1`，把名称放在对象后方，再构造 `MemoryBufferMem`。

[对应头文件](https://github.com/llvm-mirror/llvm/blob/release_34/include/llvm/Support/MemoryBuffer.h#L38) 的 `MemoryBuffer` 包含 `BufferStart`、`BufferEnd` 两个指针和虚析构函数；`MemoryBufferMem` 没有新增数据成员，常见 64 位 ABI 下对象头大小为 24B。数据长度可变化，所以“固定 24B hint、actual class 分布很广”是这一模式可能产生的特征。

### 6.3 与日志吻合的部分和缺失证据

| 观测或参考 | 对候选的支持 | 仍缺什么 |
| --- | --- | --- |
| 大量 hint 为 24，actual class 各异 | 与固定对象头、可变附加数据相容 | 具体类型及原始分配请求 |
| `buildBuiltinFromStaticBC` 释放栈 | 与加载和处理 bitcode buffer 的场景相容 | Qualcomm 函数内部实际调用点 |
| 公开 LLVM 有 MemoryBuffer 合并存储实现 | 机制确实存在，不依赖 realloc | Qualcomm fork 是否沿用以及如何释放 |
| 宿主 GCC 析构可生成 24B sized delete | 参数生成机制可成立 | 目标库的删除析构函数及符号绑定 |

**不能从这些证据直接写成“Qualcomm MemoryBuffer bug 已确认”。** 库名不能确定 LLVM 版本，其他清理栈也未必释放 MemoryBuffer；32B hint、各种地址复用还可能来自其他类型或已有缓存污染。

### 6.4 标准背景：CWG 2248 — Problems with sized delete

[CWG 2248：Problems with sized delete](https://cplusplus.github.io/CWG/issues/2248.html) 是 C++ 核心语言工作组针对 sized delete 的问题记录，由 Richard Smith 于 **2016-03-14** 提交。页面标记状态为 **C++17**，并注明已在 **2017 年 2～3 月会议采纳**；不是一个仍未解决的开放问题。此次阅读的是页面所示 Core Issues List revision 121a 非官方快照，快照日期为 2026-10-10。

问题中的原始示例为：

```cpp
T* p = new (::operator new(sizeof(T) + 100)) T;
delete p;
```

这里有两个独立动作：`::operator new` 申请整块存储，placement new 在它上面构造 T。编译器可以知道 T 的大小，却通常无法从 `delete p` 推导出之前申请了多少附加空间。原问题指出：当时标准要求传递存储块大小，却没有允许此例因参数不匹配而产生未定义行为，形成了实现无法普遍满足的要求。

2016 年 12 月提出、后续采纳的修订，修改了 `[expr.delete]` 关于释放参数的描述：

| 参数 | 修订前的相关表述 | 采纳修订的含义 |
| --- | --- | --- |
| 首个地址参数 | 要回收的存储块地址 | 单对象 delete 传最派生对象地址；数组 delete 传按数组分配开销适当调整后的对象地址 |
| `std::size_t` 参数 | 存储块大小 | 单对象 delete 传最派生类型大小；数组 delete 传数组大小加分配开销 |

同时增加说明：若最终调用通常释放函数，而地址不是先前通常分配函数的返回值，或者 size 参数不是该分配调用中对应的参数，则行为未定义。这里说的是修订涉及的具体调用条件，**不是说所有 placement new 或所有“对象后附加数据”的设计都非法**。

就该示例而言，若 T 是完整的被删除类型且实际选择全局 sized delete，则两端可能为：

```text
原分配：::operator new(sizeof(T) + 100)
后释放：::operator delete(p, sizeof(T))
```

编译器不需要替应用恢复附加的 100 字节；这条释放路径没有满足 size 参数与原申请参数对应的要求。该修订没有要求 allocator 自动忽略错误 size，也没有承诺此代码继续在所有实现中可用。

当前工作草案的 [`[expr.delete]`](https://eel.is/c++draft/expr.delete) 仍规定：单对象 sized delete 传被删除对象的大小，并保留调用可替换释放函数时的参数匹配说明；[`[new.delete.single]`](https://eel.is/c++draft/new.delete.single) 明确列出 size 参数若存在，应等于返回该指针的分配函数所接收的 size 参数。这些工作草案链接会更新，引用时应优先看稳定条款名，不能将当前段落编号当作所有历史标准版本的编号。

### 6.5 三种“大小”不能混为一谈

CWG 2248 讨论的不是 allocator 正常 size-class 取整，而是对象大小与原分配请求大小不同。需要区分：

| 名称 | 正常分配 24B 对象 | 24B 对象头加 500B 附加数据 |
| --- | ---: | ---: |
| 被删除对象大小 | 24B | 24B |
| 传给分配函数的原始请求大小 | 24B | 524B |
| tcmalloc 物理可用容量，按第 5 节示例配置 | 32B | 576B |
| 析构路径可能传入的 sized-delete 参数 | 24B | 24B |

正常情形下，24B 请求被取整到 32B，不会因此违反“释放 size 对应原请求”的条件；tcmalloc 再将 24 映射到 class 3，也与真实 class 一致。附加数据情形则是原请求为 524，而释放传入 24，不能用正常取整解释。

标准参数匹配与 tcmalloc 检测也不是同一个强度：标准讨论原请求参数是否对应，当前诊断只比较 class。若两个不同的参数恰好落在同一 class，可能不输出 mismatch，但这不自动证明其调用满足标准契约。反过来，诊断的 `actual_class` 仍只是当前 Span 元数据，不会自动给出历史请求大小。

### 6.6 对 LLVM MemoryBuffer 假设的帮助和边界

CWG 2248 使本次推理更具体：**“申请总长度、首部构造小对象、按小对象大小进入 sized delete”是标准委员会明确讨论过的问题形态，不需要以 realloc 为前提。** 上游旧版 MemoryBuffer 的合并存储写法与之结构相似，可作为查阅 Qualcomm fork 时的线索。

若实际库满足以下条件，就有可能重现该问题形态：

1. MemoryBuffer 或类似类型从可替换分配函数取得对象头与数据的总长度。
2. 在存储首部构造对象，正常销毁时选择全局 sized delete。
3. 该路径没有通过匹配的类型专属释放逻辑等方式处理原始存储，最终将对象头大小传给 tcmalloc。

这时，固定 24B 的释放参数可能是编译器按对象大小正常生成的结果，问题应优先从分配/释放契约、库对 sized deallocation 的适配以及最终符号绑定调查。**仍须核实实际类型、原请求、删除析构函数和绑定位置；不能仅凭 CWG 2248 判定所有日志都是 MemoryBuffer 引起。** 上游示例使用 nothrow 分配，命名 buffer 还涉及分配重载，具体匹配关系同样需要按实际实现检查。

一些默认 sized-delete 实现会转调不带 size 的 delete，因而可能掩盖这种尺寸差异；换成严格使用 class hint 的分配器后就会显现。现行 `[new.delete.single]` 也说明 sized delete 可以通过对应 unsized delete 实现。但默认实现的容忍行为不是错误 size 参数的通用保证，不能据此认定 tcmalloc 必须替调用方纠正。

同样，禁用某个编译单元的 sized-deallocation 代码生成、调整全局重载绑定或为类型提供匹配释放路径，是不同层面的处理。修改 perception 自身编译参数不等于重编 `/ifs/lib64/libllvm-qcom-full.so`；已有第三方二进制中的 `_ZdlPvm` 调用仍须单独核对。本文不据此直接选择修复方案。

### 6.7 与 realloc 缺陷的区别

| 候选 | class 不一致可能从哪里开始 | CWG 2248 的作用 |
| --- | --- | --- |
| 旧 realloc 保留/补齐 | allocator 返回的容量与新逻辑请求不属于同一 class | 不能用该议题代替 realloc 的运行时证据；C API 与 sized-free 扩展还需分别检查契约 |
| 对象头＋附加数据 | 原申请就是总长度，析构仅传对象大小 | 为这种不经过 realloc 的问题提供直接标准背景 |
| 缓存已被污染 | 后来小请求取得其他 class 的对象 | 不能仅因后来 hint 为 24 就认定后来调用者违反分配契约 |

因此，对本次大跨度 mismatch 的更新判断是：CWG 2248 增强了附加数据分配候选的合理性，也说明不能简单归责为“编译器传错 size”；它没有替代首次分配历史和 Qualcomm 实现证据，更没有直接证明历史 CentralFreeList 崩溃的原因。

## 7. 与缓存污染及历史崩溃如何衔接

不论最初来自 realloc、附加数据分配还是其他错误，只要大对象 p 按 class 3 回收，后续正常 `new(24)` 就可能从 class 3 FreeList 取到 p，随后正常按 24B 释放又报告 mismatch。这个调用者可以没有任何 realloc，也可以完全不知道原来那次大分配。

这解释了为何要区分“首次传入错误 hint”和“污染后再次分配/释放”。当实际物理容量大于请求时，最初使用可能不越界；进入 central 后仍可能跨 class 修改 Span，失去正确锁保护。完整机制和历史空指针故障的对应边界，见前篇第 5.3 节。

该机制不能简化成“FetchFromOneSpans 按小步长重新切割大 Span”。它沿已有 next 取对象，真正危险的是类别、链表归属、锁保护和记账不再一致。最终在正常 new 中崩溃，与更早的错误释放可以相隔很久。

## 8. 后续定位应补什么

最有价值的下一步是捕获首次异常对象的最近一次分配历史，而不是继续仅增加释放栈数量。建议以有界、避免分配递归的记录保存以下字段；这属于后续设计，当前补丁尚未实现：

```text
事件顺序、线程、分配代次
分配入口、请求大小、alignment、返回地址、请求 class、实际 Span class
分配调用栈
realloc 前后地址、请求大小、可用容量
释放地址、size_hint、hint class、实际 Span class、释放调用栈
```

| 配对后的结果 | 优先方向 |
| --- | --- |
| 最初请求约 524B，未 realloc，释放 hint 为 24B | 对象头＋附加数据、自定义 new/delete |
| 本次请求 24B，分配返回时已经属于大 class | 此前缓存污染，向前追踪归还事件 |
| 分配时类别正确，释放前 Span 信息变化 | 生命周期、过早回收或元数据损坏 |
| realloc 返回时已经与新请求 class 不一致 | 已知 realloc 缺陷在该运行中触发 |

同时需要取得匹配的 Qualcomm ELF：核对 Build ID，在首次异常调用点查看 AArch64 的 size 参数来源，检查 MemoryBuffer 等分配函数是否申请总长度，以及删除路径最终绑定何处。只看到 `_ZdlPvm` 入口不能证明它操作的具体类型。

实验对照也应明确区分：原始诊断配置、SMALL_BUT_SLOW 配置、只引入 realloc 修复的配置。分别记录首次 mismatch、重复地址分布、central 异常和运行时长。关闭 sized delete 接管、纠正 hint 或修改缓存策略都可能改变表现；短期不崩不能单独反推历史根因。

## 9. 证据与源码索引

- [前篇：历史崩溃、运行包身份与 Span 损坏机制](./2026-10-22_dr_perception_sized-free错配排查记录.md)。
- [gperftools 堆栈诊断提交 18b526f](https://code.deeproute.ai/third-party-repos/google-gperftools/-/commit/18b526f5d70d92d17a52ab4a23ca751a37a80445)。
- [堆栈输出格式提交 196b50c](https://code.deeproute.ai/third-party-repos/google-gperftools/-/commit/196b50c4b67f2da339e729f64212152b10dee7dc)。
- [当前参考 tcmalloc.cc](https://code.deeproute.ai/third-party-repos/google-gperftools/-/blob/196b50c4b67f2da339e729f64212152b10dee7dc/src/tcmalloc.cc)：`ReportSizedFreeMismatch`、`do_free_with_callback`、`do_realloc_with_callback`、aligned delete。
- [当前参考 thread_cache.h](https://code.deeproute.ai/third-party-repos/google-gperftools/-/blob/196b50c4b67f2da339e729f64212152b10dee7dc/src/thread_cache.h)：`Allocate` 与 `Deallocate`。
- [上游 realloc 修复 868a588](https://github.com/gperftools/gperftools/commit/868a588ad8afd5e6c9b795363a83fea282ecd491)。
- [CWG 2248：Problems with sized delete](https://cplusplus.github.io/CWG/issues/2248.html)：2017 年采纳，状态 C++17，附加存储与 sized-delete 参数的标准背景。
- 当前 C++ 工作草案 [`[expr.delete]`](https://eel.is/c++draft/expr.delete)、[`[new.delete.single]`](https://eel.is/c++draft/new.delete.single)：释放参数与原申请参数的对应要求，页面内容会随草案更新。
- 日志输入：`/sandbox/temp/perception_stdout.log`。
- 初步整合底稿：`/sandbox/google-gperftools/docs/sized-free-mismatch-central-freelist-analysis.md`；本系列按历史机制与后续工作拆分整理。

截至本文日期，已确认诊断运行存在 class mismatch、部分释放栈来自 OpenCL 编译路径，且已有可交付的 SMALL_BUT_SLOW 实验库；尚未取得首次异常对象的完整分配历史、Qualcomm MemoryBuffer 实现证据及与历史 SIGSEGV 的因果闭环。
