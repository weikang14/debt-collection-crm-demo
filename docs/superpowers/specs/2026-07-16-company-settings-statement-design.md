# 公司信息设置 + Statement 抬头可配置 — 设计文档

日期：2026-07-16

## 背景与问题

打印 statement（`src/views/cases/statement.ejs`）的抬头写死为 `Debt Collection CRM`。
每个部署/运营者打印出来都是同一个品牌，无法体现自己的公司信息。系统需要一个
界面来设置公司信息，让 statement 显示运营者自己的公司（名称、地址、电话、logo 等），
以便一套系统能给不同的人使用（白标）。

`clients` 模块已停用（cases 自动使用内建「自营」client），因此**采用全局单一公司**方案，
不做按 client 区分。

## 目标

- admin 可在一个设置页面维护全局公司信息：名称、地址、电话、email、注册号、logo。
- statement 抬头改为显示该公司信息；未设置时退回原有写死文字。
- logo 支持**文件上传**。

## 非目标（刻意不做）

- 不做多公司 / 按 client 区分。
- 不做每张 statement 临时自定义覆盖。
- 不改侧边栏的品牌名（只改 statement）。
- 不做图片裁剪 / 缩放 / 多尺寸。

## 关键决策

### logo 存储：base64 data URL 存进 DB（非磁盘）

Render free plan 磁盘是临时的（每次部署重新 seed），存 `public/uploads/` 会在重部署时丢失，
且不进 git / 备份。因此：

- 用 `multer`（memoryStorage）在内存接收上传文件。
- 转成 `data:<mime>;base64,<...>` 字符串，存入 settings 表的 `logo` 字段（TEXT）。
- 视图直接 `<img src="<logo>">`；打印 / Save-as-PDF 时 data URL 内嵌，不依赖外部请求。

代价：DB 体积略增（单张小 logo，可接受，限 500KB）。

### settings 表：单行

`id INTEGER PRIMARY KEY CHECK (id = 1)`，`init()` 时 `INSERT OR IGNORE` 一条默认行，
保证读取永远有值，页面/路由无需判断「行是否存在」。

## 数据模型

`src/db/schema.sql` 新增：

```sql
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  reg_no TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`src/db/index.js` `init()` 里，schema 执行后：
```js
db.prepare("INSERT OR IGNORE INTO settings (id) VALUES (1)").run();
```
（`CREATE TABLE IF NOT EXISTS` 已幂等，无需额外 ALTER 迁移。）

## 组件

### 1. 路由 `src/routes/settings.js`（挂载 `/settings`，admin 专属）

- `GET /settings`：`requireLogin` + admin 校验 → 读 `settings` 单行 → 渲染表单。
- `POST /settings`：admin 校验 → multer 处理可选 logo 文件 → 校验（image mime、≤500KB）→
  `UPDATE settings SET ... WHERE id=1`。有新文件才更新 logo；无文件则保留原 logo。
  提供「移除 logo」勾选以清空。写审计日志（仿现有 `utils/audit` 用法）。
- multer 用 `memoryStorage`，`limits: { fileSize: 512*1024 }`，
  `fileFilter` 只接受 `image/png|jpeg|svg+xml|webp`。文件太大 / 类型错 → flash 报错回表单。

权限模式仿 `users`/`demo`：admin-only。非 admin 返回 403 / 重定向。

### 2. 视图 `src/views/settings/form.ejs`

- 用现有 layout 与表单样式（仿 `clients/form.ejs` / `users/form.ejs`）。
- 字段：company_name、address（textarea）、phone、email、reg_no，file input（logo），
  当前 logo 预览（若有）+「移除 logo」勾选框。
- `enctype="multipart/form-data"`。

### 3. 侧边栏 `src/views/partials/sidebar.ejs`

admin 区（`can(['admin'])`）加入口：
```ejs
<a href="/settings" ...><%- h.icon('...') %> Settings</a>
```
（图标复用现有一个合适的 key。）

### 4. Statement 改造

- `src/routes/cases.js` 的 `GET /:id/statement`：读 `settings` 单行，作为 `company` 传入
  `res.render('cases/statement', { ..., company })`。
- `src/views/cases/statement.ejs` 抬头 `.stmt-head` 左侧：
  - `company.logo` 有值 → 显示 `<img>`（限高，如 48px）。
  - 显示 `company.company_name`；为空则退回 `Debt Collection CRM`。
  - 名称下方显示 address / phone / email / reg_no（有才显示）。

### 5. `src/app.js`

`app.use('/settings', require('./routes/settings'));`（在其它 admin 路由附近）。

### 6. `package.json`

新增依赖 `multer`。

## 错误处理

- 上传超限 / 类型不符：捕获 multer 错误 → flash 提示 → 回设置页，不改数据。
- 未上传文件：保留原 logo（除非勾选移除）。
- statement：所有公司字段可空，模板逐个判空显示，company_name 空则退回原写死文字。

## 测试

遵循仓库现有 `node --test` 风格，加一个 `test/settings.test.js`：

- settings 表默认单行存在，读取返回默认空字段。
- `UPDATE` 后再读回，字段正确。
- （若便于）data URL 拼接函数：给定 buffer + mime → 正确的 `data:...;base64,...`。
  把 base64 拼接抽成一个纯函数便于单测。

UI / multer 中间件不做端到端自动化测试（仿仓库现状），手工验证上传 + 打印。

## 改动文件清单

- `src/db/schema.sql`（新增 settings 表）
- `src/db/index.js`（init 插入默认行）
- `src/routes/settings.js`（新）
- `src/views/settings/form.ejs`（新）
- `src/views/partials/sidebar.ejs`（加入口）
- `src/views/cases/statement.ejs`（抬头改造）
- `src/routes/cases.js`（statement 路由传 company）
- `src/app.js`（挂载路由）
- `package.json` / `package-lock.json`（multer）
- `test/settings.test.js`（新）
