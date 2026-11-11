const panel = document.getElementById("startup");
if (panel) {
  const title = document.getElementById("startup-title");
  const message = document.getElementById("startup-message");
  const spinner = document.getElementById("startup-spinner");
  const retry = document.getElementById("startup-retry");
  const failed = () => {
    title.textContent =
      navigator.onLine === false ? "You're offline" : "Can't open Pi Remote";
    message.textContent =
      "Check your internet and Tailscale connection, then try again.";
    spinner.hidden = true;
    retry.hidden = false;
  };
  const deadline = setTimeout(failed, 8000);
  const moduleFailed = (event) => {
    if (event.target instanceof HTMLScriptElement) failed();
  };
  retry.addEventListener("click", () => location.reload());
  window.addEventListener("offline", failed);
  window.addEventListener("error", moduleFailed, true);
  const observer = new MutationObserver(() => {
    if (panel.isConnected) return;
    clearTimeout(deadline);
    window.removeEventListener("offline", failed);
    window.removeEventListener("error", moduleFailed, true);
    observer.disconnect();
  });
  observer.observe(document.getElementById("app"), { childList: true });
  if (navigator.onLine === false) failed();
}
