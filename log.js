/*
 * LazyEditMirror - in-panel log.
 *
 * Without the UXP Developer Tool there is no console to read, so every step
 * is written into a read-only <textarea> in the panel that the user can copy.
 * Entries are kept in memory too, so "Copy log" always has the full text.
 */
"use strict";

function createLog(textarea) {
  const lines = [];
  const MAX_LINES = 2000;

  function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function render() {
    if (!textarea) return;
    textarea.value = lines.join("\n");
    /* Keep the newest line in view. */
    try {
      textarea.scrollTop = textarea.scrollHeight;
    } catch (e) {
      /* Not every UXP build exposes scroll properties on textareas. */
    }
  }

  function write(level, message) {
    const text = "[" + stamp() + "] " + (level ? level + " " : "") + String(message);
    lines.push(text);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    render();
    try {
      if (level === "ERROR") console.error(text);
      else if (level === "WARN") console.warn(text);
      else console.log(text);
    } catch (e) {
      /* console may be unavailable; the textarea is the primary channel. */
    }
  }

  return {
    info: (m) => write("", m),
    warn: (m) => write("WARN", m),
    error: (m) => write("ERROR", m),
    step: (m) => write("->", m),
    clear: () => {
      lines.length = 0;
      render();
    },
    text: () => lines.join("\n"),
  };
}

module.exports = { createLog: createLog };
