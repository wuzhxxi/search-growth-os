# Website Technical Audit

Phase 2A 提供一套有界、只读、面向公开 HTTP(S) 网站的技术审计管线。它采集可验证的网络与静态页面事实，并输出带来源与时间的 Audit Run；它不是排名预测器、浏览器自动化工具或搜索引擎索引验证器。

## 命令

在 Node.js 22+ 环境中，从仓库根目录运行：

```bash
node scripts/search-growth.mjs audit technical https://example.com
node scripts/search-growth.mjs audit robots https://example.com
node scripts/search-growth.mjs audit sitemap https://example.com
node scripts/search-growth.mjs crawl https://example.com
```

安装/链接 package 后可把 `node scripts/search-growth.mjs` 替换为 `search-growth`。四个入口的范围如下：

- `audit technical`：按顺序运行根 URL HTTP/HTML、robots、sitemap 和 robots-aware crawl；若根请求不可用则停止后续步骤，若 robots 不能可靠取得则不启动 crawl。
- `audit robots`：取得并解析站点 `/robots.txt`，报告 sitemap 声明并对已知 crawler metadata/规则执行确定性评估。
- `audit sitemap`：从 robots 声明和默认 `/sitemap.xml` 发现 sitemap，解析 `urlset`/sitemap index 并有界遍历同源子 sitemap。
- `crawl`：先取得 robots，再执行同源、robots-aware 的静态技术 crawl。

默认输出 terminal summary；`--json` 输出完整、可机器读取的 Audit Run：

```bash
search-growth audit technical https://example.com --json
search-growth crawl https://example.com --max-pages 25 --concurrency 2 --json
```

可用选项：

| 选项 | 允许范围 | 说明 |
|---|---:|---|
| `--max-pages N` | 1–1,000 | crawler 页面数 |
| `--concurrency N` | 1–10 | crawler 并发请求 |
| `--timeout-ms N` | 100–60,000 | 单请求 timeout |
| `--max-redirects N` | 0–10 | 单请求 redirect hops |
| `--max-body-bytes N` | 1,024–5,242,880 | 单 response body；robots 仍受 512 KiB 硬上限 |
| `--max-sitemaps N` | 1–100 | sitemap 文档数 |
| `--max-sitemap-depth N` | 0–5 | sitemap index 嵌套深度 |
| `--max-sitemap-urls N` | 1–100,000 | 收集的 sitemap URL 数 |
| `--max-links-per-page N` | 1–500 | 每页进入调度候选的内部链接数 |

命令行只能在硬上限以内收紧或调整工作量，不能解除同源、SSRF、robots 或共享预算约束。

## 输出和状态

Audit Run 包含 run id、kind、timestamp、经净化的 target、实际 configuration、adapter versions、tool results、Evidence、Findings、errors 和 summary。Evidence 使用 `VERIFIED / PROVIDED / OBSERVED / INFERRED / HYPOTHESIS / UNKNOWN`；网络直接观测通常为 `OBSERVED`，缺少证据时保持 `UNKNOWN`。

Tool Adapter Result 的状态语义：

| 状态 | 含义 |
|---|---|
| `ok` | 在配置范围内完成且没有已知截断/子任务错误 |
| `partial` | 有可用结果，但发生截断、解析诊断或部分失败 |
| `UNKNOWN` | 没有足够证据，且不存在更精确的失败分类 |
| `unavailable` | 网络/依赖不可用或请求/字节预算耗尽 |
| `timeout` | DNS、请求或 Audit Run 时间预算到期 |
| `blocked` | SSRF、redirect、robots 或访问控制策略阻止 |
| `invalid` | 目标、配置或数据结构无效 |

错误保留 code、message、status、stage 与相关 context（如 URL/depth）。一个 `partial` 结果不能被解释为完整站点覆盖；一个 robots `allowed` 结果也不能推出已抓取、已索引、会排名或会被 AI 引用。

## 获取与解析边界

HTTP adapter 记录 requested/final URL、redirect chain、HTTP status、timing、精选 response headers、body bytes 与 SHA-256，并为 HTML 响应生成静态解析视图。解析视图可包括 title、meta description、canonical、robots meta、hreflang、JSON-LD 类型和同源链接。

raw response body 只可在同一次进程内以有界、不可枚举字段供下游 parser 使用；序列化 Audit Run 不包含 raw body。HTML parser 不执行 JavaScript、不等待 hydration、不操作 DOM、不模拟浏览器或 Googlebot，因此 client-rendered 内容可能不可见。canonical、robots、structured data 的存在也不证明搜索引擎接受或采用它们。

## 网络安全和跳转

- 输入必须是无 credentials 的绝对 `http:` / `https:` URL，最长 8,192 bytes；其他 scheme、URL userinfo、localhost 和非公网地址被拒绝。
- URL policy 覆盖 IPv4/IPv6 的 private、loopback、link-local、保留网段和已知 cloud metadata hostname。
- DNS 结果只要包含非公网地址就拒绝；连接固定到已验证地址，以减少 DNS rebinding 风险。
- 每个 redirect hop 都重新执行 URL、hostname、DNS、同源/robots（适用时）检查；检测循环、限制为 10 hops，并拒绝 HTTPS → HTTP 降级。
- redirect response body 不会作为普通页面缓冲；401、403、429 等访问控制响应不会扩展 crawl frontier；HTTP 429 还会停止当前 sitemap 队列或尚未启动的 technical audit 下游请求。
- 不登录、不提交表单、不绕过认证、WAF、CAPTCHA、paywall 或 anti-bot controls，不使用 stealth browser。

这些是纵深防护而非完全网络隔离；生产运行仍应配置受控 egress、最小权限和进程级资源限制。

## 资源预算

一次 Audit Run 的所有 adapter 共享以下硬预算：

- 1,500 个 HTTP 请求；
- 64 MiB 累计 response body；
- 5 分钟 wall-clock。

并发请求从同一预算预留字节和时间。预算耗尽会产生显式 `AUDIT_REQUEST_BUDGET_EXCEEDED`、`AUDIT_BYTE_BUDGET_EXCEEDED` 或 `AUDIT_DEADLINE_EXCEEDED`，不会继续扩张工作范围。单 response body 另有 5 MiB 硬上限。

子系统还具有独立上限：

| 子系统 | 硬上限 |
|---|---|
| robots | 512 KiB body；directive、pattern、target 长度和匹配步骤均有界 |
| sitemap | 同源；100 documents；depth 5；100,000 URLs；16 MiB 聚合 URL 字符串；单文档 5 MiB |
| crawler | 同源；1,000 pages；concurrency 10；500 links/page；50,000 discovered occurrences；8 MiB retained link strings |
| Audit Run | 最多 500 findings；parser diagnostics、样本和输出数组另有上限 |

达到上限会通过 `partial` 和/或 error 记录，不应把结果描述为全站穷举。

## robots、sitemap 与 crawler 语义

robots parser 根据明确 User-Agent/path 评估 `Allow`/`Disallow`，支持 percent-normalization 与有界 wildcard 匹配。无法可靠获取或解析 robots policy 时 crawler fail closed。`robots.txt` 是抓取指令，不是索引、排名、Google AI feature 或引用保证；`Google-Extended` 也不是 Google Search 排名/索引开关。

默认 crawler identity 刻意拆成两个配置字段：`user_agent` 是实际发送的完整 HTTP identification string（默认 `SearchGrowthOS/0.2.0 (...)`），`robots_product_token` 是仅用于 REP group selection 的精确 product token（默认 `SearchGrowthOS`）。更改 `user_agent` 不会隐式推导或更改 robots 身份；程序化调用若要使用自定义身份，必须显式设置 `robots_product_token`。该 token 必须是 1–512 个 ASCII 字母、下划线或连字符；包含版本斜杠、空格、括号或注释的完整 HTTP User-Agent 会在任何 adapter 请求发出前被拒绝。直接 URL 与每个 redirect target 都使用同一个 product token 重新评估 robots policy。

sitemap adapter 只遍历与目标 origin 相同的 sitemap。跨域 sitemap 声明或子 sitemap 会被拒绝/记录而不会获取；这可能与某些真实部署方式不同，是 Phase 2A 的安全限制。sitemap 中列出的 URL 是声明证据，不等于已抓取或已索引。

crawler 只调度同源 URL，每个候选与 redirect target 都重新执行 robots policy。它只从成功取得的静态 HTML 扩展 frontier。sitemap URL 未在本次有界 crawl 中出现时，只能形成范围受限、低置信度的 orphan candidate，不能断言绝对 orphan。

## 数据与隐私

序列化前会移除 URL userinfo，并净化常见敏感 query 参数。操作者仍不得把 API key、secret、OAuth/session token、客户 PII 或其他敏感数据放进 target URL、query 或 CLI 配置。公开页面本身可能含有站点公开的数据；请在运行前确认审计授权、robots/服务条款以及适用的数据处理要求。

Phase 2A 不需要 API key，也不采集 Google Search Console 或 GA4。需要 OAuth 的第一方 performance 数据、server/CDN log ingestion，以及相应的凭据和保留策略，留到 Phase 2B。

## 已知限制

- 只处理公开、无需登录的 HTTP(S) 资源和静态响应；无浏览器渲染、截图或 JavaScript execution。
- 不绕过访问控制，也不保证 WAF/CDN 对本工具 User-Agent 的行为与搜索引擎一致。
- sitemap traversal 采用同源限制，可能遗漏专用 sitemap host/CDN 上的合法 sitemap。
- 有界 crawl 不是全站爬虫；大站和高分支站点会得到抽样/截断结果。
- 技术 Evidence 不能量化流量或收入影响；没有 GSC/GA4 时相关结论保持 `UNKNOWN`。
