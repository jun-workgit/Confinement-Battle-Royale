// Paste this into the Apps Script project bound to the spreadsheet
// (Extensions > Apps Script), replacing/adding a doGet function, then
// redeploy (Deploy > Manage deployments > edit the existing deployment >
// select "New version") so the /exec URL picks up the change.
//
// Reads the "API" sheet tab and returns JSON for every "PlayerN" column:
// { players: [ { id, strength, speed, capacity, endRoom }, ... ] }
// Only Strength/Speed/Capacity/End Room are exposed, matching what the
// admin import button in the game app consumes.

function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("API");
  if (!sheet) {
    return jsonResponse({ error: "API sheet not found" });
  }

  var values = sheet.getDataRange().getValues();

  // Row layout is found by label in column A rather than a fixed row
  // index, so reordering rows in the sheet doesn't break this.
  var rowsByLabel = {};
  var headerRow = values[0] || [];
  for (var r = 0; r < values.length; r++) {
    var label = String(values[r][0] || "").trim();
    if (label) rowsByLabel[label] = values[r];
  }

  var strengthRow = rowsByLabel["Strength"] || [];
  var speedRow = rowsByLabel["Speed"] || [];
  var capacityRow = rowsByLabel["Capacity"] || [];
  var endRoomRow = rowsByLabel["End Room"] || [];

  var players = [];
  for (var c = 0; c < headerRow.length; c++) {
    var header = String(headerRow[c] || "").trim();
    var m = header.match(/^Player(\d+)$/i);
    if (!m) continue;

    players.push({
      id: parseInt(m[1], 10),
      strength: cleanNumber(strengthRow[c]),
      speed: cleanNumber(speedRow[c]),
      capacity: cleanNumber(capacityRow[c]),
      endRoom: cleanString(endRoomRow[c]),
    });
  }

  return jsonResponse({ players: players });
}

// Formula-error cells (#REF!, #N/A, etc.) come through as strings starting
// with "#" — treat those, and blanks, as "no data" rather than a value.
function cleanNumber(v) {
  if (typeof v === "string" && v.indexOf("#") === 0) return null;
  if (v === "" || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function cleanString(v) {
  if (typeof v === "string" && v.indexOf("#") === 0) return null;
  var s = String(v == null ? "" : v).trim();
  return s ? s : null;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
