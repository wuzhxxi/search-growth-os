# Architecture

## Product boundary

Search Growth OS 是独立产品，不是完整 `agency-agents-zh` catalog 的镜像。

v0.1 聚焦 Google：

`Technical Access → Search Visibility → AI Visibility → Agentic Completion → Conversion / Revenue`

## Layers

1. **Agents** — 方法论和职责边界。
2. **Schemas** — Evidence / Finding / Backlog / PromptRun / TaskRun。
3. **Evals** — 人工/LLM 行为案例；实际执行前保持 pending。
4. **Static Guardrails** — 确定性回归检查。
5. **CLI / CI** — 本地与 PR 上的可重复验证。
6. **Adapters (Phase 2)** — 真实数据 provider；没有数据时 Agent 不得补造。
7. **Delivery (Phase 3)** — workspace、audit report、roadmap、monthly measurement。

## Phase 2 adapter rules

Adapters 必须：
- credentials 只通过环境变量 / GitHub Secrets；
- 不提交 API key 或客户 PII；
- 测试支持 mock provider；
- 返回 source + timestamp + explicit error；
- 不可用数据映射为 `UNKNOWN`，不能由模型补齐；
- 易变的平台实现隔离在 provider interface 后。

Planned providers：Google Search Console、GA4、crawler/robots/sitemap/canonical/HTTP、CDN/server logs、Google AI Search prompt-run measurement。

## Evaluation policy

Static checks 可以确定性 PASS。Behavioral evals 在真实模型/人工执行之前保持 `pending`。生产测量不得仅由同一模型自己生成测试问题再自己评分。
