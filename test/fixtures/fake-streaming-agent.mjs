// Stand-in for an interactive `claude` agent in stream-json mode.
// Reads newline-delimited JSON messages from stdin; each carries a `.text`
// (the test uses a simple {text} framing). For every message it writes a file
// and commits it, so the harness sees real commits and the test can assert that
// an injected message was delivered. Exits when stdin closes.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

let n = 0;
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let text = line;
  try {
    const msg = JSON.parse(line);
    text = typeof msg.text === "string" ? msg.text : JSON.stringify(msg);
  } catch {
    /* keep raw line */
  }
  n++;
  const file = `msg-${n}.txt`;
  writeFileSync(file, text);
  execSync(`git add -A && git commit -m "agent msg ${n}"`, { stdio: "ignore" });
  console.log(`fake-streaming-agent: handled msg ${n}`);
});

rl.on("close", () => process.exit(0));
