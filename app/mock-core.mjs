// Synthetic fixture updated to observed omp 18.16.0 shapes; never a real core.
import readline from 'node:readline';
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let counter = 0, pending = null, promptId, activeModel = { provider:'mock',id:'mock-only' };
const input = readline.createInterface({ input:process.stdin });
function answer(text) {
  const message = { role:'assistant',content:[],timestamp:Date.now() };
  emit({ type:'agent_start' }); emit({ type:'turn_start' }); emit({ type:'message_start',message });
  emit({ type:'message_update',assistantMessageEvent:{ type:'text_start',contentIndex:0,partial:message } });
  setImmediate(() => {
    const content = `[모의 응답] ${text}\n코드의 입력과 기대하는 출력을 함께 적어 보세요. 실제 모델은 호출하지 않았습니다.`;
    emit({ type:'message_update',assistantMessageEvent:{ type:'text_delta',contentIndex:0,delta:content,partial:{ ...message,content:[{ type:'text',text:content }] } } });
    emit({ type:'tool_execution_start',toolCallId:`tool-${++counter}`,toolName:'read_file',args:{ path:'example.py' } });
    emit({ type:'tool_execution_end',toolCallId:`tool-${counter}`,toolName:'read_file',result:{ content:[{ type:'text',text:'print("학습을 시작합니다")' }] },isError:false,details:{} });
    emit({ type:'message_end',message:{ ...message,content:[{ type:'text',text:content }] } }); emit({ type:'turn_end' }); emit({ type:'agent_end' });
    emit({ type:'prompt_result',id:promptId,agentInvoked:true,status:'completed',sessionSettled:true }); emit({ type:'session_settled' });
  });
}
input.on('line',line => {
  let frame;
  try { frame = JSON.parse(line); } catch { emit({ type:'response',command:'parse',success:false,error:'Failed to parse command: JSON Parse error: mock fixture' }); return; }
  if (frame.type === 'negotiate_protocol') {
    if (process.env.OMP_MOCK_SCENARIO === 'held-negotiation') { emit({ type:'extension_ui_request',id:'mock-negotiation-held',method:'setWidget',widgetKey:'startup',widgetLines:['Negotiation held by test'] }); return; }
    emit({ type:'response',id:frame.id,command:frame.type,success:true,data:{ protocolVersion:process.env.OMP_MOCK_SCENARIO === 'mismatch' ? 1 : 2 } }); return;
  }
  if (frame.type === 'get_state') { emit({ type:'response',id:frame.id,command:frame.type,success:true,data:{ model:activeModel,isStreaming:false,isCompacting:false,systemPrompt:'x'.repeat(31370) } }); return; }
  if (frame.type === 'abort') { pending = null; emit({ type:'agent_end' }); return; }
  if (frame.type === 'extension_ui_response') {
    if (!pending || frame.id !== pending.id) return;
    const accepted = pending.method === 'select' ? pending.options.includes(frame.value) && frame.value !== 'Deny' : !frame.cancelled;
    pending = null; answer(accepted ? '승인 응답을 받았습니다.' : '요청을 거절했습니다. 실행하지 않았습니다.'); return;
  }
  if (frame.type === 'prompt') {
    promptId = frame.id; const message = String(frame.message);
    emit({ type:'response',id:frame.id,command:'prompt',success:true });
    const user = { role:'user',content:[{ type:'text',text:message }],timestamp:Date.now() }; emit({ type:'message_start',message:user }); emit({ type:'message_end',message:user });
    if (message === '/crash') { process.exit(7); return; }
    if (message === '/large') { emit({ type:'message_update',message:{ role:'assistant',content:'x'.repeat(3 * 1024 * 1024) } }); return; }
    if (message === '/chunk') {
      const bytes = Buffer.from(JSON.stringify({ type:'response',id:frame.id,command:'get_messages',success:true,data:{ text:'x'.repeat(1200000) } }));
      const size = 600000, count = Math.ceil(bytes.length / size);
      for (let index = 0; index < count; index++) emit({ type:'rpc_chunk',chunkId:'mock-chunk',index,count,byteLength:bytes.length,data:bytes.subarray(index * size,(index + 1) * size).toString('base64') }); return;
    }
    if (message === '/error' || message === '/refuse') { emit({ type:'response',id:frame.id,command:'prompt',success:false,error:'모의 코어가 이 요청을 거절했습니다. 실제 작업은 수행하지 않았습니다.' }); return; }
    const methods = { '/approval':'select','/select':'select','/input':'input','/editor':'editor' };
    if (methods[message]) {
      pending = { type:'extension_ui_request',id:`approval-${++counter}`,method:methods[message],title:'Allow tool: bash\nCommand: echo mock-only',options:methods[message] === 'select' ? ['Approve','Approve bash for this session','Deny'] : [],prefill:'' }; emit(pending); return;
    }
    answer('질문을 받았습니다.'); return;
  }
  if (frame.type === 'set_model') {
    if (!frame.provider || !frame.modelId || frame.modelId === 'reject-model' || (process.env.OMP_MOCK_SCENARIO === 'reject-local' && frame.provider !== 'cloud')) {
      emit({ type:'response',id:frame.id,command:frame.type,success:false,error:`Model switch rejected: ${frame.provider ?? ''}/${frame.modelId ?? ''}` });
      return;
    }
    activeModel = { provider:String(frame.provider),id:String(frame.modelId) };
    emit({ type:'response',id:frame.id,command:frame.type,success:true,data:activeModel });
    return;
  }
  emit({ type:'response',id:frame.id,command:frame.type,success:false,error:`Unknown command: ${frame.type}` });
});
input.on('close',() => process.exit(0));
if (process.env.OMP_MOCK_SCENARIO === 'startup-failure') { process.stderr.write('No default model selected. Mock startup failure.\n'); process.exit(1); }
function announceReady() {
  emit({ type:'ready',protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864 });
  emit({ type:'extension_ui_request',id:'mock-widget',method:'setWidget',widgetKey:'autoresearch',widgetLines:['모의 코어의 위젯 예시'] });
  emit({ type:'available_commands_update',commands:[{ name:'mock-example',description:'모의 명령 메타데이터',input:'질문',subcommands:[],source:'mock' }] });
}
if (process.env.OMP_MOCK_SCENARIO === 'held-startup') {
  emit({ type:'extension_ui_request',id:'mock-startup-held',method:'setWidget',widgetKey:'startup',widgetLines:['Startup held by test'] });
  input.once('line',announceReady);
} else announceReady();
