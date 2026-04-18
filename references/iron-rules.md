# Iron Rules

用途：这是 V3 operator 的硬执行纪律。

每次跑真实站点前，先过一遍这些规则；如果与某次 brief 冲突，以本次 brief + 明确安全边界为准。

## 10 条铁律

1. 先确认当前 promoted profile / 品牌 / 锚文本，再切站
- 不要把 A 站内容写到 B 站
- 切站后先读一次当前任务的目标产品、目标域名、允许锚文本

2. 不编造资料
- 缺真实字段就收口到 missing input
- 不捏造姓名、电话、城市、公司规模、社媒、融资信息、商店链接
- “为了多推进一步”而虚构资料，长期看一定制造脏状态

3. 先读相关 reference，再碰陌生 surface
- 至少读：本文件 + 对应 family reference
- 遇到 comment / anti-spam / reverse-engineering / fallback 场景时，先查对应 references

4. 不轻易丢当前表单页
- 查邮箱、看 OAuth、做补证据时，不要主动把已填一半的表单页关掉或离开
- 需要新开 tab / page 时，保持当前表单状态可回到原处

5. rel 和 live link 每次实测
- 旧数据库标记、旧人工印象、旧平台名录都不算 proof
- 提交后优先看 live page、target link、anchor、visibility、rel flags

6. 只剩验证码/人工验证时才叫人
- 必须先把所有 truthful 字段都填完
- 必须把验证码区域滚到可见
- 必须确认此时唯一剩余 blocker 就是人工验证，而不是还有漏填字段

7. 前端失灵先做一次 bounded reverse-engineering
- 按钮不动、modal 不弹、控件失真、XHR 链路异常时，不要立刻判死
- 但 reverse-engineering 必须有界：只为完成同一个公开业务动作，不 fuzz，不越权，不绕过付费/验证码/2FA/人工边界

8. 站点的硬边界要尽早承认
- 真付费墙、明确人工认证、captcha/human verification、social-OAuth-only、CleanTalk/403 之类硬阻断，不要假装还能自动推进
- 这类要及时收口，而不是反复空转

9. 不把“提交动作发生了”误判成“业务成功”
- directory family 可以接受强确认 success/pending 作为成功
- forum_profile / wp_comment / dev_blog 必须优先看 public/live backlink verification
- pending / moderation / review 不是 live backlink

10. 每次都要留痕
- 有 agent loop 就必须留 trace / handoff / artifacts
- 必须跑 `task-record-agent-trace`
- 必须跑 `task-finalize`
- 最终以 repo state 为 authoritative truth

## 快速自检

跑单站前，至少问自己：
- 当前产品和域名确认了吗？
- 这个站的 family 是什么？
- 对应 reference 读了吗？
- 资料是否全都 truthful？
- 成功定义是 submit 成功，还是 live link 成功？
- 如果中途失败，准备怎么留痕和收口？

## 不该放进这里的内容
- 单站点一次性 workaround
- 死站清单
- 平台大名单
- 临时 campaign 进度
- 临时账号/验证码细节
