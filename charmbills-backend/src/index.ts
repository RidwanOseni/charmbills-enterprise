import express from 'express';
import cors from 'cors';
import { createPayrollPlan, getPlans, getPlanById } from './api/plans';
import { mintPayrollToken, batchHireWorkers, getHiringQuote } from './api/payrollhiring';
import { getWorkers, getDashboardStats, getWorkerMetadata, addWorker, getWorkerByAddress, updateWorkerTokenUtxo } from './api/workers';
import { broadcastPackage, checkRpcHealth, getNodeInfo } from './api/broadcast-package';
import { getPendingApprovals, terminateWorker, approveTermination, getTreasuryStats, getAuditLogs } from './api/treasury';
import { 
  registerCompany, 
  getCompany, 
  listCompanies, 
  deleteCompany, 
  updateTreasuryHex 
} from './api/companies';
import { initDatabase } from './db/schema';
import { turso } from './db/client';

const app = express();
const PORT = process.env.PORT || 3002;

// ============================================================
// Database connection - Using Turso instead of local SQLite
// ============================================================
const db = turso;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =========================================================================
// FIX: Handle BigInt serialization for Turso responses
// This applies to ALL routes automatically and prevents the
// "Do not know how to serialize a BigInt" error
// =========================================================================
app.set('json replacer', (key: string, value: any) => {
    if (typeof value === 'bigint') {
        // Convert BigInt to Number for JSON serialization
        return Number(value);
    }
    return value;
});

// Make db available to route handlers
app.locals.db = db;

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// ============================================================
// COMPANY ROUTES
// ============================================================
app.post('/api/companies/register', registerCompany);
app.get('/api/companies', listCompanies);
app.get('/api/companies/:employerAddress', getCompany);
app.delete('/api/companies/:employerAddress', deleteCompany);
app.patch('/api/companies/:employerAddress/treasury', updateTreasuryHex);

// ============================================================
// PLAN ROUTES
// ============================================================
app.post('/api/plans/mint', createPayrollPlan);
app.get('/api/plans', getPlans);
app.get('/api/plans/:appId', getPlanById);

// ============================================================
// PAYROLL ROUTES
// ============================================================
app.post('/api/payrollhiring/mint', mintPayrollToken);
app.post('/api/payrollhiring/batch', batchHireWorkers);
app.post('/api/payrollhiring/quote', getHiringQuote);

// ============================================================
// WORKER ROUTES
// ============================================================
app.get('/api/workers', getWorkers);
app.post('/api/workers/add', addWorker);
app.get('/api/workers/:address', getWorkerByAddress);
app.get('/api/dashboard/stats', getDashboardStats);
app.get('/api/worker-metadata/:address', getWorkerMetadata);
app.post('/api/workers/terminate', terminateWorker);
app.post('/api/workers/update-token-utxo', updateWorkerTokenUtxo);

// ============================================================
// TREASURY ROUTES
// ============================================================
app.get('/api/treasury/pending', getPendingApprovals);
app.get('/api/treasury/stats/:employerAddress', getTreasuryStats);
app.get('/api/treasury/audit', getAuditLogs);
app.post('/api/treasury/approve', approveTermination);

// ============================================================
// BROADCAST ROUTES
// ============================================================
app.post('/api/broadcast-package', broadcastPackage);
app.get('/api/broadcast/health', checkRpcHealth);
app.get('/api/broadcast/node-info', getNodeInfo);

// ============================================================
// IPFS CID LOOKUP ROUTE
// ============================================================
app.get('/api/ipfs/cid/:metadataHash', async (req, res) => {
  const { metadataHash } = req.params;
  
  try {
    const { getCidByMetadataHash } = await import('./db/schema');
    const cid = await getCidByMetadataHash(db, metadataHash);
    
    if (!cid) {
      return res.status(404).json({ error: 'CID not found for metadata hash' });
    }
    
    res.json({ cid });
  } catch (error: any) {
    console.error('[IPFS CID] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// FALLBACK ROUTE
// ============================================================
app.use((req, res) => {
  console.warn(`[404] Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// ============================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[ERROR] ${err.message}`);
  console.error(err.stack);
  
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;
  
  res.status(err.status || 500).json({ 
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ============================================================
// START SERVER (with database initialization)
// ============================================================

/**
 * Initialize database and start server
 */
async function startServer() {
  try {
    console.log('🔧 Initializing database connection with Turso...');
    
    // Initialize tables using the updated schema [4]
    await initDatabase(db);
    console.log('✅ Database tables created/verified');

    // Verify companies table exists
    const tableCheck = await db.execute({ 
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='companies'", 
      args: [] 
    });

    if (!tableCheck.rows || tableCheck.rows.length === 0) {
      throw new Error('companies table not found after initialization');
    }
    
    // =========================================================================
    // LOG RECOGNITION: Confirm the unified vault column is accessible
    // This verifies the company table has the vaultAddress column for the new architecture
    // =========================================================================
    try {
      const vaultCheck = await db.execute({ 
        sql: "SELECT vaultAddress FROM companies LIMIT 1", 
        args: [] 
      });
      
      if (vaultCheck.rows && vaultCheck.rows.length > 0) {
        console.log('✅ Verified "vaultAddress" column is present in schema');
        
        // FIX: Use type assertion 'as string' so TypeScript allows the substring method
        const firstRow = vaultCheck.rows[0];
        const rawAddress = firstRow.vaultAddress as string;
        
        if (rawAddress) {
          console.log(`   Sample vault address: ${rawAddress.substring(0, 30)}...`);
        } else {
          console.log('   (Vault address column exists but no companies registered yet)');
        }
      } else {
        // Table has no rows yet, but column exists
        console.log('✅ Verified "vaultAddress" column is present in schema (table empty)');
      }
    } catch (e: any) {
      console.warn('⚠️ WARNING: "vaultAddress" column missing from companies table!');
      console.warn('   Please run the ALTER TABLE command to add it:');
      console.warn('   ALTER TABLE companies ADD COLUMN vaultAddress TEXT;');
      // Continue startup - don't crash, just warn
    }

    // Verify companies table exists using Turso syntax
    console.log('✅ Verified companies table exists');
    
    // Start server
    const server = app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🏢 CHARMS INC. PAYROLL BACKEND                          ║
║   Version: 1.0.0                                          ║
║   Port: ${PORT}                                              ║
║   Environment: ${process.env.NODE_ENV || 'development'}                         ║
║   Database: Turso (Cloud SQLite)                          ║
║                                                           ║
║   Ready to serve:                                         ║
║   • Companies: /api/companies/*                           ║
║   • Plans: /api/plans/*                                   ║
║   • Payroll: /api/payrollhiring/*                         ║
║   • Workers: /api/workers/*                               ║
║   • Treasury: /api/treasury/*                             ║
║   • Broadcast: /api/broadcast-package                     ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
      `);
    });
    
    // Handle server errors
    server.on('error', (err) => {
      console.error('Server error:', err);
      process.exit(1);
    });
    
  } catch (error: any) {
    console.error('❌ Failed to initialize database:', error.message);
    console.error(error.stack);
    console.error('Server startup aborted.');
    process.exit(1);
  }
}

// Graceful shutdown - Turso doesn't need db.close(), but keep for compatibility
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server...');
  process.exit(0);
});

// Start the server
startServer();

export default app;