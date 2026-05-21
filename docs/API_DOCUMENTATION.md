# CharmBills API Documentation

## Overview

CharmBills is a Bitcoin subscription platform built on the Charms protocol. This API allows merchants to create subscription plans and customers to mint subscription tokens.

**Base URL:** `http://localhost:3002`
**Network:** Bitcoin Testnet4

---

## Table of Contents

1. [Authentication](#authentication)
2. [Plans API](#plans-api)
3. [Subscriptions API](#subscriptions-api)
4. [UTXO Management](#utxo-management)
5. [Transaction Broadcasting](#transaction-broadcasting)
6. [Error Handling](#error-handling)
7. [Rate Limits](#rate-limits)

---

## Authentication

CharmBills supports two authentication methods:

### 1. JWT Bearer Token

```http
Authorization: Bearer <jwt_token>
```

### 2. API Key

```http
X-API-Key: <api_key>
```

### Login

**POST** `/api/auth/login`

Generate a JWT token for a merchant.

**Request Body:**
```json
{
  "address": "bc1qtest123...",
  "signature": "optional_bitcoin_signature",
  "message": "optional_message"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "merchant": {
    "id": "uuid",
    "address": "bc1qtest123...",
    "name": null,
    "email": null
  }
}
```

### Create API Key

**POST** `/api/auth/api-keys`

Create a new API key (requires JWT authentication).

**Headers:**
```http
Authorization: Bearer <jwt_token>
```

**Request Body:**
```json
{
  "name": "My API Key",
  "expiresInDays": 90
}
```

**Response:**
```json
{
  "success": true,
  "apiKey": {
    "id": "uuid",
    "key": "64-character-hex-key",
    "name": "My API Key",
    "expiresAt": "2026-04-04T00:00:00.000Z",
    "createdAt": "2026-01-04T00:00:00.000Z"
  },
  "warning": "Save this API key securely. It will not be shown again."
}
```

### Get Merchant Profile

**GET** `/api/auth/me`

Get current merchant profile.

**Headers:**
```http
Authorization: Bearer <jwt_token>
OR
X-API-Key: <api_key>
```

**Response:**
```json
{
  "success": true,
  "merchant": {
    "id": "uuid",
    "address": "bc1qtest123...",
    "name": "Merchant Name",
    "email": "merchant@example.com",
    "isActive": true,
    "activeApiKeys": 2,
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

### Update Merchant Profile

**PATCH** `/api/auth/me`

Update merchant profile information.

**Headers:**
```http
Authorization: Bearer <jwt_token>
```

**Request Body:**
```json
{
  "name": "Updated Name",
  "email": "updated@example.com"
}
```

### List API Keys

**GET** `/api/auth/api-keys`

List all API keys for authenticated merchant.

**Response:**
```json
{
  "success": true,
  "apiKeys": [
    {
      "id": "uuid",
      "name": "My API Key",
      "isActive": true,
      "expiresAt": "2026-04-04T00:00:00.000Z",
      "lastUsedAt": "2026-01-04T12:00:00.000Z",
      "createdAt": "2026-01-04T00:00:00.000Z"
    }
  ]
}
```

### Revoke API Key

**DELETE** `/api/auth/api-keys/:keyId`

Revoke an API key (soft delete).

---

## Plans API

Plans represent subscription offerings created by merchants.

### Create Plan (Mint NFT)

**POST** `/api/plans/mint`

Create a new subscription plan by minting an NFT authority.

**Authentication:** Required (JWT or API Key)

**Request Body:**
```json
{
  "serviceName": "Premium Newsletter",
  "priceBtc": 0.001,
  "billingCycle": "monthly",
  "ticker": "PREM",
  "merchantAddress": "bc1qmerchant...",
  "fundingUtxo": {
    "txid": "abc123...",
    "vout": 0,
    "value": 10000
  },
  "appVk": "verification_key_hex",
  "metadata": {
    "description": "Monthly premium content",
    "benefits": ["Ad-free", "Early access"]
  }
}
```

**Response:**
```json
{
  "planId": "uuid",
  "transactionId": "uuid",
  "commitTxHex": "020000000...",
  "spellTxHex": "020000000...",
  "appId": "app_id_hex",
  "message": "Plan created. Sign and broadcast transactions to activate."
}
```

### Get All Plans

**GET** `/api/plans`

Retrieve all plans for authenticated merchant.

**Authentication:** Required (JWT or API Key)

**Query Parameters:**
- `status` (optional): Filter by status (pending_signature, pending, active, inactive)

**Response:**
```json
[
  {
    "id": "uuid",
    "merchantAddress": "bc1qmerchant...",
    "serviceName": "Premium Newsletter",
    "priceBtc": "0.00100000",
    "billingCycle": "monthly",
    "ticker": "PREM",
    "status": "active",
    "remainingSupply": 100000,
    "nftUtxoId": "txid:vout",
    "appId": "app_id_hex",
    "appVk": "verification_key_hex",
    "metadata": {},
    "createdAt": "2026-01-04T00:00:00.000Z",
    "updatedAt": "2026-01-04T00:00:00.000Z",
    "_count": {
      "subscriptions": 42
    }
  }
]
```

### Get Plan by ID

**GET** `/api/plans/:id`

Retrieve a specific plan with its subscriptions.

**Authentication:** Optional (public endpoint for plan details)

**Response:**
```json
{
  "id": "uuid",
  "merchantAddress": "bc1qmerchant...",
  "serviceName": "Premium Newsletter",
  "priceBtc": "0.00100000",
  "billingCycle": "monthly",
  "ticker": "PREM",
  "status": "active",
  "remainingSupply": 99958,
  "nftUtxoId": "txid:vout",
  "appId": "app_id_hex",
  "appVk": "verification_key_hex",
  "metadata": {},
  "createdAt": "2026-01-04T00:00:00.000Z",
  "updatedAt": "2026-01-04T00:00:00.000Z",
  "subscriptions": [
    {
      "id": "uuid",
      "subscriberAddress": "bc1qsubscriber...",
      "tokenUtxoId": "txid:vout",
      "tokenAmount": 1,
      "status": "active",
      "purchasedAt": "2026-01-04T12:00:00.000Z"
    }
  ]
}
```

### Update Plan

**PATCH** `/api/plans/:id`

Update a plan (typically after transaction confirmation).

**Authentication:** Required (JWT or API Key)

**Request Body:**
```json
{
  "status": "active",
  "nftUtxoId": "txid:vout",
  "remainingSupply": 99999
}
```

### Migrate Plan from localStorage

**POST** `/api/plans/migrate`

One-time migration of a plan from localStorage to database.

**Authentication:** Required (JWT or API Key)

**Request Body:**
```json
{
  "plan": {
    "id": "uuid",
    "serviceName": "Premium Newsletter",
    "priceBtc": 0.001,
    "merchantAddress": "bc1qmerchant...",
    ...
  }
}
```

---

## Subscriptions API

### Mint Subscription Token

**POST** `/api/subscriptions/mint`

Mint a subscription token for a customer.

**Authentication:** Required (JWT or API Key)

**Request Body:**
```json
{
  "planId": "uuid",
  "subscriberAddress": "bc1qsubscriber...",
  "nftUtxo": {
    "txid": "plan_nft_txid",
    "vout": 0,
    "value": 1000
  },
  "fundingUtxo": {
    "txid": "funding_txid",
    "vout": 0,
    "value": 10000
  },
  "appVk": "verification_key_hex"
}
```

**Response:**
```json
{
  "subscriptionId": "uuid",
  "commitTxHex": "020000000...",
  "spellTxHex": "020000000...",
  "message": "Subscription token ready. Sign and broadcast to activate."
}
```

---

## UTXO Management

Prevent double-spending of UTXOs across multiple devices.

### Mark UTXO as Used

**POST** `/api/utxos/mark-used`

Mark a UTXO as used before creating a transaction.

**Authentication:** Required

**Request Body:**
```json
{
  "utxoId": "txid:vout",
  "usedBy": "transaction_id",
  "markedBy": "bc1qaddress..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "UTXO marked as used"
}
```

### Check if UTXO is Used

**GET** `/api/utxos/is-used`

Check if a UTXO has already been marked as used.

**Query Parameters:**
- `utxoId`: UTXO identifier (txid:vout)

**Response:**
```json
{
  "utxoId": "txid:vout",
  "isUsed": true,
  "usedAt": "2026-01-04T12:00:00.000Z",
  "usedBy": "transaction_id"
}
```

### List Used UTXOs

**GET** `/api/utxos/list`

List all used UTXOs (admin only).

**Authentication:** Required

**Query Parameters:**
- `confirmed` (optional): Filter by confirmation status (true/false)
- `limit` (optional): Limit results (default: 100)

**Response:**
```json
{
  "utxos": [
    {
      "utxoId": "txid:vout",
      "usedAt": "2026-01-04T12:00:00.000Z",
      "usedBy": "transaction_id",
      "confirmed": true,
      "markedBy": "bc1qaddress..."
    }
  ]
}
```

### Confirm UTXO

**POST** `/api/utxos/confirm`

Mark a UTXO as confirmed after transaction confirms.

**Authentication:** Required

**Request Body:**
```json
{
  "utxoId": "txid:vout"
}
```

### Cleanup Old UTXOs

**DELETE** `/api/utxos/cleanup`

Remove old unconfirmed UTXOs (48+ hours old).

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "deleted": 5,
  "message": "Cleaned up 5 old UTXOs"
}
```

---

## Transaction Broadcasting

### Broadcast Transaction Package

**POST** `/api/broadcast-package`

Broadcast signed commit and spell transactions to Bitcoin network.

**Authentication:** Required

**Rate Limit:** 10 requests/minute per merchant

**Request Body:**
```json
{
  "commitTxHex": "signed_commit_tx_hex",
  "spellTxHex": "signed_spell_tx_hex",
  "planId": "uuid",
  "type": "mint-nft"
}
```

**Response:**
```json
{
  "success": true,
  "commitTxid": "abc123...",
  "spellTxid": "def456...",
  "message": "Transactions broadcast successfully. Monitoring for confirmations."
}
```

---

## Error Handling

All errors follow a consistent format:

```json
{
  "error": "Error message",
  "statusCode": 400,
  "timestamp": "2026-01-04T12:00:00.000Z",
  "path": "/api/plans/mint"
}
```

### Common HTTP Status Codes

- **200 OK**: Request successful
- **400 Bad Request**: Invalid request data
- **401 Unauthorized**: Missing or invalid authentication
- **403 Forbidden**: Authenticated but not authorized
- **404 Not Found**: Resource not found
- **429 Too Many Requests**: Rate limit exceeded
- **500 Internal Server Error**: Server error

### Common Error Messages

- `"No authorization header provided"` - Missing authentication
- `"Invalid token"` - JWT token is invalid or expired
- `"Invalid API key"` - API key not found or inactive
- `"Too many requests"` - Rate limit exceeded
- `"Record not found"` - Plan or subscription doesn't exist
- `"UTXO already used"` - Attempted double-spend

---

## Rate Limits

Different endpoints have different rate limits:

### General API Endpoints
- **Limit:** 100 requests per 15 minutes per IP
- **Headers:**
  - `X-RateLimit-Limit`: Maximum requests allowed
  - `X-RateLimit-Remaining`: Requests remaining
  - `X-RateLimit-Reset`: Unix timestamp when limit resets

### Authentication Endpoints
- **Limit:** 5 requests per 15 minutes per IP
- Applies to: `/api/auth/login`

### Plan Creation
- **Limit:** 20 plans per hour per merchant
- Applies to: `/api/plans/mint`

### Transaction Broadcasting
- **Limit:** 10 requests per minute per merchant
- Applies to: `/api/broadcast-package`

When rate limit is exceeded, you'll receive a `429` response:

```json
{
  "error": "Too many requests, please try again later"
}
```

**Response Headers:**
- `Retry-After`: Seconds to wait before retrying

---

## Webhook Events (Coming Soon)

CharmBills will support webhooks for:

- `plan.confirmed` - Plan NFT transaction confirmed
- `subscription.created` - New subscription minted
- `subscription.expired` - Subscription expired
- `payment.received` - Payment detected

---

## SDKs and Libraries

### JavaScript/TypeScript

```bash
npm install @charmbills/sdk
```

```typescript
import { CharmBills } from '@charmbills/sdk';

const client = new CharmBills({
  apiKey: 'your-api-key',
  network: 'testnet'
});

// Create a plan
const plan = await client.plans.create({
  serviceName: 'Premium Service',
  priceBtc: 0.001,
  billingCycle: 'monthly'
});
```

### Python

```bash
pip install charmbills
```

```python
from charmbills import CharmBills

client = CharmBills(api_key='your-api-key', network='testnet')

# Create a plan
plan = client.plans.create(
    service_name='Premium Service',
    price_btc=0.001,
    billing_cycle='monthly'
)
```

---

## Support

- **Documentation:** https://docs.charmbills.com
- **GitHub:** https://github.com/RidwanOseni/charmbills
- **Discord:** https://discord.gg/charmbills
- **Email:** support@charmbills.com

---

## Changelog

### v1.0.0 (2026-01-04)
- Initial API release
- JWT and API Key authentication
- Plan and subscription management
- UTXO tracking
- Transaction broadcasting
- Rate limiting
- Error tracking with Sentry
