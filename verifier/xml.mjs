// Strict, namespace-aware reader for delivered XML. The acceptance checks must read exactly the document that KoSIT
// and the recipient's ERP read: comments and processing instructions are skipped, CDATA is text, prefixes are resolved
// to namespace URIs. DOCTYPE (entity declarations) and encodings other than UTF-8 are refused, so no other parser can
// read a different document. Just enough XML 1.0 for UBL; anything else throws (German message, shown to the user).
// Element: {ns, name, attrs: Map(name or {ns}name -> value), children: [Element], text}.
const ENTITIES={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};
const NAME=/[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/y;
const SPACE=/[ \t\r\n]*/y;
const VALUE=/"([^<"]*)"|'([^<']*)'/y;
const XML_NS='http://www.w3.org/XML/1998/namespace';
const fail=message=>{throw new Error(message);};

const decode=s=>s.replace(/&(#?\w{1,8});|&/g,(m,ref)=>{
 if(ref==null)fail('„&“ ohne Entität');
 if(ENTITIES[ref])return ENTITIES[ref];
 const cp=/^#x[0-9A-Fa-f]+$/.test(ref)?parseInt(ref.slice(2),16):/^#\d+$/.test(ref)?Number(ref.slice(1)):0;
 if(!(cp>0&&cp<=0x10FFFF))fail(`unbekannte Entität &${ref};`);
 return String.fromCodePoint(cp);
});

export function parseXml(xml){
 let i=xml.charCodeAt(0)===0xFEFF?1:0,root=null;
 const start=i,stack=[];// [{el,declared}]
 const bindings=new Map([['xml',[XML_NS]]]);// prefix ('' = default) -> stack of namespace URIs in scope
 const unbind=declared=>{for(const p of declared)bindings.get(p).pop();};
 const take=re=>{re.lastIndex=i;const m=re.exec(xml);if(!m)fail(`ungültiges XML an Position ${i}`);i=re.lastIndex;return m;};
 while(i<xml.length){
  const lt=xml.indexOf('<',i),end=lt<0?xml.length:lt;
  if(end>i){
   const text=xml.slice(i,end);
   if(stack.length)stack.at(-1).el.text+=decode(text);
   else if(/[^ \t\r\n]/.test(text))fail('Text außerhalb des Wurzelelements');
   i=end;
   if(lt<0)break;
  }
  if(xml.startsWith('<!--',i)){const e=xml.indexOf('-->',i+4);if(e<0)fail('Kommentar ohne Ende');i=e+3;}
  else if(xml.startsWith('<![CDATA[',i)){
   if(!stack.length)fail('CDATA außerhalb des Wurzelelements');
   const e=xml.indexOf(']]>',i+9);if(e<0)fail('CDATA ohne Ende');
   stack.at(-1).el.text+=xml.slice(i+9,e);i=e+3;
  }
  else if(xml.startsWith('<?',i)){
   const e=xml.indexOf('?>',i+2);if(e<0)fail('Verarbeitungsanweisung ohne Ende');
   const body=xml.slice(i+2,e);
   if(/^xml([ \t\r\n]|$)/i.test(body)){
    if(i!==start)fail('XML-Deklaration nicht am Dokumentanfang');
    const enc=/[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/.exec(body);
    if(enc&&(enc[1]??enc[2]).toLowerCase()!=='utf-8')fail(`Zeichenkodierung ${enc[1]??enc[2]} statt UTF-8`);
   }
   i=e+2;
  }
  else if(xml.startsWith('<!',i))fail('DOCTYPE und andere Deklarationen sind nicht erlaubt');
  else if(xml.startsWith('</',i)){
   i+=2;const name=take(NAME)[0];take(SPACE);
   if(xml[i]!=='>')fail(`ungültiges Endtag </${name}>`);
   i++;
   const open=stack.pop();
   if(open?.el.qname!==name)fail(`Endtag </${name}> passt zu keinem offenen Element`);
   unbind(open.declared);
  }
  else{
   i++;const qname=take(NAME)[0],raw=[],names=new Set();
   for(;;){
    const space=take(SPACE)[0];
    if(xml[i]==='>'||xml.startsWith('/>',i))break;
    if(!space)fail(`ungültiges Start-Tag <${qname}>`);
    const name=take(NAME)[0];take(SPACE);
    if(xml[i]!=='=')fail(`Attribut ${name} ohne Wert`);
    i++;take(SPACE);
    const v=take(VALUE);
    if(names.has(name))fail(`Attribut ${name} doppelt`);
    names.add(name);raw.push({name,value:decode((v[1]??v[2]).replace(/[\t\n\r]/g,' '))});
   }
   const selfClosing=xml[i]==='/';i+=selfClosing?2:1;
   const declared=[];
   for(const {name,value} of raw){
    const p=name==='xmlns'?'':name.startsWith('xmlns:')?name.slice(6):null;
    if(p==null)continue;
    if(!bindings.has(p))bindings.set(p,[]);
    bindings.get(p).push(value);declared.push(p);
   }
   const lookup=p=>bindings.get(p)?.at(-1);
   const resolve=(q,attribute)=>{
    const c=q.indexOf(':');
    if(c<0)return {ns:attribute?null:lookup('')||null,name:q};
    const ns=lookup(q.slice(0,c));
    if(!ns)fail(`Namensraum-Präfix ${q.slice(0,c)} ist nicht gebunden`);
    return {ns,name:q.slice(c+1)};
   };
   const el={...resolve(qname,false),qname,attrs:new Map(),children:[],text:''};
   for(const {name,value} of raw){
    if(name==='xmlns'||name.startsWith('xmlns:'))continue;
    const a=resolve(name,true),key=a.ns?`{${a.ns}}${a.name}`:a.name;
    if(el.attrs.has(key))fail(`Attribut ${name} doppelt`);
    el.attrs.set(key,value);
   }
   if(stack.length)stack.at(-1).el.children.push(el);
   else if(root)fail('mehr als ein Wurzelelement');
   else root=el;
   if(selfClosing)unbind(declared);else stack.push({el,declared});
  }
 }
 if(!root||stack.length)fail('Dokument unvollständig');
 return root;
}
