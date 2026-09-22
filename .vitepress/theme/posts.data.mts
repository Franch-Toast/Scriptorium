import { createContentLoader } from "vitepress";

// 全站内容文档静态数据（dev/build 时由 VitePress 生成）：
// 标题、日期、分类、标签与摘要。仅保留 PARA 内容文档——
// 排除站点页（首页/关于/@pages 功能页）与各库目录首页，且必须有 date。
// 摘要取 frontmatter 之后到 <!-- more --> 标记为止的内容（写作约定见 README）。
export default createContentLoader("**/*.md", {
  excerpt: true,
  // 仅保留 PARA 内容文档：排除站点页（首页/关于/@pages 功能页）与各库目录首页，且必须有 date
  transform: data =>
    data.filter(
      p =>
        p.url !== "/" &&
        !p.url.endsWith("/index.html") &&
        !p.url.startsWith("/@pages") &&
        p.url !== "/about.html" &&
        p.frontmatter.date,
    ),
});
