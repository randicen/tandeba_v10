import AdmZip from 'adm-zip';

const zip = new AdmZip('test.docx');
const entries = zip.getEntries();
const docXml = entries.find(e => e.entryName === 'word/document.xml');
console.log(docXml.getData().toString('utf8'));
