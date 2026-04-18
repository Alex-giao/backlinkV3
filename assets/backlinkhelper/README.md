# Backliner Helper

## 这份文档解决什么问题

告诉你这套系统现在是什么、主入口到底在哪、第一次该跑哪几个命令。

## 什么时候读

- 第一次接手这个 repo。
- 想确认 `skill` 和 `repo` 各负责什么。
- 想在 Hermes / Codex 会话或本机把单站点 bounded worker 跑起来。

## 最后验证对象

- `src/cli/index.ts`
- `src/control-plane/task-queue.ts`
- `src/control-plane/task-prepare.ts`
- `src/control-plane/task-finalize.ts`
- `src/shared/preflight.ts`
- `codex-skills/web-backlinker-v3-operator/SKILL.md`

## 这是什么

Backliner Helper 现在是一个 **单站点、严格串行、定时触发** 的执行底座。

- `repo 代码`
  - 负责任务队列、lease、shared CDP 浏览器连接、replay、scout、finalization、account registry、credential vault、artifact/playbook 落盘。
- `skill`
  - `web-backlinker-v3-operator` 负责实际运行协议，由 Hermes / Codex 会话驱动 `browser-use CLI`。
- `codex-skills/`
  - 是当前运行 skill 的唯一源码位置。
  - `$CODEX_HOME/skills`、`~/.hermes/skills/openclaw-imports`（历史目录名）等入口，只是运行时安装副本，不再手工维护。

当前这份 README 和 `docs/` 下文档是**实现层唯一真相源**。  
skill 不再复制完整运行细节，只负责入口和约束。

## Skill 源码管理

从现在开始，skill 的正确维护流程固定为：

1. 修改 repo 内的 `codex-skills/`
2. 运行 `pnpm validate-skills`
3. 运行 `pnpm sync-skills`

不要把 `$CODEX_HOME/skills/web-backlinker-*`、`~/.hermes/skills/openclaw-imports/web-backlinker-*` 这类运行时安装副本当成源码目录直接手改。  
那些目录只是安装产物；`openclaw-imports` 只是历史目录名，当前实际加载口径按 Hermes / Codex 处理。

## 调用链

```text
Hermes 会话 / 外部调度器
 -> operator skill
 -> repo CLI primitives
 -> shared CDP browser / gog
 -> target site family surface

Codex
 -> operator skill / architect skill
 -> repo docs
 -> repo code
```

## 当前主入口

生产路径不是 `run-next`。

当前推荐主入口是：

```text
Hermes 会话 / 外部调度器
 -> $web-backlinker-v3-operator
 -> claim-next-task
 -> task-prepare
 -> Codex-driven browser-use CLI
 -> task-record-agent-trace
 -> task-finalize
 -> exit
```

`run-next` 已切为 **fail-fast 占位命令**，只负责提示你改走 operator 主链，不再承载 repo-native agent 执行。

## 最短可运行路径

### 1. 启动一个外部 Chrome

```bash
open -na "/Applications/Google Chrome.app" --args \
  --remote-debugging-port=9223 \
  '--remote-allow-origins=*' \
  --user-data-dir=/tmp/chrome-cdp \
  about:blank
```

确认 CDP 正常：

```bash
curl http://127.0.0.1:9223/json/version
```

### 2. 准备运行环境

```bash
cd <repo-root>
export BACKLINK_BROWSER_CDP_URL=http://127.0.0.1:9223
export BACKLINER_VAULT_KEY='replace-with-a-stable-secret'
pnpm preflight
```

说明：

- `BACKLINER_VAULT_KEY` 用来解密本地凭据库。
- 当前生产主路径**不要求** `OPENAI_API_KEY`。
- 邮件读取主路径优先 `gog`，但当前也支持 `gws`（google-workspace skill）作为低成本兜底；两者任一完成 Gmail 授权即可支撑邮箱验证码 / magic link 场景。

### 2.1 历史兼容入口：`ensure-openclaw-cron`

当前推荐口径是：直接用 Hermes / V3 operator 运行主链。  
下面这个命令只在你仍要兼容旧调度环境时才需要：

```bash
cd <repo-root>
corepack pnpm ensure-openclaw-cron -- \
  --every 5m \
  --cdp-url http://127.0.0.1:9224
```

说明：

- 这条命令会把旧 cron 配置当成 **历史兼容运行时配置** 来对账：
  - 不存在就创建
  - 已存在就更新到当前推荐 spec
- 默认 job 名：`backliner-helper:queue-worker`
- 默认使用 isolated `agentTurn`
- 默认 cadence：`5m`
- 默认输出策略：
  - 空队列 / 正常自动恢复 / 正常提交完成 → `NO_REPLY`
  - 只有真的需要人工介入时才发 blocker 提醒
- 如需静默安装，可追加：`--no-deliver`
- 如果当前瓶颈不是“没有人 claim”，而是短 cron 本身带来过多空转/重复回灌，可用长跑 orchestration worker 减少调度开销；但它不应替代单任务 operator judgment，也不应把站点入口发现/点击/提交流程固化进 source-only tmp helper。

```bash
corepack pnpm drain-worker -- \
  http://127.0.0.1:9224 \
  999 \
  hermes-drain-worker \
  exactstatement-20260411-awesomefree-row-
```

说明：
- 这是 orchestration shell，不是站点决策器
- 它可以负责 claim / cadence / recount / finalize 外壳
- 但每个任务的真实站点执行仍应回到 `task-prepare -> operator reasoning -> task-record-agent-trace -> task-finalize`
- 若底层仍依赖 `tmp-hermes-batch-rerun.mjs` 这类 source-only helper，应视为历史兼容债务，而不是推荐主路径

### 3. 手工演练一次单站 worker

先入队：

```bash
pnpm enqueue-site -- \
  --task-id demo-futuretools \
  --target-url https://futuretools.io/ \
  --flow-family saas_directory \
  --promoted-url https://exactstatement.com/ \
  --submitter-email-base support@exactstatement.com \
  --confirm-submit
```

其他 family 例子：

```bash
pnpm enqueue-site -- \
  --task-id demo-forum-profile \
  --target-url https://community.example.com/settings/profile \
  --flow-family forum_profile \
  --promoted-url https://exactstatement.com/ \
  --confirm-submit

pnpm enqueue-site -- \
  --task-id demo-dev-blog \
  --target-url https://dev.to/new \
  --flow-family dev_blog \
  --promoted-url https://exactstatement.com/ \
  --confirm-submit
```

说明：

- `--target-url` 是现在的 canonical 参数；`--directory-url` 仍保留为 legacy alias，不会打断旧调用。
- `--flow-family` 当前显式支持：`saas_directory`、`forum_profile`、`wp_comment`、`dev_blog`。
- `enqueue-site` 现在会先对 `--promoted-url` 做一次 **deep probe**，默认尝试首页、pricing、features/product、about、contact、faq 等同站页面，再把结构化 promoted profile 缓存到 `data/backlink-helper/profiles/`。
- `--promoted-name` / `--promoted-description` 仍然支持，但现在更适合作为 override，而不是必填输入。

再 claim 一个任务：

```bash
pnpm claim-next-task -- --owner local-debug
```

然后 prepare：

```bash
pnpm task-prepare -- --task-id demo-futuretools
```

接下来由 operator skill 或你手工驱动 `browser-use CLI`。  
跑完后，把 trace 写回：

```bash
pnpm task-record-agent-trace -- \
  --task-id demo-futuretools \
  --payload-file /tmp/demo-futuretools-trace.json
```

最后做 Playwright 收口：

```bash
pnpm task-finalize -- --task-id demo-futuretools
```

## 当前代码地图

- `src/cli/`
  - 对外命令入口：`enqueue-site`、`claim-next-task`、`task-prepare`、`task-record-agent-trace`、`task-finalize`、`run-next`
  - 其中 `run-next` 现在仅保留兼容壳；真正生产路径只走 operator 主链
- `src/control-plane/`
  - 单站 bounded worker 的顺序和状态转换
- `src/execution/`
  - replay、scout、browser ownership lock、agent takeover finalization
- `src/memory/`
  - task / artifact / playbook / account registry / credential vault 落盘
- `src/shared/`
  - shared CDP runtime、preflight、Playwright session、邮箱 helper（`gog` 优先、`gws` 兜底）
- `codex-skills/`
  - `web-backlinker-v3-operator` 的 repo 内源码

## Skill 命令

```bash
pnpm validate-skills
pnpm validate-skills --installed
pnpm sync-skills
pnpm diff-skills
```

用途：

- `validate-skills`
  - 校验 repo 内 skill source 的结构和 frontmatter
- `validate-skills --installed`
  - 连同运行时安装副本一起校验；安装根优先取 `SKILL_RUNTIME_ROOT` / `HERMES_SKILLS_ROOT`，否则若存在 `~/.hermes/skills/openclaw-imports` 就用它，再否则退回 `$CODEX_HOME/skills`
- `sync-skills`
  - 把 repo 内 skill source 覆盖同步到检测到的运行时 skill 根目录
- `diff-skills`
  - 对比 repo source 和检测到的已安装 skill 是否漂移

## 先看哪份文档

| 你现在的问题 | 先看哪份 |
| --- | --- |
| 想先跑起来 | [docs/ops-runbook-zh.md](docs/ops-runbook-zh.md) |
| 想改 bounded worker 主链 | [docs/code-map-and-data-flow-zh.md](docs/code-map-and-data-flow-zh.md) |
| 想知道状态、lease、account、artifact 长什么样 | [docs/contracts-and-states-zh.md](docs/contracts-and-states-zh.md) |
| 想知道某个目录站之前发生过什么 | [docs/site-casebook-zh.md](docs/site-casebook-zh.md) |
| 想看北极星架构而不是当前实现 | [technical-architecture-zh.md](technical-architecture-zh.md) 和 [technical-architecture-diagrams-zh.md](technical-architecture-diagrams-zh.md) |

## 当前实现边界

- 当前 repo 已经支持：
  - 严格串行的单站队列原语
  - worker lease + 浏览器 ownership lock
  - 外部 Chrome shared CDP
  - replay / scout / finalization
  - account registry
  - 本地加密 credential vault
  - 注册型站点的邮箱 alias 策略
- 当前 repo 还没有完全自动化：
  - 独立 watchdog 进程
  - 通用 Hermes / 外部调度接入（当前仅保留 `ensure-openclaw-cron` 旧兼容入口）
  - 通用 OAuth worker
  - 完整的 `gog` 自动恢复 runner
- 所以当前最准确的定位是：
  - **repo = 可调度的执行底座**
  - **operator skill = 真正的运行入口**
