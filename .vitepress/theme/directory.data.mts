import { createContentLoader } from "vitepress";

export interface DirectoryDocument {
  url: string;
  title?: string;
  description?: string;
}

export default createContentLoader<DirectoryDocument[]>("document/**/*.md", {
  transform: data =>
    data
      .filter(page => {
        const url = decodeURIComponent(page.url).replace(/\.html$/, "").replace(/\/$/, "");
        return !page.url.endsWith("/") && !url.endsWith("/index");
      })
      .map(page => ({
        url: page.url,
        title: typeof page.frontmatter.title === "string" ? page.frontmatter.title : undefined,
        description:
          typeof page.frontmatter.description === "string" ? page.frontmatter.description : undefined,
      })),
});
