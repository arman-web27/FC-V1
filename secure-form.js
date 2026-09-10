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
   - Numeric fields open the device's own number pad (inputmode="numeric")
     while still refusing anything that was not typed one digit at a time.
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

   OPTIONS
   ---------------------------------------------------------------------
   endpoint       URL to POST the form to (omit if the page submits itself)
   form           selector or element         (default: 'form')
   redirect       URL to go to after submit
   redirectDelay  ms before redirecting anyway  (default 2000)
   loader         selector of an overlay toggled with .show while sending
   takeover       false = only protect + validate, let the existing form
                  handler submit. Use this with Contact Form 7, WPForms,
                  Elementor Forms, or any plugin that owns submission.
                  (default: true when `endpoint` is set, else false)
   onChange       fn(values, key)   -- fires on every accepted keystroke
   beforeSubmit   fn(form, values)  -- return false to abort
   onInvalid      fn(key, message, el)
   onSuccess      fn(ok) / onError  fn(err)
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
      numeric: true,
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
      numeric: true,
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
      numeric: true,
      singleChar: true,
    },
  };

  function attr(el, n, fallback) {
    var v = el.getAttribute(n);
    return v === null || v === "" ? fallback : v;
  }

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
    this.form.setAttribute("data-sf-active", "1");
    this.fields = [];

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
    /* Dobara attach karne par `name` pehle hi hataya ja chuka hota hai,
           to key id par gir jaati aur mirror galat naam se banta. */
    if (el.getAttribute("data-sf-attached")) return null;
    el.setAttribute("data-sf-attached", "1");

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
    if (spec.numeric) {
      /* type=tel is a semantic autofill target, so it is downgraded
               to text -- inputmode still opens the device number pad. */
      if (el.type === "tel") el.type = "text";
      el.setAttribute("inputmode", "numeric");
      // Older iOS needs pattern="[0-9]*" to show the number pad, but a
      // stricter pattern already on the field is left alone.
      if (!el.getAttribute("pattern")) el.setAttribute("pattern", "[0-9]*");
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
    } else if (f.el.reportValidity) {
      f.el.setCustomValidity(bad.message);
      f.el.reportValidity();
      setTimeout(function () {
        f.el.setCustomValidity("");
      }, 2000);
    } else if (global.Swal) {
      global.Swal.fire({
        icon: "warning",
        title: "जानकारी अधूरी है",
        text: bad.message,
        confirmButtonColor: "#5B3A8E",
      });
    } else {
      alert(bad.message);
    }
    f.el.focus();
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
    this.commit();

    var bad = this.validate();
    if (bad) {
      e.preventDefault();
      this._reportInvalid(bad);
      return false;
    }

    if (
      typeof this.opts.beforeSubmit === "function" &&
      this.opts.beforeSubmit(this.form, this.values()) === false
    ) {
      e.preventDefault();
      return false;
    }

    /* takeover:false -- protect and validate only, then step aside so the
           form's own handler submits it (Contact Form 7, WPForms, Elementor,
           a theme's AJAX, ...). Defaults to true when an endpoint is given. */
    var takeover = this.opts.takeover;
    if (takeover === undefined) takeover = !!this.opts.endpoint;
    if (!takeover) return true;

    e.preventDefault();

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
        /* init() do baar chal jaaye (duplicate script tag, WordPress me
                   snippet dobara load) to dobara attach mat karo. */
        var el =
          typeof opts.form === "string"
            ? document.querySelector(opts.form)
            : opts.form;
        if (el && el.getAttribute("data-sf-active")) return;
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
  };

  global.SecureForm = API;
})(window);
