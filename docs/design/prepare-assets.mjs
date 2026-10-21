import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const require=createRequire(path.join(repo,'app/package.json'));
const sharp=require('sharp');
await mkdir(path.join(here,'assets'),{recursive:true});
for(let i=1;i<=10;i++){
 const name=`studio-${String(i).padStart(2,'0')}.jpg`;
 await sharp(path.join(repo,'app/assets/inspiration',name)).rotate().resize({width:720,withoutEnlargement:true}).jpeg({quality:76,mozjpeg:true}).toFile(path.join(here,'assets',name));
 const {size}=await stat(path.join(here,'assets',name));
 if(size>200000)throw new Error(`${name} exceeds 200 KB`);
 console.log(`${name}: ${size} bytes`);
}
