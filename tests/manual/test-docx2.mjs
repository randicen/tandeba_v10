import HTMLtoDOCX from 'html-to-docx';
import fs from 'fs';
import AdmZip from 'adm-zip';

const htmlString = `
<p style="text-align: center;">Centered</p>
<p style="text-align: right;">Right</p>
<p style="text-align: justify;">Justified</p>
<p><s>Strike text</s></p>
<p><span style="text-decoration: line-through;">text-decoration strike</span></p>
`;

async function main() {
    const fileBuffer = await HTMLtoDOCX(htmlString, null, {});
    fs.writeFileSync('test2.docx', fileBuffer);
    
    const zip = new AdmZip('test2.docx');
    const entries = zip.getEntries();
    const docXml = entries.find(e => e.entryName === 'word/document.xml');
    console.log(docXml.getData().toString('utf8'));
}
main();
