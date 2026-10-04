"""Local OpenRouter protocol fixture; no credentials or network account needed."""

import json
import threading
from contextlib import contextmanager
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@contextmanager
def embedding_provider():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if (
                self.path != "/embeddings"
                or self.headers.get("Authorization") != "Bearer local-fixture"
                or body.get("model") != "google/gemini-embedding-2"
                or body.get("dimensions") != 768
            ):
                self.send_error(400)
                return
            vectors = []
            for index, text in enumerate(body["input"]):
                vector = [0.0] * 768
                # A hand-defined semantic pair verifies that vector retrieval,
                # not literal matching, supplies the end-to-end search result.
                if (
                    "automobile repair" in text.lower()
                    or "car maintenance" in text.lower()
                ):
                    vector[0] = 1.0
                else:
                    vector[
                        1 + int.from_bytes(sha256(text.encode()).digest()[:2]) % 767
                    ] = 1.0
                vectors.append({"index": index, "embedding": vector})
            payload = json.dumps(
                {"model": body["model"], "data": list(reversed(vectors))}
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/embeddings"
    finally:
        server.shutdown()
        server.server_close()
        worker.join()
