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

注册型 forum profile 补充经验：
- 某些 forum/profile surface（例如 Drupal/媒体站 forum）不是“只要邮箱+用户名”即可，而会在注册页同步要求完整联系资料：first name、last name、street address、postal code、phone、city/post office 等。此时不要因为 scout 只看到 login/register 入口，就默认资料已足够。
- 对这类 surface，先做一次 bounded validity probe：只填写当前已知且 truthful 的字段（例如 email、username、first/last name、privacy consent），尝试触发表单原生校验，再读取仍然 invalid 的 required 字段，作为 authoritative missing-input 证据。
- 若页面 DOM 里出现 hidden captcha / Turnstile 字段，但在 bounded validity probe 阶段还没有 visible captcha challenge，不要抢先归因为 captcha_blocked；应优先按 missing_input 收口，直到真实缺字段补齐后仍只剩人工验证，再升级到 captcha/manual-auth 分类。
- 对 Drupal + Turnstile 一类注册页，常见路径是：先因地址/邮编/电话/城市等真实字段缺失而被 HTML5/表单校验拦住；等这些 truthful 字段全部补齐后，提交才返回 `The answer you entered for the CAPTCHA was not correct.` 一类报错，并在 DOM 中出现 `.captcha-type-challenge--turnstile` / `cf-turnstile-response` 证据。此时应从 `REQUIRED_INPUT_MISSING` 升级为 `captcha_blocked`，不要继续停留在 missing-input 分类。
- 这类注册页常见 ask-user-once bundle：`address_line_1`、`postal_code`、`phone_number`、`city`；若命中，应一次性向用户收齐再继续，不要来回多轮追问。
- 已登录不等于 `forum_profile` 成立。若登录后 `/user/<id>/edit` 这类账户页只暴露 email / password / privacy 字段，没有 website / bio / signature / social links / about me 等 profile backlink 字段，但站内另有 `new topic` / `add thread` / rich-text composer（例如 XRacing 的 `/node/add/forum?forum_id=0`），应判定为 surface mismatch：当前路由更接近 `forum_post` 候选，而不是继续把它当 `forum_profile` 推进。
- Dynamics / Power Pages / partner-portal 风格 surface 也要按同一原则处理：有些站点 public register 成功后会自动登录，并把你落到 `My Profile` / `Partnership Application` / dashboard 类路由；这些页面可能只暴露 first/last name、job title、email、phone、organization、address 等联系或申请字段，没有任何 website / bio / signature / social backlink 字段。若同时在已登录 thread/page 上能看到 `Post a reply`、`Post this reply`、new topic 等 composer 入口，不要把“注册成功且可进入 profile/application”误写成 `PROFILE_PUBLICATION_PENDING` 或继续做 forum_profile 重试；应记录为 surface mismatch，建议切到 `forum_post` family。
- 对这类 surface mismatch，当前 runtime 若尚未正式支持 `forum_post`，应在 trace / finalize 中明确记录“账号登录成功，但 profile route 无可挂链接字段；站内存在 forum post composer，需切换 family 才能继续”，不要把它误写成 profile save pending 或 generic unsupported auth。
- 另一个常见注册后收口陷阱：有些 forum profile surface 会在注册/资料保存后同时出现 `verify your email` / `check your inbox` / `confirm your email` 提示，但 public profile 已经立即可访问，且 website/bio backlink 已 live。此时不要被 email-verification banner 机械降回 `WAITING_MANUAL_AUTH` / `WAITING_SITE_RESPONSE`；应优先直接检查匿名/public profile DOM 是否已有指向 promoted URL 的 `<a href>`。若 live backlink 已可见，默认按 `forum_profile` 业务成功收口；把邮件验证视为账号层后续事项，而不是本次 backlink 任务的阻断条件。

优先沉淀到这里的内容：
- 常见入口词与页面结构
- 资料字段映射建议
- profile 可见性与落地验证方式
- 平台级 quirks

不要放这里的内容：
- 单次任务进度
- 站点级临时 cookie / runtime 污染
- 应该进入 playbook/fragment 的单站成功路径
