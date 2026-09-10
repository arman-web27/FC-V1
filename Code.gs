/**
 * Mirgi Mukti — order form → Google Sheet
 *
 * Setup
 * 1. Open the Google Sheet that should collect the leads.
 * 2. Extensions → Apps Script, paste this file in as Code.gs.
 * 3. Deploy → New deployment → type "Web app",
 *    Execute as: Me,  Who has access: Anyone.
 * 4. Copy the /exec URL and put it in index.html inside submitForm().
 *
 * Re-deploy (Deploy → Manage deployments → edit → New version) after any edit,
 * otherwise the live URL keeps serving the old code.
 */

var SHEET_NAME = "Leads";

/* Column order in the sheet. The values here are the exact input `name`
   attributes on the form, plus two we add server side. */
var HEADERS = [
  "Timestamp",
  "date",
  "Name",
  "Mobile",
  "entry_mode",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_campaign_id",
  "utm_adset",
  "utm_adset_id",
  "utm_ad",
  "utm_ad_id",
  "utm_placement",
  "event_id",
  "fbclid",
  "fbc",
  "fbp",
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialise writes so two orders never share a row
  try {
    var data = readParams(e);
    var sheet = getSheet();

    data.Timestamp = new Date();

    if (isDuplicate(sheet, data.event_id)) {
      return json({ result: "duplicate", event_id: data.event_id });
    }

    sheet.appendRow(
      HEADERS.map(function (key) {
        if (data[key] === undefined) return "";
        // Leading apostrophe keeps the sheet from reformatting the number.
        if (key === "Mobile") return "'" + data[key];
        return data[key];
      }),
    );

    return json({ result: "success", row: sheet.getLastRow() });
  } catch (err) {
    return json({ result: "error", message: err.message });
  } finally {
    lock.releaseLock();
  }
}

/** Lets you sanity-check the deployment in a browser. */
function doGet() {
  return json({ result: "ok", message: "Mirgi Mukti lead endpoint is live" });
}

/* ---------- helpers ---------- */

/** The page posts a FormData object, but accept raw JSON too. */
function readParams(e) {
  var out = {};
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (key) {
      out[key] = e.parameter[key];
    });
  }
  if (e && e.postData && e.postData.type === "application/json") {
    try {
      var body = JSON.parse(e.postData.contents);
      Object.keys(body).forEach(function (key) {
        out[key] = body[key];
      });
    } catch (ignore) {}
  }
  return out;
}

/** Returns the sheet, creating it with a header row on first run. */
function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** The form stamps a fresh event_id per submit, so a repeat means a retry. */
function isDuplicate(sheet, eventId) {
  if (!eventId) return false;
  var col = HEADERS.indexOf("event_id") + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][0] === eventId) return true;
  }
  return false;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
