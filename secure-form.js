/* ==========================================================================
   secure-form.js  --  Manual Customer Entry Only (fake-lead protection)
   Drop-in, frontend only. No backend changes needed.

   USAGE  (only the endpoint URL changes per landing page)
   ---------------------------------------------------------------------
   1. Mark the customer fields in your HTML:

        <input type="text" name="Name"   data-secure="name"   required>
        <input type="text" name="Mobile" data-secure="phone"  required>
        <input type="text" name="Pincode" data-secure="pin"   required>
        <input type="text" name="Address" data-secure="text"  required>
        <input type="text" name="Email"  data-secure="email">

   2. Load and start it:

        <script src="secure-form.js"></script>
        <script>
          SecureForm.init({
            endpoint: 'https://script.google.com/macros/s/XXXX/exec',
            form: '#orderForm',
            redirect: './Thankyou.html'
          });
        </script>

   WHAT IT DOES
   ---------------------------------------------------------------------
   - Steals the `name` off every protected input and moves it to a hidden
     mirror, so ONLY values the customer actually typed are submitted.
   - Injects decoy name/phone/address/pin fields that soak up browser and
     Google autofill.
   - Blocks paste, drag & drop, replacement-style auto entry, and
     multi-character injection (contact strip / keyboard suggestions).
   - Detects :-webkit-autofill and clears the field.
   - Watchdog reverts values injected with no events at all (iOS).
   - Touch devices get a built-in secure numeric keypad for phone/PIN, so
     the native keyboard -- and its AutoFill Contact strip -- never opens.
   - Canonicalizes Indian phone numbers: +91 / 91 / 0091 / 0 prefixes are
     stripped only when the number is longer than 10 digits, so a genuine
     9131194906 is never truncated.
   - Validates on submit, POSTs the form, then redirects.

   data-* ATTRIBUTES ON A FIELD
   ---------------------------------------------------------------------
   data-secure   name | phone | pin | text | email | digits   (required)
   data-len      exact length required (phone defaults 10, pin 6)
   data-min      minimum length (default 1, name 2)
   data-error    custom validation message
   data-keypad   "off" to force the native keyboard on a numeric field
   ========================================================================== */
(function (global) {
  "use strict";

  /* ----------------------------------------------------------------- CSS */
  var CSS = [
    ".sf-decoys{position:absolute;left:-9999px;top:0;width:1px;height:1px;",
    "overflow:hidden;opacity:0;pointer-events:none;}",
    "@keyframes sfAutoFillStart{from{}to{}}",
    "@keyframes sfAutoFillCancel{from{}to{}}",
    "input[data-secure]:-webkit-autofill{animation-name:sfAutoFillStart;animation-duration:1ms;}",
    "input[data-secure]:not(:-webkit-autofill){animation-name:sfAutoFillCancel;animation-duration:1ms;}",
    "input[data-secure]{-webkit-touch-callout:none;}",
    /* user-select:none makes an editable input untypable on older iOS,
           so it is limited to the readonly keypad-driven fields. */
    "input[data-secure].sf-keypad-mode{-webkit-user-select:none;user-select:none;}",
    "input[data-secure].sf-keypad-mode{caret-color:transparent;cursor:pointer;}",
    ".sf-backdrop{position:fixed;top:0;right:0;bottom:0;left:0;",
    "background:rgba(20,14,32,.45);display:none;z-index:99998;}",
    ".sf-backdrop.sf-show{display:block;}",
    ".sf-keypad{position:fixed;left:50%;bottom:0;transform:translateX(-50%) translateY(110%);",
    "width:100%;max-width:450px;background:#fff;z-index:99999;border-radius:22px 22px 0 0;",
    "padding:14px 14px calc(14px + env(safe-area-inset-bottom));",
    "box-shadow:0 -10px 30px rgba(20,14,32,.22);transition:transform .28s ease;",
    "font-family:inherit;}",
    ".sf-keypad.sf-show{transform:translateX(-50%) translateY(0);}",
    ".sf-keypad-head{display:flex;align-items:center;justify-content:space-between;",
    "padding:2px 6px 12px;font-size:13px;color:#6B5E7D;font-weight:600;}",
    ".sf-keypad-val{font-size:20px;font-weight:700;color:var(--sf-accent,#5B3A8E);",
    "letter-spacing:2px;font-variant-numeric:tabular-nums;min-height:24px;}",
    ".sf-keypad-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}",
    ".sf-keypad-grid button{font-family:inherit;font-size:22px;font-weight:700;color:#2C1E45;",
    "background:#F4F1F8;border:1px solid #E3DCEE;border-radius:14px;padding:14px 0;cursor:pointer;",
    "-webkit-tap-highlight-color:transparent;transition:background .15s ease,transform .1s ease;}",
    ".sf-keypad-grid button:active{background:#E6DFF3;transform:scale(.97);}",
    ".sf-keypad-grid button.sf-act{font-size:15px;color:var(--sf-accent,#5B3A8E);}",
    ".sf-keypad-grid button.sf-done{background:var(--sf-accent,#5B3A8E);",
    "border-color:var(--sf-accent,#5B3A8E);color:#fff;grid-column:1/-1;}",
  ].join("");

  var cssDone = false;
  function injectCSS() {
    if (cssDone) return;
    cssDone = true;
    var st = document.createElement("style");
    st.setAttribute("data-secure-form", "");
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------- helpers */
  var NAME_RE = /[^A-Za-zऀ-ॿ\s.'-]/g;
  var TEXT_RE = /[^A-Za-z0-9ऀ-ॿ\s,.\-\/()#'&]/g;
  var EMAIL_RE = /[^A-Za-z0-9@._\-+]/g;

  /* +91 / 91 / 0091 / 0 peeled in any order, but only while the number is
       longer than 10 digits -- a real 9131194906 keeps its leading 91. */
  function normalizeIndianPhone(raw) {
    var d = String(raw == null ? "" : raw).replace(/\D/g, "");
    while (d.length > 10) {
      if (d.charAt(0) === "0") d = d.slice(1);
      else if (d.slice(0, 2) === "91") d = d.slice(2);
      else break;
    }
    if (d.length > 10) d = d.slice(-10);
    return d;
  }

  var TYPES = {
    name: {
      clean: function (v) {
        return v.replace(NAME_RE, "");
      },
      min: 2,
      singleChar: false,
    },
    text: {
      clean: function (v) {
        return v.replace(TEXT_RE, "");
      },
      min: 1,
      singleChar: false,
    },
    email: {
      clean: function (v) {
        return v.replace(EMAIL_RE, "");
      },
      min: 5,
      singleChar: false,
      valid: function (v) {
        return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v);
      },
      message: "कृपया सही ईमेल पता टाइप करें",
    },
    phone: {
      clean: function (v) {
        var d = String(v).replace(/\D/g, "");
        while (d.length && !/[6-9]/.test(d.charAt(0))) d = d.slice(1);
        return d.slice(0, 10);
      },
      normalize: normalizeIndianPhone,
      len: 10,
      keypad: true,
      singleChar: true,
      valid: function (v) {
        return /^[6-9][0-9]{9}$/.test(v);
      },
      message: "कृपया 10 अंकों का सही मोबाइल नंबर टाइप करें",
    },
    pin: {
      clean: function (v) {
        return String(v).replace(/\D/g, "").slice(0, 6);
      },
      len: 6,
      keypad: true,
      singleChar: true,
      valid: function (v) {
        return /^[1-9][0-9]{5}$/.test(v);
      },
      message: "कृपया 6 अंकों का सही PIN code टाइप करें",
    },
    digits: {
      clean: function (v) {
        return String(v).replace(/\D/g, "");
      },
      keypad: true,
      singleChar: true,
    },
  };

  function attr(el, n, fallback) {
    var v = el.getAttribute(n);
    return v === null || v === "" ? fallback : v;
  }

  /* -------------------------------------------------------------- keypad */
  var Keypad = (function () {
    var panel,
      backdrop,
      readout,
      grid,
      active = null,
      built = false;

    function build() {
      if (built) return;
      built = true;
      backdrop = document.createElement("div");
      backdrop.className = "sf-backdrop";

      panel = document.createElement("div");
      panel.className = "sf-keypad";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Secure number pad");
      panel.innerHTML =
        '<div class="sf-keypad-head"><span>&#128274; Secure Entry</span>' +
        '<span class="sf-keypad-val"></span></div>' +
        '<div class="sf-keypad-grid">' +
        '<button type="button" data-k="1">1</button>' +
        '<button type="button" data-k="2">2</button>' +
        '<button type="button" data-k="3">3</button>' +
        '<button type="button" data-k="4">4</button>' +
        '<button type="button" data-k="5">5</button>' +
        '<button type="button" data-k="6">6</button>' +
        '<button type="button" data-k="7">7</button>' +
        '<button type="button" data-k="8">8</button>' +
        '<button type="button" data-k="9">9</button>' +
        '<button type="button" class="sf-act" data-k="clear">Clear</button>' +
        '<button type="button" data-k="0">0</button>' +
        '<button type="button" class="sf-act" data-k="back">&#9003;</button>' +
        '<button type="button" class="sf-done" data-k="done">Done</button>' +
        "</div>";

      document.body.appendChild(backdrop);
      document.body.appendChild(panel);
      readout = panel.querySelector(".sf-keypad-val");
      grid = panel.querySelector(".sf-keypad-grid");

      grid.addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-k]");
        if (!btn || !active) return;
        var k = btn.getAttribute("data-k");
        if (k === "done") {
          close();
          return;
        }
        if (k === "clear") active.set("");
        else if (k === "back") active.set(active.value.slice(0, -1));
        else active.set(active.value + k);
        render();
        if (active && active.max && active.value.length >= active.max) close();
      });
      backdrop.addEventListener("click", close);
    }

    function render() {
      if (readout) readout.textContent = active ? active.value : "";
    }

    function open(f) {
      build();
      if (active === f) return;
      active = f;
      f.el.blur(); // keep the native keyboard away
      panel.classList.add("sf-show");
      backdrop.classList.add("sf-show");
      render();
    }

    function close() {
      active = null;
      if (panel) panel.classList.remove("sf-show");
      if (backdrop) backdrop.classList.remove("sf-show");
    }

    return { open: open, close: close, refresh: render };
  })();

  /* ------------------------------------------------------------ instance */
  function SecureFormInstance(opts) {
    var self = this;
    this.opts = opts;
    this.form =
      typeof opts.form === "string"
        ? document.querySelector(opts.form)
        : opts.form;
    if (!this.form) throw new Error("SecureForm: form not found: " + opts.form);

    injectCSS();
    this.form.setAttribute("autocomplete", "off");
    this.fields = [];
    this.isTouch = !!(
      global.matchMedia && global.matchMedia("(pointer: coarse)").matches
    );

    var list = this.form.querySelectorAll("[data-secure]");
    Array.prototype.forEach.call(list, function (el) {
      self._attach(el);
    });

    this._addDecoys();
    this._modeField = this._hidden("entry_mode", "manual");

    /* iOS can swap a value in with no events at all. */
    this._watch = setInterval(function () {
      self.fields.forEach(function (f) {
        if (f.el.value !== f.value) {
          self._flag(f, "watchdog");
          f.paint();
        }
      });
    }, 250);

    this.form.addEventListener("submit", function (e) {
      self._submit(e);
    });

    global.addEventListener("pageshow", function () {
      self.reset();
    });
    this.reset();
  }

  SecureFormInstance.prototype._hidden = function (name, value) {
    var el = this.form.querySelector(
      'input[type="hidden"][name="' + name + '"]',
    );
    if (!el) {
      el = document.createElement("input");
      el.type = "hidden";
      el.name = name;
      this.form.appendChild(el);
    }
    if (value !== undefined) el.value = value;
    return el;
  };

  SecureFormInstance.prototype._addDecoys = function () {
    if (this.form.querySelector(".sf-decoys")) return;
    var box = document.createElement("div");
    box.className = "sf-decoys";
    box.setAttribute("aria-hidden", "true");
    box.innerHTML =
      '<input type="text" name="sf_decoy_name" tabindex="-1" autocomplete="name">' +
      '<input type="tel" name="sf_decoy_phone" tabindex="-1" autocomplete="tel">' +
      '<input type="text" name="sf_decoy_address" tabindex="-1" autocomplete="street-address">' +
      '<input type="text" name="sf_decoy_pin" tabindex="-1" autocomplete="postal-code">' +
      '<input type="email" name="sf_decoy_email" tabindex="-1" autocomplete="email">';
    this.form.insertBefore(box, this.form.firstChild);
  };

  SecureFormInstance.prototype._flag = function (f, why) {
    f.blocked = why;
    if (this._modeField) this._modeField.value = "manual_blocked:" + why;
    if (typeof this.opts.onBlocked === "function")
      this.opts.onBlocked(f.key, why);
  };

  SecureFormInstance.prototype._attach = function (el) {
    var self = this;
    var typeName = el.getAttribute("data-secure") || "text";
    var spec = TYPES[typeName] || TYPES.text;

    /* The visible box must not submit anything -- move its name to a
           hidden mirror that only our manual value store ever writes. */
    var key = el.getAttribute("name") || el.id || "field_" + this.fields.length;
    el.removeAttribute("name");
    var mirror = this._hidden(key);

    el.setAttribute("autocomplete", "new-password");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("spellcheck", "false");
    if (spec.keypad) {
      /* type=tel is a semantic autofill target; text+inputmode still
               gives the numeric keyboard on desktop/laptop browsers. */
      if (el.type === "tel") el.type = "text";
      el.setAttribute("inputmode", "numeric");
    }

    var f = {
      el: el,
      key: key,
      mirror: mirror,
      spec: spec,
      type: typeName,
      value: "",
      composing: false,
      blocked: "",
      lastType: "",
      required: el.hasAttribute("required"),
      max: parseInt(attr(el, "data-len", spec.len || 0), 10) || 0,
      min: parseInt(attr(el, "data-min", spec.min || 1), 10) || 1,
      message: attr(el, "data-error", spec.message || ""),
    };
    if (f.max) el.setAttribute("maxlength", String(f.max));

    f.clean = function (v) {
      var out = spec.clean(String(v == null ? "" : v));
      return f.max ? out.slice(0, f.max) : out;
    };
    f.paint = function () {
      if (f.el.value !== f.value) f.el.value = f.value;
      f.mirror.value = spec.normalize
        ? spec.normalize(f.value)
        : f.value.trim();
      if (typeof self.opts.onChange === "function") {
        self.opts.onChange(self.values(), f.key);
      }
    };
    f.set = function (v) {
      f.value = f.clean(v);
      f.paint();
      Keypad.refresh();
    };

    /* Only a change reachable by real typing is accepted. */
    function isManualEdit(prev, next) {
      if (next.length < prev.length) return true; // delete
      var added = next.length - prev.length;
      if (added === 0) return next === prev;
      if (spec.singleChar) return added === 1; // one digit
      if (added === 1 || f.composing) return true; // IME batches
      /* Several characters at once is fine only when the browser told
               us they came from typing -- iOS QuickPath swipe and Android
               gesture typing insert a whole word this way. Autofill sets
               .value directly and fires no beforeinput, so it still fails. */
      return (
        f.lastType === "insertText" || f.lastType === "insertCompositionText"
      );
    }

    [
      "paste",
      "drop",
      "dragover",
      "dragstart",
      "copy",
      "cut",
      "contextmenu",
    ].forEach(function (evt) {
      el.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (evt === "paste" || evt === "drop") self._flag(f, evt);
        return false;
      });
    });

    el.addEventListener("compositionstart", function () {
      f.composing = true;
    });
    el.addEventListener("compositionend", function () {
      f.composing = false;
    });

    el.addEventListener("beforeinput", function (e) {
      var t = e.inputType || "";
      f.lastType = t;
      if (
        t === "insertFromPaste" ||
        t === "insertFromDrop" ||
        t === "insertReplacementText" ||
        t === "insertFromPasteAsQuotation" ||
        t === "insertFromYank"
      ) {
        e.preventDefault();
        self._flag(f, t);
        f.paint();
        return;
      }
      if (
        spec.singleChar &&
        t === "insertText" &&
        e.data &&
        e.data.length > 1
      ) {
        e.preventDefault(); // suggestion strip
        self._flag(f, "multiInsert");
        f.paint();
      }
    });

    el.addEventListener("input", function () {
      var next = f.clean(el.value);
      if (isManualEdit(f.value, next)) f.value = next;
      else self._flag(f, "injected"); // revert to last manual
      f.lastType = ""; // consume it, never reuse
      f.paint();
    });

    /* Chrome/Safari fire this when they autofill -- see the CSS hook. */
    el.addEventListener("animationstart", function (e) {
      if (e.animationName === "sfAutoFillStart") {
        f.value = "";
        self._flag(f, "autofill");
        f.paint();
      }
    });

    /* Secure keypad on touch: the native keyboard (and its AutoFill
           Contact strip) never opens for numeric fields. */
    if (
      this.isTouch &&
      spec.keypad &&
      el.getAttribute("data-keypad") !== "off"
    ) {
      f.keypad = true;
      el.classList.add("sf-keypad-mode");
      el.setAttribute("readonly", "readonly"); // also kills native paste
      el.addEventListener("focus", function () {
        Keypad.open(f);
      });
      el.addEventListener("click", function () {
        Keypad.open(f);
      });
    }

    this.fields.push(f);
    return f;
  };

  /** Current canonical values, keyed by submit name. */
  SecureFormInstance.prototype.values = function () {
    var out = {};
    this.fields.forEach(function (f) {
      out[f.key] = f.mirror.value;
    });
    return out;
  };

  SecureFormInstance.prototype.field = function (key) {
    for (var i = 0; i < this.fields.length; i++) {
      if (this.fields[i].key === key || this.fields[i].el.id === key) {
        return this.fields[i];
      }
    }
    return null;
  };

  /** Always Start With Blank Customer Fields. */
  SecureFormInstance.prototype.reset = function () {
    Keypad.close();
    this.fields.forEach(function (f) {
      f.value = "";
      f.blocked = "";
      f.el.value = "";
      f.paint();
    });
    if (this._modeField) this._modeField.value = "manual";
  };

  /** Push the manual store into the hidden mirrors. */
  SecureFormInstance.prototype.commit = function () {
    this.fields.forEach(function (f) {
      f.paint();
    });
  };

  /** Validates the canonical (mirror) values, not the visible boxes. */
  SecureFormInstance.prototype.validate = function () {
    for (var i = 0; i < this.fields.length; i++) {
      var f = this.fields[i];
      var v = f.mirror.value;
      if (!v) {
        if (f.required)
          return { field: f, message: f.message || "यह जानकारी ज़रूरी है" };
        continue;
      }
      if (f.max && v.length !== f.max)
        return { field: f, message: f.message || "अधूरी जानकारी" };
      if (v.length < f.min)
        return { field: f, message: f.message || "अधूरी जानकारी" };
      if (f.spec.valid && !f.spec.valid(v))
        return { field: f, message: f.message || "गलत जानकारी" };
    }
    return null;
  };

  SecureFormInstance.prototype._reportInvalid = function (bad) {
    var f = bad.field;
    if (typeof this.opts.onInvalid === "function") {
      this.opts.onInvalid(f.key, bad.message, f.el);
    } else if (f.el.hasAttribute("readonly")) {
      /* A readonly control is barred from native constraint validation,
               so on touch we surface the message ourselves. */
      if (global.Swal) {
        global.Swal.fire({
          icon: "warning",
          title: "जानकारी अधूरी है",
          text: bad.message,
          confirmButtonColor: "#5B3A8E",
        });
      } else {
        alert(bad.message);
      }
    } else {
      f.el.setCustomValidity(bad.message);
      f.el.reportValidity();
      setTimeout(function () {
        f.el.setCustomValidity("");
      }, 2000);
    }
    if (f.keypad) Keypad.open(f);
    else f.el.focus();
  };

  SecureFormInstance.prototype._loader = function (on) {
    if (!this.opts.loader) return;
    var el =
      typeof this.opts.loader === "string"
        ? document.querySelector(this.opts.loader)
        : this.opts.loader;
    if (el)
      el.classList[on ? "add" : "remove"](this.opts.loaderClass || "show");
  };

  SecureFormInstance.prototype._submit = function (e) {
    var self = this;
    e.preventDefault();
    Keypad.close();
    this.commit();

    var bad = this.validate();
    if (bad) {
      this._reportInvalid(bad);
      return false;
    }

    if (
      typeof this.opts.beforeSubmit === "function" &&
      this.opts.beforeSubmit(this.form, this.values()) === false
    ) {
      return false;
    }

    var btn = this.form.querySelector(
      'button[type="submit"], input[type="submit"]',
    );
    if (btn) {
      btn.disabled = true;
      btn.style.display = "none";
    }
    this._loader(true);

    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      self._loader(false);
      if (typeof self.opts.onSuccess === "function") self.opts.onSuccess(ok);
      if (self.opts.redirect) global.location.href = self.opts.redirect;
      else if (btn) {
        btn.disabled = false;
        btn.style.display = "";
      }
    }

    /* Redirect anyway if the endpoint is slow -- the lead is already sent. */
    var timer = setTimeout(function () {
      finish(false);
    }, this.opts.redirectDelay || 2000);

    if (!this.opts.endpoint) {
      finish(true);
      return false;
    }

    fetch(this.opts.endpoint, { method: "POST", body: new FormData(this.form) })
      .then(function () {
        finish(true);
      })
      .catch(function (err) {
        if (typeof self.opts.onError === "function") self.opts.onError(err);
        finish(false);
      });

    return false;
  };

  /* -------------------------------------------------------------- public */
  var API = {
    init: function (opts) {
      opts = opts || {};
      if (!opts.form) opts.form = "form";
      function start() {
        API.instance = new SecureFormInstance(opts);
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
      } else {
        start();
      }
      return API;
    },
    normalizeIndianPhone: normalizeIndianPhone,
    Keypad: Keypad,
  };

  global.SecureForm = API;
})(window);
