(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  // Run only inside the packaged Capacitor WebView. The normal Render website
  // remains the source and is not redirected back to itself.
  var host = window.location.hostname;
  var isCapacitorWebView =
    host === "localhost" ||
    window.location.protocol === "capacitor:";

  if (!isCapacitorWebView) return;

  var remotePath = script.getAttribute("data-remote-path") || "/";
  var remoteUrl = "https://meshwari.onrender.com" +
    (remotePath.charAt(0) === "/" ? remotePath : "/" + remotePath);

  var controller = new AbortController();
  var timeout = window.setTimeout(function () {
    controller.abort();
  }, 12000);

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

    // Reject incomplete/error responses. The APK's bundled page remains
    // untouched and is used automatically if any check fails.
    if (typeof html !== "string" ||
        html.length < 2000 ||
        html.length > 5 * 1024 * 1024 ||
        !/<html[\s>]/i.test(html) ||
        !/<body[\s>]/i.test(html) ||
        !/<\/html>/i.test(html) ||
        !/مشواري/i.test(html)) {
      throw new Error("Remote page failed validation");
    }

    // Do not run this bootstrap again after replacing the local document.
    html = html.replace(
      /<script\b(?=[^>]*\bsrc=["']\/meshwari-remote-loader\.js["'])[^>]*>\s*<\/script>/gi,
      ""
    );

    // Keep API calls pointed at the production API even though the WebView
    // document itself retains the local Capacitor origin.
    html = html.replace(
      /location\.origin\s*\+\s*(["'])\/api\1/g,
      "'https://meshwari.onrender.com/api'"
    );

    // Resolve all relative styles, scripts, images, and navigation against
    // the trusted production origin.
    html = html.replace(
      /<head\b[^>]*>/i,
      function (head) {
        return head + '\n<base href="https://meshwari.onrender.com/">\n';
      }
    );

    document.open();
    document.write(html);
    document.close();
  }).catch(function () {
    // Offline, timeout, invalid response, or server error:
    // keep running the bundled local application.
    window.clearTimeout(timeout);
  });
})();
