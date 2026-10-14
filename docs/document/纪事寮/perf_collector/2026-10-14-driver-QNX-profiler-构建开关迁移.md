---
title: "Driver QNX Profiler：旧 qnxprofiler 与新模式开关"
date: 2026-10-14
description: "本文说明 driver 当前分支最近两笔提交引入的 QNX profiler 开关迁移：旧的 --config=qnxprofiler 与新的 QNXPROFILER=oncpu|offcpu|all 分别做什么、应如何打包，以及为什么两者不能混为同一类配置。"
categories:
  - "纪事寮"
tags: []
---

# Driver QNX Profiler：旧 qnx_profiler 与新模式开关

本文说明 driver 当前分支最近两笔提交引入的 QNX profiler 开关迁移：旧的 **--config=qnx_profiler** 与新的 **QNX_PROFILER=oncpu|offcpu|all** 分别做什么、应如何打包，以及为什么两者不能混为同一类配置。

## 背景

### 需求从“是否开启”变为“选择采集模式”

原有方案只有 **qnx_profiler** 这一开关，语义是开启 On-CPU 采样。它由 bazel_configs 中的 Bazel RC 预设提供：

~~~bazelrc
build:qnx_profiler --@deeproute_build_tools//:qnx_profiler=ON
build:qnx_profiler --features="qnx_profiler"
~~~

最近两笔提交把 driver 中三个 DEM 配置扩展为可选择 On-CPU、Off-CPU 或两者同时采集：

| 提交 | 目的 | 结果 |
| --- | --- | --- |
| faac26e928 | 增加 **--define QNX_PROFILER=oncpu/offcpu/all**，并由 package.sh 接收同名环境变量 | driver 可按模式生成不同的运行时 machine_config |
| 547315bbca | 修复新逻辑初版忽略旧开关的问题 | 继续使用 **--config=qnx_profiler** 时仍会注入 On-CPU profiler，不会静默失效 |

新模式当前只接入以下车型的 DEM：

- LP8650-V1-SHARE
- LP8797-V1-SHARE
- LP8797-V2-SHARE

### 两种入口的差异

| 维度 | 旧入口：--config=qnx_profiler | 新入口：--define QNX_PROFILER=模式 |
| --- | --- | --- |
| 入口性质 | .bazelrc 中真实存在的命名预设 | Bazel 的键值构建参数 |
| 传给 Bazel 的值 | 共享 build setting **qnx_profiler=ON**，并启用 feature | **QNX_PROFILER=oncpu/offcpu/all** |
| driver 的条件判断 | 外部条件 **@deeproute_build_tools//:qnx_profiler_on** | 本地 **:qnx_profiler_oncpu/offcpu/all** config_setting |
| machine_config 运行时结果 | 仅注入 On-CPU profiler | 按模式注入 On-CPU、Off-CPU 或两者 |
| C/C++ 编译选项 | 尝试通过 toolchain feature 向适用目标加入 **-DQNX_PROFILER=1** | 不会自动启用该 feature，也不会自动加入此宏 |

其中 **qnx_profiler_all** 只是 BUILD 文件内一个 config_setting 的目标名，不是 Bazel RC 的 config 名称。因此 **--config=qnx_profiler_all** 会报“Config value is not defined in any .rc file”：在 .bazelrc 中没有对应的 **build:qnx_profiler_all** 段落。

正确的因果关系是：

~~~text
--define QNX_PROFILER=all
            ↓
:qnx_profiler_all 这个 config_setting 条件成立
            ↓
select() 选择 qnx_profiler_mode=all
~~~

所以 **QNX_PROFILER=all 是因**，**qnx_profiler_all 条件命中是果**。config_setting 不会设置变量；它只检查 Bazel 已收到的变量值。

## 做法

### 推荐的打包命令

通过 package.sh 打包时，推荐把 **QNX_PROFILER** 作为脚本输入环境变量。脚本会将它转换成 Bazel 的 **--define QNX_PROFILER=...**：

~~~sh
# 仅 On-CPU
QNX_PROFILER=oncpu ./pipeline/package.sh

# 仅 Off-CPU
QNX_PROFILER=offcpu ./pipeline/package.sh

# On-CPU 与 Off-CPU 同时开启
QNX_PROFILER=all ./pipeline/package.sh
~~~

模式值必须使用小写的 **oncpu**、**offcpu** 或 **all**；package.sh 只是透传该值，未知值不会命中任一 config_setting，结果会回落为 **none**。

落实到ADAS FARM上的具体的做法可以参考[这个MRset](https://adas-farm.srv.deeproute.cn/driver/releases/detail/167347?tab=release_tasks)的打包方法。


若调用方只能注入已有的 **build_options**，等价写法如下：

~~~sh
build_options="--define QNX_PROFILER=all" \
./pipeline/package.sh
~~~

这两个入口应二选一。不要把 **QNX_PROFILER=...** 和同一个模式的 **build_options=--define ...** 同时传入，以免最终命令重复；更不要使用不存在的 **--config=qnx_profiler_all**。

仍需保持旧 On-CPU 打包流程时，可以继续使用兼容入口：

~~~sh
build_options="--config=qnx_profiler" \
./pipeline/package.sh
~~~

当前最新提交下，上述旧命令仍会得到 On-CPU 的运行时配置；与新入口 **QNX_PROFILER=oncpu** 的车端采集行为相同。两者的差别在于旧入口还会启用 C++ toolchain feature。

### 各模式最终写入包内 machine_config 的运行时变量

| 打包模式 | LD_PRELOAD | QNX_PROFILER_DISABLE_ONCPU | QNX_PROFILER_OFFCPU_ENABLE | QNX_PROFILER_OFFCPU_INTERVAL_MS | 采集效果 |
| --- | --- | --- | --- | --- | --- |
| 不传新旧开关 | 不含 libqnx_profiler.so | 不设置 | 不设置 | 不设置 | 不采集 |
| QNX_PROFILER=oncpu | 含 libqnx_profiler.so | 不设置 | 不设置 | 不设置 | 仅 On-CPU |
| QNX_PROFILER=offcpu | 含 libqnx_profiler.so | 1 | 1 | 100 | 仅 Off-CPU |
| QNX_PROFILER=all | 含 libqnx_profiler.so | 不设置 | 1 | 100 | On-CPU + Off-CPU |
| --config=qnx_profiler | 含 libqnx_profiler.so | 不设置 | 不设置 | 不设置 | 仅 On-CPU（兼容路径） |

这里的 **QNX_PROFILER=all** 与车端进程环境不是同一个层级：

1. 命令前的 **QNX_PROFILER=all** 是 package.sh 读取的 shell 环境变量。
2. package.sh 将其转为 Bazel 参数 **--define QNX_PROFILER=all**。
3. Bazel 的 select() 决定 Jsonnet 的 **qnx_profiler_mode**。
4. Jsonnet 生成 machine_config，并在车端进程环境中写入 **LD_PRELOAD**、**QNX_PROFILER_OFFCPU_ENABLE** 等真正控制 profiler 的变量。

打包日志中的 **build_options=...** 应能看到 **--define QNX_PROFILER=all**（或所选模式），可作为入口是否生效的第一项检查。

### 车型范围与例外

**LP8650-OS-SHARE** 仍只读取旧的 **@deeproute_build_tools//:qnx_profiler_on** 条件，尚未接入三个新 config_setting。为该车型单独传入 **QNX_PROFILER=oncpu/offcpu/all** 不会启用新模式；若需要 Off-CPU 或 all，应在该车型自己的 driver DEM 配置中完成同样的迁移。

## 原因

### 两条配置链路在 Bazel 与运行时的分工不同

旧链路既包含 driver 的运行时开关，也包含 C++ toolchain feature：

~~~text
--config=qnx_profiler
  → bazel_configs 的 build:qnx_profiler
  → @deeproute_build_tools//:qnx_profiler=ON
  → @deeproute_build_tools//:qnx_profiler_on 命中
  → Jsonnet 的 use_profiler=true
  → machine_config 的 LD_PRELOAD 加入 libqnx_profiler.so（On-CPU）

  └→ --features=qnx_profiler
      → QNX C++ toolchain feature
      → 对适用编译 action 追加 -DQNX_PROFILER=1
~~~

新链路只解决 driver 打包后运行时应启用哪种采集模式：

~~~text
QNX_PROFILER=all
  → pipeline/package.sh
  → --define QNX_PROFILER=all
  → driver 中 :qnx_profiler_all 命中
  → select() 传入 qnx_profiler_mode=all
  → Jsonnet 写入 LD_PRELOAD 与 Off-CPU 环境变量
~~~

这解释了为何新方案不需要为了模式选择而新建 **--config=qnx_profiler_all**：它直接消费的是 **--define**，不是 Bazel RC 预设名。

### feature 与 create_engineering_flag_set 的作用

**feature** 是 Bazel C/C++ toolchain 的能力开关，不等同于 config_setting，也不等同于 shell 环境变量。旧 RC 中的 **--features=qnx_profiler** 开启名为 **qnx_profiler** 的 toolchain feature。

工程生成的 **create_engineering_flag_set(...)** 是一个辅助函数：它创建带条件的 C/C++ flag_set，在 feature 已开启、且目标的工程作用域满足要求时，才对编译 action 加上指定编译参数。qnx_profiler 的实例指定了：

~~~text
feature_name=qnx_profiler
copt=-DQNX_PROFILER=1
~~~

因此 **-DQNX_PROFILER=1** 是旧 feature 可能附加给 C/C++ 编译器的宏；**--define QNX_PROFILER=all** 则是 Bazel 配置键值。两者同名但层级和语义不同，后者不会自动变成前者。

当前检索到的 profiler 运行时行为由 **LD_PRELOAD**、**QNX_PROFILER_DISABLE_ONCPU** 和 **QNX_PROFILER_OFFCPU_ENABLE** 等环境变量控制；未发现 driver/onboard_application 源码直接以 **#ifdef QNX_PROFILER** 或 **defined(QNX_PROFILER)** 消费该编译宏。因此在这三个已迁移 DEM 上，旧方式与新 **oncpu** 方式的运行时 On-CPU 结果相同，构建层才存在 feature/macro 的差异。

### 为什么 bazel_configs 暂时不需要随 driver 修改

本次新模式是 driver 内部生成 DEM 运行时配置的选择逻辑，本地 config_setting 已能完成匹配；共享的 bazel_configs 无需为此立刻增加 **qnx_profiler_all**。

保留旧 **qnx_profiler** 仍有价值：

- 它是已有调用方可继续使用的兼容接口。
- 它仍可能被其他仓库或尚未迁移的车型使用。
- 它保留了 C++ feature 与 **-DQNX_PROFILER=1** 的既有语义；没有完成全量消费者审计前不应删除。

如果未来要把接口统一成共享的 `--config=qnx_profiler_<mode>`，那应作为独立的跨仓库迁移：同时定义 RC alias/build setting、决定 C++ feature 是否继续适用、迁移所有 DEM 与 CI 调用方，并验证向后兼容。它不是当前 driver 新模式能够单独推出的改动。
