import json
import logging
import os

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS
socketio = SocketIO(app, cors_allowed_origins="*", logger=True, engineio_logger=True)
STATE_FILE = os.path.join(os.path.dirname(__file__), "state.json")


def load_state():
    if not os.path.exists(STATE_FILE):
        return {
            "config": {
                "sessionDuration": "30",
                "alarmInterval": "5",
                "maxPeoplePerLine": "4",
                "blinkBeforeStart": False,
                "lines": [],
            }
        }
    with open(STATE_FILE, "r") as f:
        try:
            state = json.load(f)
            # Ensure the state has the correct structure
            if "config" not in state:
                state = {"config": state}
            return state
        except json.JSONDecodeError:
            return {
                "config": {
                    "sessionDuration": "30",
                    "alarmInterval": "5",
                    "maxPeoplePerLine": "4",
                    "blinkBeforeStart": False,
                    "lines": [],
                }
            }


def save_state(state):
    logger.debug(f"Saving state: {state}")
    # Ensure the state has the correct structure
    if "config" not in state:
        state = {"config": state}
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)
    # Emit the new state to all connected clients
    socketio.emit("state_update", state)
    logger.debug("State update emitted to all clients")


@app.route("/state", methods=["GET"])
def get_state():
    state = load_state()
    logger.debug(f"GET /state returning: {state}")
    return jsonify(state)


@app.route("/state", methods=["POST"])
def update_state():
    state = request.json
    logger.debug(f"POST /state received: {state}")
    save_state(state)
    return jsonify({"status": "success"})


@socketio.on("connect")
def handle_connect():
    logger.info("Client connected")
    # Send current state to newly connected client
    socketio.emit("state_update", load_state())


@socketio.on("disconnect")
def handle_disconnect():
    logger.info("Client disconnected")


if __name__ == "__main__":
    logger.info("Starting server on port 5001")
    socketio.run(app, host="0.0.0.0", port=5001, debug=True)
