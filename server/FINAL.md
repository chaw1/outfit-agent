# 服务端第四轮验收交接

结论：U1、U2、U4 完成；U3 完成三策略×三样例真实对照，塞腰可完成，袖口与吊牌纹理仍未达标，**未证实真实成功率提升**。本轮 18 次调用估算 **¥4.523159**，已停止付费；仅本机验证，无服务器访问、部署、push 或合并。

- U1：同位置低频 RGB 偏差校正（每通道限 ±48/255，向内衰减）+ 蒙版内 smoothstep 羽化；选择局部校正以保留中心改动并严格限制影响范围。细分支回退受限羽化，避免细涂抹被吞掉。
- U1 真实同 raw 对照：2–8px 内带残差梯度 **1.230558→0.377772（-69.3%）**，16px **1.411045→0.819588（-41.9%）**，边界残差跳变 2.798648→0（RGB/255）。指标先减去原图天然梯度，不将衣服/背景本身的色差充当接缝。
- U1 像素：蒙版外 **4,111,650 像素中改变 0**；框选、轨迹、贴边、RGB/RGBA、混合粗细分支及落盘的逐像素测试保留通过。细到没有内部空间的笔画不承诺同等平滑。
- U1 前后图：`artifacts/seams-fix3-cuff-baseline-before.png`、`-after.png`，三栏细节 `artifacts/seams-fix3-cuff-baseline-detail.png`；数字 `artifacts/seams-fix3-cuff-baseline.json`。使用本轮保留的真实 raw；另存历史反解仅作兼容重放，未冒充原始响应。
- U2：4× 超采样渲染 Noto Sans CJK SC Medium 子集，仅 A/I/生/成、**4,180 bytes**；字体另名 Outfit Disclosure，版权及 **SIL OFL 1.1** 许可在 `app/fonts/`，来源/哈希/复现见该目录 README。Docker 已包含字体，无新运行依赖。
- U2：512×768、1024×1536、3072×4096 原生与放大目检清晰，另测极小图；新生成图使用新字体；局部改保留历史角标像素，AIGC/Source/Model 元数据及边界不变。前后图 `artifacts/fix3-label-comparison.png`，证据 `artifacts/fix3-label-checks.json`。

U3 每个格子只有一次图片请求，不自动重试；固定原图、原始指令和蒙版，全部使用同一新合成器：

| 策略 | Qwen 指令核对通过 | 目检与选择 |
|---|---:|---|
| A：旧 20% 上下文、原提示、衣服参考 | 0/3 | 袖口仍卷；塞腰目检实际完成，存在核对误判 |
| B：60% 上下文、完整原图参考、目标描述 | 0/3 | 袖口/塞腰出现缩小人物拼贴，弃选 |
| C：60% 上下文、原衣服参考顺序、目标描述 | 1/3 | 塞腰通过且目检完成，无整图拼贴；保留此方案 |

- U3 限制：A/C 目检塞腰均完成，不能把核对数 0→1 宣称真实成功率提高；袖口仍卷，胸牌虽去掉但纹理/局部结构不够自然，仍记录 false。三样例不足以推导总体成功率；改动中亦有裤腰标签等无关细节漂移风险。
- U3 对比：`artifacts/local-edit-fix3-cuff-comparison.png`、`local-edit-fix3-tuck-comparison.png`、`local-edit-fix3-tag-comparison.png`（原图/A/C）；弃选 B 见 `seams-fix3-cuff-candidate-detail.png`。完整九项提示、输入哈希、选区、raw、检查与花费在 `artifacts/local-edit-fix3.json`。
- U3 正式流程：裁剪始终最后一张参考；保持未要求改变的品类/袖长，调色仅改属性；质检失败仍如实展示，自动纠正与队列重试共享最多两次图片请求。组合实验不能单独归因于上下文或提示。
- U4：最终 **193 passed / 32.11s**；ruff、git diff 检查通过，Alembic 空库迁移及权限/任务/持久化回归通过，live OpenAPI 与 `openapi.json` 相同。
- U4 Mock e2e：**6.897s PASS**；E1 重启续聊 2.945s、E2 去重 2.196s、E3 越阶段拒绝 0.020s、E4 脚本恢复 0.139s，全部 PASS。API/Worker 均为 Mock 且模型 key 为空。

| 本轮模型 | 调用 | 累计秒 | 估算元 |
|---|---:|---:|---:|
| wan2.7-image-pro | 9 | 132.825 | 4.500000 |
| qwen3-vl-plus | 9 | 26.058 | 0.023159 |
| 合计 | 18 | 158.883 | **4.523159** |

费用含失败、弃选和核对，无文本/视频调用；账本从零单列，预留闸 ¥5，低于 ¥5 停止线及 ¥6 硬限；最终扣费以供应商账单为准。凭证仅钥匙串取出注入子进程，未落盘；明细 `artifacts/usage-fix3-final.json`。
断点：`PROGRESS.md`；实验固定 `artifacts/local-edit-fix3.json` + 同名 `.sqlite`，生成/核对前写 started，未知结果或配置变化停止重提；`--phase check` 已以禁止模型调用 guard 复跑九项，新增调用 **0**（`evidence/fix3-resume.log`）。
复验顺序：本项目 Mock compose → `REQUIRE_INTEGRATION=1 uv run pytest -q` → `uv run ruff check .` → `scripts/e2e.py --mode mock` → `scripts/experiments.py`；重启实验结束后再测 HTTP。离线接缝命令见 README。
证据：`evidence/fix3-tests-final.log`、`fix3-ruff.log`、`fix3-e2e-final.log`、`fix3-experiments-final.log`；`artifacts/mock-fix3-final.json`、`experiments-fix3-final.json`、`verification-fix3.json`。证据、账本与断点留本地，未提交。
约定：仅更新 `docs/设计.md` 8.3 的实现说明，无接口字段/迁移变化；实现提交 `734d07f`、`6cbe581`，均 feat/server、chaw1 <97000945@qq.com>、中文单行，无署名尾注。墙钟约 15 分钟，未触及 1.5 小时上限。
