# V3 Brief Template

下面是推荐的自然语言 brief 结构。

```text
目标：
- 这批任务想要什么结果

成功优先级（仅当你要覆盖默认“成功率优先”时再写）：
- 例如：成功提交 > 待审核 > 人工认证 > 跳过 > 待判断

允许 / 禁止（仅当你要覆盖 skill 默认边界时再写）：
- 默认已允许：自动注册 / 邮箱验证 / magic link / Google chooser / OAuth 继续 / 视觉辅助 / playbook 沉淀
- 默认已禁止：付费 / CAPTCHA 代做 / 2FA / 隐藏 input 注入

视觉触发偏好（仅当你要覆盖默认策略时再写）：
- 默认：能靠 DOM / snapshot / URL / 可见字段判清，就不把视觉当固定第一步
- 默认：低置信页面、iframe / modal / overlay、auth 混合页、client-side success / thank-you state、证据互相冲突时，再提高视觉优先级
- 若需覆盖，可写成目标偏好，例如："所有 thank-you state 一律补视觉确认"

资源：
- promoted profile: <path or source>
- submitter email: <source>
- mailbox: Google Workspace skill
- browser runtime: http://127.0.0.1:9224

执行范围：
- queue / task ids / URL list

输出：
- 每站最终状态
- blocker 汇总
- 新增 playbook / fragment
- 仍需补充的信息
```

这只是 brief 结构，不是行为规则。
