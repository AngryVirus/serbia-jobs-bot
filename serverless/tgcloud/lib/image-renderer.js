// Pure JavaScript PNG renderer: no network, DOM, Node, Canvas, or runtime packages.
import { zlibSync, unzlibSync } from './image-codec.js';
import { HEADER } from './image-header.js';
import { FONTS, FONT_DATA } from './image-fonts.js';
export const IMAGE_VERSION='belgrade-v1';
const W=960, BG=[251,246,236], INK=[22,45,67], MUTED=[100,117,129], BLUE=[44,106,160];
export function fromBase64(value) {
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',out=[];let bits=0,n=0;
 for(const c of value){const v=alphabet.indexOf(c);if(v<0)continue;bits=(bits<<6)|v;n+=6;if(n>=8){n-=8;out.push((bits>>>n)&255);}}
 return new Uint8Array(out);
}
let fontPixels,headerPixels;
const assets=()=>{fontPixels ||= unzlibSync(fromBase64(FONT_DATA));headerPixels ||= unzlibSync(fromBase64(HEADER.indexed));};
const utf8=s=>{const out=[];for(const c of s){const n=c.codePointAt(0);if(n<128)out.push(n);else if(n<2048)out.push(192|(n>>6),128|(n&63));else if(n<65536)out.push(224|(n>>12),128|((n>>6)&63),128|(n&63));else out.push(240|(n>>18),128|((n>>12)&63),128|((n>>6)&63),128|(n&63));}return out;};
// SHA-256 avoids storing a user's rendered text in a cache key.
export function imageHash(text) {
 const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
 const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],data=utf8(text),length=data.length*8;data.push(128);while(data.length%64!==56)data.push(0);for(let i=7;i>=0;i--)data.push(i<4?(length>>>8*i)&255:0);
 const r=(x,n)=>(x>>>n)|(x<<(32-n)),w=new Int32Array(64);
 for(let offset=0;offset<data.length;offset+=64){for(let i=0;i<16;i++)w[i]=(data[offset+4*i]<<24)|(data[offset+4*i+1]<<16)|(data[offset+4*i+2]<<8)|data[offset+4*i+3];for(let i=16;i<64;i++)w[i]=(w[i-16]+(r(w[i-15],7)^r(w[i-15],18)^(w[i-15]>>>3))+w[i-7]+(r(w[i-2],17)^r(w[i-2],19)^(w[i-2]>>>10)))|0;
  let [a,b,c,d,e,f,g,z]=h;for(let i=0;i<64;i++){const t=(z+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0,u=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))|0;z=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+u)|0;}[a,b,c,d,e,f,g,z].forEach((v,i)=>h[i]=(h[i]+v)|0);
 }return h.map(v=>(v>>>0).toString(16).padStart(8,'0')).join('');
}
const decode=s=>s.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>=0&&c<=0x10ffff?String.fromCodePoint(c):'□';}).replace(/&(lt|gt|amp|quot|apos|#x27);/g,(_,n)=>({lt:'<',gt:'>',amp:'&',quot:'"',apos:"'",'#x27':"'"})[n]);
export function imageDocument(html) {
 const lines=String(html).replace(/<\/?blockquote>/g,'\n').split('\n').map(s=>({bold:/<b>/.test(s),text:decode(s.replace(/<[^>]*>/g,'')).replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu,'').normalize('NFC').trim()}));
 while(lines.length&&!lines[0].text)lines.shift();
 const title=lines.shift()?.text || 'Работа в Сербии';while(lines.length&&!lines[0].text)lines.shift();
 return {title,lines};
}
const glyph=(c,face)=>FONTS[face].glyphs[c.codePointAt(0)] || FONTS[face].glyphs['9633'];
const width=(s,face)=>[...s].reduce((n,c)=>n+glyph(c,face)[4],0);
function wrap(text,face,max) {
 if(!text)return [''];let lines=[],line='';for(const word of text.split(/\s+/)){let next=line?line+' '+word:word;if(width(next,face)<=max){line=next;continue;}if(line){lines.push(line);line='';}for(const c of word){if(line&&width(line+c,face)>max){lines.push(line);line='';}line+=c;}}
 if(line)lines.push(line);return lines;
}
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const u32=n=>new Uint8Array([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255]);
const concat=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
function chunk(type,data){const name=new Uint8Array([...type].map(c=>c.charCodeAt(0))),body=concat([name,data]);let crc=0xffffffff;for(const n of body)crc=crcTable[(crc^n)&255]^(crc>>>8);return concat([u32(data.length),body,u32((crc^0xffffffff)>>>0)]);}
function png(rgb,height){const stride=W*3,scan=new Uint8Array((stride+1)*height);for(let y=0;y<height;y++){const start=y*(stride+1);scan[start]=1;for(let x=0;x<stride;x++)scan[start+1+x]=(rgb[y*stride+x]-(x>=3?rgb[y*stride+x-3]:0)+256)&255;}
 return concat([new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',concat([u32(W),u32(height),new Uint8Array([8,2,0,0,0])])),chunk('IDAT',zlibSync(scan,{level:3})),chunk('IEND',new Uint8Array())]);}
export function renderImage(html) {
 assets();const doc=imageDocument(html),layout=[];let y=348;
 const titles=wrap(doc.title,'title',W-112);for(const line of titles){layout.push({text:line,face:'title',x:56,y,color:INK});y+=58;}
 y+=12;const ruleY=y;y+=30;
 const take=(text,max)=>{let count=0,n=0,lastSpace=-1;for(const c of text){const next=width(c,'body');if(n+next>max)break;n+=next;count+=c.length;if(c===' ')lastSpace=count;}if(count<text.length && lastSpace>0)count=lastSpace;return [text.slice(0,count).trim(),text.slice(count).trim()];};
 for(const line of doc.lines){
  if(!line.text){y+=20;continue;}
  const colon=line.text.indexOf(':');
  if(line.bold && colon>0 && width(line.text.slice(0,colon+1),'bold')<W-300){
   const label=line.text.slice(0,colon+1),x=68+width(label,'bold')+12;
   let [first,rest]=take(line.text.slice(colon+1).trim(),W-68-x);
   layout.push({text:label,face:'bold',x:68,y,color:INK});layout.push({text:first,face:'body',x,y:y+2,color:INK});y+=48;
   while(rest){const [part,tail]=take(rest,W-136);layout.push({text:part,face:'body',x:68,y,color:INK});y+=48;rest=tail;}
  }else{const face=line.bold?'bold':'body';for(const text of wrap(line.text,face,W-136)){layout.push({text,face,x:68,y,color:line.bold?INK:MUTED});y+=48;}}
  y+=10;
 }
 const height=Math.max(660,y+64);if(height>8500)throw Error('Image panel exceeds safe height');
 const rgb=new Uint8Array(W*height*3);for(let p=0;p<rgb.length;p+=3)rgb.set(BG,p);
 const pixel=(x,y,c,alpha=255)=>{x=Math.round(x);y=Math.round(y);if(x<0||y<0||x>=W||y>=height)return;const p=(y*W+x)*3;for(let k=0;k<3;k++)rgb[p+k]=Math.round((c[k]*alpha+rgb[p+k]*(255-alpha))/255);};
 const rect=(x,y,w,h,c)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)pixel(xx,yy,c);};
 for(let p=0;p<headerPixels.length;p++){const i=headerPixels[p]*3;rgb.set(HEADER.palette.slice(i,i+3),p*3);}
 rect(56,ruleY,100,4,[184,51,63]);rect(156,ruleY,100,4,BLUE);rect(256,ruleY,W-312,2,[226,219,207]);
 for(const line of layout){let x=line.x;const check=line.text.startsWith('✓') || line.text.startsWith('Выбрано:');if(check)rect(48,line.y-2,W-96,50,[225,237,242]);for(const c of line.text){const [w,h,left,top,advance,offset]=glyph(c,line.face);for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){const a=fontPixels[offset+yy*w+xx];if(a)pixel(x+left+xx,line.y+top+yy,line.color,a);}x+=advance;}}
 return {bytes:png(rgb,height),width:W,height,title:doc.title};
}
