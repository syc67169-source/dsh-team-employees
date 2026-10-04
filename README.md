# dsh-team-employees

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 从「一个助手」变成一个**多员工协同团队**：有工牌、有花名册、有一条内容流水线、有一道只有人能按的闸门，还有一个会动的办公室界面。

![办公室](docs/images/office.png)

- **员工**——五个 agent preset（模式）。给每个员工一张工牌：人设 + 工具集（模型由会话选择）。情报、选题、成稿、数据四个内容岗，外加一个代码审核岗。
- **花名册**——`$DSH_HOME/team/employees.json`。谁在岗、什么岗位、模型备注，写在一个 JSON 里。
- **内容流水线**——素材登记 → 打分 → 写稿 → 制作计划 → **人工裁决** → 发布包 → **真实发布确认** → 回采 → 重算权重。每个阶段只认特定的前置阶段，谁都不能跳。
- **办公室**——侧边栏一个图标，整页看到六个部门在干嘛：上钟中、待命、空岗、等你。状态来自真实会话，不是装饰动画。
- **员工管理**——「设置 → 员工」里增删改花名册，缺工牌时会给出可复制的配置片段。
- **长期研究职责（0.5.0）**——本地独立后台定时检查公开网页，用真实 Harness headless 模型生成简报，保留上次记忆并提示变化。关闭桌面应用后继续运行；电脑关机或休眠时无法继续。

![设置](docs/images/settings.png)

## 它为什么不是又一个「AI 助手壳子」

三个设计上的取舍，决定了它跟同类东西不一样：

**人工工具闸门。** `ctx.tools.guard()` 拦截员工调用 `content_gate`；状态机拒绝自动离开 review，发布包要求署名审核记录。办公室提供人工审核入口。具有本机文件/终端权限的员工仍可能直接改数据，因此这不是系统级权限隔离。

**能用代码做的，不外包给模型。** 切片、转码、排期全是确定性任务，`content_render` 只登记参数，不调 ffmpeg、更不烧 token。模型只干「判断」和「写」。

**状态诚实。** 「上钟中」的判据是那个员工的会话当前真的开着 turn；账本读不到就说读不到，不编数字；平台收入是美元、账本是人民币，没设汇率就不算净额，两个原值都留着。

## 装上

需要 Node 20+ 和一个能跑的 DeepSeek Harness。

**方式一：本地目录链接（改代码最方便）**

```sh
git clone https://github.com/syc67169-source/dsh-team-employees.git
cd dsh-team-employees
node bin/link-into-profile.mjs --dry-run   # 先看要改什么，不写盘
node bin/link-into-profile.mjs             # 装进 desktop profile
```

脚本只做三件事，都会打印出来：给 `~/.dsh/profiles/<profile>/package.json` 加一条 `link:` 依赖、把插件名追加进 `dsh.profile.bundles`、在 profile 的 `node_modules` 里建软链（原文件先备份成 `package.json.team.bak`）。**完全退出 DSH 再打开**后生效；卸载用 `--remove`。

**方式二：手动改 profile（不想跑脚本）**

在 `~/.dsh/profiles/<profile>/package.json` 里加一条依赖和一条 bundle：

```json
{
  "dependencies": { "dsh-team-employees": "github:syc67169-source/dsh-team-employees" },
  "dsh": { "profile": { "bundles": ["…原有的…", "dsh-team-employees"] } }
}
```

然后在那个 profile 目录里 `pnpm install`。桌面端注意：`dsh plugin --profile desktop` 会被 CLI 拒绝（官方设计如此），手动或走脚本。

## 装上之后

0. 完全退出 DSH 再打开（客户端界面模块在启动时组图）。
1. 侧边栏出现「办公室」图标 → 点进去是六个部门的工位。
2. 「设置 → 员工」能看到花名册，可以增删改。
3. 新建会话 → 模式下拉里出现五位员工。
4. 选「情报员工·阿研」，问她「团队里现在有谁」→ 她调 `team_roster`。再让她登记一条素材 → 回办公室页刷新，情报部那个工位会显示「上钟中」。

## 先验收长期研究第一版

进入 **办公室 → 长期研究员工 → 新建长期职责**，选择员工，填写目标和 1–5 个无需登录的公开网址，再设置间隔与每日模型唤醒上限。保存后默认暂停。

点击 **立即执行一次** 建立第一份简报；查看最近记忆、来源和完整报告。点击 **启用定期检查** 才开始持续运行：内容未变跳过模型，发生变化生成新简报与面板提示。点击 **暂停** 会取消正在执行的任务。

这是本地第一版，一次只运行一个职责；使用 headless 配置的模型，员工模型备注不负责路由。支持文本、HTML、JSON、RSS/Atom，暂不支持需要登录或浏览器渲染的网页。详情与验收步骤见 [长期研究使用与验收](docs/always-on-research.md)。

## 员工与工具

| 工位 | 模式 id | 干什么 | 工具集 |
|---|---|---|---|
| 情报员工·阿研 | `scout` | 找素材、核授权、登记 | 检索 + 文件 + 内容工具 |
| 选题员工·阿筛 | `select` | 打分、排序、给先验 | 文件 + 内容工具 |
| 成稿员工·阿写 | `write` | 脚本与标题 | 文件 + 内容工具 |
| 数据员工·阿析 | `measure` | 回采、对账、重算权重 | 文件 + shell + 内容工具 |
| 审核员工·阿审 | `reviewer` | 代码审核（与内容线无关） | 文件 + shell |

团队通用工具（`dsh-team-employees/tools`）：`team_roster` 看花名册、`team_log` 写一条工作记录、`team_inbox` 读别人做到哪了。

内容流水线工具（`dsh-team-employees/content`）：`content_new`、`content_score`、`content_script`、`content_render`、`content_queue`、`content_gate`（仅人）、`content_publish`、`metrics_pull`、`weights`、`cost_report`。

设计与字段细节见 [`docs/内容流水线编排设计.md`](docs/内容流水线编排设计.md)。

## 数据在哪

```
$DSH_HOME/team/
├── employees.json          花名册
├── journal.jsonl           团队工作日志（成员之间靠它交接）
├── content/
│   ├── index.jsonl         摘要索引
│   └── <id>/               item.json / events.jsonl / script.md / render.json / publish.json
└── metrics/
    ├── <id>.json           单条回采结果
    └── weights.json        权重表（中位数比值，全表能手算）
```

全部是纯文本，直接看、直接改、直接进版本控制都行。

## 自检

```sh
npm test          # 112 项；自动测试使用隔离目录与模型夹具，不消耗真实模型额度
```

- `test/smoke.mjs`——团队工具的注册契约、Host 的 `/team/api`、办公室状态机（上钟/待命/空岗/人工岗怎么算出来的）、浏览器兜底页、客户端包的槽位注册与界面渲染。
- `test/content.smoke.mjs`——流水线状态机、闸门、记账、权重表。

本机装了 dsh 时，会用 dsh 自己的 schema 校验器验证工具契约（`DSH_TOOLS_ENTRY` 可指定位置）；没装就自动跳过那几条并明确打印说明，其余断言照跑。客户端界面是在一个最小 React 运行时里真渲染过的，所以 CI 不需要浏览器。

看设计不用启动 DSH：

```sh
npm run preview   # 三个界面渲染成静态 HTML 到 docs/preview.html
npm run shot      # 有 Chrome 时顺便重截 docs/images/ 里的图
```

## 目录结构

```
dsh-team-employees/
├── cordis.patch.yml        挂载清单：1 个 Host 行 + 5 个员工 preset
├── employees.json          花名册样例（安装时复制到 $DSH_HOME/team/）
├── lib/
│   ├── index.js            Host：/team 接口 + 办公室数据 + 浏览器兜底页
│   ├── client.js           客户端：侧边栏入口 + 办公室整页 + 设置里的员工管理
│   ├── store.mjs           团队数据读写（花名册 + 日志）
│   ├── tools.js            Agent 工具：team_roster / team_log / team_inbox
│   ├── content.mjs         流水线数据层：状态机 + 队列 + 回采 + 权重
│   ├── content-tools.js    流水线工具 + 人工闸门
│   └── usage.mjs           读本地账本（$DSH_HOME/.dshw-usage.json）
├── bin/link-into-profile.mjs
├── tools/                  预览与截图
└── test/                   两套自检 + 最小 React 运行时
```

## 加一个员工 / 加一个工位

加员工（改花名册，界面里就能做）：`$DSH_HOME/team/employees.json` 加一条。

加工位（要改配置）：`cordis.patch.yml` 里复制一个 `preset-employee-*` 块，改 `id`（小写字母数字连字符）、`name`、`order`、人设和工具集；如果要让他守一段流水线，再在 `lib/index.js` 的 `DEPARTMENTS` 里加一行。设置页在缺工牌时会给出可以复制的片段，但不会替你改配置文件。

员工花名册的 `model` 仅作备注，不会切换模型。实际模型请在对应会话的模型选择器中设置；当前插件没有员工级模型路由。

## 边界与风险

- **闸门只挡员工，不挡你。** 它防的是「员工自我放行」，不是防你手滑。
- **`exec.agent` 是宿主内部字段。** 这是目前唯一能区分「人 vs 员工」的手段，闸门押在它上面。升级 DSH 后请重跑自检确认它还在拦。
- **账本是 best-effort。** `.dshw-usage.json` 由宿主写，不是公开契约；读不到就退回「读不到」，不编数字。
- **不代发、不批量多账号、不绕平台风控。** 发布这一步刻意留给人：`content_publish` 只写本地发布包，不接触任何平台接口。
- **`bin/render.mjs` 还没写。** `content_render` 只登记参数；真正的 ffmpeg 转码是下一步。
- **版本跟着 DSH 走。** 针对 `0.2.0-rc.2` 的运行时写的，宿主接口变动时需要跟着改；自检会告诉你哪一条不对了。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 联系与交流

用这个插件遇到问题、想提需求，或者只是想要一起交流一些AI有关的问题——扫码加我：

<img src="docs/images/qq.jpg" alt="QQ 二维码" width="240">

QQ：`3657854368`（EasonS）

### 稳定性修复（2026-10-04）

- JSON 写入使用唯一临时文件；条目、花名册、回采、权重以跨进程目录锁串行化。旧 revision 保存会被拒绝。
- 锁等待最长 15 秒，失败时不会覆盖数据。若进程崩溃留下 `.lock`，先关闭所有使用该数据目录的 Harness/脚本，再核对 `owner.json` 的 PID 已退出并移除相应锁目录。不会根据过期时间自动抢走锁。
- 索引保留每个 id 的最新摘要；队列先去重再筛选，统计包含全部条目。事件历史仍保留在条目内。
- `content_publish` 只准备发布包，条目保持待发布。办公室中署名审核、填写真实发布链接/记录并确认后，才进入 published；回采只接受已经确认发布的平台。可为同一条内容准备多个平台。
- 人工操作接口复用宿主认证并校验来源，防止跨站请求。它不是抵御具有本机文件/终端权限的代理的安全沙箱。
- 停止以全局账本前后差额自动归因内容成本。队列显示的是已关联记录，不是完整实际支出；旧成本记录未经重新审计，金额为 0 不代表免费。
- 办公室复用一次条目和账本读取；日志从尾部读取；请求 15 秒超时、卸载时取消，前次请求完成后再轮询。
- 制作阶段依然只生成制作计划，尚未实现媒体渲染器；审核时必须自行检查实际成片。
