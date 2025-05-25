import json
import os
from datetime import datetime

import boto3
from dateutil import parser

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])


def get_state(event, context):
    try:
        response = table.get_item(Key={"id": "current_state"})

        if "Item" not in response:
            return {
                "statusCode": 404,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                },
                "body": json.dumps({"message": "No state found"}),
            }

        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            },
            "body": json.dumps(response["Item"]["state"]),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            },
            "body": json.dumps({"message": str(e)}),
        }


def update_state(event, context):
    try:
        body = json.loads(event["body"])
        state = body.get("state")
        last_modified = body.get("lastModified")

        if not state or not last_modified:
            return {
                "statusCode": 400,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                },
                "body": json.dumps({"message": "Missing required fields"}),
            }

        # Convert last_modified to datetime for comparison
        client_last_modified = parser.parse(last_modified)

        # Get current state to check version
        current_state = table.get_item(Key={"id": "current_state"})

        if "Item" in current_state:
            current_last_modified = parser.parse(current_state["Item"]["lastModified"])
            if client_last_modified < current_last_modified:
                return {
                    "statusCode": 409,
                    "headers": {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Headers": "Content-Type",
                        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                    },
                    "body": json.dumps(
                        {
                            "message": "State is out of date",
                            "currentState": current_state["Item"]["state"],
                        }
                    ),
                }

        # Update state
        now = datetime.utcnow().isoformat()
        table.put_item(
            Item={"id": "current_state", "state": state, "lastModified": now}
        )

        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            },
            "body": json.dumps(
                {"message": "State updated successfully", "lastModified": now}
            ),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            },
            "body": json.dumps({"message": str(e)}),
        }
