> ## ✅ 已解决（2026-07-15，commit 15b15f9）
>
> **根因（唯一）**：`daysBetween`（`src/services/payments.js`）把毫秒差除以一天但**没取整**，`caseBalance` 用 `asOf = new Date()`，导致当天建的案子按**小数天数（挂钟时间）**计息，每次刷新页面持续累加。
>
> - RM9.24 = 借贷开始后 +2.66 小时；RM10.16 = +2.93 小时（已精确复现）。
> - 报告问题 1/2/3 = **同一个 bug**（小数天数）。
> - 问题 4（误用 Daily 分支）、问题 5（利率读成 0.55）= **误判**，利率 5%、monthly 分支都正确。
>
> **修复**：`daysBetween` 改为按马来西亚本地**整天**计算 → 当天 = 0 天 = 利息 0，利息每日跳一次。另在案件页与公式提示中明确「利息自借贷开始时间（Interest From）起算」。已加回归测试，91 个测试全绿。

# Debt Collection CRM 利息计算问题调查报告

## 案件资料

### 输入资料

| 项目 | 数值 |
|--------|--------|
| Principal Amount | RM50,000.00 |
| Interest Mode | Monthly Rate % |
| Interest Rate | 5 |
| Interest From | 14-Jul-2026 |
| Opened | 0 Days Ago |

---

## 系统规则设计

### 利息计算规则

| 模式 | 日利率 | 利息公式 |
|--------|--------|--------|
| Fixed 固定利息 | - | 欠款 = 本金 + 固定利息 - 已还款 |
| Monthly 月利率 | 月利率 ÷ 100 ÷ 30 | Σ(剩余本金 × 日利率 × 天数) |
| Daily 年利率 | 年利率 ÷ 100 ÷ 365 | Σ(剩余本金 × 日利率 × 天数) |

---

## 依照设计规则推算

### Monthly Rate = 5%

#### Step 1：计算日利率

```text
5 ÷ 100 ÷ 30
=
0.0016666667
```

#### Step 2：计算每日利息

```text
50,000 × 0.0016666667
=
RM83.33
```

---

## 预期结果

### 当天建立案件

若系统采用：

#### Exclusive（当天不计息）

```text
Interest = RM0.00
```

#### Inclusive（当天算一天）

```text
Interest = RM83.33
```

---

## 实际结果

系统曾出现：

```text
Interest = RM9.24
```

随后又出现：

```text
Interest = RM10.16
```

案件资料并无修改：

- Principal 相同
- Interest Rate 相同
- Interest From 相同
- Interest Mode 相同

但利息金额发生变化。

---

# 发现的问题

## 问题 1：利息计算结果不符合 Monthly Rate 公式

按照设计：

```text
每日利息应为 RM83.33
```

但系统显示：

```text
RM9.24
RM10.16
```

差距约：

```text
RM83.33
vs
RM10.16
```

误差超过 8 倍。

### 结论

系统实际执行逻辑与设计规则不一致。

---

## 问题 2：同一笔案件利息自动变化

观察结果：

```text
第一次：
Interest = RM9.24

之后：
Interest = RM10.16
```

期间：

- 未修改 Principal
- 未修改 Interest Rate
- 未修改 Interest Mode

### 结论

利息可能受系统时间影响实时变动。

---

## 问题 3：可能使用了小时计息

若代码类似：

```csharp
var elapsed = DateTime.Now - InterestFrom;
```

然后使用：

```csharp
elapsed.TotalHours
```

进行计算，

则每过数小时利息都会增加。

### 现象符合

```text
9.24 → 10.16
```

这种持续增长情况。

---

## 问题 4：可能误用了 Daily Mode 公式

设计要求：

```text
Monthly:
月利率 ÷ 30
```

但实际可能执行：

```text
年利率 ÷ 365
```

导致结果偏低。

需要检查：

```csharp
switch(InterestMode)
{
    case Monthly:
        ...
        break;

    case Daily:
        ...
        break;
}
```

是否正确进入 Monthly 分支。

---

## 问题 5：Interest Rate 读取错误

前端显示：

```text
Interest Rate = 5
```

但后台实际可能读取：

```text
0.55
```

或其他字段。

若读取约：

```text
0.55%
```

则每日利息约：

```text
50000 × 0.55% ÷ 30
≈ RM9.17
```

与系统显示：

```text
RM9.24
```

非常接近。

---

# 待验证项目

## 验证 1：利率是否真正参与计算

### 测试方法

将：

```text
Interest Rate = 5%
```

修改为：

```text
Interest Rate = 10%
```

---

### 预期结果

若公式正确：

```text
50,000 × 10% ÷ 30
=
RM166.67 / 天
```

应变为：

```text
Interest ≈ RM166.67
```

---

### 异常结果

若仍显示：

```text
RM10.xx
```

表示：

```text
Interest Rate 未参与计算
```

或读取错误。

---

## 验证 2：检查时间差计算方式

检查是否使用：

```csharp
DateTime.Now
```

以及：

```csharp
TimeSpan.TotalHours
```

或：

```csharp
TimeSpan.TotalMinutes
```

进行利息计算。

---

### 建议

改为：

```csharp
DateOnly
```

或：

```csharp
TimeSpan.TotalDays
```

并明确规定：

```text
当天是否计息
```

---

## 验证 3：检查 Monthly Mode 分支

检查：

```csharp
if (InterestMode == Monthly)
```

是否执行：

```csharp
dailyRate =
monthlyRate / 100 / 30;
```

而非：

```csharp
annualRate / 100 / 365;
```

---

## 验证 4：检查数据库字段

确认实际读取字段：

```text
InterestRate
MonthlyRate
AnnualRate
DailyRate
```

避免读取错误字段。

---

# 建议修正

## 标准 Monthly Rate 计算

```csharp
dailyRate = monthlyRate / 100m / 30m;

interest =
remainingPrincipal
*
dailyRate
*
elapsedDays;
```

---

## 当天建立案件

建议：

```text
elapsedDays = 0
Interest = 0
```

避免创建案件后立即产生利息。

---

# 需要开发团队提供

1. Interest Calculation Service
2. CalculateInterest() 方法
3. Interest Mode Enum
4. Interest Rate Database Field
5. Interest Schedule Table（若有）

提供上述代码后可进一步确认实际问题来源。