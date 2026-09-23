/**
 * Settings-namespace integration tests for the instant compaction engine.
 * @module dsh-compaction-instant/test/settings
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { InstantCompactionEngine, resolveConfig } from "../src/index.js";

/**
 * The settings schema mirrors the engine's own defaults, so the resolved
 * settings layer is exactly what resolveConfig computes. These assertions
 * pin that contract: bumping an engine default must bump the schema default.
 * The settings surface is the cap plus the auto-compaction controls only —
 * the deprecated `checkpointScale`/`maxTokens` knobs are not exposed.
 */
test("SETTINGS_SCHEMA defaults mirror engine defaults", () => {
  const schema = InstantCompactionEngine.SETTINGS_SCHEMA;
  const resolved = schema({});
  assert.equal(resolved.checkpointCap, 65536);
  assert.equal(resolved.auto, true);
  assert.equal(resolved.thresholdRatio, 0.5);
  assert.equal(resolved.retainTurns, 1);
  assert.equal(resolved.retainTokens, 5120);
});

test("SETTINGS_SCHEMA validates user overrides and rejects malformed values", () => {
  const schema = InstantCompactionEngine.SETTINGS_SCHEMA;
  assert.equal(schema({ checkpointCap: 131072 }).checkpointCap, 131072);
  assert.equal(schema({ auto: false }).auto, false);
  assert.equal(schema({ thresholdRatio: 0.25 }).thresholdRatio, 0.25);
  assert.equal(schema({ retainTurns: 3 }).retainTurns, 3);
  assert.equal(schema({ retainTokens: 50000 }).retainTokens, 50000);
  assert.throws(() => schema({ checkpointCap: -1 }));
  assert.throws(() => schema({ checkpointCap: 1.5 }));
  assert.throws(() => schema({ thresholdRatio: 1.5 }));
  assert.throws(() => schema({ thresholdRatio: -0.1 }));
  assert.throws(() => schema({ retainTurns: 0 }));
  assert.throws(() => schema({ retainTurns: 1.5 }));
  assert.throws(() => schema({ retainTokens: -1 }));
  assert.throws(() => schema({ auto: "yes" }));
});

test("settings values feed the engine through resolveConfig", () => {
  // A settings-layer value must survive the engine's validation and win over
  // the composition defaults once the source thunk is replaced. A real cordis
  // Context satisfies the Service base; no settings service is mounted, so
  // installSettingsSection's inject callback never runs.
  const engine = new InstantCompactionEngine(new Context(), {});
  engine.source = () => ({ checkpointCap: 131072, auto: false, thresholdRatio: 0.6, retainTurns: 2, retainTokens: 3000 });
  engine._reloadConfig();
  assert.equal(engine.config.checkpointCap, 131072);
  assert.equal(engine.config.auto, false);
  assert.equal(engine.config.thresholdRatio, 0.6);
  assert.equal(engine.config.retainTurns, 2);
  assert.equal(engine.config.retainTokens, 3000);
  // Non-exposed fields keep the composition entry values under the swap.
  engine.source = () => ({ ...{ maxTokens: 4096 }, ...{ checkpointCap: 65536 } });
  engine._reloadConfig();
  assert.equal(engine.config.maxTokens, 4096);
  assert.equal(engine.config.checkpointCap, 65536);
});

/** Yield once so a deferred cordis inject callback can run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Config still resolves with the settings-exposed fields marked volatile", () => {
  // `volatileField` is an identity function on hosts whose schemastery predates
  // 0.1.7; on 0.1.7 it marks the field so the Config-derived settings form can
  // edit it, and the loader then hands the plugin a live cosmokit reference in
  // place of the plain value. Either way `resolveConfig` must end up with the
  // value itself, never with the reference object.
  const parsed = InstantCompactionEngine.Config({ checkpointCap: 1024, auto: false, thresholdRatio: 0.25 });
  const resolved = resolveConfig(parsed);
  assert.equal(resolved.checkpointCap, 1024);
  assert.equal(resolved.auto, false);
  assert.equal(resolved.thresholdRatio, 0.25);
});

test("volatile Config references from the 0.1.7 loader are unwrapped before validation", () => {
  // dsh 0.1.7 wraps every `volatile()` Config field so a settings edit can be
  // applied without remounting the plugin; the plugin is expected to read
  // `.get()`. Validating the reference itself used to abort activation with
  // "thresholdRatio ([object Object]) must be a number in (0, 1]".
  const write = Symbol.for("cosmokit.volatile.write");
  const ref = (value) => Object.freeze({ get: () => value, [write]: () => {} });
  const resolved = resolveConfig({ thresholdRatio: ref(0.4), retainTurns: ref(3), retainTokens: ref(2048), auto: ref(false) });
  assert.equal(resolved.thresholdRatio, 0.4);
  assert.equal(resolved.retainTurns, 3);
  assert.equal(resolved.retainTokens, 2048);
  assert.equal(resolved.auto, false);
  // A reference keeps tracking its owner, so a later read sees the new value.
  let live = 0.6;
  const moving = { get: () => live, [write]: () => {} };
  assert.equal(resolveConfig({ thresholdRatio: moving }).thresholdRatio, 0.6);
  live = 0.7;
  assert.equal(resolveConfig({ thresholdRatio: moving }).thresholdRatio, 0.7);
  // Bad values inside a reference are still rejected by the normal validation.
  assert.throws(() => resolveConfig({ thresholdRatio: ref(7) }), /thresholdRatio/);
});

test("the legacy settings namespace still mounts when the host provides register", async () => {
  const calls = [];
  const ctx = new Context();
  ctx.provide("settings", {
    register: (namespace, schema, options) => {
      calls.push({ namespace, schema, options });
      return { get: () => ({ checkpointCap: 2048 }), watch: () => {} };
    }
  });
  const engine = new InstantCompactionEngine(ctx, {});
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, "compaction-instant");
  assert.equal(calls[0].schema, InstantCompactionEngine.SETTINGS_SCHEMA);
  assert.equal(engine.config.checkpointCap, 2048);
});

test("a 0.1.7 settings service (no register seam) mounts nothing and does not throw", async () => {
  // dsh 0.1.7 replaced `ctx.settings.register(...)` with Config-derived forms
  // (`SettingsForms`: describe/update/replace/mutate, addressed by entry id).
  // The engine must fall back to the composition entry instead of throwing
  // inside the inject callback.
  const ctx = new Context();
  ctx.provide("settings", {
    describe: () => [],
    update: async () => {},
    replace: async () => {},
    mutate: async () => {},
    configure: () => () => {}
  });
  const engine = new InstantCompactionEngine(ctx, { checkpointCap: 4096 });
  await flush();
  assert.equal(engine.config.checkpointCap, 4096);
  assert.equal(engine.config.auto, true);
  assert.equal(engine.config.thresholdRatio, 0.5);
  assert.equal(engine.config.retainTokens, 5120);
});
