"""Reads the rendered store chart on stdin and checks the ResourceQuota against the worst case:
every pod the chart can run at once (Deployments, StatefulSet, the wp-cron pod and the bootstrap
Job, which all overlap while a store is created), each at its limits. Exits 1 when a quota is exceeded."""

import re
import sys

import yaml

MI = {"Ki": 1 / 1024, "Mi": 1, "Gi": 1024}


def mem(v):
    m = re.fullmatch(r"(\d+)(Ki|Mi|Gi)", str(v))
    return int(m[1]) * MI[m[2]]


def cpu(v):
    v = str(v)
    return int(v[:-1]) if v.endswith("m") else int(float(v) * 1000)


def pod_spec(d):
    if d["kind"] in ("Deployment", "StatefulSet", "Job"):
        return d["spec"]["template"]["spec"]
    if d["kind"] == "CronJob":
        return d["spec"]["jobTemplate"]["spec"]["template"]["spec"]
    return None


def need(spec, key, parse):
    # Init containers run before the others, so a pod needs the larger of the two.
    main = sum(parse(c["resources"]["limits"][key]) for c in spec["containers"])
    init = [parse(c["resources"]["limits"][key]) for c in spec.get("initContainers", [])]
    return max([main, *init])


docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
quota = next(d for d in docs if d["kind"] == "ResourceQuota")["spec"]["hard"]
pods = [(f"{d['kind']}/{d['metadata']['name']}", pod_spec(d)) for d in docs if pod_spec(d)]
total_mem = sum(need(s, "memory", mem) for _, s in pods)
total_cpu = sum(need(s, "cpu", cpu) for _, s in pods)

print(
    f"{len(pods)} pods, limits.memory {total_mem:g}Mi of {quota['limits.memory']}, "
    f"limits.cpu {total_cpu}m of {quota['limits.cpu']}"
)
bad = []
if total_mem > mem(quota["limits.memory"]):
    bad.append("limits.memory")
if total_cpu > cpu(quota["limits.cpu"]):
    bad.append("limits.cpu")
if len(pods) > int(quota["pods"]):
    bad.append("pods")
if bad:
    print("over quota: " + ", ".join(bad))
    sys.exit(1)
