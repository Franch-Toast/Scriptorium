---
title: 03 Bazel 构建与测试包交付
date: 2026-10-30
description: 公司工具链接入、11 组构建配置、默认和选包交付，以及静态运行依赖核验。
categories: [撰修司]
tags: [PlatformBench, Bazel, 工具链, 测试交付]
---

# 03 Bazel 构建与测试包交付

## 1. 当前构建环境与职责

实现仓库为 `/sandbox/PlatformBench`，使用 Bazel **7.6.1**、C++17 和默认 `opt` 模式。
开发主机为 Linux x86_64，主机脚本要求 Python **3.8+**、Git、`readelf`；
原生编译使用本机 C++ 编译器，交叉编译需要公司依赖下载和 SDK Git SSH 读取权限。

`WORKSPACE` 通过 `local_repository` 接入 `/sandbox/bazel_configs`，
当前接入基线提交为 `9b9a0e3d8c38bcbd3b107df389dd3c4d3a264f35`。
`.bazelrc` 导入公司基础配置并定义本仓库别名，`toolchains/defs.bzl` 注册公司工具链。
编译器、sysroot、ABI 和基本编译/链接选项复用公司规则；项目不保存 SDK 二进制，也不修改共享配置。

外部依赖采用 WORKSPACE 机制，当前固定版本如下：

| 依赖 | 固定版本与来源 |
| --- | --- |
| GoogleTest | 公司 fork `third-party-repos/googletest.git`，提交 `4cdf9db16d8e1c1ca7341cc8b528dd4fe06e96b3` |
| Google Benchmark | 提交 `56f52ee228783547f544d9ac4a533574b9010e3f` 的归档，校验 SHA-256 |
| rules_pkg | `0.10.1`，校验 SHA-256，供公司 SDK BUILD 加载打包规则 |
| bazel_skylib | `1.7.1`，公司归档并校验 SHA-256 |

实际定义以 `WORKSPACE` 为准。升级依赖时同时核验公司补丁、许可证与各目标构建。

## 2. 已接入的构建矩阵

| config | 目标与 sysroot | 公司工具链/配置 |
| --- | --- | --- |
| `host` | 本机 Linux x86_64 | Bazel 本机 C++ 工具链 |
| `linux-aarch64-orin` | Linux AArch64，Ubuntu 20.04 | `gcc_x86_aarch64` / `cross_compile_orin` |
| `linux-aarch64-thoru` | Linux AArch64，Ubuntu 24.04 | `gcc_13_x86_aarch64` / `cross_compile_thoru` |
| `linux-aarch64-m97` | Linux AArch64，Ubuntu 24.04 | `gcc_13_3_x86_aarch64` / `cross_compile_m97` |
| `linux-aarch64-j6p` | Linux AArch64，Debian 12 | `gcc_12_x86_aarch64` / `cross_compile_j6p` |
| `qnx71-x86` / `qnx71-aarch64` | QNX SDP 7.1，x86_64/AArch64 | `qcc_x86` / `qcc_x86_aarch64` |
| `qnx80-x86` / `qnx80-aarch64` | QNX SDP 8.0，x86_64/AArch64 | `qcc_sdp8_x86` / `qcc_sdp8_x86_aarch64` |
| `qnx80v2-x86` / `qnx80v2-aarch64` | 公司 SDP 8 v2，x86_64/AArch64 | `qcc_sdp8_v2_x86` / `qcc_sdp8_v2_x86_aarch64` |

“v2”沿用公司工具链名称，不代表另一个 QNX 产品版本。表中是构建目标与 SDK 组合，
不能仅凭构建通过推断实际 BSP 与板卡运行兼容。

### QNX SDK 适配的原因与范围

公司规则固定下载 Debian SDK 包。部分 x86 规则只展开 Debian 外层，
制包脚本又主动删除了 `target/*/x86_64` 目标库，直接接入无法完成链接。
`toolchains/qnx_sdk.bzl` 仅补齐项目确需的布局与版本一致性：

1. 从固定 Debian 包复用 SDK 宿主程序、公共头文件与许可数据，保留 wrapper 的 host/target 相对关系。
2. 从 SDK Git 的命名标签归档恢复 x86 `lib/`、`usr/lib/`，验证归档内完整提交号，
   再核对 Debian control 的 `Commit_id`；标签移动或提交不匹配时失败。
3. 生成 x86 host/target 视图，并映射公司 x86 内建头文件路径元数据；
   保留公司编译和链接选项、沙箱和头文件依赖校验。
4. `qnx-libcS` 声明真实 SDK 的 `libcS.a` 输入，放在独立路径，避免影响各版 SDK 的标准库搜索；
   第一阶段不接入公司 mcount 插桩库。

| Debian SDK | 恢复标签 | 固定源码提交 |
| --- | --- | --- |
| `7.1.4` | `7.1.4-lto-wrapper` | `c71bb370c87ec3b1c3607103f84d4309785d6d81` |
| `8.1.1` | `8.1.1-lto-wrapper` | `96e96ab3e58b726cd13334a2b458d0c4f6b8fd11` |
| `8.1.4` | `es51-8.1.4` | `6965919c2a43c11947d4f7ca8d5f13ab1c6a9b25` |

SDP 7 的 Git 仓库为 `code.deeproute.ai:deeproute-org/os/all-member/toolchains_qnx.git`，
SDP 8 两版为 `code.deeproute.ai:deeproute-org/all-member/toolchains_qnx_sdp8.git`，使用 Git SSH。
不会从开发机其他 SDK 补库或静默切换版本。SDK 工具许可和下载权限仍由使用环境保证。

## 3. 目标组织与实际命令

| 目标 | 类型与用途 |
| --- | --- |
| `//cases/requirements/os:os_requirements_test` | `cc_test`，目标机 OS 检查，也可本机执行 |
| `//cases/benchmarks/cpu:integer_benchmark` | `cc_binary`，原生 CPU 基准 |
| `//cases/benchmarks/memory:bandwidth_benchmark` | `cc_binary`，原生内存基准 |
| `//platform:system_info` | `cc_library`，按真实 OS 约束选择唯一实现 |
| `//support:pb_process` | `cc_binary`，目标机进程辅助 |
| `//tests:workflow_test` | `py_test`，仅 Linux x86_64 宿主机编排回归 |
| `//:host_tests` | `test_suite`，聚合 OS GTest 和工作流回归 |
| `//:target_programs` | `filegroup`，仅聚合目标程序构建，不测量性能 |
| `//packaging:default_bundle` | `platformbench_bundle`，三个示例与进程辅助 |
| `//packaging:memory_bundle` | `platformbench_bundle`，仅内存示例与进程辅助 |

OS 选择使用 `@platforms//os:linux` / `qnx`，未知 OS 明确编译失败。
不兼容目标使用 Bazel 平台约束表达，无关 SDK 不加入公共依赖。

```sh
cd /sandbox/PlatformBench
python3 scripts/bazel.py test --config=host --test_output=errors //:host_tests
python3 scripts/bazel.py build --config=qnx71-aarch64 //:target_programs
python3 scripts/bazel.py run --config=host //cases/benchmarks/cpu:integer_benchmark -- --benchmark_min_time=0.05
```

交叉 GTest 先构建再部署，不能在 Linux 开发机直接运行 QNX 或其他架构的 ELF。
不使用无约束的 `bazel test //...` 执行所有目标；性能证据来自原生程序实际运行，
不使用 Bazel 测试缓存。

`scripts/bazel.py` 在 ASCII 路径直接使用当前仓库；若仓库路径含中文，
将源码复制到 `/sandbox/.platformbench/<路径哈希>` 再调用 Bazel，规避 Bazel 7 JVM 客户端路径问题。
同步排除结果、构建产物和设计资料，包内仍记录原始源码位置和内容快照。

## 4. 默认集合与选择目标打包

```sh
# 默认包：OS、CPU、内存和进程辅助。
python3 scripts/package.py --config host --build-id phase1 \
  --output ./out/platformbench-host-phase1

# 交叉包：只构建和静态核验，交给匹配的目标板执行。
python3 scripts/package.py --config linux-aarch64-orin --build-id phase1 \
  --output ./out/platformbench-orin-phase1

# 选包：仅内存示例与进程辅助，自动生成匹配的清单。
python3 scripts/package.py --config host --build-id memory-only \
  --bundle-target //packaging:memory_bundle --output ./out/platformbench-memory
```

输出目录和相邻 `.tar.gz` 必须尚不存在，脚本拒绝覆盖旧版本。
新增选包在 `packaging/BUILD` 声明 `platformbench_bundle`，逐项对应 `programs` 与 `frameworks`，
并声明 `assets`、源码集合 `sources` 和从固定版本外部依赖取得的 `licenses`。
默认包使用 `suites/default.sh`；选包没有显式清单时，按其真实程序生成默认清单。

`packaging/bundle.bzl` 从 Bazel `DefaultInfo` 收集可执行文件、默认 runfiles 和工具链运行库候选，
生成描述交给主机 `package.py`。运行数据保留 Bazel workspace 身份，
包清单登记目标、包内程序路径、框架和实际 runfile 路径。
缺程序、必需运行依赖、已声明的许可文件或数据时明确失败。

修改 filter、顺序和参数无需重新编译；增加包中没有的程序、数据或 SDK 必须重新交付。
当前所有构建配置共用三个通用示例，后续按真实平台适用性维护各自默认集合。

## 5. 交付目录与依赖核验

```text
platformbench-<target>-<build-id>/
  bin/                         # 原生程序、pb_process 及各程序的 .runfiles/
  lib/                         # 允许分发的 runfiles 动态库；当前示例为空
  data/                        # 用例声明的附加数据位置；当前示例无额外数据
  suites/default.sh            # 与该包匹配的受信任清单
  scripts/                     # run.sh、host.py、analyze.py
  licenses/                    # 从实际依赖收集的许可，不是源码目录
  source/                      # 本次构建完整项目源码快照
  source-sha256.txt            # 源码逐文件哈希
  manifest.tsv                # 标签、程序路径、框架和 runfiles
  build-info.json             # 来源、平台、模式、工具链和依赖版本
  runtime-dependencies.json   # ELF、加载器及递归动态依赖
  README.md                   # 生成包的最简运行指引
```

`licenses/` 在打包时直接收集外部仓库的真实 `LICENSE`，本仓库不维护副本。
默认包包含 GoogleTest/Google Benchmark 许可；内存选包仅包含 Google Benchmark 许可。
编译器、QNX SDK、基础加载器及 BSP 系统库不随包分发。

`build-info.json` 记录提交号、工作区改动、源码路径、公司配置提交、构建标识、平台、模式和工具链，
以及固定框架版本。尚无首个提交时提交号记 `unknown`，通过 `source/` 和逐文件哈希保留可追溯性；
不能只靠一个提交号或 dirty 标记描述未提交构建。

打包使用 `readelf` 静态检查 ELF64、架构、OS ABI、解释器和递归 `DT_NEEDED`。
Linux AArch64 加载器为 `/lib/ld-linux-aarch64.so.1`，QNX 为 `/usr/lib/ldqnx-64.so.2`。
QNX 7.1 使用 `libc++.so.1` / `libc.so.5`，两组 QNX 8 工具链使用 `libc++.so.2` / `libc.so.6`，
分别从对应 SDK 解析；QNX x86 依赖只从 SDK target 视图取得，不能用 Linux host 库满足。

runfiles 中允许交付的动态库收集到 `lib/`，BSP/OS 基础库只记录为外部依赖。
本机系统库由本机编译器搜索路径解析，交叉系统库由所选工具链/sysroot 解析，
不对交叉 ELF 调用 `ldd`。静态匹配只证明构建环境能解析依赖，真实目标机仍须核验符号和 BSP 兼容性。

## 6. 验证与产物管理

```sh
# 所有 11 组配置，逐项保存日志、matrix.tsv/json、ELF 证据及包。
sh scripts/build_matrix.sh --output ./out/matrix-phase1 --packages

# 仅复查选定配置；输出路径仍须是新目录。
sh scripts/build_matrix.sh --output ./out/matrix-selected \
  --config host --config qnx80-aarch64 --packages
```

矩阵单项失败后继续检查后续项，最终存在失败时返回非零；`host` 还执行 `//:host_tests`。
当前一期已验证全部 11 组配置的构建、链接、打包和静态依赖检查。
本机默认包和内存选包独立运行与解析通过，交叉目标实机运行尚未验证。

验证日志、旧包、源码快照和运行结果是可重建产物，放在调用者指定的新目录，
不提交到源码仓库，不另维护一次性验证文档。
源码清理不影响 Bazel 外部依赖缓存；需要复现时按上述命令生成新证据。

部署必须使用新目录，程序与数据只读使用、结果单独保存，不覆盖旧版本或 BSP 库。
目标机仅需 POSIX Shell、已验证基本工具、包内 `pb_process` 及匹配的 OS 运行库；
目标机独立执行不需要 Python/Bazel，主机 Python 和 SSH/SCP 用于远程场景。

执行清单、目录解释、异常与返回码见[第 04 篇](./04%20脚本运行与结果收集.md)。
