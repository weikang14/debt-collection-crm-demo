# calc-r2 run 2026-10-26

| 组 | 合计 | PASS | FAIL | INFO |
|---|---|---|---|---|
| INT | 55 | 52 | 3 | 0 |
| RULE | 1 | 0 | 0 | 0 |
| EDGE | 56 | 56 | 0 | 0 |
| ROUND | 18 | 12 | 6 | 0 |
| PAYV | 13 | 12 | 1 | 0 |
| ALLOC | 16 | 16 | 0 | 0 |
| EARLY | 22 | 22 | 0 | 0 |
| RS | 43 | 37 | 6 | 0 |
| CAP | 21 | 19 | 1 | 1 |
| PTP | 25 | 25 | 0 | 0 |
| DPD | 34 | 32 | 2 | 0 |
| COM | 16 | 13 | 3 | 0 |

| ID | 场景 | 算式 | 预期 | 实际 | 结果 | 备注 |
|---|---|---|---|---|---|---|
| INT#A0.interest | 示例A 无还款：合同利息 | 10000 × 1.5% × 12 个月 | 1800.00 | 1800.00 | PASS |  |
| INT#A0.outstanding | 示例A 无还款：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11800.00 | 11800.00 | PASS |  |
| INT#A0.settlement | 示例A 无还款：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 11470.97 | 11470.97 | PASS |  |
| INT#A0.dpd | 示例A 无还款：DPD | 最早未还清期到期日 → 今天（D-09） | 267 | 267 | PASS |  |
| INT#A0.overdue | 示例A 无还款：Overdue | Σ 已到期未还（计划 FIFO） | 1350.00 | 1350.00 | PASS |  |
| INT#A0.maturity | 示例A 无还款：Maturity | 起始日 + 期限月（月末对齐） | 2027-01-01 | 2027-01-01 | PASS |  |
| INT#A0.schedule | 示例A 无还款：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/150.00/0.00/150.00/Overdue … 2027-01-01/10150.00/0.00/10150.00/Pending | 一致（12 行） | PASS |  |
| INT#A0.settle.formula | 示例A 今日结清额的算式 | 10000 + 10000×1.5%×(9 + 24/31) | 11466.13 | 11470.97 | FAIL |  |
| INT#A0.stmt | 示例A 对账单 = 案件页（合同欠款/结清额/逾期/DPD） | 同一案件同一天 | 11800.00/11470.97/1350.00/267 | 11800.00/11470.97/1350.00/267 | PASS |  |
| INT#A0.paymax | 示例A Record Payment 弹窗 max = 今日结清额 |  | 11470.97 | label 11470.97 attr 11470.97 | PASS |  |
| INT#A1.reject11800 | 示例A 03-02 还合同全额 11,800（PAY-17） | 应拒收；上限 = 10000 + 10000×1.5%×(2+1/31) | 10304.84 | 10304.84 | PASS |  |
| INT#A1.outstanding | 示例A 03-02 还 1,000：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10696.06 | 10696.06 | PASS |  |
| INT#A1.interest | 示例A 03-02 还 1,000：Interest | 已收利息 + 未收利息（合同期） | 1696.06 | 1696.06 | PASS |  |
| INT#A1.paid | 示例A 03-02 还 1,000：Paid | Σ 还款 | 1000.00 | 1000.00 | PASS |  |
| INT#A1.settlement | 示例A 03-02 还 1,000：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 10389.90 | 10389.90 | PASS |  |
| INT#A1.dpd | 示例A 03-02 还 1,000：DPD | 最早未还清期到期日 → 今天（D-09） | 86 | 86 | PASS |  |
| INT#A1.overdue | 示例A 03-02 还 1,000：Overdue | Σ 已到期未还（计划 FIFO） | 350.00 | 350.00 | PASS |  |
| INT#A1.schedule | 示例A 03-02 还 1,000：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/150.00/150.00/0.00/Paid … 2027-01-01/10150.00/0.00/10150.00/Pending | 一致（12 行） | PASS |  |
| INT#A1.drop | PAY-15 欠款降幅 | 11800 − 10696.06 | 1103.94 | 1103.94 | PASS |  |
| INT#A1.sett0615 | 5.2 示例A 06-15 结清额（用超额拦截提示探测） | 9304.84 + 9304.84×1.5%×(5+14/30−2−1/31) | 9784.19 | 9784.19 | PASS |  |
| INT#C3.outstanding | 示例C：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10450.00 | 10450.00 | PASS |  |
| INT#C3.interest | 示例C：Interest | 已收利息 + 未收利息（合同期） | 450.00 | 450.00 | PASS |  |
| INT#C3.settlement | 示例C：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 10450.00 | 10450.00 | PASS |  |
| INT#C3.dpd | 示例C：DPD | 最早未还清期到期日 → 今天（D-09） | 267 | 267 | PASS |  |
| INT#C3.overdue | 示例C：Overdue | Σ 已到期未还（计划 FIFO） | 10450.00 | 10450.00 | PASS |  |
| INT#C3.maturity | 示例C：Maturity | 起始日 + 期限月（月末对齐） | 2026-04-01 | 2026-04-01 | PASS |  |
| INT#C3.schedule | 示例C：还款计划 3 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/150.00/0.00/150.00/Overdue … 2026-04-01/10150.00/0.00/10150.00/Overdue | 一致（3 行） | PASS |  |
| INT#G.outstanding | 示例G Annual 36,500×18%：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 43070.00 | 43070.00 | PASS |  |
| INT#G.interest | 示例G Annual 36,500×18%：Interest | 已收利息 + 未收利息（合同期） | 6570.00 | 6570.00 | PASS |  |
| INT#G.settlement | 示例G Annual 36,500×18%：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 41864.00 | 41864.00 | PASS |  |
| INT#G.dpd | 示例G Annual 36,500×18%：DPD | 最早未还清期到期日 → 今天（D-09） | 267 | 267 | PASS |  |
| INT#G.overdue | 示例G Annual 36,500×18%：Overdue | Σ 已到期未还（计划 FIFO） | 4914.00 | 4914.00 | PASS |  |
| INT#G.schedule | 示例G Annual 36,500×18%：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/558.00/0.00/558.00/Overdue … 2027-01-01/37058.00/0.00/37058.00/Pending | 一致（12 行） | PASS |  |
| INT#D1.outstanding | 示例D Fixed 1,000/3 期 起 01-31：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 1000.00 | 1000.00 | PASS |  |
| INT#D1.dpd | 示例D Fixed 1,000/3 期 起 01-31：DPD | 最早未还清期到期日 → 今天（D-09） | 240 | 240 | PASS |  |
| INT#D1.overdue | 示例D Fixed 1,000/3 期 起 01-31：Overdue | Σ 已到期未还（计划 FIFO） | 1000.00 | 1000.00 | PASS |  |
| INT#D1.schedule | 示例D Fixed 1,000/3 期 起 01-31：还款计划 3 行（到期日/应还/已还/未还/状态） |  | 2026-02-28/333.33/0.00/333.33/Overdue … 2026-04-30/333.34/0.00/333.34/Overdue | 一致（3 行） | PASS |  |
| INT#D2.outstanding | 示例D Fixed 11,200/12 还 2,000：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 9200.00 | 9200.00 | PASS |  |
| INT#D2.settlement | 示例D Fixed 11,200/12 还 2,000：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 9200.00 | 9200.00 | PASS |  |
| INT#D2.dpd | 示例D Fixed 11,200/12 还 2,000：DPD | 最早未还清期到期日 → 今天（D-09） | 208 | 208 | PASS |  |
| INT#D2.overdue | 示例D Fixed 11,200/12 还 2,000：Overdue | Σ 已到期未还（计划 FIFO） | 6399.97 | 6399.97 | PASS |  |
| INT#D2.schedule | 示例D Fixed 11,200/12 还 2,000：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/933.33/933.33/0.00/Paid … 2027-01-01/933.37/0.00/933.37/Pending | 一致（12 行） | PASS |  |
| INT#D2.pay | SCH-07 Pay 预填 | min(最早未还期 799.99, 结清额 9,200) | 799.99 | 799.99 | PASS |  |
| INT#E0.dpd | 示例E 未还款（今天）：DPD | 最早未还清期到期日 → 今天（D-09） | 267 | 267 | PASS |  |
| INT#E0.overdue | 示例E 未还款（今天）：Overdue | Σ 已到期未还（计划 FIFO） | 900.00 | 900.00 | PASS |  |
| INT#E1.dpd | 示例E 再还 150：DPD | 最早未还清期到期日 → 今天（D-09） | 239 | 239 | PASS |  |
| INT#E1.overdue | 示例E 再还 150：Overdue | Σ 已到期未还（计划 FIFO） | 750.00 | 750.00 | PASS |  |
| INT#E1.schedule | 示例E 再还 150：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/100.00/100.00/0.00/Paid … 2027-01-01/100.00/0.00/100.00/Pending | 一致（12 行） | PASS |  |
| RULE#N-02 | 起始=今天 无期限：v1.11.0 起不填期限被拒 |  | v1.10.0 允许 | Tenure is required for a loan that charges interest | RULE-CHANGE | 改用 tenure=12 继续 |
| INT#INT07 | INT-07 起始=今天、无期限：利息 | 同一天 0 天 | 0.00 | 1800.00 | FAIL |  |
| INT#INT07.dpd | INT-07 无计划：DPD/Overdue 不显示 | null | null | 0 | FAIL |  |
| INT#SHORT.outstanding | 1 个月贷款 起 10-01：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10150.00 | 10150.00 | PASS |  |
| INT#SHORT.settlement | 1 个月贷款 起 10-01：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 10120.97 | 10120.97 | PASS |  |
| INT#SHORT.maturity | 1 个月贷款 起 10-01：Maturity | 起始日 + 期限月（月末对齐） | 2026-11-01 | 2026-11-01 | PASS |  |
| INT#SHORT.dpd | 1 个月贷款 起 10-01：DPD | 最早未还清期到期日 → 今天（D-09） | 0 | 0 | PASS |  |
| INT#SHORT.schedule | 1 个月贷款 起 10-01：还款计划 1 行（到期日/应还/已还/未还/状态） |  | 2026-11-01/10150.00/0.00/10150.00/Pending … 2026-11-01/10150.00/0.00/10150.00/Pending | 一致（1 行） | PASS |  |
| EDGE#闰年 起2024-01-31 3期.outstanding | 闰年 起2024-01-31 3期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10450.00 | 10450.00 | PASS |  |
| EDGE#闰年 起2024-01-31 3期.interest | 闰年 起2024-01-31 3期：Interest | 已收利息 + 未收利息（合同期） | 450.00 | 450.00 | PASS |  |
| EDGE#闰年 起2024-01-31 3期.maturity | 闰年 起2024-01-31 3期：Maturity | 起始日 + 期限月（月末对齐） | 2024-04-30 | 2024-04-30 | PASS |  |
| EDGE#闰年 起2024-01-31 3期.schedule | 闰年 起2024-01-31 3期：还款计划 3 行（到期日/应还/已还/未还/状态） |  | 2024-02-29/150.00/0.00/150.00/Overdue … 2024-04-30/10150.00/0.00/10150.00/Overdue | 一致（3 行） | PASS |  |
| EDGE#闰年 起2024-01-31 3期@2024-02-29 | 闰年 起2024-01-31 3期：2024-02-29 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2024-01-31→2024-02-29) | 10150.00 | 10150.00 | PASS |  |
| EDGE#闰年 起2024-01-31 3期@2024-03-01 | 闰年 起2024-01-31 3期：2024-03-01 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2024-01-31→2024-03-01) | 10154.84 | 10154.84 | PASS |  |
| EDGE#闰年 起2024-01-31 3期@2024-03-30 | 闰年 起2024-01-31 3期：2024-03-30 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2024-01-31→2024-03-30) | 10295.16 | 10295.16 | PASS |  |
| EDGE#闰年 起2024-01-31 3期@2024-03-31 | 闰年 起2024-01-31 3期：2024-03-31 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2024-01-31→2024-03-31) | 10300.00 | 10300.00 | PASS |  |
| EDGE#平年 起2026-01-31 3期.outstanding | 平年 起2026-01-31 3期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10450.00 | 10450.00 | PASS |  |
| EDGE#平年 起2026-01-31 3期.interest | 平年 起2026-01-31 3期：Interest | 已收利息 + 未收利息（合同期） | 450.00 | 450.00 | PASS |  |
| EDGE#平年 起2026-01-31 3期.maturity | 平年 起2026-01-31 3期：Maturity | 起始日 + 期限月（月末对齐） | 2026-04-30 | 2026-04-30 | PASS |  |
| EDGE#平年 起2026-01-31 3期.schedule | 平年 起2026-01-31 3期：还款计划 3 行（到期日/应还/已还/未还/状态） |  | 2026-02-28/150.00/0.00/150.00/Overdue … 2026-04-30/10150.00/0.00/10150.00/Overdue | 一致（3 行） | PASS |  |
| EDGE#平年 起2026-01-31 3期@2026-02-28 | 平年 起2026-01-31 3期：2026-02-28 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2026-01-31→2026-02-28) | 10150.00 | 10150.00 | PASS |  |
| EDGE#平年 起2026-01-31 3期@2026-03-01 | 平年 起2026-01-31 3期：2026-03-01 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2026-01-31→2026-03-01) | 10154.84 | 10154.84 | PASS |  |
| EDGE#平年 起2026-01-31 3期@2026-03-30 | 平年 起2026-01-31 3期：2026-03-30 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2026-01-31→2026-03-30) | 10295.16 | 10295.16 | PASS |  |
| EDGE#平年 起2026-01-31 3期@2026-03-31 | 平年 起2026-01-31 3期：2026-03-31 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2026-01-31→2026-03-31) | 10300.00 | 10300.00 | PASS |  |
| EDGE#起2026-01-30 3期.outstanding | 起2026-01-30 3期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10450.00 | 10450.00 | PASS |  |
| EDGE#起2026-01-30 3期.interest | 起2026-01-30 3期：Interest | 已收利息 + 未收利息（合同期） | 450.00 | 450.00 | PASS |  |
| EDGE#起2026-01-30 3期.maturity | 起2026-01-30 3期：Maturity | 起始日 + 期限月（月末对齐） | 2026-04-30 | 2026-04-30 | PASS |  |
| EDGE#起2026-01-30 3期.schedule | 起2026-01-30 3期：还款计划 3 行（到期日/应还/已还/未还/状态） |  | 2026-02-28/150.00/0.00/150.00/Overdue … 2026-04-30/10150.00/0.00/10150.00/Overdue | 一致（3 行） | PASS |  |
| EDGE#起2026-01-30 3期@2026-02-28 | 起2026-01-30 3期：2026-02-28 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2026-01-30→2026-02-28) | 10150.00 | 10150.00 | PASS |  |
| EDGE#起2026-01-30 3期@2026-03-01 | 起2026-01-30 3期：2026-03-01 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2026-01-30→2026-03-01) | 10155.00 | 10155.00 | PASS |  |
| EDGE#起2026-01-30 3期@2026-03-29 | 起2026-01-30 3期：2026-03-29 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2026-01-30→2026-03-29) | 10295.00 | 10295.00 | PASS |  |
| EDGE#闰年 起2024-02-29 12期.outstanding | 闰年 起2024-02-29 12期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11800.00 | 11800.00 | PASS |  |
| EDGE#闰年 起2024-02-29 12期.interest | 闰年 起2024-02-29 12期：Interest | 已收利息 + 未收利息（合同期） | 1800.00 | 1800.00 | PASS |  |
| EDGE#闰年 起2024-02-29 12期.maturity | 闰年 起2024-02-29 12期：Maturity | 起始日 + 期限月（月末对齐） | 2025-02-28 | 2025-02-28 | PASS |  |
| EDGE#闰年 起2024-02-29 12期.schedule | 闰年 起2024-02-29 12期：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2024-03-29/150.00/0.00/150.00/Overdue … 2025-02-28/10150.00/0.00/10150.00/Overdue | 一致（12 行） | PASS |  |
| EDGE#闰年 起2024-02-29 12期@2024-03-28 | 闰年 起2024-02-29 12期：2024-03-28 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2024-02-29→2024-03-28) | 10144.83 | 10144.83 | PASS |  |
| EDGE#闰年 起2024-02-29 12期@2024-03-29 | 闰年 起2024-02-29 12期：2024-03-29 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2024-02-29→2024-03-29) | 10150.00 | 10150.00 | PASS |  |
| EDGE#闰年 起2024-02-29 12期@2025-02-27 | 闰年 起2024-02-29 12期：2025-02-27 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2024-02-29→2025-02-27) | 11795.00 | 11795.00 | PASS |  |
| EDGE#跨闰2月 起2023-12-01 12期.outstanding | 跨闰2月 起2023-12-01 12期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11800.00 | 11800.00 | PASS |  |
| EDGE#跨闰2月 起2023-12-01 12期.interest | 跨闰2月 起2023-12-01 12期：Interest | 已收利息 + 未收利息（合同期） | 1800.00 | 1800.00 | PASS |  |
| EDGE#跨闰2月 起2023-12-01 12期.maturity | 跨闰2月 起2023-12-01 12期：Maturity | 起始日 + 期限月（月末对齐） | 2024-12-01 | 2024-12-01 | PASS |  |
| EDGE#跨闰2月 起2023-12-01 12期.schedule | 跨闰2月 起2023-12-01 12期：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2024-01-01/150.00/0.00/150.00/Overdue … 2024-12-01/10150.00/0.00/10150.00/Overdue | 一致（12 行） | PASS |  |
| EDGE#跨闰2月 起2023-12-01 12期@2024-02-15 | 跨闰2月 起2023-12-01 12期：2024-02-15 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2023-12-01→2024-02-15) | 10372.41 | 10372.41 | PASS |  |
| EDGE#跨闰2月 起2023-12-01 12期@2024-03-01 | 跨闰2月 起2023-12-01 12期：2024-03-01 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2023-12-01→2024-03-01) | 10450.00 | 10450.00 | PASS |  |
| EDGE#跨闰2月 起2023-12-01 12期@2024-03-15 | 跨闰2月 起2023-12-01 12期：2024-03-15 结清额（超额拦截提示） | 10000 × 1.5% × 月数(2023-12-01→2024-03-15) | 10517.74 | 10517.74 | PASS |  |
| EDGE#闰年 起2024-01-31 1期.outstanding | 闰年 起2024-01-31 1期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10150.00 | 10150.00 | PASS |  |
| EDGE#闰年 起2024-01-31 1期.interest | 闰年 起2024-01-31 1期：Interest | 已收利息 + 未收利息（合同期） | 150.00 | 150.00 | PASS |  |
| EDGE#闰年 起2024-01-31 1期.maturity | 闰年 起2024-01-31 1期：Maturity | 起始日 + 期限月（月末对齐） | 2024-02-29 | 2024-02-29 | PASS |  |
| EDGE#闰年 起2024-01-31 1期.schedule | 闰年 起2024-01-31 1期：还款计划 1 行（到期日/应还/已还/未还/状态） |  | 2024-02-29/10150.00/0.00/10150.00/Overdue … 2024-02-29/10150.00/0.00/10150.00/Overdue | 一致（1 行） | PASS |  |
| EDGE#Annual 起2024-01-01 12期（366天）.outstanding | Annual 起2024-01-01 12期（366天）：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 43088.00 | 43088.00 | PASS |  |
| EDGE#Annual 起2024-01-01 12期（366天）.interest | Annual 起2024-01-01 12期（366天）：Interest | 已收利息 + 未收利息（合同期） | 6588.00 | 6588.00 | PASS |  |
| EDGE#Annual 起2024-01-01 12期（366天）.maturity | Annual 起2024-01-01 12期（366天）：Maturity | 起始日 + 期限月（月末对齐） | 2025-01-01 | 2025-01-01 | PASS |  |
| EDGE#Annual 起2024-01-01 12期（366天）.schedule | Annual 起2024-01-01 12期（366天）：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2024-02-01/558.00/0.00/558.00/Overdue … 2025-01-01/37058.00/0.00/37058.00/Overdue | 一致（12 行） | PASS |  |
| EDGE#Annual 起2024-01-01 12期（366天）@2024-02-29 | Annual 起2024-01-01 12期（366天）：2024-02-29 结清额（超额拦截提示） | 36500 × 18% × 月数(2024-01-01→2024-02-29) | 37562.00 | 37562.00 | PASS |  |
| EDGE#Annual 起2024-01-01 12期（366天）@2024-12-31 | Annual 起2024-01-01 12期（366天）：2024-12-31 结清额（超额拦截提示） | 36500 × 18% × 月数(2024-01-01→2024-12-31) | 43070.00 | 43070.00 | PASS |  |
| EDGE#FUT-M.outstanding | 未来闰年 Monthly 起2027-12-01 12期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11800.00 | 11800.00 | PASS |  |
| EDGE#FUT-M.interest | 未来闰年 Monthly 起2027-12-01 12期：Interest | 已收利息 + 未收利息（合同期） | 1800.00 | 1800.00 | PASS |  |
| EDGE#FUT-M.maturity | 未来闰年 Monthly 起2027-12-01 12期：Maturity | 起始日 + 期限月（月末对齐） | 2028-12-01 | 2028-12-01 | PASS |  |
| EDGE#FUT-M.schedule | 未来闰年 Monthly 起2027-12-01 12期：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2028-01-01/150.00/0.00/150.00/Pending … 2028-12-01/10150.00/0.00/10150.00/Pending | 一致（12 行） | PASS |  |
| EDGE#FUT-D.outstanding | 未来闰年 Annual 起2027-12-01 12期（366天 ÷365）：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 43088.00 | 43088.00 | PASS |  |
| EDGE#FUT-D.interest | 未来闰年 Annual 起2027-12-01 12期（366天 ÷365）：Interest | 已收利息 + 未收利息（合同期） | 6588.00 | 6588.00 | PASS |  |
| EDGE#FUT-D.maturity | 未来闰年 Annual 起2027-12-01 12期（366天 ÷365）：Maturity | 起始日 + 期限月（月末对齐） | 2028-12-01 | 2028-12-01 | PASS |  |
| EDGE#FUT-D.eff | 同上：实际年化（366/365×18%） | 6588 ÷ 36500 | 18.05 | 18.05 | PASS | 规则如此（闰年 ÷366 待律师确认） |
| EDGE#FUTPAY | 明天日期的还款 | 拒收 | Payment date cannot be in the future | Payment date cannot be in the future | PASS |  |
| ROUND#P1015.int | P=1015 1 个月利息 | 1015 × 1.5% = 609/40 | 15.23 | 15.23 | PASS |  |
| ROUND#P1015.out | P=1015 合同欠款 | 1015 + 1015×1.5%（half-up） | 1030.23 | 1030.22 | FAIL |  |
| ROUND#P1015.ident | P=1015 恒等式 Principal + Interest = Outstanding（页面） | 应相等 | 1030.22 | 1030.23 | FAIL |  |
| ROUND#P1015.sett | P=1015 今日结清额 | 同上（今天到期） | 1030.23 | 1030.22 | FAIL |  |
| ROUND#P1079.int | P=1079 1 个月利息 | 1079 × 1.5% = 3237/200 | 16.19 | 16.18 | FAIL |  |
| ROUND#P1079.out | P=1079 合同欠款 | 1079 + 1079×1.5%（half-up） | 1095.19 | 1095.19 | PASS |  |
| ROUND#P1079.ident | P=1079 恒等式 Principal + Interest = Outstanding（页面） | 应相等 | 1095.19 | 1095.18 | FAIL |  |
| ROUND#P1079.sett | P=1079 今日结清额 | 同上（今天到期） | 1095.19 | 1095.19 | PASS |  |
| ROUND#P1001.int | P=1001 1 个月利息 | 1001 × 1.5% = 3003/200 | 15.02 | 15.02 | PASS |  |
| ROUND#P1001.out | P=1001 合同欠款 | 1001 + 1001×1.5%（half-up） | 1016.02 | 1016.02 | PASS |  |
| ROUND#P1001.ident | P=1001 恒等式 Principal + Interest = Outstanding（页面） | 应相等 | 1016.02 | 1016.02 | PASS |  |
| ROUND#P1001.sett | P=1001 今日结清额 | 同上（今天到期） | 1016.02 | 1016.02 | PASS |  |
| ROUND#P3001.int | P=3001 1 个月利息 | 3001 × 1.5% = 9003/200 | 45.02 | 45.02 | PASS |  |
| ROUND#P3001.out | P=3001 合同欠款 | 3001 + 3001×1.5%（half-up） | 3046.02 | 3046.02 | PASS |  |
| ROUND#P3001.ident | P=3001 恒等式 Principal + Interest = Outstanding（页面） | 应相等 | 3046.02 | 3046.02 | PASS |  |
| ROUND#P3001.sett | P=3001 今日结清额 | 同上（今天到期） | 3046.02 | 3046.02 | PASS |  |
| ROUND#P1015.payShown | P=1015 按页面显示的结清额 1030.22 还款后应结清 |  | Outstanding 0.00 / Fully Paid | Payment RCPT-2026-0004 recorded; Outstanding 0.00; Fully Paid | PASS |  |
| ROUND#P1015.payHalfUp | P=1015 还 1,030.23（精确 1,030.225 四舍五入） |  | 接受（超出 0.005 在容差内）并 Fully Paid | Amount exceeds outstanding; New; Outstanding 1030.22 | FAIL |  |
| PAYV#amt=0 | 还款金额 0 | 拒收 | Invalid amount | Invalid amount | PASS |  |
| PAYV#amt=-5 | 还款金额 -5 | 拒收 | Invalid amount | Invalid amount | PASS |  |
| PAYV#amt=0.001 | 还款金额 0.001 | 拒收 | Invalid amount | Invalid amount | PASS |  |
| PAYV#amt=100.004 | 还款金额 100.004 | 拒收 | Invalid amount | Invalid amount | PASS |  |
| PAYV#amt=1e2 | 还款金额 1e2 | 拒收 | Invalid amount | Invalid amount | PASS |  |
| PAYV#amt=1000.01 | 还款金额 1000.01 | 拒收 | Amount exceeds outstanding | Amount exceeds outstanding | PASS |  |
| PAYV#date=02-30 | 还款日期 2026-02-30 | 拒收 | Invalid payment date | Invalid payment date | PASS |  |
| PAYV#method | 非法还款方式 | 拒收 | Invalid payment method | Invalid payment method | PASS |  |
| PAYV#sett+0.01 | 今日结清额 11470.97 + 0.01 | 拒收，提示上限 = 结清额 | 11470.97 | 11470.97 | PASS |  |
| PAYV#chain.hintOk | 按提示金额 727.96 补录时 06-01 那笔的超额 | 提示金额本身可接受（超额 0） | 0.00 | 0.00 | PASS |  |
| PAYV#chain.hint | 已有 06-01 还 10,000，补录 03-02 的 800：拒收提示中的上限 | 独立计算：使 06-01 那笔不超过其当日结清额的最大补录额 | 731.03 | 727.96 | FAIL | 提示按线性扣减计算，未考虑补录额变小会增加后续利息 |
| PAYV#chain.max | 按独立计算的上限 731.03 补录 |  | 接受 | Payment RCPT-2026-0006 recorded | PASS |  |
| PAYV#beforeStart | B-16 起息日（2026-06-01）之前的还款 05-01 |  | 拒收（业务预期；F-20 范围） | Payment date cannot be before the loan start date (2026-06-01) | PASS |  |
| ALLOC#P200.outstanding | 03-02 还 200（< 已计利息 304.84）：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11600.00 | 11600.00 | PASS |  |
| ALLOC#P200.interest | 03-02 还 200（< 已计利息 304.84）：Interest | 已收利息 + 未收利息（合同期） | 1800.00 | 1800.00 | PASS |  |
| ALLOC#P200.settlement | 03-02 还 200（< 已计利息 304.84）：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 11270.97 | 11270.97 | PASS |  |
| ALLOC#P200.split | 03-02 的 200 全部冲利息 | toInterest | 200.00 | 200.00 | PASS |  |
| ALLOC#ORDER.outstanding | 先录 05-01 的 500、后补录 03-02 的 1,000：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10169.02 | 10169.02 | PASS |  |
| ALLOC#ORDER.interest | 先录 05-01 的 500、后补录 03-02 的 1,000：Interest | 已收利息 + 未收利息（合同期） | 1669.02 | 1669.02 | PASS |  |
| ALLOC#ORDER.settlement | 先录 05-01 的 500、后补录 03-02 的 1,000：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 9870.28 | 9870.28 | PASS |  |
| ALLOC#ORDER.schedule | 先录 05-01 的 500、后补录 03-02 的 1,000：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/150.00/150.00/0.00/Paid … 2027-01-01/10150.00/0.00/10150.00/Pending | 一致（12 行） | PASS |  |
| ALLOC#AFTERMAT.outstanding | 到期（2025-04-01）后 2026-10-01 还 500：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 9950.00 | 9950.00 | PASS |  |
| ALLOC#AFTERMAT.interest | 到期（2025-04-01）后 2026-10-01 还 500：Interest | 已收利息 + 未收利息（合同期） | 450.00 | 450.00 | PASS |  |
| ALLOC#AFTERMAT.settlement | 到期（2025-04-01）后 2026-10-01 还 500：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 9950.00 | 9950.00 | PASS |  |
| ALLOC#AFTERMAT.dpd | 到期（2025-04-01）后 2026-10-01 还 500：DPD | 最早未还清期到期日 → 今天（D-09） | 573 | 573 | PASS |  |
| ALLOC#AFTERMAT.overdue | 到期（2025-04-01）后 2026-10-01 还 500：Overdue | Σ 已到期未还（计划 FIFO） | 9950.00 | 9950.00 | PASS |  |
| ALLOC#INTONLY.outstanding | 03-02 恰好还已计利息 304.84：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11495.16 | 11495.16 | PASS |  |
| ALLOC#INTONLY.interest | 03-02 恰好还已计利息 304.84：Interest | 已收利息 + 未收利息（合同期） | 1800.00 | 1800.00 | PASS |  |
| ALLOC#INTONLY.settlement | 03-02 恰好还已计利息 304.84：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 11166.13 | 11166.13 | PASS |  |
| EARLY#A+0.01 | 03-02 还 10,304.85（结清额 + 0.01） | 拒收 | 10304.84 | 10304.84 | PASS |  |
| EARLY#A.outstanding | 03-02 还 10,304.84 结清：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 0.00 | 0.00 | PASS |  |
| EARLY#A.interest | 03-02 还 10,304.84 结清：Interest | 已收利息 + 未收利息（合同期） | 304.84 | 304.84 | PASS |  |
| EARLY#A.paid | 03-02 还 10,304.84 结清：Paid | Σ 还款 | 10304.84 | 10304.84 | PASS |  |
| EARLY#A.recovered | 03-02 还 10,304.84 结清：% recovered | round(已还 ÷ (本金+利息)) | 100 | 100 | PASS |  |
| EARLY#A.schedule | 03-02 还 10,304.84 结清：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-02-01/150.00/150.00/0.00/Paid … 2027-01-01/10150.00/8654.84/0.00/Paid | 一致（12 行） | PASS |  |
| EARLY#A.status | 状态 |  | Fully Paid | Fully Paid | PASS |  |
| EARLY#EDIT+0.01 | 把 03-02 的 1,000 改为 10,304.85 | 拒收（上限 = 当日结清额） | 10304.84 | 10304.84 | PASS |  |
| EARLY#EDIT=sett | 改为 10,304.84 |  | 接受，Fully Paid，Outstanding 0.00 | Payment updated; Fully Paid; 0.00 | PASS |  |
| EARLY#E2E.afterPtp | PTP 1,000 当天履行后今日结清额 | 10000 − 1000（当天利息 0） | 9000.00 | 9000.00 | PASS |  |
| EARLY#E2E.status1 | 履行后状态 |  | Partial Paid | Partial Paid | PASS |  |
| EARLY#E2E.payPrefill | 计划 Pay 预填（最早未还清期 = 第 7 期 2027-05-26） | min(该期未还, 今日结清额)；PTP 的 1,000 已按 FIFO 冲掉前 6 期 | 50.00 | 50.00 | PASS |  |
| EARLY#E2E.paidAhead | PTP 1,000 当天全部冲本金后，计划前 6 期显示 Paid |  | 记录现状（见 B2 发现：计划 FIFO 与账本口径不一致） | Paid,Paid,Paid,Paid,Paid,Paid,Partially Paid | PASS |  |
| EARLY#E2E.max | 再看 max（今日结清额） | 9000 − 50.00 | 8950.00 | 8950.00 | PASS |  |
| EARLY#E2E.outstanding | E2E-01 用 max 还清后：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 0.00 | 0.00 | PASS |  |
| EARLY#E2E.interest | E2E-01 用 max 还清后：Interest | 已收利息 + 未收利息（合同期） | 0.00 | 0.00 | PASS |  |
| EARLY#E2E.paid | E2E-01 用 max 还清后：Paid | Σ 还款 | 10000.00 | 10000.00 | PASS |  |
| EARLY#E2E.recovered | E2E-01 用 max 还清后：% recovered | round(已还 ÷ (本金+利息)) | 100 | 100 | PASS |  |
| EARLY#E2E.schedule | E2E-01 用 max 还清后：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-11-26/150.00/150.00/0.00/Paid … 2027-10-26/10150.00/8350.00/0.00/Paid | 一致（12 行） | PASS |  |
| EARLY#E2E.status | E2E-01 状态 |  | Fully Paid | Fully Paid | PASS |  |
| EARLY#FIXED.sett | Fixed 11,200 第 2 个月的今日结清额 | Fixed 全额（D-02 演示前维持） | 11200.00 | 11200.00 | PASS |  |
| EARLY#FIXED+0.01 | Fixed 还 11,200.01 | 拒收 | Amount exceeds outstanding | Amount exceeds outstanding | PASS |  |
| RS#B.ok | 示例B 重组提交 |  | Restructured | Restructured | PASS |  |
| RS#B.cut | 示例B 截点本金 / 挂账欠息 | 9304.84 / 9304.84×1.5%×30/31 | 9304.84/135.07 | 9304.84/135.07 | PASS |  |
| RS#B.outstanding | 示例B 重组后：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11449.75 | 11449.75 | PASS |  |
| RS#B.interest | 示例B 重组后：Interest | 已收利息 + 未收利息（合同期） | 2449.75 | 2449.75 | PASS |  |
| RS#B.maturity | 示例B 重组后：Maturity | 起始日 + 期限月（月末对齐） | 2027-10-01 | 2027-10-01 | PASS |  |
| RS#B.settlement | 示例B 重组后：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 10199.90 | 10199.90 | PASS |  |
| RS#B.dpd | 示例B 重组后：DPD | 最早未还清期到期日 → 今天（D-09） | 208 | 178 | FAIL |  |
| RS#B.overdue | 示例B 重组后：Overdue | Σ 已到期未还（计划 FIFO） | 805.03 | 805.03 | PASS |  |
| RS#B.schedule | 示例B 重组后：还款计划 19 行（到期日/应还/已还/未还/状态） |  | 2026-04-01/135.07/0.00/135.07/Overdue … 2027-10-01/9416.50/0.00/9416.50/Pending | #1 预期 2026-04-01/135.07/0.00/135.07/Overdue / 实际 2026-05-01/135.07/0.00/135.07/Overdue | FAIL |  |
| RS#B.payOnEff | 重组后补录生效日当天（04-01）的还款 | 拒收（D-04：新还款须晚于生效日） | Payment date must be after the restructure date (2026-04-01) | Payment date must be after the restructure date (2026-04-01) | PASS |  |
| RS#B2.outstanding | 示例B 重组后 05-01 还 500：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10898.09 | 10898.09 | PASS |  |
| RS#B2.interest | 示例B 重组后 05-01 还 500：Interest | 已收利息 + 未收利息（合同期） | 2398.09 | 2398.09 | PASS |  |
| RS#B2.settlement | 示例B 重组后 05-01 还 500：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 9682.26 | 9682.26 | PASS |  |
| RS#B2.dpd | 示例B 重组后 05-01 还 500：DPD | 最早未还清期到期日 → 今天（D-09） | 86 | 86 | PASS |  |
| RS#B2.overdue | 示例B 重组后 05-01 还 500：Overdue | Σ 已到期未还（计划 FIFO） | 305.03 | 305.03 | PASS |  |
| RS#B2.schedule | 示例B 重组后 05-01 还 500：还款计划 19 行（到期日/应还/已还/未还/状态） |  | 2026-04-01/135.07/135.07/0.00/Paid … 2027-10-01/9416.50/0.00/9416.50/Pending | #1 预期 2026-04-01/135.07/135.07/0.00/Paid / 实际 2026-05-01/135.07/135.07/0.00/Paid | FAIL |  |
| RS#SAME.cut | 06-01 还 5,000 后以 06-01 重组：截点 | 本金 10000 −（5000 − 10000×1.5%×5）；挂账 0 | 5750.00/0.00 | 5750.00/0.00 | PASS |  |
| RS#SAME.outstanding | 同日还款后重组：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 6785.00 | 6785.00 | PASS |  |
| RS#SAME.interest | 同日还款后重组：Interest | 已收利息 + 未收利息（合同期） | 1785.00 | 1785.00 | PASS |  |
| RS#SAME.settlement | 同日还款后重组：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 6164.56 | 6164.56 | PASS |  |
| RS#SAME.dpd | 同日还款后重组：DPD | 最早未还清期到期日 → 今天（D-09） | 117 | 117 | PASS |  |
| RS#SAME.overdue | 同日还款后重组：Overdue | Σ 已到期未还（计划 FIFO） | 345.00 | 345.00 | PASS |  |
| RS#SAME.schedule | 同日还款后重组：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-07-01/86.25/0.00/86.25/Overdue … 2027-06-01/5836.25/0.00/5836.25/Pending | 一致（12 行） | PASS |  |
| RS#SAME.undo | RS-16 生效日当天的还款不阻止撤销（有 Undo 按钮） |  | Undo 可见 | Undo 可见 | PASS |  |
| RS#TODAY.dialog | RS-02/25 今天还 2,000 后重组弹窗“截至今天” | 本金 10000 −（2000 − 150）；未付利息 0 | 8150.00/0.00 | 8150.00/0.00 | PASS |  |
| RS#TODAY.outstanding | 今天还款后今天重组：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 9323.60 | 9323.60 | PASS |  |
| RS#TODAY.settlement | 今天还款后今天重组：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 8150.00 | 8150.00 | PASS |  |
| RS#TODAY.schedule | 今天还款后今天重组：还款计划 12 行（到期日/应还/已还/未还/状态） |  | 2026-11-26/97.80/0.00/97.80/Pending … 2027-10-26/8247.80/0.00/8247.80/Pending | 一致（12 行） | PASS |  |
| RS#TODAY.again | 同一天再重组 |  | 拒收（下限 = 上次生效日次日） | Effective date must be between 2026-10-27 and 2026-10-26 | PASS |  |
| RS#RAISE | 1.2%/月 → 1.5%/月（RS-23） | 拒收 | A restructure cannot raise the interest rate (14.4% → 18% p.a.) | A restructure cannot raise the interest rate (14.4% → 18% p.a.) | PASS |  |
| RS#CAP | 重组为 2%/月（RS-24） | 拒收（上限优先） | Interest rate exceeds the 18% p.a. limit (this loan: 24% p.a.) | Interest rate exceeds the 18% p.a. limit (this loan: 24% p.a.) | PASS |  |
| RS#FIXCAP.1800 | 重组为 Fixed 利息 1800、12 期（截点本金 10,000）名义年化 18.00…% |  | 接受 | A rate-based loan cannot be restructured to a fixed amount (pending legal review) | FAIL |  |
| RS#FIXCAP.1801 | 重组为 Fixed 利息 1801、12 期（截点本金 10,000）名义年化 18.01…% |  | 拒收（> 18%） | Interest rate exceeds the 18% p.a. limit (this loan: 18.01% p.a.) | PASS |  |
| RS#FIXCAP.1800.40 | 重组为 Fixed 利息 1800.40、12 期（截点本金 10,000）名义年化 18.00…% |  | 拒收（> 18%） | Interest rate exceeds the 18% p.a. limit (this loan: 18% p.a.) | PASS |  |
| RS#TOTINT.74 | 06-01 重组为 1.25%/月 × 74 个月：总利息 10000.00（本金 10,000） |  | 接受（= 本金） | Restructured | PASS |  |
| RS#TOTINT.75 | 06-01 重组为 1.25%/月 × 75 个月：总利息 10125.00（本金 10,000） |  | 拒收（> 本金） | Interest after the restructure plus carried arrears cannot exceed the remaining principal | FAIL |  |
| RS#MATURED.cut | RS-21 已到期贷款今天重组：挂账 | 只计到原到期日 10000×1.5%×3 | 450.00 | 450.00 | PASS |  |
| RS#MATURED.outstanding | RS-21 重组后：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 11650.00 | 11650.00 | PASS |  |
| RS#MATURED.settlement | RS-21 重组后：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 10450.00 | 10450.00 | PASS |  |
| RS#MATURED.dpd | RS-21 重组后：DPD | 最早未还清期到期日 → 今天（D-09） | 0 | 0 | PASS |  |
| RS#MATURED.overdue | RS-21 重组后：Overdue | Σ 已到期未还（计划 FIFO） | 0.00 | 0.00 | PASS |  |
| RS#BORN.dpd | 生效日 2026-09-25 重组（挂账欠息生效日即到期）：DPD | 最早未还清期到期日 → 今天（D-09） | 31 | 1 | FAIL |  |
| RS#BORN.overdue | 生效日 2026-09-25 重组（挂账欠息生效日即到期）：Overdue | Σ 已到期未还（计划 FIFO） | 1470.00 | 1470.00 | PASS |  |
| CAP#monthly 1.5 | 建案 monthly 1.5；名义年化 18.00%；合同总利息 1800.00 |  | 接受 | 接受（案件 68） | PASS |  |
| CAP#monthly 1.5008 | 建案 monthly 1.5008；名义年化 18.01%；合同总利息 1800.96 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 18.01% p.a.) | PASS |  |
| CAP#monthly 1.50004 | 建案 monthly 1.50004；名义年化 18.00%；合同总利息 1800.05 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 18% p.a.) | PASS |  |
| CAP#monthly 1.6 | 建案 monthly 1.6；名义年化 19.20%；合同总利息 1920.00 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 19.2% p.a.) | PASS |  |
| CAP#daily 18 | 建案 daily 18；名义年化 18.00%；合同总利息 1800.00 |  | 接受 | 接受（案件 69） | PASS |  |
| CAP#daily 18.01 | 建案 daily 18.01；名义年化 18.01%；合同总利息 1801.00 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 18.01% p.a.) | PASS |  |
| CAP#daily 18.004 | 建案 daily 18.004；名义年化 18.00%；合同总利息 1800.40 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 18% p.a.) | PASS |  |
| CAP#fixed 1800/12 | 建案 fixed 1800/12；名义年化 18.00%；合同总利息 1800.00 |  | 接受 | 接受（案件 70） | PASS |  |
| CAP#fixed 1801/12 | 建案 fixed 1801/12；名义年化 18.01%；合同总利息 1801.00 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 18.01% p.a.) | PASS |  |
| CAP#fixed 1800.40/12 | 建案 fixed 1800.40/12；名义年化 18.00%；合同总利息 1800.40 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 18% p.a.) | PASS |  |
| CAP#fixed 1800.01/12 | 建案 fixed 1800.01/12；名义年化 18.00%；合同总利息 1800.01 |  | 拒收 | Interest rate exceeds the 18% p.a. limit (this loan: 18% p.a.) | PASS |  |
| CAP#fixed 9000 无期限 | 建案 fixed 9000 无期限；名义年化 —%；合同总利息 无期限/无法计算 |  | 拒收 | Tenure is required for a loan that charges interest | PASS |  |
| CAP#fixed 1500 期限30 tenure_unit=days（篡改请求） | 建案 fixed 1500 期限30 tenure_unit=days（篡改请求）；名义年化 —%；合同总利息 无期限/无法计算 |  | 拒收 | 接受（案件 71） | FAIL |  |
| CAP#fixed 1500 期限30 tenure_unit=days（篡改请求）.stored | 同上：存储的期限与到期日 |  | 30 days → 实际年化 1500/10000 ÷ (30/365) = 182.5% | {"tenure":30,"tenure_unit":"months","maturity_date":"2029-04-01"} | INFO |  |
| CAP#monthly 1.25 × 80 期（总利息 = 本金） | 建案 monthly 1.25 × 80 期（总利息 = 本金）；名义年化 15.00%；合同总利息 10000.00 |  | 接受 | 接受（案件 72） | PASS |  |
| CAP#monthly 1.25 × 81 期（101.25%） | 建案 monthly 1.25 × 81 期（101.25%）；名义年化 15.00%；合同总利息 10125.00 |  | 拒收 | Total interest cannot exceed the principal | PASS |  |
| CAP#monthly 1.5 × 120 期（INT-13） | 建案 monthly 1.5 × 120 期（INT-13）；名义年化 18.00%；合同总利息 18000.00 |  | 拒收 | Total interest cannot exceed the principal | PASS |  |
| CAP#fixed 10000 / 120 期（= 本金，10% p.a.） | 建案 fixed 10000 / 120 期（= 本金，10% p.a.）；名义年化 10.00%；合同总利息 10000.00 |  | 接受 | 接受（案件 73） | PASS |  |
| CAP#fixed 10000.01 / 120 期 | 建案 fixed 10000.01 / 120 期；名义年化 10.00%；合同总利息 10000.01 |  | 拒收 | Total interest cannot exceed the principal | PASS |  |
| CAP#monthly 1.5 无期限 起2023-01-01（至今 68.66%） | 建案 monthly 1.5 无期限 起2023-01-01（至今 68.66%）；名义年化 18.00%；合同总利息 无期限/无法计算 |  | 拒收 | Tenure is required for a loan that charges interest | PASS |  |
| CAP#monthly 1.5 无期限 起2020-06-01（至今 > 本金） | 建案 monthly 1.5 无期限 起2020-06-01（至今 > 本金）；名义年化 18.00%；合同总利息 无期限/无法计算 |  | 拒收 | Tenure is required for a loan that charges interest | PASS |  |
| PTP#CAP.1 | PTP 6,000（7 天后） |  | 接受 | PTP created | PASS |  |
| PTP#CAP.2 | 再建 4,000.01（14 天后），合计 10,000.01 | 拒收：合计 > 最后到期日结清额 10,000 | Promised total RM 10,000.01 exceeds the settlement amount on 2026-11-09 (RM 10,000.00) | Promised total RM 10,000.01 exceeds the settlement amount on 2026-11-09 (RM 10,000.00) | PASS |  |
| PTP#CAP.3 | 再建 4,000，合计 10,000.00 |  | 接受 | PTP created | PASS |  |
| PTP#DATE.past | PTP 到期日昨天 | 拒收 | Due date cannot be in the past | Due date cannot be in the past | PASS |  |
| PTP#DATE.blank | PTP 到期日为空 | 拒收 | Invalid due date | Invalid due date | PASS |  |
| PTP#DATE.bad | PTP 到期日 2027-02-30 | 拒收 | Invalid due date | Invalid due date | PASS |  |
| PTP#MCAP.today | 今天到期 PTP 10000.01 | 拒收：上限 = 今日结清额 10000.00 | Promised total RM 10,000.01 exceeds the settlement amount on 2026-10-26 (RM 10,000.00) | Promised total RM 10,000.01 exceeds the settlement amount on 2026-10-26 (RM 10,000.00) | PASS |  |
| PTP#MCAP.1m+ | 一个月后到期 PTP 10150.01 |  | 拒收：上限 = 2026-11-26 结清额 10150.00 | Promised total RM 10,150.01 exceeds the settlement amount on 2026-11-26 (RM 10,150.00) | PASS |  |
| PTP#MCAP.1m | 一个月后到期 PTP 10150.00（= 当日结清额，含 1 个月利息） |  | 接受 | PTP created | PASS |  |
| PTP#PLAN.1000/3.amt | 分期 1000 / 3 期 | 前 n−1 期向下取到分，末期吸收零头 | 333.33,333.33,333.34 | 333.33,333.33,333.34 | PASS |  |
| PTP#PLAN.1000/3.dates | 分期 1000 / 3 期 首期 2026-11-30：到期日 | 按首期日的对应日逐月（月末对齐） | 2026-11-30,2026-12-30,2027-01-30 | 2026-11-30,2026-12-30,2027-01-30 | PASS |  |
| PTP#PLAN.100/7.amt | 分期 100 / 7 期 | 前 n−1 期向下取到分，末期吸收零头 | 14.28,14.28,14.28,14.28,14.28,14.28,14.32 | 14.28,14.28,14.28,14.28,14.28,14.28,14.32 | PASS |  |
| PTP#PLAN.100/7.dates | 分期 100 / 7 期 首期 2027-01-31：到期日 | 按首期日的对应日逐月（月末对齐） | 2027-01-31,2027-02-28,2027-03-31,2027-04-30,2027-05-31,2027-06-30,2027-07-31 | 2027-01-31,2027-02-28,2027-03-31,2027-04-30,2027-05-31,2027-06-30,2027-07-31 | PASS |  |
| PTP#PLAN.300/3.amt | 分期 300 / 3 期 | 前 n−1 期向下取到分，末期吸收零头 | 100.00,100.00,100.00 | 100.00,100.00,100.00 | PASS |  |
| PTP#PLAN.300/3.dates | 分期 300 / 3 期 首期 2028-01-31：到期日 | 按首期日的对应日逐月（月末对齐） | 2028-01-31,2028-02-29,2028-03-31 | 2028-01-31,2028-02-29,2028-03-31 | PASS |  |
| PTP#PLAN.cap | 同一案件再建分期 3,600.01（已承诺 1,400，结清额 5,000） |  | 拒收 | Promised total RM 5,000.01 exceeds the settlement amount on 2028-03-31 (RM 5,000.00) | PASS |  |
| PTP#PLAN.past | 分期首期日期为昨天 | 拒收 | First due date cannot be in the past | First due date cannot be in the past | PASS |  |
| PTP#PLAN.mcap+ | Monthly 分期 3 期首期今天，总额 10300.01 |  | 拒收：上限 = 末期日 2026-12-26 结清额 10300.00 | Promised total RM 10,300.01 exceeds the settlement amount on 2026-12-26 (RM 10,300.00) | PASS |  |
| PTP#PLAN.mcap | 同上总额 10300.00 |  | 接受 | Installment plan created | PASS |  |
| PTP#PK.status | PTP 1,000 只收 600：PTP 状态 | partially kept（D-10） | partially kept | partially kept | PASS |  |
| PTP#PK.timeline | 时间线 |  | “PTP partially kept: RM 600.00 of RM 1000.00” | PTP partially kept: RM 600.00 of RM 1000.00 | PASS |  |
| PTP#PK.noNew | 不自动生成新承诺：pending PTP 数 | 0 | 0 | 0 | PASS |  |
| PTP#PK.out | 部分履行后欠款 | 1000 − 600 | 400.00 | 400.00 | PASS |  |
| PTP#PK.caseStatus | 部分履行后案件状态 |  | Partial Paid（已无 pending PTP） | Partial Paid | PASS |  |
| PTP#PLAN.kept | 分期 3 期，第 1 期 100 只收 50：标题行 “N/3 kept” |  | 0/3 kept（部分履行不应算 kept） | 0/3 kept | PASS |  |
| DPD#N0.dpd | 首期到期 2026-10-26（起始 2026-09-26）：DPD | 2026-10-26 − 2026-10-26 | 0 | 0 | PASS |  |
| DPD#N0.overdue | 同上：逾期金额 | 100 × 已到期期数 | 0.00 | 0.00 | PASS |  |
| DPD#N0.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “Current” | Current:1200.00 | Current:1200.00 | PASS |  |
| DPD#N1.dpd | 首期到期 2026-10-25（起始 2026-09-25）：DPD | 2026-10-26 − 2026-10-25 | 1 | 1 | PASS |  |
| DPD#N1.overdue | 同上：逾期金额 | 100 × 已到期期数 | 100.00 | 100.00 | PASS |  |
| DPD#N1.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “1–30” | 1–30:1200.00 | 1–30:1200.00 | PASS |  |
| DPD#N30.dpd | 首期到期 2026-09-26（起始 2026-08-26）：DPD | 2026-10-26 − 2026-09-26 | 30 | 30 | PASS |  |
| DPD#N30.overdue | 同上：逾期金额 | 100 × 已到期期数 | 100.00 | 100.00 | PASS |  |
| DPD#N30.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “1–30” | 1–30:1200.00 | 1–30:1200.00 | PASS |  |
| DPD#N31.dpd | 首期到期 2026-09-25（起始 2026-08-25）：DPD | 2026-10-26 − 2026-09-25 | 31 | 31 | PASS |  |
| DPD#N31.overdue | 同上：逾期金额 | 100 × 已到期期数 | 200.00 | 200.00 | PASS |  |
| DPD#N31.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “31–60” | 31–60:1200.00 | 31–60:1200.00 | PASS |  |
| DPD#N60.dpd | 首期到期 2026-08-27（起始 2026-07-27）：DPD | 2026-10-26 − 2026-08-27 | 60 | 60 | PASS |  |
| DPD#N60.overdue | 同上：逾期金额 | 100 × 已到期期数 | 200.00 | 200.00 | PASS |  |
| DPD#N60.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “31–60” | 31–60:1200.00 | 31–60:1200.00 | PASS |  |
| DPD#N61.dpd | 首期到期 2026-08-26（起始 2026-07-26）：DPD | 2026-10-26 − 2026-08-26 | 61 | 61 | PASS |  |
| DPD#N61.overdue | 同上：逾期金额 | 100 × 已到期期数 | 200.00 | 200.00 | PASS |  |
| DPD#N61.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “61–90” | 61–90:1200.00 | 61–90:1200.00 | PASS |  |
| DPD#N90.dpd | 首期到期 2026-07-28（起始 2026-06-28）：DPD | 2026-10-26 − 2026-07-28 | 90 | 90 | PASS |  |
| DPD#N90.overdue | 同上：逾期金额 | 100 × 已到期期数 | 300.00 | 300.00 | PASS |  |
| DPD#N90.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “61–90” | 61–90:1200.00 | 61–90:1200.00 | PASS |  |
| DPD#N91.dpd | 首期到期 2026-07-27（起始 2026-06-27）：DPD | 2026-10-26 − 2026-07-27 | 91 | 91 | PASS |  |
| DPD#N91.overdue | 同上：逾期金额 | 100 × 已到期期数 | 300.00 | 300.00 | PASS |  |
| DPD#N91.bucket | 同上：仪表盘 Aging 档位变化 | +1,200 落在 “90+” | 90+:1200.00 | 90+:1200.00 | PASS |  |
| DPD#PRE.outstanding | 2025-10-01 起、次日还 5,000、已到期：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 5903.29 | 5903.29 | PASS |  |
| DPD#PRE.settlement | 2025-10-01 起、次日还 5,000、已到期：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 5903.29 | 5903.29 | PASS |  |
| DPD#PRE.dpd | 2025-10-01 起、次日还 5,000、已到期：DPD | 最早未还清期到期日 → 今天（D-09） | 25 | 25 | PASS |  |
| DPD#PRE.overdue | 2025-10-01 起、次日还 5,000、已到期：Overdue | Σ 已到期未还（计划 FIFO） | 6800.00 | 5903.29 | FAIL |  |
| DPD#PRE.biz | 业务预期：逾期金额不应超过今日结清额（总欠款） |  | Overdue ≤ 5903.29 | Overdue 5903.29 vs Settlement 5903.29 / 合同欠款 5903.29 | PASS |  |
| DPD#PRE2.outstanding | 起始日（2026-04-26）还 1,000 冲本金、之后未付利息：合同欠款 | 剩余本金 + 合同期利息 − 已还 | 10620.00 | 10620.00 | PASS |  |
| DPD#PRE2.settlement | 起始日（2026-04-26）还 1,000 冲本金、之后未付利息：Settlement Today (2026-10-26) | 剩余本金 + 截至今天利息（D-02） | 9810.00 | 9810.00 | PASS |  |
| DPD#PRE2.dpd | 起始日（2026-04-26）还 1,000 冲本金、之后未付利息：DPD | 最早未还清期到期日 → 今天（D-09） | 0 | 0 | PASS |  |
| DPD#PRE2.overdue | 起始日（2026-04-26）还 1,000 冲本金、之后未付利息：Overdue | Σ 已到期未还（计划 FIFO） | 0.00 | 0.00 | PASS |  |
| DPD#PRE2.biz | 业务预期：账本上已产生且未付的利息 > 0 时，不应显示 up to date |  | 账本未付利息 805.50（截至昨天）→ DPD > 0 | up to date; Overdue 0.00 | FAIL |  |
| COM#REASSIGN | 改派 A → B |  | Saved | Saved | PASS |  |
| COM#A.collected | A 本月 Collected（改派前收 933.63） | 933.63（D-11 归收款时催收员） | 933.63 | 933.63 | PASS |  |
| COM#A.earned | A 本月 Earned | 933.63 × 5% | 46.68 | 46.68 | PASS |  |
| COM#B.collected | B 本月 Collected（改派后录入 1,234.57 + 补录昨天 100） | 1334.57（系统按录入时的案件催收员） | 1334.57 | 1234.57 | FAIL | 昨天（改派前）的 100 归 B：D-11 “收款时”指录入时还是收款日，待确认 |
| COM#B.earned | B 本月 Earned | 1334.57 × 7.5% | 100.09 | 92.59 | FAIL |  |
| COM#BACKDATE | 补录 2026-10-25（改派前那天）的 100 归属 |  | 业务预期：A（当天负责的催收员） | v1.11.0 拒收：还款日期早于贷款起始日（N-14），无法验证归属 | FAIL | RULE-CHANGE |
| COM#TASKS | 改派后任务：待办随案件转 B，已完成留 A |  | QA 待办→B；QA 已完成→A | [{"title":"QA 待办","agent_id":6,"status":"pending"},{"title":"QA 已完成","agent_id":5,"status":"done"}] | PASS |  |
| COM#RPT.A | Reports 本月业绩 A：Collected/Commission | 同 Commissions 页 | 933.63/46.68 | 933.63/46.68 | PASS |  |
| COM#RPT.B | Reports 本月业绩 B：Collected/Commission | 同 Commissions 页 | 1234.57/92.59 | 1234.57/92.59 | PASS |  |
| COM#CSV.A | agent-performance.csv A：Collected,Commission | 933.63 / 46.68（RPT-06 无尾差） | 933.63,46.68 | 933.63,46.68 | PASS |  |
| COM#CSV.B | agent-performance.csv B：Collected,Commission | 1234.57 / 92.59 | 1234.57,92.59 | 1234.57,92.59 | PASS |  |
| COM#AGT.A | Agents 页 A：案件数/Collected/Commission | 0 件（已改派）/933.63/46.68 | 0/933.63/46.68 | 0/933.63/46.68 | PASS |  |
| COM#AGT.B | Agents 页 B：案件数/Collected | 1/1234.57 | 1/1234.57 | 1/1234.57 | PASS |  |
| COM#OVERSETTLE | A 结算 50.00 > Earned 46.68 |  | Pending −3.32 红字（超额发放无硬拦截，K-05） | -3.32 red=true | PASS |  |
| COM#VOID | 作废 A 收的 933.63 后 A 的本月 Earned/Pending |  | 0.00 / −50.00（追溯变动，K-05 快照延后） | 0.00 / -50.00 | PASS |  |
| COM#RCPT | 作废最新一笔 RCPT-2026-0026 后再记一笔（B-06/F-03） |  | 新号 ≠ 作废号 | RCPT-2026-0027 | PASS |  |