#!/usr/bin/env python3
"""Scan container images for secrets before a GHCR package is made public.

    python3 -I scripts/image-secret-scan.py <image> [<image> ...]
    python3 -I scripts/image-secret-scan.py ghcr.io/vinayakjeet/gateway:0.1.0-ca62fac

Each image is exported with `docker save`, and every layer is read in memory (a file deleted
in a later layer still ships in an earlier one). Nothing is extracted to disk. Checks:

  1. File names: .env files, ssh keys, .git, .notes, .superpowers, deploy/secrets, password
     files, cloud and kube config, CLAUDE.md and .claude (outside node_modules). These fail the run.
     Public certificate bundles, .npmrc and a .claude folder inside node_modules are listed only.
  2. File contents up to 5 MB: GitHub, AWS, Google, Groq, OpenAI style and Slack tokens, PEM private
     key blocks and long bearer strings. A match needs a human to read it: base images carry test keys.
  3. The image config and the `docker history` lines, for the same patterns and for env names
     that look sensitive.
  4. The values of local secrets, searched byte for byte: files in deploy/secrets and .notes/demo,
     $S/demo.key, and environment variables named like KEY, TOKEN, SECRET or PASSWORD. Values are
     never printed; a hit names only the file or variable.

Exit code: 0 nothing found, 1 a value or a forbidden file name was found, 2 a content pattern
needs review. Run it on the images pulled from GHCR, not only on a local build: those are the
bytes the world gets. The script holds no secrets and prints none.
"""
import glob
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

MAX_FILE = 5 * 1024 * 1024
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FORBIDDEN_NAMES = {
    "dotenv": re.compile(r"(^|/)\.env([.\w-]*)$"),
    "ssh-key": re.compile(r"(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$"),
    "credential-file": re.compile(r"(^|/)\.(netrc|pypirc|git-credentials)$"),
    "git-dir": re.compile(r"(^|/)\.git(/|$)"),
    "notes-dir": re.compile(r"(^|/)\.notes(/|$)"),
    "superpowers-dir": re.compile(r"(^|/)\.superpowers(/|$)"),
    "deploy-secrets": re.compile(r"(^|/)deploy/secrets(/|$)"),
    "cloud-or-kube-config": re.compile(r"(^|/)\.(aws|ssh|kube|docker)(/|$)|(^|/)kubeconfig$"),
    "password-file": re.compile(r"\.(pw|pass|password)$"),
    # A third-party package may ship its own .claude folder; ours must never be in an image.
    "claude-files": re.compile(r"^(?!.*node_modules/).*((^|/)\.claude(/|$)|(^|/)CLAUDE\.md$)"),
}
LISTED_NAMES = {
    "key-or-cert-file": re.compile(r"\.(pem|key|p12|pfx|jks|keystore)$"),
    "npmrc": re.compile(r"(^|/)\.npmrc$"),
    "claude-in-node_modules": re.compile(r"node_modules/.*(\.claude(/|$)|(^|/)CLAUDE\.md$)"),
}
CONTENT = {
    "github-token": re.compile(rb"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{50,}"),
    "aws-access-key": re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    "private-key-block": re.compile(rb"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n ]{80,}"),
    "google-api-key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    "groq-key": re.compile(rb"\bgsk_[A-Za-z0-9]{20,}\b"),
    "openai-style-key": re.compile(rb"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b"),
    "slack-token": re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    "bearer-string": re.compile(rb"[Bb]earer [A-Za-z0-9._~+/-]{40,}"),
}
SENSITIVE_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD)")


def local_secret_values():
    """(label, bytes) pairs. Labels are file base names or variable names, never values."""
    paths = glob.glob(os.path.join(REPO, "deploy/secrets/*")) + glob.glob(os.path.join(REPO, ".notes/demo/*"))
    paths += glob.glob(os.path.join(os.environ.get("S", ""), "demo.key"))
    found = []
    for path in paths:
        try:
            text = open(path, errors="ignore").read()
        except OSError:
            continue
        values = set(re.findall(r"[\"']?([A-Za-z0-9+/=_.-]{12,})[\"']?\s*$", text, re.M))
        values |= set(re.findall(r":\s*[\"']([^\"'\n]{12,})[\"']", text))
        if len(text.strip()) <= 200 and "\n" not in text.strip():
            values.add(text.strip())
        found += [(os.path.basename(path), v.encode()) for v in values]
    found += [("env:" + k, v.encode()) for k, v in os.environ.items() if SENSITIVE_ENV.search(k) and len(v) >= 12]
    seen, unique = set(), []
    for label, value in found:
        if value not in seen:
            seen.add(value)
            unique.append((label, value))
    return unique


def note(bucket, rule, where):
    entry = bucket.setdefault(rule, {"count": 0, "examples": []})
    entry["count"] += 1
    if len(entry["examples"]) < 5:
        entry["examples"].append(where)


def scan_image(image, secrets):
    result = {"files": 0, "layers": 0, "forbidden": {}, "listed": {}, "content": {}, "values": set(), "env": []}

    def scan_bytes(data, where):
        for rule, rx in CONTENT.items():
            if rx.search(data):
                note(result["content"], rule, where)
        for label, value in secrets:
            if value in data:
                result["values"].add((label, where))

    with tempfile.TemporaryDirectory() as tmp:
        tar_path = os.path.join(tmp, "image.tar")
        subprocess.run(["docker", "save", image, "-o", tar_path], check=True)
        with tarfile.open(tar_path) as outer:
            manifest = json.load(outer.extractfile("manifest.json"))[0]
            config_raw = outer.extractfile(manifest["Config"]).read()
            scan_bytes(config_raw, "image config")
            config = json.loads(config_raw)
            for item in config.get("history", []):
                scan_bytes(item.get("created_by", "").encode(), "history line")
            for env in config.get("config", {}).get("Env", []):
                name = env.split("=", 1)[0]
                if SENSITIVE_ENV.search(name):
                    result["env"].append(name)
            for layer in manifest["Layers"]:
                result["layers"] += 1
                with tarfile.open(fileobj=io.BytesIO(outer.extractfile(layer).read()), mode="r:*") as lt:
                    for member in lt:
                        result["files"] += 1
                        # Only a leading "./" goes: lstrip("./") would turn ".env" into "env" and miss it.
                        path = re.sub(r"^(\./)+", "", member.name).lstrip("/")
                        for rule, rx in FORBIDDEN_NAMES.items():
                            if rx.search(path):
                                note(result["forbidden"], rule, path)
                        for rule, rx in LISTED_NAMES.items():
                            if rx.search(path):
                                note(result["listed"], rule, path)
                        if member.isfile() and 0 < member.size <= MAX_FILE:
                            data = lt.extractfile(member)
                            if data is not None:
                                scan_bytes(data.read(), path)
    return result


def report(image, r):
    print(f"== {image}: {r['layers']} layers, {r['files']} files")
    for title, bucket in (("FORBIDDEN NAME", r["forbidden"]), ("CONTENT PATTERN (read it)", r["content"]), ("listed only", r["listed"])):
        for rule, entry in bucket.items():
            print(f"  {title} {rule}: {entry['count']}, e.g. {', '.join(entry['examples'][:3])}")
    for label, where in sorted(r["values"]):
        print(f"  SECRET VALUE FOUND: {label} appears in {where}")
    for name in r["env"]:
        print(f"  env name looks sensitive (value not checked here): {name}")


def main(images):
    secrets = local_secret_values()
    print(f"checking {len(secrets)} local secret values (never printed)")
    code = 0
    for image in images:
        r = scan_image(image, secrets)
        report(image, r)
        if r["values"] or r["forbidden"]:
            code = 1
        elif r["content"] and code == 0:
            code = 2
    print({0: "CLEAN", 1: "FAIL: a secret value or a forbidden file is in an image", 2: "REVIEW: a content pattern matched"}[code])
    return code


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1:]))
