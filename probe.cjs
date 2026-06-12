const c = require('fs').readFileSync('C:\\Users\\acer\\Downloads\\asistente IA\\untitled\\src\\agent\\workflow-engine\\executor\\executor.ts','utf8');
// Find "executeWithTimeoutAndRetry(" and look for the method body
const idx = c.indexOf('private async executeWithTimeoutAndRetry');
console.log(c.slice(idx, idx + 4000));
