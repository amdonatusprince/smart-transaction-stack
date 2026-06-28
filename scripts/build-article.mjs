import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const architecturePath = resolve(root, "docs/architecture.md");
const articlePath = resolve(root, "docs/article.md");
const diagramNames = [
  ["System architecture", "system-architecture.png"],
  ["Transaction execution flow", "execution-sequence.png"],
  ["Lifecycle tracking model", "lifecycle-states.png"],
  ["AI retry flow", "ai-retry-flow.png"],
  ["Doctor command flow", "command-doctor.png"],
  ["Run command flow", "command-run.png"],
  ["Blockhash-expiry command flow", "command-fault-blockhash.png"],
  ["Dashboard command flow", "command-dashboard.png"],
  ["Export command flow", "command-export.png"]
];

let index = 0;
const architecture = readFileSync(architecturePath, "utf8")
  .replace(/^# Snapsis Architecture\n+/, "# How to Build an AI-Powered Smart Transaction Stack with Yellowstone gRPC and Jito Bundles\n\n");
const body = architecture.replace(/```mermaid\n[\s\S]*?```/g, () => {
  const [alt, file] = diagramNames[index] ?? [`Diagram ${index + 1}`, ""];
  index += 1;
  return `![${alt}](../shots/${file})`;
});

const article = body;

writeFileSync(articlePath, article);
console.log(`Wrote article to ${articlePath}`);
