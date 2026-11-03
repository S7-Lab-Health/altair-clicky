"""Trusted-base emergency merging authorized by Jad or Kossai."""

import json
import os
import subprocess

AUTHORIZED = {78962232: "JadSbai", 35923560: "KossaiSbai"}


class Refused(RuntimeError):
    pass


def gh(args, *, merge=False):
    env = dict(
        os.environ, GH_TOKEN=os.environ["GH_MERGE_TOKEN" if merge else "GH_READ_TOKEN"]
    )
    result = subprocess.run(["gh", *args], env=env, capture_output=True, text=True)
    if result.returncode:
        raise Refused("GitHub command failed: " + result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else None


def validate(pr, head=None, branch=None):
    if pr["state"] != "open" or pr["draft"]:
        raise Refused("PR must be open and ready for review")
    if pr["base"]["ref"] not in ("main", "preprod"):
        raise Refused("Only main and preprod targets are supported")
    if not any(x["name"] == "emergency" for x in pr["labels"]):
        raise Refused("Emergency label is absent")
    if head and pr["head"]["sha"] != head:
        raise Refused("PR head changed; rerun for the new commit")
    if branch and pr["base"]["ref"] != branch:
        raise Refused("PR target changed")
    return pr["head"]["sha"]


def label_authorization(pages):
    events = [
        e
        for page in pages
        for e in page
        if e.get("event") in ("labeled", "unlabeled")
        and e.get("label", {}).get("name") == "emergency"
    ]
    if not events:
        raise Refused("No auditable emergency label event")
    event = max(events, key=lambda e: e["id"])
    actor = event.get("actor") or {}
    if event["event"] != "labeled" or actor.get("id") not in AUTHORIZED:
        raise Refused("The current emergency label must be applied by Jad or Kossai")
    if (
        actor.get("type") != "User"
        or actor.get("login", "").lower() != AUTHORIZED[actor["id"]].lower()
    ):
        raise Refused("Emergency requester identity does not match")
    return event["id"], actor["login"]


def main():
    repo, number = os.environ["GITHUB_REPOSITORY"], os.environ["PR_NUMBER"]

    def fetch():
        return gh(["api", f"repos/{repo}/pulls/{number}"])

    def authorize():
        event_id, actor = label_authorization(
            gh(
                [
                    "api",
                    "--paginate",
                    "--slurp",
                    f"repos/{repo}/issues/{number}/events?per_page=100",
                ]
            )
        )
        permission = gh(["api", f"repos/{repo}/collaborators/{actor}/permission"])[
            "permission"
        ]
        if permission not in ("admin", "maintain", "write"):
            raise Refused("Emergency requester must retain repository write permission")
        return event_id, actor

    pr = fetch()
    # Removal events cancel earlier runs, then exit without obtaining approval.
    if not any(x["name"] == "emergency" for x in pr["labels"]):
        print("Emergency label removed; no merge attempted")
        return
    head = validate(pr)
    branch = pr["base"]["ref"]
    authorization = authorize()
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
            f"body=Emergency requested by {authorization[1]}; pre-merge checks and reviews are bypassed. Normal deployment remains enabled.",
        ],
        merge=True,
    )
    pr = fetch()
    validate(pr, head, branch)
    if authorize() != authorization:
        raise Refused("Emergency authorization changed; rerun required")
    # No status-check waiting. GitHub enforces the App's configured PR-only bypass.
    # Preserve release-branch ancestry, and never delete the source branch.
    method = "--merge" if pr["head"]["ref"] in ("main", "preprod") else "--squash"
    env = dict(os.environ, GH_TOKEN=os.environ["GH_MERGE_TOKEN"])
    subprocess.run(
        [
            "gh",
            "pr",
            "merge",
            number,
            "--repo",
            repo,
            "--admin",
            "--match-head-commit",
            head,
            method,
        ],
        env=env,
        check=True,
    )


if __name__ == "__main__":
    main()
