# Dev Blog Family Reference

用途：补充 self-serve article / community publishing family 经验。

当前范围：
- 仅覆盖可自助创建 draft、submit for review、publish 的 flow
- 不覆盖 guest post / editorial outreach
- 内容必须基于真实资料，不允许为了发文而编造

关注面：
- write post / new post / publish / draft / editor / submit for review
- 标题、摘要、正文、标签、作者简介
- draft saved / submitted for review / published
- 公开页链接与 rel 实测

状态判断：
- `draft saved` = `ARTICLE_DRAFT_SAVED`，表示只是保存草稿，不是成功
- `submitted for review / article submitted` = `ARTICLE_SUBMITTED_PENDING_EDITORIAL`，表示站点在审核，不是成功
- `published` 只有在 link verification 命中目标链接时才算成功
- `published` 但没有目标链接，应记为 `ARTICLE_PUBLISHED_NO_LINK`
- 对 `ARTICLE_PUBLISHED_NO_LINK`，默认应直接按终态失败收口（skip / terminal audit），不要再做无人值守自动重试；文章已经公开但链接没落地时，重复自动提交通常没有意义

首版资料字段 bundle：
- article_title
- article_summary
- article_body_or_markdown
- author_bio_short
- canonical_url
- tags_or_categories

优先沉淀到这里的内容：
- editor cue 与状态识别
- article-level required inputs
- publish / review / draft 状态经验
- 公开文章验证经验
