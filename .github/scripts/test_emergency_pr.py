import copy
import unittest
from unittest.mock import patch
import emergency_pr as p

PR = {
    "state": "open",
    "draft": False,
    "base": {"ref": "main"},
    "head": {"sha": "abc", "ref": "fix"},
    "labels": [{"name": "emergency"}],
}


class EmergencyTests(unittest.TestCase):
    def test_valid_targets(self):
        for target in ("main", "preprod"):
            pr = copy.deepcopy(PR)
            pr["base"]["ref"] = target
            self.assertEqual(p.validate(pr), "abc")

    def test_refuses_unapproved_states(self):
        for key, value in [("state", "closed"), ("draft", True), ("labels", [])]:
            pr = copy.deepcopy(PR)
            pr[key] = value
            with self.assertRaises(p.Refused):
                p.validate(pr)

    def test_refuses_other_target(self):
        pr = copy.deepcopy(PR)
        pr["base"]["ref"] = "feature"
        with self.assertRaises(p.Refused):
            p.validate(pr)

    def test_refuses_changed_commit(self):
        with self.assertRaises(p.Refused):
            p.validate(PR, "old")

    def test_missing_required_check_waits(self):
        self.assertFalse(p.ready([], {"CI"}))

    def test_no_required_checks(self):
        self.assertTrue(p.ready([], set()))

    def test_pending_check_waits(self):
        self.assertFalse(p.ready([{"name": "CI", "bucket": "pending"}], {"CI"}))

    def test_failed_checks_cannot_merge(self):
        for bucket in ("fail", "cancel"):
            with self.assertRaises(p.Refused):
                p.ready([{"name": "CI", "bucket": bucket}], {"CI"})

    def test_successful_and_skipped_checks(self):
        for bucket in ("pass", "skipping"):
            self.assertTrue(p.ready([{"name": "CI", "bucket": bucket}], {"CI"}))

    def test_legacy_and_ruleset_requirements_are_combined(self):
        with patch.object(
            p,
            "gh",
            side_effect=[
                [
                    {
                        "type": "required_status_checks",
                        "parameters": {
                            "required_status_checks": [{"context": "security"}]
                        },
                    }
                ],
                {
                    "data": {
                        "repository": {
                            "ref": {
                                "branchProtectionRule": {
                                    "requiredStatusCheckContexts": ["CI"]
                                }
                            }
                        }
                    }
                },
            ],
        ):
            self.assertEqual(
                p.required_contexts("org/repo", "preprod"), {"security", "CI"}
            )

    def test_permission_errors_do_not_mean_no_checks(self):
        with patch.object(p, "gh", side_effect=p.Refused("API denied")):
            with self.assertRaises(p.Refused):
                p.required_contexts("org/repo", "main")

    def test_workflow_uses_trusted_base(self):
        from pathlib import Path

        workflow = Path(__file__).with_name("emergency-auto-approve.yml")
        if not workflow.exists():
            workflow = (
                Path(__file__).resolve().parents[1]
                / "workflows/emergency-auto-approve.yml"
            )
        text = workflow.read_text()
        self.assertIn("ref: ${{ github.event.pull_request.base.sha }}", text)
        self.assertIn("persist-credentials: false", text)
        self.assertNotIn("pull_request.head.sha", text)
        self.assertIn("unlabeled, synchronize, reopened, ready_for_review", text)


class ExecutionTests(unittest.TestCase):
    def execute(self, snapshots, mode="merge", permission="write"):
        from contextlib import ExitStack

        with ExitStack() as stack:
            stack.enter_context(
                patch.dict(
                    p.os.environ,
                    {
                        "GITHUB_REPOSITORY": "org/repo",
                        "PR_NUMBER": "1",
                        "REQUEST_ACTOR": "maintainer",
                        "GH_MERGE_TOKEN": "fake",
                        "EMERGENCY_MODE": mode,
                    },
                )
            )
            stack.enter_context(
                patch.object(p, "required_contexts", return_value={"CI"})
            )
            stack.enter_context(
                patch.object(
                    p, "checks", return_value=[{"name": "CI", "bucket": "pass"}]
                )
            )

            def api(args, **kwargs):
                if "collaborators" in args[1]:
                    return {"permission": permission}
                if "--method" in args:
                    return {}
                return snapshots.pop(0)

            stack.enter_context(patch.object(p, "gh", side_effect=api))
            run = stack.enter_context(patch.object(p.subprocess, "run"))
            p.main()
            return run

    def test_merge_pins_checked_head_and_preserves_branch(self):
        run = self.execute([copy.deepcopy(PR) for _ in range(3)])
        args = run.call_args.args[0]
        self.assertIn("--match-head-commit", args)
        self.assertIn("abc", args)
        self.assertNotIn("--delete-branch", args)

    def test_promotion_preserves_ancestry(self):
        pr = copy.deepcopy(PR)
        pr["head"]["ref"] = "preprod"
        run = self.execute([copy.deepcopy(pr) for _ in range(3)])
        self.assertIn("--merge", run.call_args.args[0])

    def test_approve_only_never_merges(self):
        self.assertFalse(self.execute([copy.deepcopy(PR)], mode="approve").called)

    def test_label_removal_refuses_merge(self):
        changed = copy.deepcopy(PR)
        changed["labels"] = []
        with self.assertRaises(p.Refused):
            self.execute([copy.deepcopy(PR), changed])

    def test_untrusted_actor_refused(self):
        with self.assertRaises(p.Refused):
            self.execute([], permission="read")


if __name__ == "__main__":
    unittest.main()
