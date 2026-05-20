import HTMLtoDOCX from 'html-to-docx';
import fs from 'fs';
import AdmZip from 'adm-zip';

const htmlString = `
<div style="text-align: left;">
<p style="text-align: center;">Center one</p>
<p><s>Strike one</s></p>
<p><strike>Strike two</strike></p>
<p><del>Strike three</del></p>
</div>
`;

async function main() {
    const fileBuffer = await HTMLtoDOCX(htmlString, null, {});
    fs.writeFileSync('test-strike-align.docx', fileBuffer);
    
    const zip = new AdmZip('test-strike-align.docx');
    const entries = zip.getEntries();
    const docXml = entries.find(e => e.entryName === 'word/document.xml');
    console.log(docXml.getData().toString('utf8'));
}
main();
