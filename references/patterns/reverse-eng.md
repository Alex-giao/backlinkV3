# Reverse Engineering Pattern Reference

用途：沉淀 bounded reverse-engineering 的经验。

这里记录的是“当前端层失灵时，如何在同一公开业务动作内补齐证据并寻找真实提交路径”。
不是让 operator 无边界地 fuzz、爆破或越权。

## 何时使用

当这些条件同时满足时，可以考虑做一次 bounded reverse-engineering：
- 当前表面明显是真实 submit / register / vote / profile / publish surface
- 前端交互层出问题：按钮不动、modal 不弹、表单不提交、多 input 组件失真、SPA 空壳
- 继续盲点盲填只会浪费时间

如果页面本身已经明确是：
- 付费墙
- captcha/human verification block
- social-OAuth-only
- 缺 truthful 必填资料
那就不要把 reverse-engineering 当成默认下一步。

## 核心边界

只允许：
- 为完成同一个公开可见的业务动作，补充识别真实 action / endpoint / hidden fields / payload shape
- 在同一 session / 同一权限边界内完成同一动作

不允许：
- fuzz 未知参数
- 暴力枚举内部 API
- 越过付费/验证码/2FA/人工审核边界
- 把一次站点级抓包经验误升级成通用真理

## 推荐 SOP

### 1. 先确认值得逆向
先补一轮 fresh evidence：
- 当前 URL
- title
- screenshot
- visible CTA
- browser-use state / DOM

如果连表面是否真实都不清楚，先别逆向。

### 2. 先看静态结构
优先检查：
- `form.action`
- hidden inputs
- `button[type=submit]`
- `data-*` attributes
- inline scripts

目标：
- 找真实 action
- 找 payload clue
- 找状态切换线索

### 3. 再看脚本和网络线索
可从这些地方找线索：
- `fetch(`
- `axios.post(` / `axios.get(`
- XHR endpoint 字符串
- bundle 中的 route/action 名称

重点不是“抓全站所有接口”，而是定位与当前公开动作最相关的那一条。

### 4. 只在 endpoint 已经足够清楚时，做同语义调用
如果你已经明确识别：
- 这是当前页面同一个公开动作的官方后端入口
- 所需 payload 基本来自当前表单/当前 session
- 继续不会跨权限或制造脏状态

才可以在同一 session 下做一次 bounded 调用。

### 5. 把结果写成 evidence，不要只留脑内结论
应记录：
- 找到的 action / endpoint 线索
- 关键 hidden fields / payload clues
- 为什么判定这是同语义入口
- 调用后发生了什么
- 为什么继续 / 停止

## 典型模式

### 模式 A：按钮无反应 / modal 不弹
看：
- 是否有 click handler 对应的 network call
- 是否是前端 mount 失败但后端入口仍存在
- 是否只是 overlay / z-index / disabled state 问题

### 模式 B：多 input 组件失真
例如：
- OTP / verification code 多格输入
- 组件依赖 onkeyup/oninput 自动跳格

处理：
- 先确认是否存在统一的后端提交入口
- 如果只能靠前端组件完成且无清晰同语义 endpoint，不要硬猜 payload

### 模式 C：SPA blank shell / dead root
看：
- `#root` / app mount 是否为空
- body text、form count、input/button count
- 是否只是页面壳活着，提交面已死

若 evidence 足够说明是 stale/blank shell，应优先按 stale path 收口，而不是继续深挖。

### 模式 D：前端校验吃不到输入
看：
- 是不是 key events / blur / change 没被触发
- 是不是 hidden state/derived payload 没生成

先用更高保真的交互补证据；不要一上来把所有问题都当成要直接打 API。

## 停止条件

出现这些情况就应停止 reverse-engineering 并收口：
- endpoint 仍不清楚
- 需要猜未知参数
- 继续会跨越安全/权限边界
- 页面真实 blocker 其实是 missing input / paid listing / captcha / manual auth
- 已经拿到足够证据证明 submit path 死掉或表面不真实

## 常见坑

- 不要因为“前端坏了”就自动认为“后端一定能直调”
- 不要把单站点一次性 API path 写成跨站通用规则
- 不要因为逆向成功过一次，就把站点级 snippet 塞进主 skill
- 不要跳过 trace / finalize，只在聊天里描述“我看到了 endpoint”

## Verification

做完一次 bounded reverse-engineering 后，至少确认：
- 你解决的是前端失灵，不是绕安全边界
- evidence 已留下，而不是只剩口头结论
- 如果调用了同语义 endpoint，已说明为什么它与页面动作等价
- 如果没继续调用，也已明确停止原因
