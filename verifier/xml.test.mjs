import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseXml} from './xml.mjs';

test('reader resolves namespaces, decodes entities, skips comments and PIs, keeps CDATA as text',()=>{
 const root=parseXml('﻿<?xml version="1.0" encoding="UTF-8"?><?pi x?><!-- c --><r xmlns="urn:a" xmlns:p="urn:b" k=\'1 > 0\'><p:x p:k="&quot;&#65;&#x42;">a&amp;b<!--<p:x>no</p:x>--><![CDATA[<c>]]></p:x><y xmlns="urn:c"/><p:z xmlns:p="urn:d"/></r>');
 assert.equal(root.ns,'urn:a');assert.equal(root.name,'r');assert.equal(root.attrs.get('k'),'1 > 0');
 assert.deepEqual(root.children.map(c=>[c.ns,c.name]),[['urn:b','x'],['urn:c','y'],['urn:d','z']]);
 const [x]=root.children;
 assert.equal(x.text,'a&b<c>');assert.deepEqual(x.children,[]);assert.equal(x.attrs.get('{urn:b}k'),'"AB');
});

test('reader refuses what another parser could read differently',()=>{
 for(const [xml,message] of [
  ['<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>',/DOCTYPE/],
  ['<?xml version="1.0" encoding="ISO-8859-1"?><r/>',/UTF-8/],
  [' <?xml version="1.0"?><r/>',/Dokumentanfang/],
  ['<r>&e;</r>',/Entität/],['<r>a & b</r>',/Entität/],
  ['<r><a></r>',/Endtag/],['<r>',/unvollständig/],['<r/><r/>',/Wurzelelement/],['<r/>x',/außerhalb/],
  ['<r a="1" a="2"/>',/doppelt/],['<r xmlns:p="urn:p" p:a="1" xmlns:q="urn:p" q:a="2"/>',/doppelt/],
  ['<p:r/>',/nicht gebunden/],['<r a="1"b="2"/>',/Start-Tag/],['<r a="<"/>',/ungültiges XML/],
 ])assert.throws(()=>parseXml(xml),message,xml);
});

test('reader runs in linear time on hostile input',()=>{
 const t=performance.now();
 for(const xml of ['<r'+' '.repeat(2e6)+'!','<r a'+' '.repeat(2e6)+'!','<r>'+'&'.repeat(1e3),'<r>'+'<!--'.repeat(1e5)])assert.throws(()=>parseXml(xml));
 const prefixes=Array.from({length:2e4},(_,k)=>`xmlns:p${k}="urn:p"`).join(' ');
 assert.equal(parseXml(`<r ${prefixes}>${'<a/>'.repeat(5e4)}</r>`).children.length,5e4);
 assert.equal(parseXml(`<r ${Array.from({length:5e4},(_,k)=>`a${k}="1"`).join(' ')}/>`).attrs.size,5e4);
 assert.ok(performance.now()-t<2000,'hostile input must not take quadratic time');
});
