# Scriptorium

**Scriptorium**（缮写室）—— 个人文档知识库站点。以 **VitePress + vitepress-theme-teek** 构建，内容按 **PARA** 方法论组织，通过 **GitHub Actions 自动发布到 GitHub Pages**。

本仓库是整个知识体系的**唯一内容源（Hub）**：在这里持续写作，三个发布渠道（GitHub Pages / 公司内部站点 / 飞书云盘）各自通过独立管线消费这里的文档，渠道之间互不干扰。

## 架构（Hub-and-Spoke）

```text
                    ┌──────────────────────────────────┐
                    │   Scriptorium（本仓库，唯一源）      │
                    │   PARA 内容 + VitePress 站点工程    │
                    └────────────────┬─────────────────┘
                                     │ push main
              ┌──────────────────────┼───────────────────────┐
              ▼                      ▼                       ▼
   ① GitHub Pages            ② 内部 Serverless           ③ 飞书云盘
   本仓库 Actions 自动构建     push mirror → 内部 GitLab    feishu-sync-docs
   并发布（已就绪）            CI 构建部署（待接入）          双向同步（待接入）
```

> 设计要点：不用 submodule，也不复制仓库。发布时机与版本用 **git 分支/tag + CI 触发器**控制；
> 每个渠道一条独立管线，谁也不用感知谁的存在。

## 快速开始

环境要求：Node.js >= 20、pnpm >= 10（`corepack enable` 可启用）。

```bash
pnpm install   # 安装依赖
pnpm dev       # 本地开发（http://localhost:5173），自动先生成热力图数据
pnpm build     # 构建产物到 .vitepress/dist（prebuild 钩子自动生成热力图数据）
pnpm preview   # 本地预览构建产物
```

## 目录结构

```text
Scriptorium/
├── .vitepress/                      # VitePress 工程根（与内容分离，srcDir 指向 docs/）
│   ├── config.mts                   # 站点配置（导航/搜索/侧边栏/主题）
│   ├── theme/
│   │   ├── index.ts                 # Teek 主题接入 + 全局组件注册
│   │   ├── posts.data.mts           # 全站内容文档静态数据（createContentLoader）
│   │   ├── custom.css               # 站点级样式微调与热力图色板
│   │   └── components/
│   │       ├── ContributionGraph.vue   # GitHub 风格贡献热力图
│   │       ├── ChangelogList.vue       # 更新记录卡片列表
│   │       └── LibraryIntro.vue        # 藏经阁六库介绍卡片
│   └── generated/                   # 构建时生成的站点数据（git 忽略）
├── docs/                            # 内容根（srcDir，可整体复用给其他 VitePress 项目）
│   ├── index.md                     # 落地页（Hero）
│   ├── @pages/                      # 功能页（不进侧边栏/文章流）
│   │   ├── updatesPage.md           #   更新记录：热力图 + 卡片流（/updates）
│   │   ├── catalogue.md             #   藏经阁：六库导航与介绍（/catalogue）
│   │   └── about.md                 #   关于页（/about）
│   ├── public/                      # 原样透传的静态资源（favicon 等）
│   └── document/                    # ★ 纯内容目录（六库整体收纳于此）
│       ├── 撷简台/          # ┐
│       ├── 撰修司/       # │
│       ├── 正典阁/      # ├ PARA 六大分区（与本地知识库目录一致）
│       ├── 纪事寮/     # │
│       ├── 资简库/         # │
│       └── 秘藏龛/        # ┘
├── scripts/
│   └── gen-contributions.mjs        # git log → 热力图数据（pnpm build 自动执行）
├── .github/workflows/
│   └── deploy-pages.yml             # push main → 构建 → 发布 GitHub Pages
└── README.md
```

> 工程与内容分层：`.vitepress/`（工程）在仓库根，`docs/` 只含页面与文档；其中 `docs/document/` 是纯内容目录，可整体拷贝或同步给其他项目使用。

## 日常使用：如何新增一篇文档

1. 在对应分区目录下新建 `语义化标题.md`（目录结构即站点导航，**不要平铺**）；
2. 建议带上 frontmatter：

   ```yaml
   ---
   title: 文档标题
   date: 2026-09-21
   description: 一句话摘要（可选，更新记录卡片优先展示）
   categories:
     - 正典阁
   tags:
     - 笔记
   ---
   ```

3. 卡片摘要：优先取 frontmatter 的 `description` 字段；未写时回退到正文首个段落——在首段后加一行 `<!-- more -->`，"更新记录"页会截取此前内容作为摘要；

4. `git commit` + `git push` 到 `main`——约 1~2 分钟后站点自动更新；
   贡献热力图与更新记录也会随之记录这次更新。

无需注册路由、无需改任何配置：各库侧边栏由 [vitepress-sidebar](https://github.com/jooy2/vitepress-sidebar) 按 `config.mts` 里的分区配置扫描生成；藏经阁的库介绍与文档计数、更新记录的卡片流，均由构建期数据（`posts.data.mts` / `gen-contributions.mjs`）自动驱动。

## 发布管线

### ① GitHub Pages（已就绪）

- 触发：`push` 到 `main`，或手动 `workflow_dispatch`；
- 流程：完整拉取历史（`fetch-depth: 0`，热力图需要）→ `pnpm build`（自动注入 `BASE_PATH=/<仓库名>/`）→ 发布；
- **首次启用**：GitHub 仓库 → Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**；
- 站点地址：`https://<user>.github.io/<repo>/`。

### ② 公司内部 Serverless 站点（预留）

推荐「GitHub push mirror → 内部 GitLab CI」模式，内部渠道完全自治：

1. GitHub 仓库 Settings → Remotes → **Add push mirror**，目标为内部 GitLab 上的 `<你的名字>/scriptorium` 空仓库（凭据用内部 GitLab PAT）；
2. 内部 GitLab 仓库放一个 `.gitlab-ci.yml`（内容与 deploy-pages.yml 等价的构建脚本 + 内部部署平台的发布命令）；
3. 发布时机两种选法：
   - `push mirror` 每次同步都触发内部 CI → 内网站点与 GitHub 同步更新；
   - 或内部 CI 只监听 **tag**（如 `release/2026-09-21`）→ 内网站点只在打 tag 时更新，形成人工版本门禁；
4. 构建时同样注入 `BASE_PATH=/scriptorium/`（与内部部署路径一致）。

### ③ 飞书云盘（预留）

复用既有的 `feishu-sync-docs` 服务：它以本地目录为唯一真相、与飞书云盘文件夹双向同步。接入方式：

1. 启动 feishu-sync-docs，将本仓库的 `docs/document/`（纯内容目录）绑定为同步根目录（`remoteType=folder`）；
2. 本地编辑 → 自动推送到飞书；飞书端编辑 → 三方合并回本地 → `git commit` 后随 ①② 渠道发布；
3. 注意：feishu-sync 的同步基线就是 `docs/` 所在仓库的 `main` 分支 HEAD，**不要在其他机器直接编辑本仓库 main 后强推**，以免扰动基线判定。

## 自定义

| 想改什么 | 位置 |
| --- | --- |
| 站点标题/描述/导航 | `.vitepress/config.mts` |
| 落地页文案与卡片 | `docs/index.md`（Hero frontmatter） |
| Teek 主题行为（作者信息、文章信息等） | `config.mts` 里的 `defineTeekConfig({...})`，全部选项见 [Teek 文档](https://vp.teek.top) |
| 热力图颜色阈值 | `ContributionGraph.vue` 的 `levelOf()` 与 `custom.css` 的 `--tk-contrib-*` |
| 各库侧边栏（树/返回入口/藏经阁导航） | `config.mts` 里 `libs` 与 `libSidebar()` |
| 藏经阁六库介绍文案 | `.vitepress/theme/components/LibraryIntro.vue` 的 `LIBS` |

开启分类页/标签页：在 `docs/@pages/` 仿照 `updatesPage.md` 新建 `categoriesPage.md`（frontmatter `categoriesPage: true` + `layout: page` + `permalink: /categories`），标签页同理，再在 `config.mts` 的 `nav` 中加入口。

## 常见问题

- **中文/空格路径会坏吗？** 不会。目录名原样出现在导航与 URL（浏览器自动百分号编码），站内互链在构建期做 dead link 校验，写错会直接报错；
- **页面白屏、资源 404？** 大概率 `base` 不对：本地用默认 `/`，GitHub Pages 用 `BASE_PATH=/<仓库名>/ pnpm build`；
- **`/updates`、`/catalogue` 这些地址怎么实现的？** `@pages/` 下功能页的 frontmatter 带 `permalink`，由 `vitepress-plugin-permalink` 的 `createRewrites`（VitePress rewrites 机制）在 dev/build 时落地为根路径物理文件，纯静态托管可直接访问；新增功能页同理，无需额外配置；
- **热力图是空的？** 数据来自 git 提交历史（`docs/` 下，按天统计修改篇次），新 clone 后先跑 `pnpm dev` 或 `pnpm build` 生成；CI 使用完整历史（`fetch-depth: 0`），无需担心；
- **新文档没出现在侧边栏？** 检查文件是否在六大分区目录内、是否被误放进 `@pages/`（该目录不参与侧边栏）；
- **更新记录/藏经阁计数少了？** 这两处只统计带 frontmatter `date` 的内容文档，检查新文档的 frontmatter；

## 维护边界

- `.vitepress/generated/`、`.vitepress/cache/`、`.vitepress/dist/` 均为构建产物，已 gitignore，不要手工编辑；
- 伪造/修改历史提交日期会影响热力图，属于个人仓库的自由但需自担一致性；
- 仓库当前无远程：推送到你的 GitHub 后，在 `config.mts` 把 `socialLinks` 与 `@pages/about.md` 中的占位 `your-name` 替换为实际账号。
