# 越权边界测试（Authorization Boundary Tests）— Design

**Date:** 2026-07-08
**Status:** Spec — awaiting user review before plan/implementation.

## 目标 / Goal

现有 `test/scope.test.js` 只断言 `caseWhere` 返回的 **SQL 字符串**长得对，测不到
「某个路由忘了应用范围过滤」这种真实越权。历史上 `debtors/show`、`tasks` 的范围泄漏
就是这样漏过单测、到最终评审才抓到的。

本子项目补一个**端到端范围断言**：用真实数据证明一个 `agent` 用户**永远**拿不到
另一个坐坐的数据——测在路由真正使用的**加载器/查询层**（泄漏真正发生的地方）。

## 方案：一个隔离库的端到端测试文件

对齐仓库现有的 DB 测试方式（`process.env.CRM_DB_PATH` 指向临时库，`init()` 建表）。
被否：
- **纯单测**：`scope.test.js` 已在做，抓不到"路由没应用范围"。
- **完整 HTTP 测试（supertest）**：仓库没有 HTTP 测试骨架，另起一套是更大的独立工程；
  按全仓惯例测在加载器层即可。

## 播种（`test/scope_boundary.test.js`，隔离库）

- 两个坐坐 agent A、agent B（`agents` 表两行）。
- 各自一个 debtor、一个 case（`agent_id` 分别指向 A、B）、一个 task（`agent_id` 指向各自）、
  case 上各一笔 payment。
- 两个 user 行：userA（role=agent, agent_id=A）、userB（role=agent, agent_id=B）；
  外加一个 manager user（无范围）。

## 断言

用 `src/utils/scope.js` 的 `caseWhere` / `reachableDebtorIds` / `reachableClientIds` +
直接对隔离库跑与路由**相同**的查询：

1. **Case 加载（loadCase 的范围子句）**：以 `caseWhere(userA)` 查 A 的 case → 命中 1 行；
   查 B 的 case id → 0 行（对应路由的 404/access-denied 路径）。
2. **Cases 列表**：`SELECT ... WHERE ${caseWhere(userA).clause}` 只返回 A 的 case，
   不含 B 的。
3. **可达 debtor / client**：`reachableDebtorIds(userA)` 不含 B 的 debtor id；
   `reachableClientIds(userA)` 不含 B 的 client id。
4. **Tasks 范围**：以 Tasks 页对 agent 的谓词（`agent_id = userA.agent_id`）查询，
   只返回 A 的 task，不含 B 的。
5. **管理员对照**：manager（`caseWhere` = `1=1`）能同时查到 A 和 B 的 case——证明
   过滤**唯一**来自范围子句，而不是数据本身就只有一条。

## 影响面

- 新增：`test/scope_boundary.test.js`。
- 不改任何生产代码（纯测试）。若断言过程中发现真实泄漏，另行修（本子项目仅加测试；
  发现 bug 则记录并单独处理）。

## 不做（YAGNI）

- 不为每个路由都写 HTTP 级测试——加载器/查询层是收口点。
- `client` 角色已从可用用户面移除，仅在 `caseWhere` 单测层覆盖，不在本文件重复。
- 不引入 supertest 或任何新测试依赖。
