"""Loopback-only harness for the real Lynclaw synthesis route, with synthetic identity/model."""
from __future__ import annotations
import argparse
import json
import socket
import sys
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lynclaw-root', type=Path, required=True)
    parser.add_argument('--ready-file', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.lynclaw_root.resolve()))
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse
    from runtime import desktop_synthesis
    from runtime.http_identity import LynseIdentity, IdentityAuthenticationError
    import uvicorn

    calls = []
    original = desktop_synthesis.synthesize

    def model(messages):
        payload = json.loads(messages[1]['content'])
        source = payload['sources'][0]
        text = source['text']
        # The fixture must never silently send unexpected evidence to any provider.
        if source['kind'] != 'meeting_summary' or 'TRANSCRIPT_ONLY' in json.dumps(payload) or '张三负责A项目' not in text or '@example.com' in text or '13812345678' in text:
            raise ValueError('Expected synthetic, already masked source')
        calls.append({'task': payload['task'], 'masked': True})
        ref = dict(id=source['id'], kind=source['kind'], revision=source['revision'], quote=text.strip())
        def node(key, kind, title, modality='asserted', due=''):
            return dict(key=key,kind=kind,title=title,description=title,status='unknown',modality=modality,confidence=.8,timeText='',dueText=due,citations=[ref])
        def relation(subject, target, predicate, modality='asserted'):
            return dict(subject=subject,target=target,predicate=predicate,modality=modality,confidence=.8,citations=[ref])
        result = dict(schemaVersion=1,nodes=[node('person','person','张三'),node('recipient','person','李四'),node('project','project','A项目'),node('document','document','预算表'),node('task','task','提交预算表','planned','周五'),node('decision','decision','采用方案B'),node('risk','risk','预算超支','uncertain')],relations=[relation('person','project','responsible_for'),relation('task','person','owner','planned'),relation('task','recipient','recipient','planned'),relation('task','document','object','planned'),relation('task','project','project','planned'),relation('decision','project','project'),relation('risk','project','project'),relation('recipient','risk','concerned_about','uncertain')])
        if payload.get('query') == 'fixture-invalid-quote':
            result['relations'][0]['citations'] = [{**ref, 'quote': 'Invented source text'}]
        return result

    def synthesize(payload, **kwargs):
        return original(payload, **kwargs, model_call=model)

    def identity(token, **kwargs):
        if token != 'synthetic-local-graph-token':
            raise IdentityAuthenticationError('Synthetic fixture rejected token')
        return LynseIdentity('graph-smoke-user', 'Local fixture', 'graph-smoke-customer')

    executor = ThreadPoolExecutor(max_workers=2)
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origin_regex=r'https?://(?:localhost|127\.0\.0\.1)(?::\d+)?', allow_methods=['GET', 'POST'], allow_headers=['*'])
    desktop_synthesis.register_desktop_routes(app, root_provider=lambda: args.lynclaw_root, executor_provider=lambda: executor)

    @app.get('/health')
    def health():
        return {'mode':'synthetic-identity-and-model', 'schemaVersion':1, 'modelCalls':len(calls), 'allMasked':all(call['masked'] for call in calls)}

    audio_file = args.ready_file.with_suffix('.wav')
    with wave.open(str(audio_file), 'wb') as output:
        output.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
        output.writeframes(b'\0\0' * 8000 * 20)

    @app.get('/audio.wav')
    def audio():
        return FileResponse(audio_file, media_type='audio/wav')

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(16)
    address = f'http://127.0.0.1:{listener.getsockname()[1]}'
    args.ready_file.write_text(json.dumps({'url':address}), encoding='utf-8')
    with patch('runtime.desktop_synthesis.synthesize', side_effect=synthesize), patch('runtime.http_identity.resolve_token_identity', side_effect=identity), patch('runtime.session_binding.bound_backend_host', return_value=None):
        try:
            uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False)).run(sockets=[listener])
        finally:
            executor.shutdown(wait=True)
            listener.close()


if __name__ == '__main__':
    main()
