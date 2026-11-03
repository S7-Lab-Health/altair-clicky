# Emergency PR automation

JadSbai or KossaiSbai can apply `emergency` to a ready PR targeting `main` or `preprod`. The emergency App approves and attempts an exact-head merge without waiting for pre-merge checks or human/code-owner reviews. This applies to Webapp too. Normal deployment remains enabled: image builds, migrations and deployment health verification are not bypassed.

Authorization comes from the latest emergency-label event, using the requester's verified GitHub account ID and current repository write permission. Another user's label does not authorize a merge. Label removal stops the operation. A new commit or changed target must be revalidated. The handler runs only trusted base-branch code and never executes PR code.

GitHub rulesets must grant the emergency App pull-request bypass. Normal branches keep their existing requirements for other actors. Legacy branch protections can still block an App and must be represented by equivalent active rulesets before retirement. The workflow never disables protection itself or fabricates successful checks. CI may still execute independently, but its results do not block an authorized emergency merge.

Long-lived main/preprod promotions preserve ancestry with merge commits. Other PRs use squash merging. Source branches are never deleted by the handler. A conflicting PR cannot merge; emergencies do not resolve conflicts automatically.

Verification must distinguish App approval, an actual bot merge, and successful deployment. Record the head SHA, label requester, merge actor and deployment outcome. Local tests: `python3 -m unittest discover -s .github/scripts -p test_emergency_pr.py`.
