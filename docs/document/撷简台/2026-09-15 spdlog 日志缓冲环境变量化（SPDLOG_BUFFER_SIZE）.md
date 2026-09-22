---
title: "2026-09-15 spdlog 日志缓冲环境变量化（SPDLOG_BUFFER_SIZE）"
date: 2026-09-20
description: "分支：user/zyf/large_buffer（/sandbox/spdlog）"
categories:
  - 撷简台
tags:
  - SPDLOG
---

# 2026-09-15 spdlog 日志缓冲环境变量化（SPDLOG_BUFFER_SIZE）

分支：`user/zyf/large_buffer`（/sandbox/spdlog）

## 背景：前两个commit分析

- **`42b07108` 写入buffer增到128K**：仅改 `details/os-inl.h:fopen_s`，对 fopen 的日志文件调用  
`setvbuf(fp, NULL, _IOFBF, 128*1024)`，把 QNX 默认 1KB(BUFSIZ) 缓冲扩大为 128K 全缓冲，  
减少 write() 系统调用次数（QNX 每次 write 是一次 IPC/MsgSend 到 UFS）。只影响**日志文件**。
- **`6d6e599b` console sink 缓冲**：未改缓冲大小，而是控制 `fflush` 时机：

  1. `stdout_sinks-inl.h` / `ansicolor_sink-inl.h`：仅当 `isatty`（终端）时每条 flush，  
  重定向到文件/管道时不 flush，让 stdio 默认缓冲攒块批量写；
  2. `thread_pool-inl.h`：async 溢出 `stdout_fallback` 从 iostream 改为 C stdio `fwrite`  
  （QNX libc++ 未 override xsputn → iostream 逐字符 write）。

## 关键发现（重要）

**glibc 的 `setvbuf(fp, NULL, _IOFBF, size)` 会忽略 size 参数**：  
传入 NULL buffer 时 glibc 不重新分配缓冲，仍保持默认 4096 字节（实验：  
`mini2.c` 中 setvbuf(NULL,128K) 后 `f->_IO_buf_end - f->_IO_buf_base` 仍为 4096）。  
即 **commit `42b07108` 在 Linux/glibc 上实际无效**（只有 QNX 等按 size 分配的 libc 才生效）。  
必须由 caller 提供 buffer 的 setvbuf 才能跨平台按 size 生效。

## 实现

需求：环境变量控制缓冲大小（debug 设小刷新快、生产设大减少落盘）。范围=文件+控制台统一，单位=KiB。

- `os.h/os-inl.h`：新增 `log_buffer_size()`（读 `SPDLOG_BUFFER_SIZE`，单位 KiB，缺省 128）、  
`apply_log_buffer_size(FILE*, std::vector<char>&)`（caller 提供 buffer 的 setvbuf）、  
`restore_log_buffer(FILE*)`（析构时恢复默认缓冲防悬垂）。
- `fopen_s`：移除原 setvbuf（NULL buffer 无效），缓冲迁移到 file_helper。
- `file_helper.{h,-inl.h}`：新增 `io_buffer_` 成员（持有 128K buffer，随文件生命周期），  
open() 中 fopen_s 成功后应用；`~file_helper` 先 close() 再释放 buffer，安全。
- `stdout_sinks.{h,-inl.h}`、`ansicolor_sink.{h,-inl.h}`：各加 `io_buffer_` 成员，  
构造时对 stdout/stderr 应用；析构时 restore 恢复默认缓冲（stdout/stderr 是进程级流）。

## 验证（g++ 9.4，strace 统计 write）

写入 4000 条短日志(≈160KB)：

| 场景 | 默认(128K) | SPDLOG_BUFFER_SIZE=4 |
|-|-|-|
| 文件 | 3次 write(131072×2+\~65K) | 80次×4096 |
| stdout重定向 | 3次大块 | 82次×4096 |
| color stdout重定向 | 3次大块 | 81次×4096 |

- `SPDLOG_BUFFER_SIZE=1` → 319 次 ×1024；`abc`/`0` → 回退默认 128K。
- tty 模拟(script)下 128K 配置仍逐行小写(\~82B) → 终端实时性不受影响（靠逐行 fflush）。
- 两种构建模式均通过：header-only 与 `SPDLOG_COMPILED_LIB`（src/ 编译 + 链接 -pthread）。

## 使用方式

```bash
SPDLOG_BUFFER_SIZE=4   ./app   # debug：4KiB 缓冲，刷新快/实时
SPDLOG_BUFFER_SIZE=128 ./app   # 生产：128KiB 全缓冲，减少落盘（默认即此值，可比默认再调大）
```

注意：stdout/stderr 经 spdlog 设置为大缓冲全缓冲属于全局副作用，  
不经过 spdlog 的裸 printf 写 stdout 在重定向时也会被同样缓冲。

---

## 二、内存机制解析（第2轮 Q&A）

**stdio 缓冲内存从哪来、会不会双重分配？**

- glibc 的 `FILE*` 缓冲是**懒分配**的：流第一次输出时 stdio 才分配默认 `BUFSIZ`(4096) 的缓冲。
- `setvbuf(fp, NULL, size)`：glibc **不重新分配**，size 被忽略，依旧用 4K 默认；QNX 此类 libc 才会按 size malloc。
- `setvbuf(fp, caller_buf, size)`：stdio **直接使用调用方给的 buffer，不再额外分配自身缓冲**。
- 现实现 = `std::vector<char>(size)` 作 buffer → 每流新增一块 `size` 内存，stdio 复用这块内存，**无双重分配**。
- 相对修复前的对比：修复前 glibc 实际每流 \~4K（懒分配）；修复后每流 `size`（默认 128K），净增约 `size-4K`。
- 若 QNX 上此前 `setvbuf(NULL,128K)` 按 size malloc 成功（每流已是 128K），换 caller buffer 后内存量不变，只是所有权从 stdio 内部缓冲变成我们持有的 vector（随 file_helper/sink 生命周期释放，可归因、可调）。
- 结论：要达到"128K 攒块"任何方案都要一块 128K 内存；差别只在谁持有、何时释放。现方案用 `MLOG_writebuffersize` 可把每流缓冲压小（如 16），契合内存归因诉求。

## 三、第2轮改动总览

1. **spdlog**：环境变量 `SPDLOG_BUFFER_SIZE` 改名 **`MLOG_writebuffersize`**（与 MLOG 封装 `common/base/logger/spdlog` 的 `MLOG_*` 前缀统一）。`os.h`/`os-inl.h` + file_helper/stdout_sinks/ansicolor_sink 3 处注释同步。
2. **mcu_common（zyf/log_optimize）**：tlog 硬编码 128K 缓冲扩展到环境变量 **`TLOG_writebuffersize`**（KiB）：新增 `tlog_get_file_buff_size()`（`strtol` 解析 + 非法值回退默认 128K），打开日志流的 `malloc`/`setvbuf` 处按 env 尺寸分配；`gcc -fsyntax-only` 通过。
3. **dem `src/main.cc` f0adea1 分析**：该提交在 `main()` 对重定向的 stderr 设 64K 全缓冲（静态数组），把 MLOG/iostream 逐字节 write 改为批量写。dem 自己的 logger（`LoggerBase`）基于 spdlog：

   - 文件 sink 用 `details::file_helper` → 走 apply_log_buffer_size，受 `MLOG_writebuffersize` 控制；
   - console 用 `stdout_color_sink_mt` → ansicolor_sink 构造同样受控；
   - 故 dem 的"文件 + stdout"已天然覆盖，无需再改；唯一独立于 `MLOG_writebuffersize` 的是 main() 里 stderr 写死的 64K（可选后续对齐）。
   - dem 是否可接入 MLOG：主 logger 是自研 spdlog 封装（非 MLOG `common::log`），但 config 已带 `MLOG_*` 环境变量、依赖 `@common//common:log`；因同底 spdlog，缓冲配置经 `MLOG_writebuffersize` 统一生效。
4. **dem machine_config.jsonnet**：8 个车型在 `orin_env_config`（优先，均有）补入 `"MLOG_writebuffersize": "128"`：default / hy11-et / j6p-share / lp8650-os-share / lp8650-v1-share / lp8797-v1-share / lp8797-v2-share / yinhe-all。
5. **dem `src/main.cc`（stderr 对齐）**：将 f0adea1 中写死的 64K stderr 缓冲改为读取 `MLOG_writebuffersize`（KiB，缺省 128K），与 spdlog 文件/控制台 sink 缓冲配置统一；终端下仍不缓冲即时输出。C++ 语法已验证。

## 使用方式（改后）

```bash
MLOG_writebuffersize=4   ./app   # debug：4KiB 缓冲，刷新快/实时
MLOG_writebuffersize=128 ./app   # 生产：128KiB 全缓冲，减少落盘（默认即此值，可比默认再调大）

# MCU 端（mcu_common/tlog）
TLOG_writebuffersize=128  # 同语义，单位 KiB
```

---

## 四、回归排障：//common:log_test SIGSEGV（第3轮）

**现象**：`cd /sandbox/common && bazel test //common:log_test` 崩溃（SIGSEGV）。崩溃栈符号化后：`testing::internal::ColoredPrintf`（gtest 结束时打印**写 stdout**）→ glibc `_IO_file_xsputn` → SIGSEGV，发生在 `Logging system shut down successfully`（MLOG shutdown、各 sink 析构）之后。

**判定与本次修改相关**：`third_party/dr_third_party.bzl` 中 `@spdlog` = `new_git_repository(commit="e7a1f330", remote=git@code.deeproute.ai:third-party-repos/spdlog.git)`，即 bazel 固定拉取我们 push 的提交 e7a1f330——测试用的正是本次改动。

**根因**：`restore_log_buffer(FILE*)` 用单步 `setvbuf(fp, NULL, _IOFBF, 0)` 想解除对 caller buffer 的引用，但 **glibc 的 setvbuf 传 NULL 时不会替换已存在的 caller buffer**（实测 mini3：`_IO_buf_base`/size 完全不变，stdio 仍指向我们的 vector）。于是 console sink 析构时：

1. `restore_log_buffer` 无效 → stdio 仍引用 `io_buffer_`
2. `io_buffer_`（vector）被释放
3. 之后任何写 stdout 的代码（gtest 结果打印）→ UAF → SIGSEGV

**修复**（spdlog 工作树，未提交）：`restore_log_buffer` 改为两步——

```cpp
::setvbuf(fp, nullptr, _IONBF, 0);   // 先切无缓冲，清掉对 caller buffer 的引用
::setvbuf(fp, nullptr, _IOFBF, 0);   // 恢复默认全缓冲，stdio 下次 lazy 自建
```

实测 mini4：两步后 stdio base 脱离 caller buffer，free 后再写 100 行输出完整、无崩溃。

**上线方式**（bazel 固定 commit 拉取，修复需发版）：

1. spdlog commit 此修复并 push 到 `git@code.deeproute.ai:third-party-repos/spdlog.git`
2. 更新 `/sandbox/third_party/dr_third_party.bzl` 中 spdlog 的 `commit` 为新哈希
3. 重跑 `bazel test //common:log_test` 确认通过

---

## 五、dem 与「用 MLOG 的模块」的差异（第4轮 Q&A）

### 1. 日志栈不同 → 决定了谁需要额外设置缓冲

- **普通 MLOG 模块**：日志全部经 MLOG。`LoggerManager::CreateModuleLogger`（`common/base/logger/spdlog/log.cc:344-352`）为每个模块 logger **无条件创建 `stderr_color_sink_mt`（写 stderr）+ file sink**：

  - `stderr_color_sink_mt` = `ansicolor_stderr_sink` → 构造时 `apply_log_buffer_size(stderr)`（我们的改动）
  - file sink → `details::file_helper` → `apply_log_buffer_size(file)`  
  → 两条通道都被 spdlog 自动设好缓冲，**模块自己只需改 MLOG/spdlog，不需要任何额外设置**。
- **dem**：几乎不用 MLOG 宏（全 `src/` 仅 `thread/my_thread.cc:43` 一处 `MLOG(WARN)`），主日志是自研封装 `src/logger/`：

  - file sink → `details::file_helper`（被覆盖 ✓）
  - console sink → `stdout_color_sink_mt`（**只覆盖 stdout，不覆盖 stderr ✗**）
  - 另有大量非 spdlog 的 stderr 路径：118 处 `std::cerr/std::cout/fprintf(stderr)`、`signal_handler.cc:420` 的 `::write(STDERR_FILENO,...)`、启动早期输出、第三方库  
  → dem 的 stderr **没有任何 sink 覆盖**，保持 C 默认的**无缓冲**；而 stderr 被重定向到文件时必须由 dem 自己在 `main()` 里兜底设置（读 `MLOG_writebuffersize`）。

> 补充：dem 的 `setvbuf` 只作用于 **dem 自身进程**（fork/exec 子进程只继承 fd，不继承 FILE 缓冲状态）；且 `setvbuf` 管的是 C stdio，对 `std::cerr` 这类 unitbuf 的 iostream 收益有限。

### 2. 「把子进程 stdout/stderr 重定向到文件」到底是谁做的

要分两层，二者正交：

| 层次 | 谁负责 | 证据 |
|-|-|-|
| **fd 层重定向**（fd1/fd2 指向文件） | **dem 启动器**，与 MLOG/spdlog 无关 | `src/vehicle_feature/lp/dr_service_controller.cc:303-315`：spawn 子进程时 `posix_spawn_file_actions_addopen(STDOUT_FILENO, stdout_<ts>.log)` + `adddup2(STDOUT→STDERR)` |
| **日志库层**（日志内容写哪个文件/fd） | 日志库的 sink | MLOG file sink 直接按 `MLOG_log_dir/<logger_name>.log` 打开写；MLOG 的 `stderr_color_sink` 写 fd2（若 fd2 被重定向则进那个文件）；dem 自研 file sink 直接写 `/tmp/dem/dem.log` |

结论：**重定向不是 MLOG/spdlog 完成的**，那是启动器的 fd 级职责；MLOG/spdlog 只决定"日志内容落到哪"。另有一种汇聚由 dem 自研：`journalctl_logger` 用 popen/setsid 抓 journalctl/子进程输出再转成日志，MLOG 不提供该能力。

### 3. dem 能否改用 MLOG，同时保持"日志/stdout/stderr 都到文件"

**可以**，且两层正交：fd 重定向层不变（仍由 dem 的 spawn 逻辑保证），只替换日志库层。

- MLOG 可覆盖：多文件 logger（`CreateModuleLogger(name)` → `log_dir/<name>.log`）、轮转/压缩/清理（`mlog_max_log_size`/`mlog_max_logfile_num`/`MLOG_enable_log_compress`/cleaner）、异步与 flush 策略、`MLOG_*` 环境变量体系、崩溃处理。
- 需要适配的差异：

  1. **文件路径/命名**：MLOG 固定在 `MLOG_log_dir/<name>.log`；dem 现在是 `/tmp/dem/*.log` 与 `dem_launch/stdout_*.log` → 需与日志收集链路对齐。
  2. **轮转语义**：dem 是编号轮转 `base.log → base.log.1 → …`（`LoggerFileNumberRotate`）；MLOG 的轮转由注入的 `file_sink_factory` 决定，命名/压缩策略不同。
  3. **console sink 目标**：dem 现在 `stdout_color_sink`（写 stdout），MLOG 是 `stderr_color_sink`（写 stderr）→ 语义变化需确认下游。
  4. **自研能力**：journalctl/命令输出抓取、`SetDumpPath` 等 MLOG 不提供，仍需 dem 保留。
- 现状"stdout/stderr 重定向到文件"**不依赖自研日志栈**，故改用 MLOG 后依然成立。
