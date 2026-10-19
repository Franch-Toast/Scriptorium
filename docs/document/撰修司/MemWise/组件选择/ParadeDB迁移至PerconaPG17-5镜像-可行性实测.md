---
title: "数据库组件选型：官方 ParadeDB 镜像（pg17）→ 公司 Percona PG 17.5 + 插件镜像 —— 可行性实测"
date: 2026-10-19
description: "> 场景：当前 WeKnora 各环境在 drcloud 上各自 helm 部署一个 paradedb/paradedb:v0.22.2-pg17 单实例（自运维备份/高可用/磁盘）。公司运维可提供统一运维的 PerconaPGCluster（仅支持 PG 15.13 / 17.5），且不能直接使用 ParadeDB ..."
categories:
  - "撰修司"
tags: []
---

# 数据库组件选型：官方 ParadeDB 镜像（pg17）→ 公司 Percona PG 17.5 + 插件镜像 —— 可行性实测

> 场景：当前 WeKnora 各环境在 drcloud 上各自 helm 部署一个 `paradedb/paradedb:v0.22.2-pg17` 单实例（自运维备份/高可用/磁盘）。公司运维可提供统一运维的 **PerconaPGCluster（仅支持 PG 15.13 / 17.5）**，且**不能直接使用 ParadeDB 发行镜像**，运维想用「公司支持的 PG 基础镜像 + 按需安装对应版本插件（pg_search / pgvector）」打一个自定义镜像给 WeKnora。
>
> 本文档记录一次**本地实证**：拉取 `percona/percona-distribution-postgresql:17.5` → 装入 ParadeDB 预编译 pg_search 0.22.2 → 重打包 → 拉起 → 跑真实迁移与检索 SQL → 补一份 `WEKNORA_TEST_PG_DSN` 门控的 Go 集成测试入仓，验证功能是否正常、有无 bug。
>
> **前置说明**：本文档与同目录《[ParadeDB迁移至PerconaPG15评估.md](./ParadeDB迁移至PerconaPG15评估.md)》的关系是**姊妹篇 + 两处结论修正**：① 目标基线定为 PG **17.5**（非 15）；② 该文档基于 PG15 推断的「search_path 必须复刻，否则 `|||` 报 operator does not exist」在本实测中**被推翻**——pg_search 0.22.2 的 `|||` 实为 **pg_catalog 中的多态运算符**，详见 §6。

---

## 0. 结论先行（TL;DR）

- **技术上完全可行，应用侧零代码改动、无需运维预建扩展。** 我们用 Percona PG 17.5 官方基础镜像 + 一颗 ParadeDB 预编译 el9 rpm 打出的自定义镜像，**跑通了 WeKnora 全部 85 个 versioned 迁移**（含 bm25 中文检索索引 + HNSW 向量索引），中文 BM25 检索、halfvec HNSW TopK、`SET LOCAL hnsw.*` GUC 全部正常。
- **不需要源码编译 pg_search**。ParadeDB 官方 `pg_search_17-0.22.2` 预编译 rpm（el9）在 Percona PG 17.5（server_version_num `170005`）上直接加载成功（Gate 1 通过）。
- **pgvector 已随 Percona 镜像内置**（`percona-pgvector_17-0.8.0`），pg_trgm / uuid-ossp 为服务器 contrib 自带 → 运维只需补装 **pg_search 一个包**。
- **关键结论修正**：PG17 + pg_search 0.22.2 **既不需要 `shared_preload_libraries='pg_search'`，也不需要复刻官方 bootstrap 的 `search_path`**（详见 §6）。官方镜像保留这两点属于历史包袱/防御性，新镜像可不做或仅做防御性保留。
- 新补的 gated 集成测试 `internal/application/repository/retriever/postgres/integration_test.go` 可作为「公司实例插件就绪冒烟」的标准化入口（详见 §5.6 / §8）。

---

## 1. 两个镜像的差异（Part A 产出）

| 维度 | 官方 `paradedb/paradedb:v0.22.2-pg17` | 公司目标 `percona/…:17.5` + 插件 |
|---|---|---|
| 基础 OS | Debian trixie（apt） | **Oracle Linux 9.6**（el9，microdnf/rpm） |
| PostgreSQL | PGDG PG **17.9**（`17.9-1.pgdg13+1`，Debian 布局 `/usr/lib/postgresql/17/`） | Percona PG **17.5.3**（`170005`，布局 `/usr/pgsql-17/{lib,share}`） |
| 默认用户/入口 | 官方 postgres 镜像（UID 999，`docker-entrypoint.sh`） | postgres UID 26，`/entrypoint.sh`，PGDATA=`/data/db`，支持 `POSTGRES_*` + `/docker-entrypoint-initdb.d/` |
| 内置扩展 | pg_search(源码编译, 1.05GB debug .so)、pgvector、pg_trgm、uuid-ossp、**postgis3、pg_cron、pg_ivm、barman** | `percona-pgvector_17-0.8.0`、pg_trgm、uuid-ossp、pg_stat_monitor、percona_pg_telemetry（无 pg_search） |
| 默认 preload | `pg_search,pg_cron,pg_stat_statements` | `pg_stat_monitor,percona_pg_telemetry` |

**WeKnora 真正依赖的只有**（代码盘点，见 §3）：`pg_search`（硬依赖，无 fallback）、pgvector（`halfvec`+HNSW，GUC 缺省有降级）、`pg_trgm`、`uuid-ossp`。**官方镜像里 postgis / pg_cron / pg_ivm / barman 等 WeKnora 一概未用，不必复刻。**

**需补装/确认清单**（给运维）：

| 插件 | 版本 | 来源 | WeKnora 用在哪 |
|---|---|---|---|
| `pg_search` | **0.22.2**（与官方 v0.22.2-pg17 同版，或最新 0.22.x） | ParadeDB GitHub Release 预编译 el9 rpm | bm25 索引 / `|||` / `paradedb.score(id)` / `chinese_lindera` |
| `vector` | 0.8.0（已内置） | `percona-pgvector_17` | `halfvec` 列 + HNSW 表达式索引 + `hnsw.*` GUC |
| `pg_trgm` / `uuid-ossp` | 随服务器 contrib | 无需单独装 | wiki 标题 trigram 去重 / id 生成 |

> 兼容性注记：pg_search 预编译要求 CPU ≥ x86-64-v3（Haswell+）；Percona 17.5 为 **x86-64-v2** 构建，v3 指令集要求来自 pg_search 自身二进制，装机时请用 `lscpu` 核对 flags。

---

## 2. 版本选择背景（用户拍板）

- 目标基线 = **PG 17.5**（`percona/percona-distribution-postgresql:17.5`，实测 PG 17.5.3）。选择理由：① 与官方 paradeDB 同处 PG17，跨小版本加载风险最低；② 17.5 是公司运维 PerconaPGCluster 支持的两个版本中较新者。
- 本次只做**镜像可行性验证**（不起 PGO 集群、不改 helm），PGO/helm 落点差异在 §9 记录。
- 补一份 **gated 集成测试**入仓（`WEKNORA_TEST_PG_DSN`，未设则 skip）。

---

## 3. WeKnora 对数据库的真实依赖（代码级）

业务库与检索引擎共用同一 gorm 连接（`internal/container/container.go`、`engine_factory.go`）。

| 依赖扩展 | 被用在 | 关键 SQL/代码点 |
|---|---|---|
| `pg_search` | 关键词检索（**硬依赖，代码无 fallback**） | `USING bm25(...)` 索引、`content ||| ?`、`paradedb.score(id)`——`internal/application/repository/retriever/postgres/repository.go:197,215`；`000002_embeddings.up.sql:42-51` 建 bm25（`chinese_lindera`）；`000008/000011` 执行 `ALTER EXTENSION pg_search UPDATE` |
| `pgvector` | 向量检索 | `embeddings.embedding halfvec`；HNSW **表达式**索引 `(embedding::halfvec(3584|798)) halfvec_cosine_ops`（`000002`）；事务内 `SET LOCAL hnsw.ef_search`/`hnsw.iterative_scan=strict_order`（`repository.go:412-443`，GUC 缺失时降级重试） |
| `pg_trgm` | wiki 标题去重预筛 | `000041` 建 `lower(title)` trigram GIN |
| `uuid-ossp` | 兼容 | `000000` `CREATE EXTENSION "uuid-ossp"` |

> 代码里 `paradedb.score(id)` 始终是**限定了 schema 的**调用；不加限定直接引用的 pg_search 对象只有 `|||` 运算符。

---

## 4. 本地实证过程（Part B）

### 4.1 材料与来源

| 材料 | 版本 | 来源 |
|---|---|---|
| 基础镜像 | `percona/percona-distribution-postgresql:17.5`（Oracle Linux 9.6，PG 17.5.3） | Docker Hub |
| pg_search | `pg_search_17-0.22.2` el9 rpm | ParadeDB GitHub Release `v0.22.2`（资产名形如 `pg_search_17-0.22.2-1PARADEDB.el9.x86_64.rpm`；本地安装后 NEVRA 为 `pg_search_17-0.22.2-1.el9.x86_64`） |
| 官方镜像对照 | `paradedb/paradedb:v0.22.2-pg17`（本机已有） | Docker Hub |

### 4.2 Gate 1：pg_search 预编译二进制在 PG17.5 可加载（★最大风险点，通过）

ParadeDB 的 pg_search 是 pgrx 编译的扩展，二进制内带 PG module-magic（期望某 PG17 小版本）。Percona 服务端为 17.5，属「同大版本、不同小版本」跨版本加载。

验证方式：`docker build` 一个 probe 镜像（`FROM percona…:17.5` + `rpm -ivh pg_search_17.rpm`）→ 起库后 `CREATE EXTENSION pg_search;` → **成功，无 module-magic 报错**。ext 版本 0.22.2、schema=`paradedb`。

> 结论：**无需源码编译**。若将来 Percona 升到 PG18（pg_search 需同时跟进 18 版产物）或 CPU 低于 x86-64-v3，才需要走 pgrx 对 Percona `pg_config` 源码编译（重，文档此处不展开）。

### 4.3 镜像重打包

Dockerfile 要点（完整版见 §8.1）：

```dockerfile
FROM percona/percona-distribution-postgresql:17.5
USER root
COPY pg_search_17.rpm /tmp/pg_search_17.rpm
RUN rpm -ivh /tmp/pg_search_17.rpm && rm -f /tmp/pg_search_17.rpm
# （可选，防御性）复刻官方默认 preload + 初始库 search_path —— 见 §6，非必需
USER 26
```

- 装 rpm 需切 `root`：Percona 镜像默认 `USER 26`（postgres），无权限写 `/usr/pgsql-17`。
- pgvector 0.8.0 / pg_trgm / uuid-ossp 均已在镜像内，无需安装。

### 4.4 拉起 + 真实迁移

- `docker run`（`POSTGRES_PASSWORD/DB`，端口映射 127.0.0.1:55432）。
- `CREATE EXTENSION` 全过：`vector`(0.8.0)、`pg_search`(0.22.2)、`pg_trgm`(1.6)、`uuid-ossp`(1.1)。
- **跑了完整 `migrations/versioned` 全链（85 个迁移文件）**，经 golang-migrate（与生产 AUTO_MIGRATE 同路径）在空库一次跑通：
  - `000002` 建 `embeddings` 表 + `embeddings_search_idx`（`USING bm25 ... chinese_lindera`）+ HNSW 表达式索引 `3584/798`，`REINDEX` 正常；
  - `000007` 为 `embeddings` 加 `tag_id`（检索引擎 SELECT 依赖它）；
  - `000008/000011` 的 `ALTER EXTENSION pg_search UPDATE` 在扩展已为最新时是 **no-op 成功**；
  - 全部迁移里无第二个非标准扩展需求。

### 4.5 SQL 检索冒烟（全部断言通过）

| 用例 | 结果 |
|---|---|
| 中文 BM25：插中文行 → `content ||| ?` + `paradedb.score(id)` | 命中正确文档、按 score 降序，`chinese_lindera` 中文分词正常 |
| HNSW 表达式索引命中 | `EXPLAIN` 强制 `enable_seqscan=off` 后走 `Index Scan using embeddings_embedding_idx_3584`；3584 维 TopK 返回正确行 |
| GUC | 事务内 `SET LOCAL hnsw.ef_search=100`、`hnsw.iterative_scan=strict_order` 均被接受（`SHOW` 回显正确） |
| search_path 反例 | `weknora_gotest` 库（未应用任何 `ALTER DATABASE SET search_path`，默认 `"$user", public`）上 `content ||| ?` **正常解析**——详见 §6 |

### 4.6 Go 集成测试（Part C，已入仓）

新增 `internal/application/repository/retriever/postgres/integration_test.go`（`package postgres`，white-box），参照既有 `sqlite/repository_test.go` 模式：

- **门控**：`WEKNORA_TEST_PG_DSN` 未设置 → 全部 `t.Skip`（CI 无库不挂，`go vet ./...` 与无 DSN `go test` 已验证通过）。
- **迁移**：用 golang-migrate 跑完整 versioned 全链（用 `runtime.Caller` 定位仓库根，避免 `go test` CWD=包目录导致 `file://migrations/versioned` 找不到），每进程只跑一次；测试间 `TRUNCATE embeddings` 保证可重复执行。
- **用例**（在 Percona PG 17.5 镜像全绿）：
  1. `TestKeywordsRetrieveChineseBM25` —— 中文 BM25 命中 + `paradedb.score` 排序（对应 `repository.go` 查询形态）；
  2. `TestKeywordsRetrieveWorksWithDefaultSearchPath` —— 锁定「`|||` 注册在 pg_catalog、无需 search_path 复刻」这一修正；
  3. `TestVectorRetrieveHalfvecTopK` —— halfvec HNSW TopK + 相似度阈值过滤 + 内部事务 `SET LOCAL hnsw.*`；
  4. `TestVectorRetrieveFiltersByKnowledgeBase` —— knowledge_base 过滤后置生效；
  5. `TestKeywordsRetrieveRespectsIsEnabledDisable` —— 走生产禁用路径 `BatchUpdateChunkEnabledStatus` 后 chunk 不再召回。

> 实现中暴露的一个**测试侧认知修正**（非本次 bug）：`Save(IsEnabled=false)` 并不能把 chunk 存成禁用——`pgVector.IsEnabled` 是裸 `bool` + gorm `default:true` tag，GORM Create 会忽略零值 false 让 DB 默认 true 兜底（这是包括官方 ParadeDB 在内的既有行为，生产禁用实际走 `BatchUpdateChunkEnabledStatus` 的 UPDATE 路径）。集成测试按生产路径断言。

---

## 5. 关键发现与决策记录

1. **决策：复用 Percona PG 17.5 + 装扩展，应用零改动。** 与 PG15 评估一致，WeKnora 不依赖「ParadeDB 发行版镜像」，只依赖 3 个可独立装载的扩展。
2. **决策：pg_search 用官方预编译 rpm，不做源码编译。** Gate 1 实测通过，省去 rust + cargo-pgrx 的构建链。
3. **决策：pgvector 直接用 Percona 内置 0.8.0**（`hnsw.iterative_scan` ≥0.8 才有，WeKnora 对其有降级路径，0.8.0 即完整满足）。
4. **修正（推翻 PG15 文档推断）①：无需 `search_path` 复刻。**
   - PG15 评估文档依据「pg_search 全部对象装在 `paradedb` schema、应用 DSN 不设 search_path、官方镜像靠 bootstrap `ALTER DATABASE SET search_path`」推断必须复刻。
   - 实测（`pg_operator` 直查）：pg_search 0.22.2 把 `|||` 注册为**多态运算符** `anyelement ||| text|text[]|pdb.query|pdb.boost|pdb.fuzzy` → boolean，**全部落在 `pg_catalog`**。而 `pg_catalog` 在默认解析顺序里总是最前，故 `content ||| 'q'`（走 `anyelement ||| text`）在任何默认会话里都能解析。
   - 实证锚点：后建的 `weknora_gotest` 库从未被 bootstrap 改写 search_path（`SHOW search_path` = `"$user", public`），关键词检索与集成测试全部通过。
   - 结论：**0.22.2 不需要** `ALTER DATABASE ... SET search_path`。官方 bootstrap 与 §8 Dockerfile 里的 `init-search-path.sh` 保留仅作**对齐官方/防御性**（万一未来 pg_search 版本把运算符挪进 `paradedb` schema）。
5. **修正（重估 PG15 文档）②：PG17 无需 `shared_preload_libraries='pg_search'`。**
   - 实测运行中 preload 为 `pg_stat_monitor, percona_pg_telemetry`（**不含 pg_search**），bm25 索引创建与查询均正常。PG15 文档所载「PG<17 必须 preload 否则建 bm25 索引崩」的硬性约束在 PG17 上不存在。
   - §8 Dockerfile 里的 preload 改动仅为对齐官方行为，非必需（若删掉也不影响功能）。
6. **决策：把 gated 集成测试入仓**，作为每次「公司插件实例」就绪验收与回归的标准入口（弥补既有 postgres 检索包零覆盖的空白）。

---

## 6. 给运维的落地要点

**镜像构建（最小集）**
1. `FROM percona/percona-distribution-postgresql:17.5`
2. `USER root` 后 `rpm -ivh pg_search_17-0.22.2-1PARADEDB.el9.x86_64.rpm`（从 ParadeDB GitHub Release 下载，CPU ≥ x86-64-v3）；装回 `USER 26`
3. （建议，非必需）复刻官方 preload `pg_search` + 初始库 search_path 到 `paradedb`，见 §8.1 注释；即使不做，0.22.2 功能不受影响

**PGO 集群注意**
- PerconaPGCluster（PGO）下，插件的 `.so`/`extension` 文件必须随 **镜像** 分发（所有主/从节点同源同版本）；pg_search 不支持降级，升级要滚动。
- 若共享实例要求，可让 DB 团队以 superuser **预建扩展**（`CREATE EXTENSION vector/pg_search/pg_trgm/"uuid-ossp"`），WeKnora 侧迁移用 `IF NOT EXISTS` 兜底，普通账号即可完成。或者直接给 WeKnora 连接账号开扩展创建权限（应用启动会自动建）。
- 用 §8.3 的 gated 集成测试作为就绪验收：`WEKNORA_TEST_PG_DSN` 指向一个**空的专用测试库**（superuser 或能建扩展），跑绿即证明插件安装正确、迁移与两条检索路径可用。

---

## 7. 复现命令

### 7.1 镜像构建（含材料）

```bash
# 1) 拉基础镜像、下 pg_search rpm
docker pull percona/percona-distribution-postgresql:17.5
curl -L -o pg_search_17.rpm \
  "https://github.com/paradedb/paradedb/releases/download/v0.22.2/pg_search_17-0.22.2-1PARADEDB.el9.x86_64.rpm"

# 2) 构建
docker build -f Dockerfile -t <your-reg>/pg17-pgsearch-percona:17.5 .
#    （不推 Harbor；把 Dockerfile + rpm 交给运维复现）
```

### 7.2 拉起冒烟

```bash
docker run -d --name pg-itest -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=pgsrv_weak_test -e POSTGRES_DB=weknora_itest \
  <your-reg>/pg17-pgsearch-percona:17.5
psql "postgres://postgres:pgsrv_weak_test@127.0.0.1:55432/weknora_itest?sslmode=disable" \
  -c "CREATE EXTENSION vector; CREATE EXTENSION pg_search; CREATE EXTENSION pg_trgm; CREATE EXTENSION \"uuid-ossp\";"
```

### 7.3 集成测试（推荐做法）

```bash
# 专用空库（先建好：CREATE DATABASE weknora_gotest）
WEKNORA_TEST_PG_DSN="postgres://postgres:<pw>@<host>:<port>/weknora_gotest?sslmode=disable" \
  go test ./internal/application/repository/retriever/postgres/ -v -count=1

# 无 DSN 时（CI）：测试全部 skip，不挂
go test ./internal/application/repository/retriever/postgres/
```

---

## 8. 附录

### 8.1 用到的 Dockerfile（实证原稿）

```dockerfile
# WeKnora postgres: 以公司 Percona PG 17.5 为基础补齐 pg_search 0.22.2
# pgvector 0.8.0 / pg_trgm / uuid-ossp 已随镜像内置
FROM percona/percona-distribution-postgresql:17.5
USER root
COPY pg_search_17.rpm /tmp/pg_search_17.rpm
RUN rpm -ivh /tmp/pg_search_17.rpm && rm -f /tmp/pg_search_17.rpm
# ↓ 以下两步为“对齐官方行为/防御性”，0.22.2 实测并非功能必需（见 §5-4/5-5）
RUN sed -i "s/^shared_preload_libraries = 'percona_pg_telemetry'/shared_preload_libraries = 'pg_search,percona_pg_telemetry'/" \
      /usr/pgsql-17/share/postgresql.conf.sample
COPY init-search-path.sh /docker-entrypoint-initdb.d/10_search_path_paradedb.sh
RUN chmod +x /docker-entrypoint-initdb.d/10_search_path_paradedb.sh
USER 26
```

```bash
# init-search-path.sh（内容与官方 bootstrap 等价；保留仅作对齐/防御）
#!/bin/bash
set -e
PGUSER="${POSTGRES_USER:-postgres}"
for db in $(psql -U "$PGUSER" -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn;"); do
  psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE \"$db\" SET search_path TO \"\$user\", public, paradedb;" >/dev/null
done
```

### 8.2 关键证据速查

- `server_version`：`PostgreSQL 17.5 (Percona Server …17.5.3 … x86_64)`，`server_version_num=170005`。
- 已装 rpm：`pg_search_17-0.22.2-1.el9.x86_64`、`percona-pgvector_17-0.8.0-1.el9.x86_64`。
- ext 版本：`pg_search=0.22.2`、`vector=0.8.0`、`pg_trgm=1.6`、`uuid-ossp=1.1`。
- `|||` 注册（`pg_operator`）：`anyelement ||| text/text[]/pdb.query/pdb.boost/pdb.fuzzy → boolean`，`nspname=pg_catalog`。
- HNSW 强制走索引计划：`Index Scan using embeddings_embedding_idx_3584 on embeddings`（`enable_seqscan=off` 下）。
- `shared_preload_libraries`（运行中）：`pg_stat_monitor, percona_pg_telemetry`（无 pg_search，bm25 正常）。
- 官方镜像：Debian trixie + PGDG PG 17.9；打包 postgis3/pg_cron/pg_ivm/barman + pg_search(1.05GB debug .so) + pgvector。

---

## 9. 边界与后续

- **本任务不含 PGO 集群 / helm 落点改动**。PGO 接管后仍需确认：共享实例的命名空间/权限、备份策略是否覆盖 bm25/HNSW 索引、主从节点插件一致性与滚动升级、以及 drcloud helm 里既有 postgres 组件的下线流程。
- **许可证**：pg_search 为 **AGPL-3.0**（另有商业许可）。纯内网部署一般无开源义务，需合规确认。
- **大版本升级**：公司 PG 后续 17.5→更高 17.x/18 时 pg_search 需跟随（pg_search 不支持降级；跨 PG 大版本要换对应产物）。
- **CPU**：若目标宿主机低于 x86-64-v3，pg_search 预编译包无法运行，只能源码编译（成本显著上升，需另排期评估）。
- **长期可取更优路径**：pg_search 若随版本把 `|||` 迁入 `paradedb` schema，或 WeKnora 某天直连 `paradedb.score` 之外的裸对象，才需要 search_path 兜底——集成测试的 `TestKeywordsRetrieveWorksWithDefaultSearchPath` 可在此类升级后第一时间报警。
