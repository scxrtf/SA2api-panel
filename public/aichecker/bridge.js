// hlwy-ai-checker x wb2api panel bridge:
// The checker page runs inside a same-origin iframe in the panel. The panel
// API key never touches localStorage or page inputs; the parent injects it
// into requests to the panel proxy API via this fetch interceptor.
(function () {
  let key = "";
  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (d && d.type === "wb2a-auth") key = typeof d.key === "string" ? d.key : "";
  });
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "aichecker-ready" }, window.location.origin);
  }
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/panel/aichecker/") === 0) {
      init = init || {};
      const h = new Headers(init.headers || (typeof input === "object" && input ? input.headers : undefined));
      if (key && !h.has("Authorization")) h.set("Authorization", "Bearer " + key);
      init.headers = h;
    }
    return origFetch(input, init);
  };
})();