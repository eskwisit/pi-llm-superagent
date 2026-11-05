"use strict";

// Entry point for `node --test tests/`.
// Node 22+ resolves a directory argument like a module path and loads this file, which pulls in
// every *.test.js next to it. Node 20 searches the directory for test files itself and skips this
// file (its name matches no test pattern). `node --test tests/*.test.js` works on every version.

const fs = require("node:fs");
const path = require("node:path");

for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort()) {
  require(path.join(__dirname, file));
}
