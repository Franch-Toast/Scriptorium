---
title: "WeKnora 数据库镜像替换 · 运维实施说明（Percona PG 17.5 + pgsearch 0.22.2）"
date: 2026-10-19
description: "> 本文档给 运维 / DBA 同学：把我们实测通过的「公司 Percona PG 17.5 基础镜像 + ParadeDB pgsearch 插件」镜像的构建与部署要点整理成可直接照做的清单。所有版本、下载源、安装方式均来自一次完整的本地实证（详见同目录《ParadeDB迁移至PerconaPG17-5镜像-可行性实..."
categories:
  - "撰修司"
tags: []
---

# WeKnora 数据库镜像替换 · 运维实施说明（Percona PG 17.5 + pg_search 0.22.2）

> 本文档给 **运维 / DBA 同学**：把我们实测通过的「公司 Percona PG 17.5 基础镜像 + ParadeDB pg_search 插件」镜像的构建与部署要点整理成可直接照做的清单。所有版本、下载源、安装方式均来自一次完整的本地实证（详见同目录《[ParadeDB迁移至PerconaPG17-5镜像-可行性实测.md](./ParadeDB迁移至PerconaPG17-5镜像-可行性实测.md)》）。
>
> **一句话结论**：目标是给 WeKnora 提供自定义的 PostgreSQL 镜像，**在 Percona PG 17.5 基础镜像上只补装 `pg_search` 一个包**即可满足 WeKnora 全部数据库依赖。pgvector / pg_trgm / uuid-ossp 都已包含在基础镜像里，无需额外安装。**不需要**改动任何 WeKnora 应用代码，也**不需要**在数据库上额外设置 `search_path` 或把 `pg_search` 加进 `shared_preload_libraries`。

---

## 1. 交付概要

| 项 | 值 |
|---|---|
| 用途 | 替代 WeKnora 目前各环境自带的 `paradedb/paradedb:v0.22.2-pg17` 单实例 |
| 基础镜像 | `percona/percona-distribution-postgresql:17.5`（PostgreSQL 17.5.3，Oracle Linux 9.6，x86_64） |
| 需补装扩展 | **`pg_search`** `17`/`0.22.2`（el9 / x86_64）—— 唯一需额外安装的包 |
| 基础镜像已含扩展 | `vector` 0.8.0（`percona-pgvector_17-0.8.0`）、`pg_trgm`、`uuid-ossp` |
| 应用侧改动 | **零改动**（仅连接串指向新实例） |
| 需数据库侧配置 | 无强制项（`preload` / `search_path` 均可选，见 §6） |
| 玩法约束 | 插件随**镜像**分发，主/从节点同源同版本 |

---

## 2. 版本与依赖矩阵（务必按此对齐）

| 软件 | 版本 | 说明 / 来源 |
|---|---|---|
| PostgreSQL | **17.5** | 即 Percona Distribution for PostgreSQL 17.5，运行 `SHOW server_version_num` = `170005` |
| pg_search | **0.22.2** | 与官方 `paradedb:v0.22.2-pg17` 完全同版本；WeKnora 的 bm25 索引 / `|||` / `paradedb.score()` / `chinese_lindera` 均依赖它。**建议锁定 0.22.x，不要跨大补丁随意升级** |
| pgvector | **0.8.0** | 基础镜像预装 `percona-pgvector_17-0.8.0`；WeKnora 用 `halfvec` + HNSW + `hnsw.ef_search` / `hnsw.iterative_scan`（后一个 GUC 需 ≥0.8，0.8.0 即满足） |
| pg_trgm | 1.6 | 服务器 contrib，基础镜像自带 |
| uuid-ossp | 1.1 | 服务器 contrib，基础镜像自带 |
| CPU | 需 **x86-64-v3**（Intel Haswell+/AMD Excavator+，2013 年后主流服务器） | pg_search 预编译二进制的要求；装机前用 `lscpu` 看 flags（有 `avx2` 基本即满足） |

---

## 3. 下载

**pg_search 唯一需要下载的文件**（选 x86_64 或按宿主机架构选 arm64）：

- 官方 GitHub Release：`https://github.com/paradedb/paradedb/releases/tag/v0.22.2`
- 直接下载（x86_64 / el9）：
  `https://github.com/paradedb/paradedb/releases/download/v0.22.2/pg_search_17-0.22.2-1PARADEDB.el9.x86_64.rpm`
- 若宿主机是 arm64：[同页 `…-1PARADEDB.el9.aarch64.rpm`](https://github.com/paradedb/paradedb/releases/download/v0.22.2/pg_search_17-0.22.2-1PARADEDB.el9.aarch64.rpm)

注意事项：
- 文件名里的 `PARADEDB` 只是发行商命名约定；装好后 `rpm -q` 显示的 `Release` 字段为 `1.el9`（我们实测视频验证过的正是这个包），属正常。
- 安装后校验身份：`rpm -qi pg_search_17` 应显示 `Name: pg_search_17, Version: 0.22.2, Release: 1.el9`。
- 只下 **el9** 系列（对应 Oracle Linux 9 / RHEL9 系）。不要下 Deb 系列。

---

## 4. 镜像构建（可直接照抄）

```dockerfile
# Dockerfile —— 公司镜像：Percona PG 17.5 + pg_search 0.22.2
# 构建上下文里放好下载的 rpm，文件名为 pg_search_17.rpm
FROM percona/percona-distribution-postgresql:17.5
USER root
COPY pg_search_17.rpm /tmp/pg_search_17.rpm
RUN rpm -ivh /tmp/pg_search_17.rpm \
 && rm -f /tmp/pg_search_17.rpm \
 && rpm -qa | grep ^pg_search_17          # 应输出 pg_search_17-0.22.2-1.el9.x86_64
USER 26
```

```bash
docker build -t <registry>/pg17-pgsearch-percona:17.5 .
# 验证镜像内插件文件就位：
docker run --rm <registry>/pg17-pgsearch-percona:17.5 \
  sh -c "ls -la /usr/pgsql-17/lib/pg_search.so && ls /usr/pgsql-17/share/extension/ | grep -i pg_search"
```

要点：
- Percona 镜像默认用户是 UID 26（postgres），无权限写 `/usr/pgsql-17`，所以 `rpm -ivh` 必须在 **`USER root`** 下执行，装完切回 `USER 26`。
- 安装产物：`/usr/pgsql-17/lib/pg_search.so` + `/usr/pgsql-17/share/extension/pg_search.{control,sql…}`，与其他扩展同布局，无需手工搬文件。
- 若公司对签名/合规有要求：该 rpm 无官方签名依赖，`rpm -ivh` 可直接装；不能用 `yum/apt` 仓库拉（ParadeDB 官方只发二进制 + 源码）。

---

## 5. 启动与数据库初始化

```bash
# 本地起一个验证实例（或用 PGO 直接拉上面的镜像）
docker run -d --name pg-itest -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=<your_pw> \
  <registry>/pg17-pgsearch-percona:17.5

# 建库侧扩展（superuser 或授权给应用账号；全部幂等）
psql "postgres://postgres:<your_pw>@<host>:5432/<db>?sslmode=disable" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_search;
SELECT extname, extversion FROM pg_extension WHERE extname IN
  ('vector','pg_trgm','uuid-ossp','pg_search') ORDER BY 1;
SQL
```

输出应为：
```
 vector    | 0.8.0
 pg_trgm   | 1.6
 uuid-ossp | 1.1
 pg_search | 0.22.2
```

> 应用侧 WeKnora 启动时若 `AUTO_MIGRATE=true`（默认），会自动执行 `migrations/versioned` 全链：建 `embeddings` 表、BM25 索引（`chinese_lindera` 分词）、HNSW 向量索引等，全部幂等。**主/从所有节点都要能建扩展**（PGO 环境下建议先用 superuser 在集群库里预建一次扩展，或给应用账号开 `CREATE ON DATABASE` 权限）。

---

## 6. 配置说明（两个可选项，均非强制）

1. **`shared_preload_libraries`：可选。**
   - 实测：基础镜像默认 preload 为 `pg_stat_monitor, percona_pg_telemetry`，**不含 pg_search**，bm25 索引创建与查询**均正常**（PG17 从内核层面不再要求 pg_search 预载；PG15 才必须，见 §9 升级提醒）。
   - 若想把行为贴齐官方镜像，可在示例配置里加 `pg_search`，但**不加不影响功能**。
2. **`search_path`：不需要配置。**
   - 实测：pg_search 0.22.2 把 `|||` 运算符注册为 pg_catalog 下的多态运算符（`anyelement ||| text/…`），默认会话（`"$user", public`）下**可直接解析**；应用代码里 `paradedb.score(id)` 也始终限定 schema 调用。
   - 因此**不需要**对每个库执行 `ALTER DATABASE ... SET search_path TO …paradedb`（早期 ParadeDB 镜像的 bootstrap 行为，0.22.2 下纯属历史包袱）。若为了将来兼容仍想加，也不影响正确性。

---

## 7. PerconaPGCluster（PGO）落地注意点

1. **插件随镜像分发**：构建好的镜像用于集群所有 Pod（主/备/从）。任何节点缺 `.so` 都会导致该节点建索引/查询失败——务必保证全集群同一镜像 tag。
2. **扩展安装权限**：
   - 方式 A（推荐）：让 DBA 用 superuser 在库上先执行 §5 的 4 条 `CREATE EXTENSION IF NOT EXISTS …`（幂等）。
   - 方式 B：给 WeKnora 连接账号开扩展创建权限，由应用启动自动建（`AUTO_MIGRATE` 会兜底）。
3. **升级约束**：pg_search **不支持降级**。小版本升级（0.22.2 → 0.22.x）走滚动：先备后主，逐步换新镜像；跨大版本升级必须先做兼容性验证（见 §9）。
4. **重启窗口**：PG17 下 `pg_search` 不要求进 preload，**理论上无需为插件做集群重启**（若决定加 preload 才需要重启窗口）。
5. **备份**：确认公司备份方案覆盖 bm25/HNSW 索引（逻辑备份 `pg_dump` 天然含扩展对象；物理备份无影响）。

---

## 8. 验证清单（上线前必须跑绿）

### 8.1 扩展 & 权限
```sql
SELECT extname, extversion FROM pg_extension ORDER BY 1;
```
应含 vector 0.8.0 / pg_trgm / uuid-ossp / pg_search 0.22.2。

### 8.2 中文关键词检索（BM25）
```sql
CREATE TEMP TABLE t(id serial primary key, content text);
CREATE INDEX t_bm25 ON t USING bm25(id, content)
  WITH (key_field='id',
        text_fields='{"content":{"tokenizer":{"type":"chinese_lindera"}}}');
INSERT INTO t(content) VALUES ('腾讯云向量数据库为金融提供底座'), ('自动驾驶时序数据');
SELECT id, paradedb.score(id) FROM t
 WHERE content ||| '向量数据库' ORDER BY paradedb.score(id) DESC;
```
预期：只命中「向量数据库」那条，score > 0。

### 8.3 运维就绪门禁（推荐做法）
用 WeKnora 仓库内置的 gated 集成测试（真实库，自动跑全量迁移 + BM25 + HNSW TopK + 过滤/禁用）：

```bash
# 指向一个【空的专用测试库】（superuser 或能建扩展）
WEKNORA_TEST_PG_DSN="postgres://postgres:<pw>@<host>:<port>/weknora_gotest?sslmode=disable" \
  go test ./internal/application/repository/retriever/postgres/ -v -count=1
```

预期 5 个用例全部 `PASS`（无 DSN 时自动 skip，专供无库的 CI）：
`TestKeywordsRetrieveChineseBM25` / `TestKeywordsRetrieveWorksWithDefaultSearchPath` / `TestVectorRetrieveHalfvecTopK` / `TestVectorRetrieveFiltersByKnowledgeBase` / `TestKeywordsRetrieveRespectsIsEnabledDisable`。

---

## 9. 常见问题排查

| 现象 | 原因 & 处理 |
|---|---|
| `CREATE EXTENSION pg_search` 报 `extension "pg_search" has no installation script` / `control file not found` | 镜像没装到 pg_search 文件，或装错 PG 大版本（装了 15/16 的包）。核对 `rpm -qa | grep pg_search` = `pg_search_17-0.22.2-1.el9` |
| 建 bm25 索引时**连接崩溃/后端子进程被杀** | 说明用在了 **PG15**（必须 `shared_preload_libraries='pg_search'` + 重启）。PG17 不会出现 |
| 查询报 `operator does not exist: text ||| unknown` | pg_search 扩展**没建到这个库**（不是 search_path 问题）。执行 §5 的 `CREATE EXTENSION pg_search` |
| 报 `module ... mismatch` / `unsupported version` | 服务端 PG 与 pg_search 编译时的 PG 大版本不一致（如用 pg_search_16 包装到 PG17）。正确装 `pg_search_17` 系列 |
| 部署机 CPU 过老起不来 | pg_search 需 x86-64-v3。`lscpu` 无 `avx2` → 需评估源码编译（成本高，另行排期） |
| 向量查询报 `hnsw` 相关 GUC 不存在 | 那是有降级路径的旧 pgvector（<0.8）；本镜像内置 0.8.0，正常不会出现 |

## 10. 升级 / 许可 / 备份提醒

- **大版本升级**：公司 PG 将来 17.5→18 时，需同步换 `pg_search_18` 对应产物并做兼容验证；pg_search 无降级，升级需滚动 + 先备后主。
- **许可证**：pg_search 为 **AGPL-3.0**（另有商业授权）。纯内网使用一般无开源义务，发布/分发前请走合规确认。
- **备份**：逻辑备份（pg_dump）自动包含扩展与 bm25/HNSW 索引定义；恢复后应用自动重新 `AUTO_MIGRATE` 幂等补全。

---

附：实证环境快照（供对账）

- 运行版本：`PostgreSQL 17.5 (Percona Server …)`, `server_version_num=170005`
- 已装包：`pg_search_17-0.22.2-1.el9.x86_64`、`percona-pgvector_17-0.8.0-1.el9.x86_64`
- 全量 85 个 `migrations/versioned` 迁移跑通；5 个 gated 集成测试全绿