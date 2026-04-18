# Link Verification Reference

用途：定义 post-submit verification 的核心关注点。

最小验证目标：
- live_page_url
- target_link_url
- anchor_text
- rel
- ugc / sponsored / nofollow
- 链接是否公开可见

统一成功口径：
- forum_profile：public profile reachable + target link verified
- wp_comment：public live comment exists + target link verified
- dev_blog：public article exists + target link verified

非成功但常见状态：
- `PROFILE_PUBLICATION_PENDING`
- `COMMENT_MODERATION_PENDING`
- `ARTICLE_SUBMITTED_PENDING_EDITORIAL`
- `ARTICLE_DRAFT_SAVED`
- `COMMENT_PUBLISHED_NO_LINK`
- `ARTICLE_PUBLISHED_NO_LINK`

原则：
- 不以“点了提交按钮”替代成功定义
- 不以旧数据库标记替代新实测
- profile / comment / article 三类 family 都应统一走 verification 口径
