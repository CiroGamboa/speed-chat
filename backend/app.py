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
CORS(
    app, resources={r"/*": {"origins": "*"}}
)  # Enable CORS with more specific configuration
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    logger=True,
    engineio_logger=True,
    async_mode="eventlet",
    ping_timeout=60,
    ping_interval=25,
)
STATE_FILE = os.path.join(os.path.dirname(__file__), "state.json")


def load_state():
    if not os.path.exists(STATE_FILE):
        return {
            "config": {
                "sessionDuration": "30",
                "alarmInterval": "5",
                "maxPeoplePerLine": "10",
                "blinkBeforeStart": False,
                "blinkTime": "5",
                "finishWindow": "5",
                "autoReschedule": "off",
                "lines": [],
            }
        }
    with open(STATE_FILE, "r") as f:
        try:
            state = json.load(f)
            # Ensure the state has the correct structure
            if "config" not in state:
                state = {"config": state}
            # Ensure maxPeoplePerLine is set to 10 if not present or invalid
            if (
                "maxPeoplePerLine" not in state["config"]
                or not state["config"]["maxPeoplePerLine"].isdigit()
            ):
                state["config"]["maxPeoplePerLine"] = "10"
            return state
        except json.JSONDecodeError:
            return {
                "config": {
                    "sessionDuration": "30",
                    "alarmInterval": "5",
                    "maxPeoplePerLine": "10",
                    "blinkBeforeStart": False,
                    "blinkTime": "5",
                    "finishWindow": "5",
                    "autoReschedule": "off",
                    "lines": [],
                }
            }


def save_state(state):
    logger.debug(f"Saving state: {state}")
    # Ensure the state has the correct structure
    if "config" not in state:
        state = {"config": state}

    # Save to file
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

    # Emit the new state to all connected clients
    socketio.emit("state_updated", state, namespace="/")
    logger.debug("State update emitted to all clients")


@app.route("/state", methods=["GET"])
def get_state():
    state = load_state()
    logger.debug(f"GET /state returning: {state}")
    return jsonify(state)


@app.route("/state", methods=["POST"])
def update_state():
    try:
        state = request.json
        logger.debug(f"POST /state received: {state}")
        save_state(state)
        return jsonify({"status": "success", "state": state})
    except Exception as e:
        logger.error(f"Error updating state: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


@socketio.on("connect")
def handle_connect():
    logger.info("Client connected")
    # Send current state to newly connected client
    socketio.emit("state_updated", load_state(), namespace="/")
    logger.debug("Initial state sent to client")


@socketio.on("disconnect")
def handle_disconnect():
    logger.info("Client disconnected")


@socketio.on("get_state")
def handle_get_state():
    logger.info("Received get_state request")
    socketio.emit("state_updated", load_state(), namespace="/")
    logger.debug("State sent in response to get_state request")


@socketio.on("state_saved")
def handle_state_saved(state):
    logger.info("Received state_saved event")
    save_state(state)
    logger.debug("State saved and broadcasted")


if __name__ == "__main__":
    logger.info("Starting server on port 8080")
    socketio.run(app, host="0.0.0.0", port=8080, debug=True)
