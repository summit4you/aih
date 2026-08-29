/* AIH docs — mobile nav toggle */
(function () {
  var btn = document.getElementById("navToggle");
  var scrim = document.getElementById("scrim");
  if (!btn) return;
  function set(open) {
    document.body.classList.toggle("nav-open", open);
    btn.setAttribute("aria-expanded", String(open));
  }
  btn.addEventListener("click", function () {
    set(!document.body.classList.contains("nav-open"));
  });
  scrim.addEventListener("click", function () { set(false); });
  // close nav after choosing a page (mobile)
  var sidebar = document.getElementById("sidebar");
  if (sidebar) {
    sidebar.addEventListener("click", function (e) {
      if (e.target && e.target.tagName === "A") set(false);
    });
  }
})();
