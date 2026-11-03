"""Trusted-base emergency automation. Never runs code from the pull request."""

import json
import os
import subprocess
import time


class Refused(RuntimeError):
    pass


def gh(args, *, merge=False, optional=False):
    env = dict(
        os.environ, GH_TOKEN=os.environ["GH_MERGE_TOKEN" if merge else "GH_READ_TOKEN"]
    )
    result = subprocess.run(["gh", *args], env=env, capture_output=True, text=True)
    if result.returncode:
        if optional and "HTTP 404" in result.stderr:
            return None
        raise Refused("GitHub command failed: " + result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else None


def validate(pr, head=None):
    if pr["state"] != "open" or pr["draft"]:
        raise Refused("PR must be open and ready for review")
    if pr["base"]["ref"] not in ("main", "preprod"):
        raise Refused("Only main and preprod targets are supported")
    if not any(label["name"] == "emergency" for label in pr["labels"]):
        raise Refused("Emergency label was removed")
    if head and pr["head"]["sha"] != head:
        raise Refused("PR head changed; a fresh run must check the new commit")
    return pr["head"]["sha"]


def required_contexts(repo, branch):
    # Check both modern rulesets and legacy protection. API permission errors
    # are not interpreted as absence of branch protection.
    rules = gh(["api", f"repos/{repo}/rules/branches/{branch}"])
    # The branch read exposes legacy required status contexts with contents:read.
    # Reading BranchProtectionRule through GraphQL instead requires privileges
    # unavailable to GITHUB_TOKEN on legacy-protected repositories.
    result = gh(["api", f"repos/{repo}/branches/{branch}"])
    if "protection" not in result:
        raise Refused("Branch response omitted protection metadata")
    protection = result["protection"] or {}
    contexts = set()
    for rule in rules:
        if rule["type"] == "required_status_checks":
            contexts.update(
                c["context"] for c in rule["parameters"]["required_status_checks"]
            )
    required = protection.get("required_status_checks") or {}
    contexts.update(required.get("contexts", []))
    contexts.update(check["context"] for check in required.get("checks", []))
    return contexts


def ready(checks, required):
    names = {c["name"] for c in checks}
    if not required.issubset(names):
        return False  # A not-yet-registered check is not a successful check.
    if any(c["bucket"] in ("fail", "cancel") for c in checks):
        raise Refused(
            "A required check failed or was cancelled; emergency does not bypass CI"
        )
    return all(c["bucket"] in ("pass", "skipping") for c in checks)


def checks(repo, number):
    env = dict(os.environ, GH_TOKEN=os.environ["GH_READ_TOKEN"])
    result = subprocess.run(
        [
            "gh",
            "pr",
            "checks",
            number,
            "--repo",
            repo,
            "--required",
            "--json",
            "name,bucket",
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    try:
        values = json.loads(result.stdout)
    except json.JSONDecodeError:
        if (
            result.returncode == 1
            and "no required checks reported" in (result.stdout + result.stderr).lower()
        ):
            return []
        raise Refused(
            "Could not read required checks; refusing to infer success"
        ) from None
    if result.returncode not in (0, 1, 8) or not isinstance(values, list):
        raise Refused("Required-check lookup failed")
    return values


def main():
    repo, number = os.environ["GITHUB_REPOSITORY"], os.environ["PR_NUMBER"]
    actor = os.environ["REQUEST_ACTOR"]
    permission = gh(["api", f"repos/{repo}/collaborators/{actor}/permission"])[
        "permission"
    ]
    if permission not in ("admin", "maintain", "write"):
        raise Refused("Emergency requests require repository write permission")

    def fetch():
        return gh(["api", f"repos/{repo}/pulls/{number}"])

    pr = fetch()
    head = validate(pr)
    branch = pr["base"]["ref"]
    # App reviews must name the exact commit being checked.
    gh(
        [
            "api",
            "--method",
            "POST",
            f"repos/{repo}/pulls/{number}/reviews",
            "-f",
            "event=APPROVE",
            "-f",
            f"commit_id={head}",
            "-f",
            "body=Emergency review automation; required CI remains mandatory.",
        ],
        merge=True,
    )
    if os.environ.get("EMERGENCY_MODE") == "approve":
        print(
            "Approved exact head; this repository intentionally leaves merging to its maintainer."
        )
        return
    deadline = time.monotonic() + 2400
    while True:
        pr = fetch()
        validate(pr, head)
        if pr["base"]["ref"] != branch:
            raise Refused("PR target branch changed")
        required = required_contexts(repo, branch)
        if ready(checks(repo, number), required):
            break
        if time.monotonic() >= deadline:
            raise Refused("Required checks did not complete within 40 minutes")
        time.sleep(20)
    pr = fetch()
    validate(pr, head)
    if pr["base"]["ref"] != branch:
        raise Refused("PR target branch changed")
    promotion = pr["head"]["ref"] in ("main", "preprod")
    # Preserve long-lived branches and their ancestry. Do not delete any source
    # branch here; cleanup is independent of a successful emergency release.
    args = [
        "pr",
        "merge",
        number,
        "--repo",
        repo,
        "--admin",
        "--match-head-commit",
        head,
        "--merge" if promotion else "--squash",
    ]
    env = dict(os.environ, GH_TOKEN=os.environ["GH_MERGE_TOKEN"])
    subprocess.run(["gh", *args], env=env, check=True)


if __name__ == "__main__":
    main()
