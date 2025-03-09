import assert from "node:assert";
import { existsSync } from "node:fs";
import {
  parse as parseToml,
  stringify as stringifyToml,
} from "jsr:@std/toml@1.0.2";
import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.49";
import {
  format as formatSemVer,
  increment as incrementSemVer,
  parse as parseSemVer,
} from "jsr:@std/semver@1.0.4";
import * as cases from "jsr:@luca/cases@1";

const issue2104 = await fetch(
  "https://github.com/zed-industries/extensions/issues/2104",
).then((response) => response.text()).then((text) =>
  new DOMParser().parseFromString(text, "text/html")
);

const links = issue2104
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
const tempDir = createWorkDir();
Deno.chdir(tempDir);

// Get GitHub username
const username = await getGitHubUsername();
console.log(`Using GitHub username: ${username}`);

for (const repo of repos) {
  console.log(`Processing repo: ${JSON.stringify(repo)}`);

  // This is neeed to handle repo renaming
  // Get the *current* repository name using gh repo view
  try {
    const repoInfo = await getCurrentRepoInfo(repo.user, repo.name);
    // Update the repo object with the CORRECTED name
    repo.user = repoInfo.owner;
    repo.name = repoInfo.name;
  } catch (error) {
    console.error(
      `Error getting current repo info for ${repo.user}/${repo.name}:`,
      error,
    );
    continue; // Skip to the next repository if we can't get info
  }

  // Check for existing PRs *before* cloning or doing any work
  const existingPR = await getExistingPR(repo.user, repo.name, username);

  await fetchRepo(repo.repo);

  if (existingPR) {
    console.log(
      `Found existing PR for ${repo.user}/${repo.name}: updating it...`,
    );
    // await updateExistingPRRemoveJsonConfig(repo, existingPR, username);
    await updateCleanup(repo, existingPR, username);
  } else if (existsSync(`${repo.name}/extension.toml`)) {
    console.log("Skipping existing extension.toml");
    continue;
  } else {
    portExtToToml(repo.name);
    await openPR(repo);
  }
  // Uncomment to process only the first repo
  // break;
}

async function fetchRepo(repo: string) {
  await run(["gh", "repo", "clone", repo]);
}

async function getCurrentRepoInfo(user: string, name: string) {
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

function portExtToToml(path: string) {
  const jsonConfig = JSON.parse(
    Deno.readTextFileSync(`${path}/extension.json`),
  );
  jsonConfig.id = cases.kebabCase(jsonConfig.name);
  jsonConfig.version = formatSemVer(
    incrementSemVer(parseSemVer(jsonConfig.version), "patch"),
  );
  jsonConfig.schema_version = 1;

  let tomlConfig = stringifyToml(jsonConfig);
  const maybeRepoConfig = findRepoConfig(path);
  if (maybeRepoConfig) {
    tomlConfig += `grammar = "${maybeRepoConfig.name}"`;
    tomlConfig += `
[grammars.${maybeRepoConfig.name}]
${maybeRepoConfig.content}`;
  }

  console.log(tomlConfig);
  Deno.writeTextFileSync(`${path}/extension.toml`, tomlConfig);
}

function findRepoConfig(path: string) {
  if (!existsSync(`${path}/grammars`)) return;
  for (const entry of Deno.readDirSync(`${path}/grammars`)) {
    if (entry.isFile && entry.name.endsWith(".toml")) {
      const content = Deno.readTextFileSync(`${path}/grammars/${entry.name}`);
      return { name: entry.name.replace(/\.toml$/, ""), content };
    }
  }
}

async function run(cmd: string[], options = {}) {
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

async function getGitHubUsername() {
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

async function openPR(
  { user, name }: { repo: string; user: string; name: string },
) {
  console.log(`Opening PR for ${name}`);

  // Create a branch name
  const branchName = `add-extension-toml-${Date.now()}`;

  // Change directory to the cloned repo
  Deno.chdir(`${tempDir}/${name}`);

  // Check if changes need to be made
  if (!existsSync("extension.toml")) {
    console.log("No extension.toml was created. Skipping PR creation.");
    return;
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

  // Add the new file
  await run(["git", "add", "extension.toml"]);

  // Commit the changes
  const commitResult = await run(["git", "commit", "-m", "Add extension.toml"]);
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
    "Add extension.toml",
    "--body",
    `This PR adds 'extension.toml' file, converting from the existing 'extension.json' configuration.
See https://github.com/zed-industries/extensions/issues/2104

This change was generated automatically and needs to be manually tested.
Bot script: https://github.com/sigmaSd/botfixzed/blob/master/bot2104.ts`,
    "--repo",
    `${user}/${name}`,
  ]);

  if (prResult.success) {
    const prUrl = prResult.stdout.trim().split("\n")[0];
    console.log(`Pull request created: ${prUrl}`);
  }

  // Return to the temp directory
  Deno.chdir(tempDir);
}

async function getExistingPR(
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

// https://github.com/zed-industries/extensions/issues/2104#issuecomment-2707475876
async function _updateExistingPRRemoveJsonConfig(
  { user, name }: { repo: string; user: string; name: string },
  branchName: string,
  username: string,
) {
  console.log(`Updating PR for ${name} to remove extension.json`);

  // Change directory to the cloned repo
  Deno.chdir(`${tempDir}/${name}`);

  // Check if extension.json exists
  if (!existsSync("extension.json")) {
    console.log("extension.json doesn't exist. No need to update PR.");
    Deno.chdir(tempDir);
    return;
  }

  // Add a remote for your fork
  await run([
    "git",
    "remote",
    "add",
    "fork",
    `https://github.com/${username}/${name}.git`,
  ]);

  // Fetch from the fork to get the branch
  await run(["git", "fetch", "fork"]);

  // Checkout the existing branch
  await run(["git", "checkout", `fork/${branchName}`]);
  await run(["git", "checkout", "-b", branchName]);

  // Remove extension.json
  await run(["git", "rm", "extension.json"]);

  // Commit the changes
  const commitResult = await run([
    "git",
    "commit",
    "-m",
    "Remove extension.json",
  ]);

  if (!commitResult.success) {
    console.log("Nothing to commit, skipping PR update");
    return;
  }

  // Push to the fork remote
  await run(["git", "push", "fork", branchName]);

  console.log(`Updated PR branch for ${user}/${name}`);

  // Return to temp directory
  Deno.chdir(tempDir);
}

async function updateCleanup(
  { user, name }: { repo: string; user: string; name: string },
  branchName: string,
  username: string,
) {
  console.log(`Updating PR for ${name} to update toml and remove grammar`);

  // Change directory to the cloned repo
  Deno.chdir(`${tempDir}/${name}`);

  // Add a remote for your fork
  await run([
    "git",
    "remote",
    "add",
    "fork",
    `https://github.com/${username}/${name}.git`,
  ]);

  // Fetch from the fork to get the branch
  await run(["git", "fetch", "fork"]);

  // Checkout the existing branch
  await run(["git", "checkout", `fork/${branchName}`]);
  await run(["git", "checkout", "-b", branchName]);

  // seems like earlier I created a corrupt toml by having
  // [grammars] alongside [grammars.matlab]
  // the issue we can't even parse it to fix it
  // the workaround is simple, string replacement
  let tomlFile = await Deno.readTextFile("extension.toml");
  tomlFile = tomlFile.replace("[grammars]", "[grammarsDELETE]");

  const tomlConfig = parseToml(tomlFile);
  // 1. remove grammar = type
  delete tomlConfig.grammar;
  // 2. remove [grammar]
  delete tomlConfig.grammarsDELETE;
  // 3. remove [languages]
  delete tomlConfig.languages;

  // 4. remove grammars folder
  {
    try {
      await Deno.remove("grammars", { recursive: true });
    } catch { /* ignore */ }
  }

  // Not all repos need this, lets just ignore the gitignore
  // 5. setup gitignore
  // {
  //   let gitIgnoreContent = "";
  //   try {
  //     gitIgnoreContent = await Deno.readTextFile(".gitignore");
  //   } catch { /* ignore */ }
  //   const gitignore = await Deno.open(".gitignore", {
  //     append: true,
  //     create: true,
  //   });
  //   if (!gitIgnoreContent.includes("grammars")) {
  //     await gitignore.write(new TextEncoder().encode("grammars\n"));
  //   }
  //   if (!gitIgnoreContent.includes("*.wasm")) {
  //     await gitignore.write(new TextEncoder().encode("*.wasm\n"));
  //   }
  // }

  await Deno.writeTextFile("extension.toml", stringifyToml(tomlConfig));
  console.log("new", Deno.readTextFileSync("extension.toml"));

  // Commit the changes
  await run(["git", "add", "."]);
  const commitResult = await run([
    "git",
    "commit",
    "-m",
    "cleanup",
  ]);

  if (!commitResult.success) {
    console.log("Nothing to commit, skipping PR update");
    Deno.chdir(tempDir);
    return;
  }

  // Push to the fork remote
  await run(["git", "push", "fork", branchName]);

  console.log(`Updated PR branch for ${user}/${name}`);

  // Return to temp directory
  Deno.chdir(tempDir);
}

function createWorkDir() {
  const path = "./work";
  try {
    Deno.removeSync(path, { recursive: true });
  } catch { /* ignore */ }
  Deno.mkdirSync(path);
  return path;
}
