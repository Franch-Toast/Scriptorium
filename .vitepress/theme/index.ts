// Teek 主题接入：在 VitePress 默认主题基础上扩展（在线包方式）
import Teek from "vitepress-theme-teek";
import "vitepress-theme-teek/index.css";
import "./custom.css";
import ContributionGraph from "./components/ContributionGraph.vue";
import type { Theme } from "vitepress";

export default {
  extends: Teek,
  enhanceApp({ app }) {
    // 热力图在落地页与更新记录页两处复用，注册为全局组件（页面内直接使用标签）
    app.component("ContributionGraph", ContributionGraph);
  },
} satisfies Theme;
