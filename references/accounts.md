# Accounts / Mailbox Strategy

用途：沉淀 V3 在账号、邮箱、OAuth、身份隔离上的稳定策略。

这不是凭据仓库；真实账号、cookie、邮箱 alias 映射应留在 repo state / vault，而不是写在 skill 文档里。

## 基本原则

1. 账号身份和 promoted profile 分离
- 提交身份是 submitter identity，不等于 promoted brand identity
- 不要把品牌官网邮箱误当成所有站点都适合的注册邮箱

2. mailbox 资源必须在 brief 中显式给出
- submitter email 来源
- 可用 mailbox / Gmail / Google Workspace 资源
- 是否允许 magic link / email code / Google chooser / OAuth

3. 不为了一次注册污染长期身份
- 某个邮箱/别名在某类站点表现差，不要硬撑到底
- 站点级异常应记入 repo state，避免同一 identity 反复踩坑

4. 账号和浏览器状态要隔离
- campaign drain / 多 worker / 多 runtime 时，不要默认共用一个被污染的浏览器身份
- 需要并行时优先隔离 browser profile / CDP runtime / cookie jar

## 邮箱策略

### 1. 默认优先顺序
- 当前 brief 明确指定的邮箱资源
- 已接好的 Google Workspace / Gmail 能力
- 正式开跑前默认要求同时具备：一个主 submitter 邮箱资源 + 一个用户明确提供的 Gmail backup 邮箱资源
- 若当前 batch / queue 可能触发注册验证，而 dossier / brief 中没有 Gmail backup 邮箱：先 ask user once，拿到后再开跑；不要等卡在收信阶段才临时追问
- 站点要求触发后再决定是否切换 alias，而不是一开始乱换

### 2. 何时考虑切 Gmail alias
可以考虑切 Gmail alias 的场景：
- 自定义域名邮箱明显收不到验证码 / magic link
- 站点疑似对某类自定义域邮箱 deliverability 很差
- campaign 允许用通用 submitter identity，而不是必须品牌域邮箱

默认切换规则：
- 若站点已向自定义域邮箱发起验证链路，应先做一次 resend（如果页面提供）
- resend 后，用 authoritative Gmail / mailbox exact query 再确认一次
- 若在默认首轮 2 分钟观察窗内仍收不到验证邮件，优先把该站点视为“域名邮箱 deliverability 可疑”
- 这时若用户已提供 Gmail backup 邮箱，优先改用该 Gmail 身份从干净注册路径重做，不再在同一个域名邮箱上反复空等
- 这里的 2 分钟是默认运营阈值，不是全局不可覆盖的核心硬门禁；若某类站点已知发信更慢，可由 brief / runtime 覆盖；bundled runtime 当前使用 `BACKLINK_EMAIL_FALLBACK_WAIT_SECONDS`（默认 120）作为这个窗口
- operator-only 路径下，`task-prepare` 现在会同时暴露主注册草稿与 Gmail fallback 注册草稿；若页面明确拒绝自定义域邮箱或超时未收信，应优先切到 prepare 输出里的 Gmail fallback 凭据，而不是临时现场造新身份

注意：
- 切邮箱不等于伪造身份
- 仍然要保持 submitter identity 自洽、可回溯
- alias 变化要写回 repo state，避免下次失忆
- 若站点明确不接受自定义域名邮箱，也应直接切到用户提供的 Gmail backup，而不是继续重试域名邮箱

### 3. 查邮箱时不要丢表单页
- 当前页已经填了一半时，不要为了查邮件主动离开原表单
- 优先新开 tab / page 或用 mailbox tooling 直接检索
- 邮件检查结束后要能无损回到原提交面

### 4. mailbox 查询要区分“候选召回”和“authoritative 结论”
- 广撒网 mailbox triage 适合找候选
- 要写回“没有该站验证邮件”这类 authoritative 结论时，应再做一次精确查询确认

## OAuth / Social login 策略

1. OAuth 是 continuation，不是默认主路径
- 页面有本地 email/password/register，就优先走本地路径
- 只有公开路径明显要求 Google chooser / OAuth 继续时，再用 OAuth

2. social-OAuth-only 是独立语义
- 如果最终只剩 Google/GitHub 等第三方 OAuth、没有本地注册输入框，应按 manual auth / login gate 语义处理
- 不要因为按钮上写着 Register 就假设存在本地注册路径

3. 不把人工 OAuth 误当自动可持续路径
- 一次手工 OAuth 通过，不代表这个站以后适合批量自动跑
- 站点如果长期依赖人工 OAuth，应记为站点级操作事实

## 账号记录建议

应写回 repo state / vault 的内容：
- site/domain
- 使用的 submitter identity / alias
- 邮箱或 OAuth 路径是否成功
- 是否收到验证码邮件
- 是否需要人工 OAuth / manual auth
- 该身份是否被 anti-spam / policy 拒绝

不应写进 skill 文档的内容：
- 具体邮箱地址
- 具体密码
- OAuth token
- session cookie
- 一次性验证码

## 隐私保护 vs 伪造身份

可以做：
- 使用真实可控的 submitter alias / role account
- 使用你自己拥有或可合法接收的邮箱 alias
- 使用真实存在、可回收、可解释的业务联系方式
- 在本地测试 / dry-run 中使用占位假数据，但不能投到真实第三方站点

不要做：
- 为真实目录提交随机生成不存在的人名、地址、手机号
- 用虚构身份绕过站点要求的联系人信息
- 把“保护隐私”当成“允许伪造资料”

默认规则：
- live submission 一律优先 truthful + privacy-safe
- 若字段缺失且站点确实要求，先 ask_user_once，再继续
- 若用户不想提供，则该站点应保持 `WAITING_MISSING_INPUT` / policy blocker，而不是自动伪造

## 常见坑

- 不要在切站后忘记确认当前提交身份和目标产品是否匹配
- 不要因为品牌邮箱“看起来更正规”就忽视 deliverability 问题
- 不要把 mailbox 候选结果当成 authoritative 命中
- 不要为了收邮件反复刷新/关闭表单页
- 不要把一次站点级邮箱异常，误升级成全局规则
