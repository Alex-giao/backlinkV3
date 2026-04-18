# Anti-Spam Pattern Reference

用途：集中存放反垃圾/风控表面的经验，不把这些 case 直接升级为核心 kernel 规则。

这里记录的是“识别与收口经验”，不是 CAPTCHA/风控绕过手册。

## 关注目标

可以放：
- Akismet / Antispam Bee / CleanTalk / Turnstile / reCAPTCHA / hCaptcha / Jetpack 等表面经验
- 哪些属于可继续观察的表面，哪些属于硬边界
- 提交后内容被吞、静默审核、服务端清洗、duplicate comment、published-no-link 等模式

不应该放：
- 越过 CAPTCHA / 2FA / 付费墙 / 人工审核边界的做法
- 单站点一次性脚本直接升格成共享规则
- 为了绕过风控而伪造资料或批量污染身份

## 结果优先的反垃圾分类

### 1. Moderation / queue-like
典型信号：
- `awaiting moderation`
- `comment submitted`
- `pending review`

处理：
- 这是进入站点队列，不是业务成功
- comment/article/profile family 后续仍要看 public/live evidence

### 2. Duplicate / spam-like
典型信号：
- `duplicate comment detected`
- `looks like spam`
- `blocked`
- `forbidden`
- `anti-spam`

处理：
- 优先记为 anti-spam / policy 阻断
- 不要误当作 success_or_confirmation

### 3. Published but sanitized
典型信号：
- 页面 live 了
- comment/profile/article 也公开了
- 但目标链接缺失、被清洗、只剩纯文本品牌提及

处理：
- 记为 no-link 类结果，而不是成功
- 先看 live backlink，再谈 rel

### 4. CAPTCHA / managed verification
典型信号：
- reCAPTCHA / Turnstile / hCaptcha challenge 仍待完成
- 提交后明确报 verification required / captcha failed

处理：
- 当 challenge 真实构成阻断时，按 human verification / captcha 语义收口
- 不要把挑战页面硬说成普通 register gate

## 常见系统/表面的经验

### Akismet-like 表面
常见表现：
- `looks like spam`
- `duplicate comment detected`
- comment 被吞或进黑洞

操作原则：
- 保持内容与上下文相关，不堆重复 URL/锚文本
- 若站点结构提供独立 website / author URL 字段，优先把站点链接放在结构化字段，而不是把推广链接硬塞到正文里
- 被明确判 spam/duplicate 时，不要再把这次提交记成待审核成功

### Antispam Bee / key-event-sensitive 表面
常见表现：
- JS 直接设值后服务端/前端校验异常
- textarea 看起来有值，但提交被当成 bot 或 403

操作原则：
- 若前端明显依赖真实键盘事件链，优先使用原生输入/逐字输入，而不是纯 JS `value=` 设值
- 这是前端交互保真问题，不是风控绕过特权

### CleanTalk / 403 hard block
常见表现：
- `403`
- `anti-spam`
- `CleanTalk`
- forbidden/blocked without a meaningful continuation path

操作原则：
- 优先视为强阻断
- 不要盲重试、换一堆随机输入去撞

### Jetpack Highlander / cross-domain iframe
常见表现：
- comment form 在跨域 iframe
- 当前 runtime 无法稳定注入或提交

操作原则：
- 当它成为真实阻断时，应按 external/human-verification-like surface 收口
- 不要假装只是普通 comment textarea

### Turnstile / reCAPTCHA / hCaptcha
常见表现：
- DOM 里有控件痕迹，但是否阻断要看 fresh screenshot + submit outcome

操作原则：
- 看到控件痕迹，不等于已经被阻断
- 只有当页面仍要求人工完成、或提交后明确报 verification/captcha error，才按 captcha 阻断收口
- challenge 已显示 success/勾选且按钮可继续时，应继续真实提交流程

## Comment-family 特别提醒

WordPress/comment 表面要额外区分：
- awaiting moderation
- duplicate/spam blocked
- live comment but no link
- live comment + target link verified

这四种语义不能混成一种“评论提交了”。

## 证据建议

遇到 anti-spam / captcha / moderation 时，尽量留：
- fresh screenshot
- 当前 URL
- 页面错误文案/系统名字
- browser-use state / DOM 线索
- post-submit outcome page
- 是否已出现 public live page

## Verification

结束前至少确认：
- 当前表面属于 moderation、anti-spam、captcha、还是 no-link
- 没有把 anti-spam/duplicate 误写成成功
- 没有把 live-no-link 误写成 dofollow/成功
- 需要人工验证时，已经明确说明“只剩这个 blocker”还是“还有 truthful missing input”
