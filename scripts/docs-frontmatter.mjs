import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const defaultDocsRoot = path.join(repoRoot, "docs", "document");
const allowedLibraries = new Set(["撷简台", "撰修司", "正典阁", "纪事寮", "资简库", "秘藏龛"]);

function parseArgs(argv) {
  const options = { check: false, dryRun: false, root: defaultDocsRoot };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--root") {
      const root = argv[i + 1];
      if (!root) throw new Error("--root 需要一个目录参数");
      options.root = path.resolve(root);
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function listMarkdownFiles(root) {
  if (!existsSync(root)) throw new Error(`文档目录不存在：${root}`);
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") files.push(file);
    }
  };
  visit(root);
  return files;
}

function detectNewline(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function frontmatterState(content) {
  const firstLine = content.match(/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/);
  if (!firstLine) return "missing";

  const rest = content.slice(firstLine[0].length);
  if (/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.test(rest)) return "present";
  return "malformed";
}

function cleanInlineMarkdown(value) {
  return value
    .replace(/!??\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferTitle(content, fallback) {
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1];
  return cleanInlineMarkdown(heading || fallback);
}

function inferDescription(content) {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex(line => /^#\s+/.test(line));
  const body = lines.slice(headingIndex >= 0 ? headingIndex + 1 : 0);
  const paragraph = [];

  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,6}\s|^```|^~~~|^[-*+]\s|^\d+[.)]\s|^\|/.test(trimmed)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(trimmed);
  }

  const description = cleanInlineMarkdown(paragraph.join(" "));
  return description ? `${description.slice(0, 160)}${description.length > 160 ? "..." : ""}` : "";
}

function yamlString(value) {
  return JSON.stringify(value);
}

function buildFrontmatter({ title, date, description, category }, newline) {
  const lines = ["---", `title: ${yamlString(title)}`, `date: ${date}`];
  if (description) lines.push(`description: ${yamlString(description)}`);
  lines.push("categories:", `  - ${yamlString(category)}`, "tags: []", "---", "");
  return lines.join(newline) + newline;
}

function processFile(file, docsRoot, options) {
  const content = readFileSync(file, "utf8");
  const state = frontmatterState(content);
  const relative = path.relative(docsRoot, file);

  if (state === "present") return { status: "skipped", file: relative };
  if (state === "malformed") throw new Error(`frontmatter 格式不完整，未修改：${file}`);

  const library = relative.split(path.sep)[0];
  if (!allowedLibraries.has(library)) {
    throw new Error(`文档不属于六大分区，无法推导 categories：${file}`);
  }

  const newline = detectNewline(content);
  const filename = path.basename(file, ".md");
  const title = inferTitle(content, filename);
  const description = inferDescription(content);
  const date = new Date().toISOString().slice(0, 10);
  const block = buildFrontmatter({ title, date, description, category: library }, newline);
  const body = content.replace(/^(?:\r?\n)+/, "");

  if (!options.check && !options.dryRun) writeFileSync(file, block + body, "utf8");
  return { status: options.check ? "missing" : options.dryRun ? "preview" : "updated", file: relative, title };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = listMarkdownFiles(options.root);
  const results = files.map(file => processFile(file, options.root, options));
  const missing = results.filter(result => result.status === "missing");
  const changed = results.filter(result => ["updated", "preview", "missing"].includes(result.status));

  for (const result of changed) {
    const suffix = result.title ? ` -> ${result.title}` : "";
    console.log(`${options.check ? "缺少 frontmatter" : options.dryRun ? "预览" : "已补充"}: ${result.file}${suffix}`);
  }

  const skipped = results.filter(result => result.status === "skipped").length;
  console.log(`检查完成：${files.length} 个普通文档，${skipped} 个已有 frontmatter，${changed.length} 个待处理。`);
  if (options.check && missing.length) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[docs:frontmatter] ${error.message}`);
  process.exitCode = 1;
}
