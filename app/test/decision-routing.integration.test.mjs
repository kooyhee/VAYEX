import test from 'node:test';
import assert from 'node:assert/strict';
import { startRealFixture, attach } from './real-fixture.mjs';

test('integrated decision-routing: falls back to demo-chat when remote decision plane is unreachable', { timeout: 30000 }, async (t) => {
  const f = await startRealFixture({
    configureInference: (raw) => {
      // Keep fixture local stub, plus add demo-chat and a dead proxy upstream
      const stubUrl = raw.upstreams[0].base_url;
      return {
        ...raw,
        logging: { ...raw.logging, log_request_bodies: false },
        upstreams: [
          ...raw.upstreams,
          {
            id: 'local-stub',
            class: 'server_local',
            kind: 'openai',
            base_url: stubUrl,
            auth_mode: 'none',
            models: [{
              id: 'demo-chat',
              capabilities: ['chat'],
              zero_data_retention: true,
              training_opt_out: true,
              context_window: 32768,
              thinking_limit: 8192,
            }],
          },
          {
            id: 'dead-decision',
            class: 'proxy',
            kind: 'openai',
            base_url: 'http://127.0.0.1:1/v1',
            auth_mode: 'none',
            models: [
              {
                id: 'combo/main',
                capabilities: ['chat'],
                zero_data_retention: false,
                training_opt_out: false,
                metadata: { decision_model: true },
              },
              {
                id: 'combo/front-worker',
                capabilities: ['chat'],
                zero_data_retention: false,
                training_opt_out: false,
                metadata: { decision_model: true },
              },
            ],
          },
        ],
      };
    },
  });
  t.after(() => f.close());

  const ws = attach(f.url, '?route=any_cloud&consent=1');
  await ws.until((x) => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(ws.frames.find((x) => x.type === 'bridge_error'), undefined);

  const connected = ws.frames.find((x) => x.type === 'bridge_connected');
  const session = f.bridge.sessions.get(connected.sessionId);
  assert.ok(session, 'session must be registered');

  const userPrompt = '반응형 프론트엔드 네비게이션 바 화면을 구현해줘';
  const chatRes = await fetch(f.url + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': session.identity || 'local-user',
      'x-route': 'any_cloud',
      'x-app-session': session.token,
    },
    body: JSON.stringify({
      role: 'frontend',
      messages: [{ role: 'user', content: userPrompt }],
      stream: false,
    }),
  });

  assert.equal(chatRes.status, 200, `chat request must succeed: ${await chatRes.clone().text()}`);
  const json = await chatRes.json();

  // Model selection should reflect local fallback due to unreachable dead-decision upstream
  assert.equal(json.gateway.model.id, 'demo-chat');
  assert.equal(json.gateway.model.role, 'frontend');
  assert.equal(json.gateway.model.decision_source, 'local_fallback');
  assert.ok(json.gateway.model.decision_reason.startsWith('decision_plane_'));

  // Header verification
  assert.equal(chatRes.headers.get('x-gateway-decision-source'), 'local_fallback');
  assert.equal(chatRes.headers.get('x-gateway-role'), 'frontend');

  // Verify that the local fixture received the request directed to demo-chat
  const lastReq = f.requests.find((r) => r.body && r.body.model === 'demo-chat');
  assert.ok(lastReq, 'fixture stub must have received the request with model demo-chat');

  // Verify no prompt bodies were leaked to logs
  const logsText = f.logs.join('\n');
  assert.equal(logsText.includes(userPrompt), false, 'user prompt must NEVER appear in logs');
});
