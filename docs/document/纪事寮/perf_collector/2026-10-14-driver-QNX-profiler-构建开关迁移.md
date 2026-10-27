---
title: "Driver QNX Profiler：模式开关与运行时状态统一"
date: 2026-10-14
description: "说明 driver 如何通过 QNX_PROFILER 选择 profiler 打包模式，以及 profiler 库和 monitor 如何统一使用 QNX_PROFILER_MODE 控制运行时行为。"
categories:
  - "纪事寮"
tags: []
---

# Driver QNX Profiler：模式开关与运行时状态统一

本文说明 QNX profiler 当前的构建和运行时配置：打包时通过 **QNX_PROFILER=oncpu|offcpu|all** 选择采集模式，车端进程统一通过 **QNX_PROFILER_MODE** 判断是否开启 On-CPU 或 Off-CPU。旧的 **--config=qnx_profiler** engineering feature 不再作为兼容入口。

## 背景

### 从单一开关改为选择采集模式

原有方案通过 bazel_configs 中的 `qnx_profiler` RC 预设启用 On-CPU 采样，同时开启 C/C++ toolchain feature。该 feature 曾将 `-DQNX_PROFILER=1` 添加到适用的编译 action。现在 profiler 改为由打包配置选择 On-CPU、Off-CPU 或两者同时启用；旧 RC 预设和 engineering feature 已从 bazel_configs 移除。

~~~bazelrc
build:qnx_profiler --@deeproute_build_tools//:qnx_profiler=ON
build:qnx_profiler --features="qnx_profiler"
~~~

driver 在公共 `config/qnx_profiler` 中定义模式条件和 selector，以下 DEM 共用同一套选择规则：

- LP8650-V1-SHARE
- LP8650-OS-SHARE
- LP8797-V1-SHARE
- LP8797-V2-SHARE

### 构建入口与运行时状态的分工

| 维度 | 构建入口：QNX_PROFILER=模式 | 车端状态：QNX_PROFILER_MODE |
| --- | --- | --- |
| 用途 | 由 package.sh 转换为 Bazel `--define`，供 config_setting 匹配 | machine_config 注入所有相关进程，供 profiler 库和 monitor 判断模式 |
| 可用值 | `oncpu`、`offcpu`、`all`；未指定时为 `none` | `none`、`oncpu`、`offcpu`、`all` |
| 决定的行为 | profiler 库是否进入 release package，以及生成哪种运行时配置 | profiler 库初始化哪些采集器，monitor 扫描哪些共享内存 |
| C/C++ 编译选项 | 不会开启旧 toolchain feature，也不会注入 `-DQNX_PROFILER=1` | 不控制 C/C++ 编译参数 |

`qnx_profiler_oncpu`、`qnx_profiler_offcpu` 和 `qnx_profiler_all` 是 BUILD 中的 `config_setting` 名称。它们检查 Bazel 收到的 `--define QNX_PROFILER=...`，本身不会设置该值。因此 `--config=qnx_profiler_all` 会报“Config value is not defined in any .rc file”：这不是 `.bazelrc` 中定义的 config 名称。

正确的因果关系是：

~~~text
--define QNX_PROFILER=all
            ↓
:qnx_profiler_all 这个 config_setting 条件成立
            ↓
select() 选择 qnx_profiler_mode=all
~~~

所以构建参数 **QNX_PROFILER=all 是因**，**qnx_profiler_all 条件命中是果**；selector 随后将 `all` 传给 Jsonnet。`QNX_PROFILER_MODE=all` 则是生成到车端配置中的运行时结果，不是构建输入。

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

这两个入口应二选一。不要同时设置 **QNX_PROFILER=...** 和同模式的 **build_options=--define ...**，否则会重复传入构建定义。旧的 **--config=qnx_profiler** 不再兼容；不要将 BUILD 中的 `config_setting` 名称误当作 `--config` 参数。

### 各模式最终写入包内 machine_config 的运行时变量

| 打包模式 | LD_PRELOAD | QNX_PROFILER_MODE | QNX_PROFILER_OFFCPU_INTERVAL_MS | 采集效果 |
| --- | --- | --- | --- | --- |
| 未设置 QNX_PROFILER | 不含 libqnx_profiler.so | none | 不设置 | 不采集 |
| QNX_PROFILER=oncpu | 含 libqnx_profiler.so | oncpu | 不设置 | 仅 On-CPU |
| QNX_PROFILER=offcpu | 含 libqnx_profiler.so | offcpu | 100 | 仅 Off-CPU |
| QNX_PROFILER=all | 含 libqnx_profiler.so | all | 100 | On-CPU + Off-CPU |

这里的 **QNX_PROFILER=all** 与车端进程环境不是同一个层级：

1. 命令前的 **QNX_PROFILER=all** 是 package.sh 读取的 shell 环境变量。
2. package.sh 将其转为 Bazel 参数 **--define QNX_PROFILER=all**。
3. Bazel 的 select() 决定 Jsonnet 的 **qnx_profiler_mode**。
4. Jsonnet 生成 machine_config，在相关车端进程中设置 **LD_PRELOAD** 和 **QNX_PROFILER_MODE**；profiler 库与 monitor 均读取该 mode。Off-CPU 周期仍通过 **QNX_PROFILER_OFFCPU_INTERVAL_MS** 配置。

打包日志中的 **build_options=...** 应能看到 **--define QNX_PROFILER=all**（或所选模式），可作为入口是否生效的第一项检查。

### 车型范围与例外

上述四个 DEM 均已使用公共 mode selector。其他车型是否注入 profiler，仍取决于其 machine_config 和打包规则；本次公共规则迁移没有自动改变其他车型的运行时配置。

## 原因

### 两条配置链路在 Bazel 与运行时的分工不同

旧链路曾将 driver 的运行时开关和 C++ toolchain feature 绑定在同一个 RC 预设中：

~~~text
--config=qnx_profiler
  → bazel_configs 的 build:qnx_profiler
  → @deeproute_build_tools//:qnx_profiler=ON
  → @deeproute_build_tools//:qnx_profiler_on 命中
  → Jsonnet 的 use_profiler=true
  → machine_config 的 LD_PRELOAD 加入 libqnx_profiler.so
  → --features=qnx_profiler 开启 toolchain feature
  → 对适用编译 action 追加 -DQNX_PROFILER=1
  → 上述旧 feature 和 RC 入口现已从 bazel_configs 移除
~~~

新链路只解决 driver 打包后运行时应启用哪种采集模式：

~~~text
QNX_PROFILER=all
  → pipeline/package.sh
  → --define QNX_PROFILER=all
  → driver 中 :qnx_profiler_all 命中
  → select() 传入 qnx_profiler_mode=all
  → Jsonnet 写入 LD_PRELOAD、QNX_PROFILER_MODE 和 Off-CPU 周期配置
  → profiler 库与 monitor 读取同一个 QNX_PROFILER_MODE
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

这段旧配置解释了 `create_engineering_flag_set(...)` 和编译宏的历史用途；当前 profiler 启停不依赖该宏。运行时由 profiler 库和 monitor 共同读取 **QNX_PROFILER_MODE**，其中 `none` 不启动采集或周期扫描，`oncpu`、`offcpu`、`all` 分别决定对应功能。

### 为什么 mode 选择放在 driver，运行状态使用单一变量

`QNX_PROFILER` 是打包阶段的输入，用来选择产物和生成配置；`QNX_PROFILER_MODE` 是部署给进程的运行时状态。两者处于不同阶段，但 mode 值由同一条构建选择链路传递，避免 profiler 库和 monitor 分别维护启停条件。

driver 内的 `config_setting` 直接匹配 `--define QNX_PROFILER=<mode>`，因此无需在 bazel_configs 新增 `--config=qnx_profiler_<mode>`。旧的 `qnx_profiler` engineering feature、RC alias 和 `-DQNX_PROFILER=1` 注入已移除；现有打包调用应迁移到 `QNX_PROFILER=...` 或 `build_options="--define QNX_PROFILER=..."`。
