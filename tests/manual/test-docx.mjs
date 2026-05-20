import HTMLtoDOCX from 'html-to-docx';
import fs from 'fs';

const htmlString = `
<p><span style="font-size: 24px;">24px text</span></p>
<p><span style="font-size: 18pt;">18pt text</span></p>
`;

async function main() {
    const fileBuffer = await HTMLtoDOCX(htmlString, null, {});
    fs.writeFileSync('test.docx', fileBuffer);
    console.log("Done");
}
main();
