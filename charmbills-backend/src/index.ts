import express from 'express';
import cors from 'cors';
import { createPayrollPlan, getPlans, getPlanById } from './api/plans';
import { mintPayrollToken, batchHireWorkers, getHiringQuote } from './api/payrollhiring';
import { getWorkers, getDashboardStats, getWorkerMetadata } from './api/workers';
import { broadcastPackage, checkRpcHealth, getNodeInfo } from './api/broadcast-package';
import { getPendingApprovals, terminateWorker, approveTermination } from './api/treasury';
import { 
  registerCompany, 
  getCompany, 
  listCompanies, 
  deleteCompany, 
  updateTreasuryHex 
} from './api/companies';

const app = express();
const PORT = process.env.PORT || 3002;

// ============================================================
// MIDDLEWARE
// ============================================================

// Basic middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase limit for large transaction hexes

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
// HEALTH CHECK (for monitoring)
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
// PLAN ROUTES (NFT Creation)
// ============================================================
app.post('/api/plans/mint', createPayrollPlan);
app.get('/api/plans', getPlans);
app.get('/api/plans/:appId', getPlanById);

// ============================================================
// PAYROLL ROUTES (Worker Token Minting)
// ============================================================
app.post('/api/payrollhiring/mint', mintPayrollToken);
app.post('/api/payrollhiring/batch', batchHireWorkers);
app.post('/api/payrollhiring/quote', getHiringQuote);

// ============================================================
// WORKER ROUTES
// ============================================================
app.get('/api/workers', getWorkers);
app.get('/api/dashboard/stats', getDashboardStats);
app.get('/api/worker-metadata/:address', getWorkerMetadata);
app.post('/api/workers/terminate', terminateWorker);

// ============================================================
// TREASURY ROUTES (Multi-sig Governance)
// ============================================================
app.get('/api/treasury/pending', getPendingApprovals);
app.post('/api/treasury/approve', approveTermination);

// ============================================================
// BROADCAST ROUTES (Bitcoin RPC)
// ============================================================
app.post('/api/broadcast-package', broadcastPackage);
app.get('/api/broadcast/health', checkRpcHealth);
app.get('/api/broadcast/node-info', getNodeInfo);

// ============================================================
// FALLBACK ROUTE (404 Handler)
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
  
  // Don't leak internal errors in production
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;
  
  res.status(err.status || 500).json({ 
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🏢 CHARMS INC. PAYROLL BACKEND                          ║
║   Version: 1.0.0                                          ║
║   Port: ${PORT}                                              ║
║   Environment: ${process.env.NODE_ENV || 'development'}                         ║
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server...');
  process.exit(0);
});

export default app;