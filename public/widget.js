/*
 * Embeddable chat widget.
 * Usage: <script src="https://YOUR-APP/widget.js" data-agent-id="AGENT_ID" defer></script>
 * Optional attributes: data-position="left|right", data-color="#4f46e5"
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var agentId = script.getAttribute("data-agent-id");
  if (!agentId || document.getElementById("cbi-widget-root")) return;

  var origin;
  try { origin = new URL(script.src).origin; } catch (e) { return; }
  var left = script.getAttribute("data-position") === "left";
  var color = script.getAttribute("data-color") || "#4f46e5";

  function build(c) {
    var root = document.createElement("div");
    root.id = "cbi-widget-root";
    root.style.cssText = "position:fixed;bottom:20px;" + (left ? "left" : "right") + ":20px;z-index:2147483000;font-family:system-ui,sans-serif;";

    var frameBox = document.createElement("div");
    frameBox.style.cssText =
      "display:none;position:absolute;bottom:72px;" + (left ? "left" : "right") + ":0;" +
      "width:380px;height:600px;max-height:calc(100vh - 110px);max-width:calc(100vw - 40px);" +
      "border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff;";
    var frame = document.createElement("iframe");
    frame.title = "Chat";
    frame.setAttribute("loading", "lazy");
    // The chat page checks which website embeds it (an agent can be limited to its owner's websites).
    frame.referrerPolicy = "origin";
    frame.style.cssText = "width:100%;height:100%;border:0;";
    frameBox.appendChild(frame);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Open chat");
    btn.style.cssText =
      "width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#fff;font-size:26px;line-height:1;" +
      "box-shadow:0 6px 20px rgba(0,0,0,.25);background:" + c + ";";
    btn.textContent = "💬";

    var open = false;
    btn.addEventListener("click", function () {
      open = !open;
      if (open && !frame.src) frame.src = origin + "/embed/" + encodeURIComponent(agentId);
      frameBox.style.display = open ? "block" : "none";
      btn.textContent = open ? "✕" : "💬";
      btn.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    });

    root.appendChild(frameBox);
    root.appendChild(btn);
    document.body.appendChild(root);
  }

  // Use the agent's saved brand colour when we can fetch it; fall back to data-color / default.
  fetch(origin + "/api/public/agents/" + encodeURIComponent(agentId))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (cfg && cfg.allowed === false) return; // this website isn't on the agent's allowed list
      build((cfg && cfg.brandColor) || color);
    })
    .catch(function () { build(color); });
})();
