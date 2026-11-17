export const MAX_TEXT_CHARACTERS=1_000_000;
export function splitText(text,{size=512,overlap=80}={}){
 text=String(text||'');if(text.length>MAX_TEXT_CHARACTERS)throw Error('文本超过100万字符，请拆成多个文件或消息');
 size=Math.max(32,Math.floor(size));overlap=Math.max(0,Math.min(Math.floor(overlap),Math.floor(size/3)));const parts=[];
 for(let start=0;start<text.length;){let end=Math.min(text.length,start+size);if(end<text.length){const lower=start+Math.floor(size*.65),last=Math.max(text.lastIndexOf('\n',end-1),text.lastIndexOf('。',end-1));if(last>=lower)end=last+1;if(/[\uD800-\uDBFF]/.test(text[end-1]))end--;}
  parts.push({start,end,text:text.slice(start,end)});if(end===text.length)break;start=end-overlap;if(/[\uDC00-\uDFFF]/.test(text[start]))start--;}
 return parts;
}
export function extractionParts(text,context=4096){const output=Math.min(1400,Math.floor(context*.35)),size=Math.max(128,Math.min(1200,Math.floor((context-output-700)/1.5)));return splitText(text,{size,overlap:Math.min(160,Math.floor(size/5))});}
export function queryText(text){text=String(text||'');return text.length<=2000?text:text.slice(0,300)+'\n'+text.slice(-1600);}
export function meanEmbedding(items){if(!items.length)return null;const {model,vector}=items[0];if(items.some(e=>e.model!==model||e.vector.length!==vector.length))throw Error('分块向量版本不一致');const sum=Array(vector.length).fill(0);for(const e of items)e.vector.forEach((v,i)=>sum[i]+=v/items.length);const norm=Math.sqrt(sum.reduce((n,x)=>n+x*x,0))||1;return {model,vector:sum.map(x=>x/norm)};}
