// Translate authored interface copy. User input and model output are never scanned.
const LANGUAGE_KEY = 'audiocpp-ui-language';
let language = 'zh';
try { language = localStorage.getItem(LANGUAGE_KEY) === 'en' ? 'en' : 'zh'; } catch {}
const dictionary = await fetch(new URL('./locales/en.json', import.meta.url)).then(r => {
  if (!r.ok) throw new Error('Language file unavailable');
  return r.json();
}).catch(() => ({}));
const patterns = Object.entries(dictionary).filter(([key]) => /\{\d+\}/.test(key)).map(([key, value]) => {
  const names = [];
  const source = key.split(/(\{\d+\})/).map(part => {
    if (/^\{\d+\}$/.test(part)) { names.push(part); return '([\\s\\S]*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return {regex:new RegExp('^' + source + '$'), names, value, length:key.replace(/\{\d+\}/g,'').length};
}).sort((a,b) => b.length-a.length);
export const getLanguage = () => language;
export function t(value) {
  const source = String(value ?? '');
  if (language !== 'en') return source;
  if (Object.hasOwn(dictionary, source)) return dictionary[source];
  if (!/[\u3400-\u9fff]/.test(source)) return source;
  for (const {regex,names,value:translated} of patterns) {
    const match = regex.exec(source);
    if (match) return translated.replace(/\{\d+\}/g, key => match[names.indexOf(key)+1] ?? key);
  }
  return source;
}
const bindings = new WeakMap();
const textNodes = new WeakMap();
function renderCopy(value) {
  if(typeof value==='string')return t(value);
  const copy=t(value.source);return copy.length>value.limit?copy.slice(0,value.limit-1)+'…':copy;
}
function bind(element, property, source, limit=0) {
  let record = bindings.get(element);
  if (!record) { record = {}; bindings.set(element,record); element.dataset.uiCopy=''; }
  record[property] = limit?{source:String(source??''),limit}:String(source ?? '');
  if (property === 'textContent') {
    const node=document.createTextNode(renderCopy(record[property]));
    element.replaceChildren(node);textNodes.set(element,node);
  }
  else element.setAttribute(property,t(source));
  return source;
}
export function uiText(element, source, limit=0) { return bind(element,'textContent',source,limit); }
export function uiAttr(element, name, source) { return bind(element,name,source); }
export function sourceText(element) {
  const source=bindings.get(element)?.textContent;
  return typeof source==='string'?source:source?.source??element.textContent;
}
export function rawText(element, value) {
  const record=bindings.get(element);if(record)delete record.textContent;
  textNodes.delete(element);
  element.removeAttribute('data-i18n');element.textContent=String(value??'');
}
export function applyLanguage(root = document) {
  for (const element of root.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-aria-description], [data-i18n-alt]')) {
    if (element.hasAttribute('data-i18n')) {if(!Object.hasOwn(bindings.get(element)||{},'textContent'))uiText(element,element.getAttribute('data-i18n'));element.removeAttribute('data-i18n');}
    for (const name of ['title','placeholder','aria-label','aria-description','alt']) if (element.hasAttribute(`data-i18n-${name}`)) {if(!Object.hasOwn(bindings.get(element)||{},name))uiAttr(element,name,element.getAttribute(`data-i18n-${name}`));element.removeAttribute(`data-i18n-${name}`);}
  }
  for (const element of root.querySelectorAll('[data-ui-copy]')) {
    for (const [property,source] of Object.entries(bindings.get(element)||{})) {
      if (property === 'textContent') {
        const node=textNodes.get(element);
        if(node?.parentNode===element)node.nodeValue=renderCopy(source);
      }
      else element.setAttribute(property,t(source));
    }
  }
}
export function setLanguage(value, {persist=true} = {}) {
  language = value === 'en' ? 'en' : 'zh';
  if (persist) try { localStorage.setItem(LANGUAGE_KEY,language); } catch {}
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  applyLanguage();
  window.dispatchEvent(new CustomEvent('audiocpp:language',{detail:{language}}));
}
window.addEventListener('storage',event => { if (event.key===LANGUAGE_KEY) setLanguage(event.newValue,{persist:false}); });
document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
// Called only for HTML templates authored by the app. Interpolated text is opaque.
const escape = value => String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function html(strings, ...values) {
  const token = i => `\uE000${i}\uE001`;
  const expand = source => source.replace(/\uE000(\d+)\uE001/g,(_,i)=>String(values[Number(i)]??''));
  let source = strings.reduce((out,part,i)=>out+part+(i<values.length?token(i):''),'');
  source=source.replace(/(<(?:textarea|pre|code|script|style)\b[^>]*>)([\s\S]*?)(<\/(?:textarea|pre|code|script|style)>)/gi,(_,open,body,close)=>{
    const i=values.length;values.push(expand(body));return open+token(i)+close;
  });
  source = source.replace(/\s(title|placeholder|aria-label)=(['"])(.*?)\2/g,(all,name,quote,copy)=>{
    if (!/[\u3400-\u9fff]/.test(copy)) return all;
    const raw=expand(copy), decoded=decode(raw);
    return ` ${name}="${escape(t(decoded))}" data-i18n-${name}="${escape(decoded)}"`;
  });
  source = source.replace(/<([a-z][\w-]*)([^<>]*)>([^<>]+)<\/\1>/gi,(all,tag,attrs,copy)=>{
    if (['textarea','code','pre','script','style'].includes(tag)||!/[\u3400-\u9fff]/.test(copy)) return all;
    const raw=expand(copy);if (/[<>]/.test(raw)) return all;
    const decoded=decode(raw);
    return `<${tag}${attrs} data-i18n="${escape(decoded)}">${escape(t(decoded))}</${tag}>`;
  });
  source = source.replace(/(<[^<>]+>)([^<>]+)(?=<)/g,(all,open,copy)=>{
    if(/\bdata-i18n=/.test(open))return all;
    if (!/[\u3400-\u9fff]/.test(copy)) return all;
    const raw=expand(copy);
    if (/[<>]/.test(raw)) return all;
    const decoded=decode(raw);
    return `${open}<span data-i18n="${escape(decoded)}">${escape(t(decoded))}</span>`;
  });
  return expand(source);
}
function decode(value) { const el=document.createElement('textarea');el.innerHTML=value;return el.value; }
export function textHTML(value) {return `<span data-i18n="${escape(value)}">${escape(t(value))}</span>`;}
