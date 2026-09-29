const fs = require('fs');
const path = require('path');

const file = path.join('g:', 'WECRYP', 'src', 'kalshi', 'prediction-markets.js');
let code = fs.readFileSync(file, 'utf8');

const badStartStr = `    });\r
        incomplete: Boolean(data?.incomplete),\r
        cached: Boolean(data?.cached),\r
      };\r
      _poly5mCryptoPriceCache[cacheKey] = { value, fetchedAt: Date.now() };\r
      return value;\r
    } catch (err) {`;

const badEndStr = `        socket.onclose = () => {\r
          clearTimeout(timerId);\r
          finish(null);\r
        };\r
      } catch (_) {\r
        clearTimeout(timerId);\r
        finish(null);\r
      }\r
    });\r
  }`;

// Try to normalize newlines to \n to be safe
let normalizedCode = code.replace(/\r\n/g, '\n');
let normalizedStart = badStartStr.replace(/\r\n/g, '\n');
let normalizedEnd = badEndStr.replace(/\r\n/g, '\n');

const startIndex = normalizedCode.indexOf(normalizedStart);
if (startIndex === -1) {
  console.error("Could not find start index");
  process.exit(1);
}

// Find the end string AFTER the start index
const endIndexPos = normalizedCode.indexOf(normalizedEnd, startIndex);
if (endIndexPos === -1) {
  console.error("Could not find end index");
  process.exit(1);
}

const finalEndIndex = endIndexPos + normalizedEnd.length;

const newCode = normalizedCode.substring(0, startIndex + 8) + "\n" + normalizedCode.substring(finalEndIndex);

fs.writeFileSync(file, newCode, 'utf8');
console.log("Fixed prediction-markets.js successfully.");
