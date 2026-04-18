# WP Comment Family Reference

用途：补充 WordPress / comment form 家族经验。

关注面：
- leave a reply / post comment / author url / textarea
- anti-spam / moderation / comment visibility
- comment 是否公开可见
- 链接是否真实落地以及 rel 实测

格式策略（有界尝试，不升级为 kernel 站点特判）：
- `plain_text`：正文放纯 URL
- `bbcode`：正文放 `[url=...]anchor[/url]`
- `html_link`：正文放 `<a href="...">anchor</a>`

状态判断：
- `awaiting moderation / comment submitted` 只代表进入站点队列，不代表成功
- 成功定义：public live comment 存在，且 link verification 命中目标链接
- live comment 已出现但目标链接缺失/被清洗，应记为 `COMMENT_PUBLISHED_NO_LINK`
- Akismet / CleanTalk / duplicate comment / spam 检测等，应记为 `COMMENT_ANTI_SPAM_BLOCKED`

反垃圾经验索引：
- Akismet：常见于“looks like spam / duplicate comment detected”
- CleanTalk：常见于“anti-spam / cleantalk / forbidden / blocked”
- 这些经验应沉淀到 references，不应扩成共享 kernel 的站点级条件分支

优先沉淀到这里的内容：
- 通用 comment surface cue
- 逐字输入、提交前校验、审核态识别
- 反垃圾系统经验索引
- comment live verification 经验

不要放这里的内容：
- 单站点一次性 workaround
- 具体账号凭据
- 临时手工接管细节
