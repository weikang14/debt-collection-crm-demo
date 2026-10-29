#!/usr/bin/env python3
"""AWS UAT / PROD 只读检查。

只调用 Describe* / List* / Get* 类 API，并在 botocore 层拦截所有写操作和
会读出机密内容的操作（GetSecretValue、GetObject、GetParameter 等）。
输出：
  out/inventory.json  读到的原始配置（不含任何 secret 值）
  out/findings.json   问题清单：哪里有问题 / 为什么 / 建议
用法：
  python3 audit.py --regions ap-southeast-5 --out out
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
from collections import defaultdict

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError

# ---------------------------------------------------------------- 只读保护
READ_PREFIX = ("Describe", "List", "Get", "Lookup", "Search", "BatchGet")
# 名字是只读，但会读出机密内容或产生临时凭证，一律不调用
DENY = {
    "GetSecretValue", "BatchGetSecretValue", "GetObject", "GetObjectTorrent",
    "GetParameter", "GetParameters", "GetParametersByPath", "GetParameterHistory",
    "GetAuthorizationToken", "GetDownloadUrlForLayer", "BatchGetImage",
    "GetPasswordData", "GetConsoleOutput", "GetConsoleScreenshot",
    "GetLogEvents", "GetQueryResults", "GetSessionToken", "GetFederationToken",
    "GetFunction", "GetLayerVersion", "GetDataKey", "GetRoleCredentials",
}
ALLOW_EXTRA = {"GetCallerIdentity"}


class ReadOnlyViolation(RuntimeError):
    pass


def _guard(model, **_):
    name = model.name
    if name in ALLOW_EXTRA:
        return
    if name in DENY or not name.startswith(READ_PREFIX):
        raise ReadOnlyViolation(f"拦截非只读操作: {model.service_model.service_name}:{name}")


CFG = Config(retries={"max_attempts": 8, "mode": "adaptive"}, read_timeout=30, connect_timeout=10)
_clients = {}


def client(service, region=None):
    key = (service, region)
    if key not in _clients:
        c = boto3.client(service, region_name=region, config=CFG)
        c.meta.events.register("before-call", _guard)
        _clients[key] = c
    return _clients[key]


ERRORS = []  # 没权限 / 服务未开通等，报告里列为「未能检查」


def safe(fn, *a, _what="", default=None, _ok=(), **kw):
    """调用失败时记录到 ERRORS；_ok 里的错误码代表「没有这个设定」，属于正常，不记录。"""
    try:
        return fn(*a, **kw)
    except ReadOnlyViolation:
        raise
    except (ClientError, EndpointConnectionError) as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code", type(e).__name__)
        if code in _ok:
            return default
        ERRORS.append({"what": _what or getattr(fn, "__name__", "?"), "code": code, "msg": str(e)[:300]})
        return default


def pages(c, op, key, **kw):
    if c.can_paginate(op):
        out = []
        for p in c.get_paginator(op).paginate(**kw):
            out.extend(p.get(key, []))
        return out
    return c.__getattribute__(op)(**kw).get(key, [])


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---------------------------------------------------------------- 环境识别
# 环境词前后不能紧接字母，避免 product / evaluate 之类误判
UAT_RE = re.compile(r"(?<![a-z])(uat|stg|staging)(?![a-z])", re.I)
PROD_RE = re.compile(r"(?<![a-z])(prod|prd|production)(?![a-z])", re.I)


def env_of(*texts):
    s = " ".join(t for t in texts if t)
    if UAT_RE.search(s):
        return "UAT"
    if PROD_RE.search(s):
        return "PROD"
    return "共用/未标"


def tags_dict(tags):
    if not tags:
        return {}
    if isinstance(tags, dict):
        return tags
    return {t.get("Key", t.get("key")): t.get("Value", t.get("value")) for t in tags}


def env_of_res(name, tags=None):
    t = tags_dict(tags)
    hint = " ".join(str(v) for k, v in t.items() if k and k.lower() in ("env", "environment", "stage", "name"))
    return env_of(name, hint)


def pair_key(name):
    """把名字里的环境词换掉，用来把 UAT 和 PROD 的同类资源配对。"""
    return PROD_RE.sub("{env}", UAT_RE.sub("{env}", (name or "").lower()))


# ---------------------------------------------------------------- findings
FINDINGS = []
SEV_ORDER = {"高": 0, "中": 1, "低": 2, "提示": 3}


def add(sev, area, env, resource, title, why, fix, path=None, evidence=None):
    FINDINGS.append({
        "severity": sev, "area": area, "env": env, "resource": resource,
        "title": title, "why": why, "fix": fix,
        "path": path or [], "evidence": evidence or {},
    })


SENSITIVE_PORTS = {22: "SSH", 3389: "RDP", 5432: "PostgreSQL", 3306: "MySQL", 1433: "SQL Server",
                   1521: "Oracle", 6379: "Redis", 27017: "MongoDB", 9200: "Elasticsearch", 11211: "Memcached"}
SECRET_NAME_RE = re.compile(r"(pass(word)?|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|conn(ection)?str|credential)", re.I)


# ================================================================ 采集
def collect_identity(inv):
    inv["identity"] = client("sts").get_caller_identity()
    inv["account_id"] = inv["identity"]["Account"]
    iam = client("iam")
    inv["iam"] = {
        "summary": safe(lambda: iam.get_account_summary()["SummaryMap"], _what="iam:GetAccountSummary", default={}),
        "password_policy": safe(lambda: iam.get_account_password_policy()["PasswordPolicy"],
                                _what="iam:GetAccountPasswordPolicy", default=None, _ok=("NoSuchEntity",)),
        "aliases": safe(lambda: iam.list_account_aliases()["AccountAliases"], _what="iam:ListAccountAliases", default=[]),
    }


def _policy_docs_for(kind, name):
    """返回 [(policy_name, document)]，包括 inline 和 attached（AWS managed 只记名字）。"""
    iam = client("iam")
    docs, managed = [], []
    if kind == "role":
        inline = safe(pages, iam, "list_role_policies", "PolicyNames", RoleName=name, _what="iam:ListRolePolicies", default=[])
        for pn in inline:
            d = safe(lambda: iam.get_role_policy(RoleName=name, PolicyName=pn)["PolicyDocument"], _what="iam:GetRolePolicy")
            if d:
                docs.append((pn, d))
        att = safe(pages, iam, "list_attached_role_policies", "AttachedPolicies", RoleName=name, _what="iam:ListAttachedRolePolicies", default=[])
    elif kind == "user":
        inline = safe(pages, iam, "list_user_policies", "PolicyNames", UserName=name, _what="iam:ListUserPolicies", default=[])
        for pn in inline:
            d = safe(lambda: iam.get_user_policy(UserName=name, PolicyName=pn)["PolicyDocument"], _what="iam:GetUserPolicy")
            if d:
                docs.append((pn, d))
        att = safe(pages, iam, "list_attached_user_policies", "AttachedPolicies", UserName=name, _what="iam:ListAttachedUserPolicies", default=[])
    else:  # group
        inline = safe(pages, iam, "list_group_policies", "PolicyNames", GroupName=name, _what="iam:ListGroupPolicies", default=[])
        for pn in inline:
            d = safe(lambda: iam.get_group_policy(GroupName=name, PolicyName=pn)["PolicyDocument"], _what="iam:GetGroupPolicy")
            if d:
                docs.append((pn, d))
        att = safe(pages, iam, "list_attached_group_policies", "AttachedPolicies", GroupName=name, _what="iam:ListAttachedGroupPolicies", default=[])
    for a in att:
        managed.append(a["PolicyName"])
        if ":aws:policy/" in a["PolicyArn"]:
            continue
        pol = safe(lambda: iam.get_policy(PolicyArn=a["PolicyArn"])["Policy"], _what="iam:GetPolicy")
        if pol:
            v = safe(lambda: iam.get_policy_version(PolicyArn=a["PolicyArn"], VersionId=pol["DefaultVersionId"])["PolicyVersion"]["Document"],
                     _what="iam:GetPolicyVersion")
            if v:
                docs.append((a["PolicyName"], v))
    return docs, managed


def collect_iam(inv):
    iam = client("iam")
    roles = safe(pages, iam, "list_roles", "Roles", _what="iam:ListRoles", default=[])
    inv["iam"]["roles"] = []
    for r in roles:
        if r.get("Path", "").startswith("/aws-service-role/"):
            continue
        docs, managed = _policy_docs_for("role", r["RoleName"])
        inv["iam"]["roles"].append({
            "name": r["RoleName"], "arn": r["Arn"], "env": env_of(r["RoleName"]),
            "trust": r.get("AssumeRolePolicyDocument"), "managed": managed,
            "docs": docs, "last_used": str((r.get("RoleLastUsed") or {}).get("LastUsedDate", "")),
        })
    users = safe(pages, iam, "list_users", "Users", _what="iam:ListUsers", default=[])
    inv["iam"]["users"] = []
    now = dt.datetime.now(dt.timezone.utc)
    for u in users:
        n = u["UserName"]
        mfa = safe(pages, iam, "list_mfa_devices", "MFADevices", UserName=n, _what="iam:ListMFADevices", default=[])
        console = safe(lambda: iam.get_login_profile(UserName=n), _what="iam:GetLoginProfile", default=None, _ok=("NoSuchEntity",))
        keys = []
        for k in safe(pages, iam, "list_access_keys", "AccessKeyMetadata", UserName=n, _what="iam:ListAccessKeys", default=[]):
            lu = safe(lambda: iam.get_access_key_last_used(AccessKeyId=k["AccessKeyId"])["AccessKeyLastUsed"], _what="iam:GetAccessKeyLastUsed", default={})
            keys.append({"id": k["AccessKeyId"][-4:], "status": k["Status"],
                         "age_days": (now - k["CreateDate"]).days,
                         "last_used_days": (now - lu["LastUsedDate"]).days if lu and lu.get("LastUsedDate") else None})
        groups = [g["GroupName"] for g in safe(pages, iam, "list_groups_for_user", "Groups", UserName=n, _what="iam:ListGroupsForUser", default=[])]
        docs, managed = _policy_docs_for("user", n)
        inv["iam"]["users"].append({"name": n, "env": env_of(n), "mfa": bool(mfa), "console": console is not None,
                                    "keys": keys, "groups": groups, "managed": managed, "docs": docs})
    inv["iam"]["groups"] = []
    for g in safe(pages, iam, "list_groups", "Groups", _what="iam:ListGroups", default=[]):
        docs, managed = _policy_docs_for("group", g["GroupName"])
        inv["iam"]["groups"].append({"name": g["GroupName"], "env": env_of(g["GroupName"]), "managed": managed, "docs": docs})
    inv["iam"]["oidc"] = [p["Arn"] for p in safe(lambda: iam.list_open_id_connect_providers()["OpenIDConnectProviderList"],
                                                   _what="iam:ListOpenIDConnectProviders", default=[])]


def collect_region(region, inv):
    R = inv["regions"][region] = {}
    ec2 = client("ec2", region)
    R["vpcs"] = safe(pages, ec2, "describe_vpcs", "Vpcs", _what=f"ec2:DescribeVpcs@{region}", default=[])
    for v in R["vpcs"]:
        v["_name"] = tags_dict(v.get("Tags")).get("Name", v["VpcId"])
        v["_env"] = env_of_res(v["_name"], v.get("Tags"))
        for attr, key in (("enableDnsSupport", "EnableDnsSupport"), ("enableDnsHostnames", "EnableDnsHostnames")):
            a = safe(lambda: ec2.describe_vpc_attribute(VpcId=v["VpcId"], Attribute=attr)[key]["Value"], _what="ec2:DescribeVpcAttribute")
            v["_" + attr] = a
    R["subnets"] = safe(pages, ec2, "describe_subnets", "Subnets", _what="ec2:DescribeSubnets", default=[])
    R["route_tables"] = safe(pages, ec2, "describe_route_tables", "RouteTables", _what="ec2:DescribeRouteTables", default=[])
    R["nat"] = safe(pages, ec2, "describe_nat_gateways", "NatGateways", _what="ec2:DescribeNatGateways", default=[])
    R["igw"] = safe(pages, ec2, "describe_internet_gateways", "InternetGateways", _what="ec2:DescribeInternetGateways", default=[])
    R["endpoints"] = safe(pages, ec2, "describe_vpc_endpoints", "VpcEndpoints", _what="ec2:DescribeVpcEndpoints", default=[])
    R["nacls"] = safe(pages, ec2, "describe_network_acls", "NetworkAcls", _what="ec2:DescribeNetworkAcls", default=[])
    R["sgs"] = safe(pages, ec2, "describe_security_groups", "SecurityGroups", _what="ec2:DescribeSecurityGroups", default=[])
    R["peering"] = safe(pages, ec2, "describe_vpc_peering_connections", "VpcPeeringConnections", _what="ec2:DescribeVpcPeeringConnections", default=[])
    R["tgw_att"] = safe(pages, ec2, "describe_transit_gateway_attachments", "TransitGatewayAttachments", _what="ec2:DescribeTransitGatewayAttachments", default=[])
    R["flow_logs"] = safe(pages, ec2, "describe_flow_logs", "FlowLogs", _what="ec2:DescribeFlowLogs", default=[])
    R["enis"] = safe(pages, ec2, "describe_network_interfaces", "NetworkInterfaces", _what="ec2:DescribeNetworkInterfaces", default=[])
    R["instances"] = [i for res in safe(pages, ec2, "describe_instances", "Reservations", _what="ec2:DescribeInstances", default=[]) for i in res["Instances"]]
    R["volumes"] = safe(pages, ec2, "describe_volumes", "Volumes", _what="ec2:DescribeVolumes", default=[])
    R["ebs_default_enc"] = safe(lambda: ec2.get_ebs_encryption_by_default()["EbsEncryptionByDefault"], _what="ec2:GetEbsEncryptionByDefault")

    # ECS
    ecs = client("ecs", region)
    arns = safe(pages, ecs, "list_clusters", "clusterArns", _what="ecs:ListClusters", default=[])
    R["ecs_clusters"] = []
    for ch in chunks(arns, 100):
        R["ecs_clusters"] += safe(lambda: ecs.describe_clusters(clusters=ch, include=["SETTINGS", "CONFIGURATIONS", "TAGS"])["clusters"],
                                  _what="ecs:DescribeClusters", default=[])
    R["ecs_services"], R["task_defs"] = [], {}
    for c in R["ecs_clusters"]:
        sarns = safe(pages, ecs, "list_services", "serviceArns", cluster=c["clusterArn"], _what="ecs:ListServices", default=[])
        for ch in chunks(sarns, 10):
            for s in safe(lambda: ecs.describe_services(cluster=c["clusterArn"], services=ch, include=["TAGS"])["services"],
                          _what="ecs:DescribeServices", default=[]):
                s["_cluster"] = c["clusterName"]
                R["ecs_services"].append(s)
                td = s["taskDefinition"]
                if td not in R["task_defs"]:
                    d = safe(lambda: ecs.describe_task_definition(taskDefinition=td, include=["TAGS"])["taskDefinition"], _what="ecs:DescribeTaskDefinition")
                    if d:
                        R["task_defs"][td] = _redact_taskdef(d)

    # ECR
    ecr = client("ecr", region)
    R["ecr"] = safe(pages, ecr, "describe_repositories", "repositories", _what="ecr:DescribeRepositories", default=[])
    R["ecr_registry_scan"] = safe(lambda: ecr.get_registry_scanning_configuration()["scanningConfiguration"], _what="ecr:GetRegistryScanningConfiguration")
    for r in R["ecr"]:
        pol = safe(lambda: ecr.get_repository_policy(repositoryName=r["repositoryName"])["policyText"], _what="ecr:GetRepositoryPolicy", _ok=("RepositoryPolicyNotFoundException",))
        r["_policy"] = json.loads(pol) if pol else None
        lc = safe(lambda: ecr.get_lifecycle_policy(repositoryName=r["repositoryName"]), _what="ecr:GetLifecyclePolicy", _ok=("LifecyclePolicyNotFoundException",))
        r["_lifecycle"] = bool(lc)

    # RDS
    rds = client("rds", region)
    R["rds"] = safe(pages, rds, "describe_db_instances", "DBInstances", _what="rds:DescribeDBInstances", default=[])
    R["rds_clusters"] = safe(pages, rds, "describe_db_clusters", "DBClusters", _what="rds:DescribeDBClusters", default=[])
    R["rds_snap_public"] = []
    for s in safe(pages, rds, "describe_db_snapshots", "DBSnapshots", SnapshotType="manual", _what="rds:DescribeDBSnapshots", default=[]):
        at = safe(lambda: rds.describe_db_snapshot_attributes(DBSnapshotIdentifier=s["DBSnapshotIdentifier"])["DBSnapshotAttributesResult"]["DBSnapshotAttributes"],
                  _what="rds:DescribeDBSnapshotAttributes", default=[])
        for a in at:
            if a["AttributeName"] == "restore" and "all" in a.get("AttributeValues", []):
                R["rds_snap_public"].append(s["DBSnapshotIdentifier"])

    # ELB
    elb = client("elbv2", region)
    R["lbs"] = safe(pages, elb, "describe_load_balancers", "LoadBalancers", _what="elbv2:DescribeLoadBalancers", default=[])
    waf = client("wafv2", region)
    for lb in R["lbs"]:
        lb["_listeners"] = safe(pages, elb, "describe_listeners", "Listeners", LoadBalancerArn=lb["LoadBalancerArn"], _what="elbv2:DescribeListeners", default=[])
        lb["_attrs"] = {a["Key"]: a["Value"] for a in safe(lambda: elb.describe_load_balancer_attributes(LoadBalancerArn=lb["LoadBalancerArn"])["Attributes"],
                                                            _what="elbv2:DescribeLoadBalancerAttributes", default=[])}
        if lb["Type"] == "application":
            lb["_waf"] = bool((safe(lambda: waf.get_web_acl_for_resource(ResourceArn=lb["LoadBalancerArn"]), _what="wafv2:GetWebACLForResource", default={}) or {}).get("WebACL"))

    # Secrets / KMS / Logs / ACM
    sm = client("secretsmanager", region)
    R["secrets"] = [{k: v for k, v in s.items() if k not in ("SecretVersionsToStages",)}
                    for s in safe(pages, sm, "list_secrets", "SecretList", _what="secretsmanager:ListSecrets", default=[])]
    kms = client("kms", region)
    R["kms"] = []
    for k in safe(pages, kms, "list_keys", "Keys", _what="kms:ListKeys", default=[]):
        md = safe(lambda: kms.describe_key(KeyId=k["KeyId"])["KeyMetadata"], _what="kms:DescribeKey")
        if not md or md.get("KeyManager") != "CUSTOMER" or md.get("KeyState") != "Enabled":
            continue
        md["_rotation"] = safe(lambda: kms.get_key_rotation_status(KeyId=k["KeyId"])["KeyRotationEnabled"], _what="kms:GetKeyRotationStatus")
        pol = safe(lambda: kms.get_key_policy(KeyId=k["KeyId"], PolicyName="default")["Policy"], _what="kms:GetKeyPolicy")
        md["_policy"] = json.loads(pol) if pol else None
        md["_aliases"] = [a["AliasName"] for a in safe(lambda: kms.list_aliases(KeyId=k["KeyId"])["Aliases"], _what="kms:ListAliases", default=[])]
        R["kms"].append(md)
    logs = client("logs", region)
    R["log_groups"] = safe(pages, logs, "describe_log_groups", "logGroups", _what="logs:DescribeLogGroups", default=[])
    acm = client("acm", region)
    R["certs"] = []
    for c in safe(pages, acm, "list_certificates", "CertificateSummaryList", _what="acm:ListCertificates", default=[]):
        d = safe(lambda: acm.describe_certificate(CertificateArn=c["CertificateArn"])["Certificate"], _what="acm:DescribeCertificate")
        if d:
            R["certs"].append({"domain": d["DomainName"], "status": d["Status"], "not_after": str(d.get("NotAfter", "")),
                               "in_use": bool(d.get("InUseBy")), "renewal": d.get("RenewalEligibility")})

    # 账号级安全服务
    R["trails"] = safe(lambda: client("cloudtrail", region).describe_trails(includeShadowTrails=True)["trailList"], _what="cloudtrail:DescribeTrails", default=[])
    for t in R["trails"]:
        st = safe(lambda: client("cloudtrail", region).get_trail_status(Name=t["TrailARN"]), _what="cloudtrail:GetTrailStatus", default={})
        t["_logging"] = (st or {}).get("IsLogging")
    R["guardduty"] = safe(lambda: client("guardduty", region).list_detectors()["DetectorIds"], _what="guardduty:ListDetectors", default=None)
    R["securityhub"] = safe(lambda: client("securityhub", region).describe_hub().get("HubArn"), _what="securityhub:DescribeHub", default=None,
                         _ok=("InvalidAccessException",))  # 没开通，按 finding 处理
    R["config"] = safe(lambda: client("config", region).describe_configuration_recorder_status()["ConfigurationRecordersStatus"], _what="config:DescribeConfigurationRecorderStatus", default=None)
    R["analyzers"] = safe(lambda: client("accessanalyzer", region).list_analyzers()["analyzers"], _what="access-analyzer:ListAnalyzers", default=None)


def _redact_taskdef(d):
    """task definition 里的明文环境变量只保留名字和是否像 secret，不保留值。"""
    for c in d.get("containerDefinitions", []):
        env = []
        for e in c.get("environment", []):
            v = e.get("value", "") or ""
            env.append({"name": e["name"], "len": len(v),
                        "mentions_prod": bool(PROD_RE.search(v)),
                        "mentions_uat": bool(UAT_RE.search(v))})
        c["environment"] = env
    return d


def collect_s3(inv):
    s3 = client("s3")
    out = []
    for b in safe(lambda: s3.list_buckets()["Buckets"], _what="s3:ListBuckets", default=[]):
        n = b["Name"]
        e = {"name": n, "env": env_of(n)}
        e["region"] = (safe(lambda: s3.get_bucket_location(Bucket=n)["LocationConstraint"], _what="s3:GetBucketLocation") or "us-east-1")
        e["public_status"] = safe(lambda: s3.get_bucket_policy_status(Bucket=n)["PolicyStatus"]["IsPublic"], _what="s3:GetBucketPolicyStatus", _ok=("NoSuchBucketPolicy",))
        e["pab"] = safe(lambda: s3.get_public_access_block(Bucket=n)["PublicAccessBlockConfiguration"], _what="s3:GetPublicAccessBlock", _ok=("NoSuchPublicAccessBlockConfiguration",))
        e["versioning"] = safe(lambda: s3.get_bucket_versioning(Bucket=n).get("Status"), _what="s3:GetBucketVersioning")
        acl = safe(lambda: s3.get_bucket_acl(Bucket=n)["Grants"], _what="s3:GetBucketAcl", default=[])
        e["acl_public"] = any("AllUsers" in str(g.get("Grantee", {}).get("URI", "")) or "AuthenticatedUsers" in str(g.get("Grantee", {}).get("URI", "")) for g in acl)
        lg = safe(lambda: s3.get_bucket_logging(Bucket=n), _what="s3:GetBucketLogging", default={})
        e["logging"] = bool((lg or {}).get("LoggingEnabled"))
        out.append(e)
    inv["s3"] = out
    acct = inv["account_id"]
    inv["s3_account_pab"] = safe(lambda: client("s3control", "us-east-1").get_public_access_block(AccountId=acct)["PublicAccessBlockConfiguration"],
                                 _what="s3control:GetPublicAccessBlock", _ok=("NoSuchPublicAccessBlockConfiguration",))


# ================================================================ 检查
def _stmts(doc):
    s = (doc or {}).get("Statement", [])
    return s if isinstance(s, list) else [s]


def _as_list(x):
    return x if isinstance(x, list) else ([] if x is None else [x])


def check_account(inv):
    s = inv["iam"]["summary"]
    if s.get("AccountMFAEnabled") == 0:
        add("高", "安全", "账号", "root 账号", "root 账号没有开 MFA",
            "root 拥有账号全部权限，且不受 IAM policy 限制。密码一旦泄露，UAT 和 PROD 会同时被接管。",
            "用 root 登录后到 Security credentials 绑定 MFA（建议硬件 key 或 passkey），平时不用 root。",
            ["IAM", "Dashboard", "Add MFA for root user"])
    if s.get("AccountAccessKeysPresent"):
        add("高", "安全", "账号", "root 账号", "root 账号存在 Access key",
            "root 的 access key 无法用 policy 限制，泄露等于整个账号失守。",
            "确认没有程序在用后，在 root 的 Security credentials 页面停用并删除。",
            ["账号右上角", "Security credentials", "Access keys"])
    pp = inv["iam"]["password_policy"]
    if not pp:
        add("中", "安全", "账号", "IAM 密码策略", "没有设定 IAM 密码策略",
            "IAM user 可以用很短、不过期的密码登录 console。",
            "设定最少 14 位、包含大小写/数字/符号、禁止重用最近 24 个密码。",
            ["IAM", "Account settings", "Password policy", "Edit"])
    elif pp.get("MinimumPasswordLength", 0) < 14:
        add("低", "安全", "账号", "IAM 密码策略", f"密码最短长度只有 {pp.get('MinimumPasswordLength')} 位",
            "CIS 基线要求至少 14 位。", "把 Minimum password length 改成 14。",
            ["IAM", "Account settings", "Password policy", "Edit"])


def check_iam(inv):
    users = inv["iam"]["users"]
    for u in users:
        if u["console"] and not u["mfa"]:
            add("高", "权限", u["env"], f"IAM user {u['name']}", "能登录 console 但没有开 MFA",
                "只靠密码保护，钓鱼或撞库就能进 console。", "让该用户绑定 MFA；或加一条『没有 MFA 就拒绝』的 policy。",
                ["IAM", "Users", u["name"], "Security credentials", "Assign MFA device"])
        for k in u["keys"]:
            if k["status"] != "Active":
                continue
            if k["age_days"] > 90:
                add("中", "权限", u["env"], f"IAM user {u['name']}（key …{k['id']}）", f"Access key 已经 {k['age_days']} 天没有轮换",
                    "长期不换的 key 一旦外泄（代码仓库、CI 日志、个人电脑）会被一直利用。",
                    "建新 key → 更新使用方 → 停用旧 key 观察 → 删除。能改用 IAM role 的就不要用 key。",
                    ["IAM", "Users", u["name"], "Security credentials", "Access keys"])
            if k["last_used_days"] is None or k["last_used_days"] > 90:
                add("低", "权限", u["env"], f"IAM user {u['name']}（key …{k['id']}）", "Access key 超过 90 天没用过（或从没用过）",
                    "没人用的 key 是白白放着的风险。", "确认无人使用后停用并删除。",
                    ["IAM", "Users", u["name"], "Security credentials", "Access keys"])
        admin = "AdministratorAccess" in u["managed"] or any(_is_admin(d) for _, d in u["docs"])
        if admin:
            add("中", "权限", u["env"], f"IAM user {u['name']}", "IAM user 直接挂了管理员权限",
                "这个人（或这把 key）可以同时改 UAT 和 PROD，无法做到环境隔离，也无法事后区分是谁在哪个环境动的手。",
                "改成通过 group / IAM Identity Center permission set 授权，并按环境拆成 UAT-Admin、PROD-ReadOnly 等。",
                ["IAM", "Users", u["name"], "Permissions"])
    admins = [u["name"] for u in users if "AdministratorAccess" in u["managed"] or any(_is_admin(d) for _, d in u["docs"])
              or any("AdministratorAccess" in g["managed"] for g in inv["iam"]["groups"] if g["name"] in u["groups"])]
    if users and len(admins) >= max(2, len(users) * 0.6):
        add("中", "权限区分", "UAT+PROD", f"{len(admins)}/{len(users)} 个 IAM user", "大部分人都是管理员，没有按 UAT / PROD 分权限",
            "UAT 的日常操作（部署、调试、改 SG）用的是同一套可以改 PROD 的权限，误操作会直接打到 PROD。",
            "至少拆成两组：UAT 可读写、PROD 只读；PROD 写权限只给少数人，并要求 MFA。资源加 Environment tag，用 tag 条件限制。",
            ["IAM", "User groups"], {"admins": admins})

    prod_names = _prod_resource_names(inv)
    for r in inv["iam"]["roles"]:
        trust = r["trust"] or {}
        for st in _stmts(trust):
            if st.get("Effect") != "Allow":
                continue
            pr = st.get("Principal", {})
            aws_p = _as_list(pr.get("AWS")) if isinstance(pr, dict) else _as_list(pr)
            if "*" in aws_p and not st.get("Condition"):
                add("高", "权限", r["env"], f"IAM role {r['name']}", "Trust policy 允许任何 AWS 账号 assume",
                    "Principal 是 * 且没有条件，任何 AWS 账号都能拿到这个 role 的权限。",
                    "把 Principal 改成具体的账号 / role ARN，或加 aws:PrincipalOrgID 条件。",
                    ["IAM", "Roles", r["name"], "Trust relationships"])
            fed = _as_list(pr.get("Federated")) if isinstance(pr, dict) else []
            if any("token.actions.githubusercontent.com" in f for f in fed):
                cond = json.dumps(st.get("Condition", {}))
                if "token.actions.githubusercontent.com:sub" not in cond:
                    add("高", "权限", r["env"], f"IAM role {r['name']}", "GitHub OIDC role 没有限制 repo / branch",
                        "没有 sub 条件时，任何 GitHub 仓库的 Actions 都能 assume 这个 role。",
                        "在 Condition 加 StringLike token.actions.githubusercontent.com:sub = repo:<org>/<repo>:ref:refs/heads/<branch>（PROD role 只允许 main / tag）。",
                        ["IAM", "Roles", r["name"], "Trust relationships"])
        if "AdministratorAccess" in r["managed"] or any(_is_admin(d) for _, d in r["docs"]):
            add("高" if r["env"] == "UAT" else "中", "权限区分", r["env"], f"IAM role {r['name']}", "Role 有完整管理员权限（Action * / Resource *）",
                "UAT 用的 role 有 * 权限，就等于也能改 PROD 的所有资源；ECS task 或 CI 一旦被攻破，影响整个账号。" if r["env"] == "UAT"
                else "管理员权限的 role 被滥用时影响整个账号。",
                "按实际用到的服务和资源收窄；UAT 的 role 用 Resource ARN（名字含 uat）或 aws:ResourceTag/Environment=uat 条件限制。",
                ["IAM", "Roles", r["name"], "Permissions"])
            continue
        if r["env"] == "UAT":
            hits, wild = set(), set()
            for pn, d in r["docs"]:
                for st in _stmts(d):
                    if st.get("Effect") != "Allow":
                        continue
                    for res in _as_list(st.get("Resource")):
                        if PROD_RE.search(res):
                            hits.add(f"{pn}: {res}")
                        elif res == "*" and any(re.match(r"(secretsmanager|ssm|s3|rds|kms|dynamodb|ecs|ecr|ec2|iam|lambda):(\*|Put|Delete|Update|Create|Get|Decrypt|Modify)", a, re.I)
                                                for a in _as_list(st.get("Action"))):
                            wild.add(pn)
            if hits:
                add("高", "权限区分", "UAT", f"IAM role {r['name']}", "UAT 的 role 被授权访问 PROD 资源",
                    "UAT 的程序 / 人可以读写 PROD 的数据或 secret，UAT 出问题会波及 PROD，也违反环境隔离。",
                    "删掉指向 PROD 资源的 statement；如果确实需要，单独建一个只读、可审计的 role。",
                    ["IAM", "Roles", r["name"], "Permissions"], {"statements": sorted(hits)[:10]})
            elif wild and prod_names:
                add("中", "权限区分", "UAT", f"IAM role {r['name']}", "UAT 的 role 对敏感服务用了 Resource: *",
                    "同一个账号里有 PROD 资源，Resource: * 意味着这个 UAT role 也能操作 PROD 的同类资源。",
                    "把 Resource 改成 UAT 资源的 ARN，或加 aws:ResourceTag/Environment = uat 条件。",
                    ["IAM", "Roles", r["name"], "Permissions"], {"policies": sorted(wild)})


def _is_admin(doc):
    for st in _stmts(doc):
        if st.get("Effect") == "Allow" and "*" in _as_list(st.get("Action")) and "*" in _as_list(st.get("Resource")):
            return True
    return False


def _prod_resource_names(inv):
    names = []
    for R in inv["regions"].values():
        names += [v["_name"] for v in R.get("vpcs", []) if v["_env"] == "PROD"]
        names += [c["clusterName"] for c in R.get("ecs_clusters", []) if env_of(c["clusterName"]) == "PROD"]
        names += [d["DBInstanceIdentifier"] for d in R.get("rds", []) if env_of(d["DBInstanceIdentifier"]) == "PROD"]
    return names


def _subnet_rt(R, subnet_id, vpc_id):
    main = None
    for rt in R["route_tables"]:
        for a in rt.get("Associations", []):
            if a.get("SubnetId") == subnet_id:
                return rt
            if a.get("Main") and rt["VpcId"] == vpc_id:
                main = rt
    return main


def _default_route(rt):
    for r in (rt or {}).get("Routes", []):
        if r.get("DestinationCidrBlock") == "0.0.0.0/0":
            return r
    return None


def check_network(region, R, inv):
    vpc_env = {v["VpcId"]: v["_env"] for v in R["vpcs"]}
    vpc_name = {v["VpcId"]: v["_name"] for v in R["vpcs"]}
    for v in R["vpcs"]:
        if v.get("IsDefault"):
            used = any(e["VpcId"] == v["VpcId"] for e in R["enis"])
            if used:
                add("低", "安全", "共用/未标", f"default VPC {v['VpcId']}（{region}）", "default VPC 里有在用的网卡",
                    "default VPC 的 subnet 全是 public，且自动分配公网 IP，资源放进去容易意外暴露。",
                    "把资源搬到自建 VPC；不用的话保留空的 default VPC 即可。", ["VPC", "Your VPCs"])
            continue
        env = v["_env"]
        flows = [f for f in R["flow_logs"] if f.get("ResourceId") == v["VpcId"]]
        if not flows:
            add("中" if env == "PROD" else "低", "安全", env, f"{v['_name']}（{v['VpcId']}）", "VPC 没有开 Flow logs",
                "出事后无法查哪个 IP 连过哪个端口；排查网络问题（像 ECR i/o timeout）也少了直接证据。",
                "开 Flow logs 到 CloudWatch Logs 或 S3，Traffic type 选 All（UAT 可以只选 Reject 省成本）。",
                ["VPC", "Your VPCs", v["_name"], "Flow logs", "Create flow log"])
        has_if_ep = any(e["VpcId"] == v["VpcId"] and e["VpcEndpointType"] == "Interface" for e in R["endpoints"])
        if has_if_ep and (v.get("_enableDnsSupport") is False or v.get("_enableDnsHostnames") is False):
            add("中", "配置", env, f"{v['_name']}（{v['VpcId']}）", "VPC 的 DNS resolution / DNS hostnames 没有全开",
                "VPC endpoint 的 Private DNS 依赖这两个设定，没开时 ECR / Secrets Manager 会被解析成公网 IP。",
                "Actions › Edit VPC settings，两个都勾上。", ["VPC", "Your VPCs", v["_name"], "Actions", "Edit VPC settings"])

    # NAT / 路由
    for rt in R["route_tables"]:
        for r in rt.get("Routes", []):
            if r.get("State") == "blackhole":
                add("中", "配置", vpc_env.get(rt["VpcId"], "?"), f"{rt['RouteTableId']}（{vpc_name.get(rt['VpcId'])}）",
                    f"路由 {r.get('DestinationCidrBlock') or r.get('DestinationPrefixListId')} 是 Blackhole",
                    "目标（NAT / peering / ENI）已经不存在，走这条路由的流量会被丢掉。",
                    "改指向现有的目标，或删除这条路由。", ["VPC", "Route tables", rt["RouteTableId"], "Routes"])
    for n in R["nat"]:
        if n["State"] not in ("available", "deleted", "deleting"):
            add("中", "配置", vpc_env.get(n["VpcId"], "?"), n["NatGatewayId"], f"NAT Gateway 状态是 {n['State']}",
                "NAT 不可用时 private subnet 出不了公网（ECR 拉 image 会 i/o timeout）。",
                "查看 Failure message；必要时重建。", ["VPC", "NAT gateways", n["NatGatewayId"]])
    for v in R["vpcs"]:
        if v.get("IsDefault"):
            continue
        nats = [n for n in R["nat"] if n["VpcId"] == v["VpcId"] and n["State"] == "available"]
        eps = [e["ServiceName"].split(".")[-1] for e in R["endpoints"] if e["VpcId"] == v["VpcId"]]
        v["_nat_count"], v["_endpoints"] = len(nats), sorted(eps)
        private_task_subnets = []
        for s in R["subnets"]:
            if s["VpcId"] != v["VpcId"]:
                continue
            d = _default_route(_subnet_rt(R, s["SubnetId"], v["VpcId"]))
            s["_route"] = (d or {}).get("NatGatewayId") or (d or {}).get("GatewayId") or (d or {}).get("TransitGatewayId") or "无"
            if s["_route"] == "无":
                private_task_subnets.append(s["SubnetId"])
        for e in R["endpoints"]:
            if e["VpcId"] == v["VpcId"] and e["VpcEndpointType"] == "Interface" and not e.get("PrivateDnsEnabled"):
                add("中", "配置", v["_env"], f"{e['VpcEndpointId']}（{e['ServiceName']}）", "Interface endpoint 没开 Private DNS",
                    "没开时程序仍会把服务域名解析成公网 IP、走 NAT，endpoint 形同虚设。",
                    "Actions › Modify private DNS name，勾 Enable。", ["VPC", "Endpoints", e["VpcEndpointId"]])

    # peering / TGW：UAT 和 PROD 是否连通
    for p in R["peering"]:
        if p["Status"]["Code"] != "active":
            continue
        a, b = p["RequesterVpcInfo"]["VpcId"], p["AccepterVpcInfo"]["VpcId"]
        envs = {vpc_env.get(a), vpc_env.get(b)}
        if envs == {"UAT", "PROD"}:
            add("高", "权限区分", "UAT+PROD", f"{p['VpcPeeringConnectionId']}：{vpc_name.get(a, a)} ↔ {vpc_name.get(b, b)}", "UAT VPC 和 PROD VPC 之间有 peering",
                "网络层面 UAT 可以直接连到 PROD 的数据库和服务，UAT 被入侵或配置写错（连错 DB）会直接影响 PROD。",
                "确认用途；不需要就删除 peering。必须保留的话，只在两边 route table 放行具体 CIDR，并用 SG 只允许特定端口。",
                ["VPC", "Peering connections", p["VpcPeeringConnectionId"]])
    tgw_envs = defaultdict(set)
    for t in R["tgw_att"]:
        if t.get("ResourceType") == "vpc" and t.get("State") == "available":
            tgw_envs[t["TransitGatewayId"]].add(vpc_env.get(t["ResourceId"]))
    for tgw, envs in tgw_envs.items():
        if {"UAT", "PROD"} <= envs:
            add("中", "权限区分", "UAT+PROD", tgw, "UAT 和 PROD 的 VPC 接在同一个 Transit Gateway",
                "如果 TGW route table 没分开，UAT 和 PROD 网络是通的。",
                "确认 UAT、PROD attachment 关联到不同的 TGW route table，且彼此没有 propagation。",
                ["VPC", "Transit gateway route tables"])

    # SG
    sg_env = {g["GroupId"]: vpc_env.get(g["VpcId"], "?") for g in R["sgs"]}
    used_sgs = {g["GroupId"] for e in R["enis"] for g in e.get("Groups", [])}
    for g in R["sgs"]:
        env = sg_env[g["GroupId"]]
        label = f"{g['GroupName']}（{g['GroupId']}）"
        in_use = g["GroupId"] in used_sgs
        for p in g.get("IpPermissions", []):
            open_v4 = any(r.get("CidrIp") == "0.0.0.0/0" for r in p.get("IpRanges", []))
            open_v6 = any(r.get("CidrIpv6") == "::/0" for r in p.get("Ipv6Ranges", []))
            if not (open_v4 or open_v6):
                pass
            else:
                proto = p.get("IpProtocol")
                fp, tp = p.get("FromPort"), p.get("ToPort")
                if proto == "-1" or (fp == 0 and tp == 65535):
                    add("高" if in_use else "中", "安全", env, label, "Inbound 对整个互联网开放所有端口",
                        "任何人都可以连到挂这个 SG 的资源的任意端口。" + ("" if in_use else "（目前没有资源在用）"),
                        "删掉这条，只放行需要的端口和来源（例如 ALB 的 SG）。", ["EC2", "Security Groups", g["GroupId"], "Inbound rules"])
                    continue
                for port, svc in SENSITIVE_PORTS.items():
                    if fp is not None and fp <= port <= tp:
                        add("高" if in_use else "中", "安全", env, label, f"{svc}（{port}）对 0.0.0.0/0 开放",
                            f"{svc} 端口暴露在公网，会被持续扫描和暴力破解。" + ("" if in_use else "（目前没有资源在用）"),
                            "改成只允许公司出口 IP / VPN / 跳板机的 SG；SSH 建议改用 Systems Manager Session Manager，不开 22。",
                            ["EC2", "Security Groups", g["GroupId"], "Edit inbound rules"])
            # SG 引用跨环境
            for pair in p.get("UserIdGroupPairs", []):
                other = sg_env.get(pair.get("GroupId"))
                if other and {env, other} == {"UAT", "PROD"}:
                    add("高", "权限区分", "UAT+PROD", label, f"SG 允许来自另一个环境的 SG（{pair['GroupId']}）",
                        "UAT 和 PROD 的资源之间被打通了。", "删除这条跨环境的规则。",
                        ["EC2", "Security Groups", g["GroupId"], "Inbound rules"])
        if g["GroupName"] == "default" and in_use:
            add("低", "安全", env, label, "有资源挂在 default SG 上",
                "default SG 默认允许同 SG 内互通、出站全开；新建资源没选 SG 时会自动挂上，容易在不知情下互相打通。",
                "给资源挂专用 SG；default SG 的规则清空。", ["EC2", "Security Groups", g["GroupId"]])

    # EC2
    for i in R["instances"]:
        if i["State"]["Name"] == "terminated":
            continue
        name = tags_dict(i.get("Tags")).get("Name", i["InstanceId"])
        env = env_of(name) if env_of(name) != "共用/未标" else vpc_env.get(i.get("VpcId"), "?")
        if (i.get("MetadataOptions") or {}).get("HttpTokens") != "required":
            add("中", "安全", env, f"EC2 {name}（{i['InstanceId']}）", "没有强制 IMDSv2",
                "IMDSv1 可以被 SSRF 直接读到 instance role 的临时凭证。",
                "Actions › Instance settings › Modify instance metadata options，IMDSv2 选 Required。",
                ["EC2", "Instances", i["InstanceId"], "Actions", "Instance settings", "Modify instance metadata options"])
        if i.get("PublicIpAddress"):
            add("提示", "安全", env, f"EC2 {name}（{i['InstanceId']}）", f"有公网 IP {i['PublicIpAddress']}",
                "公网可直达，安全全靠 SG。跳板机常见，但要确认 SG 只放行公司 IP。",
                "能用 Session Manager 的话就不需要公网 IP 和 22 端口。", ["EC2", "Instances", i["InstanceId"], "Security"])
    if R["ebs_default_enc"] is False:
        add("中", "安全", "账号", f"EBS（{region}）", "EBS 默认加密没开",
            "新建的磁盘和快照默认不加密。", "EC2 › Settings › EBS encryption › Manage，勾 Always encrypt new EBS volumes（只影响新磁盘）。",
            ["EC2", "Dashboard", "Settings", "EBS encryption"])
    unenc = [v["VolumeId"] for v in R["volumes"] if not v.get("Encrypted")]
    if unenc:
        add("中", "安全", "共用/未标", f"{len(unenc)} 个 EBS volume", "有未加密的 EBS volume",
            "磁盘快照被分享或泄露时数据是明文。", "做加密快照后用它重建 volume（需要停机窗口，先排计划）。",
            ["EC2", "Volumes", "筛选 Encryption = Not encrypted"], {"volumes": unenc[:20]})


def check_ecs(region, R, inv):
    subnet_by_id = {s["SubnetId"]: s for s in R["subnets"]}
    vpc_env = {v["VpcId"]: v["_env"] for v in R["vpcs"]}
    for c in R["ecs_clusters"]:
        env = env_of(c["clusterName"])
        ci = {s["name"]: s["value"] for s in c.get("settings", [])}.get("containerInsights")
        if ci in (None, "disabled"):
            add("低" if env != "PROD" else "中", "配置", env, f"ECS cluster {c['clusterName']}", "没有开 Container Insights",
                "看不到 task 级的 CPU / 内存趋势，OOM、资源不足要靠猜。",
                "Update cluster › Monitoring 选 Container Insights。", ["ECS", "Clusters", c["clusterName"], "Update cluster"])
    for s in R["ecs_services"]:
        env = env_of(s["_cluster"], s["serviceName"])
        label = f"{s['_cluster']} / {s['serviceName']}"
        nc = (s.get("networkConfiguration") or {}).get("awsvpcConfiguration") or {}
        subs = nc.get("subnets", [])
        sub_vpc_envs = {vpc_env.get(subnet_by_id.get(x, {}).get("VpcId")) for x in subs}
        if env in ("UAT", "PROD") and (sub_vpc_envs - {env, None}) & {"UAT", "PROD"}:
            add("高", "权限区分", env, label, f"{env} 的 service 跑在别的环境的 VPC 里",
                "service 名字是 " + env + "，但 subnet 属于另一个环境的 VPC。", "改成对应环境 VPC 的 private subnet。",
                ["ECS", "Clusters", s["_cluster"], "Services", s["serviceName"], "Update service", "Networking"])
        if nc.get("assignPublicIp") == "ENABLED":
            add("中", "安全", env, label, "service 开了 Public IP",
                "task 直接拿到公网 IP，暴露面只靠 SG。和 PROD 用 private subnet + NAT 的做法不一致。",
                "改到 private subnet、Public IP 关掉（需要 NAT 或 VPC endpoint 才能拉 image）。",
                ["ECS", "Clusters", s["_cluster"], "Services", s["serviceName"], "Update service", "Networking"])
        for x in subs:
            sn = subnet_by_id.get(x)
            if sn and str(sn.get("_route", "")).startswith("igw-") and nc.get("assignPublicIp") != "ENABLED":
                add("高", "配置", env, label, f"task 在 public subnet {x}，但 Public IP 是关的",
                    "这种组合 task 出不了公网，拉 ECR image / 取 secret 会 i/o timeout（ResourceInitializationError）。",
                    "改用 private subnet（0.0.0.0/0 → NAT），或打开 Public IP。见《ECS Task 连不上 ECR 排查手册》第 3、7 步。",
                    ["ECS", "Clusters", s["_cluster"], "Services", s["serviceName"], "Update service", "Networking"])
            elif sn and sn.get("_route") == "无":
                vpc = sn["VpcId"]
                has_ecr_ep = any(e["VpcId"] == vpc and e["ServiceName"].endswith("ecr.dkr") for e in R["endpoints"])
                if not has_ecr_ep:
                    add("高", "配置", env, label, f"task 的 subnet {x} 没有 0.0.0.0/0 路由，VPC 里也没有 ECR endpoint",
                        "task 没有任何路可以到 ECR / Secrets Manager，启动必定失败。",
                        "照《ECS Task 连不上 ECR 排查手册》第 3–4 步补 NAT 路由，或建 ecr.api / ecr.dkr / s3 / secretsmanager / logs endpoint。",
                        ["VPC", "Subnets", x, "Route table"])
        dc = s.get("deploymentConfiguration", {})
        if not (dc.get("deploymentCircuitBreaker") or {}).get("enable"):
            add("低", "配置", env, label, "没有开 deployment circuit breaker",
                "新版本起不来时 ECS 会一直重试，不会自动回滚。", "Update service › Deployment options 勾 Use the Amazon ECS deployment circuit breaker + Rollback on failures。",
                ["ECS", "Clusters", s["_cluster"], "Services", s["serviceName"], "Update service"])
        if s.get("enableExecuteCommand") and env == "PROD":
            add("提示", "安全", env, label, "PROD service 开了 ECS Exec",
                "可以直接进入 PROD 容器执行命令。", "确认只有少数人的 role 有 ecs:ExecuteCommand，且 Exec 的 session 有记录到 CloudWatch / S3。",
                ["ECS", "Clusters", s["_cluster"], "Configuration"])
        if s.get("desiredCount", 0) > 0 and s.get("runningCount", 0) < s.get("desiredCount", 0):
            add("中", "配置", env, label, f"running {s.get('runningCount')} / desired {s.get('desiredCount')}",
                "service 没有达到期望的 task 数，可能正在反复启动失败。",
                "看 Events 和最近 stopped task 的 Stopped reason。", ["ECS", "Clusters", s["_cluster"], "Services", s["serviceName"], "Events"])

        td = R["task_defs"].get(s["taskDefinition"])
        if not td:
            continue
        tdn = f"{td['family']}:{td['revision']}"
        for role_key in ("executionRoleArn", "taskRoleArn"):
            arn = td.get(role_key)
            if arn and env in ("UAT", "PROD") and env_of(arn.split("/")[-1]) not in (env, "共用/未标"):
                add("高", "权限区分", env, f"task definition {tdn}", f"{role_key} 用了另一个环境的 role（{arn.split('/')[-1]}）",
                    "UAT 的 task 拿着 PROD 的权限（或反过来），等于环境没有隔离。", "为每个环境建独立的 role。",
                    ["ECS", "Task definitions", td["family"], "Create new revision"])
        s["_roles"] = (td.get("executionRoleArn"), td.get("taskRoleArn"))
        for c in td.get("containerDefinitions", []):
            cn = f"{tdn} / {c['name']}"
            img = c.get("image", "")
            if img.endswith(":latest") or (":" not in img.split("/")[-1] and "@sha256" not in img):
                add("中" if env == "PROD" else "低", "配置", env, cn, "image 用的是 latest（或没有 tag）",
                    "无法确定跑的是哪个版本；UAT 验过的和 PROD 部署的可能不是同一个 image。",
                    "用不可变的 tag（git sha / 版本号）或 @sha256 digest，UAT 验过的同一个 digest 再推到 PROD。",
                    ["ECS", "Task definitions", td["family"], "Create new revision"])
            if env in ("UAT", "PROD"):
                other = "PROD" if env == "UAT" else "UAT"
                hit = [e["name"] for e in c.get("environment", []) if e[f"mentions_{other.lower()}"]]
                if hit:
                    add("高", "权限区分", env, cn, f"环境变量的值里出现 {other.lower()}：{', '.join(hit[:6])}",
                        f"{env} 的容器可能连到 {other} 的数据库 / API / bucket。", "逐个确认；配置值改成本环境的资源。",
                        ["ECS", "Task definitions", td["family"], "Containers", c["name"], "Environment variables"])
            plain = [e["name"] for e in c.get("environment", []) if SECRET_NAME_RE.search(e["name"]) and e["len"] > 0]
            if plain:
                add("高", "安全", env, cn, f"疑似密码 / key 以明文环境变量存放：{', '.join(plain[:6])}",
                    "task definition 的明文环境变量任何有 ecs:DescribeTaskDefinition 权限的人都看得到，也会留在每个历史 revision。",
                    "改到 Secrets Manager / SSM SecureString，用 container 的 secrets 字段引用；值本身要轮换（已经暴露过）。",
                    ["ECS", "Task definitions", td["family"], "Create new revision", "Environment variables"])
            for sec in c.get("secrets", []):
                src = sec.get("valueFrom", "")
                se = env_of(src.split(":")[-1]) if src else None
                if env in ("UAT", "PROD") and se in ("UAT", "PROD") and se != env:
                    add("高", "权限区分", env, cn, f"引用了 {se} 的 secret（{sec['name']}）",
                        f"{env} 的容器拿到的是 {se} 的凭证。", "为本环境建独立 secret，并在 execution role 里只授权本环境的 secret ARN。",
                        ["ECS", "Task definitions", td["family"], "Containers", c["name"], "Secrets"])
            if c.get("privileged"):
                add("高", "安全", env, cn, "容器以 privileged 模式运行", "容器逃逸后可以控制宿主机。", "去掉 privileged。",
                    ["ECS", "Task definitions", td["family"]])
            if not c.get("logConfiguration"):
                add("中", "配置", env, cn, "容器没有设定 log 输出", "容器报错时 Logs tab 什么都没有，只能靠猜。",
                    "logConfiguration 用 awslogs，指定 log group。", ["ECS", "Task definitions", td["family"], "Create new revision", "Logging"])


def check_data(region, R, inv):
    for d in R["rds"]:
        n = d["DBInstanceIdentifier"]
        env = env_of(n)
        p = ["RDS", "Databases", n, "Modify"]
        if d.get("PubliclyAccessible"):
            add("高", "安全", env, f"RDS {n}", "数据库设成 Publicly accessible",
                "有公网 DNS 解析，只要 SG 有一条放宽，数据库就直接暴露在互联网。",
                "Modify › Connectivity › Public access 选 Not publicly accessible；从跳板机或 VPN 连。", p)
        if not d.get("StorageEncrypted"):
            add("高" if env == "PROD" else "中", "安全", env, f"RDS {n}", "数据库存储没有加密",
                "备份和快照都是明文，快照被分享 / 复制时会泄露数据。",
                "不能直接打开：做快照 → 复制快照时加密 → 用加密快照还原 → 切换连接。需要停机窗口。", ["RDS", "Databases", n, "Configuration"])
        if d.get("BackupRetentionPeriod", 0) == 0:
            add("高" if env == "PROD" else "低", "配置", env, f"RDS {n}", "自动备份关闭（保留 0 天）",
                "误删数据或数据损坏时无法做时间点还原。", "Backup retention period 设 7 天以上（PROD 建议 14–35 天）。", p)
        if not d.get("DeletionProtection") and env == "PROD":
            add("中", "配置", env, f"RDS {n}", "PROD 数据库没开 Deletion protection",
                "一次误操作就能删掉 PROD 数据库。", "Modify 勾 Enable deletion protection。", p)
        if not d.get("MultiAZ") and env == "PROD" and not d.get("DBClusterIdentifier"):
            add("中", "配置", env, f"RDS {n}", "PROD 数据库是 Single-AZ",
                "AZ 故障或维护时 PROD 会停机。", "Modify › Multi-AZ deployment 选 Create a standby instance（费用约翻倍，评估后决定）。", p)
        ca = d.get("CACertificateIdentifier", "")
        if ca and ca in ("rds-ca-2019",):
            add("中", "配置", env, f"RDS {n}", f"CA 证书是 {ca}（已过期）", "用 SSL 校验的客户端会连不上。", "改为 rds-ca-rsa2048-g1。", p)
    for sn in R["rds_snap_public"]:
        add("高", "安全", env_of(sn), f"RDS 快照 {sn}", "手动快照被设为公开",
            "任何 AWS 账号都可以用这个快照还原出完整数据库。", "Actions › Share snapshot，把 Public 改成 Private。", ["RDS", "Snapshots", sn])

    for r in R["ecr"]:
        n = r["repositoryName"]
        env = env_of(n)
        scan = (r.get("imageScanningConfiguration") or {}).get("scanOnPush")
        reg = R.get("ecr_registry_scan") or {}
        if not scan and not reg.get("rules"):
            add("低", "安全", env, f"ECR {n}", "没有开 image 扫描", "已知漏洞的 image 会被直接部署。",
                "Private registry › Scanning 设 Scan on push（Basic 免费）。", ["ECR", "Private registry", "Scanning"])
        if r.get("imageTagMutability") == "MUTABLE":
            add("低", "配置", env, f"ECR {n}", "tag 可以被覆盖（MUTABLE）",
                "同一个 tag 可能前后指向不同的 image，UAT 测过的版本和 PROD 跑的不一定一样。",
                "Edit › Tag immutability 选 Immutable（之后不能再推同名 tag，CI 要用唯一 tag）。", ["ECR", "Repositories", n, "Edit"])
        if not r["_lifecycle"]:
            add("提示", "配置", env, f"ECR {n}", "没有 lifecycle policy", "旧 image 一直累积、持续收费。",
                "加规则：untagged 超过 14 天删除，只保留最近 N 个 tag。", ["ECR", "Repositories", n, "Lifecycle Policy"])
        for st in _stmts(r["_policy"]):
            pr = st.get("Principal")
            if st.get("Effect") == "Allow" and (pr == "*" or (isinstance(pr, dict) and "*" in _as_list(pr.get("AWS")))) and not st.get("Condition"):
                add("高", "安全", env, f"ECR {n}", "Repository policy 允许任何人", "任何 AWS 账号都能拉取（甚至推送）image。",
                    "把 Principal 改成具体的账号。", ["ECR", "Repositories", n, "Permissions"])

    for s in R["secrets"]:
        env = env_of(s["Name"])
        if not s.get("RotationEnabled") and env == "PROD":
            add("低", "安全", env, f"Secret {s['Name']}", "PROD secret 没开自动轮换",
                "密码长期不变，外泄后会一直有效。", "RDS 密码可直接用 Secrets Manager 的轮换模板；其他的至少定期手动轮换。",
                ["Secrets Manager", s["Name"], "Rotation"])
        la = s.get("LastAccessedDate")
        if la and (dt.datetime.now(dt.timezone.utc) - la).days > 120:
            add("提示", "配置", env, f"Secret {s['Name']}", f"超过 {(dt.datetime.now(dt.timezone.utc) - la).days} 天没有被读取",
                "可能已经没用了。", "确认后安排删除（有 7–30 天的恢复期）。", ["Secrets Manager", s["Name"]])

    for k in R["kms"]:
        name = ",".join(k["_aliases"]) or k["KeyId"]
        if k.get("_rotation") is False and k.get("KeySpec") == "SYMMETRIC_DEFAULT":
            add("低", "安全", env_of(name), f"KMS {name}", "customer managed key 没开自动轮换",
                "CIS 基线要求。", "Key rotation 勾 Automatically rotate（每年，不影响已加密的数据）。", ["KMS", "Customer managed keys", k["KeyId"], "Key rotation"])
        for st in _stmts(k.get("_policy")):
            pr = st.get("Principal")
            if st.get("Effect") == "Allow" and (pr == "*" or (isinstance(pr, dict) and "*" in _as_list(pr.get("AWS")))) and not st.get("Condition"):
                add("高", "安全", env_of(name), f"KMS {name}", "Key policy 允许任何人使用",
                    "任何 AWS 账号都可以用这把 key 解密。", "把 Principal 改成本账号或具体 role。", ["KMS", "Customer managed keys", k["KeyId"], "Key policy"])

    no_ret = [g["logGroupName"] for g in R["log_groups"] if not g.get("retentionInDays")]
    if no_ret:
        add("低", "配置", "共用/未标", f"{len(no_ret)} 个 log group（{region}）", "CloudWatch log group 设成永久保存",
            "日志会一直累积收费；UAT 尤其没必要。", "UAT 设 14–30 天，PROD 按合规要求（例如 90–365 天）。",
            ["CloudWatch", "Log groups", "Actions", "Edit retention setting"], {"groups": no_ret[:30]})

    now = dt.datetime.now(dt.timezone.utc)
    for c in R["certs"]:
        if c["not_after"] and c["in_use"]:
            na = dt.datetime.fromisoformat(c["not_after"])
            days = (na - now).days
            if days < 30 and c.get("renewal") != "ELIGIBLE":
                add("中", "配置", env_of(c["domain"]), f"ACM {c['domain']}", f"证书 {days} 天后到期且不会自动续期",
                    "到期后网站 HTTPS 会报错。", "检查 DNS 验证记录是否还在；或重新申请。", ["Certificate Manager", c["domain"]])

    for lb in R["lbs"]:
        n = lb["LoadBalancerName"]
        env = env_of(n)
        for l in lb["_listeners"]:
            if l["Protocol"] == "HTTP":
                redirect = any(a.get("Type") == "redirect" for a in l.get("DefaultActions", []))
                if not redirect:
                    add("中", "安全", env, f"ALB {n}:{l['Port']}", "HTTP listener 没有转 HTTPS",
                        "登录和业务数据可能以明文在网络上传输。", "把 HTTP:80 的 default action 改成 Redirect to HTTPS:443。",
                        ["EC2", "Load balancers", n, "Listeners and rules"])
            if l["Protocol"] == "HTTPS" and l.get("SslPolicy") and re.search(r"2016-08|TLS-1-0|TLS-1-1|2015", l["SslPolicy"]):
                add("中", "安全", env, f"ALB {n}:{l['Port']}", f"TLS policy 太旧（{l['SslPolicy']}）",
                    "允许 TLS 1.0 / 1.1，不符合 PCI 等要求。", "改成 ELBSecurityPolicy-TLS13-1-2-2021-06。",
                    ["EC2", "Load balancers", n, "Listeners and rules", "Edit listener"])
        if lb["_attrs"].get("access_logs.s3.enabled") != "true":
            add("低", "安全", env, f"ALB {n}", "没有开 access logs", "出事后查不到谁访问过什么。",
                "Attributes › Access logs 打开，写到 S3。", ["EC2", "Load balancers", n, "Attributes"])
        if lb["Type"] == "application" and lb["_attrs"].get("routing.http.drop_invalid_header_fields.enabled") != "true":
            add("低", "安全", env, f"ALB {n}", "没有丢弃不合法的 HTTP header", "可能被用来做 request smuggling。",
                "Attributes › Drop invalid header fields 打开。", ["EC2", "Load balancers", n, "Attributes"])
        if lb["Scheme"] == "internet-facing" and lb["Type"] == "application" and not lb.get("_waf"):
            add("中" if env == "PROD" else "提示", "安全", env, f"ALB {n}", "对公网开放但没有挂 WAF",
                "SQL 注入、扫描器、爆破请求直接打到应用。" + ("UAT 对公网开放的话，至少限制来源 IP。" if env == "UAT" else ""),
                "挂 WAF 的 AWS managed rules（Core rule set + Known bad inputs）；UAT 用 SG 只放行公司 IP。",
                ["EC2", "Load balancers", n, "Integrations", "AWS WAF"])
        if env == "PROD" and lb["_attrs"].get("deletion_protection.enabled") != "true":
            add("低", "配置", env, f"ALB {n}", "PROD 负载均衡器没开 deletion protection", "误删会直接中断 PROD。",
                "Attributes › Deletion protection 打开。", ["EC2", "Load balancers", n, "Attributes"])


def check_account_services(inv):
    regions = inv["regions"]
    trails = [t for R in regions.values() for t in R.get("trails", [])]
    if not any(t.get("IsMultiRegionTrail") and t.get("_logging") for t in trails):
        add("高", "安全", "账号", "CloudTrail", "没有在记录的 multi-region CloudTrail",
            "没有 API 操作记录：谁改了 SG、谁删了资源都查不到，也无法证明这次检查是只读。",
            "建一个 multi-region trail 写到专用 S3 bucket，打开 Log file validation。", ["CloudTrail", "Trails", "Create trail"])
    elif not any(t.get("LogFileValidationEnabled") for t in trails):
        add("低", "安全", "账号", "CloudTrail", "trail 没开 Log file validation", "无法证明日志没被改过。", "Edit trail 勾 Log file validation。", ["CloudTrail", "Trails"])
    for region, R in regions.items():
        if R.get("guardduty") == []:
            add("中", "安全", "账号", f"GuardDuty（{region}）", "GuardDuty 没有开启",
                "账号被盗用、挖矿、异常 API 调用不会有任何告警。", "开启 GuardDuty（30 天免费试用，之后按量计费）。", ["GuardDuty", "Get started"])
        if R.get("securityhub") is None and not any(e["what"] == "securityhub:DescribeHub" for e in ERRORS):
            add("低", "安全", "账号", f"Security Hub（{region}）", "Security Hub 没有开启",
                "没有持续的配置合规检查，这份报告只能代表今天的状态。",
                "开启 Security Hub + AWS Foundational Security Best Practices 标准。", ["Security Hub", "Go to Security Hub"])
        if R.get("config") == []:
            add("低", "安全", "账号", f"AWS Config（{region}）", "AWS Config 没有记录",
                "配置变更没有历史，UAT 和 PROD 什么时候开始不一样无从查起。", "开 Config recorder（可只记录关键资源类型控制成本）。", ["Config", "Get started"])
        if R.get("analyzers") == []:
            add("低", "安全", "账号", f"IAM Access Analyzer（{region}）", "没有建 Access Analyzer",
                "被分享到账号外的 S3 / KMS / role 没人发现。", "建一个 account 级的 analyzer（免费）。", ["IAM", "Access analyzer", "Create analyzer"])

    pab = inv.get("s3_account_pab")
    if not pab or not all(pab.values()):
        add("中", "安全", "账号", "S3 账号级 Block Public Access", "账号级的 S3 公开访问封锁没有全开",
            "任何一个 bucket 的 policy / ACL 写错，就会直接公开。", "S3 › Block Public Access settings for this account，四项全开（先确认没有需要公开的 bucket）。",
            ["S3", "Block Public Access settings for this account"])
    for b in inv["s3"]:
        if b["public_status"] or b["acl_public"]:
            add("高", "安全", b["env"], f"S3 {b['name']}", "bucket 是公开的",
                "bucket 里的文件可能被任何人读取（或写入）。", "确认是否本该公开（静态网站用 CloudFront + OAC 代替）；否则移除公开的 policy / ACL 并打开 Block Public Access。",
                ["S3", b["name"], "Permissions"])
        elif not b["pab"] or not all(b["pab"].values()):
            if pab and all(pab.values()):
                continue
            add("低", "安全", b["env"], f"S3 {b['name']}", "bucket 级 Block Public Access 没有全开", "防线少一层。",
                "Permissions › Block public access 四项全开。", ["S3", b["name"], "Permissions"])
        if b["env"] == "PROD" and b["versioning"] != "Enabled":
            add("低", "配置", b["env"], f"S3 {b['name']}", "PROD bucket 没开 versioning", "误删 / 覆盖后无法恢复。",
                "Properties › Bucket Versioning › Enable，并加 lifecycle 清理旧版本。", ["S3", b["name"], "Properties"])


# ---------------------------------------------------------------- UAT 对照 PROD
def check_drift(inv):
    """名字里把 uat/prod 换掉后能配对的资源，比较关键设定。"""
    groups = defaultdict(lambda: {"UAT": [], "PROD": []})

    def put(kind, name, attrs):
        e = env_of(name)
        if e in ("UAT", "PROD"):
            groups[(kind, pair_key(name))][e].append((name, attrs))

    for region, R in inv["regions"].items():
        for v in R["vpcs"]:
            if not v.get("IsDefault"):
                subs = [s for s in R["subnets"] if s["VpcId"] == v["VpcId"]]
                put("VPC", v["_name"], {
                    "NAT Gateway 数量": v.get("_nat_count"),
                    "VPC endpoints": ", ".join(v.get("_endpoints", [])) or "无",
                    "Flow logs": "有" if any(f.get("ResourceId") == v["VpcId"] for f in R["flow_logs"]) else "无",
                    "private subnet 数（0.0.0.0/0→NAT）": sum(1 for s in subs if str(s.get("_route", "")).startswith("nat-")),
                    "public subnet 数（0.0.0.0/0→IGW）": sum(1 for s in subs if str(s.get("_route", "")).startswith("igw-")),
                })
        for c in R["ecs_clusters"]:
            put("ECS cluster", c["clusterName"], {"Container Insights": {s["name"]: s["value"] for s in c.get("settings", [])}.get("containerInsights", "disabled")})
        for s in R["ecs_services"]:
            nc = (s.get("networkConfiguration") or {}).get("awsvpcConfiguration") or {}
            subn = {x["SubnetId"]: x for x in R["subnets"]}
            kinds = sorted({("private" if str(subn.get(x, {}).get("_route", "")).startswith("nat-") else
                             "public" if str(subn.get(x, {}).get("_route", "")).startswith("igw-") else "无出口") for x in nc.get("subnets", [])})
            td = R["task_defs"].get(s["taskDefinition"], {})
            put("ECS service", f"{s['_cluster']}/{s['serviceName']}", {
                "launch type": s.get("launchType") or ",".join(p["capacityProvider"] for p in s.get("capacityProviderStrategy", [])),
                "subnet 类型": ", ".join(kinds),
                "Public IP": nc.get("assignPublicIp"),
                "circuit breaker": ((s.get("deploymentConfiguration") or {}).get("deploymentCircuitBreaker") or {}).get("enable"),
                "task CPU / 内存": f"{td.get('cpu')} / {td.get('memory')}",
                "环境变量名": ", ".join(sorted(e["name"] for c in td.get("containerDefinitions", []) for e in c.get("environment", []))) or "无",
                "secrets 名": ", ".join(sorted(x["name"] for c in td.get("containerDefinitions", []) for x in c.get("secrets", []))) or "无",
                "log driver": ", ".join(sorted({(c.get("logConfiguration") or {}).get("logDriver", "无") for c in td.get("containerDefinitions", [])})),
            })
        for d in R["rds"]:
            put("RDS", d["DBInstanceIdentifier"], {
                "engine": f"{d['Engine']} {d['EngineVersion']}", "加密": d.get("StorageEncrypted"),
                "Publicly accessible": d.get("PubliclyAccessible"), "备份天数": d.get("BackupRetentionPeriod"),
                "Multi-AZ": d.get("MultiAZ"), "Deletion protection": d.get("DeletionProtection"),
                "parameter group": ",".join(p["DBParameterGroupName"] for p in d.get("DBParameterGroups", [])),
                "CA": d.get("CACertificateIdentifier"),
            })
        for lb in R["lbs"]:
            put("负载均衡器", lb["LoadBalancerName"], {
                "scheme": lb["Scheme"], "listeners": ", ".join(sorted(f"{l['Protocol']}:{l['Port']}" for l in lb["_listeners"])),
                "TLS policy": ", ".join(sorted({l.get("SslPolicy") for l in lb["_listeners"] if l.get("SslPolicy")})) or "无",
                "WAF": lb.get("_waf"), "access logs": lb["_attrs"].get("access_logs.s3.enabled"),
            })
        for r in R["ecr"]:
            put("ECR", r["repositoryName"], {"scan on push": (r.get("imageScanningConfiguration") or {}).get("scanOnPush"),
                                             "tag mutability": r.get("imageTagMutability"), "lifecycle": r["_lifecycle"]})
        for s in R["secrets"]:
            put("Secret", s["Name"], {"rotation": s.get("RotationEnabled", False), "KMS": "customer key" if s.get("KmsKeyId") else "aws/secretsmanager"})
        for g in R["log_groups"]:
            put("Log group", g["logGroupName"], {"retention": g.get("retentionInDays", "永久")})

    inv["drift"] = []
    uat_only, prod_only = [], []
    # 只有在「UAT 比 PROD 弱」时算问题；其他差异列为提示（可能是刻意的，例如规格小）
    weaker_keys = {"Flow logs", "Container Insights", "circuit breaker", "加密", "备份天数", "scan on push", "access logs", "WAF", "TLS policy"}
    hard_keys = {"subnet 类型", "Public IP", "环境变量名", "secrets 名", "log driver", "VPC endpoints", "private subnet 数（0.0.0.0/0→NAT）", "NAT Gateway 数量", "engine", "listeners"}
    for (kind, key), envs in groups.items():
        u, p = envs["UAT"], envs["PROD"]
        if u and not p:
            uat_only.append(f"{kind}: {u[0][0]}")
            continue
        if p and not u:
            prod_only.append(f"{kind}: {p[0][0]}")
            continue
        (un, ua), (pn, pa) = u[0], p[0]
        diffs = [(k, ua.get(k), pa.get(k)) for k in pa if str(ua.get(k)) != str(pa.get(k))]
        inv["drift"].append({"kind": kind, "uat": un, "prod": pn, "diffs": diffs})
        if not diffs:
            continue
        hard = [d for d in diffs if d[0] in hard_keys]
        weak = [d for d in diffs if d[0] in weaker_keys]
        rest = [d for d in diffs if d not in hard and d not in weak]
        if hard:
            add("中", "UAT vs PROD", "UAT", f"{kind}：{un} ↔ {pn}", "UAT 和 PROD 的结构性设定不一致",
                "UAT 是按 PROD 建的，这些差异会让『UAT 测过 = PROD 能跑』不成立（例如网络路径、环境变量、secret 名不同，上线时才发现缺东西）。",
                "逐项确认是否刻意；不是的话按 PROD 修正 UAT。最好把两边改成同一份 IaC（Terraform / CDK）用参数区分环境。",
                evidence={"diffs": hard})
        if weak:
            add("低", "UAT vs PROD", "UAT", f"{kind}：{un} ↔ {pn}", "UAT 的安全 / 可观测性设定和 PROD 不同",
                "UAT 少了 PROD 有的保护或监控，问题在 UAT 阶段发现不了。", "按 PROD 的设定补齐（成本敏感的项目可以说明后保留差异）。",
                evidence={"diffs": weak})
        if rest:
            add("提示", "UAT vs PROD", "UAT", f"{kind}：{un} ↔ {pn}", "其他差异（多半是刻意的规格差，确认即可）",
                "列出来供核对。", "确认后在 IaC / 文档里注明是刻意的差异。", evidence={"diffs": rest})
    if prod_only:
        add("中", "UAT vs PROD", "UAT", f"{len(prod_only)} 项资源", "PROD 有、UAT 没有对应的资源",
            "UAT 缺了 PROD 有的组件，相关功能在 UAT 测不到。", "逐项确认是否需要在 UAT 补建。", evidence={"items": prod_only[:40]})
    if uat_only:
        add("提示", "UAT vs PROD", "UAT", f"{len(uat_only)} 项资源", "UAT 有、PROD 没有对应的资源",
            "可能是测试遗留，或 PROD 的命名不同所以没配对上。", "确认是否还在用，不用的清掉省成本。", evidence={"items": uat_only[:40]})


def check_separation(inv):
    """同账号、共用 role / KMS / secret 等。"""
    envs = defaultdict(set)
    for R in inv["regions"].values():
        for v in R["vpcs"]:
            envs[v["_env"]].add(v["_name"])
        for c in R["ecs_clusters"]:
            envs[env_of(c["clusterName"])].add(c["clusterName"])
    if envs.get("UAT") and envs.get("PROD"):
        add("中", "权限区分", "UAT+PROD", f"账号 {inv['account_id']}", "UAT 和 PROD 在同一个 AWS 账号里",
            "账号是 AWS 最强的隔离边界。同账号时只能靠 IAM policy 一条条限制，任何一个 Resource: * 都会跨环境；配额、费用也混在一起。",
            "中期：用 AWS Organizations 把 PROD 搬到独立账号。短期：所有资源打 Environment tag，IAM 用 tag 条件限制，PROD 写权限单独授权。",
            ["AWS Organizations"], {"UAT": sorted(envs["UAT"]), "PROD": sorted(envs["PROD"])})
    role_use = defaultdict(set)
    for R in inv["regions"].values():
        for s in R["ecs_services"]:
            for arn in s.get("_roles", ()) or ():
                if arn:
                    role_use[arn].add(env_of(s["_cluster"], s["serviceName"]))
    for arn, es in role_use.items():
        if {"UAT", "PROD"} <= es:
            add("高", "权限区分", "UAT+PROD", f"IAM role {arn.split('/')[-1]}", "UAT 和 PROD 的 ECS task 共用同一个 role",
                "UAT 的 task 拥有和 PROD 完全一样的权限（能读 PROD 的 secret、bucket）。", "为 UAT 建独立的 execution / task role，只授权 UAT 资源。",
                ["IAM", "Roles", arn.split("/")[-1]])


# ================================================================ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--regions", default="ap-southeast-5", help="逗号分隔；all = 所有已启用的 region")
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    inv = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "regions": {}}
    collect_identity(inv)
    regions = a.regions.split(",")
    if a.regions == "all":
        regions = [r["RegionName"] for r in client("ec2", "us-east-1").describe_regions(AllRegions=False)["Regions"]]
    inv["region_list"] = regions
    print(f"账号 {inv['account_id']}  身份 {inv['identity']['Arn']}  region {regions}", file=sys.stderr)
    collect_iam(inv)
    for r in regions:
        print(f"  采集 {r} …", file=sys.stderr)
        collect_region(r, inv)
    collect_s3(inv)

    check_account(inv)
    check_iam(inv)
    for r, R in inv["regions"].items():
        check_network(r, R, inv)
        check_ecs(r, R, inv)
        check_data(r, R, inv)
    check_account_services(inv)
    check_drift(inv)
    check_separation(inv)

    FINDINGS.sort(key=lambda f: (SEV_ORDER[f["severity"]], f["area"], f["env"], f["resource"]))
    for i, f in enumerate(FINDINGS, 1):
        f["id"] = i
    with open(os.path.join(a.out, "inventory.json"), "w") as fh:
        json.dump(inv, fh, ensure_ascii=False, indent=1, default=str)
    with open(os.path.join(a.out, "findings.json"), "w") as fh:
        json.dump({"account_id": inv["account_id"], "aliases": inv["iam"]["aliases"], "identity": inv["identity"]["Arn"],
                   "regions": regions, "generated_at": inv["generated_at"], "findings": FINDINGS, "errors": ERRORS,
                   "drift": inv["drift"],
                   "vpcs": [{"region": r, "name": v["_name"], "id": v["VpcId"], "env": v["_env"], "cidr": v["CidrBlock"]}
                            for r, R in inv["regions"].items() for v in R["vpcs"] if not v.get("IsDefault")]},
                  fh, ensure_ascii=False, indent=1, default=str)
    c = defaultdict(int)
    for f in FINDINGS:
        c[f["severity"]] += 1
    print(f"完成：{dict(c)}，未能检查 {len(ERRORS)} 项 → {a.out}/findings.json", file=sys.stderr)


if __name__ == "__main__":
    main()
