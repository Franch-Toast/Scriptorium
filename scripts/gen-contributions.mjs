// 构建前生成站点数据（供组件静态导入）：
// 1. contributions.json —— 近一年热力图：每天文档修改篇次（不去重，同日同文档多次提交计多次）
// 2. docs-updates.json  —— 每篇内容文档的最后提交日期，供更新记录页按更新时间排序
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const outDir = path.join(repoRoot, ".vitepress", "generated");

// 内容文档口径：docs/ 下除功能页(@pages)、站点页(index/about)与各库目录首页外的 md
function isContentDoc(file) {
  const rel = file.slice(5); // 去掉 "docs/"
  if (rel.startsWith("@pages/") || rel === "index.md" || rel === "about.md") return false;
  if (rel.endsWith("/index.md")) return false;
  return true;
}

let log = "";
try {
  // @date 行开头一个 commit；后续行为该 commit 的文件变更（--name-status：状态\t路径）
  // -M 开启 rename 检测：重命名输出单行 R<score>\t旧路径\t新路径，只计新路径一次；
  // core.quotepath=false：中文/非 ASCII 路径原样输出，否则会被转义加引号导致统计失效
  log = execSync(
    `git -C ${JSON.stringify(repoRoot)} -c core.quotepath=false log --name-status -M --pretty=format:@%ad --date=short -- docs/`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch (err) {
  console.warn("[gen-contributions] git log 执行失败，将生成空数据：", err.message);
}

// 现存文件集合：输出前过滤已不存在的历史路径（如文件被移动/删除前最后一次修改的记录）
let tracked = new Set();
try {
  tracked = new Set(
    execSync(`git -C ${JSON.stringify(repoRoot)} -c core.quotepath=false ls-files -- docs/`, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean),
  );
} catch (err) {
  console.warn("[gen-contributions] git ls-files 执行失败，无法过滤已删除路径：", err.message);
}

const byDate = new Map();   // date -> 当日修改篇次（不去重）
const lastDate = new Map(); // file -> 最后提交日期（git log 按时间倒序，首次出现即最新）
let currentDate = null;
for (const raw of log.split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith("@")) {
    currentDate = line.slice(1);
    continue;
  }
  if (!currentDate) continue;
  // --name-status 行解析：R/C（rename/copy）为 "状态\t旧\t新"取末段；D 删除跳过；A/M 取路径
  const parts = line.split("\t");
  let file = "";
  if (parts.length >= 3 && "RC".includes(parts[0][0])) file = parts[parts.length - 1];
  else if (parts.length === 2) {
    if (parts[0] === "D") continue;
    file = parts[1];
  } else file = line;
  file = file.trim();
  if (!file.startsWith("docs/") || !file.endsWith(".md")) continue;
  byDate.set(currentDate, (byDate.get(currentDate) ?? 0) + 1);
  if (isContentDoc(file) && !lastDate.has(file)) lastDate.set(file, currentDate);
}

// 近 53 周（对齐周日）逐日填零，保证热力图网格完整；全程 UTC 计算避免时区偏移
const DAY = 86_400_000;
const now = new Date();
const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
const start = end - 371 * DAY;

const days = [];
for (let t = start; t <= end; t += DAY) {
  const key = new Date(t).toISOString().slice(0, 10);
  days.push({ date: key, count: byDate.get(key) ?? 0 });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  path.join(outDir, "contributions.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), days }, null, 2),
);

// 最后提交时间倒序输出，供更新记录页（ChangelogList）合并排序；
// 仅保留工作区仍存在的路径，避免历史移动/删除残留脏数据
const docs = [...lastDate.entries()]
  .filter(([file]) => tracked.has(file))
  .map(([file, date]) => ({ file, lastDate: date }))
  .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
writeFileSync(
  path.join(outDir, "docs-updates.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), docs }, null, 2),
);

const activeDays = days.filter(d => d.count > 0).length;
const totalEdits = days.reduce((sum, d) => sum + d.count, 0);
console.log(
  `[gen-contributions] 已写入 contributions.json（${activeDays} 个活跃日 / ${totalEdits} 篇次）与 docs-updates.json（${docs.length} 篇文档）`,
);
