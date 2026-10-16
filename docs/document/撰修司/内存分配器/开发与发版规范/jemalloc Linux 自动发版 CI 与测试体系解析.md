---
title: "jemalloc Linux 自动发版 CI 与测试体系解析"
date: 2026-10-16
description: "> 基于 /sandbox/jemalloc 当前仓库及 /sandbox/cicd-common 模板。公共 include 使用 ref: development，后续变动需以实际 pipeline 展开脚本为准。"
categories:
  - "撰修司"
tags: []
---

# jemalloc Linux 自动发版 CI 与测试体系解析

> 基于 /sandbox/jemalloc 当前仓库及 /sandbox/cicd-common 模板。公共 include 使用 ref: development，后续变动需以实际 pipeline 展开脚本为准。

## 0. 一句话总览

jemalloc Linux 发版由 .gitlab-ci.yml 按 Ubuntu/目标平台拆成独立 job。job 通过相应构建环境、SUBPROJECT_ID 获取平台 Debian control，调用公共 cicd-common 模板构建和上传。每个平台的单个 job 会在 pipeline/Makefile.deb 中分别编译两个变体，再把它们装入一个平台专属 deb。

- libjemalloc.so.2：configure 启用 stats 和 profiler。
- libjemalloc_minimal.so.2：另一次 configure 关闭 stats/profiler，复制后改文件名。
- 非 tag 流程走 snapshot；tag 流程走 release。
- 当前发布 CI 没有 make check 或 jemalloc 专属运行时测试 job；构建/上传成功不能证明运行时策略或目标设备兼容性已通过。

## 1. 发布包形态

### 1.1 安装布局

包安装根目录为 /opt/deeproute/jemalloc/：

    opt/deeproute/jemalloc/
    ├── include/                         # profile 安装树的头文件
    └── lib/
        ├── libjemalloc.so.2             # --enable-stats --enable-prof
        ├── libjemalloc_minimal.so.2     # --disable-stats --disable-prof，复制后改名
        └── profile 构建的其他 install 产物

minimal 文件只是从其安装目录复制并改名，Makefile.deb 没有修改 ELF 内容。磁盘文件名不一定等于 ELF SONAME；如需按该名字链接，单独核对 readelf -d。常见加载方式是 LD_PRELOAD 指向实际文件绝对路径。

### 1.2 profile/stats 开关语义

| 加载库 | MALLOC_CONF | JEMALLOC_STATS_ENABLE | interval/dir 有效时的输出 |
|---|---|---|---|
| profile | prof:true | 未设或非 true | heap profile |
| profile | prof:true | 精确 true | heap profile + stats |
| profile | prof:false | 精确 true | 仅 stats |
| profile | prof:false | 未设或非 true | 不启动自动 dump，不解析 interval/dir |
| minimal | 任意（包括 prof:true） | 任意 | 不执行 heap/stats 自动 dump |

profile 库在编译时含 profiler 代码；运行时 heap dump 由 MALLOC_CONF 的 prof:true 控制。JEMALLOC_STATS_ENABLE 只有值恰为 true 才开启 stats，stats-only 与 heap profile 共用 JEMALLOC_PROF_TIME_INTERVAL 和 JEMALLOC_AUTODUMP_DIR；interval 必须是正整数，目录支持环境变量展开。prof:false 且 stats 未开启时，不会解析 interval/dir。minimal 编译时禁用了 profiler/stats 自动 dump 实现，但其他 jemalloc MALLOC_CONF 参数仍然生效。

### 1.3 平台和包架构矩阵

来自 pipeline/config.xml 和 .gitlab-ci.yml：

| SUBPROJECT_ID | 平台 | Debian Architecture | runner/build env | apt source 后缀 |
|---|---|---|---|---|
| ubuntu18 | Ubuntu 18.04 x86 | amd64 | mapping；x86-env-ubuntu18.04 | 1804 |
| ubuntu20 | Ubuntu 20.04 x86 | amd64 | mapping；x86-env-ubuntu20.04 | 2004 |
| ubuntu20-orin | Ubuntu 20.04 Orin/ARM | arm64 | arm-platform；arm-env-ubuntu20.04 | 2004 |
| thoru | Ubuntu 24.04 ARM64 | arm64 | arm-platform；Thoru ARM 镜像 | 2404 |

每个 subproject 单独生成 deb；amd64/arm64 不是一个 universal 包。package Architecture 元数据由公共 control 流程和 subproject 配置决定。

## 2. .gitlab-ci.yml 与公共模板

### 2.1 include 和触发规则

仓库 include cicd-common 的 global/build/lib CI 文件及 module-version 导出模板；本地 build job 继承公共 project/build.gitlab-ci.yml：

- .build：非 tag 构建（except tags），用于 snapshot。
- .build-release：tag 构建（only tags），用于 release。

公共命令大致顺序：

    进入仓库 pipeline/
    -> 白名单/协议依赖检查
    -> 获取依赖和 snapshot/release control
    -> before_build_deb
    -> old_make_deb
    -> after_build_deb
    -> old_upload_deb(snapshot/release)
    -> release 额外 add-dr-package hook

control、make deb、上传实现由 cicd-common/project/reference.gitlab-ci.yml 等公共文件提供。

### 2.2 八个发布 job

每个平台各有 snapshot/release job：

| Snapshot | Release | 目标 |
|---|---|---|
| build:ubuntu18 | build-release:ubuntu18 | Ubuntu 18.04 amd64 |
| build:ubuntu20 | build-release:ubuntu20 | Ubuntu 20.04 amd64 |
| build-orin:ubuntu20-orin | build-release-orin:ubuntu20-orin | Ubuntu 20.04 arm64 / Orin |
| build-ubuntu2404-arm64-snapshot | build-ubuntu2404-arm64-release | Ubuntu 24.04 arm64 / Thoru |

x86 使用 mapping tag 和各自 x86 env artifacts；Orin/Thoru 使用 arm-platform，Orin needs arm env job，Thoru 指定 ARM image。SUBPROJECT_ID 选择 control 配置，snapshot_source/release_source 选择上传仓库。source 分别对应 1804、2004、2404 后缀。大多数 release job 设置 REDEPLOY=true，Thoru 沿用公共模板默认值。

### 2.3 上传后打印下载地址

本地新增隐藏 job .jemalloc-snapshot/.jemalloc-release，在引用完整公共 build/release 脚本之后调用：

    pipeline/print_deb_url.py --control /pipeline/DEBIAN/control --source <snapshot_source 或 release_source>

脚本从实际 control 读取 Package、Version、Architecture，输出：

    DEB_DOWNLOAD_URL=https://apt.deeproute.cn/<source>/pool/d/<package>/<package>_<version>_<architecture>.deb

因此每个上传 job 都会有可复制的 apt 地址日志；snapshot 即使跳过 cache verification 也能打印。release 公共脚本确认 Nexus 上传后，本地步骤打印 apt 预期地址，但不会额外轮询验证 cache 已同步。

### 2.4 多架构如何编译、打包、上传

并非一个 job 交叉构建所有架构，而是按平台拆分：

1. GitLab 依据 mapping/arm-platform tags 选择 runner；x86/ARM build-env job 准备对应镜像/环境，构建 job 用 needs 接收产物。
2. 各 job 通过不同 SUBPROJECT_ID 获取平台 control，写入架构/版本等 deb 元数据。
3. job 在对应构建环境运行同一个 pipeline/Makefile.deb，将 profile + minimal 两个库装入一个该平台 deb。
4. old_upload_deb 读取 control，并根据 snapshot_source/release_source 上传对应 Nexus apt 源。

pipeline/Makefile.deb 没有显式传 --host，因此发布流程依赖 job 的构建环境/runner 默认编译器。仓库根目录 build_jemalloc.bash 是开发者另行调用的手动构建脚本，含 Orin/Thoru 交叉工具链；当前 Debian 发布 Makefile 没有调用它。不能将手动脚本的交叉编译参数误认为 CI 实际命令链。

## 3. 构建、打包与上传顺序

### 3.1 双变体构建

pipeline/Makefile.deb 的 all -> createdeb -> build 负责组包：

1. 为 profile/minimal 分别创建临时 out-of-tree build 目录并在退出时清理。
2. 删除旧的 /pipeline/opt/deeproute/jemalloc，运行 update_python.bash 和 autogen.sh。
3. profile 目录执行 configure --enable-stats --enable-prof --enable-pi-mutex、make -j8、make install。
4. minimal 目录执行 configure --disable-stats --disable-prof --enable-pi-mutex、make -j8、make install。
5. profile 安装树复制到 /pipeline/opt/deeproute/jemalloc；minimal 的 libjemalloc.so.2 复制为 libjemalloc_minimal.so.2。
6. 复制 pipeline/DEBIAN 并替换包名，然后 createdeb 在 /pipeline 执行 dpkg-deb。

两个变体使用独立 build dir，避免 configure 状态互相覆盖。

### 3.2 CI deb 路径改写

公共 old_make_deb 用 sed 改写 Makefile 中 dpkg-deb -b 的输出路径为 /tmp/$FILENAME_DEB，再执行 make。故本地默认输出到 /pipeline/$(REPO_NAME).deb；CI 上传使用 /tmp/jemalloc.deb（具体名称由 FILENAME_DEB 提供）。

### 3.3 control 与上传

仓库 pipeline/DEBIAN/control 是占位模板；CI 通过 API 根据 subproject/version 生成 /pipeline/DEBIAN/control，含 Package、Version、Architecture、Depends 等字段。共享上传脚本将 /tmp 下的 deb POST 到 Nexus snapshot/release source。apt 可见地址遵循：

    https://apt.deeproute.cn/<source>/pool/d/<package>/<package>_<version>_<architecture>.deb

新脚本打印的是 apt 下载入口，不是含凭证的 Nexus 上传 API 地址。

## 4. CI 测试覆盖与未覆盖项

### 4.1 流水线会做

- 公共白名单、协议依赖和 control 准备检查。
- 对两个变体分别 configure/make/install；失败会阻断后续打包。
- 生成 deb 并按 snapshot/release 路由上传；snapshot 通常验证 apt cache，release 还运行注册 hook。
- 成功后打印 DEB_DOWNLOAD_URL。

### 4.2 流水线没有做

- pipeline/Makefile.deb 没有 make check。
- 没有独立 job 验证 prof:false + stats-only、minimal 忽略自动 dump 环境变量、MALLOC_CONF 其他参数仍有效等运行时契约。
- 新增 URL echo 不等于下载/HTTP 验证，release 地址不一定立刻完成 apt cache 同步。
- 构建/上传成功不等同于目标设备 ABI、动态加载、页面大小、性能等验收通过。

### 4.3 建议的 smoke test 矩阵

| 库/配置 | 期望结果 |
|---|---|
| profile，prof:true，stats 未开 | 产生 .heap |
| profile，prof:true，stats=true | 产生 .heap 和 .stats |
| profile，prof:false，stats=true | 只产生 .stats |
| profile，prof:false，stats 未开 | 不产生 dump |
| minimal，即使 prof:true、interval、dir、stats=true | 不产生 heap/stats；其他 MALLOC_CONF 仍生效 |

另检查 file/readelf 的 ELF Machine/SONAME/依赖及 dpkg-deb -c 的包路径。该矩阵当前属于建议验收，不能宣称已由 CI 自动运行。

## 5. 多架构构建风险与边界

- 架构隔离发生在 job 层：amd64、arm64 各有环境、control 和 deb，不是同一个 deb 改名。
- runner tag/build image 选择构建环境，Architecture 字段是包元数据；应额外确认 ELF Machine 与其相符。
- Ubuntu 20 amd64 与 Ubuntu 20 Orin arm64 是不同 subproject/产物，虽 apt source 后缀都为 2004。
- 本地 build_jemalloc.bash 有 --host/sysroot/toolchain 参数，CI 发布 Makefile 没有使用它。
- 手动交叉构建脚本提示目标 page size 可能需显式 lg_page；当前发布 Makefile 未传 --with-lg-page。ARM 目标若非 4 KiB page，应验证配置和二进制行为。

## 6. 开发者发版 SOP

1. 修改代码和适当运行时测试，保持 profile/minimal 编译开关语义正确。
2. 更新 pipeline/config.xml 四个 subproject 版本及需要同步的 Architecture/描述等元数据。
3. 本地构建两个变体；交叉脚本测试不能代替 CI 和目标设备验收。
4. 推送分支触发 snapshot，检查构建、包内容、control、架构、上传日志及 DEB_DOWNLOAD_URL。
5. 按第 4.3 节在目标平台验证；特别检查 prof:false + JEMALLOC_STATS_ENABLE=true 只输出 stats。
6. 发布 tag 触发 release。确认每个平台上传/注册 hook，再记录地址；不能把 echo 当作下载验证。
7. 归档 tag/commit、包版本、平台、Architecture、两个库校验和、URL、运行时结果及 page size/toolchain。

### 文件变更速查

| 改动 | 文件 |
|---|---|
| profile/stats dump 语义 | src/prof_auto_dump.c 和运行时测试 |
| 双库构建/安装/组包 | pipeline/Makefile.deb |
| 版本、subproject、架构、描述 | pipeline/config.xml |
| job 矩阵、source、上传地址输出 | .gitlab-ci.yml |
| apt URL 生成 | pipeline/print_deb_url.py |
| 手动交叉构建 | build_jemalloc.bash |

## 7. 相关文件

| 路径 | 作用 |
|---|---|
| /sandbox/jemalloc/.gitlab-ci.yml | 平台矩阵、模板继承、上传后地址输出 |
| /sandbox/jemalloc/pipeline/Makefile.deb | profile/minimal 双构建和打包 |
| /sandbox/jemalloc/pipeline/config.xml | control 输入和平台映射 |
| /sandbox/jemalloc/pipeline/DEBIAN/control | control 占位模板 |
| /sandbox/jemalloc/pipeline/print_deb_url.py | 输出 apt 下载 URL |
| /sandbox/jemalloc/src/prof_auto_dump.c | 自动 heap/stats dump 逻辑 |
| /sandbox/jemalloc/build_jemalloc.bash | 手动多平台/交叉构建脚本 |
| /sandbox/cicd-common/project/build.gitlab-ci.yml | build/release 主流程 |
| /sandbox/cicd-common/project/reference.gitlab-ci.yml | control、deb、上传实现 |

## 8. 待办与发版风险

1. 把第 4.3 节运行时矩阵加入 CI 自动测试。
2. 考虑固定 cicd-common 的不可变 commit/tag，降低 development 分支变动影响。
3. 校验每个平台 ELF Machine 与 control Architecture 一致。
4. 检查 minimal 文件的内部 SONAME/动态依赖，并明确消费者加载约定。
5. 确认 ARM 目标 page size；当前 CI recipe 未配置 lg_page。
6. 若要求 release URL 可用性作为成功门槛，增加带重试的 HTTP/下载校验；目前后置步骤只 echo URL。

