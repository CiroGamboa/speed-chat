import logging
import os
import time
from contextlib import contextmanager
from typing import Any, Dict

from database import Config, GeneralWaitQueue, Line, Person, get_db, init_db
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO
from sqlalchemy.exc import DisconnectionError, OperationalError
from sqlalchemy.orm import Session

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Initialize database at module level
init_db()
logger.info("Database initialized")

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    logger=True,
    engineio_logger=True,
    async_mode="threading",
    ping_timeout=60,
    ping_interval=25,
)

# Global state version for conflict resolution
current_state_version = 0


@contextmanager
def get_db_with_retry(max_retries=3, delay=1):
    """Get database session with retry logic for connection issues"""
    for attempt in range(max_retries):
        try:
            db = next(get_db())
            yield db
            break
        except (OperationalError, DisconnectionError) as e:
            logger.warning(f"Database connection attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(delay * (attempt + 1))  # Exponential backoff
            else:
                logger.error("All database connection attempts failed")
                raise
        finally:
            try:
                db.close()
            except:
                pass


def get_state_from_db(db: Session) -> Dict[str, Any]:
    global current_state_version

    try:
        config = db.query(Config).first()
        if not config:
            config = Config()
            db.add(config)
            db.commit()
            db.refresh(config)

        lines = db.query(Line).all()
        lines_data = []
        for line in lines:
            people_data = [
                {"id": person.id, "name": person.name} for person in line.people
            ]
            lines_data.append(
                {
                    "id": line.id,
                    "name": line.name,
                    "time": line.time,
                    "people": people_data,
                }
            )

        # Get general wait queue
        general_wait_queue = db.query(GeneralWaitQueue).all()
        wait_queue_data = [
            {"id": person.id, "name": person.name} for person in general_wait_queue
        ]

        # Don't increment version on read operations
        return {
            "version": current_state_version,
            "timestamp": time.time(),
            "config": {
                "sessionDuration": config.session_duration,
                "alarmInterval": config.alarm_interval,
                "maxPeoplePerLine": config.max_people_per_line,
                "blinkBeforeStart": config.blink_before_start,
                "blinkTime": config.blink_time,
                "finishWindow": config.finish_window,
                "autoReschedule": config.auto_reschedule,
                "lines": lines_data,
                "generalWaitQueue": wait_queue_data,
            },
        }
    except Exception as e:
        logger.error(f"Error getting state from database: {e}")
        raise


def save_state_to_db(state: Dict[str, Any], db: Session, client_version: int = None):
    global current_state_version

    # Only check for conflicts if client version is significantly behind (more than 5 versions)
    # This allows for normal user actions without triggering conflicts
    if client_version is not None and client_version < current_state_version - 5:
        logger.warning(
            f"State version conflict: client={client_version}, server={current_state_version}"
        )
        raise ValueError("State is outdated. Please refresh and try again.")

    try:
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

        # Update general wait queue
        existing_wait_queue = {p.id: p for p in db.query(GeneralWaitQueue).all()}
        new_wait_queue = config_data.get("generalWaitQueue", [])

        # Remove wait queue people that are no longer in the queue
        for person_id in list(existing_wait_queue.keys()):
            if not any(p["id"] == person_id for p in new_wait_queue):
                db.delete(existing_wait_queue[person_id])

        # Add new wait queue people
        for person_data in new_wait_queue:
            if person_data["id"] not in existing_wait_queue:
                wait_queue_person = GeneralWaitQueue(name=person_data["name"])
                db.add(wait_queue_person)

        db.commit()
        # Increment version only after successful save
        current_state_version += 1

        logger.info(f"State saved successfully. New version: {current_state_version}")

    except Exception as e:
        db.rollback()
        logger.error(f"Error saving state to database: {e}")
        raise


@app.route("/state", methods=["GET"])
def get_state():
    try:
        with get_db_with_retry() as db:
            state = get_state_from_db(db)
            logger.debug(f"GET /state returning: {state}")
            return jsonify(state)
    except Exception as e:
        logger.error(f"Error in get_state: {e}")
        return jsonify({"error": "Failed to get state"}), 500


@app.route("/state", methods=["POST"])
def update_state():
    try:
        state = request.json
        client_version = state.get("version")
        logger.debug(f"POST /state received: {state}")

        with get_db_with_retry() as db:
            save_state_to_db(state, db, client_version)
            # Return updated state with new version
            updated_state = get_state_from_db(db)
            return jsonify({"status": "success", "state": updated_state})
    except ValueError as e:
        logger.warning(f"State version conflict: {e}")
        return jsonify({"status": "conflict", "message": str(e)}), 409
    except Exception as e:
        logger.error(f"Error updating state: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


@socketio.on("connect")
def handle_connect():
    logger.info("Client connected")
    try:
        with get_db_with_retry() as db:
            state = get_state_from_db(db)
            socketio.emit("state_updated", state, namespace="/")
            logger.debug("Initial state sent to client")
    except Exception as e:
        logger.error(f"Error sending initial state: {e}")
        socketio.emit(
            "connection_error",
            {"message": "Failed to load initial state"},
            namespace="/",
        )


@socketio.on("disconnect")
def handle_disconnect():
    logger.info("Client disconnected")


@socketio.on("get_state")
def handle_get_state():
    logger.info("Received get_state request")
    try:
        with get_db_with_retry() as db:
            state = get_state_from_db(db)
            socketio.emit("state_updated", state, namespace="/")
            logger.debug("State sent in response to get_state request")
    except Exception as e:
        logger.error(f"Error handling get_state: {e}")
        socketio.emit("state_error", {"message": "Failed to get state"}, namespace="/")


@socketio.on("state_saved")
def handle_state_saved(state):
    logger.info("Received state_saved event")
    try:
        client_version = state.get("version")
        with get_db_with_retry() as db:
            save_state_to_db(state, db, client_version)
            # Get updated state and broadcast to all clients
            updated_state = get_state_from_db(db)
            # Broadcast to all clients including the sender to ensure sync
            socketio.emit("state_updated", updated_state, namespace="/")
            logger.debug("State saved and broadcasted to all clients")
    except ValueError as e:
        logger.warning(f"State version conflict in WebSocket: {e}")
        socketio.emit("state_conflict", {"message": str(e)}, namespace="/")
    except Exception as e:
        logger.error(f"Error handling state_saved: {e}")
        socketio.emit("state_error", {"message": "Failed to save state"}, namespace="/")


if __name__ == "__main__":
    logger.info("Starting server on port 8080")
    socketio.run(app, host="0.0.0.0", port=8080, debug=True)
