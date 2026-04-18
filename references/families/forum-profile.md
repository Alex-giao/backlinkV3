# Forum Profile Family Reference

用途：补充 forum profile 类提交面的经验，不把这些细节硬塞回核心 skill 或 runtime if/else。

关注面：
- public profile / member profile / account settings / website / bio / signature / social links
- profile 是否公开可见
- profile 页上的目标链接是否真实落地
- rel / ugc / sponsored / nofollow 实测

推荐入口 cue：
- member profile
- account settings
- edit profile
- update profile
- save profile
- about me
- signature
- website
- social links

首版资料字段 bundle：
- profile_display_name
- profile_headline
- profile_bio
- profile_signature
- profile_website_url
- profile_social_links

状态判断：
- `profile updated / changes saved / saved successfully` 只代表资料保存成功，不代表业务成功
- 业务成功必须看到 public profile 可访问，且 link verification 命中目标链接
- 如果只是 save 成功但还没验证到 live link，应视为 `PROFILE_PUBLICATION_PENDING`
- 对 Discourse 一类 forum profile，要特别区分“页面上看到了站点文本”与“真的有 anchor backlink”：website / bio 有时会只渲染成 plain text 或 `<span title="https://...">...`，这不算 live backlink；要实测 public profile DOM 中是否存在指向目标 URL 的 `<a href>`，不要只凭肉眼看到 `exactstatement.com` 文本就判成功

优先沉淀到这里的内容：
- 常见入口词与页面结构
- 资料字段映射建议
- profile 可见性与落地验证方式
- 平台级 quirks

不要放这里的内容：
- 单次任务进度
- 站点级临时 cookie / runtime 污染
- 应该进入 playbook/fragment 的单站成功路径
