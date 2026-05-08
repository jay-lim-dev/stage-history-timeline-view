ZOHO.embeddedApp.on("PageLoad", function (data) {
  var entityId = data.EntityId;

  // TODO: fetch stage history for entityId
  // ZOHO.CRM.API.getRecord({ Entity: "Deals", RecordID: entityId })
  //   .then(renderTimeline)
  //   .catch(showError);

  showState("state-loading");
});

ZOHO.embeddedApp.init();

function showState(id) {
  ["state-loading", "state-error", "state-empty", "state-timeline"].forEach(function (s) {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

function showError() {
  showState("state-error");
}
