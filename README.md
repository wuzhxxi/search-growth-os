# Search Growth OS

> **Google-first Search Growth operating system：SEO · AEO · GEO · Agentic Search · Measurement**

Search Growth OS 是一个独立、证据驱动的搜索增长项目，用统一的 Agent、Schema、Eval、CLI 和 CI，把 **Google 技术可达性 → 自然搜索可见性 → AI 搜索可见性 → 任务完成 → 转化/收入** 串成一套可执行系统。

> 本项目是独立开源项目，与 Google 无隶属或官方背书关系。

## 当前范围

v0.1 专注 Google 生态：

- Google Search：抓取、索引、搜索需求、排名机会、内容与转化
- Google AI Search：AI Overviews / AI Mode 等生成式搜索表面的可见性与来源分析
- Google Search Console：Phase 2 接入
- GA4：Phase 2 接入
- crawl / robots.txt / sitemap / canonical / status / rendering：Phase 2 接入
- Google-first GEO prompt measurement：Phase 2 接入
- Agentic task completion：验证从搜索发现到站内任务完成的可执行性与安全性

**不会把 `Google-Extended` 当成 Google Search 排名开关，也不会把 `llms.txt` 当成 Google AI Search 的必需项。**

## Growth Model

```text
Technical Access
      ↓
Search Visibility
      ↓
AI Visibility
      ↓
Agentic Completion
      ↓
Conversion / Revenue
```

## 五个核心 Agent

| Agent | 负责什么 |
|---|---|
| `agents/aeo-foundations.md` | 技术可达性、Googlebot、robots/noindex、渲染、WAF/CDN、日志 |
| `agents/seo-specialist.md` | Google Search 需求、意图、内容架构、排名机会、自然转化 |
| `agents/geo-strategist.md` | Google AI Search 的 Mention / Recommendation / Citation / Source |
| `agents/agentic-search-optimizer.md` | 搜索发现后的任务完成、状态验证、安全与 fallback |
| `agents/orchestrator.md` | 路由、证据归一、去重、优先级和统一 Roadmap |

## 证据协议

任何重要发现必须使用：

`VERIFIED / PROVIDED / OBSERVED / INFERRED / HYPOTHESIS / UNKNOWN`

没有证据时不能把假设写成事实，也不能制造固定 uplift、行业平均值或保证提升。

## 快速验证

需要 Node.js 22+：

```bash
npm test
npm run validate
npm run agents
npm run evals
```

`evals` 中的案例默认是 `pending`。静态验证通过不代表 LLM 行为测试已经通过。

## Repo Structure

```text
agents/              五个核心 Search Growth Agent
schemas/             Evidence / Finding / Backlog / PromptRun / TaskRun
evals/               人工/LLM 评测案例与 manifest
search-growth/       Agent Registry
scripts/             Search Growth CLI
tests/               确定性回归测试
docs/                架构与阶段规划
.github/workflows/    PR / push 自动验证
```

## 路线图

**Phase 1 — Standalone Foundation**
- 独立产品仓
- 5 个核心 Agent
- shared schemas
- static regression guardrails
- eval manifest
- CLI + tests + CI

**Phase 2 — Real Tool Adapters**
- Google Search Console
- GA4
- crawler / robots / sitemap / canonical / HTTP
- server/CDN log ingestion
- Google AI Search prompt-run provider interface

**Phase 3 — Delivery**
- `audit foundation`
- `audit seo`
- `audit geo`
- `audit full`
- client workspace
- Markdown / JSON reports
- prioritized 90-day roadmap
- monthly measurement

## License / Attribution

MIT. See `LICENSE` and `ATTRIBUTION.md`.
