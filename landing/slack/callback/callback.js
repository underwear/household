(() => {
  const params = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  const status = document.getElementById("status");
  const result = document.getElementById("result");
  const copy = document.getElementById("copy");
  const code = params.get("code"), state = params.get("state");
  if (params.has("error")) {
    status.textContent = "Slack access was not authorized. Return to Household and start again.";
    return;
  }
  if (params.getAll("code").length !== 1 || params.getAll("state").length !== 1 || !code || code.length > 4096 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    status.textContent = "There is no valid connection result on this page. Start Slack sign-in from your Household dashboard.";
    return;
  }
  const payload = new URL("https://agents-household.dev/slack/callback/");
  payload.search = new URLSearchParams({ code, state }).toString();
  result.value = payload.href;
  result.hidden = false;
  copy.hidden = false;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(result.value);
      status.textContent = "Copied. Return to Household and paste into “Connection result”, then connect.";
      copy.textContent = "Copy again";
    } catch {
      result.focus(); result.select();
      status.textContent = "Select and copy the connection result above, then paste it into Household.";
    }
  });
})();
