---
title: "自动驾驶 Driver 包内存火焰图发版指南"
date: 2026-10-16
description: "本文面向 ADAS Farm Driver 包发版人员和负责目标进程配置的开发人员，说明如何发布一个能定时生成堆内存 profile 文件的版本。流程分为两部分：发版构建选择含 profiler 的 allocator 库，Driver 配置 MR 再为指定进程开启运行时采集。两部分缺一不可。"
categories:
  - "撰修司"
tags: []
---

# 自动驾驶 Driver 包内存火焰图发版指南

本文面向 ADAS Farm Driver 包发版人员和负责目标进程配置的开发人员，说明如何发布一个能定时生成堆内存 profile 文件的版本。流程分为两部分：发版构建选择含 profiler 的 allocator 库，Driver 配置 MR 再为指定进程开启运行时采集。两部分缺一不可。

## 适用范围

- QNX LP8650/LP8797 使用 tcmalloc：分别对应 SDP 7.1/8.0。
- Linux 使用 jemalloc 的 Driver 平台可按本文操作。
- Debian 12 当前 jemalloc 包不在本文所述 profile/minimal 切换支持范围内，不要仅凭设置 `MEMORY_PROFILE=true` 就认为其具备采集能力；需先确认该平台包和加载配置已完成适配。
- 本流程针对 Driver 包中的长驻业务进程。不要为短时脚本或无关进程开启采集。

## 1. ADAS Farm 发版时选择 Profile 库

在 ADAS Farm 发版构建变量/编译选项中设置：

```text
MEMORY_PROFILE=true
```

该变量以 Bazel `--define MEMORY_PROFILE=true` 传入 Driver 构建。当前规则只将精确值 `true` 视为开启；未设置或设为 `false` 时走默认 minimal 库：

|平台|`MEMORY_PROFILE=true`|默认或 `false`|
|---|---|---|
|QNX SA8650 / SDP 7.1|`libtcmalloc.so.10`|`libtcmalloc_minimal.so.10`|
|QNX SA8797 / SDP 8.0|`libtcmalloc.so.10`|`libtcmalloc_minimal.so.10`|
|支持该规则的 Linux 平台|`libjemalloc.so.2`|`libjemalloc_minimal.so.2`|

发版人员应在对应 Farm 构建任务中确认变量确实进入 Bazel build options，并在产物检查中确认目标包包含对应平台的 profile 库。**此变量只选择打包/加载的库，不会自动开启任何进程的 heap profiling。** QNX 和 Linux 包中通常同时保留 profile 与 minimal 两个文件，Driver 生成的进程配置决定实际加载哪个文件。

## 2. Driver 仓库提交配置 MR

在目标车型/平台实际使用的进程配置中，为目标长驻业务进程打开 heap profile 运行时开关。仅编辑目标设备会采用的配置块；当进程同时定义 `orin_env_config` 和 `env_config` 时，优先修改目标平台生效的 `orin_env_config`，没有该块再修改 `env_config`。遵循车型共版关系，修改实际被打包引用的配置源。

### QNX：tcmalloc

将目标进程的 `TCMALLOC_SAMPLE_ENABLE` 从 `false` 改为字符串 `true`。确认同一进程还配置正数采样参数、输出周期和目录，例如：

```json
"TCMALLOC_SAMPLE_ENABLE": "true",
"TCMALLOC_SAMPLE_PARAMETER": "524288",
"TCMALLOC_STATS_ENABLE": "false",
"TCMALLOC_SAMPLE_DUMP_TIME_INTERVAL": "60",
"TCMALLOC_AUTODUMP_DIR": "${DR_LOG_DIR}/heap_dump"
```

### Linux：jemalloc

在目标进程的 `MALLOC_CONF` 中将 `prof:false` 改为 `prof:true`，其余 jemalloc 参数保持不变；例如原值为：

```json
"MALLOC_CONF": "prof:true,lg_prof_sample:19,metadata_thp:auto,narenas:10,background_thread:true"
```

同时保留/配置自动输出字段：

```json
"JEMALLOC_PROF_TIME_INTERVAL": "60",
"JEMALLOC_AUTODUMP_DIR": "${DR_LOG_DIR}/heap_dump",
"JEMALLOC_STATS_ENABLE": "false"
```

若原有 `MALLOC_CONF` 含其他参数，只替换其中的 `prof:false`，不要覆盖或丢弃其他选项。不要重复添加第二个 `prof` 配置项。

## 3. 环境变量说明与调参

|平台|变量|含义及建议|
|---|---|---|
|QNX|`TCMALLOC_SAMPLE_ENABLE`|精确设为 `true` 才开启 heap sampling 和定时 `.heap` 输出。采集 MR 将目标进程设为 `true`；默认配置保持 `false`。|
|QNX|`TCMALLOC_SAMPLE_PARAMETER`|采样间隔，单位字节。常规/大内存进程用 `524288`；内存规模较小或需要更高采样精度时可用 `262144`。数值越小采样越密，CPU 与数据量开销通常越高。|
|QNX|`TCMALLOC_STATS_ENABLE`|独立控制 `.stats` 统计文件，不是生成 heap profile 的必要条件。仅需火焰图时保持 `false`；确需 allocator 统计时才设为 `true`。|
|QNX|`TCMALLOC_SAMPLE_DUMP_TIME_INTERVAL`|heap/stats 自动输出周期，单位秒，默认建议 `60`。必须为正整数。|
|QNX|`TCMALLOC_AUTODUMP_DIR`|heap/stats 输出目录。建议使用 `${DR_LOG_DIR}/heap_dump`，确认运行账户对展开后的目录有写权限。|
|Linux|`MALLOC_CONF` 的 `prof`|`prof:true` 开启 jemalloc heap profiling；`prof:false` 关闭。Profile 库中此项在进程初始化时读取。|
|Linux|`MALLOC_CONF` 的 `lg_prof_sample`|控制采样粒度，建议大内存进程用 `19`、较小进程或更高精度需求用 `18`。指数每减 1，采样约加密一倍，开销和输出数据可能增加。保留原有 `MALLOC_CONF` 的其他参数。|
|Linux|`JEMALLOC_PROF_TIME_INTERVAL`|heap/stats 自动输出周期，单位秒，默认建议 `60`，必须为正整数。|
|Linux|`JEMALLOC_AUTODUMP_DIR`|heap/stats 输出目录，建议 `${DR_LOG_DIR}/heap_dump`，并确认目录可创建且进程可写。|
|Linux|`JEMALLOC_STATS_ENABLE`|独立控制 `.stats` 输出，不是 heap profile 的必要条件。只采集火焰图时保持 `false`；确需统计文件才设为 `true`。|

两种 allocator 都在库初始化时读取配置。进程启动后再修改环境变量不会动态启停采集。profile/minimal 库的差别是编译期能力：即使运行时开关已打开，加载 minimal 库也不会产生本方案的 heap 自动输出。

## 4. MR 与发版验收

Driver MR 应说明目标车型、进程名、实际生效的配置块、选择的采样参数及采集窗口。检查清单：

1. Farm 构建设置了 `MEMORY_PROFILE=true`，生成包所用配置确实带有该 define。
2. Driver MR 只为目标长驻业务进程启用运行时 profile；其他进程及 stats 开关保持原状态。
3. 编译后的进程配置中，QNX 为 `TCMALLOC_SAMPLE_ENABLE=true`；Linux 为 `MALLOC_CONF` 中 `prof:true`，并保留其他参数。
4. 目标包包含正确平台的 profile 库，进程实际加载 profile 库而不是 minimal 库。
5. 设备上启动目标进程，等待至少一个完整输出周期，并检查 `${DR_LOG_DIR}/heap_dump` 下出现该进程的 `.heap` 文件。仅有 `.stats` 文件不代表 heap profile 已开启。

请将采集窗口限制在排查所需时间内，并通过后续配置 MR 关闭目标进程采集（QNX 改回 `TCMALLOC_SAMPLE_ENABLE=false`；Linux 改回 `prof:false`）。`MEMORY_PROFILE=true` 可按需要单独控制发版库选择；除非包策略要求回退 minimal，否则关闭运行时采集时不必因此修改其他进程配置。

## 常见问题

- **设置了 `MEMORY_PROFILE=true`，没有 `.heap` 文件：**检查目标进程运行时开关、周期/目录、目录写权限、实际加载库，以及是否已等待完整周期。
- **QNX 只有 minimal 库或加载失败：**核对目标是 SDP 7.1 还是 SDP 8.0，检查对应 profile 库是否进入 Driver 包；两个 SDP 的库不可混用。
- **Linux `prof:true` 仍无输出：**确认不是 minimal 库，并检查运行配置中是否因后续配置合并覆盖了 `MALLOC_CONF` 或未保留自动输出周期/目录。
- **只看到 `.stats`：**检查 heap 开关。QNX `TCMALLOC_STATS_ENABLE=true` 不会替代 `TCMALLOC_SAMPLE_ENABLE=true`；Linux `JEMALLOC_STATS_ENABLE=true` 不会替代 `MALLOC_CONF` 的 `prof:true`。
- **采样开销偏高：**先对目标进程使用更大的采样间隔（QNX `524288`、Linux `lg_prof_sample:19`），并缩短采集窗口；不要通过关闭 allocator 的必要配置来规避。

## 相关资料

- [TCMALLOC 的 Profile 功能修改（定时输出）](./TCMALLOC的profile功能修改.md)
- [Jemalloc 的 Profile 功能修改（定时输出）](./Jemalloc的profile功能修改.md)
- [tcmalloc QNX 自动发版 CI 与测试体系解析](./开发与发版规范/tcmalloc%20(gperftools)%20QNX%20自动发版%20CI%20与测试体系解析.md)
- [jemalloc Linux 自动发版 CI 与测试体系解析](./开发与发版规范/jemalloc%20Linux%20自动发版%20CI%20与测试体系解析.md)
