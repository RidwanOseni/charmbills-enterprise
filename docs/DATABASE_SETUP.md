# CharmBills - Database Integration Setup Guide

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 15+ (or Docker)
- Bitcoin testnet4 node with RPC access
- Rust toolchain (for compiling subscription-engine)

---

## 📦 Installation

### 1. Clone and Install Dependencies

```bash
cd charmbills

# Install backend dependencies
cd charmbills-backend
npm install

# Install frontend dependencies
cd ../charmbills-frontend
npm install
```

### 2. Database Setup

#### Option A: Local PostgreSQL

```bash
# Create database
createdb charmbills

# Or using psql
psql -U postgres
CREATE DATABASE charmbills;
\q
```

#### Option B: Docker PostgreSQL

```bash
docker run --name charmbills-postgres \
  -e POSTGRES_DB=charmbills \
  -e POSTGRES_USER=charmbills_user \
  -e POSTGRES_PASSWORD=secure_password_here \
  -p 5432:5432 \
  -d postgres:15-alpine
```

### 3. Environment Configuration

```bash
# Backend configuration
cp .env.example charmbills-backend/.env

# Edit charmbills-backend/.env with your values:
# - DATABASE_URL (PostgreSQL connection string)
# - RPC_USER and RPC_PASSWORD (Bitcoin node credentials)
# - APP_BINARY_BASE64 (compiled Rust binary)

# Frontend configuration
cp charmbills-frontend/.env.example charmbills-frontend/.env
```

### 4. Run Database Migrations

```bash
cd charmbills-backend

# Generate Prisma Client
npm run db:generate

# Run migrations to create database schema
npm run db:migrate

# View database (optional)
npm run db:studio
```

---

## 🏃 Running the Application

### Development Mode

```bash
# Terminal 1: Backend
cd charmbills-backend
npm run start:backend

# Terminal 2: Frontend
cd charmbills-frontend
npm run dev
```

Access the application:
- Frontend: http://localhost:3000
- Backend API: http://localhost:3002
- Health Check: http://localhost:3002/health

### Production Mode with Docker

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

---

## 🗄️ Database Schema

### Tables

**plans** - Merchant-created subscription plans (NFT authorities)
- Stores plan metadata, pricing, billing cycles
- Tracks NFT UTXO and app ID
- Status: pending_signature → pending_confirmation → active

**subscriptions** - Customer subscription instances (tokens)
- Links to parent plan
- Tracks token UTXO and expiration
- Status: pending → active → expired

**transactions** - Full audit trail
- Stores commit/spell transaction hex
- Tracks confirmation status
- Links to plans for updates

**used_utxos** - Double-spend prevention
- Tracks which UTXOs have been selected for use
- Prevents race conditions across devices
- Cleanup job removes old unconfirmed entries

---

## 🔄 Data Migration

### Migrating from localStorage

The application automatically migrates existing localStorage data to the database on first login:

1. Connect wallet
2. System detects old `charm_subscriptions` in localStorage
3. Migrates each plan to database
4. Clears localStorage after successful migration

Manual migration via API:
```bash
curl -X POST http://localhost:3002/api/plans/migrate \
  -H "Content-Type: application/json" \
  -d '{
    "merchantAddress": "tb1q...",
    "serviceName": "Pro Plan",
    "priceBTC": 0.001,
    "billingCycle": "monthly",
    "nftUtxoId": "abc123:0"
  }'
```

---

## 🛠️ API Endpoints

### Plans
- `GET /api/plans?merchantAddress=tb1q...` - Get all plans for merchant
- `GET /api/plans/:id` - Get specific plan
- `POST /api/plans/mint` - Create new Plan NFT
- `PATCH /api/plans/:id` - Update plan (after confirmation)
- `POST /api/plans/migrate` - Migrate from localStorage

### UTXOs
- `POST /api/utxos/mark-used` - Mark UTXO as used
- `GET /api/utxos/is-used?utxoId=txid:vout` - Check if UTXO is used
- `GET /api/utxos/list` - List all used UTXOs
- `POST /api/utxos/confirm` - Confirm UTXO after tx confirms
- `DELETE /api/utxos/cleanup?hoursAgo=24` - Cleanup old UTXOs

### Subscriptions
- `POST /api/subscriptions/mint` - Mint subscription token

### Transactions
- `POST /api/broadcast-package` - Broadcast signed transaction package

---

## 🔍 Monitoring & Maintenance

### Background Jobs

**Transaction Confirmation Monitor** (runs every 2 minutes)
- Checks pending transactions on mempool.space
- Updates confirmation status
- Activates plans after confirmation
- Auto-starts with backend server

**UTXO Cleanup** (runs daily)
- Removes unconfirmed UTXOs older than 48 hours
- Marks unsigned transactions as failed

### Database Maintenance

```bash
# View database in browser
npm run db:studio

# Create new migration after schema changes
npm run db:migrate

# Deploy migrations in production
npm run db:migrate:prod

# Backup database
pg_dump charmbills > backup.sql

# Restore database
psql charmbills < backup.sql
```

### Monitoring Queries

```sql
-- Check system health
SELECT 
  'plans' as table_name, COUNT(*) as count FROM plans
UNION ALL
SELECT 'subscriptions', COUNT(*) FROM subscriptions
UNION ALL
SELECT 'transactions', COUNT(*) FROM transactions
UNION ALL
SELECT 'used_utxos', COUNT(*) FROM used_utxos;

-- Pending transactions
SELECT * FROM transactions 
WHERE status = 'pending' 
ORDER BY created_at DESC;

-- Active plans
SELECT service_name, merchant_address, remaining_supply
FROM plans 
WHERE status = 'active';

-- Recent activity
SELECT type, status, created_at 
FROM transactions 
ORDER BY created_at DESC 
LIMIT 10;
```

---

## 🐛 Troubleshooting

### Database Connection Issues

```bash
# Check if PostgreSQL is running
psql -U charmbills_user -d charmbills -c "SELECT 1"

# Check DATABASE_URL format
echo $DATABASE_URL
# Should be: postgresql://user:password@host:port/database
```

### Migration Errors

```bash
# Reset database (⚠️ destroys data)
npx prisma migrate reset

# Push schema without migration
npx prisma db push
```

### UTXO Conflicts

If you see "No fresh UTXOs available":
1. Check wallet balance on mempool.space
2. Wait for pending transactions to confirm
3. Clear UTXO cache: `api.utxos.cleanup(0)` in browser console
4. Send more testnet BTC to wallet

### Frontend Can't Connect to Backend

1. Verify backend is running: `curl http://localhost:3002/health`
2. Check CORS settings in backend
3. Verify `NEXT_PUBLIC_API_URL` in frontend `.env`

---

## 📚 Additional Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [Charms Protocol](https://charms.dev)
- [Bitcoin Testnet4 Faucet](https://mempool.space/testnet4/faucet)
- [Leather Wallet](https://leather.io)

---

## 🎯 What Changed

### Before (localStorage)
- ❌ Data lost on browser clear
- ❌ Single device only
- ❌ No backup/recovery
- ❌ No analytics
- ❌ Race conditions with UTXOs

### After (Database)
- ✅ Persistent data storage
- ✅ Multi-device sync
- ✅ Automatic backups
- ✅ Rich analytics
- ✅ Atomic UTXO management
- ✅ Transaction monitoring
- ✅ Audit trail

---

## 💡 Next Steps

1. **Security**: Add API authentication (JWT/API keys)
2. **Monitoring**: Integrate Sentry for error tracking
3. **Analytics**: Add dashboard with charts
4. **Automation**: Implement subscription renewal system
5. **Scaling**: Add Redis for caching

---

Need help? Check the [Issues](https://github.com/RidwanOseni/charmbills/issues) page or create a new issue.
