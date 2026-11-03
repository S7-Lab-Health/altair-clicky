# Emergency PR automation

The existing emergency contract is approval plus an attempted admin merge after all required checks pass. It does **not** skip CI, migrations, security, deployments or health checks. Webapp retains approval-only behavior. Normal push/deployment workflows still execute after merging.

Use `emergency` only on a ready PR targeting `main` or `preprod`. The requesting actor needs repository write permission. Automation reads checks using the workflow token and approves/merges with the configured GitHub App. `GH_APP_ID` and `GH_APP_PRIVATE_KEY` must be available and the App must be installed with pull-request and contents write permissions. Its ability to merge remains subject to repository rulesets; this workflow does not disable those rulesets.

The handler runs from the trusted base commit, never from PR code. It checks the exact head, rechecks the label and target while waiting, and binds the merge to that head. New commits restart it; label removal cancels the old run. It waits up to 40 minutes. A missing expected check, API error, failed check, or denied merge is not treated as success.

`main`/`preprod` promotion PRs use a merge commit to preserve ancestry. Other PRs retain squash behavior. No source branch is deleted by this workflow.

Local qualification: `python3 -m unittest discover -s .github/scripts -p test_emergency_pr.py`. Live qualification still requires an actual labeled PR, approved app access, successful required checks and verification of the resulting post-merge run. Do not claim end-to-end success from local tests alone.
