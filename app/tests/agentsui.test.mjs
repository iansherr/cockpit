import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

async function fixture(liveAgents) {
  const context = createContext({ console });
  const imports = {
    herdr: {
      agents: () => liveAgents,
      spaces: () => [],
      run: () => {},
      setShared: () => {},
      notify: () => {},
    },
    "gpui-base": {
      InputState: { new: () => ({}) },
    },
    "./hub.js": {
      act: async () => ({}),
      subscribe: () => ({ stop() {} }),
    },
  };
  const sources = new Map();
  const modules = new Map();
  const folder = new URL("../mods/cockpit/", import.meta.url);
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".js")) continue;
    const text = await readFile(new URL(name, folder), "utf8");
    sources.set(`./${name}`, text);
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(herdr|gpui-kit|gpui-base)"/g)) {
      const exports = (imports[match[2]] ??= {});
      for (const word of match[1].split(",")) {
        const key = word.trim().split(/\s+as\s+/)[0];
        exports[key] ??= () => {
          throw new Error(`unexpected native call: ${key}`);
        };
      }
    }
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const native = imports[name];
    const mod = native
      ? new SyntheticModule(
          Object.keys(native),
          function () {
            for (const [key, value] of Object.entries(native)) this.setExport(key, value);
          },
          { context },
        )
      : new SourceTextModule(sources.get(name), { context, identifier: name });
    modules.set(name, mod);
    return mod;
  }
  const mod = new SourceTextModule('export { AgentsModel } from "./agentsui.js";', { context });
  await mod.link(load);
  await mod.evaluate();
  return mod.namespace.AgentsModel;
}

test("AgentsModel.rows strips spinner prefixes, ignores numeric tab names, and merges program/cwd", async () => {
  const AgentsModel = await fixture([
    {
      address: "w1:p1",
      status: "idle",
      title: "✢ Audit MacMold ecosystem",
      tab_name: "1",
      cwd: "/Users/dev/project",
      program: { key: "codex", name: "Codex" },
    },
  ]);
  const model = new AgentsModel();
  model.down = false;
  model.value = {
    agents: [
      {
        terminal: "app:w1:p1",
        address: "w1:p1",
        stage: "idle",
        tab: { id: "t1", name: "1" },
      },
    ],
  };

  const rows = model.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Audit MacMold ecosystem");
  assert.equal(rows[0].cwd, "/Users/dev/project");
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0].program)), { key: "codex", name: "Codex" });
});

test("AgentsModel.rows clears stale needs_you and question when Herdr status is no longer blocked", async () => {
  const AgentsModel = await fixture([
    {
      address: "w2:p1",
      status: "working",
      terminal_title_stripped: "1",
      tab_name: "2",
    },
  ]);
  const model = new AgentsModel();
  model.down = false;
  model.value = {
    agents: [
      {
        terminal: "app:w2:p1",
        address: "w2:p1",
        stage: "needs_you",
        task: "Fix CI checks",
        question: { text: "Proceed?", choices: [] },
      },
    ],
  };

  const rows = model.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "working");
  assert.equal(rows[0].question, null);
  assert.equal(rows[0].title, "Fix CI checks");
});
