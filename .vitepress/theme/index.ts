import { VPCarbon } from "vitepress-carbon";
import "./custom.css";

// carbon 主题 Layout 入口（GitHub 风格布局：左侧文档导航 + 右侧本页目录）
// 配置层面的主题选项由 config.mts 的 extends: baseConfig 提供
export default { ...VPCarbon };
