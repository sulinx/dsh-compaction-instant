/**
 * Browser half of dsh-compaction-instant: a plugin configuration card under
 * Settings → Plugins, bound to the `compaction-instant` settings namespace
 * registered by the engine's Host half (src/index.js).
 *
 * This file is served verbatim by the deployment's client-modules bundle
 * route, so it must be a self-contained lazy-CJS factory in the
 * `window.__ModuleLoader__.load` format. It registers under BOTH package
 * names: the alias name used by drop-in deployments
 * (`@deepseek-ai/dsh-compaction-basic` — web profiles alias the official
 * package to this one so bundled agent presets keep resolving) and the real
 * package name. Exactly one of the two is required by the boot graph; the
 * other registration is inert.
 *
 * No TypeScript/JSX/bundler transforms run on this file.
 */
function instantCompactionClientFactory(require) {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  var React = require("react");
  // LOCAL PATCH (2026-09-03): dsh 0.1.2 removed the @deepseek-ai/dsh-client-runtime
  // client bundle; createSnapshotStore now ships in @deepseek-ai/dsh-client-store
  // (same API). Re-apply after any plugin reinstall/upgrade.
  var { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

  // ── styles (injected once per page, matching the official cards' tokens) ──
  var css = [
    ".dsci_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
    ".dsci_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
    ".dsci_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
    ".dsci_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
    ".dsci_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
    ".dsci_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
    ".dsci_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
    ".dsci_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
    ".dsci_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
    ".dsci_chevronOpen{transform:rotate(180deg)}",
    ".dsci_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
    ".dsci_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
    ".dsci_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
    ".dsci_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
    ".dsci_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}",
    ".dsci_discard,.dsci_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
    ".dsci_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
    ".dsci_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
    ".dsci_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
    ".dsci_discard:disabled,.dsci_save:disabled{opacity:.4;cursor:default}",
    ".dsci_discard:focus-visible,.dsci_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
    ".dsci_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}",
    ".dsci_field+.dsci_field{border-top:1px solid var(--dsw-alias-border-l2)}",
    ".dsci_head{align-items:center;gap:8px;display:flex}",
    ".dsci_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
    ".dsci_badges{align-items:center;gap:8px;display:inline-flex}",
    ".dsci_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
    ".dsci_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}",
    ".dsci_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
    ".dsci_reset:disabled{cursor:default}",
    ".dsci_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}",
    ".dsci_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
    ".dsci_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
    ".dsci_inputInvalid{border-color:var(--dsw-alias-label-error)}",
    ".dsci_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}",
    ".dsci_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
    ".dsci_toggleRow{align-items:center;gap:10px;display:flex}",
    ".dsci_toggle{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px;cursor:pointer}",
    ".dsci_toggle:disabled{cursor:default}"
  ].join("");
  var tagId = "dsh-compaction-instant/settings.css";
  if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
    var tag = document.createElement("style");
    tag.dataset.plugin = "dsh-compaction-instant";
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── locale ────────────────────────────────────────────────────────────────
  var NS = "compaction-instant";
  var zh = {
    title: "即时压缩",
    description: "VCC 式即时压缩引擎（dsh-compaction-instant）的参数。",
    checkpointCap: "检查点预算上限",
    checkpointCapHint: "一次检查点的编译预算上限（默认 65536）。",
    auto: "自动压缩",
    autoHint: "步骤间按上下文压力自动压缩；关闭后仅手动 /compact。",
    thresholdRatio: "自动压缩比例",
    thresholdRatioHint: "上下文窗口占用达到此比例时触发自动压缩（默认 0.5）。",
    retainTurns: "保留回合数",
    retainTurnsHint: "优先保留最近 N 个完整回合（默认 1）。",
    retainTokens: "保留 token 上限",
    retainTokensHint: "保留区 token 硬上限：补足回合时永不超出；若最近回合本身就大于它，只保留其中能装下的部分（默认 5120）。",
    skipPerTurnInjections: "跳过每轮注入",
    skipPerTurnInjectionsHint: "不把宿主每轮重新注入的内容（运行上下文/记忆快照、技能目录）编进检查点：这些内容每次请求都会原样重发，且 append-only 日志仍可用 recall/search 取回。关闭则退回旧行为（实测旧行为下单个压缩区间有 73%–98% 的编译预算花在这类样板文本上）。",
    rankElision: "相关性排序与重复折叠",
    rankElisionHint: "按价值排序决定检查点超限时先丢哪一行（编辑/测试/工作流命令优先保留），并把重复的同一工具行折叠成一条备注。实测 112 个真实压缩区间：工具行带载荷比例 32.8%→76.4%（体积 +3.4%），40% 上限下高价值行保留率 11.6%→19.8%，对话正文 100% 保留。关闭则退回「从最旧的低价值行开始丢」。",
    overridden: "已覆盖",
    reset: "重置",
    invalidNumber: "必须是数字",
    save: "保存",
    saving: "保存中…",
    saveFailed: "保存失败",
    discard: "放弃",
    unsaved: "未保存",
    readOnly: "当前连接为只读，无法修改配置。",
    expand: "展开",
    collapse: "收起"
  };
  var en = {
    title: "Instant Compaction",
    description: "VCC-style instant compaction engine (dsh-compaction-instant) tuning.",
    checkpointCap: "Checkpoint cap",
    checkpointCapHint: "Total compiler-token budget for one checkpoint (default 65536).",
    auto: "Automatic compaction",
    autoHint: "Compress automatically between steps by pressure; off means manual /compact only.",
    thresholdRatio: "Auto-compaction ratio",
    thresholdRatioHint: "Triggers automatic compaction at this fraction of the context window (default 0.5).",
    retainTurns: "Retained turns",
    retainTurnsHint: "Prefer the last N complete turns (default 1).",
    retainTokens: "Retained-token ceiling",
    retainTokensHint: "Hard ceiling for the retained region: turn extension never exceeds it, and if the latest turn alone is bigger, only the part of it that fits is kept (default 5120).",
    skipPerTurnInjections: "Skip per-turn injections",
    skipPerTurnInjectionsHint: "Keep host per-turn injections (runtime-context/memory snapshot, skill catalog) out of checkpoints: they are re-sent verbatim on every request and stay recoverable via recall/search in the append-only log. Turn off for the old behavior (measured: 73%–98% of one real compaction span's compiled budget went to that boilerplate).",
    rankElision: "Relevance ranking + repeat collapsing",
    rankElisionHint: "Rank rows by value so cap pressure drops the least useful one first (edits, test runs and workflow commands stay), and collapse repeated identical tool rows into one marker. Measured over 112 real compaction regions: tool rows carrying a payload 32.8% → 76.4% for +3.4% tokens, and under a 40% cap high-value rows retained 11.6% → 19.8% with conversation text untouched. Turn off for the old oldest-first elision.",
    overridden: "Overridden",
    reset: "Reset",
    invalidNumber: "Must be a number",
    save: "Save",
    saving: "Saving…",
    saveFailed: "Save failed",
    discard: "Discard",
    unsaved: "Unsaved",
    readOnly: "This connection is read-only.",
    expand: "Expand",
    collapse: "Collapse"
  };

  // ── field specs ───────────────────────────────────────────────────────────
  /** A whole-number field; empty draft clears, non-numeric drafts block save. */
  function numberField(field) {
    return {
      field,
      format: (value) => typeof value === "number" ? String(value) : "",
      parse: (text) => {
        var trimmed = text.trim();
        if (trimmed === "") return { kind: "clear" };
        var parsed = Number(trimmed);
        return Number.isFinite(parsed) ? { kind: "set", value: parsed } : void 0;
      }
    };
  }
  /** A boolean field staged through the toggle's "true"/"false" text. */
  function booleanField(field) {
    return {
      field,
      format: (value) => value === true ? "true" : "false",
      parse: (text) => ({ kind: "set", value: text === "true" })
    };
  }

  // ── form model (official-card semantics: staged edits, one save, read-back) ──
  /**
   * Stages one card's edits over the compaction-instant settings namespace and
   * writes them on save. Mirrors the official plugin-card form contract:
   * dirty/invalid/saving/failed shell state, per-field draft text, and a save
   * that plans one write per staged field then re-reads from the Host.
   */
  var CardController = /** @class */ (function () {
    function CardController(scope, specs) {
      this.scope = scope;
      this.specs = new Map(specs.map(function (spec) { return [spec.field, spec]; }));
      this.staged = new Map();
      this.listeners = new Set();
      this.saving = false;
      this.failed = false;
      scope.subscribe(function () { this.publish(); }.bind(this));
    }
    /** Build the snapshot store the slot's `useCompactionCard` selector reads. */
    CardController.prototype.bind = function (project) {
      var store = createSnapshotStore(project());
      this.listeners.add(function () { store.set(project()); });
      return store;
    };
    CardController.prototype.publish = function () {
      for (var _i = 0, _a = Array.from(this.listeners); _i < _a.length; _i++) {
        var listener = _a[_i];
        try { listener(); } catch (_) { /* a failing projection must not kill the form */ }
      }
    };
    CardController.prototype.shell = function () {
      var snapshot = this.scope.getSnapshot();
      var plan = this.plan();
      return {
        available: snapshot.status === "ready",
        writable: snapshot.writable,
        dirty: plan.length > 0,
        invalid: plan.some(function (item) { return item.run === void 0; }),
        saving: this.saving,
        failed: this.failed
      };
    };
    CardController.prototype.field = function (field) {
      var staged = this.staged.get(field);
      var spec = this.specs.get(field);
      if (staged === void 0) {
        return {
          text: spec.format(this.sectionValue(field)),
          overridden: this.stored(field),
          invalid: false
        };
      }
      var write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
      return {
        text: staged.text,
        overridden: write != null && write.kind === "set",
        invalid: write === void 0
      };
    };
    CardController.prototype.actions = function () {
      var self = this;
      return {
        edit: function (field, text) {
          self.stage(field, { text: text, clear: false });
        },
        resetField: function (field) {
          self.stage(field, { text: self.specs.get(field).format(self.baseValue(field)), clear: true });
        },
        save: function () { self.save(); },
        discard: function () {
          if (self.staged.size === 0 && !self.failed) return;
          self.staged.clear();
          self.failed = false;
          self.publish();
        }
      };
    };
    /** Every staged edit a save would write, in staging order. */
    CardController.prototype.plan = function () {
      var plan = [];
      var entries = Array.from(this.staged.entries());
      for (var _i = 0; _i < entries.length; _i++) {
        var entry = entries[_i];
        var field = entry[0];
        var staged = entry[1];
        var spec = this.specs.get(field);
        if (staged.clear) {
          if (this.stored(field)) plan.push({ field: field, run: (function (self, f) { return function () { return self.clear(f); }; })(this, field) });
          continue;
        }
        if (staged.text === spec.format(this.sectionValue(field))) continue;
        var write = spec.parse(staged.text);
        if (write === void 0) plan.push({ field: field, run: void 0 });
        else if (write.kind === "clear") plan.push({ field: field, run: (function (self, f) { return function () { return self.clear(f); }; })(this, field) });
        else plan.push({ field: field, run: (function (self, f, v) { return function () { return self.store(f, v); }; })(this, field, write.value) });
      }
      return plan;
    };
    CardController.prototype.stage = function (field, edit) {
      this.staged.set(field, edit);
      this.failed = false;
      this.publish();
    };
    CardController.prototype.sectionValue = function (field) {
      var value = this.scope.getSnapshot().value;
      return value == null ? void 0 : value[field];
    };
    CardController.prototype.baseValue = function (field) {
      var base = this.scope.getSnapshot().base;
      return base == null ? void 0 : base[field];
    };
    CardController.prototype.userLayer = function () {
      return this.scope.getSnapshot().user;
    };
    CardController.prototype.stored = function (field) {
      var user = this.userLayer();
      return user !== void 0 && Object.prototype.hasOwnProperty.call(user, field);
    };
    CardController.prototype.clear = function (field) {
      var self = this;
      return this.scope.unset(field).then(function () { return !self.stored(field); });
    };
    CardController.prototype.store = function (field, value) {
      var self = this;
      return this.scope.set(field, value).then(function () {
        var user = self.userLayer();
        return user !== void 0 && user[field] === value;
      });
    };
    /** Write every staged edit, then re-read what the Host accepted. */
    CardController.prototype.save = function () {
      var self = this;
      var plan = this.plan();
      var writes = [];
      for (var _i = 0; _i < plan.length; _i++) {
        var item = plan[_i];
        if (item.run !== void 0) writes.push(item.run);
      }
      if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
      this.saving = true;
      this.failed = false;
      this.publish();
      var landed = true;
      var settle = Promise.resolve();
      for (var _a = 0; _a < writes.length; _a++) {
        settle = settle.then(writes[_a]).then(function (ok) { landed = ok && landed; });
      }
      settle.then(function () {
        if (landed) self.staged.clear();
        self.saving = false;
        self.failed = !landed;
        self.publish();
      });
    };
    return CardController;
  })();

  // ── components ────────────────────────────────────────────────────────────
  function ValueField(props) {
    return React.createElement(
      "div",
      { className: "dsci_field" },
      React.createElement(
        "div",
        { className: "dsci_head" },
        React.createElement("label", { className: "dsci_label", htmlFor: props.id }, props.label),
        props.overridden
          ? React.createElement(
              "span",
              { className: "dsci_badges" },
              React.createElement("span", { className: "dsci_badge" }, props.overriddenLabel),
              React.createElement("button", {
                type: "button",
                className: "dsci_reset",
                disabled: props.disabled,
                onClick: props.onReset
              }, props.resetLabel)
            )
          : null
      ),
      React.createElement("input", {
        id: props.id,
        className: props.invalid ? "dsci_input dsci_inputInvalid" : "dsci_input",
        type: "text",
        inputMode: props.numeric === true ? "numeric" : void 0,
        "aria-invalid": props.invalid ? true : void 0,
        value: props.text,
        placeholder: props.placeholder ?? "",
        disabled: props.disabled,
        onChange: function (event) { props.onEdit(event.target.value); }
      }),
      React.createElement("p", { className: props.invalid ? "dsci_invalid" : "dsci_hint" }, props.invalid ? props.invalidLabel : props.hint)
    );
  }

  function ToggleField(props) {
    return React.createElement(
      "div",
      { className: "dsci_field" },
      React.createElement(
        "div",
        { className: "dsci_head" },
        React.createElement("label", { className: "dsci_label", htmlFor: props.id }, props.label),
        props.overridden
          ? React.createElement(
              "span",
              { className: "dsci_badges" },
              React.createElement("span", { className: "dsci_badge" }, props.overriddenLabel),
              React.createElement("button", {
                type: "button",
                className: "dsci_reset",
                disabled: props.disabled,
                onClick: props.onReset
              }, props.resetLabel)
            )
          : null
      ),
      React.createElement(
        "div",
        { className: "dsci_toggleRow" },
        React.createElement("input", {
          id: props.id,
          className: "dsci_toggle",
          type: "checkbox",
          checked: props.checked,
          disabled: props.disabled,
          onChange: function (event) { props.onToggle(event.target.checked); }
        })
      ),
      React.createElement("p", { className: "dsci_hint" }, props.hint)
    );
  }

  /** Render the compaction-instant card; nothing while the namespace is unavailable. */
  function CompactionCard(props) {
    var open = React.useState(false);
    var isOpen = open[0];
    var setOpen = open[1];
    // LOCAL PATCH (2026-09-03): the 0.1.2 settings UI only provides useXCard
  // selectors for cards it knows; render nothing instead of throwing if the host
  // UI does not provide useCompactionCard (engine/tools are host-side, unaffected).
  if (typeof props.useCompactionCard !== "function") return null;
  var state = props.useCompactionCard(function (snapshot) { return snapshot; });
    var t = props.t;
    if (!state.available) return null;
    var blocked = !state.dirty || state.invalid || state.saving;
    return React.createElement(
      "li",
      { className: "dsci_card" + (isOpen ? " dsci_cardOpen" : "") },
      React.createElement(
        "button",
        {
          type: "button",
          className: "dsci_header",
          "aria-expanded": isOpen,
          "aria-label": t(isOpen ? "collapse" : "expand") + ": " + t("title"),
          onClick: function () { setOpen(!isOpen); }
        },
        React.createElement(
          "span",
          { className: "dsci_headText" },
          React.createElement("span", { className: "dsci_name" }, t("title")),
          React.createElement("span", { className: "dsci_description" }, t("description"))
        ),
        state.dirty ? React.createElement("span", { className: "dsci_pending" }, t("unsaved")) : null,
        React.createElement("span", { className: "dsci_chevron" + (isOpen ? " dsci_chevronOpen" : "") }, "▾")
      ),
      isOpen
        ? React.createElement(
            "div",
            { className: "dsci_body" },
            !state.writable ? React.createElement("p", { className: "dsci_readOnly", role: "status" }, t("readOnly")) : null,
            React.createElement(ValueField, {
              id: "plugin-config-instant-cap",
              label: t("checkpointCap"),
              hint: t("checkpointCapHint"),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              invalidLabel: t("invalidNumber"),
              numeric: true,
              disabled: !state.writable,
              ...state.checkpointCap,
              onEdit: function (text) { props.edit("checkpointCap", text); },
              onReset: function () { props.resetField("checkpointCap"); }
            }),
            React.createElement(ToggleField, {
              id: "plugin-config-instant-auto",
              label: t("auto"),
              hint: t("autoHint"),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              checked: state.auto.text === "true",
              overridden: state.auto.overridden,
              disabled: !state.writable,
              onToggle: function (checked) { props.edit("auto", checked ? "true" : "false"); },
              onReset: function () { props.resetField("auto"); }
            }),
            React.createElement(ValueField, {
              id: "plugin-config-instant-threshold",
              label: t("thresholdRatio"),
              hint: t("thresholdRatioHint"),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              invalidLabel: t("invalidNumber"),
              numeric: true,
              disabled: !state.writable,
              ...state.thresholdRatio,
              onEdit: function (text) { props.edit("thresholdRatio", text); },
              onReset: function () { props.resetField("thresholdRatio"); }
            }),
            React.createElement(ValueField, {
              id: "plugin-config-instant-retain-turns",
              label: t("retainTurns"),
              hint: t("retainTurnsHint"),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              invalidLabel: t("invalidNumber"),
              numeric: true,
              disabled: !state.writable,
              ...state.retainTurns,
              onEdit: function (text) { props.edit("retainTurns", text); },
              onReset: function () { props.resetField("retainTurns"); }
            }),
            React.createElement(ValueField, {
              id: "plugin-config-instant-retain-tokens",
              label: t("retainTokens"),
              hint: t("retainTokensHint"),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              invalidLabel: t("invalidNumber"),
              numeric: true,
              disabled: !state.writable,
              ...state.retainTokens,
              onEdit: function (text) { props.edit("retainTokens", text); },
              onReset: function () { props.resetField("retainTokens"); }
            }),
            React.createElement(ToggleField, {
              id: "plugin-config-instant-skip-injections",
              label: t("skipPerTurnInjections"),
              hint: t("skipPerTurnInjectionsHint"),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              checked: state.skipPerTurnInjections.text === "true",
              overridden: state.skipPerTurnInjections.overridden,
              disabled: !state.writable,
              onToggle: function (checked) { props.edit("skipPerTurnInjections", checked ? "true" : "false"); },
              onReset: function () { props.resetField("skipPerTurnInjections"); }
            }),
            React.createElement(ToggleField, {
              id: "plugin-config-instant-rank-elision",
              label: t("rankElision"),
              hint: t("rankElisionHint"),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              checked: state.rankElision.text === "true",
              overridden: state.rankElision.overridden,
              disabled: !state.writable,
              onToggle: function (checked) { props.edit("rankElision", checked ? "true" : "false"); },
              onReset: function () { props.resetField("rankElision"); }
            }),
            React.createElement(
              "div",
              { className: "dsci_footer" },
              state.failed ? React.createElement("p", { className: "dsci_failed", role: "status" }, t("saveFailed")) : null,
              React.createElement("button", {
                type: "button",
                className: "dsci_discard",
                disabled: !state.dirty || state.saving,
                onClick: props.discard
              }, t("discard")),
              React.createElement("button", {
                type: "button",
                className: "dsci_save",
                disabled: blocked,
                onClick: props.save
              }, t(state.saving ? "saving" : "save"))
            )
          )
        : null
    );
  }

  // ── plugin body ───────────────────────────────────────────────────────────
  /** Namespace of the instant-compaction settings section (Host side registers it). */
  var SETTINGS_NAMESPACE = "compaction-instant";
  /** Required services (cordis fiber inject). */
  // LOCAL PATCH (2026-09-03): dropped "connection" - not a client service in dsh 0.1.2
  // and unused by this client (apply() only uses locale/slots/remote/settingsScope).
  var inject = ["slots", "locale", "remote", "settingsScope"];

  function apply(ctx) {
    var t = ctx.locale.bind(NS);
    ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "compaction-instant: settings dictionary");
    var controller = new CardController(ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE }), [
      numberField("checkpointCap"),
      booleanField("auto"),
      numberField("thresholdRatio"),
      numberField("retainTurns"),
      numberField("retainTokens"),
      booleanField("skipPerTurnInjections"),
      booleanField("rankElision")
    ]);
    var store = controller.bind(function () {
      var shell = controller.shell();
      return {
        ...shell,
        checkpointCap: controller.field("checkpointCap"),
        auto: controller.field("auto"),
        thresholdRatio: controller.field("thresholdRatio"),
        retainTurns: controller.field("retainTurns"),
        retainTokens: controller.field("retainTokens"),
        skipPerTurnInjections: controller.field("skipPerTurnInjections"),
        rankElision: controller.field("rankElision")
      };
    });
    ctx.slots.inject("settings.plugin.item", function* () {
      yield ctx.slots.register({
        name: "settings.plugin.item",
        key: "compaction-instant",
        order: 30,
        locale: NS,
        inject: function () {
          return {
            hooks: { compactionCard: store },
            ...controller.actions()
          };
        }
      }, CompactionCard);
    });
  }

  exports.apply = apply;
  exports.inject = inject;
  return module.exports;
}

window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-compaction-basic",
  factory: instantCompactionClientFactory
});
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-compaction-instant",
  factory: instantCompactionClientFactory
});
window.__ModuleLoader__.load({
  id: "dsh-compaction-instant",
  factory: instantCompactionClientFactory
});
