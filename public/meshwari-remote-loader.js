(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  // Run only inside the packaged Capacitor WebView. The Render website itself
  // stays unchanged and remains the authoritative source of the UI.
  var host = window.location.hostname;
  var isCapacitorWebView =
    host === "localhost" ||
    window.location.protocol === "capacitor:";
  if (!isCapacitorWebView) return;

  var remotePath = script.getAttribute("data-remote-path") || "/";
  var remoteUrl = "https://meshwari.onrender.com" +
    (remotePath.charAt(0) === "/" ? remotePath : "/" + remotePath);
  var cacheKey = "meshwari.remote.ui.v1:" + remotePath;
  var controller = new AbortController();
  var timeout = window.setTimeout(function () {
    controller.abort();
  }, 12000);

  function prepare(html) {
    if (typeof html !== "string" ||
        html.length < 2000 ||
        html.length > 5 * 1024 * 1024 ||
        !/<html[\s>]/i.test(html) ||
        !/<body[\s>]/i.test(html) ||
        !/<\/html>/i.test(html) ||
        !/مشواري/i.test(html)) {
      throw new Error("Remote page failed validation");
    }

    // Prevent the remote copy from starting another remote-load cycle.
    html = html.replace(
      /<script\b(?=[^>]*\bsrc=["']\/meshwari-remote-loader\.js["'])[^>]*>\s*<\/script>/gi,
      ""
    );

    // Keep API calls directed at the production API from the local WebView.
    html = html.replace(
      /location\.origin\s*\+\s*(["'])\/api\1/g,
      "'https://meshwari.onrender.com/api'"
    );

    // Resolve relative page assets against the production web origin.
    html = html.replace(
      /<head\b[^>]*>/i,
      function (head) {
        return head + '\n<base href="https://meshwari.onrender.com/">\n';
      }
    );
    return html;
  }

  function show(html) {
    document.open();
    document.write(html);
    document.close();
  }

  fetch(remoteUrl, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "follow",
    signal: controller.signal,
    headers: { "Accept": "text/html" }
  }).then(function (response) {
    if (!response.ok) throw new Error("Remote page unavailable");
    var type = response.headers.get("content-type") || "";
    if (!/text\/html/i.test(type)) throw new Error("Unexpected page type");
    return response.text();
  }).then(function (html) {
    window.clearTimeout(timeout);
    var ready = prepare(html);

    // Store only after the response passes validation. If storage is full or
    // unavailable, the live update still works and the bundled APK remains.
    try { window.localStorage.setItem(cacheKey, ready); } catch (_) {}
    show(ready);
  }).catch(function () {
    window.clearTimeout(timeout);

    // Offline fallback order: last validated remote page, then the untouched
    // page bundled inside the APK.
    try {
      var saved = window.localStorage.getItem(cacheKey);
      if (saved) {
        show(saved);
        return;
      }
    } catch (_) {}
  });
})();
