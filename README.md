# 衣序 · 穿搭笔记智能体（outfit-agent）

小红书穿搭博主接到品牌合作，品牌方往往只给几张衣服图。博主在「衣序」App 里和智能体多轮对话：智能体看懂衣服、给出场景和风格方向（附灵感预览图），写出笔记脚本，博主确认后按脚本批量生成"博主本人 × 品牌衣服 × 场景"的图片，不满意的一句话改图，最后得到一篇可直接发布的图文笔记，还可以生成一条 5 秒短视频。

- 线上服务：`https://47.97.153.127:8443`（`GET /api/health`）
- 移动端：Expo（React Native + TypeScript），iOS / Android 同一套代码

## 文档

| 文件 | 内容 |
|---|---|
| [docs/调研.md](docs/调研.md) | 场景调研、生成能力实测对比、**智能体框架选型**（硬需求 → 8 个候选对照 → 实验证明 → 反方意见）、演进方向 |
| [docs/设计.md](docs/设计.md) | 架构、智能体状态与人在回路、接口约定、卡片结构、数据表（后端和 App 共用的唯一约定） |
| [docs/开发记录.md](docs/开发记录.md) | 从接到作业开始的完整过程与卡点 |
| [docs/review/](docs/review/) | 外部技术评审意见 |
| [docs/spike/](docs/spike/) | 模型实测素材（全部自生成） |

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
| [server/](server/) | FastAPI + LangGraph + SQLAlchemy/Alembic + Worker，100 个测试 | `cd server && docker compose up -d --build`，见 [server/README.md](server/README.md) |
| [app/](app/) | Expo SDK 58 App + 本地假服务（不花钱也能走完整条链路），35 个测试 | `cd app && npm ci && npm run mock & npm run start`，见 [app/README.md](app/README.md) |

关键实验（`server/scripts/experiments.py`）：E1 重启后续聊、E2 重复确认不重复花钱、E3 越阶段被拒、E4 脚本时间旅行，全部通过。

## 部署

单台阿里云 ECS，docker compose（api、worker × 2、postgres）+ 宿主机 nginx 终止 TLS。域名未在阿里云备案接入，域名 HTTPS 会被按 SNI 拦截，所以使用 Let's Encrypt 的 IP 证书（每天自动续期）。部署脚本：[server/deploy/deploy-ecs.sh](server/deploy/deploy-ecs.sh)。
