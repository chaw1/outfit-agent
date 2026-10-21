# 衣序 · 穿搭笔记智能体（outfit-agent）

小红书穿搭博主接到品牌合作，品牌方往往只给几张衣服图。博主在「衣序」App 里和智能体多轮对话：智能体看懂衣服、给出场景和风格方向（附灵感预览图），写出笔记脚本，博主确认后按脚本批量生成"博主本人 × 品牌衣服 × 场景"的图片，不满意的一句话改图，最后得到一篇可直接发布的图文笔记，还可以生成一条 5 秒短视频。 赶更新时可以切到「一键出片」：交完素材去喝杯咖啡，全套图文和视频自动出好，中途随时接手。用户侧只看点数，不看货币。

- 线上服务：`https://47.97.153.127:8443`（`GET /api/health`）
- 移动端：Expo（React Native + TypeScript），iOS / Android 同一套代码

## 文档

| 文件 | 内容 |
|---|---|
| [docs/html/index.html](docs/html/index.html) | 以下全部文档的 HTML 阅读版（带目录与流程图），`make docs` 由 Markdown 生成 |
| [docs/调研.md](docs/调研.md) | 场景调研、生成能力实测对比、**智能体框架选型**（硬需求 → 8 个候选对照 → 实验证明 → 反方意见）、演进方向 |
| [docs/设计.md](docs/设计.md) | 架构、智能体状态与人在回路、接口约定、卡片结构、数据表（后端和 App 共用的唯一约定） |
| [docs/UI设计稿.md](docs/UI设计稿.md) | UI 设计稿：信息架构、核心流程、双主题视觉、页面状态与组件规格；[高保真设计板](docs/design/index.html) |
| [docs/设计系统.md](docs/设计系统.md) | 衣序 DS：token 单一来源、双主题组件规格、开发画廊、视觉快照与设计协作流程 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、分支提交、提交门禁与评审清单 |
| [docs/工程规范.md](docs/工程规范.md) | 分层、代码规范、测试与发布、ADR 索引、规则债务与质量快照 |
| [docs/开发记录.md](docs/开发记录.md) | 从接到作业开始的完整过程与卡点 |
| [docs/review/](docs/review/) | 外部技术评审意见 |
| [docs/spike/](docs/spike/) | 模型实测素材（全部自生成） |
| [docs/演示脚本.md](docs/演示脚本.md) | 5–8 分钟演示流程与追问答法 |
| [docs/调研-Chiccify对照.md](docs/调研-Chiccify对照.md) | 对公司现有产品 Chiccify 的功能对照与取舍 |
| [app/LIVE.md](app/LIVE.md) | 10-21 凌晨第一批线上联调报告（历史；最终验收见下方索引） |
| [docs/评审-独立评估.md](docs/评审-独立评估.md) | 交付前的独立评审（gpt-6.1-sol，只评不改）：六维评分、Top 10 问题、追问清单；第八轮按它修 |
| [server/FINAL.md](server/FINAL.md) · [server/ADMIN.md](server/ADMIN.md) | 服务端各轮验收报告：局部改像素证据、接缝指标、管理端验收 |

## 最终验收索引（唯一口径）

| 项 | 值 |
|---|---|
| 代码基线 | main，见 `git log`（线上服务端与 main 同步部署，`cd server && ./deploy/deploy-ecs.sh`） |
| 最新一次线上全链路 · 沉浸编导 | 2026-10-21 12:35–12:43（Asia/Shanghai），服务端与 App 均为最终版（含设计系统、素材库、3:4 竖版出图），`app/screenshots-live/run-4/`（evidence.json / http-evidence.json / sse-evidence.json），**13/13 通过**，真实模型（health `mock=false`），390×844 手机视口 Web。分析 56 s、出图 79 s、局部改 76 s、视频 190 s，项目 57 点。局部改"袖口放平"仍被核对判为未改到位，App 按规则沿用原版入稿 |
| 最新一次线上全链路 · 一键出片 | 2026-10-21 12:52–12:56（带录屏），注册 → 开拍 → 方向、脚本、出图、笔记、视频全自动到完成，App 端观察到全部六步，`app/screenshots-live/auto/run-5-evidence.json` 与 `run-5-*.png`，项目 45.9 点；前一轮 `run-4-*` 同样通过 |
| 真实商品图试跑 | 一件鹅黄色拉链连帽卫衣的正反两张商品图走一键出片：5 张成片 + 笔记 + 视频，核对分 95–98，`app/screenshots-live/auto/run-2-*`（服务端完成，用例在"写笔记"步因页面刷新间隔误判，已修） |
| 录屏 | `app/screenshots-live/走查视频/线上全链路-注册到视频-最终版-原速.mp4`（7 分 31 秒）与 3 倍速版；`线上一键出片-注册到视频-最终版-原速.mp4` 与 3 倍速版；更早几轮的录屏保留在同目录 |
| 真机 | iPhone 17 Pro（iOS 26）Release 包：注册 → 上传相册照片 → 开拍 → 出图 → 查看成片已由本人走通；首次真机上传暴露了 React Native FormData 文件通道的问题，已改为系统原生上传（见开发记录） |
| 点数口径 | 10 点 = 1 元；每个完整项目约 57 点（一键出片约 46 点）。用户侧只显示点数；管理端按元统计 |
| 已知未达标 | 局部改"袖口放平"多次线上均被还原检查判为未改到位（流程正确呈现失败，不算效果达标）；未核对通过的版本不默认入稿 |
| 未验证 | 小红书平台实际发帖（App 到"准备发布"为止，由系统分享面板接手） |
| 历史记录 | `run-1/`（07:41，第七轮）、`run-2/`（08:27，第八轮）、`run-3/`（10:55，第九轮）、`app/LIVE.md` |

## 开发方法与顺序

1. **调研与实测**：场景拆解、生成能力真实调用对比、智能体框架选型与小实验（`docs/调研.md`、`docs/spike/`）。
2. **设计先行**：产品范围与分期（`docs/设计.md` §1.1）、UI 设计稿（信息架构、流程、视觉语言、页面稿与状态、组件规格：`docs/UI设计稿.md`）、后端与 App 共用的接口契约（`docs/设计.md`）、设计 token 单一来源（`docs/设计系统.md`）。
3. **工程底座**：仓库分层、CI 门禁、校验脚本、假服务与 mock 模型（不花钱走通全链路）、迁移与部署脚本、工程规范（`docs/工程规范.md`、`CONTRIBUTING.md`）。
4. **按设计还原 P0 主链路**：假服务端到端通过后，上线真实模型，从注册到视频全链路留证据（截图、HTTP / SSE 证据、录屏）。
5. **P1 产品完整度 → P2 质量与体系**：每项只增不改，老客户端不受影响；每合入一项跑一遍假服务端到端，关键节点跑线上回归。
6. **独立评审 → 修复 → 最终回归**：交付前由另一个模型只评不改（`docs/评审-独立评估.md`），按评审修复后再做一遍线上全链路回归与录屏，结果汇总在下方「最终验收索引」。

整个过程采用 AI 原生的协作方式：人定方向与验收，Claude Code 写契约与任务书并复测合并，Codex 按任务书并行实现（`docs/开发记录.md`「工作方式」）。

## 架构一览

```
App（Expo）──HTTPS：REST + SSE──▶ FastAPI ──▶ LangGraph 智能体（PostgresSaver，thread = 项目）
                                     │          阶段之间：状态机（代码管钱、可审计）
                                     │          阶段之内：ReAct（模型选工具、写回复）
                                     ▼
                                 PostgreSQL（业务表 + 任务队列 + checkpoint）
                                     ▲
                       Worker × 2（SKIP LOCKED 领任务）
                         ├─ wan2.7-image-pro：试衣 + 换场景 / 改图
                         ├─ qwen3-vl-plus：看图、还原分质检
                         └─ wan2.6-i2v-flash：图生视频
```

## 代码

| 目录 | 说明 | 运行 |
|---|---|---|
| [server/](server/) | FastAPI + LangGraph + SQLAlchemy/Alembic + Worker + 管理端，562 个测试 | `cd server && docker compose up -d --build`，见 [server/README.md](server/README.md) |
| [app/](app/) | Expo SDK 58 App + 本地假服务（不花钱也能走完整条链路），207 个单测 + 27 条假服务端到端 + 2 条线上流程（Playwright） | `cd app && npm ci && npm run mock & npm run start`，见 [app/README.md](app/README.md) |

关键实验（`server/scripts/experiments.py`）：E1 重启后续聊、E2 重复确认不重复花钱、E3 越阶段被拒、E4 脚本时间旅行，全部通过。

## 管理端

和 API 同一容器：`/admin`（独立口令，`ADMIN_TOKEN` 为空时整体关闭）。总览、用量统计（按模型 / 用户 / 天，导出 CSV）、模型分层与每日配额（存库即时生效）、任务队列（重试 / 取消）、用户管理（禁用 / 层级）。花钱的动作在服务端按层级预算门禁，对话不受限。约定见 `docs/设计.md` 第 9 节。

## 部署

单台阿里云 ECS，docker compose（api、worker × 2、postgres）+ 宿主机 nginx 终止 TLS。域名未在阿里云备案接入，域名 HTTPS 会被按 SNI 拦截，所以使用 Let's Encrypt 的 IP 证书（每天自动续期）。部署脚本：[server/deploy/deploy-ecs.sh](server/deploy/deploy-ecs.sh)。
