const fs = require("fs");
const path = "G:/WECRYP/src/core/app.js";
let content = fs.readFileSync(path, "utf8");

const startTag = "async function renderCFM() {";
const startIdx = content.indexOf(startTag);
if (startIdx === -1) { console.log("Not found"); process.exit(1); }

// Find the end of the function by counting braces
let openBraces = 0;
let endIdx = -1;
for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') openBraces++;
    if (content[i] ==