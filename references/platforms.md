# Platform Surface Guide

用途：给 V3 一个面向“平台/表面类型”的操作速查，而不是堆假平台名单。

这里按 surface family 组织稳定经验；具体站点一次性观察，应沉淀到 repo state / runtime docs，而不是静态写死。

## 1. SaaS directory / listing surface

常见 cue：
- Submit / Add your product / List your tool / Get listed / Suggest a tool
- name / website / category / description / logo / screenshot / pricing
- review / pending approval / thank-you for submitting

常见 blocker：
- pricing / sponsored listing / advertise only
- auth/register gate
- missing truthful submitter or product fields
- captcha / human verification

成功判断：
- 对 directory family，明确的 submitted / pending review / thank-you 通常可视作业务成功
- 但仍应保留 trace 和 evidence

## 2. Forum profile surface

常见 cue：
- profile / account settings / signature / website / about me / social links
- save profile / update profile / public member page

关键字段：
- display name
- headline / about me
- signature
- website
- social links

成功判断：
- `profile updated / changes saved` 只是阶段推进
- business success 取决于 public profile reachable + target link verified

## 3. WP comment / comment form surface

常见 cue：
- Leave a reply / Post comment / Name / Email / Website / Comment
- comment moderation text
- duplicate comment / spam / anti-spam / blocked signals

关键动作：
- 分清 author URL 字段和 comment body
- 提交后核实 comment 是否公开 live
- 提交后核实 target link 和 rel

成功判断：
- awaiting moderation ≠ success
- public live comment + target link verified 才是成功
- live comment 出现但链接没落地，记 `COMMENT_PUBLISHED_NO_LINK`

## 4. Dev blog / community article surface

常见 cue：
- Write / Submit article / Publish / Draft / Review / Editorial approval
- title / summary / body / tags / author bio

关键语义：
- draft saved = 进度，不是成功
- submitted for review = 进入 editorial queue，不是成功
- published 但链接缺失 = `ARTICLE_PUBLISHED_NO_LINK`
- 公开文章存在且链接验证通过，才算成功

## 5. Generic utility / fake submit surface

常见 cue：
- 只有一个 URL 输入框
- Share / Analyze / Convert / Scan / Shorten 等按钮
- 没有 listing/profile/article/comment 的发布语义

处理原则：
- 不要把“有输入框 + submit button”自动当成 backlink surface
- 如果只是工具表面，不会发布业务实体，就应跳过或 `SKIPPED`

## 6. Register / login gate surface

常见 cue：
- sign in / continue with Google / forgot password / verification code
- auth modal 覆盖在 submit surface 之上

处理原则：
- 本地注册可达：继续探到最深处
- social-OAuth-only：按 manual auth 语义
- verify email / magic link：走 mailbox continuation
- 如果 auth 通过后只剩 paid listing / sponsored path，不要把注册成功误当 submit 可达

## 7. Paid / sponsored / advertise-only surface

常见 cue：
- advertise / sponsor / featured listing / pro access / contact sales
- price card / media kit / sponsored placement

处理原则：
- 这不是普通免费 submit surface
- 若公开推广入口本质是付费 inventory，按 policy/paid listing 处理

## 8. 如何使用这份 guide

建议顺序：
1. 先判断这是哪类 surface
2. 再读对应 family reference
3. 再决定是继续推进、补证据、做 fallback，还是直接收口

## 不该放进这里的内容
- 死站大全
- 未验证的平台大名单
- 过时 dofollow 榜单
- 单站点一次性抓包结果
- 临时 campaign 命中列表
