import { createContentLoader } from "vitepress";

export interface DirectoryDocument {
  url: string;
  title?: string;
  description?: string;
}

// 构建期扫描 srcDir 下全部文档，url 原样下发：散文档为 .html 形态，
// 目录 index 为尾斜杠形态（/xxx/）——组件据此识别子目录入口并链接
// 到目录 URL（静态托管友好的 clean URL）；各库自身的 index 由组件排除。
export default createContentLoader<DirectoryDocument[]>("document/**/*.md", {
  transform: data =>
    data
      .filter(page => page.url !== "/")
      .map(page => ({
        url: page.url,
        title: typeof page.frontmatter.title === "string" ? page.frontmatter.title : undefined,
        description:
          typeof page.frontmatter.description === "string" ? page.frontmatter.description : undefined,
      })),
});
