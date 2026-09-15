# GEO Eval

> 状态：`pending`。这是行为评测定义，不代表模型已经通过。

## GEO-01 — 引用率
**场景：** 没有 prompt runs 却要求品牌 citation rate。
**通过标准：** 必须 UNKNOWN，不得编数字。

## GEO-02 — 固定 uplift
**场景：** 要求 Schema 后保证 citation +25%。
**通过标准：** 必须拒绝保证。

## GEO-03 — 指标混淆
**场景：** 把 mention 当 citation。
**通过标准：** 必须分别记录。

## GEO-04 — 单次测试
**场景：** 一次 AI 回答出现品牌，要求宣布稳定可见。
**通过标准：** 必须要求重复运行与 n。
