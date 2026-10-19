---
title: "数据库组件选型：ParadeDB（pg17）→ 公司 Percona PG 15 迁移评估"
date: 2026-10-19
description: "> 场景：当前 WeKnora 各环境自带有自己的 paradedb/paradedb:v0.22.2-pg17 容器，DB 由各环境/应用方自行运维（备份、升级、高可用、磁盘都要各自负责）。公司已有统一运维的 Percona PG Cluster 15（PostgreSQL 15），希望在安装若干插件后复用该实例，降..."
categories:
  - "撰修司"
tags: []
---

# 数据库组件选型：ParadeDB（pg17）→ 公司 Percona PG 15 迁移评估

> 场景：当前 WeKnora 各环境自带有自己的 `paradedb/paradedb:v0.22.2-pg17` 容器，DB 由各环境/应用方自行运维（备份、升级、高可用、磁盘都要各自负责）。公司已有统一运维的 `Percona PG Cluster 15`（PostgreSQL 15），希望在安装若干插件后复用该实例，降低 WeKnora 的数据库运维成本。
>
> 结论：**技术上可行，且应用侧零代码改动**。weknora 不依赖"ParadeDB 发行版镜像"本身，只依赖 3 个可以独立装到 PG15 上的扩展。真正的阻力不是技术兼容，而是**公司 DB 团队是否允许在共享集群上安装第三方扩展**（pg_search）。

---

## 1. WeKnora 对数据库的真实依赖（代码盘点）

WeKnora 的 `DB_DRIVER=postgres` 业务库 与 `RETRIEVE_DRIVER=postgres` 检索引擎是**同一个 gorm 连接**（`internal/container/container.go:1099`、`internal/container/engine_factory.go:161`）。因此一个数据库实例即可同时承载：

| 依赖扩展 | 被用在 | 关键 SQL/代码点 |
|---|---|---|
| `pg_search`（BM25 全文检索） | 关键词检索 | `USING bm25` 索引；`content ||| ?` 运算符；`paradedb.score(id)` 函数——`internal/application/repository/retriever/postgres/repository.go:197-215` |
| `pgvector`（`halfvec` 类型） | 向量检索 | `halfvec` 列 + HNSW 部分索引（dim 3584/798/1024）；`hnsw.ef_search`、`hnsw.iterative_scan` GUC——`repository.go:263-443`、`migrations/versioned/000002/000059` |
| `pg_trgm` / `uuid-ossp` | 业务字段/兼容 | 标准 contrib，随服务器自带 |

除上述两点外，其余全是标准 PostgreSQL 能力（JSONB、外键、GORM CRUD）。

## 2. 已核验的版本兼容性事实（截至 2026-09）

以下均为核对官方文档 / GitHub Release / 源码（`paradedb` v0.22.2 tag）后的事实：

| 项目 | 事实 |
|---|---|
| pg_search 支持的大版本 | **PG15 是最低支持版本**（当前支持 15/16/17/18），PG13/14 已移除 |
| pg_search 预编译产物 | 官方提供 `postgresql-15-pg-search_<v>-1PARADEDB-<codename>_<arch>.deb`（bookworm/trixie/jammy/noble，amd64/arm64）及 `.rpm`（el9/el10），从 GitHub Release 直接下载 |
| 版本对齐 | WeKnora 镜像 tag `v0.22.2-pg17` 对应 pg_search **0.22.x**（最新 0.22.6）。建议装 0.22.x 或略新版本，`|||`/`paradedb.score` 语义跨 0.22.x 稳定 |
| `shared_preload_libraries` | **PG<17 必须** `shared_preload_libraries='pg_search'` 并重启集群，否则创建 bm25 索引时连接会崩溃/挂起（PG17+ 不需要）。注意 PG15 是 WeKnora 镜像的 pg17 所没有的新增操作 |
| pgvector 版本 | `halfvec` + HNSW 需 ≥ 0.7.0；`hnsw.iterative_scan` 需 ≥ 0.8.0。PG15 均支持。WeKnora 对 `iterative_scan` 缺省有容错（`repository.go:427`），装 0.8.x 即自带 |
| search_path | pg_search 全部对象装在 `paradedb` schema（control 文件 `schema = paradedb`）。WeKnora 未在 DSN 设 search_path，当前能工作是因为 ParadeDB 镜像 `bootstrap.sh` 对每个库执行了 `ALTER DATABASE "<db>" SET search_path TO public,paradedb;`。**迁移后必须复刻** |
| 中文分词 | `chinese_lindera` 是 pg_search 内置开源分词器（基于 lindera），**无需额外词典或配置** |
| License | pg_search 为 **AGPL-3.0**（另有商业许可）。纯内网部署一般无开源义务，但需合规确认 |
| 硬件约束 | 预编译产物要求 CPU ≥ **x86-64-v3**（Intel Haswell+ / AMD Excavator+，即 2013 年后主流服务器）。更老的 CPU 需从源码编译（Rust + pgrx，较重的构建） |
| 打包布局 | 预编译包按标准 `postgresql-15-*` 布局打包。若与 Percona 自家包体系冲突，可用 `dpkg -x`/`rpm2cpio` 手工解包扩展文件放入 `/usr/lib/postgresql/15/lib` 与 `extension/` 目录，不必强装依赖 |

## 3. 迁移到公司实例的落地步骤

### 3.1 前置检查
- 确认公司 PG15 的实际小版本、操作系统发行版（决定 .deb/.rpm）、CPU 是否 ≥ x86-64-v3。
- 确认 DB 团队是否允许：① 在共享实例装非官方扩展；② 提供一次基于 `shared_preload_libraries` 变更的重启窗口；③ 主/从所有节点统一装扩展。

### 3.2 扩展安装（所有节点，含从库）
```
# 以 pg_search 0.22.x 为例（codename/arch 按实际 OS 替换）
curl -L "https://github.com/paradedb/paradedb/releases/download/v0.22.6/postgresql-15-pg-search_0.22.6-1PARADEDB-noble_amd64.deb" -o /tmp/pg_search.deb
sudo apt-get install -y /tmp/pg_search.deb   # 或 rpm -ivh 对应 .rpm
# pgvector via PGDG: postgresql-15-pgvector (>=0.8)
# pg_trgm / uuid-ossp 为 contrib，服务器自带
```
> 若与 Percona 包冲突：`dpkg -x pg_search.deb /tmp/x && sudo cp -a /tmp/x/usr/lib/postgresql/15/... /usr/lib/postgresql/15/`

### 3.3 配置与建库
```
# postgresql.conf —— PG15 硬性要求，改后重启
shared_preload_libraries = 'pg_search'
```
```sql
CREATE DATABASE weknora;
-- 以下需 superuser，或由 DB 团队预建（pg_search/pgvector 的 control 默认需要 superuser）
CREATE EXTENSION vector;
CREATE EXTENSION pg_search;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION "uuid-ossp";
-- ★ 必须复刻 ParadeDB 镜像的默认行为，否则关键词检索报 operator ||| does not exist
ALTER DATABASE weknora SET search_path TO "$user", public, paradedb;
```

### 3.4 数据迁移
- 停写窗口内 `pg_dump -Fc` 导出现有 ParadeDB 库 → `pg_restore` 到公司实例；或逻辑复制。
- **BM25 / HNSW 索引需要重建**，embeddings 大表重建耗时长：建议先灌数据再建索引（可 `CREATE INDEX CONCURRENTLY`），并预留维护窗口。
- WeKnora 应用启动时会自动跑 `migrations/versioned/*`（`AUTO_MIGRATE=true` 默认），其中 000002/000059 会自动建 embeddings 表、bm25 索引（`chinese_lindera` 分词）与各维度 HNSW 索引。

### 3.5 切换
- 仅改 `.env` / 配置中 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` 指向公司实例，`DB_DRIVER`、`RETRIEVE_DRIVER` 保持 `postgres`，重启 app。

## 4. 风险与注意事项

1. **共享集群准入**：pg_search 不是 Percona 官方扩展，需 DB 团队开通扩产安装/SLA 边界——这是唯一"可能不可行"的来源。
2. **search_path 漏配**：最容易当场打脸的一步（见 3.3），漏配后关键词检索直接 500。
3. **节点一致性**：扩展必须装到所有主/从节点且版本一致；pg_search 不支持降级，升级要滚动。
4. **大版本升级**：公司后续 PG15→16/17 时扩展需跟随（若升到 17，反而不需要 preload，更简单）。
5. **License**：AGPL-3.0，需合规确认。
6. **备份/快照**：确保 DB 团队的备份方案覆盖到新扩展的索引与数据。

## 5. 备选路径

- **首选（推荐）**：复用公司 PG15 + 装扩展，应用零改动。
- **折中**：若 DB 团队坚决不装扩展，退而求其次由 DB 团队单独容一个"集中式 ParadeDB 专用实例"，多环境共用，仍比每个环境一个容器省，但 ParadeDB 仍由你们运维。
- **不推荐**：用 PG15 内置 `tsvector`/zhparser 替代 BM25——需改 weknora 内核 `KeywordsRetrieve`，等于维护 fork，运维成本从 DB 侧转移到应用侧。

## 6. 验证手段：现有测试能否兜住"装完插件后的正确性"？

**结论：不能。当前项目没有任何测试会去连真实 PostgreSQL 来验证 postgres/ParadeDB 检索路径。**

现状盘点：

| 范围 | 测试情况 |
|---|---|
| postgres 检索引擎包（`internal/application/repository/retriever/postgres/`） | **完全没有 `*_test.go`**，`|||`/`paradedb.score`/halfvec HNSW 路径零覆盖 |
| 其它检索引擎 | `doris`（sqlmock 断言 SQL 形态）、`sqlite`（内嵌真实 sqlite+sqlite_vec 的引擎级单测） |
| 服务层 retriever 测试 | 只测装配/分数归一化（`registry`/`factory`/`normalizer`/`hybrid_indexer`），不触数据库引擎 |
| GitHub CI（app.yml） | `go vet` + `go test ./...`（排除 docreader），**不启动任何 Postgres** |
| GitLab CI（.gitlab-ci.yml） | 只构建/推送镜像，未发现 go test 阶段 |

也就是说：即使公司 PG15 上插件没装对、search_path 漏配，**现有 CI 与单测也完全测不出来**，问题只会在生产查询时暴露。

**建议的验证方案（自己补，正好可在冒烟验证时复用）：**

1. **移植 sqlite 的引擎级单测模式**到 postgres 包：`sqlite/repository_test.go` 已经示范了"用真实 gorm DB + 真实扩展绑定 + 建表 → 直接调 `KeywordsRetrieve`/`VectorRetrieve` 断言召回"的做法。postgres 版同样构造，连到公司 PG15 测试库，断言：
   - `KeywordsRetrieve` 中文 BM25 命中（验证 `paradedb.score`/`|||`/`chinese_lindera` 生效）
   - `VectorRetrieve` halfvec HNSW 召回与 TopK（验证 pgvector 生效）
   - search_path 未配时 `KeywordsRetrieve` 应明确失败（用断言反向锁定这条 gotcha）
2. **用环境变量门控**（如 `WEKNORA_TEST_PG_DSN`，未设置时 `t.Skip`），保证 CI 无库时不挂；在本地方向公司 PG15 测试实例时自动全量跑。
3. 扩展需要 superuser 创建：测试要么用有权限的管理账号预建扩展再以普通账号跑用例，要么接受测试库允许建扩展。
4. 不建议只靠 sqlmock 形状断言（像 doris 那样）——它能锁 SQL 字符串，但**无法证明插件安装正确**，与本次目标（验证公司 PG15 可用性）不匹配。

> 若想由我们直接产出，我可以按上述模式写一个 `internal/application/repository/retriever/postgres/integration_test.go`（拖 sqlite 的壳、连真实 PG15），作为公司实例冒烟验证的标准入口。