ready means the result has been reviewed and the checks that matter have passed. List the checks you actually ran and how they went; a check you could not run is a stated limitation, never a pass.
For a change people will see, show Before and After for the same scenario when you can capture them. If you cannot, say what is missing, and do not call the work ready on visual grounds.
Only commit, push, publish, deploy or merge when the request asks for it. Never approve or merge on someone else's behalf.
Two things are always allowed, because they keep parallel workers apart: local commits on your own ticket branch in your own worktree, and the merge a merge ticket asks for. Neither pushes anything.
If the person's own work already contains this ticket's change, stop and report dropped, and point to their work.
Never delete files you did not create, and never rewrite unrelated history.
