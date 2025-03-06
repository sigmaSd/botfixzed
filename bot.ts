import assert from "node:assert";
import { stringify as stringifyToml } from "jsr:@std/toml@1.0.2";
import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.49";
import { existsSync } from "node:fs";

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
for (const repo of repos) {
  console.log(`Processing repo: ${JSON.stringify(repo)}`);
  await fetchRepo(repo.repo);
  portExtToToml(repo.name);
  openPR(repo);
  // break;
  // openPR({repo,path})
}

async function fetchRepo(repo: string) {
  await run(["git", "clone", repo]);
}

function portExtToToml(path: string) {
  if (existsSync(`${path}/extension.toml`)) {
    console.log("Skipping existing extension.toml");
    return;
  }
  const jsonConfig = JSON.parse(
    Deno.readTextFileSync(`${path}/extension.json`),
  );
  let tomlConfig = stringifyToml(jsonConfig);
  const maybeRepo = findRepoConfig(path);
  if (maybeRepo) {
    tomlConfig += `
[grammars.${maybeRepo.name}]
${maybeRepo.content}`;
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

async function run(cmd: string[]) {
  const process = new Deno.Command(cmd[0], { args: cmd.slice(1) });
  const status = await process.spawn().status;
  return status;
}

function openPR(
  { repo, user, name }: { repo: string; user: string; name: string },
) {
  console.log(`Opening PR for ${name}`);

  forkRepo({ user, name });
}

function forkRepo({ user, name }: { user: string; name: string }) {
  throw new Error("Function not implemented.");
}
