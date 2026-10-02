import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";

function load(relative) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, Set, Promise });
  return exports;
}
const { isLikelyShellCommand, executableName, shouldAutoReturnToAi } =
  load("../src/features/terminal/command-classification.ts");
const { TerminalDispatcher } = load("../src/features/terminal/dispatcher.ts");

assert.equal(isLikelyShellCommand('bash -c "$(curl -fsSL https://example.test/install.sh)"'), true);
assert.equal(isLikelyShellCommand("sh installer.sh"), true);
assert.equal(executableName("cmehers chat"), "cmehers");
assert.equal(executableName("检查服务器"), null);
assert.equal(executableName("cmehers;echo"), null);
assert.equal(shouldAutoReturnToAi("cmehers"), true);
assert.equal(shouldAutoReturnToAi("cmehers chat"), true);
assert.equal(shouldAutoReturnToAi("bash -c 'echo ok'"), true);
assert.equal(shouldAutoReturnToAi("bash installer.sh"), true);
assert.equal(shouldAutoReturnToAi("bash"), false);
assert.equal(shouldAutoReturnToAi("sudo -u root -i"), false);
assert.equal(shouldAutoReturnToAi("sudo -u root bash -c 'echo ok'"), true);

function scenario(route) {
  const actions = [];
  const dispatcher = new TerminalDispatcher({
    writeCommand: async command => actions.push(["ssh", command]),
    askAi: prompt => actions.push(["ai", prompt]),
    approve: () => {},
    pendingCommand: () => null,
    onCommand: () => {},
    looksLikeCommand: isLikelyShellCommand,
    resolveUnknownCommand: async line => {
      actions.push(["lookup", executableName(line)]);
      return route;
    },
  });
  return { dispatcher, actions };
}
{
  const { dispatcher, actions } = scenario("command");
  await dispatcher.dispatch("cmehers");
  assert.deepEqual(actions, [["lookup", "cmehers"], ["ssh", "cmehers"]]);
}
{
  const { dispatcher, actions } = scenario("cancel");
  await dispatcher.dispatch("cmehers");
  assert.deepEqual(actions, [["lookup", "cmehers"]]);
}
{
  const { dispatcher, actions } = scenario("ai");
  await dispatcher.dispatch("question");
  assert.deepEqual(actions, [["lookup", "question"], ["ai", "question"]]);
}
{
  const { dispatcher, actions } = scenario("cancel");
  await dispatcher.dispatch("/cmd cmehers");
  await dispatcher.dispatch("/ai 检查服务器");
  assert.deepEqual(actions, [["ssh", "cmehers"], ["ai", "检查服务器"]]);
}
{
  const { dispatcher, actions } = scenario("cancel");
  await dispatcher.dispatch('bash -c "echo ok"');
  assert.deepEqual(actions, [["ssh", 'bash -c "echo ok"']]);
}
console.log("Terminal routing regression checks passed.");
