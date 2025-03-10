import assert from "node:assert";
import { parse as parseToml } from "jsr:@std/toml@1.0.2";
import {
  format as formatSemVer,
  increment as incrementSemVer,
  parse as parseSemVer,
} from "jsr:@std/semver@1.0.4";
import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.49";
import { existsSync } from "node:fs";

export async function getReposWithIssueN(issueN: number) {
  const issue = await fetch(
    `https://github.com/zed-industries/extensions/issues/${issueN}`,
  ).then((response) => response.text()).then((text) =>
    new DOMParser().parseFromString(text, "text/html")
  );

  const links = issue
    .querySelector(".contains-task-list")
    ?.querySelectorAll("a");
  assert(links);

  const repos = [...links]
    .map((element) => element.getAttribute("href"))
    .filter((href) => !href?.includes("issues"))
    .map((repo) => {
      assert(repo);
      const [user, name] = repo.split("/").slice(-2);
      return { repo, user, name };
    });

  return repos;
}

export async function fetchRepo(repo: string) {
  await run(["gh", "repo", "clone", repo]);
}

export async function getCurrentRepoInfo(user: string, name: string) {
  const { stdout, success } = await run([
    "gh",
    "repo",
    "view",
    `${user}/${name}`,
    "--json",
    "name,owner",
  ]);

  if (!success) {
    throw new Error(`Failed to get repo info for ${user}/${name}`);
  }

  const repoData = JSON.parse(stdout);
  return { owner: repoData.owner.login, name: repoData.name };
}

export async function run(cmd: string[], options = {}) {
  console.log(`Running: ${cmd.join(" ")}`);
  const process = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    ...options,
  });
  const { stdout, stderr, success } = await process.output();

  if (!success) {
    console.error("Command failed:");
    console.error(new TextDecoder().decode(stderr));
  }

  return {
    success,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

export async function getGitHubUsername() {
  // Get current user from gh cli
  const { stdout, success } = await run([
    "gh",
    "api",
    "user",
    "--jq",
    ".login",
  ]);

  if (!success) {
    throw new Error("Failed to get GitHub username");
  }

  return stdout.trim();
}

export function bumpVersion(name: string) {
  const tomlConfigPath = `${name}/extension.toml`;
  const jsonConfigPath = `${name}/extension.json`;
  if (existsSync(tomlConfigPath)) {
    let tomlFile = Deno.readTextFileSync(tomlConfigPath);
    const tomlConfig = parseToml(tomlFile);
    const newVersion = formatSemVer(incrementSemVer(
      parseSemVer(tomlConfig.version as string),
      "patch",
    ));
    tomlFile = tomlFile.replace(
      /version = "[^"]+"/,
      `version = "${newVersion}"`,
    );
    Deno.writeTextFileSync(tomlConfigPath, tomlFile);
    return;
  }
  if (existsSync(jsonConfigPath)) {
    let jsonFile = Deno.readTextFileSync(jsonConfigPath);
    const jsonConfig = JSON.parse(jsonFile);
    const newVersion = formatSemVer(incrementSemVer(
      parseSemVer(jsonConfig.version),
      "patch",
    ));
    jsonFile = jsonFile.replace(
      /"version": "[^"]+"/,
      `"version": "${newVersion}"`,
    );
    Deno.writeTextFileSync(jsonConfigPath, jsonFile);
    return;
  }
}

export async function retry(fn: () => Promise<void>) {
  while (true) {
    try {
      await fn();
      return;
    } catch (e) {
      console.log("error", e);
      if (!confirm("Do you want to retry ? ")) {
        return;
      }
    }
  }
}

export async function correctRepoInfo(
  repo: { repo: string; user: string; name: string },
) {
  // Get the *current* repository name using gh repo view
  const repoInfo = await getCurrentRepoInfo(
    repo.user,
    repo.name.replace(/\.git$/, ""), /* github strips .git */
  );
  return {
    repo: repo.repo,
    user: repoInfo.owner,
    // Update the repo object with the CORRECTED name
    name: repoInfo.name,
  };
}

export async function getExistingPR(
  user: string,
  repo: string,
  username: string,
): Promise<string | null> {
  const { stdout, success } = await run([
    "gh",
    "pr",
    "list",
    "--repo",
    `${user}/${repo}`,
    "--author",
    username,
    "--json",
    "number,headRefName",
  ]);

  if (!success) {
    console.error(`Failed to check for open PRs for ${user}/${repo}`);
    return null;
  }

  const prs = JSON.parse(stdout);
  if (prs.length === 0) return null;

  // Return the branch name for the existing PR
  return prs[0].headRefName;
}

export function createWorkDir() {
  const path = `${Deno.cwd()}/work`;
  try {
    Deno.removeSync(path, { recursive: true });
  } catch { /* ignore */ }
  Deno.mkdirSync(path);
  return path;
}

export function switchDirTemp(dir: string) {
  const originalDir = Deno.cwd();
  Deno.chdir(dir);
  return {
    [Symbol.dispose]() {
      Deno.chdir(originalDir);
    },
  };
}

export async function openPR(
  {
    repoUser: user,
    repoName: name,
    botUsername: username,
    commitMsg,
    prTitle,
    prBody,
  }: {
    repoUser: string;
    repoName: string;
    botUsername: string;
    commitMsg: string;
    prTitle: string;
    prBody: string;
  },
) {
  console.log(`Opening PR for ${name}`);

  // Create a branch name
  const branchName = `update-attr-${Date.now()}`;

  // Change directory to the cloned repo
  using _ = switchDirTemp(name);

  // git diff
  {
    const { stdout, stderr } = await run(["git", "diff"]);
    console.log(stdout, stderr);
  }

  // Fork the repository *before* any git operations
  await run(["gh", "repo", "fork", `${user}/${name}`, "--remote=false"]); // --remote=false is important here!

  // Add a remote for *your* fork
  await run([
    "git",
    "remote",
    "add",
    "fork",
    `https://github.com/${username}/${name}.git`,
  ]);

  // Create a new branch
  await run(["git", "checkout", "-b", branchName]);

  // Add the changed files
  await run(["git", "add", "."]);

  // Commit the changes
  const commitResult = await run([
    "git",
    "commit",
    "-m",
    commitMsg,
  ]);
  if (!commitResult.success) {
    console.log("Nothing to commit, skipping PR creation");
    return;
  }

  // Push to the *fork* remote
  await run(["git", "push", "-u", "fork", branchName]);

  // Create a PR using gh cli
  const prResult = await run([
    "gh",
    "pr",
    "create",
    "--title",
    prTitle,
    "--body",
    prBody,
    "--repo",
    `${user}/${name}`,
  ]);

  if (prResult.success) {
    const prUrl = prResult.stdout.trim().split("\n")[0];
    console.log(`Pull request created: ${prUrl}`);
  }
}

export async function fetchPrAndSetupBranch(
  { repoName: name, branchName, botUsername }: {
    repoName: string;
    branchName: string;
    botUsername: string;
  },
) {
  console.log(`Updating PR for ${name}`);

  using _ = switchDirTemp(name);

  // Add a remote for *your* fork
  await run([
    "git",
    "remote",
    "add",
    "fork",
    `https://github.com/${botUsername}/${name}.git`,
  ]);

  // Fetch from the fork to get the branch
  await run(["git", "fetch", "fork"]);

  // Checkout the existing branch
  await run(["git", "checkout", `fork/${branchName}`]);
}

export async function updatePr(
  { repoUser, repoName, branchName }: {
    repoUser: string;
    repoName: string;
    branchName: string;
  },
) {
  using _ = switchDirTemp(repoName);

  // git diff
  {
    const { stdout, stderr } = await run(["git", "diff"]);
    console.log(stdout, stderr);
  }

  // Add the changed files
  await run(["git", "add", "."]);

  // Commit the changes
  const commitResult = await run([
    "git",
    "commit",
    "-m",
    "rename scrollbar_thumb.background to scrollbar.thumb.background",
  ]);
  if (!commitResult.success) {
    console.log("Nothing to commit, skipping PR creation");
    return;
  }

  // Push to the *fork* remote
  await run(["git", "push", "-u", "fork", branchName]);

  console.log(`Updated PR branch for ${repoUser}/${repoName}`);
}
