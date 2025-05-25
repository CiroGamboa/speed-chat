import json
import os

from flask import Flask, jsonify, request

app = Flask(__name__)
STATE_FILE = "backend/state.json"


def load_state():
    if not os.path.exists(STATE_FILE):
        return {}
    with open(STATE_FILE, "r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


@app.route("/state", methods=["GET"])
def get_state():
    return jsonify(load_state())


@app.route("/state", methods=["POST"])
def update_state():
    state = request.json
    save_state(state)
    return jsonify({"status": "success"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
