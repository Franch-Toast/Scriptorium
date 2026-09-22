import { defineConfig } from "vitepress";
import { generateSidebar } from "vitepress-sidebar";
import { createRewrites } from "vitepress-plugin-permalink";
import { defineTeekConfig } from "vitepress-theme-teek/config";

// Teek 主题配置：关闭博客风首页，保留 VitePress 原生 Hero 落地页
const teekConfig = defineTeekConfig({
  teekHome: false,
  vpHome: true,
});

// 六大分区定义（藏经阁导航与各库侧边栏共用的单一事实来源）
const libs = [
  { dir: "撷简台", title: "撷简台（inbox）", icon: "📥" },
  { dir: "撰修司", title: "撰修司（projects）", icon: "🚀" },
  { dir: "正典阁", title: "正典阁（knowledge）", icon: "📚" },
  { dir: "纪事寮", title: "纪事寮（experience）", icon: "🔍" },
  { dir: "资简库", title: "资简库（assets）", icon: "🧰" },
  { dir: "秘藏龛", title: "秘藏龛（archive）", icon: "🗄️" },
];

// 各库侧边栏：顶部“返回藏经阁”入口 + 仅该库的完整目录树（新文档入库自动出现，无需改配置）
type SidebarItem = { text?: string; link?: string; items?: SidebarItem[] };

// scanStartPath 模式下插件输出的 link 是相对分区根（无前导 /），补上分区目录与前导斜杠
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
      // 相对项目根（构建 cwd）；scanStartPath 相对它解析，最终指向 docs/document/<分区>
      documentRootPath: "docs",
      scanStartPath: libPath,
      useTitleFromFrontmatter: true,
      useFolderTitleFromIndexFile: true,
      // 不设 collapseDepth：库内全树默认展开
    },
  ]) as unknown;
  // 该选项组合下插件返回多段对象 { "/": { items } }；旧版/其他组合返回数组，两种形态都兼容
  const raw = Array.isArray(scanned)
    ? (scanned as SidebarItem[])
    : ((scanned as Record<string, { items?: SidebarItem[] }>)?.["/"]?.items ?? []);
  return [
    { text: "← 返回藏经阁", link: "/catalogue" },
    {
      text: title,
      items: [
        { text: `${title} · 首页`, link: `/${libPath}/` },
        ...normalizeLinks(raw, libPath),
      ],
    },
  ];
}

// 多段侧边栏（VitePress 按路径最长前缀匹配）：
// 藏经阁页 = 仅六个一级目录导航；库内页面 = 该库完整树；其余站点页无侧边栏
const sidebar = {
  "/catalogue": libs.map(l => ({ text: `${l.icon} ${l.title}`, link: `/document/${l.dir}/` })),
  ...Object.fromEntries(libs.map(l => [`/document/${l.dir}/`, libSidebar(l.dir, l.title)])),
};

// GitHub Pages 项目站部署时由 CI 注入 BASE_PATH（如 /Scriptorium/），本地开发默认 "/"
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  extends: teekConfig,
  // 内容目录（相对 VitePress root=项目根）：docs 只放页面与文档内容，工程全部在根 .vitepress
  srcDir: "docs",
  // 依赖缓存显式指回根 .vitepress（VitePress 默认会落在 srcDir 下的 .vitepress/cache）
  cacheDir: ".vitepress/cache",
  // 功能页 permalink（/archives、/catalogue*）落地为根路径物理文件：
  // Teek 的 permalink 插件仅在 dev 模式拦截，纯静态托管（GitHub Pages）下会 404，
  // 这里改用其 createRewrites 生成 VitePress 原生 rewrites，dev/build 均生效
  rewrites: createRewrites({ srcDir: "docs" }),
  lang: "zh-CN",
  title: "Scriptorium",
  description: "个人文档知识库 —— 收集、整理、沉淀，让知识在时间线上生长",
  base,
  lastUpdated: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }]],
  themeConfig: {
    nav: [
      { text: "首页", link: "/" },
      { text: "更新记录", link: "/updates" },
      { text: "藏经阁", link: "/catalogue" },
      { text: "关于", link: "/about" },
    ],
    sidebar,
    socialLinks: [
      { icon: "github", link: "https://github.com/your-name/Scriptorium" },
    ],
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
  markdown: {
    lineNumbers: true,
    image: { lazyLoading: true },
    container: {
      tipLabel: "提示",
      warningLabel: "警告",
      dangerLabel: "危险",
      infoLabel: "信息",
      detailsLabel: "详细信息",
    },
  },
});
