# Architecture

## 产品边界

Search Growth OS 是独立产品，不是完整 `agency-agents-zh` catalog 的镜像。它沿用以下增长链路，但 Phase 2A 只提供链路最前端的公开网站技术证据：

`Technical Access → Search Visibility → AI Visibility → Agentic Completion → Conversion / Revenue`

HTTP 状态、robots 规则或静态 HTML metadata 不能单独证明索引、排名、AI 引用、流量、转化或收入变化。Google Search Console、GA4 和其他需要认证的第一方数据属于 Phase 2B。

## 分层

1. **Agents** — 受保护的方法论与职责边界；Phase 2A 不重写 `agents/`。
2. **Schemas** — Evidence、Finding、Audit Run 与 Tool Adapter Result 的版本化 contract。
3. **Tool Adapters** — HTTP/HTML、robots、sitemap 和 crawler 的确定性采集与解析。
4. **Audit orchestration** — 共享预算、adapter 编排、Evidence → Finding 映射、去重与有界输出。
5. **CLI / formatters** — terminal summary 与完整 JSON Audit Run。
6. **Evals / guardrails / CI** — mock/fixture 驱动的离线测试、静态回归和 PR 验证。
7. **Delivery（后续）** — workspace、审计报告、roadmap 与持续 measurement。

```text
Public credential-free HTTP(S) URL
              ↓
URL policy → DNS validation/pinning → bounded HTTP
              ↓
static HTML / robots / same-origin sitemap / same-origin crawl
              ↓
versioned Tool Adapter Results + provenance-preserving Evidence
              ↓
deterministic Findings → sanitized, timestamped Audit Run
              ↓
terminal summary / JSON
```

## Phase 2A adapter contract

每个 adapter result 包含 adapter identity/version、capabilities、输入、结构化输出、Evidence、`observed_at`、状态和显式错误。公共状态为：

- `ok`：请求与解析在所选范围内完成。
- `partial`：仍有可用观测，但遇到截断、解析问题或部分子任务失败。
- `UNKNOWN`：没有足够证据判断，且不能安全归入更具体的失败类型。
- `unavailable`：依赖、网络或运行预算不可用/耗尽。
- `timeout`：DNS、请求或 Audit Run 时间预算到期。
- `blocked`：安全策略、robots 或访问控制阻止操作。
- `invalid`：输入、配置或返回结构不满足 contract。

错误通过稳定 code、message、status 和 stage/context（适用时）表达。失败不会被模型补造为成功结果。直接网络观测通常成为 `OBSERVED` Evidence；无数据保持 `UNKNOWN`。

HTTP adapter 可在一次运行的内存对象中提供有界、不可枚举的 raw body，供 HTML/robots/sitemap parser 消费。序列化 Audit Run 只保留结构化结果、精选 headers、字节数、hash、provenance、错误与 findings，**不包含 raw response body**。

## 信任边界与资源上限

- 只接受无 URL credentials 的绝对 `http:` / `https:` URL，长度上限 8,192 bytes。
- URL policy 阻止 localhost、私有、loopback、link-local、保留地址与已知 cloud metadata host。
- 每个 redirect hop 重新执行 URL 与 DNS 检查；连接固定到已验证的公网地址，检测循环，最多 10 次跳转，并拒绝 HTTPS → HTTP 降级。
- robots、sitemap 和 crawler 在 HTTP 层之上继续检查自己的同源和策略约束；不能可靠取得 robots 时 crawler fail closed。
- 单 HTTP response body 硬上限 5 MiB。一次 Audit Run 共享最多 1,500 个请求、64 MiB response bytes 与 5 分钟 wall-clock；并发请求共同预留/消耗这份预算。
- robots body 最多 512 KiB，并限制 directive、规则长度与匹配步骤；robots `Allow` 仅表示该 parser 对指定 User-Agent/path 的规则评估结果。
- sitemap 只遍历与目标同源的文档，最多 100 个 sitemap、5 层、100,000 个 URL、16 MiB 聚合 URL 字符串；单文档最多 5 MiB。
- crawler 只调度同源 URL，最多 1,000 页、并发 10、每页 500 个链接、50,000 个发现项和 8 MiB 保留链接字符串；每次请求及跳转目标都重新执行 robots 检查。
- 401、403、429 等访问控制响应不会被用来扩展 crawl frontier。
- Audit Run findings 最多 500 条；parser diagnostics、样本和数组也有独立上限，触顶时返回 partial/error，而不是静默宣称完整。

这些限制是默认实现的安全边界，而不是任意不可信网络的完整隔离。生产部署仍应使用最小权限、受控网络出口和独立的运行时防护。

## 数据处理与能力限制

Phase 2A 读取公开网页，不登录、不提交表单、不绕过认证、WAF、CAPTCHA、paywall 或 anti-bot controls，也不修改目标站点。HTML parser 只分析响应中的静态 markup，不执行 JavaScript，不模拟浏览器，不代表 Googlebot 渲染，也不验证搜索引擎索引状态。

目标 URL 的 userinfo 与常见敏感 query 参数会在可序列化记录中净化；raw body 不进入 Audit Run。公开页面内容本身仍可能包含站点发布的数据，因此操作者必须确认审计授权与数据处理要求，并且不得把 API key、secret、session token、客户 PII 等放入目标 URL 或配置。

## 后续 provider 规划

Phase 2B 才引入 Google Search Console、GA4、server/CDN logs 等认证的第一方数据，并单独设计 OAuth、权限、凭据与数据保留策略。Google AI Search prompt-run measurement 若在后续加入，也应位于可替换的 provider interface 后，不依赖未经授权的 SERP 或 AI surface scraping。

## Evaluation policy

Static checks 可以确定性 PASS。adapter、crawler 与安全测试使用 mock/fixture，不依赖公网。Behavioral evals 在真实模型/人工执行之前保持 `pending`；生产测量不得仅由同一模型自己生成测试问题再自己评分。
