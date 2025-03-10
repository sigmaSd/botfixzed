import { existsSync } from "node:fs";
import {
  parse as parseToml,
  stringify as stringifyToml,
} from "jsr:@std/toml@1.0.2";
import {
  format as formatSemVer,
  increment as incrementSemVer,
  parse as parseSemVer,
} from "jsr:@std/semver@1.0.4";
import * as cases from "jsr:@luca/cases@1";
import {
  correctRepoInfo,
  createWorkDir,
  fetchPrAndSetupBranch,
  fetchRepo,
  getExistingPR,
  getGitHubUsername,
  getReposWithIssueN,
  openPR,
  switchDirTemp,
  updatePr,
} from "./utils.ts";

const ISSUE_NUMBER = 2104;
if (import.meta.main) {
  const repos = await getReposWithIssueN(ISSUE_NUMBER);
  const tempDir = createWorkDir();
  Deno.chdir(tempDir);

  // Get GitHub username
  const botUsername = await getGitHubUsername();
  console.log(`Using GitHub username: ${botUsername}`);

  for (let [index, repo] of repos.entries()) {
    console.log(`[${index}] Processing repo: ${JSON.stringify(repo)}`);

    // This is neeed to handle repo renaming
    // Get the *current* repository name using gh repo view
    repo = await correctRepoInfo(repo);

    // Check for existing PRs *before* cloning or doing any work
    const existingPRBranchName = await getExistingPR(
      repo.user,
      repo.name,
      botUsername,
    );

    await fetchRepo(repo.repo);

    if (existingPRBranchName) {
      console.log(
        `Found existing PR for ${repo.user}/${repo.name}: updating it...`,
      );
      await fetchPrAndSetupBranch(
        {
          repoName: repo.name,
          branchName: existingPRBranchName,
          botUsername,
        },
      );

      let changes = false;
      {
        using _ = switchDirTemp(repo.name);
        if (_updateExistingPRRemoveJsonConfig()) changes = true;
        if (await updateCleanup()) changes = true;
      }

      if (changes) {
        await updatePr({
          repoUser: repo.user,
          repoName: repo.name,
          branchName: existingPRBranchName,
          commitMsg: "remvoe extension.json and cleanup",
        });
      }
    } else {
      let changed = false;
      {
        using _ = switchDirTemp(repo.name);
        changed = portExtToToml();
      }
      if (changed) {
        await openPR({
          repoUser: repo.user,
          repoName: repo.name,
          botUsername,
          commitMsg: "add extension.toml",
          prTitle: "Add extension.toml",
          prBody:
            `This PR adds 'extension.toml' file, converting from the existing 'extension.json' configuration.
           See https://github.com/zed-industries/extensions/issues/2104

           This change was generated automatically and needs to be manually tested.
           Bot script: https://github.com/sigmaSd/botfixzed/blob/master/bot2104.ts`,
        });
      }
    }
    // Uncomment to process only the first repo
    // break;
  }
}

function portExtToToml() {
  if (existsSync("extension.toml")) {
    console.log("Skipping existing extension.toml");
    return false;
  }
  const jsonConfig = JSON.parse(
    Deno.readTextFileSync("extension.json"),
  );
  jsonConfig.id = cases.kebabCase(jsonConfig.name);
  jsonConfig.version = formatSemVer(
    incrementSemVer(parseSemVer(jsonConfig.version), "patch"),
  );
  jsonConfig.schema_version = 1;

  let tomlConfig = stringifyToml(jsonConfig);
  const maybeRepoConfig = findRepoConfig(Deno.cwd());
  if (maybeRepoConfig) {
    tomlConfig += `grammar = "${maybeRepoConfig.name}"`;
    tomlConfig += `
[grammars.${maybeRepoConfig.name}]
${maybeRepoConfig.content}`;
  }

  // console.log(tomlConfig);
  Deno.writeTextFileSync("extension.toml", tomlConfig);

  return true;
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

// https://github.com/zed-industries/extensions/issues/2104#issuecomment-2707475876
function _updateExistingPRRemoveJsonConfig() {
  console.log("Updating PR to remove extension.json");

  // Check if extension.json exists
  if (!existsSync("extension.json")) {
    console.log("extension.json doesn't exist. No need to update PR.");
    return false;
  }

  Deno.removeSync("extension.json");
  return true;
}

async function updateCleanup() {
  if (!existsSync("extension.toml")) {
    return false;
  }
  // seems like earlier I created a corrupt toml by having
  // [grammars] alongside [grammars.matlab]
  // the issue we can't even parse it to fix it
  // the workaround is simple, string replacement
  const tomlFileOld = await Deno.readTextFile("extension.toml");
  const tomlConfig = parseToml(
    tomlFileOld.replace("[grammars]", "[grammarsDELETE]"),
  );

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

  const tomlFileNew = stringifyToml(tomlConfig);
  await Deno.writeTextFile("extension.toml", tomlFileNew);
  // console.log("new", Deno.readTextFileSync("extension.toml"));
  return tomlFileNew !== tomlFileOld;
}
