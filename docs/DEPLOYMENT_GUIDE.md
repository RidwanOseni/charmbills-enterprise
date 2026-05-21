# CharmBills Deployment & Operations Guide

## Table of Contents

1. [Production Deployment](#production-deployment)
2. [Environment Configuration](#environment-configuration)
3. [Database Management](#database-management)
4. [Monitoring & Observability](#monitoring--observability)
5. [Security Best Practices](#security-best-practices)
6. [Backup & Recovery](#backup--recovery)
7. [Scaling](#scaling)
8. [Troubleshooting](#troubleshooting)

---

## Production Deployment

### Prerequisites

- Docker & Docker Compose
- PostgreSQL 15+
- Node.js 18+ (if not using Docker)
- Bitcoin Core node (or RPC access)
- Domain name with SSL certificate

### Option 1: Docker Deployment (Recommended)

```bash
# 1. Clone repository
git clone https://github.com/RidwanOseni/charmbills.git
cd charmbills

# 2. Configure environment
cp charmbills-backend/.env.example charmbills-backend/.env
cp charmbills-frontend/.env.example charmbills-frontend/.env

# Edit .env files with production values
nano charmbills-backend/.env

# 3. Build and start services
docker-compose up -d

# 4. Run database migrations
docker-compose exec backend npm run db:migrate:prod

# 5. Verify services
docker-compose ps
curl http://localhost:3002/health
```

### Option 2: Manual Deployment

```bash
# 1. Install dependencies
cd charmbills-backend && npm install
cd ../charmbills-frontend && npm install

# 2. Configure environment
cp charmbills-backend/.env.example charmbills-backend/.env
cp charmbills-frontend/.env.example charmbills-frontend/.env

# 3. Setup database
cd charmbills-backend
npm run db:migrate:prod
npm run db:generate

# 4. Build applications
npm run build
cd ../charmbills-frontend
npm run build

# 5. Start with PM2
npm install -g pm2
pm2 start charmbills-backend/dist/index.js --name charmbills-backend
pm2 start npm --name charmbills-frontend -- start
pm2 save
pm2 startup
```

### Option 3: Cloud Deployment

#### AWS Elastic Beanstalk

```bash
# Install EB CLI
pip install awsebcli

# Initialize
eb init -p docker charmbills

# Deploy
eb create charmbills-prod
eb deploy
```

#### Heroku

```bash
# Install Heroku CLI
npm install -g heroku

# Login and create app
heroku login
heroku create charmbills-prod

# Add PostgreSQL
heroku addons:create heroku-postgresql:standard-0

# Deploy
git push heroku main
heroku run npm run db:migrate:prod
```

#### DigitalOcean App Platform

```bash
# Use doctl CLI
doctl apps create --spec .do/app.yaml

# Or use the web UI
# 1. Connect GitHub repository
# 2. Configure build settings
# 3. Add PostgreSQL database
# 4. Deploy
```

---

## Environment Configuration

### Backend Environment Variables

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/charmbills"

# Server
NODE_ENV="production"
PORT=3002

# Authentication
JWT_SECRET="your-super-secret-key-minimum-32-characters"
JWT_EXPIRES_IN="7d"

# Bitcoin RPC
RPC_URL="http://localhost:18332"
RPC_USER="bitcoin"
RPC_PASSWORD="your-rpc-password"

# Charms Configuration
HARDCODED_APP_VK="your-app-verification-key"
APP_BINARY_BASE64="base64-encoded-charm-binary"
PROVER_API_URL="http://prover:8080"

# Monitoring
SENTRY_DSN="https://xxxxx@sentry.io/xxxxx"
SENTRY_TRACES_SAMPLE_RATE="0.1"

# Logging
LOGS_DIR="./logs"
LOG_LEVEL="info"

# Optional: Redis for rate limiting
REDIS_URL="redis://localhost:6379"
```

### Frontend Environment Variables

```bash
NEXT_PUBLIC_API_URL="https://api.charmbills.com"
NEXT_PUBLIC_BITCOIN_NETWORK="mainnet"
NEXT_PUBLIC_SENTRY_DSN="https://xxxxx@sentry.io/xxxxx"
```

### Security Considerations

⚠️ **Never commit `.env` files to version control!**

```bash
# Add to .gitignore
echo ".env" >> .gitignore
echo ".env.local" >> .gitignore
echo ".env.production" >> .gitignore
```

**Use environment variable management:**
- AWS Secrets Manager
- HashiCorp Vault
- Doppler
- Environment variables in hosting platform

---

## Database Management

### Migrations

```bash
# Development: Create and apply migration
npm run db:migrate

# Production: Apply migrations only
npm run db:migrate:prod

# View migration history
npx prisma migrate status

# Rollback (manual)
# Prisma doesn't support automatic rollback
# You'll need to create a new migration that undoes changes
```

### Backup Strategy

#### Daily Automated Backups

```bash
#!/bin/bash
# backup-database.sh

BACKUP_DIR="/var/backups/charmbills"
DATE=$(date +%Y%m%d_%H%M%S)
DB_NAME="charmbills"

# Create backup directory
mkdir -p $BACKUP_DIR

# Dump database
pg_dump -h localhost -U charmbills -F c -b -v -f \
  "$BACKUP_DIR/charmbills_$DATE.backup" $DB_NAME

# Compress
gzip "$BACKUP_DIR/charmbills_$DATE.backup"

# Keep only last 30 days
find $BACKUP_DIR -name "*.backup.gz" -mtime +30 -delete

# Upload to S3 (optional)
aws s3 cp "$BACKUP_DIR/charmbills_$DATE.backup.gz" \
  s3://charmbills-backups/database/
```

**Setup cron job:**
```bash
crontab -e

# Add line:
0 2 * * * /path/to/backup-database.sh
```

#### Restore from Backup

```bash
# Stop application
pm2 stop charmbills-backend

# Restore database
gunzip charmbills_20260104_020000.backup.gz
pg_restore -h localhost -U charmbills -d charmbills -v \
  charmbills_20260104_020000.backup

# Restart application
pm2 start charmbills-backend
```

### Database Optimization

```sql
-- Vacuum and analyze (run weekly)
VACUUM ANALYZE;

-- Reindex (if queries are slow)
REINDEX DATABASE charmbills;

-- Check table sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check index usage
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC;
```

---

## Monitoring & Observability

### Health Checks

```bash
# Application health
curl http://localhost:3002/health

# Database health
curl http://localhost:3002/health/db

# Background jobs health
curl http://localhost:3002/health/jobs
```

### Logging

**View logs:**
```bash
# Docker
docker-compose logs -f backend
docker-compose logs -f frontend

# PM2
pm2 logs charmbills-backend
pm2 logs charmbills-frontend

# Traditional
tail -f /var/log/charmbills/combined.log
tail -f /var/log/charmbills/error.log
```

**Log rotation:**
```bash
# /etc/logrotate.d/charmbills
/var/log/charmbills/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 0644 charmbills charmbills
    sharedscripts
    postrotate
        pm2 reloadLogs
    endscript
}
```

### Monitoring Queries

```sql
-- Active plans by status
SELECT status, COUNT(*) as count
FROM plans
GROUP BY status;

-- Subscriptions created today
SELECT COUNT(*) as subscriptions_today
FROM subscriptions
WHERE DATE(purchased_at) = CURRENT_DATE;

-- Pending transactions
SELECT COUNT(*) as pending_txs
FROM transactions
WHERE status = 'pending'
AND created_at > NOW() - INTERVAL '24 hours';

-- Failed transactions (last 24h)
SELECT COUNT(*) as failed_txs
FROM transactions
WHERE status = 'failed'
AND created_at > NOW() - INTERVAL '24 hours';

-- Top merchants by plans
SELECT merchant_address, COUNT(*) as plan_count
FROM plans
GROUP BY merchant_address
ORDER BY plan_count DESC
LIMIT 10;

-- Average confirmation time
SELECT AVG(EXTRACT(EPOCH FROM (confirmed_at - created_at))/60) as avg_minutes
FROM transactions
WHERE confirmed_at IS NOT NULL
AND created_at > NOW() - INTERVAL '7 days';
```

### Metrics Dashboard

**Grafana + Prometheus Setup:**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'charmbills'
    static_configs:
      - targets: ['localhost:3002']
    metrics_path: '/metrics'
```

**Key Metrics to Track:**
- Request rate (req/s)
- Response time (p50, p95, p99)
- Error rate (%)
- Database query time
- Active connections
- Transaction confirmation rate
- UTXO usage rate
- API key usage

### Sentry Integration

Sentry is already configured in the code. Errors are automatically captured and sent to Sentry.

**View errors:**
1. Login to Sentry.io
2. Navigate to your project
3. View error frequency, stack traces, and user context

**Set up alerts:**
- Email on new error types
- Slack notification for high error rate
- PagerDuty for critical errors

---

## Security Best Practices

### API Security

✅ **Implemented:**
- Helmet.js security headers
- CORS configuration
- Rate limiting
- JWT authentication
- API key authentication
- Input validation
- SQL injection prevention (Prisma)

🔒 **Additional Recommendations:**

```bash
# 1. Use strong JWT secrets
openssl rand -base64 32

# 2. Enable HTTPS only
# In nginx:
server {
    listen 443 ssl http2;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
}

# 3. Implement IP whitelisting (if needed)
# In nginx:
location /api/admin {
    allow 1.2.3.4;
    deny all;
}

# 4. Enable database SSL
DATABASE_URL="postgresql://user:pass@host:5432/db?sslmode=require"
```

### Bitcoin Security

- **Never store private keys on server**
- Use hardware wallets for merchant keys
- Implement multi-sig for high-value operations
- Monitor mempool for double-spend attempts
- Set up alerts for unusual transaction patterns

### Secrets Management

```bash
# AWS Secrets Manager
aws secretsmanager create-secret \
  --name charmbills/database \
  --secret-string '{"username":"user","password":"pass"}'

# Retrieve in code:
const secret = await secretsManager
  .getSecretValue({ SecretId: 'charmbills/database' })
  .promise();
```

---

## Backup & Recovery

### What to Backup

1. **Database** (Critical)
   - Daily automated backups
   - Stored offsite (S3, GCS)
   - Test restore monthly

2. **Environment Variables** (Critical)
   - Store encrypted in password manager
   - Document all variables

3. **Application Code** (Version controlled)
   - Git repository
   - Tagged releases

4. **Logs** (Optional)
   - Keep 30-90 days
   - Important for debugging

### Disaster Recovery Plan

**RTO (Recovery Time Objective):** 1 hour
**RPO (Recovery Point Objective):** 24 hours

**Recovery Steps:**

1. **Database Corruption:**
```bash
# Restore from latest backup
pg_restore -d charmbills latest_backup.sql
pm2 restart charmbills-backend
```

2. **Application Crash:**
```bash
# Check logs
pm2 logs charmbills-backend --lines 100

# Restart
pm2 restart charmbills-backend

# If persists, rollback deployment
git checkout <previous-tag>
npm install
npm run build
pm2 restart all
```

3. **Complete Server Loss:**
```bash
# 1. Provision new server
# 2. Install dependencies (Docker, Node, etc.)
# 3. Clone repository
git clone https://github.com/RidwanOseni/charmbills.git

# 4. Restore environment variables
# (from secrets management)

# 5. Restore database
pg_restore -d charmbills s3://backups/latest.sql

# 6. Deploy application
docker-compose up -d
```

---

## Scaling

### Vertical Scaling

**When to scale:**
- CPU > 70% consistently
- Memory > 80% consistently
- Database connections maxed out
- Response time > 500ms

**Recommended specs by usage:**

| Users/Day | Backend | Database | Frontend |
|-----------|---------|----------|----------|
| < 1,000 | 1 vCPU, 2GB RAM | 1 vCPU, 2GB RAM | 1 vCPU, 1GB RAM |
| 1,000-10,000 | 2 vCPU, 4GB RAM | 2 vCPU, 4GB RAM | 2 vCPU, 2GB RAM |
| 10,000-100,000 | 4 vCPU, 8GB RAM | 4 vCPU, 16GB RAM | 4 vCPU, 4GB RAM |
| 100,000+ | Horizontal scaling required | Read replicas | CDN + multiple instances |

### Horizontal Scaling

**Load Balancer (Nginx):**

```nginx
upstream charmbills_backend {
    server backend1:3002;
    server backend2:3002;
    server backend3:3002;
}

server {
    listen 80;
    server_name api.charmbills.com;

    location / {
        proxy_pass http://charmbills_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Database Read Replicas:**

```javascript
// Prisma with read replicas
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// For read-heavy queries
const readReplica = new PrismaClient({
  datasources: {
    db: {
      url: process.env.READ_REPLICA_URL,
    },
  },
});
```

**Redis for Rate Limiting:**

Replace in-memory rate limiting with Redis for distributed systems:

```javascript
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);

// Store rate limit counters in Redis
```

---

## Troubleshooting

### Common Issues

#### 1. Database Connection Errors

**Symptom:** `Error: Can't reach database server`

**Solution:**
```bash
# Check database is running
docker-compose ps postgres
pg_isready -h localhost -p 5432

# Check connection string
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL
```

#### 2. High Memory Usage

**Symptom:** Application crashes with out-of-memory

**Solution:**
```bash
# Check memory usage
docker stats

# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" npm start

# Check for memory leaks
node --inspect dist/index.js
# Use Chrome DevTools > Memory
```

#### 3. Slow API Responses

**Symptom:** Response time > 1s

**Solution:**
```sql
-- Find slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Add missing indexes
CREATE INDEX idx_plans_merchant ON plans(merchant_address);
CREATE INDEX idx_transactions_status ON transactions(status);
```

#### 4. Transaction Broadcasting Fails

**Symptom:** `sendrawtransaction RPC error`

**Solution:**
```bash
# Check Bitcoin node connection
bitcoin-cli -testnet getblockchaininfo

# Verify transaction hex
bitcoin-cli -testnet decoderawtransaction <hex>

# Check mempool
bitcoin-cli -testnet getmempoolinfo

# Verify sufficient fees
bitcoin-cli -testnet estimatesmartfee 6
```

#### 5. Background Job Not Running

**Symptom:** Transactions not confirming automatically

**Solution:**
```bash
# Check if process is running
pm2 list

# Check logs for errors
pm2 logs charmbills-backend | grep "confirmation monitor"

# Restart application
pm2 restart charmbills-backend
```

### Debug Mode

Enable verbose logging:

```bash
LOG_LEVEL=debug npm start
```

### Support Channels

- **GitHub Issues:** https://github.com/RidwanOseni/charmbills/issues
- **Discord:** https://discord.gg/charmbills
- **Email:** support@charmbills.com

---

## Maintenance Schedule

### Daily
- Monitor error rates
- Check disk space
- Review failed transactions

### Weekly
- Database vacuum and analyze
- Review slow query logs
- Update dependencies (security patches)

### Monthly
- Full backup restore test
- Security audit
- Performance optimization review
- Update documentation

### Quarterly
- Dependency updates (major versions)
- Infrastructure cost optimization
- Disaster recovery drill
- Security penetration testing

---

## Appendix

### Useful Commands

```bash
# Check all services status
docker-compose ps
pm2 status

# View resource usage
docker stats
htop

# Database size
psql -U charmbills -d charmbills -c \
  "SELECT pg_size_pretty(pg_database_size('charmbills'));"

# Restart everything
docker-compose restart
pm2 restart all

# View logs (last 100 lines)
docker-compose logs --tail=100 backend
pm2 logs charmbills-backend --lines 100

# Run migrations
docker-compose exec backend npm run db:migrate:prod

# Open database shell
docker-compose exec postgres psql -U charmbills

# Backup database
docker-compose exec postgres pg_dump -U charmbills -F c \
  charmbills > backup.dump
```

### Performance Benchmarks

Expected performance on recommended hardware:

- **Request rate:** 1000 req/s
- **Response time (p95):** < 200ms
- **Database queries:** < 50ms
- **Transaction broadcasting:** < 2s
- **Confirmation monitoring:** Every 2 minutes

---

**Last Updated:** January 4, 2026
**Version:** 1.0.0
