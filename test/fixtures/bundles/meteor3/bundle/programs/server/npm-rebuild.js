var rebuildArgs = require("./npm-rebuild-args.js").get();
var fs = require("fs");
var rebuilds = JSON.parse(fs.readFileSync(require("path").join(__dirname, "npm-rebuilds.json"), "utf8"));
