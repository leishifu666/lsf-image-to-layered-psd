import {readFile,writeFile} from 'node:fs/promises';
const composition=await readFile(new URL('./composition.html',import.meta.url),'utf8');
const css=composition.match(/<style>\n([\s\S]*?)\n<\/style>/)[1];
const markup=composition.match(/<section[\s\S]*?<\/section>/)[0];
const template=await readFile(new URL('./element-template.js',import.meta.url),'utf8');
await writeFile(new URL('./component.js',import.meta.url),template.replace('__MARKUP_JSON__',()=>JSON.stringify(markup)).replace('__CSS_JSON__',()=>JSON.stringify(css)));
console.log('Built A exploded layer cover');
