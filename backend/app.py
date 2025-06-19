import logging
import os
from typing import Any, Dict

from database import Config, Line, Person, get_db, init_db
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO
from sqlalchemy.orm import Session

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    logger=True,
    engineio_logger=True,
    async_mode="eventlet",
    ping_timeout=60,
    ping_interval=25,
)


def get_state_from_db(db: Session) -> Dict[str, Any]:
    config = db.query(Config).first()
    if not config:
        config = Config()
        db.add(config)
        db.commit()
        db.refresh(config)

    lines = db.query(Line).all()
    lines_data = []
    for line in lines:
        people_data = [{"id": person.id, "name": person.name} for person in line.people]
        lines_data.append({"name": line.name, "time": line.time, "people": people_data})

    return {
        "config": {
            "sessionDuration": config.session_duration,
            "alarmInterval": config.alarm_interval,
            "maxPeoplePerLine": config.max_people_per_line,
            "blinkBeforeStart": config.blink_before_start,
            "blinkTime": config.blink_time,
            "finishWindow": config.finish_window,
            "autoReschedule": config.auto_reschedule,
            "lines": lines_data,
        }
    }


def save_state_to_db(state: Dict[str, Any], db: Session):
    config_data = state.get("config", {})

    # Update or create config
    config = db.query(Config).first()
    if not config:
        config = Config()
        db.add(config)

    config.session_duration = config_data.get("sessionDuration", "30")
    config.alarm_interval = config_data.get("alarmInterval", "5")
    config.max_people_per_line = config_data.get("maxPeoplePerLine", "10")
    config.blink_before_start = config_data.get("blinkBeforeStart", False)
    config.blink_time = config_data.get("blinkTime", "5")
    config.finish_window = config_data.get("finishWindow", "5")
    config.auto_reschedule = config_data.get("autoReschedule", "off")

    # Update lines
    existing_lines = {line.name: line for line in db.query(Line).all()}
    new_lines = config_data.get("lines", [])

    # Remove lines that are no longer in the state
    for line_name in list(existing_lines.keys()):
        if not any(line["name"] == line_name for line in new_lines):
            db.delete(existing_lines[line_name])

    # Update or create lines
    for line_data in new_lines:
        line = existing_lines.get(line_data["name"])
        if not line:
            line = Line(name=line_data["name"])
            db.add(line)

        line.time = line_data["time"]

        # Update people
        existing_people = {p.id: p for p in line.people}
        new_people = line_data.get("people", [])

        # Remove people that are no longer in the line
        for person_id in list(existing_people.keys()):
            if not any(p["id"] == person_id for p in new_people):
                db.delete(existing_people[person_id])

        # Add new people
        for person_data in new_people:
            if person_data["id"] not in existing_people:
                person = Person(name=person_data["name"], line=line)
                db.add(person)

    db.commit()


@app.route("/state", methods=["GET"])
def get_state():
    db = next(get_db())
    try:
        state = get_state_from_db(db)
        logger.debug(f"GET /state returning: {state}")
        return jsonify(state)
    finally:
        db.close()


@app.route("/state", methods=["POST"])
def update_state():
    try:
        state = request.json
        logger.debug(f"POST /state received: {state}")
        db = next(get_db())
        try:
            save_state_to_db(state, db)
            return jsonify({"status": "success", "state": state})
        finally:
            db.close()
    except Exception as e:
        logger.error(f"Error updating state: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


@socketio.on("connect")
def handle_connect():
    logger.info("Client connected")
    db = next(get_db())
    try:
        state = get_state_from_db(db)
        socketio.emit("state_updated", state, namespace="/")
        logger.debug("Initial state sent to client")
    finally:
        db.close()


@socketio.on("disconnect")
def handle_disconnect():
    logger.info("Client disconnected")


@socketio.on("get_state")
def handle_get_state():
    logger.info("Received get_state request")
    db = next(get_db())
    try:
        state = get_state_from_db(db)
        socketio.emit("state_updated", state, namespace="/")
        logger.debug("State sent in response to get_state request")
    finally:
        db.close()


@socketio.on("state_saved")
def handle_state_saved(state):
    logger.info("Received state_saved event")
    db = next(get_db())
    try:
        save_state_to_db(state, db)
        socketio.emit("state_updated", state, namespace="/")
        logger.debug("State saved and broadcasted")
    finally:
        db.close()


if __name__ == "__main__":
    # Initialize database
    init_db()
    logger.info("Starting server on port 8080")
    socketio.run(app, host="0.0.0.0", port=8080, debug=True)
