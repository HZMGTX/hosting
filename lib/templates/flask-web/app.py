"""Flask app hosted on OmniHost. OmniHost sets PORT for you — always listen on it."""
import os
import time

from flask import Flask, jsonify, render_template
from waitress import serve

app = Flask(__name__)
STARTED = time.time()


@app.get("/")
def index():
    return render_template("index.html")


# Keep URLs relative (fetch('api/hello')) so the app works at /apps/<id>/ and on a custom domain.
@app.get("/api/hello")
def hello():
    return jsonify(message="Hello from Flask on OmniHost!", uptime_seconds=round(time.time() - STARTED))


@app.get("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Flask app listening on port {port}", flush=True)
    serve(app, host="0.0.0.0", port=port)
