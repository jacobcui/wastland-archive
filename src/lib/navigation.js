export function goHome() {
  if (window.location.hash === "#/" || window.location.hash === "") return;
  window.location.hash = "#/";
}
