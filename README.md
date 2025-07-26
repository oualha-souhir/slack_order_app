# Slack Order App

This project is a Slack-integrated order management application. It allows users to manage orders, payments, reports, and notifications directly from Slack, leveraging a Node.js backend and various APIs.

## Features

- Order management via Slack commands and interactions
- Payment processing and tracking
- Daily and custom reporting
- Integration with Excel for data export/import
- User role and permission management
- Notification system for order and payment events

## Project Structure

```
slack_order_app/
├── src/
│   ├── database/           # Database utilities and models
│   ├── functions/          # Azure Functions APIs (Slack, Reports, etc.)
│   ├── Handlers/           # Slack event and action handlers
│   └── services/           # Business logic and integrations
├── coverage/               # Test coverage reports
├── package.json            # Project dependencies and scripts
├── host.json               # Azure Functions host configuration
├── README.md               # Project documentation
```

## Getting Started

### Prerequisites

- Node.js (v16 or higher recommended)
- npm
- Azure Functions Core Tools (for local development)
- A Slack App with necessary permissions

## Deployment

- This code has been deployed to Azure Functions.


