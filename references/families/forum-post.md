# Forum Post Family Reference

用途：记录 forum / thread / topic / reply 一类“发帖带链接” surface 的经验。当前 runtime 已把 `forum_post` 作为正式 `flow_family` 暴露给 classifier / dispatcher / generic family agent；这类 surface 不能被误判成 `forum_profile` 或默认 `saas_directory`。

关注面：
- new topic / add topic / add thread / create post / reply composer
- topic 标题、正文、分类 / forum section、富文本编辑器 / markdown editor
- 发帖后 public thread / post URL 是否可访问
- thread / post 中目标链接是否真实落地
- moderation / anti-spam / captcha / managed human verification

推荐入口 cue：
- new topic
- add topic
- create thread
- post new topic
- reply
- editor
- title
- body
- category
- forum section

状态判断：
- `draft saved` 不是业务成功
- `post submitted` / `awaiting moderation` / `pending approval` 不是业务成功
- 业务成功必须看到 public thread/post 可访问，且 link verification 命中目标链接
- 如果只完成提交但还没验证到 live link，应视为 pending / review 层，而不是 DONE

执行优先级：
- 默认优先回复别人已存在且高相关的帖子 / 主题（reply / comment on existing thread），而不是自己开新帖子
- 只有在没有合适的 existing thread、或 reply surface 无法自然承载目标内容时，才考虑 `new topic` / `create thread`
- 不要为了留链而硬开新贴；如果只能强行新开主题才有机会放链接，默认视为低优先级甚至不做

route boundary / family 边界：
- 如果登录后 user/profile edit 页只有 email / password / privacy 一类账户字段，没有 website / bio / signature / social links / about me 等资料字段，不要硬套 `forum_profile`
- 若同站同时暴露 `new topic` / `add thread` / `reply composer` 这类可发帖 surface，应改判为 `forum_post` 候选，而不是继续在 `forum_profile` family 里空转
- XRacing 型 Drupal forum 是一个已验证例子：`/user/<id>/edit` 没有可挂 backlink 的 profile 字段，但 `/node/add/forum?forum_id=0` 暴露 `Aihe`（标题）/ `Foorumit`（分类）/ `Sisältö`（正文）富文本编辑器，这属于 forum post surface，不属于 forum profile surface

实现哲学：
- 不要把 `forum_post` 支持做成“一段控制脚本负责点哪里、填什么、按什么顺序发帖”的厚脚本方案。
- `forum_post` 应作为正式 family contract 进入 shared kernel / family config / prompt context，让 agent 围绕目标、证据、边界自主决策，而不是被 one-off choreography 牵着走。
- deterministic 的小块能力（例如 verifier / schema / artifact persistence）可以留在 shared runtime；但站点执行路径、内容判断、何时切 route、何时收口，仍应由 agent 在 family-aware contract 下判断。

优先沉淀到这里的内容：
- forum post surface 的入口 cue
- 标题 / 正文 / 分类 / editor 结构
- moderation / anti-spam / captcha 经验
- public thread verification 方法

不要放这里的内容：
- 单次任务进度
- 站点级临时 cookie / runtime 污染
- 只适用于某一次任务的 workaround
