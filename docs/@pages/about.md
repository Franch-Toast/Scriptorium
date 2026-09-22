---
title: 关于我
permalink: /about
layout: page
article: false
sidebar: false
---

<div class="about-page">

## ✨ 你好，很高兴认识你 👋

<p class="about-hello">Hi！</p>

<p class="about-id">我叫 <strong class="about-name">L0nelyCache</strong>，AKA</p>

<div class="about-tags">
<span>屎山代码制造机</span>
<span>躺平艺术爱好者</span>
<span>濒危发量守门员</span>
</div>

<p class="about-sub">尘世中一个从能源动力专业转行来的迷途小菜鸡，什么都不会，什么都想学~</p>

## 🚶🏻‍♂️ 一路走来

<div class="about-timeline">

2015.9 - 2018.6 在 **安徽省宿松中学** 当精神小伙

2018.9 - 2022.6 在 **江苏大学（能源与动力工程专业）** 当锅炉工

2022.9 - 2025.3 在 **浙江大学（能源动力）** 一边装汽车空调一边转码

2025.4 - 至今 在 **深圳元戎启行（系统平台软件开发工程师）** 做小弟

</div>

<div class="about-musing">
<p>❓ 未来去哪呢……</p>
<p>🛌 是摆烂还是躺平呢……</p>
<p>🤔 好纠结啊（bushi）</p>
</div>

## 🤷‍♂️ 为什么写博客

和朋友时常感叹，感觉自己的反应力和记忆力与高中相比差远了，简直是难以望其项背。很多时候难以集中精力做一件事、看一段文字，即使看了，很快就会忘记。所以我想学习高中，记录点什么。

写博客不仅是主动对记忆进行加深和留存，也是对自己的敦促。希望自己能无限进步，多年以后回首无愧于心。（btw，我本来就是一个喜欢逼逼叨叨的人哈哈哈哈哈。）

在博客中记录我的学习，记录我的生活，记录我的思考。

<p class="about-ps">ps：🤪 上面都是假的，你不会信了吧（bushi），其实是为了装B……</p>

## 💻 我会些什么？

<div class="about-skills">
<div class="about-skills-bar"><span class="about-dot about-dot-r"></span><span class="about-dot about-dot-y"></span><span class="about-dot about-dot-g"></span><span class="about-skills-title">L0nelyCache@scriptorium:~</span></div>
<div class="about-skills-body">

大放厥词 ██████████ 100% 

修空调  ██████░░░░ 60%  ← 嗯，所以这才是老本行

烧锅炉  ██████░░░░ 60%

热流体仿真  ██████░░░░ 60%

Linux  ██░░░░░░░░ 20%  ← 还在踩坑，努力学习ing

嵌入式  █████░░░░░ 50%  ← 稍微了解一些

C/C++  ██░░░░░░░░ 20% 

Python ██░░░░░░░░ 20%  ← 能跑就行

AI     ░░░░░░░░░█ -10% ← 完全不懂

</div>
</div>

## 😈 看完了想找地方骂我？

### How to Contact me?

<a class="about-contact" href="mailto:random996@163.com">📬️ Email：random996@163.com</a>

</div>

<style scoped>
/*
 * 排版基准借鉴站内文档页渲染（vp-doc：24px 标题 / 48px 节奏 / 1.7 行高 / 代码块壳），
 * 个人页在其上做名片式精修：标题分隔语言居中化、正文行距放宽、
 * 称号徽章 / 时间线 / 终端窗口 / 胶囊按钮四种质感与正文形成节奏。
 */
.about-page {
  max-width: 720px;
  margin: 0 auto;
  font-size: 16px;
}

.about-page p {
  line-height: 1.85;
}

/* 分节标题：继承文档页 24px 与负字距，分隔语言从 border-top 改为居中渐变短线 */
.about-page h2 {
  margin: 56px 0 24px;
  padding-top: 0;
  border-top: none;
  text-align: center;
  letter-spacing: -0.02em;
  font-size: 20px;
}

.about-page h2::after {
  content: "";
  display: block;
  width: 44px;
  height: 3px;
  margin: 12px auto 0;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
}

.about-page h2:first-child {
  margin-top: 12px;
}

.about-page h3 {
  margin: 28px 0 0;
  text-align: center;
  font-size: 17px;
  color: var(--vp-c-text-2);
  letter-spacing: -0.01em;
}

/* —— 名片头：渐变问候 + 名字强调 + 称号徽章 —— */
.about-hello {
  width: fit-content;
  margin: 8px auto 4px;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(120deg, var(--vp-c-brand-1), var(--vp-c-brand-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.about-id {
  margin: 0 0 14px;
  text-align: center;
}

.about-name {
  color: var(--vp-c-brand-1);
  font-size: 18px;
}

.about-tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 0 0 18px;
}

.about-tags span {
  padding: 4px 14px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 13px;
  font-weight: 500;
}

.about-sub {
  margin: 0 0 8px;
  text-align: center;
  font-size: 14px;
  color: var(--vp-c-text-3);
}

/* —— 时间线：贯穿竖线 + 光晕圆点（呼应站内归档时间线语言）—— */
.about-timeline {
  position: relative;
  margin: 8px 0 0;
  padding: 2px 0;
}

.about-timeline::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 16px;
  bottom: 16px;
  width: 1px;
  background: var(--vp-c-divider);
}

.about-timeline p {
  position: relative;
  margin: 0 0 18px;
  padding-left: 24px;
  font-size: 15px;
}

.about-timeline p:last-child {
  margin-bottom: 0;
}

.about-timeline p::before {
  content: "";
  position: absolute;
  left: 0;
  top: 9px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px var(--vp-c-brand-soft);
}

/* —— 碎碎念：虚线便签 —— */
.about-musing {
  margin: 24px 0 0;
  padding: 14px 16px;
  border: 1px dashed var(--vp-c-divider);
  border-radius: 10px;
}

.about-musing p {
  margin: 0 0 6px;
  text-align: center;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.about-musing p:last-child {
  margin-bottom: 0;
}

/* —— ps 彩蛋行 —— */
.about-ps {
  margin: 20px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--vp-c-text-3);
}

/* —— 技能终端：借鉴站内代码块的圆角卡片壳 + mac 窗口头 —— */
.about-skills {
  margin: 8px 0 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  overflow: hidden;
}

.about-skills-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
}

.about-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.about-dot-r {
  background: #ff5f57;
}

.about-dot-y {
  background: #febc2e;
}

.about-dot-g {
  background: #28c840;
}

.about-skills-title {
  margin-left: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.about-skills-body {
  padding: 14px 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
  font-size: 13px;
  overflow-x: auto;
}

.about-skills-body p {
  margin: 0 0 4px;
  line-height: 1.9;
}

.about-skills-body p:last-child {
  margin-bottom: 0;
}

/* —— 联系方式：胶囊按钮（mailto 直达）—— */
.about-contact {
  display: block;
  width: fit-content;
  margin: 28px auto 8px;
  padding: 11px 26px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  transition: background-color 0.25s, color 0.25s, transform 0.2s;
}

.about-contact:hover {
  background: var(--vp-c-brand-1);
  color: #fff;
  transform: translateY(-1px);
  text-decoration: none;
}
</style>
