# Speed Chat Backend

This is the backend service for Speed Chat, providing state synchronization across multiple clients using AWS DynamoDB.

## Prerequisites

- AWS CLI installed and configured
- AWS SAM CLI installed
- Python 3.9 or later

## Deployment

1. Build the application:
```bash
sam build
```

2. Deploy the application:
```bash
sam deploy --guided
```

During the guided deployment, you'll be asked several questions:
- Stack Name: Choose a name for your stack (e.g., speed-chat-backend)
- AWS Region: Choose your preferred region
- Confirm changes before deploy: Yes
- Allow SAM CLI IAM role creation: Yes
- Save arguments to configuration file: Yes
- SAM configuration file: Accept the default
- SAM configuration environment: Accept the default

## API Endpoints

After deployment, you'll get an API endpoint URL. The following endpoints will be available:

- GET /state - Retrieve the current state
- POST /state - Update the current state

### State Update Format

When updating state, send a POST request with the following JSON body:
```json
{
    "state": {
        // Your state object here
    },
    "lastModified": "2024-03-21T12:00:00Z" // ISO 8601 timestamp
}
```

## Local Development

To run the application locally:

1. Start the local API:
```bash
sam local start-api
```

2. The API will be available at http://localhost:3000

## Testing

To test the functions locally:

```bash
sam local invoke GetStateFunction
sam local invoke UpdateStateFunction --event events/event.json
```

## Cleanup

To delete the deployed stack:

```bash
sam delete
```
