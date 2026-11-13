"""Synthetic provider inside a network-disabled QA container; no provider credentials."""
import json, time, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
root = Path('/tmp/qa')
root.mkdir(exist_ok=True)
lock = threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self): self.respond({})
    def respond(self, value):
        body = json.dumps(value).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
        if self.path == '/events':
            with lock:
                with (root / 'hooks.jsonl').open('a') as f: f.write(json.dumps(body) + '\n')
            if body.get('hook_event_name') == 'PermissionRequest':
                for _ in range(600):
                    if (root / 'decision.json').exists():
                        return self.respond({'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': json.loads((root / 'decision.json').read_text())}})
                    time.sleep(.1)
            return self.respond({})
        if not self.path.split('?')[0].endswith('/messages'): return self.respond({})
        with lock:
            with (root / 'requests.jsonl').open('a') as f: f.write(json.dumps(body) + '\n')
            scenario = root / 'next.json'
            step = json.loads(scenario.read_text()) if scenario.exists() else {}
            eligible = body.get('stream') and body.get('tools')
            if step.get('match') and step['match'] not in json.dumps([m for m in body.get('messages', []) if m.get('role') == 'user'][-1:], ensure_ascii=False): eligible = False
            if eligible and scenario.exists(): scenario.unlink()
            if not eligible: step = {}
        time.sleep(step.get('delay', 0))
        content = step.get('content', [{'type': 'text', 'text': 'QA_DONE'}])
        stop = 'tool_use' if any(b['type'] == 'tool_use' for b in content) else 'end_turn'
        msg = dict(id='msg_qa', type='message', role='assistant', model=body.get('model'), content=content, stop_reason=stop, stop_sequence=None, usage=dict(input_tokens=1, output_tokens=1))
        if not body.get('stream'): return self.respond(msg)
        events = [('message_start', dict(type='message_start', message={**msg, 'content': [], 'stop_reason': None}))]
        for i, b in enumerate(content):
            tool = b['type'] == 'tool_use'
            events += [('content_block_start', dict(type='content_block_start', index=i, content_block={**b, 'input': {}} if tool else dict(type='text', text=''))),
                       ('content_block_delta', dict(type='content_block_delta', index=i, delta=dict(type='input_json_delta', partial_json=json.dumps(b['input'])) if tool else dict(type='text_delta', text=b['text']))),
                       ('content_block_stop', dict(type='content_block_stop', index=i))]
        events += [('message_delta', dict(type='message_delta', delta=dict(stop_reason=stop, stop_sequence=None), usage=dict(output_tokens=1))), ('message_stop', dict(type='message_stop'))]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        try: self.wfile.write(''.join(f'event: {e}\ndata: {json.dumps(d)}\n\n' for e,d in events).encode())
        except BrokenPipeError: pass
ThreadingHTTPServer(('127.0.0.1', 18080), Handler).serve_forever()
