import { expect, test } from "bun:test"
import { resolveConfig, validateDispatchConfig } from "../config/resolve-config"
import type { Issue } from "../domain/types"
import { resolveIssueRuntimeConfig } from "../workflow/render-frontmatter"
import { type CommandRunner, ensureWorkspace } from "./workspace-manager"

const issue: Issue = {
  id: "1",
  identifier: "owner/repo#1",
  title: "task",
  description: null,
  priority: null,
  state: "Ready",
  repository: "owner/repo",
  fields: {},
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
}
function config() {
  return resolveConfig({
    tracker: { kind: "github_project", github_project: { owner: "owner", number: 1 } },
    work: { workspace: { provider: "git-wt", branch: "feature/test" } },
  })
}
function fixture(options: { existing?: boolean; missing?: boolean; failure?: boolean } = {}) {
  const calls: string[][] = []
  let exists = options.existing ?? false
  const runCommand: CommandRunner = async (command, args) => {
    calls.push([command, ...args])
    if (command === "ghq")
      return { exitCode: 0, stdout: options.missing ? "" : "/custom/ghq/owner/repo\n", stderr: "" }
    if (args[0] === "rev-parse")
      return { exitCode: 0, stdout: "/custom/ghq/owner/repo\n", stderr: "" }
    if (args.join(" ") === "wt --json")
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          exists ? [{ path: "/custom/worktrees/feature/test", branch: "feature/test" }] : [],
        ),
        stderr: "",
      }
    if (args.join(" ") === "wt --nocd -- feature/test") {
      exists = true
      return {
        exitCode: options.failure ? 1 : 0,
        stdout: "hook output\n/custom/worktrees/feature/test\n",
        stderr: options.failure ? "hook failed" : "",
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`)
  }
  return { calls, runCommand }
}
test("git-wt survives configuration validation and per-issue rendering", async () => {
  const c = config()
  expect(() => validateDispatchConfig(c)).not.toThrow()
  expect((await resolveIssueRuntimeConfig(issue, c.work, null)).workspace.provider).toBe("git-wt")
})
test("ghq resolves the repository and git-wt chooses the created worktree path", async () => {
  const f = fixture()
  const result = await ensureWorkspace(issue, config().work.workspace, f)
  expect(result.path).toBe("/custom/worktrees/feature/test")
  expect(result.createdNow).toBe(true)
  expect(f.calls[0]).toEqual(["ghq", "list", "-p", "-e", "owner/repo"])
  expect(f.calls).toContainEqual(["git", "wt", "--nocd", "--", "feature/test"])
})
test("existing worktree is reused by branch without invoking creation hooks", async () => {
  const f = fixture({ existing: true })
  expect((await ensureWorkspace(issue, config().work.workspace, f)).createdNow).toBe(false)
  expect(f.calls.some((c) => c.includes("--nocd"))).toBe(false)
})
test("reuse_existing=false refuses an existing worktree", async () => {
  const f = fixture({ existing: true })
  await expect(
    ensureWorkspace(issue, { ...config().work.workspace, reuseExisting: false }, f),
  ).rejects.toThrow("already exists")
})
test("create_if_missing=false does not create a worktree", async () => {
  const f = fixture()
  await expect(
    ensureWorkspace(issue, { ...config().work.workspace, createIfMissing: false }, f),
  ).rejects.toThrow("workspace not found")
  expect(f.calls.some((c) => c.includes("--nocd"))).toBe(false)
})
test("missing ghq repository fails without cloning", async () => {
  const f = fixture({ missing: true })
  await expect(ensureWorkspace(issue, config().work.workspace, f)).rejects.toThrow(
    "ghq repository not found",
  )
  expect(f.calls).toHaveLength(1)
})
test("absolute repository paths do not require ghq", async () => {
  const f = fixture()
  await ensureWorkspace(
    { ...issue, repository: "/custom/ghq/owner/repo" },
    config().work.workspace,
    f,
  )
  expect(f.calls.some((c) => c[0] === "ghq")).toBe(false)
})
test("git-wt hook failures are propagated", async () => {
  await expect(
    ensureWorkspace(issue, config().work.workspace, fixture({ failure: true })),
  ).rejects.toThrow("hook failed")
})

test("git-wt rejects Symphony path overrides instead of silently ignoring them", async () => {
  await expect(
    ensureWorkspace(issue, { ...config().work.workspace, baseDir: "/custom" }, fixture()),
  ).rejects.toThrow("wt.basedir")
})
