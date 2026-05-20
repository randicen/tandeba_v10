import fs from 'fs';
import mammoth from 'mammoth';

async function run() {
    const buf = fs.readFileSync('workspace/Derecho_de_Peticion_EPS_Medicamentos.docx');
    console.log(buf instanceof Buffer);
    const result = await mammoth.convertToHtml({ buffer: buf });
    console.log(result.value.substring(0, 100));
}
run();
