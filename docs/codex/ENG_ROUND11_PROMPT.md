# 第十一轮 B：工程规范与门禁

## 目标

把 `docs/设计.md` **第 17 节**做出来（**唯一契约**）：让"工程意识与代码规范"在仓库里看得见、跑得通——`CONTRIBUTING.md`、`docs/工程规范.md`（含 ADR 索引与质量快照）、`.editorconfig`、`.githooks/pre-commit`、App ESLint 与服务端 ruff 规则补齐、`pytest-cov`、CI 补任务、根目录 `Makefile`。

现在还有四个 worktree 在并行改 `app/src`、`server/app`（第九轮、第十轮）。为了合并不打架，**本轮不改任何 `app/src/**` 与 `server/app/**` 的业务代码**：加 lint 规则时，只能加"现有代码零违规"的规则为 error；有违规的加为 warn，并把违规清单写进工程规范的"债务"一节，留给后续轮修。`app/package.json` 只允许加 `devDependencies` 与 `scripts`，`server/pyproject.toml` 只允许加 dev 依赖与工具配置。

## 验收标准（Claude 会亲自实测，不信自报）

1. `cd app && npm run verify` 仍全过；`cd server && uv run ruff check . && REQUIRE_INTEGRATION=1 uv run pytest -q --cov=app --cov-report=term-missing` 全过并输出覆盖率。
2. `make check` 在本机一条命令跑完两侧检查并以非零退出码反映失败；`make -n deploy` 显示调用的是现有 `server/deploy/deploy-ecs.sh`。
3. `.githooks/pre-commit` 可执行，在只改 `app/` 文件时只跑 App 侧检查，只改 `server/` 时只跑服务端检查；CONTRIBUTING 写明 `git config core.hooksPath .githooks`。
4. `.github/workflows/ci.yml` 新增 App Playwright（假服务）任务与 Docker 构建任务，YAML 可被 `python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'))"` 解析；本机无法跑 Actions，用 `act` 不作要求。
5. `docs/工程规范.md` 与 `CONTRIBUTING.md` 的每一条都对应仓库里真实存在的文件 / 命令 / 规则（Claude 会抽查），ADR 索引覆盖设计.md 第 2–17 节；"质量快照"填本轮实测数字与日期。README 文档表加两行。
6. 交付摘要写到 `docs/codex/runs/eng-round11-final.txt`（由 `-o` 指定）：做了什么、怎么验证、没做什么、新增规则与债务清单。

## 硬护栏（≤5 条）

1. 只在本 worktree（feat/engineering）工作，只提交本地分支，不 push，不碰 `docs/设计.md`、任何凭证和 `app/src/**`、`server/app/**` 业务代码；提交信息中文一行，作者 `chaw1 <97000945@qq.com>`，**不加任何 AI 署名 / Co-Authored-By**。
2. 不引入代码格式化工具的整仓重排（不跑 prettier / ruff format 改现有文件）。
3. 不连线上服务，不调用会花钱的接口。
4. 1.5 小时内交付；顺序：工程规范文档 → editorconfig / hooks / Makefile → lint 规则 → coverage → CI；时间不够就把没做的写进摘要。
5. 每做完一项跑一次相关检查，保证随时可交付。
