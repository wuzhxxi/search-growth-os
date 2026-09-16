# Search Growth OS

> **Google-first Search Growth operating system：SEO · AEO · GEO · Agentic Search · Measurement**

Search Growth OS 是一个独立、证据驱动的搜索增长项目，用统一的 Agent、Schema、Eval、CLI 和 CI，把 **Google 技术可达性 → 自然搜索可见性 → AI 搜索可见性 → 任务完成 → 转化/收入** 串成一套可执行系统。

Phase 2A 已加入面向真实公开网站的 Tool Adapter Foundation 与 Website Technical Audit：系统现在可以采集 HTTP、HTML、`robots.txt`、sitemap 和同源 crawl 证据，生成保留来源的 Audit Run。它不会从这些技术事实直接推断排名、AI 引用、流量或转化提升。

> 本项目是独立开源项目，与 Google 无隶属或官方背书关系。

## 当前范围

当前实现包括：

- 五个经过人工方法论 Review 的核心 Search Growth Agent；Phase 2A **没有修改或重新设计 `agents/`**。
- 统一 Tool Adapter 结果：adapter 身份与版本、能力、输入、结构化输出、Evidence、观测时间、明确状态与错误。
- 公开 HTTP(S) 网站检查：状态、跳转、精选响应头、HTML metadata、结构化数据是否存在及同源内部链接。
- `robots.txt` 获取、解析、sitemap 声明发现与 crawler/path 规则评估。
- `/sitemap.xml` 与 robots 声明 sitemap 的发现、`urlset` / sitemap index 解析及有界嵌套遍历。
- 尊重 robots、仅同源、小规模且可配置的技术 crawler。
- Evidence → Finding → Audit Run → terminal / JSON 输出。

Phase 2A 不包含 Google Search Console 或 GA4；需要 OAuth 的第一方绩效数据留到 Phase 2B。它也不抓取 Google SERP、AI Overviews / AI Mode，不接 OpenAI、Claude 或 Gemini API，不需要 API key。

**不会把 `Google-Extended` 当成 Google Search 排名或索引开关，也不会把 `llms.txt` 当成 Google AI Search 的必需项。`robots.txt` 的 Allow 结果也不等于抓取、索引、排名、答案收录或引用保证。**

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

## 快速开始

需要 Node.js 22+。在仓库 checkout 中可直接运行：

```bash
node scripts/search-growth.mjs audit technical https://example.com
node scripts/search-growth.mjs audit robots https://example.com
node scripts/search-growth.mjs audit sitemap https://example.com
node scripts/search-growth.mjs crawl https://example.com
```

如果已把 package 的 CLI 链接为 `search-growth`，等价命令是：

```bash
search-growth audit technical https://example.com
search-growth audit robots https://example.com
search-growth audit sitemap https://example.com
search-growth crawl https://example.com
```

默认输出便于阅读的 terminal summary；追加 `--json` 可取得完整、可机器读取的 Audit Run，例如：

```bash
search-growth audit technical https://example.com --json
search-growth crawl https://example.com --max-pages 25 --concurrency 2 --json
```

运行 `search-growth audit --help` 查看全部有界配置。执行前请确认你有权审计目标，并避免对不属于你的站点提高默认负载。完整用法、数据边界和限制见 [`docs/technical-audit.md`](docs/technical-audit.md)。

## 数据与结论边界

```text
Public URL
   → HTTP / robots / sitemap / crawler adapters
   → versioned Tool Adapter Results
   → provenance-preserving Evidence
   → deterministic technical Findings
   → timestamped Audit Run
   → terminal summary or complete JSON
```

HTTP adapter 记录请求 URL、最终 URL、redirect chain、状态、耗时、精选 header、body 字节数与 hash，并生成独立的静态 HTML 解析视图。为供同一次运行内的下游 parser 使用，adapter 可在内存中暴露有界且不可枚举的 raw body；序列化后的 Audit Run **不包含 raw response body**。失败会显式返回 `UNKNOWN`、`unavailable`、`timeout`、`blocked` 或 `invalid`，不会由模型补齐。

直接观察到的 `404` 可以成为 `OBSERVED` Evidence；没有 Search Console / GA4 数据时，“造成了多少流量损失”仍是 `UNKNOWN`。sitemap 中出现但未在本次有界 crawl 中发现的 URL，只会标记为低置信度、范围受限的 orphan candidate，不会断言为绝对 orphan。

## 安全与礼貌边界

- 只接受不含 URL credentials 的绝对 `http:` / `https:` 目标；阻止 `file:` 等其他 scheme。
- 阻止 localhost、私有/loopback/link-local/保留地址和已知 cloud metadata hostname；DNS 返回中只要出现非公网地址即拒绝。
- 每个 redirect hop 都重新校验、重新解析 DNS 并把连接固定到已检查地址，限制跳转并检测循环。
- 阻止 HTTPS 降级到 HTTP；robots、sitemap 与 crawler 的跳转和调度继续执行各自的同源/策略检查。
- 单响应最多 5 MiB；每个 Audit Run 共享最多 1,500 个请求、64 MiB 响应数据和 5 分钟 wall-clock 预算。
- robots body 最多 512 KiB；sitemap 最多 100 个文档、5 层、100,000 个 URL 和 16 MiB URL 字符串，且只遍历与目标同源的 sitemap。
- crawler 最多 1,000 页、并发 10、每页 500 个链接，同时限制为 50,000 个发现项和 8 MiB 保留链接字符串。
- crawler 的 HTTP 请求使用完整、可识别的 User-Agent，而 robots group selection 使用独立的精确 product token；只调度同源链接并对候选和跳转目标执行 robots 规则，无法可靠取得规则时不会继续 crawl。
- 不登录，不绕过认证、WAF、CAPTCHA、paywall 或 anti-bot controls，不使用 stealth browser，不修改目标网站。
- URL userinfo 和常见敏感 query 参数会在可序列化记录中净化；调用者仍不应把 secret、token、客户 PII 或其他敏感信息放进目标 URL。

解析仅针对已取得的静态 HTML，不执行 JavaScript，也不等同于浏览器渲染、Googlebot 渲染或索引验证。这是一套 SSRF 防护与资源上限，不是对任意不可信网络环境的完整隔离。运行者仍应使用适当的网络出口策略和最小权限环境。

## 五个核心 Agent

| Agent | 负责什么 |
|---|---|
| `agents/aeo-foundations.md` | 技术可达性、Googlebot、robots/noindex、渲染、WAF/CDN、日志 |
| `agents/seo-specialist.md` | Google Search 需求、意图、内容架构、排名机会、自然转化 |
| `agents/geo-strategist.md` | Google AI Search 的 Mention / Recommendation / Citation / Source |
| `agents/agentic-search-optimizer.md` | 搜索发现后的任务完成、状态验证、安全与 fallback |
| `agents/orchestrator.md` | 路由、证据归一、去重、优先级和统一 Roadmap |

Phase 2A 的 adapter 和确定性 finding 规则为这些方法论提供技术证据基础；它们不替代或改写 Agent 的职责边界。

## 证据协议

任何重要发现必须使用：

`VERIFIED / PROVIDED / OBSERVED / INFERRED / HYPOTHESIS / UNKNOWN`

没有证据时不能把假设写成事实，也不能制造固定 uplift、行业平均值或保证提升。每个 Audit Run 都保留 timestamp、target、configuration、adapter version、完整 tool result、Evidence provenance、Finding、错误和 summary。

## 验证与 CI

```bash
npm test
npm run validate
npm run agents
npm run evals
```

`npm test` 使用 Node 内置 test runner 运行 Phase 1 回归测试以及 adapter、crawler、Audit Run 与安全测试。测试使用确定性 fixture / mock，不依赖公网。GitHub Actions 在 push / pull request 上使用 Node.js 22 运行 `npm test` 和 `npm run validate`，不需要 secrets。

`evals` 中的案例默认是 `pending`。静态验证通过不代表 LLM 行为测试已经通过。

## Repo Structure

```text
agents/              五个 protected Search Growth Agent 方法论
lib/core/            统一 Tool Adapter result contract
lib/http/            公网 HTTP(S) 获取与静态 HTML metadata 解析
lib/security/        URL、地址、DNS pinning 与 SSRF policy
lib/robots/          robots adapter、parser 与可变 crawler registry
lib/sitemap/         sitemap discovery、parser 与有界遍历
lib/crawler/         同源、有界、robots-aware 技术 crawler
lib/audit/           Audit Run、Evidence→Finding 和输出格式
lib/cli/             audit CLI 参数与安全范围
schemas/             Evidence / Finding / AuditRun / Adapter 等 contracts
evals/               人工/LLM 评测案例与 manifest
search-growth/       Agent Registry
scripts/             Search Growth CLI
tests/               确定性回归、adapter、crawler 与安全测试
docs/                架构、技术审计用法与阶段规划
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

**Phase 2A — Tool Adapter Foundation & Website Technical Audit**

- 公网 HTTP / HTML、robots、sitemap adapters
- SSRF policy、DNS pinning 与有界获取
- 同源、robots-aware crawler
- Evidence / Finding 映射与 Audit Run
- terminal / JSON CLI

**Phase 2B — Authenticated First-party Data**

- Google Search Console
- GA4
- server/CDN log ingestion
- provider credentials、权限与数据保留策略

**Later measurement and delivery**

- Google AI Search prompt-run provider interface（不依赖未经授权的 SERP / AI surface scraping）
- workspace、audit report、prioritized roadmap 与持续 measurement

## License / Attribution

MIT. See `LICENSE` and `ATTRIBUTION.md`.
