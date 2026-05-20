import HTMLtoDOCX from 'html-to-docx';
import fs from 'fs';
import AdmZip from 'adm-zip';

const htmlString = `
<p><strike>Strike text tag</strike></p>
<p><del>Del text tag</del></p>
<p><u>Underline text tag</u></p>
<p><b>Bold</b></p>
<p><i>Italic</i></p>
`;

async function main() {
    const fileBuffer = await HTMLtoDOCX(htmlString, null, {});
    fs.writeFileSync('test3.docx', fileBuffer);
    
    const zip = new AdmZip('test3.docx');
    const entries = zip.getEntries();
    const docXml = entries.find(e => e.entryName === 'word/document.xml');
    console.log(docXml.getData().toString('utf8'));
}
main();
