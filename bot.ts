import assert from "node:assert";
import { existsSync } from "node:fs";
import { stringify as stringifyToml } from "jsr:@std/toml@1.0.2";
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

const tempDir = Deno.makeTempDirSync();
console.log("Patching repos in:", tempDir);
Deno.chdir(tempDir);

// Get GitHub username
const username = await getGitHubUsername();
console.log(`Using GitHub username: ${username}`);

for (const repo of repos) {
  console.log(`Processing repo: ${JSON.stringify(repo)}`);
  await fetchRepo(repo.repo);
  if (existsSync(`${repo.name}/extension.toml`)) {
    console.log("Skipping existing extension.toml");
    continue;
  }
  portExtToToml(repo.name);
  await openPR(repo);
  // Uncomment to process only the first repo
  break;
}

async function fetchRepo(repo: string) {
  await run(["gh", "repo", "clone", repo]);
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
  await run([
    "gh",
    "pr",
    "create",
    "--title",
    "Add extension.toml",
    "--body",
    `This PR adds 'extension.toml' file, converting from the existing 'extension.json' configuration.
See https://github.com/zed-industries/extensions/issues/2104

This change was generated automatically and needs to be manually tested.
Bot script: https://github.com/sigmaSd/botfixzed/blob/master/bot.ts`,
    "--repo",
    `${user}/${name}`,
  ]);

  // Return to the temp directory
  Deno.chdir(tempDir);
}
