// ============ Ad attribution (UTM + Meta) ============

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_campaign_id",
  "utm_adset",
  "utm_adset_id",
  "utm_ad",
  "utm_ad_id",
  "utm_placement",
];

function setHidden(name, value) {
  const input = document.querySelector('#orderForm input[name="' + name + '"]');
  if (input) input.value = value || "";
}

function readCookie(name) {
  const match = document.cookie.match(
    new RegExp("(^|;\\s*)" + name + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[2]) : "";
}

function stickyValue(key, fromUrl) {
  if (fromUrl) {
    try {
      sessionStorage.setItem(key, fromUrl);
    } catch (e) {
      /* private mode */
    }
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(key) || "";
  } catch (e) {
    return "";
  }
}

function captureUtmParams() {
  const urlParams = new URLSearchParams(window.location.search);

  UTM_KEYS.forEach(function (key) {
    setHidden(key, stickyValue(key, urlParams.get(key)));
  });

  // Meta click ID. Present only on the first landing URL, so persist it.
  const fbclid = stickyValue("fbclid", urlParams.get("fbclid"));
  setHidden("fbclid", fbclid);

  let fbc = readCookie("_fbc");
  if (!fbc && fbclid) {
    const savedFbc = stickyValue("fbc", "");
    fbc =
      savedFbc && savedFbc.endsWith("." + fbclid)
        ? savedFbc
        : stickyValue("fbc", "fb.1." + Date.now() + "." + fbclid);
  }
  setHidden("fbc", fbc);
  setHidden("fbp", readCookie("_fbp"));
}

function newEventId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "evt-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

const orderFormEl = document.getElementById("orderForm");

function updateProgress() {
  ["name", "phone"].forEach(function (id) {
    const input = document.getElementById(id);
    if (input.validity.valid) {
      document.getElementById(id + "Error").classList.remove("show");
    }
  });
}

window.addEventListener("pageshow", function () {
  orderFormEl.reset();
  if (window.SecureForm && SecureForm.instance) SecureForm.instance.reset();
  captureUtmParams();
  updateProgress();
  document.getElementById("loading").classList.remove("show");
  const button = document.getElementById("submitBtn");
  button.style.display = "";
  button.disabled = false;
});
captureUtmParams();

const ENDPOINT =
  "https://script.google.com/macros/s/AKfycbwqSzfvjzPYQtwLBLL8gi4tNx645ledDsd_RpXLTyQb7AWyS4y1pQOf0DejzgddwXvs/exec";

SecureForm.init({
  endpoint: ENDPOINT,
  form: "#orderForm",
  redirect: "./Thankyou.html",
  redirectDelay: 2000,
  loader: "#loading",
  onChange: function () {
    updateProgress();
  },

  beforeSubmit: function () {
    // Re-read attribution in case the page was opened before it was
    // stored, then stamp submission time and a fresh dedupe id.
    captureUtmParams();

    document.getElementById("date").value = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
    document.getElementById("event_id").value = newEventId();
  },

  onSuccess: function () {
    if (window.Swal)
      window.Swal.fire({
        icon: "success",
        title: "Success",
        text: "Processing Your Order. Please wait....",
        confirmButtonColor: "#3085d6",
        confirmButtonText: "OK",
      });
  },

  onError: function (err) {
    console.error("Fetch error:", err);
  },
});

let dotCount = 1;
setInterval(() => {
  const d = document.getElementById("dotAnim");
  if (d) {
    dotCount = (dotCount % 3) + 1;
    d.textContent = ".".repeat(dotCount);
  }
}, 500);
