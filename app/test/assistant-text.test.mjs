// The core never emits a top-level `{type:'text_end', text}` frame; assistant text
// rides on `message_start|message_update|message_end` as `message.content` (and nests
// `{type:'text_end'}` inside `message_update.assistantMessageEvent`). A completed turn
// can also report only tool calls, and then the old renderer drew an empty bubble.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewModel, applyFrame, assistantNote, ASSISTANT_NOTE } from '../public/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const coreMessage = (content) => ({ role:'assistant',content,api:'openai-completions',provider:'harness-local',model:'auto',stopReason:'stop',timestamp:1 });

test('assistant text reaches the view model from the message frames the core emits, not from a text_end frame', () => {
  const vm = createViewModel();
  const text = '실제 omp와 연결되었습니다. 모델 응답은 테스트 스텁입니다.';
  const frames = [
    { type:'message_start',message:{ role:'user',content:[{ type:'text',text:'hello local stub' }] } },
    { type:'message_end',message:{ role:'user',content:[{ type:'text',text:'hello local stub' }] } },
    { type:'message_start',message:coreMessage([{ type:'text',text }]) },
    { type:'message_update',assistantMessageEvent:{ type:'text_start',contentIndex:0,partial:coreMessage([{ type:'text',text }]) },message:coreMessage([{ type:'text',text }]) },
    { type:'message_update',assistantMessageEvent:{ type:'text_delta',contentIndex:0,delta:'실제 omp',partial:coreMessage([{ type:'text',text }]) },message:coreMessage([{ type:'text',text }]) },
    { type:'message_update',assistantMessageEvent:{ type:'text_end',contentIndex:0,content:text,partial:coreMessage([{ type:'text',text }]) },message:coreMessage([{ type:'text',text }]) },
    { type:'message_end',message:coreMessage([{ type:'text',text }]) },
  ];
  for (const frame of frames) applyFrame(vm,frame);
  const assistant = vm.messages.find(message => message.role === 'assistant');
  assert.equal(assistant.text,text,'the assistant text is rendered from message.content');
  assert.equal(assistantNote(assistant,false),null,'a message that carries text needs no notice');
});

test('a turn that reported only tool calls gets an honest notice instead of a blank bubble', async () => {
  const vm = createViewModel();
  const toolOnly = coreMessage([{ type:'toolCall',id:'call-local-1',name:'bash',arguments:{ command:'echo ok' } }]);
  for (const frame of [
    { type:'message_start',message:toolOnly },
    { type:'message_update',assistantMessageEvent:{ type:'toolcall_start',contentIndex:0,partial:toolOnly },message:toolOnly },
    { type:'message_end',message:toolOnly },
    { type:'tool_execution_start',toolCallId:'call-local-1',toolName:'bash',args:{ command:'echo ok' } },
    { type:'tool_execution_end',toolCallId:'call-local-1',toolName:'bash',result:{ content:[{ type:'text',text:'ok' }] },isError:false },
  ]) applyFrame(vm,frame);
  const assistant = vm.messages.find(message => message.role === 'assistant');
  assert.equal(assistant.text,'','the core reported no assistant text for this turn');
  assert.equal(assistantNote(assistant,vm.tools.length > 0),ASSISTANT_NOTE.toolOnly,'the tool-call-only turn is named as such');
  assert.equal(assistantNote(assistant,false),ASSISTANT_NOTE.none,'a turn with no tools and no text is not blamed on tools');
  assert.equal(assistantNote({ role:'user',text:'' },true),null,'only assistant messages can be textless');

  // The renderer uses that notice: no assistant bubble is emitted empty.
  const app = await readFile(resolve(here,'../public/app.js'),'utf8');
  assert.match(app,/assistantNote\(entry\.message/,'the transcript asks protocol.js whether the assistant text was reported');
  assert.match(app,/el\('div','assistant-empty',note\)/,'an unreported assistant text renders its own honest node');
  const css = await readFile(resolve(here,'../public/styles.css'),'utf8');
  assert.match(css,/\.assistant-empty\{/,'the honest node is styled as secondary text');
});
