import fs from 'fs';

const file = fs.readFileSync('node_modules/html-to-docx/dist/html-to-docx.cjs.js', 'utf8');
const iSt = file.indexOf('text-decoration');
console.log(file.substring(iSt - 100, iSt + 100));

const delSt = file.indexOf('del');
console.log(file.substring(delSt - 100, delSt + 100));

const strikeSt = file.indexOf('strike');
console.log(file.substring(strikeSt - 100, strikeSt + 100));
