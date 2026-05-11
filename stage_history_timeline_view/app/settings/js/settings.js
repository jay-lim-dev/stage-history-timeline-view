ZOHO.embeddedApp.on("PageLoad", function () {
  // TODO: load saved settings via ZOHO.CRM.API or a custom variable
  showState("state-form");
});

ZOHO.embeddedApp.init();

document.getElementById("settings-form").addEventListener("submit", function (e) {
  e.preventDefault();
  // TODO: persist settings
  showFeedback("Settings saved.", "success");
});

function showState(id) {
  ["state-loading", "state-form"].forEach(function (s) {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

function showFeedback(msg, type) {
  var el = document.getElementById("save-feedback");
  el.textContent = msg;
  el.className = "feedback " + type;
}
