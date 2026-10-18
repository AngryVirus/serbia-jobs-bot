// Node's standard AES-256-GCM; authenticated metadata and per-file random salt/nonce.
import { readFileSync } from 'node:fs';
import { randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
const magic=Buffer.from('SJCBK001');
try {
 const token=process.env.TGCLOUD_TOKEN;
 if(!/^app8802394224:[A-Za-z0-9_-]+$/.test(token||''))throw Error();
 const input=readFileSync(0),decrypt=process.argv[2]==='decrypt';
 const salt=decrypt?input.subarray(8,40):randomBytes(32),nonce=decrypt?input.subarray(40,52):randomBytes(12);
 if(decrypt && (input.length<68 || !input.subarray(0,8).equals(magic)))throw Error();
 const header=Buffer.concat([magic,salt,nonce]);
 const key=hkdfSync('sha256',Buffer.from(token),salt,Buffer.from('SerbiaJobsBot backup v1'),32);
 if(decrypt) {
  const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(header);cipher.setAuthTag(input.subarray(52,68));
  const clear=Buffer.concat([cipher.update(input.subarray(68)),cipher.final()]);
  process.stdout.write(clear);
 } else {
  if(process.argv[2]!=='encrypt')throw Error();
  const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(header);
  const encrypted=Buffer.concat([cipher.update(input),cipher.final()]);
  process.stdout.write(Buffer.concat([header,cipher.getAuthTag(),encrypted]));
 }
} catch {process.stderr.write('Backup cryptography failed; private details withheld\n');process.exitCode=1;}
