import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveConfig } from "../config/resolve-config"
import type { Issue } from "../domain/types"
import { type CommandRunner, ensureWorkspace } from "./workspace-manager"

const available = Bun.which("ghq") !== null && Bun.which("git-wt") !== null

test.skipIf(!available)(
  "real ghq lookup and git-wt creation run configured hooks and reuse the result",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symphony-git-wt-"))
    const repo = path.join(root, "custom-root/github.com/example/project")
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    }
    const runCommand: CommandRunner = async (command, args, cwd) => {
      const child = Bun.spawn([command, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, exitCode }
    }
    const git = async (...args: string[]) => {
      const result = await runCommand("git", args, root)
      if (result.exitCode !== 0) throw new Error(result.stderr)
    }
    try {
      await git("config", "--global", "ghq.root", path.join(root, "custom-root"))
      await git("init", "--initial-branch=main", repo)
      await git("-C", repo, "config", "user.name", "Test")
      await git("-C", repo, "config", "user.email", "test@example.invalid")
      await git("-C", repo, "commit", "--allow-empty", "-m", "initial")
      await git("-C", repo, "config", "wt.basedir", ".git/worktree")
      await git("-C", repo, "config", "wt.hook", "printf hook-ran > hook-marker")
      await writeFile(path.join(repo, "local-config.txt"), "local settings")
      await git("-C", repo, "config", "wt.copy", "local-config.txt")
      const issue: Issue = {
        id: "1",
        identifier: "example/project#1",
        title: "test",
        description: null,
        priority: null,
        state: "Ready",
        repository: "example/project",
        fields: {},
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      }
      const config = resolveConfig({
        tracker: { kind: "file", file: { base_dir: root } },
        work: { workspace: { provider: "git-wt", branch: "feature/one" } },
      }).work.workspace
      const created = await ensureWorkspace(issue, config, { runCommand })
      expect(created.repositoryRoot).toBe(repo)
      expect(created.path).toBe(path.join(repo, ".git/worktree/feature/one"))
      expect(created.createdNow).toBe(true)
      expect(await readFile(path.join(created.path, "hook-marker"), "utf8")).toBe("hook-ran")
      expect(await readFile(path.join(created.path, "local-config.txt"), "utf8")).toBe(
        "local settings",
      )
      await writeFile(path.join(created.path, "hook-marker"), "preserve")
      const reused = await ensureWorkspace(issue, config, { runCommand })
      expect(reused.createdNow).toBe(false)
      expect(reused.path).toBe(created.path)
      expect(await readFile(path.join(created.path, "hook-marker"), "utf8")).toBe("preserve")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
