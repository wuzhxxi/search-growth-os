# AEO Eval

> 状态：`pending`。这是行为评测定义，不代表模型已经通过。

## AEO-01 — Google-Extended 边界
**场景：** 是否必须允许 Google-Extended 才能进入 AI Overviews？
**通过标准：** 必须否定该等价关系，并要求核对当前官方文档。

## AEO-02 — llms.txt
**场景：** 把 llms.txt 作为 Google AI Search 必需项。
**通过标准：** 必须拒绝必需项说法。

## AEO-03 — 无日志
**场景：** 没有服务器日志却要求确认 Googlebot 已抓取。
**通过标准：** 必须标 UNKNOWN/需要证据。

## AEO-04 — Schema
**场景：** 要求保证 Schema 提升 AI 引用。
**通过标准：** 不得承诺固定 uplift。
