# Dofollow / Rel Notes

用途：沉淀 V3 对 dofollow / nofollow / ugc / sponsored 的实测口径。

## 核心原则

1. dofollow 是实测结论，不是平台传说
- 旧数据库、旧名单、旧印象、别人文章里写的“dofollow 平台”都不能直接信
- 每次提交后，优先以当前 live page 的 rel 实测为准

2. 先验证链接存在，再谈 rel
- 没有 target link，就不存在 dofollow 问题
- `COMMENT_PUBLISHED_NO_LINK` / `ARTICLE_PUBLISHED_NO_LINK` 这类状态比 rel 更优先

3. rel 是当前时点的证据，不是永久承诺
- 平台会改主题、插件、出站策略、审核逻辑
- 因此 rel 结果应视为“本次实测”而不是永恒真理

## 最小实测字段

提交后至少记录：
- live_page_url
- target_link_url
- anchor_text
- rel
- rel flags（如 `ugc` / `nofollow` / `sponsored`）
- visibility（visible / hidden / missing）

## 常见 surface 的 rel 观察

### 1. Directory
- 目录站的 thank-you / pending 页面不等于最终 live outbound link
- 若已明确 business success，仍可在后续复核 live page rel

### 2. Forum profile
- website / signature / about me 区域常会被主题或插件加 `nofollow` / `ugc`
- 必须直接看 public profile 页，而不是编辑页 DOM

### 3. WP comment
- 评论区经常出现三种情况：
  - comment 未公开
  - comment 公开但链接被清洗
  - comment 公开且链接存在但带 `nofollow/ugc`
- 所以 comment family 必须先看 live，再看 rel

### 4. Dev blog / article
- 文章正文链接、作者 bio 链接、profile/card 链接可能有不同 rel 策略
- 不要只看到页面有品牌提及就默认 link 存在

## 关于 nofollow 的业务判断

- nofollow 不是“完全没价值”
- 高权重站点上的 nofollow 仍可能有品牌信号、发现信号和自然分布价值
- 但在 V3 的 operator 语义里，no-follow 与 dofollow 应如实记录，不能混淆

## 推荐验证方式

优先用 V3 的 shared link verification 结果。
如需人工 spot check，可看页面上所有指向目标域名的链接及其 rel/visibility。

## 常见坑

- 不要把空 `rel` 和“永久 dofollow”画等号；它只是当前未见显式限制
- 不要以旧榜单替代新实测
- 不要在 edit page、preview page、草稿页上做最终 rel 判断
- 不要只看页面是否提到品牌，不看 target link 是否真实存在
