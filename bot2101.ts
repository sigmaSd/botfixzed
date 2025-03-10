import {
  bumpVersion,
  correctRepoInfo,
  createWorkDir,
  fetchPrAndSetupBranch,
  fetchRepo,
  getExistingPR,
  getGitHubUsername,
  getReposWithIssueN,
  openPR,
  retry,
  switchDirTemp,
  updatePr,
} from "./utils.ts";

const ISSUE_NUMBER = 2101;
if (import.meta.main) {
  const repos = await getReposWithIssueN(ISSUE_NUMBER);

  const work_dir = createWorkDir();
  Deno.chdir(work_dir);

  // Get GitHub botUsername
  const botUsername = await getGitHubUsername();
  console.log(`Using GitHub botUsername: ${botUsername}`);

  for (let [index, repo] of repos.entries()) {
    console.log(`[${index}] Processing repo: ${JSON.stringify(repo)}`);
    if (repo.name === "aura-theme") {
      console.log("Skipping repo as it is too big to clone");
      continue;
    }
    await retry(async () => {
      // This is needed to handle repo renaming
      repo = await correctRepoInfo(repo);
      await fetchRepo(repo.repo);

      // This update logic is here because noticed after I sent PRs that there can be multiple theme files, though this is not common
      const existingPRBranchName = await getExistingPR(
        repo.user,
        repo.name,
        botUsername,
      );
      if (existingPRBranchName !== null) {
        // console.log(
        //   `Skipping repo ${repo.user}/${repo.name} as PR already exists`,
        // );
        //
        await fetchPrAndSetupBranch({
          repoName: repo.name,
          branchName: existingPRBranchName,
          botUsername,
        });
        const changed = patchScrollbarThumbBg(repo.name);
        if (changed) {
          await updatePr({
            repoUser: repo.user,
            repoName: repo.name,
            branchName: existingPRBranchName,
          });
        } else {
          console.log(
            `Skipping repo ${repo.user}/${repo.name} as there are no changes`,
          );
        }
        return;
      }

      const changed = patchScrollbarThumbBg(repo.name);
      if (changed) {
        bumpVersion(repo.name);
        await openPR({
          repoUser: repo.user,
          repoName: repo.name,
          botUsername,
          commitMsg:
            "rename scrollbar_thumb.background to scrollbar.thumb.background",
          prTitle:
            "Rename scrollbar_thumb.background to scrollbar.thumb.background",
          prBody:
            `See issue https://github.com/zed-industries/extensions/issues/2101
        This PR was autogenerated and have not been tested manually, please verify before merge.
        Bot script: https://github.com/sigmaSd/botfixzed/blob/master/bot2101.ts`,
        });
      } else {
        console.log(
          `Skipping repo ${repo.user}/${repo.name} as there are no changes`,
        );
      }
    });

    // Uncomment to process only the first repo
    // break;
  }
}

function patchScrollbarThumbBg(repo: string) {
  using _ = switchDirTemp(repo);

  let changes = false;

  for (const themePath of findThemes()) {
    let theme = Deno.readTextFileSync(themePath);
    if (!theme.includes("scrollbar_thumb.background")) {
      continue;
    }
    changes = true;
    theme = theme.replaceAll(
      "scrollbar_thumb.background",
      "scrollbar.thumb.background",
    );

    // console.log(theme);

    Deno.writeTextFileSync(themePath, theme);
  }

  if (changes) {
    return true;
  } else {
    return false;
  }
}

function* findThemes() {
  for (const entry of Deno.readDirSync("themes")) {
    if (entry.name.endsWith(".json")) {
      yield `themes/${entry.name}`;
    }
  }
}
