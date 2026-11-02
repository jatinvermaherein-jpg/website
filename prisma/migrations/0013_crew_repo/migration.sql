-- A crew that cannot reach the repository is a chat room.
--
-- The project now names its source of truth. Seats work in git worktrees of
-- it; the only thing that makes work real is a push that lands there.
ALTER TABLE "Project" ADD COLUMN "repoUrl" TEXT;
ALTER TABLE "Project" ADD COLUMN "defaultBranch" TEXT NOT NULL DEFAULT 'main';

-- what a reviewer actually needs: the branch and the commit, so the diff is
-- read from the repo rather than trusted from a summary
ALTER TABLE "Task" ADD COLUMN "branch" TEXT;
ALTER TABLE "Task" ADD COLUMN "headCommit" TEXT;
