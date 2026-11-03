import os
import unittest
from unittest.mock import patch
import emergency_pr as e


def pr():
    return {
        "state": "open",
        "draft": False,
        "base": {"ref": "main"},
        "head": {"sha": "abc", "ref": "feature"},
        "labels": [{"name": "emergency"}],
    }


def event(actor=35923560, ident=1, kind="labeled"):
    return {
        "id": ident,
        "event": kind,
        "label": {"name": "emergency"},
        "actor": {
            "id": actor,
            "login": e.AUTHORIZED.get(actor, "Other"),
            "type": "User",
        },
    }


class Contract(unittest.TestCase):
    def test_both_people(self):
        for user in e.AUTHORIZED:
            self.assertEqual(
                e.label_authorization([[event(user)]])[1], e.AUTHORIZED[user]
            )

    def test_other_denied(self):
        with self.assertRaises(e.Refused):
            e.label_authorization([[event(123)]])

    def test_latest_event_wins_across_pages(self):
        with self.assertRaises(e.Refused):
            e.label_authorization([[event()], [event(123, 2)]])

    def test_removed_denied(self):
        with self.assertRaises(e.Refused):
            e.label_authorization([[event(), event(ident=2, kind="unlabeled")]])

    def test_missing_event_denied(self):
        with self.assertRaises(e.Refused):
            e.label_authorization([[]])

    def test_spoofed_login_denied(self):
        x = event()
        x["actor"]["login"] = "Other"
        with self.assertRaises(e.Refused):
            e.label_authorization([[x]])

    def test_bot_denied(self):
        x = event()
        x["actor"]["type"] = "Bot"
        with self.assertRaises(e.Refused):
            e.label_authorization([[x]])

    def test_head_target_label_and_draft_fences(self):
        for key, value in [
            ("draft", True),
            ("state", "closed"),
            ("labels", []),
            ("base", {"ref": "other"}),
            ("head", {"sha": "changed"}),
        ]:
            x = pr()
            x[key] = value
            with self.assertRaises(e.Refused):
                e.validate(x, "abc", "main")
        with self.assertRaises(e.Refused):
            e.validate(pr(), "abc", "preprod")

    def run_main(
        self,
        promotion=False,
        changed=False,
        removed=False,
        permission="write",
        relabeled=False,
    ):
        calls = []
        fetches = 0
        auths = 0

        def gh(args, merge=False):
            nonlocal fetches, auths
            calls.append((args, merge))
            if "/events?" in " ".join(args):
                auths += 1
                return [[event(ident=auths if relabeled else 1)]]
            if args[-1].endswith("/permission"):
                return {"permission": permission}
            if args[-1].endswith("/pulls/7"):
                fetches += 1
                x = pr()
                if promotion:
                    x["head"]["ref"] = "preprod"
                if changed and fetches > 1:
                    x["head"]["sha"] = "changed"
                if removed:
                    x["labels"] = []
                return x
            return {}

        with (
            patch.dict(
                os.environ,
                {
                    "GITHUB_REPOSITORY": "org/repo",
                    "PR_NUMBER": "7",
                    "GH_MERGE_TOKEN": "fake",
                },
            ),
            patch.object(e, "gh", side_effect=gh),
            patch.object(e.subprocess, "run") as run,
        ):
            e.main()
            return calls, run.call_args

    def test_merge_does_not_read_or_wait_for_checks(self):
        calls, merged = self.run_main()
        self.assertIn("--match-head-commit", merged.args[0])
        self.assertIn("--squash", merged.args[0])
        self.assertFalse(
            any(
                "/check-runs" in " ".join(c[0]) or c[0][:2] == ["pr", "checks"]
                for c in calls
            )
        )

    def test_promotions_preserve_history(self):
        self.assertIn("--merge", self.run_main(promotion=True)[1].args[0])

    def test_changed_head_denied(self):
        with self.assertRaises(e.Refused):
            self.run_main(changed=True)

    def test_relabel_denied(self):
        with self.assertRaises(e.Refused):
            self.run_main(relabeled=True)

    def test_permission_revoked_denied(self):
        with self.assertRaises(e.Refused):
            self.run_main(permission="read")

    def test_removal_no_merge(self):
        self.assertIsNone(self.run_main(removed=True)[1])

    def test_stale_unlabelled_events_have_separate_concurrency(self):
        from pathlib import Path

        p = (
            Path(__file__).resolve().parent.parent
            / "workflows"
            / "emergency-auto-approve.yml"
        )
        if not p.exists():
            p = Path(__file__).with_name("emergency-auto-approve.yml")
        s = p.read_text()
        self.assertIn("'active' || 'inactive'", s)
        self.assertIn("github.event.action == 'unlabeled'", s)


if __name__ == "__main__":
    unittest.main()
