// Makes the site installable as a phone/desktop app.
// Service workers only run on https or localhost; on a plain http Wi-Fi
// address phones can still "Add to Home Screen", just without offline use.

if ("serviceWorker" in navigator && window.isSecureContext && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Chrome/Edge/Android fire this when the app can be installed with one tap.
// Pages show their install button when window.installApp is set.
window.installApp = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.installApp = async () => {
    e.prompt();
    await e.userChoice;
    window.installApp = null;
    document.dispatchEvent(new Event("installchange"));
  };
  document.dispatchEvent(new Event("installchange"));
});

const isInstalledApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
