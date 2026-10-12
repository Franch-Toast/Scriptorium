import { defineConfigWithTheme } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { generateSidebar } from "vitepress-sidebar";
import type { ThemeConfig } from "vitepress-carbon";
import baseConfig from "vitepress-carbon/dist/theme/config/baseConfig.js";

// 六大分区定义（与个人站 master 保持一致的目录约定，cherry-pick 路径零冲突的前提）
const libs = [
  { dir: "撷简台", title: "撷简台（inbox）", icon: "📥" },
  { dir: "撰修司", title: "撰修司（projects）", icon: "🚀" },
  { dir: "正典阁", title: "正典阁（knowledge）", icon: "📚" },
  { dir: "纪事寮", title: "纪事寮（experience）", icon: "🔍" },
  { dir: "资简库", title: "资简库（assets）", icon: "🧰" },
  { dir: "秘藏龛", title: "秘藏龛（archive）", icon: "🗄️" },
];

type SidebarItem = { text?: string; link?: string; items?: SidebarItem[] };

// scanStartPath 模式下插件输出的 link 相对分区根（无前导 /），补上分区目录与前导斜杠
function normalizeLinks(items: SidebarItem[], dir: string): SidebarItem[] {
  return items.map(item => ({
    ...item,
    ...(item.link ? { link: `/${dir}/${item.link}`.replace(/\/{2,}/g, "/") } : {}),
    ...(item.items ? { items: normalizeLinks(item.items, dir) } : {}),
  }));
}

function libSidebar(dir: string, title: string) {
  // 六库收纳在 docs/document/ 下，URL 前缀为 /document/<分区>
  const libPath = `document/${dir}`;
  const scanned = generateSidebar([
    {
      documentRootPath: "docs",
      scanStartPath: libPath,
      useTitleFromFrontmatter: true,
      useFolderTitleFromIndexFile: true,
    },
  ]) as unknown;
  const raw = Array.isArray(scanned)
    ? (scanned as SidebarItem[])
    : ((scanned as Record<string, { items?: SidebarItem[] }>)?.["/"]?.items ?? []);
  return [
    {
      text: title,
      items: [{ text: `${title} · 首页`, link: `/${libPath}/` }, ...normalizeLinks(raw, libPath)],
    },
  ];
}

// 多段侧边栏：库内页面 = 该库完整树；站点页无侧边栏
const sidebar = Object.fromEntries(
  libs.map(l => [`/document/${l.dir}/`, libSidebar(l.dir, l.title)]),
);

// 公司 GitLab Pages 部署时由 CI 注入 BASE_PATH，本地开发默认 "/"
const base = process.env.BASE_PATH || "/";

export default withMermaid(
  defineConfigWithTheme<ThemeConfig>({
    extends: baseConfig,
    // 内容目录与工程布局和个人站完全同构，cherry-pick 的文档无需任何调整即可构建
    srcDir: "docs",
    cacheDir: ".vitepress/cache",
    lang: "zh-CN",
    title: "Deeproute Scriptorium",
    description: "Deeproute 内部文档知识库 —— 收集、整理、沉淀",
    base,
    lastUpdated: true,
    themeConfig: {
      nav: [
        { text: "首页", link: "/" },
        ...libs.map(l => ({ text: `${l.icon} ${l.title}`, link: `/document/${l.dir}/` })),
      ],
      sidebar,
      search: {
        provider: "local",
        options: {
          translations: {
            button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
            modal: {
              noResultsText: "没有找到结果",
              resetButtonTitle: "清除查询条件",
              footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
            },
          },
        },
      },
      lastUpdated: { text: "最后更新于" },
      outline: { level: [2, 3], label: "本页目录" },
      docFooter: { prev: "上一篇", next: "下一篇" },
      returnToTopLabel: "回到顶部",
      sidebarMenuLabel: "目录",
      darkModeSwitchLabel: "主题",
      lightModeSwitchTitle: "切换到浅色模式",
      darkModeSwitchTitle: "切换到深色模式",
    },
    // dev 服务器显式绑定 IPv4 + mermaid 预构建（个人站已验证的配置，直接对齐）
    vite: {
      server: { host: "127.0.0.1" },
      optimizeDeps: { include: ["mermaid"] },
    },
  }),
  // mermaid 全局配置：```mermaid 代码块渲染为客户端组件，深浅色自动跟随
  {
    securityLevel: "loose",
    startOnLoad: false,
  },
);
