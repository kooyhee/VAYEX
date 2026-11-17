// The activity adapter is the only place omp wire names become student-facing text.
// These tests drive it with the frame shapes omp 18.16.0 actually emits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActivity, ingestFrame, markPrompt, markApprovalAnswered, timelineRows, eventLines, taskSummary, lanes, verifyCommand, verifyOutcome, formatElapsed, diffTotals } from '../public/activity.js';

const base = Date.parse('2026-11-08T05:00:00.000Z');
const at = seconds => base + seconds * 1000;

function toolRun(activity, { id, name, args, result, isError = false, start = 0, end = 1 }) {
  ingestFrame(activity,{ type:'tool_execution_start',toolCallId:id,toolName:name,args },{ now:at(start) });
  ingestFrame(activity,{ type:'tool_execution_end',toolCallId:id,toolName:name,result,isError },{ now:at(end) });
}

test('tool frames become Korean timeline rows without leaking a path', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'데모 작업을 실행해 주세요',at(0));
  toolRun(activity,{ id:'t1',name:'read_file',args:{ path:'src/app.js' },result:{ content:[{ type:'text',text:'const a = 1;' }] } });
  const rows = timelineRows(activity);
  const toolStart = rows.find(row => row.kind === 'tool.start');
  const toolEnd = rows.find(row => row.kind === 'tool.end');
  assert.equal(toolStart.lines[0],'read_file 도구를 실행합니다');
  assert.equal(toolStart.lines[1],'대상 미보고');
  assert.equal(toolEnd.lines[0],'read_file 실행을 마쳤습니다');
  assert.equal(toolEnd.taskId,'main');
  assert.equal(rows[0].kind,'run');
  assert.equal(rows[0].lines[0],'‘데모 작업을 실행해 주세요’ 작업을 시작했습니다');
  // The timeline never lists files: changes are reviewed in the Diff tab instead.
  assert.ok(!/[\\/]|\.js\b/.test(toolStart.lines.join(' ') + toolEnd.lines.join(' ')));
});

test('a failed tool reports the failure, not a completion', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'실패 확인',at(0));
  toolRun(activity,{ id:'t2',name:'bash',args:{ command:'node missing.js' },result:{ content:[{ type:'text',text:'MODULE_NOT_FOUND' }] },isError:true,end:3 });
  const end = timelineRows(activity).find(row => row.kind === 'tool.end');
  assert.equal(end.lines[0],'bash 실행이 실패했습니다');
  assert.equal(end.facts.failed,true);
});

test('per-file results become write rows with counted line changes', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'파일 변경',at(0));
  toolRun(activity,{ id:'t3',name:'edit',args:{ path:'src/one.js' },result:{ details:{ perFileResults:[{ path:'src/one.js',diff:'--- a\n+++ b\n+added\n+added2\n-removed\n',created:false,existedBefore:true }] } } });
  const write = timelineRows(activity).find(row => row.kind === 'write');
  assert.equal(write.facts.path,'src/one.js');
  assert.equal(write.facts.op,'수정');
  assert.equal(write.facts.added,2);
  assert.equal(write.facts.removed,1);
  assert.equal(write.lines[0],'수정 · 2줄 추가 / 1줄 삭제');
  assert.ok(!/src\/one\.js/.test(write.lines.join(' ')));
});

test('verification commands are only the runners this module names', () => {
  assert.equal(verifyCommand('bash',{ command:'node --test test/*.test.mjs' }),'node --test test/*.test.mjs');
  assert.equal(verifyCommand('bash',{ command:'npm test' }),'npm test');
  assert.equal(verifyCommand('bash',{ command:'echo hello' }),null);
  assert.equal(verifyCommand('read_file',{ path:'a.js' }),null);
  const passed = verifyOutcome({ output:'# pass 44\n# fail 0\n' });
  assert.equal(passed.state,'passed');
  assert.equal(passed.pass,44);
  const failed = verifyOutcome({ output:'# pass 3\n# fail 2\n' });
  assert.equal(failed.state,'failed');
  assert.equal(failed.fail,2);
  assert.equal(verifyOutcome({ isError:true,output:'' }).state,'failed');
  assert.equal(verifyOutcome({ output:'no counts here' }).state,'unknown');
});

test('a verification run becomes one row carrying the result state', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'검증 실행',at(0));
  toolRun(activity,{ id:'t4',name:'bash',args:{ command:'node --test' },result:{ content:[{ type:'text',text:'# pass 6\n# fail 0\n' }] } });
  const row = timelineRows(activity).find(item => item.kind === 'verify');
  assert.equal(row.facts.state,'passed');
  assert.equal(row.highlight,'verify');
  assert.equal(row.lines[0],'검증 통과');
  const summary = taskSummary(activity,at(2));
  assert.equal(summary.verify.passed,1);
  assert.equal(summary.verify.failed,0);
});

test('subagent lifecycle reports lanes, dependencies and stable task states', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'병렬 작업',at(0));
  ingestFrame(activity,{ type:'subagent_lifecycle',payload:{ id:'sub-a',agent:'조사',status:'started',index:0,description:'의존성 확인',parentToolCallId:'tool-9' } },{ now:at(1) });
  ingestFrame(activity,{ type:'subagent_lifecycle',payload:{ id:'sub-b',agent:'구현',status:'started',index:1,description:'화면 수정',parentToolCallId:'tool-9' } },{ now:at(1) });
  ingestFrame(activity,{ type:'subagent_lifecycle',payload:{ id:'sub-a',agent:'조사',status:'completed',index:0 } },{ now:at(5) });

  const summary = taskSummary(activity,at(6));
  assert.equal(summary.tasks.length,2);
  assert.equal(summary.tasks[0].status,'done');
  assert.equal(summary.tasks[1].status,'running');
  assert.equal(summary.tasks[1].lane,1);
  const delegate = timelineRows(activity).find(row => row.kind === 'delegate');
  assert.equal(delegate.lines[0],'조사에게 작업을 넘겼습니다');
  assert.equal(delegate.lines[1],'‘의존성 확인’ · 레인 1');
  const done = timelineRows(activity).find(row => row.kind === 'agent.end');
  assert.equal(done.lines[0],'조사 작업 완료');

  const laneView = lanes(activity,at(7));
  assert.equal(laneView.rows.length,3);
  assert.ok(laneView.rows.every(row => row.width > 0 && row.width <= 1));
  assert.equal(laneView.rows[2].dependsOn.label,'병렬 작업');
});

test('a subagent event keeps its own tokens out of the main task', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'토큰 분리',at(0));
  ingestFrame(activity,{ type:'subagent_lifecycle',payload:{ id:'sub-c',agent:'검토',status:'started',index:0 } },{ now:at(1) });
  ingestFrame(activity,{ type:'subagent_event',payload:{ id:'sub-c',event:{ type:'message_end',message:{ role:'assistant',usage:{ totalTokens:120,cost:0.002 } } } } },{ now:at(2) });
  ingestFrame(activity,{ type:'message_end',message:{ role:'assistant',usage:{ totalTokens:80,cost:0.001 } } },{ now:at(3) });
  const summary = taskSummary(activity,at(4));
  assert.equal(summary.tasks[0].tokens,120);
  assert.equal(summary.main.tokens,80);
});

test('consecutive repeated events group once and different targets never merge', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'반복 도구',at(0));
  for (const [index,id] of ['r1','r2','r3'].entries()) {
    toolRun(activity,{ id, name:'read_file', args:{ path:'src/keep.js' }, result:{ content:[] }, start:index * 2, end:index * 2 + 1 });
  }
  toolRun(activity,{ id:'r4', name:'read_file', args:{ path:'src/other.js' }, result:{ content:[] }, start:8, end:9 });

  const grouped = timelineRows(activity,{ grouped:true }).filter(row => row.kind === 'tool.start');
  assert.equal(grouped.length,2,'three repeats and one other target must make two rows');
  assert.equal(grouped[0].count,3);
  assert.equal(grouped[1].count,1);

  const chrono = timelineRows(activity,{ grouped:false }).filter(row => row.kind === 'tool.start');
  assert.equal(chrono.length,4,'chronological mode keeps every event separate');
});

test('an approval request parks the task and the answer releases it', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'승인 대기',at(0));
  ingestFrame(activity,{ type:'extension_ui_request',id:'ask-1',method:'select',title:'Allow tool: bash',options:['Approve','Deny'] },{ now:at(1) });
  assert.equal(taskSummary(activity,at(1)).main.status,'waiting');
  const row = timelineRows(activity).find(item => item.kind === 'approval');
  assert.equal(row.highlight,'approval');
  assert.match(row.lines[0],/승인을 기다립니다/);
  markApprovalAnswered(activity,at(2));
  assert.equal(taskSummary(activity,at(2)).main.status,'running');
});

test('a finished prompt reports its own elapsed time, while a failed one reports failure', () => {
  const completed = createActivity(at(0));
  markPrompt(completed,'완료 데모',at(0));
  ingestFrame(completed,{ type:'agent_start' },{ now:at(1) });
  ingestFrame(completed,{ type:'prompt_result',status:'completed',agentInvoked:true,status2:1,sessionSettled:true },{ now:at(6) });
  const done = timelineRows(completed).find(row => row.kind === 'done');
  assert.equal(taskSummary(completed,at(6)).main.status,'done');
  assert.equal(taskSummary(completed,at(6)).main.elapsed,6000);
  assert.match(done.lines[1],/토큰 미보고/);

  const failed = createActivity(at(0));
  markPrompt(failed,'실패 데모',at(0));
  ingestFrame(failed,{ type:'prompt_result',status:'error',error:{ message:'core refused' } },{ now:at(4) });
  assert.equal(taskSummary(failed,at(4)).main.status,'failed');
  const row = timelineRows(failed).find(item => item.kind === 'failed');
  assert.equal(row.lines[0],'작업이 실패했습니다');
  assert.equal(row.lines[1],'core refused');
});

test('bridge and extension errors are highlighted and never invent a state', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'오류 확인',at(0));
  ingestFrame(activity,{ type:'extension_error',extensionPath:'x.js',error:'boom' },{ now:at(1) });
  const row = timelineRows(activity).find(item => item.kind === 'error');
  assert.equal(row.highlight,'error');
  assert.equal(row.lines[0],'오류 · extension_error');
  assert.equal(row.lines[1],'boom');
  assert.equal(taskSummary(activity,at(1)).main.status,'waiting');
});

test('the buffers are bounded and the event list keeps the newest records', () => {
  const activity = createActivity(at(0));
  for (let index = 0; index < 460; index += 1) {
    ingestFrame(activity,{ type:'tool_execution_start',toolCallId:`c${index}`,toolName:'read_file',args:{ path:`src/${index}.js` } },{ now:at(index) });
  }
  assert.ok(activity.events.length <= 400);
  assert.equal(activity.openTools.size <= 200,true);
  assert.equal(activity.events.at(-1).target,'src/459.js');
});

test('elapsed formatting and diff totals read only what was reported', () => {
  assert.equal(formatElapsed(null),'—');
  assert.equal(formatElapsed(45_000),'45초');
  assert.equal(formatElapsed(72_000),'1분 12초');
  assert.equal(formatElapsed(3_720_000),'1시간 2분');
  assert.deepEqual(diffTotals('+++ b\n+a\n+b\n-c'),{ added:2,removed:1 });
});

test('eventLines returns one or two local Korean lines for every kind', () => {
  const activity = createActivity(at(0));
  markPrompt(activity,'문구 확인',at(0));
  ingestFrame(activity,{ type:'turn_start' },{ now:at(1) });
  ingestFrame(activity,{ type:'auto_retry_start',attempt:2,reason:'rate limited' },{ now:at(2) });
  ingestFrame(activity,{ type:'subagent_lifecycle',payload:{ id:'s1',agent:'탐색',status:'started',index:0,description:'경로 찾기' } },{ now:at(3) });
  for (const row of timelineRows(activity,{ grouped:false })) {
    const lines = eventLines({ kind:row.kind,facts:row.facts,taskName:row.taskName,taskState:row.taskState });
    assert.equal(lines.length,2);
    assert.ok(lines[0].length > 0);
  }
});
