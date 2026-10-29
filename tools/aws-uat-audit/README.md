# AWS UAT 只读检查

检查 AWS 账号里的 UAT 环境：

1. UAT 本身的配置问题
2. UAT 和 PROD 的配置差异（UAT 是照 PROD 建的）
3. UAT / PROD 的权限是否分开
4. 整个账号的安全隐患

最后产出一份 PDF 报告，每一项写清楚哪里有问题、为什么、建议怎么改，版式照《ECS Task 连不上 ECR 排查手册》。

## 只读，不改

- `audit.py` 只调用 `Describe*` / `List*` / `Get*`。botocore 的 `before-call` hook 会拦下其他所有操作，
  直接报 `ReadOnlyViolation` 停止运行。
- 会读出机密内容的 Get 操作也一律拦截，例如 `GetSecretValue`、`GetObject`、`GetParameter*`、
  `GetAuthorizationToken`、`GetPasswordData`、`GetLogEvents`。
- task definition 里的明文环境变量只记录变量名、长度、值里有没有出现 uat / prod，不保存值。
- IAM 那边也要再挡一层：检查用的身份只挂下面两个 AWS managed policy，这样就算脚本有 bug 也改不了东西。

| Policy | 用途 |
|---|---|
| `SecurityAudit` | 读 IAM、KMS、S3、CloudTrail 等的安全设定 |
| `ViewOnlyAccess` | 读 ECS、RDS、ELB 等的资源列表和配置 |

不要用 `ReadOnlyAccess`：它包含 `s3:GetObject`、`secretsmanager:GetSecretValue` 等读数据的权限。

## 在 Claude Code 云端 session 跑

AWS 的 SigV4 签名要在本机用 secret key 计算，所以 key 必须是 **环境变量**，
不能放成 proxy 代入的 network secret（那种的值在容器里是占位符，AWS 会回
`InvalidClientTokenId`）。

1. 建一个 IAM user（例如 `audit-readonly`），只挂 `SecurityAudit` + `ViewOnlyAccess`，建一把 access key。
2. 在 environment 设定里加环境变量 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`。
3. 开新 session（环境变量只对新 session 生效）。
4. 检查完把这把 key 停用或删除。

## 执行

```bash
pip install boto3
apt-get install -y fonts-noto-cjk        # 中文字体
python3 audit.py --regions ap-southeast-5 --out out
python3 report.py out/findings.json -o AWS-UAT-检查报告.pdf
```

- `--regions all`：查所有已启用的 region（会慢很多）。
- 产出的 `out/inventory.json` 是读到的原始配置，`out/findings.json` 是问题清单。
  两个都含账号内部信息，**不要 commit**（`.gitignore` 已排除 `out/`）。
- PDF 用 Playwright + Chromium 排版：有 Python 版 Playwright 就用 Python 版，否则改用 Node 版（`npm i playwright`）。

## 环境怎么判断

资源名字或 `Environment` / `Name` tag 里有 `uat` / `stg` / `staging` 的算 UAT，
有 `prod` / `prd` / `production` 的算 PROD。环境词前后紧接字母的不算，所以 `product` 不会被当成 PROD。
名字里没有环境词的资源归在「共用/未标」。

UAT 和 PROD 的对比，是把名字里的环境词换掉后配对，
例如 `my-zentro-uat-pos-vpc` ↔ `my-zentro-prod-pos-vpc`。
