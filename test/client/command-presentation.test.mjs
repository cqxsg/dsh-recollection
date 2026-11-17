import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { installCommandPresentation } from '../../.local/test-code/client/command-presentation.js';
import { apply as commands } from '../../.local/test-code/host/commands.js';
import { apply as previews } from '../../.local/test-code/host/command-previews.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const cells = [ ['conversation.chat.node', { key: 'user' }], ['conversation.chat.node', { key: 'steering' }],
  ['conversation.chat.flow', {}], ['conversation.composer.bar', {}], ['conversation.view', { id: 'chat' }] ];
function registry() {
  const rows = new Map(), listeners = new Map();
  const notify = name => queueMicrotask(() => { for (const fn of listeners.get(name) ?? []) fn(); });
  const slots = {
    entries: name => rows.get(name) ?? [],
    entriesOfSlot: name => { const seen = new Set(); return slots.entries(name).toSorted((a,b) => (a.options.priority ?? 0)-(b.options.priority ?? 0))
      .filter(entry => { const key = entry.options.key ?? entry.options.id; if (seen.has(key)) return false; seen.add(key); return true; }); },
    subscribe: (name, fn) => { const set = listeners.get(name) ?? new Set(); listeners.set(name,set); set.add(fn); return () => set.delete(fn); },
    register: ({ name, ...options }, component) => {
      const entry = { component, options }; rows.set(name,[...slots.entries(name),entry]); notify(name);
      return () => { rows.set(name,slots.entries(name).filter(e => e !== entry)); notify(name); };
    },
    listeners,
  };
  const locale = { getLocale: () => ({ active: 'en' }), subscribe: () => () => {} };
  const mounts = cells.map(([name,options]) => slots.register({ name, ...options }, () => null));
  return { slots, locale, mounts, notify };
}

test('templates match the approved text and input is data in one user request', async () => {
  // Frozen from the approved RC4 text; keep this check portable to the public source export.
  const templates = JSON.parse(await readFile(new URL('../fixtures/recall-command-templates.json', import.meta.url), 'utf8'));
  let definition; const messages=[]; const agent={id:'test', steer:m => messages.push(m)};
  commands({ commands:{register:d => definition=d}, agents:{get:() => agent} });
  for (const rawInput of ['', ' \r\n\t', ' 查找原文\nC:\\a+b[0].ts\n  ']) {
    definition.handler({ agent, rawInput, signal:new AbortController().signal });
    const message=messages.at(-1), input=rawInput.trim()?rawInput:'';
    assert.equal(message.content[0].text,input?templates[1].replace('{user_input}',input):templates[0]);
    assert.deepEqual(message.source,{kind:'user',dshRecollection:{type:'recall',userInput:input}});
  }
  assert.equal(messages.length,3); assert.equal(new Set(messages.map(m=>m.id)).size,3);
});

test('only marked display props change; empty rows disappear and ordinary attachments retain identity', () => {
  const {slots,locale}=registry();const off=installCommandPresentation(slots,locale,()=>{});
  const render=(name,key,props)=>{const el=slots.entriesOfSlot(name).find(e=>e.options.key===key).component(props);return el.type(el.props);};
  const source=input=>({kind:'user',dshRecollection:{type:'recall',userInput:input}});
  const original={node:{data:{source:source(' 多行\n输入 '),content:[{type:'text',text:'internal instruction'}]}}};
  const unchanged=structuredClone(original);
  const output=render('conversation.chat.node','user',original);
  assert.deepEqual(output.props.node.data.content,[{type:'text',text:' 多行\n输入 '}]);assert.deepEqual(original,unchanged);
  assert.equal(output.props.node.data.source,original.node.data.source);
  assert.equal(render('conversation.chat.node','steering',{node:{data:{source:source('')}}}),null);
  const ordinary={source:{kind:'user'},content:[{type:'text',text:'[/recall request'}, {type:'image',url:'attachment'}]};
  assert.equal(render('conversation.chat.node','user',{node:{data:ordinary}}).props.node.data,ordinary);
  const pendingInputs=[{id:'bare',source:source('')},{id:'target',source:source('target'),content:original.node.data.content},ordinary];
  const pending=render('conversation.chat.flow',undefined,{pendingInputs}).props.pendingInputs;
  assert.deepEqual(pending.map(item=>item.id),['target',undefined]);assert.equal(pending[1],ordinary);
  assert.deepEqual(pending[0].content,[{type:'text',text:'target'}]);assert.equal(pendingInputs.length,3);
  off();
});

test('preview fold preserves ordinary first prompts and does not let mid-turn recall override them', () => {
  let def; previews({sessionProjections:{register:d=>def=d}});
  let s=def.init(); const apply=(type,data)=>s=def.apply(s,{type,data});
  const user=(source,text='original model input')=>apply('user/message',{source,content:[{type:'text',text}]});
  const recall=text=>({kind:'user',dshRecollection:{type:'recall',userInput:text}});
  apply('turn/start',{turn:1});user({kind:'user'},'ordinary');user(recall('later recall'));
  apply('turn/start',{turn:2});user(recall(''));user(recall('later target'));
  apply('turn/start',{turn:3});user(recall('x'.repeat(100)));
  assert.deepEqual(def.wire.view(s),{2:'',3:'x'.repeat(49)+'…'});
  assert.deepEqual(def.stateSchema.parse(JSON.parse(JSON.stringify(s))),s);
  apply('turn/start',{turn:3});user(recall('must not reset'));
  assert.equal(s.previews[3],'x'.repeat(49)+'…');
});

test('duplicate mounts share wrappers, dispose restores originals and stops subscriptions', async () => {
  const {slots,locale}=registry(), originals=cells.map(([name,options])=>slots.entries(name).find(e=>e.options.key===options.key&&e.options.id===options.id)).map(e=>[e,e.component]);
  const statuses=[]; const off=installCommandPresentation(slots,locale,s=>statuses.push(s));await settle();
  assert.equal(statuses.at(-1).ready,true);
  const wrapped=originals.map(([entry])=>entry.component),off2=installCommandPresentation(slots,locale,()=>{});
  assert.deepEqual(originals.map(([e])=>e.component),wrapped);
  off();off();assert.deepEqual(originals.map(([e])=>e.component),wrapped);
  off2();await settle();for(const [entry,original] of originals)assert.equal(entry.component,original);
  assert.equal([...slots.listeners.values()].reduce((n,s)=>n+s.size,0),0);
});

test('host withdrawal and new entry rebind once; third-party replacements are not overwritten or stacked', async () => {
  const {slots,locale,mounts,notify}=registry(),statuses=[];
  const off=installCommandPresentation(slots,locale,s=>statuses.push(s));await settle();
  mounts[0]();await settle();assert.equal(statuses.at(-1).ready,false);
  const original=()=>null;const remove=slots.register({name:cells[0][0],key:'user'},original);await settle();
  assert.equal(statuses.at(-1).ready,true);
  const entry=slots.entries(cells[0][0]).find(e=>e.options.key==='user'),wrapped=entry.component;
  assert.notEqual(wrapped,original);
  const external=props=>wrapped(props);entry.component=external;notify(cells[0][0]);await settle();
  assert.equal(entry.component,external);assert.equal(statuses.at(-1).ready,false);
  // A stale wrapper captured by another plugin delegates unchanged after losing ownership.
  assert.equal(wrapped({}).type,original);
  off();assert.equal(entry.component,external);remove();
});

test('unsupported immutable registrations report failure without changing them', async () => {
  const {slots,locale}=registry(),entry=slots.entries(cells[0][0])[0],original=entry.component,statuses=[];
  Object.defineProperty(entry,'component',{value:original,writable:false});
  const off=installCommandPresentation(slots,locale,s=>statuses.push(s));await settle();
  assert.equal(statuses.at(-1).ready,false);assert.match(statuses.at(-1).error,/Unsupported component/);
  assert.equal(entry.component,original);off();
});
