import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const architecturePath = resolve(root, "docs/architecture.md");
const shotsDir = resolve(root, "shots");
const names = [
  "system-architecture",
  "execution-sequence",
  "lifecycle-states",
  "ai-retry-flow",
  "command-doctor",
  "command-run",
  "command-fault-blockhash",
  "command-dashboard",
  "command-export"
];

mkdirSync(shotsDir, { recursive: true });

const tempDir = mkdtempSync(resolve(tmpdir(), "snapsis-mermaid-"));
const puppeteerConfig = resolve(tempDir, "puppeteer-config.json");
writeFileSync(
  puppeteerConfig,
  JSON.stringify({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }, null, 2)
);

const markdown = readFileSync(architecturePath, "utf8");
const blocks = [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => match[1].trim());

if (blocks.length !== names.length) {
  throw new Error(`Expected ${names.length} Mermaid blocks, found ${blocks.length}`);
}

for (const [index, block] of blocks.entries()) {
  const base = resolve(shotsDir, names[index]);
  const source = resolve(tempDir, `${names[index]}.mmd`);
  const output = `${base}.png`;
  writeFileSync(source, `${block}\n`);
  const result = spawnSync("npx", ["-y", "@mermaid-js/mermaid-cli", "-i", source, "-o", output, "-b", "transparent", "-w", "1400", "-H", "900", "-p", puppeteerConfig], {
    cwd: root,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" },
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`Failed to render ${source}`);
  }
}

writeFileSync(
  resolve(shotsDir, "README.md"),
  `${names.map((name) => `- ${name}.png`).join("\n")}\n- snapsis-dashboard-updated.png\n`
);

console.log(`Rendered ${names.length} Mermaid screenshots into ${shotsDir}`);
