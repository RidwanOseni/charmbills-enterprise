import express from 'express';
import cors from 'cors';
import { createPayrollPlan } from './api/plans';        // ← NEW payroll version
import { mintPayrollToken } from './api/payrollhiring'; // ← NEW payroll version
import { getWorkers, getDashboardStats, getWorkerMetadata } from './api/workers';
import { broadcastPackage } from './api/broadcast-package';
import { getPendingApprovals, terminateWorker, approveTermination } from './api/treasury';

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());

// Payroll Route: Create Department Plan NFT
app.post('/api/plans/mint', createPayrollPlan);  

// Payroll Route: Mint Worker Tokens (Batch hire)
app.post('/api/payrollhiring/mint', mintPayrollToken);  

// Broadcast Route: Submit signed packages
app.post('/api/broadcast-package', broadcastPackage);  

// NEW: Data Retrieval routes for Phase 4 Dashboard
app.get('/api/workers', getWorkers);
app.get('/api/dashboard/stats', getDashboardStats);
app.get('/api/worker-metadata/:address', getWorkerMetadata);

app.get('/api/treasury/pending', getPendingApprovals);
app.post('/api/workers/terminate', terminateWorker);
app.post('/api/treasury/approve', approveTermination);

app.listen(PORT, () => console.log(`CharmBills Payroll Backend running on port ${PORT}`));