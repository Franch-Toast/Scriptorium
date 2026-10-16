---
title: "tcmalloc (gperftools) QNX 自动发版 CI 与测试体系解析"
date: 2026-10-14
description: "涉及文件：.gitlab-ci.yml、compile.bash、pipeline/、qnx_allocator_validation/ 与公共 CI 模板；覆盖 QNX 双平台四库交付"
categories:
  - 撰修司
tags:
  - QNX
  - tcmalloc
---

# tcmalloc (gperftools) QNX 自动发版 CI 与测试体系解析

> 文档性质：对 `google-gperftools` 仓库 QNX 发版流水线（GitLab CI）的逐段解析 + 测试分析 + 开发者发版 SOP 存档。  
> 初版日期：2026-09-09；最近一次代码同步：2026-10-14。
> 源码仓库：`/sandbox/google-gperftools`（GitLab `third-party-repos/google-gperftools`）  
> 本文的“当前实现”以仓库中的 `compile.bash`、`pipeline/`、`qnx_allocator_validation/` 为准。
> 正式 tag：`v2.17.2-qnx.2`；正式产物源码 SHA：`75d23a135288367bbae59b1ca3ba3c92215a79eb`  
> 涉及文件：`.gitlab-ci.yml`、`compile.bash`、`pipeline/*`、`qnx_allocator_validation/*`、公共模板 `/sandbox/cicd-common/*`

---

## 0. 一句话总览

本仓库的 QNX 发版不是"从零写 CI"，而是对 DeepRoute 公共模板 `cicd-common`  
（`/sandbox/cicd-common`，include 时锁 `ref: development`）的**最小化适配**：  
本地只写 4 个 job + 1 个注册 hook，构建、生成 Debian control、打 deb、上传、注册  
全部复用模板。当前 deb 要交付 SDP7.1/SDP8.0 的 minimal/full 共四份库。CI 保证的是
"**能编、能链、ELF/ABI/SONAME 正确、full 库含 heap-profiler 导出、包能上传并能从公开源
重新下载校验**"；QNX 实机运行验证（含 full 库实际 profile）仍由人在 CI 之外执行。

**验收结论边界（务必记住）**：8650 / 8797 双平台正式发版 + 双台架核心短测已完成，  
**不代表历史 crash 已归因，也不代表全部 QNX UT 已通过**。当前"默认使用 tcmalloc"  
是运营决策而非完整验证结论。

### 0.1 2026-10-14 双库交付变更

- 旧实现使用 `configure --enable-minimal`，只构建并打包 minimal 库。该选项会关闭
  heap profiler，因此**不会**生成 `libtcmalloc.so.10`。
- 当前实现每平台只执行一次不带 `--enable-minimal` 的完整 `configure`，再按 target 分别
  执行 `make libtcmalloc_minimal.la sampler_test` 和 `make libtcmalloc.la`。这避免第二次
  configure 和第二个构建目录；两个 libtool target 仍各自编译所需对象。
- 两次 `make` 必须分别覆盖 `LDFLAGS`，为 minimal/full 写入各自 SONAME。若在 configure
  阶段全局写死 minimal SONAME，full 库会带错误 SONAME。
- 包校验、manifest、台架 launcher、feature matrix 和回归测试均已适配 full 库，旧的
  minimal-only 制品会被当前包校验器拒绝。

---

## 1. 发布包形态

- 一个 deb 同时装两个平台产物，安装树为 `/opt/deeproute/tcmalloc/`：

  ```
  opt/deeproute/tcmalloc/
    build-receipt.txt              # 构建批次凭据：status/platform/git_sha/build_run_id
    sdp7.1/manifest.txt            # minimal/full 两份库的完整指纹
    sdp7.1/lib/libtcmalloc_minimal.so.10
    sdp7.1/lib/libtcmalloc.so.10   # 含 heap profiler 的完整库
    sdp8.0/manifest.txt            # minimal/full 两份库的完整指纹
    sdp8.0/lib/libtcmalloc_minimal.so.10
    sdp8.0/lib/libtcmalloc.so.10   # 含 heap profiler 的完整库
  ```
- 

| 平台 | QNX | tcmalloc 内部页 | 依赖 libc++ |
|-|-|-|-|
| 8650 = sdp7.1 | QNX 7.1 (SDP7.1.0) | 16 KiB | `libc++.so.1` |
| 8797 = sdp8.0 | QNX 8.0 (SDP8.0.0) | 4 KiB | `libc++.so.2` |

- 两个平台各有两份 QNX AArch64 shared ELF：minimal 的 SONAME 是
  `libtcmalloc_minimal.so.10`；full 的 SONAME 是 `libtcmalloc.so.10`。
- minimal 是默认的 malloc/free 与 C++ new/delete 接管库，不带 heap profiler；full 包含
  heap profiler，导出 `HeapProfilerStart`、`HeapProfilerDump`、`HeapProfilerStop` 和
  `IsHeapProfilerRunning`。
- 启用方式：`LD_PRELOAD=<同平台库绝对路径> <业务程序>`，无需重新链接业务代码。profile
  场景使用 `HEAPPROFILE=/tmp/heapprof LD_PRELOAD=.../libtcmalloc.so.10 <业务程序>`。
- 同一进程只能加载一个 allocator；SDP7.1 与 SDP8.0 的库不可混用，分别依赖
  `libc++.so.1` 与 `libc++.so.2`。
- **Debian `Architecture: amd64` 标记的是"交叉编译产物的宿主架构"（包在 x86 Linux  
上打出的），不是库的目标架构**。
- **QNX 本身没有 dpkg/apt**，deb 只是 Linux 侧的发布/分发载体，台架使用 = 拷库文件 +  
LD_PRELOAD。

---

## 2. `.gitlab-ci.yml` 逐段解析

### 2.1 顶层骨架

```yaml
stages: [test, build, verify]     # 依赖方向 test → build → verify
include:
  - project: deeproute-projects/public/cicd-common, ref: development
      file: project/global.gitlab-ci.yml    # 全局变量（IMAGE_*、NEXUS_*、API_HUB_URL、MAKEFILE_DEB...）
      file: project/build.gitlab-ci.yml     # 定义 .build / .build-release 两个基础 job
      file: lib/ci.gitlab-ci.yml            # 工具函数库
variables:
  REPO_NAME: tcmalloc          # 包名基础 = deeproute-<REPO_NAME>-<edition>
  FILENAME_DEB: tcmalloc.deb   # 覆盖模板默认 ${CI_PROJECT_NAME}.deb
  SUBPROJECT_ID: default       # 对应 config.xml 的 subproject id
before_script:                 # 全局 before_script（每个未覆盖它的 job 都会先执行）
  - cd "${CI_PROJECT_DIR}"
  - bash -x ./compile.bash     # QNX 双平台交叉编译，产物到 /pipeline（CI 默认 PACKAGE_ROOT）
  - cd -
```

### 2.2 四个 job

| job | stage | extends / 触发 | 做的事 |
|-|-|-|-|
| `test-ubuntu2004-amd64` | test | 无 / 任意 push | `before_script: []` 清掉构建；跑 pipeline 脚本单测 + Linux 源码 UT |
| `build-ubuntu2004-qnx-amd64-snapshot` | build | `.build` / 分支 push（except tags） | 构建 + 制包 + 上传 snapshot 源；尾部追加 `package_download.py` 产出下载 URL(dotenv) |
| `build-ubuntu2004-qnx-amd64-release` | build | `.build-release` / 仅 tag | 同上，上传 release 源 + **注册包** |
| `verify-qnx-download-url` | verify | 无 / 任意 push | `needs` 两个 build job（optional）；从公开源重新下载 deb 并做全量校验 |

**`before_script: []` 的关键性**：GitLab 中 job 定义了 `before_script` 就**完全覆盖**  
全局（不合并）。test / verify 用它跳过 `compile.bash`，build 两 job 不写则自动继承——  
一份全局声明控制三个 job 是否做重活。

### 2.3 模板展开后的真实命令链（snapshot 的 `.build`）

`.build` 在模板 `project/build.gitlab-ci.yml` 中定义，执行链（每步 `!reference` 引用  
`reference.gitlab-ci.yml` 的隐藏 job）：

| # | 引用片段 | 实际动作 | 产出 |
|-|-|-|-|
| 0 | 全局 before_script | `compile.bash` 双平台交叉编译 + 内嵌校验 | `/pipeline/opt/deeproute/tcmalloc/...` + manifest |
| 1 | 切 `pipeline` 目录，`IS_PROVIDE=true` | — | — |
| 2 | `.provide_white_list_check` | `REPO_NAME` 在白名单(python-source/car-config)则 `IS_PROVIDE=false`；tcmalloc 不在 | 保持 true |
| 3 | `.common_protocol_depend_check` | 依赖 common-protocol 的模块才注入依赖；tcmalloc 不需要 | 跳过 |
| 4 | `.old_get_control_file get_depends` | 有 driver 依赖才 clone driver 生成依赖 | 跳过 |
| 5 | `.old_get_control_file snapshot` | **POST `config.xml` 到 `hub.deeproute.ai/apt/control`**，版本服务校验并生成权威 `DEBIAN/control` 写回 | 真实 control 文件 |
| 6 | `.before_build_deb` | echo 占位 | — |
| 7 | `.old_make_deb` | sed 改 `Makefile.deb` 输出路径 → `make -f Makefile.deb`（内部 `dpkg-deb --root-owner-group -b`） | `/tmp/tcmalloc.deb` |
| 8 | `.after_build_deb` | echo 占位 | — |
| 9 | `.old_upload_deb snapshot` | 解析 control 的 Package/Version/Arch → curl 上传到 Nexus snapshot 仓库 → 轮询 `apt.deeproute.cn` 确认 200 | 包上线 snapshot 源 |
| 10 | 本地追加步骤 | `package_download.py` 生成下载 URL | `package.env`（`DEB_DOWNLOAD_URL=...`） |

`.build-release`（模板 `project/build.gitlab-ci.yml`）差异：

- 触发 `only: [tags]`
- 第 5 步用 release 分支：带 `tag_name=${CI_COMMIT_TAG}` + `redeploy=false`（服务器强制版本唯一）
- 第 9 步上传 `deeproute-release-2004`
- **多第 10 步**：`!reference [.add-dr-package, script-old]`（执行注册）

### 2.4 `.add-dr-package` —— release 的"注册 hook"

本仓库 `.gitlab-ci.yml` 里那个看起来像死代码的隐藏 job 其实是被模板显式引用的钩子：

```yaml
.add-dr-package:                 # 以 . 开头 = hidden job，不会作为 pipeline job 执行
  script-old:                    # 键名是模板约定（注意不是 script！）
    - python3 .../register_package.py --control /pipeline/DEBIAN/control --output-dir .../registration
```

`project/build.gitlab-ci.yml:55` 里 release 的 script 有  
`!reference [.add-dr-package, script-old]`；snapshot 的 script 没有这一行。因此：

- **snapshot：只上传，不注册**；
- **release：上传后再注册**到 `hub.deeproute.ai/v2/apt/dr_package`（生产）与  
`stg-hub.deeproute.ai/v2/apt/dr_package`（预发布），要求 `SUCCESS` + 返回记录 ID。

### 2.5 `verify-qnx-download-url` job（发布后复验）

`before_script: []`；`needs` 两个 build job（`optional: true`，缺失不阻塞）。执行：

1. `test -n "${DEB_DOWNLOAD_URL:?...}"` —— 断言 dotenv 变量从上游继承到（防御断链）
2. `curl` 下载发布出的真实 deb
3. `dpkg-deb -f` 看头、`sha256sum` 记录
4. `dpkg-deb -x` 解出安装树
5. `verify_qnx_package.py <root> --expected-sha ${CI_COMMIT_SHA} --require-clean`  
—— **防"发出去的是脏源码/旧产物"**。

### 2.6 触发矩阵（规则来自模板源码，非本文件）

模板 `project/build.gitlab-ci.yml`：`.build: except: [tags]`、`.build-release: only: [tags]`。

| 触发事件 | test-UT | build-snapshot | build-release | verify |
|-|-|-|-|-|
| push 任意分支 / MR | ✅ | ✅ | ❌ | ✅ |
| push tag（如 `v2.17.2-qnx.2`） | ✅ 重跑 Linux UT | ❌ | ✅ | ✅ |
| 手动 / API 触发 | ✅ | 视 tag | 视 tag | ✅（相关 build job 缺席则跳过） |

即：**普通开发分支推送自动发布 snapshot；合规且已批准的 Git tag 自动发布正式 release。**
CI 的自动触发不等于发版授权：不得直接向集成主线开发或推送，正式 tag 只能指向已验收、
已批准、且属于集成主线历史的提交。

### 2.7 值得注意的写法细节

1. 构建放 `before_script` 而非 `script`，配合 job 级 `before_script: []` 实现"一键不构建"。
2. `cd` 不跨行持久，故每段脚本用 `cd ${CI_PROJECT_DIR}` / `cd -` 包住。
3. dotenv 继承链：build job `reports: dotenv:` → verify `needs artifacts:true`，传递 `DEB_DOWNLOAD_URL`。
4. 两套包命名：release `deeproute-tcmalloc-qnx-dev_2.17.3_amd64.deb`；  
snapshot `deeproute-tcmalloc-qnx-snapshot_2.17.3-<pipeline_id>_amd64.deb`（带 pipeline 号防覆盖）。
5. 版本号三段数字卡点在 config.xml 传给版本服务那一步。
6. artifacts `paths: build/qnx-tests/` 保留交叉链接的 sampler / 冒烟程序 30 天，供台架复用。

### 2.8 CI 演进历史（git log -- .gitlab-ci.yml）

```
4c67a56  ci: add automatic QNX tcmalloc release       # 初始：仅 2 个 build job + 全局 before_script
138bd67  test(sampler): restore isolated sampler coverage   # 补 test job（Linux UT 门禁）
8a0e892  fix(ci): unify dual-QNX builds & validate release revision  # 统一 compile.bash 平台参数
5291803  ci: publish deb download URL and inherit it via dotenv      # 补 verify 下载复验 job
```

演进路径：**先能自动发版 → 再补测试门禁 → 再补发布后下载复验**。

---

## 3. 各发版流程中做了哪些测试

### 3.1 snapshot 流程（分支 push）的三层测试

**第 1 层 · CI test job（纯 Linux 环境，无 QNX）**

- `python3 -m unittest discover -s pipeline/tests -v`

  - `test_release.py`：15 个纯逻辑用例全部跑；其中新增 full 库摘要转发覆盖；
  - `test_package_artifacts.py`：10 个用例因 `@skipUnless(QNX_TEST_PACKAGE_ROOT)`
  此时**整体 skip**（还没有 QNX 产物）。
- `bash -x ./run_linux_unit_tests.bash`：对干净 git 快照做 autogen → configure → make，  
Linux 原生跑

  - `sampler_test`：**11/11**（采样间隔算法，固定 `-DNO_TCMALLOC_SAMPLES` 隔离编译）
  - `tcmalloc_unittest`：**126/126**（21 项 × 6 种运行配置）

**第 2 层 · build job 内部校验（随交叉编译强制执行）**

- 每个平台先执行一次完整 configure（不传 `--enable-minimal`），再按 target 构建 minimal
  和 full；minimal 构建同时交叉链接 `sampler_test`。
- 每份库编译后立即做（见 `compile.bash`）：AArch64 + `Type: DYN`、各自 SONAME、对应
  libc++、allocator C/C++ 导出、Build ID、SHA256 写入 manifest；full 还校验四个 heap-profiler
  动态导出。manifest 保留 minimal 的 `sha256` 等旧字段，full 使用 `full_sha256`、
  `full_soname`、`full_needed`、`full_build_id`、`full_profile_exports` 等字段；
- **sampler_test 交叉链接门禁**（两平台都要能交叉链成 AArch64，测试程序不进发布包）；
- `--platform all` 构建成功后：`verify_qnx_package.py` 全包校验 +  
`QNX_TEST_PACKAGE_ROOT` 已置位 → `test_package_artifacts.py` 的 **10 项真实 ELF
集成测试**真正执行（含 full 库篡改和跨平台 ABI 串用）；
- 模板制包环节：`/apt/control` 生成 = 校验三段数字；上传后**轮询下载链接 200** 确认可见。

**第 3 层 · verify job（stage: verify）**  
从公开源真实下载 deb → `verify_qnx_package.py --expected-sha CI_COMMIT_SHA--require-clean` 全量复验。

### 3.2 release 流程（tag push）差异

测试内容与 snapshot **完全相同**（test 重跑、build 重建校验、verify 重验）。发版动作差异：

- control 生成带 `tag_name` + `redeploy=false` → 版本服务拒绝重复版本；
- 上传 `deeproute-release-2004`；
- 追加 `register_package.py` 注册（必须 SUCCESS + 返回记录 ID）。

### 3.3 CI 测不到的边界（需人工/台架）

CI **不测** QNX 实机运行。双台架冒烟  
（8650=`ostest-8650-39` / QNX7.1；8797=`lp-8797B-1` / QNX8.0）由人把**下载的真实包**  
传上台架，用 `run_qnx_release_smoke.sh`（内部经 `run_with_allocator.sh` 以 LD_PRELOAD  
加载库，先按实际库名校验 manifest 的 `sha256` 或 `full_sha256` 与 ELF 归属）跑 **8/8 程序**：
sampler + O0/O2/O3 各一组 C API(`allocator_c_api_O*`)与 C++ 合约(`allocator_contract_O*`)

- 双 DSO 交叉分配(`dso_contract_test`)；对应 **sampler 11/11、JSON/符号归属 21/21**。  
每个平台分本地预验证 / 实际 snapshot 包 / 实际正式包三阶段。

当前 feature matrix 还按实际传入的库区分能力：仅当库文件名是
`libtcmalloc_minimal.so.10` 时跳过 heap profile/automatic dump 路径；full 库会继续执行该路径。
这只覆盖脚本分支，不能替代 QNX 目标机上的 `HEAPPROFILE` 运行短测。

---

## 4. `pipeline/` 文件角色 + 两个测试文件逐项分析

### 4.1 文件角色（一半是"发布引擎"，一半是"引擎的测试"）

| 文件 | 角色 | 被谁调用 |
|-|-|-|
| `config.xml` | 发版配置：module_name/version/architecture/maintainer/description（声明态） | 模板 POST 给版本服务 |
| `DEBIAN/control`(模板) | 真实 control 由版本服务生成后写回；模板里是占位符 | — |
| \`DEBIAN/preinst | postinst | prerm |
| `Makefile.deb` | 先调用全包校验，再 `dpkg-deb --root-owner-group -b /pipeline /tmp/tcmalloc.deb`；基于 Makefile 自身路径定位脚本和 `DEBIAN/` | 模板 `.old_make_deb` |
| `register_package.py` | 注册正式包到生产/预发布接口，校验 HTTP + JSON + 记录 ID | release job `.add-dr-package` |
| `package_download.py` | 按 control 拼 URL → stdout 日志 + `download-url.txt` + `package.env` | 两个 build job 追加步骤 |
| `verify_qnx_package.py` | 双平台四库全包校验器（见 4.4） | compile.bash 尾部 + 制包前 + verify job + 本地 |
| `apt_update.bash` | apt 索引同步抖动时的**有界重试**（≤4 次） | compile.bash 装工具链 |
| `tests/test_release.py` | 发布脚本的单元测试（15 用例） | CI test job / 本地 |
| `tests/test_package_artifacts.py` | 校验器对真实交叉产物的破坏性测试（10 用例） | CI build job / 本地 |

> 备注：`DEBIAN` 维护脚本为空壳，进一步佐证 deb 在 Linux 上是纯载体（真正被消费的是库文件）。

### 4.2 `test_release.py`（15 用例，纯逻辑，不需要 QNX）

保护点 = "能发版的工具自己别坏"：

1. `test_download_url_uses_actual_control_fields` — URL 拼接格式（release/snapshot 两版本）；  
非法源名（`''`/`../release`/URL）→ ValueError。
2. `test_download_artifacts_match_log_and_dotenv` — stdout 日志 / `download-url.txt` /  
`package.env` 三处 URL 完全一致；版本含 `:` 时 URL 正确 percent-encode。
3. `test_invalid_control_emits_no_download_artifacts` — control 缺字段 / 重复 Version /  
空 Version → 抛错且不产出任何文件。
4. `test_apt_mirror_refresh_and_retry_bound` — 用假 apt-get 模拟：瞬时报错（索引抖动）  
第 3 次成功 → exit 0；一直失败 → 4 次后带错误退出；**无关错误（权限拒绝）→ 第 1 次就退**  
（不盲目重试）。
5. `test_package_version_matches_control_service_format` — 解析 `config.xml`，  
`<version>` 必须匹配 `^[0-9]+\.[0-9]+\.[0-9]+$`（防 2.17.2-1 被拒复现）。
6. `test_invalid_platform_and_missing_argument` — `compile.bash` 非法平台 / 缺参 → exit 2。
7. `test_missing_toolchain_is_not_installed_locally` — 本地(非 CI)缺 QNX 工具链 →  
不自动装依赖、打印 `sudo apt-get install ...` 提示、exit 2（`CI=false` 分支）。
8. `test_single_platform_and_incomplete_receipts_rejected` — receipt 为单平台(8650/8797)  
或 status=building 时，`verify.verify` 拒绝（正式制包必须 `--platform all` 同批次）。
9. `test_stale_source_rejected` — receipt 的 git_sha 与期望 SHA 不一致 → "Stale source"。
10. `test_duplicate_manifest_field_rejected` — manifest 重复字段 → 解析即抛错。
11. `test_registration_response` — 合法注册响应通过；HTML 页 / 数组 / `{"code":500}` /  
FAILED / 空 body → 全拒绝。
12. `test_registration_json_escaping` — Description 含引号/反斜杠时 JSON 往返无损。
13. `test_registration_response_file` — mock urlopen：注册写 `registration-0.json`  
**而非 `./res`**（防污染 root 拥有的 /pipeline）。
14. `test_launcher_manifest_compatibility_and_digest_forwarding` — `run_with_allocator.sh`：  
`tcmalloc`/`tcmalloc-minimal` 均兼容、`jemalloc` 拒绝(exit 3)、SHA 不匹配 exit 1（假 preflight）。
15. `test_launcher_uses_full_tcmalloc_digest` — 传入 `libtcmalloc.so.10` 时，launcher 必须
把 manifest 的 `full_sha256` 而非 minimal 的 `sha256` 交给 ELF preflight。

### 4.3 `test_package_artifacts.py`（10 用例，**需要真实 QNX ELF**）

整组 `@skipUnless(QNX_TEST_PACKAGE_ROOT)`。compile.bash 在 `--platform all` 成功后显式  
`QNX_TEST_PACKAGE_ROOT="$PACKAGE_ROOT" python3 -m unittest ...` 才会真正执行。  
copy 真实构建树逐项搞破坏，验证 `verify_qnx_package.py` 抓得到：

1. `test_real_dual_platform_package` — 完整双平台四库包 → 通过。
2. `test_tampered_library` — minimal 库尾追加字节 → `SHA256 mismatch`。
3. `test_tampered_profile_library` — full 库尾追加字节 → `full_library SHA256 mismatch`。
4. `test_mixed_build_batches` — manifest 的 `build_run_id` 改成别批 → `build_run_id`（防混批次）。
5. `test_wrong_libcxx_abi` — 把 sdp7.1 minimal 库塞进 sdp8.0 路径 → `libc++ ABI`（防串平台）。
6. `test_wrong_profile_libcxx_abi` — 把 sdp7.1 full 库塞进 sdp8.0 路径，即使同步伪造
   `full_sha256`，仍因 `libc++ ABI` 被拒绝。
7. `test_wrong_elf_architecture` — 用 `/bin/true` 顶替 minimal 库 → `AArch64`。
8. `test_mismatched_build_id` — 篡改 minimal Build ID → `Build ID`。
9. `test_dirty_release_rejected` — manifest 标 `source_dirty=true` + `--require-clean` → `Dirty source`。
10. `test_unexpected_artifact` — 目录多塞文件 → `Unexpected`（文件清单严格等于预期）。

### 4.4 `verify_qnx_package.py` 校验维度（被上面两组测试共同保护）

receipt 完整性（status=complete / platform=all / git_sha 40hex / build_run_id 存在）  
→ 双平台(枚举 sdp7.1+sdp8.0)各自：minimal/full 两库与 manifest 都存在，且 manifest 关键字段
与期望一致 → 每份库 SHA256 == 对应 manifest 字段 → readelf 交叉检查 Machine=AArch64 +
Type=DYN + 各自 SONAME + NEEDED libc++ 对应 + Build ID 一致 + allocator 导出白名单；full
还必须有 heap-profiler 导出且与 `full_profile_exports` 一致 → 整棵树无 symlink、文件清单
严格等于 receipt、两个 manifest 和四份库。

---

## 5. 测试运行环境（分四层）

| 层级 | 环境 | 内容 |
|-|-|-|
| CI test job | `deeproute-drydocker-2004:2662911-rc1`（**Ubuntu 20.04 x86_64**），runner `mapping`；无 QNX 工具链 | pipeline 脚本单测 + Linux 原生 tcmalloc UT |
| CI build job | 同一镜像 + 进程内 `apt_update.bash` 安装 relocatable QNX 工具链包（`deeproute-toolchains-qnx-sdp7-relocatlable-dev=7.1.3` / `...sdp8...=8.1.1`） | `qcc -Vgcc_ntoaarch64le` 交叉编译到 `/pipeline` + 双平台四库内嵌 ELF 校验 + artifact 10 项 |
| CI verify job | 纯 host 工具链：curl / dpkg-deb / sha256sum / readelf / python3 | 下载真实 deb 复验 |
| 台架（CI 外，人工） | 8650 = QNX 7.1；8797 = QNX 8.0 | `run_qnx_release_smoke.sh` 8/8 + sampler 11/11 |

关键点：

- 交叉校验 = 用 x86 的 readelf 读 AArch64 ELF，**不是代码在 AArch64 上运行**。
- `readelf` 路径可用 `READELF` 环境变量覆盖（交叉 readelf）。
- 本地复现容器与 CI 同一镜像，README 提供 `docker run --entrypoint /bin/bash ...` 命令，  
无需挂个人目录，需 QNX 许可证挂载。
- CI 构建 `compile.bash` 使用 git 跟踪文件的干净副本（`git ls-files | tar`），新增源码须先 `git add`；  
缺依赖时本地只提示、CI 才自动 apt 安装。

---

## 6. 开发者发版 SOP

```
1. 从最新集成主线创建开发分支（默认 `codex/` 前缀），不直接在主线开发。
2. 改代码，本地验证
   JOBS=8 bash compile.bash --platform all        # 双平台建档
   python3 pipeline/verify_qnx_package.py build/qnx-package
   JOBS=8 bash run_linux_unit_tests.bash
3. 只暂存本次文件并提交开发分支，推送集成远程（操作前用 `git remote -v` 核对实际映射，
   不按 remote 名称推断目标）→ 自动触发 snapshot。
4. 创建 MR，至少一名非作者评审；required CI 必须对应最新 source SHA 且成功。snapshot
   通过、下载复验绿灯只是可合入证据，不是正式发布批准。
5. 获得合并授权后合入主线，记录最终提交 `C`；merge/squash/rebase 可能改变 SHA，必须从
   干净源码和锁定构建输入重新验证 `C`，保存制品、payload SHA256、工具链/flags、适用平台
   结果与回滚资产。
6. 确认发正式版：
   a. 改 pipeline/config.xml 的 <version>（递增，三段数字）
   b. 将版本改动经开发分支和 MR 合入；验证最终提交 `C` 的新版本 snapshot 包
   c. 获得绑定 `C` 与制品摘要的发布批准，确认 tag 不存在后打 tag：
        git tag -a v2.17.2-qnx.N -m 'QNX package build revision N'
        git push <remote> v2.17.2-qnx.N            → 自动触发 release
7. 等 release 完成，核对：
   - register_package → SUCCESS + 记录 ID（生产 + 预发布）
   - apt.deeproute.cn/deeproute-release-2004 出现该版本，SHA 一致
   - 下载 deb 跑台架冒烟（人工发版验收）
```

构建后还应针对四份库分别检查 `readelf -h -d -n`。如果发版目的包含 profile，台架验收
必须选择同平台的 `libtcmalloc.so.10`，设置 `HEAPPROFILE` 后确认实际生成 profile；仅验证
minimal 的 `LD_PRELOAD` 不足以证明完整库可用。

**约束红线**

- 版本号只能三段数字：`2.17.3` ✓；`2.17.2-1` / `2.17.2.1` ✗。
- **禁止覆盖已发布版本**（`redeploy=false` + 版本服务拒绝重复）→ 每次正式版必须递增版本。
- **禁止移动 / 复用 tag**；失败的 tag 只能保留。
- tag 命名 `v2.17.2-qnx.N`：`2.17.2` = upstream 源码版本，`N` = 包构建修订；  
config.xml 的 `2.17.3` = 下游包版本。三者独立，真实源码版本由 manifest `source_version` 记录。

**易踩的坑**：必须先让"版本号提升 + 代码改动"经 MR 合入，并在最终主线提交 `C` 上重新
验收，**再给 `C` 打 tag**；否则 release 可能因 `--expected-sha` / `--require-clean` 校验失败，
或产出旧代码新版本号。不得移动旧 tag、复用已发布版本或为获得绿灯而绕过门禁。

### 什么时候要改 `pipeline/config.xml`

**唯一需要改它的场景：正式发新版本前，递增 `<version>`。**

- snapshot 版本由 CI 自动拼 `-<pipeline_id>`，不需改 config.xml；
- release 版本要求"全局唯一 + 三段数字"，由 `config.xml → /apt/control → 版本服务` 强制；
- 其余字段（`module_name`、`edition=dev`、`architecture=amd64`、`optional_task=qnx`、  
`maintainers`）定义了包在包管理里的身份，一般不动。

---

## 7. 相关文件路径速查

| 目的 | 路径 |
|-|-|
| CI 主配置 | `google-gperftools/.gitlab-ci.yml` |
| 构建入口（交叉编译 + 内嵌校验） | `google-gperftools/compile.bash` |
| Linux 源码单测入口 | `google-gperftools/run_linux_unit_tests.bash` |
| 发布脚本自测 / 制品集成测试 | `google-gperftools/pipeline/tests/{test_release,test_package_artifacts}.py` |
| 全包校验器 | `google-gperftools/pipeline/verify_qnx_package.py` |
| 包注册 / 下载 URL / apt 重试 | `google-gperftools/pipeline/{register_package.py, package_download.py, apt_update.bash}` |
| 发版声明（版本号改这里） | `google-gperftools/pipeline/config.xml` |
| 台架冒烟 / LD_PRELOAD 启动器 | `google-gperftools/qnx_allocator_validation/{run_qnx_release_smoke.sh,run_with_allocator.sh}` |
| 发版验收记录 | `google-gperftools/qnx_allocator_validation/QNX_RELEASE_REVISION_20260907.md` |
| sampler 单测修复记录 | `google-gperftools/qnx_allocator_validation/SAMPLER_UNIT_TEST_VALIDATION_20260905.md` |
| 公共模板（触发规则/构建链） | `/sandbox/cicd-common/project/{build,global,reference}.gitlab-ci.yml` |

---

## 8. 附录：v2.17.2-qnx.2 正式验收数据（历史 minimal-only 制品）

本节保留的是 2026-09 历史正式包的证据。当时 deb 每平台只有
`libtcmalloc_minimal.so.10`；因此下列 Build ID、库 SHA256 和 deb SHA256 **不能**作为当前
dual-library 包的验收依据，也不包含 full 库的指纹。当前代码的包校验器会拒绝该旧布局。

- 正式包：`deeproute-tcmalloc-qnx-dev_2.17.3_amd64.deb`  
链接：`https://apt.deeproute.cn/deeproute-release-2004/pool/d/deeproute-tcmalloc-qnx-dev/deeproute-tcmalloc-qnx-dev_2.17.3_amd64.deb`
- 

| 平台 | minimal Build ID | minimal 库 SHA256 |
|-|-|-|
| 8650/SDP7.1 | `499b847800389681a534ea4901ac7d89` | `0995fb6326a26a2cc5fa0dc3a95875b5394fe49fcb8f0e37530dc97bc831872c` |
| 8797/SDP8.0 | `d3d4a771e71e0ef6f693a6746b3bba83` | `4eb99f26d9e48ff6b9a1a8a8d35368a3698cc2e79d0b761317a2e74d61aeb8fc` |

- release deb SHA256：`a3792f4ebb5b8a8787df6d8f160f0189a994feda81a1f2fc7ccac00d9080fb02`
- snapshot 包：`deeproute-tcmalloc-qnx-snapshot_2.17.3-49958009_amd64.deb`
- 注册记录 ID：生产 `5062648`、预发布 `11103239`
- snapshot pipeline `49958009`（QNX job `272036689`）；release pipeline `49958649`（QNX job `272039280`）
- 验收按"snapshot / 正式 release 均下载真实包、双台架 8/8"通过；  
DEBIAN `Architecture: amd64` = 宿主架构（交叉编译产物），旧包内两份库为 QNX AArch64
minimal 库。full 库必须由包含本次改动的新提交重新构建、下载、解包和验收。

---

## 9. 待办 / 验收边界（未闭环项）

本节是历史风险和待办记录，未随双库构建改动重新审计；不能替代本次提交的 CI、制品或
QNX 实机验收结论。

- QNX8 `thread_dealloc_unittest`：thread cache 数量 1→3 待查；
- QNX7 debug `ManyThreads` SIGSEGV、debug 回溯符号化不足待查；
- 大堆碎片 UT 超时待查；
- 历史实车 crash 尚未归因；
- 72 小时业务回灌未完成；
- 远端开发分支 `codex/qnx-allocator-release-ci` 未合并默认分支；
- DEB_DOWNLOAD_URL 下发相关改动（5291803）已过本地与 CI 配置校验，**未提交/推送**，  
尚未在新 release 中生效。
