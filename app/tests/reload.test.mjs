import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);

async function setupFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "cockpit-reload-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = path.join(root, "home");
  const sessions = path.join(home, ".cache", "cockpit", "sessions");
  await mkdir(sessions, { recursive: true });

  const pluginJson = JSON.parse(
    await readFile(new URL("../../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"),
  );
  await writeFile(path.join(sessions, "s1.json"), JSON.stringify({ pane: "w1:p1", version: "0.0.1" }));
  await writeFile(path.join(sessions, "s2.json"), JSON.stringify({ pane: "w1:p2", version: pluginJson.version }));

  const logFile = path.join(root, "prompts.log");
  const fakeHerdr = path.join(root, "fake-herdr");
  await writeFile(
    fakeHerdr,
    `#!/bin/sh
case "$1 $2" in
  "pane list") echo '{"result":{"panes":[{"pane_id":"w1:p1","agent":"claude","agent_status":"idle"},{"pane_id":"w1:p2","agent":"claude","agent_status":"working"}]}}' ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
  "agent prompt") echo "$3|$4" >> "${logFile}" ;;
esac
`,
  );
  await chmod(fakeHerdr, 0o755);

  const script = new URL("../../herdr/reload.sh", import.meta.url).pathname;
  const invoke = async (...args) => {
    await writeFile(logFile, "");
    const { stdout } = await run("sh", [script, ...args], {
      env: { ...process.env, HOME: home, HERDR_BIN_PATH: fakeHerdr, HERDR_APP_HOME: path.join(root, "no-app") },
    });
    const prompted = (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean);
    return { stdout: stdout.trim(), prompted };
  };

  return { invoke };
}

test("reload.sh targets only behind sessions by default, all with --force, and filters idle in any flag order", async (t) => {
  const f = await setupFixture(t);

  const def = await f.invoke();
  assert.deepEqual(def.prompted, ["w1:p1|/reload-plugins"]);

  const forced = await f.invoke("--force");
  assert.deepEqual(forced.prompted, ["w1:p1|/reload-plugins", "w1:p2|/reload-plugins"]);

  const idleForce = await f.invoke("--idle", "--force");
  const forceIdle = await f.invoke("--force", "--idle");
  assert.deepEqual(idleForce.prompted, ["w1:p1|/reload-plugins"]);
  assert.deepEqual(forceIdle.prompted, ["w1:p1|/reload-plugins"]);
});
