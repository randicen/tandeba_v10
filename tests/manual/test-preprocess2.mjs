import { preprocessHtmlForDocx } from './server.ts';

const inputHtml = `<span style="background-color: yellow;">Yellow background</span>
<span style="color: rgb(37, 99, 235);">RGB Blue text</span>
<font color="#2563eb">Hex font</font>
<span style="color: yellow;">yellow text</span>
<div style="background-color: #ffff00">div yellow bg</div>
<p style="background-color: rgb(255, 255, 0);">p rgb yellow bg</p>
<p style="background-color: yellow;">p yellow bg</p>
<span style="text-decoration: line-through;">strike from text decoration</span>
<s>strike s</s>
<strike>strike strike</strike>
<del>strike del</del>
<p style="text-align: right;">aligned right</p>
<div style="text-align: center;">aligned center</div>
<p style="text-align: justify">aligned justify</p>
`;

preprocessHtmlForDocx(inputHtml).then(console.log);
