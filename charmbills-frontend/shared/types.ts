// --- 1. Employment/Engagement Types ---
export type EngagementType = 'full-time' | 'part-time' | 'freelancer' | 'contractor' | 'other';
export type ScrollPolicyType = 'time' | 'proof' | 'hybrid';
export type PayPeriodUnit = 'weekly' | 'biweekly' | 'monthly' | 'custom' | 'demo';

// --- 2. Plan (Employment Contract Definition) ---
// Represents a job role or employment contract created by the employer
export interface Plan {
  id: string;                          // Internal UUID
  serviceName: string;                  // "Charms Inc Engineering Department"
  role: string;                         // "Senior Rust Engineer"
  
  // Payroll-specific fields
  engagementType: EngagementType;        // Type of worker
  compensationSats: number;              // Sats per pay period
  payPeriodSeconds: number;               // Duration in seconds (e.g., 1209600 for 2 weeks)
  payPeriodUnit: PayPeriodUnit;           // Human-readable unit
  scrollPolicyType: ScrollPolicyType;     // How settlement triggers
  
  // On-chain authority
  merchantAddress: string;                // Employer's Bitcoin address
  nftUtxoId: string;                      // txid:vout of Plan NFT
  appId: string;                           // Charms app ID
  appVk: string;                            // Verification key
  
  // Multi-signature security
  multiSigSigners?: string[];              // Array of pubkeys for 2-of-3
  multiSigThreshold?: number;               // Default 2
  
  // Metadata
  createdAt: string;                        // ISO string
  expiresAt?: string;                        // Optional contract end date
}

// --- 3. CharmPlanNFT (On-Chain Authority Object) ---
// The actual NFT stored on Bitcoin that controls minting authority
export interface CharmPlanNFT {
  utxoId: string;
  ownerAddress: string;
  metadata: {
    ticker: string;        // "CHARMS-PAY"
    remaining: number;     // Supply for periods
    metadataHash: string;  // SHA256 of encrypted IPFS JSON
    scrollPolicy: number;  // 0=Time, 1=Proof
    payPeriodSeconds: number;
    compensationSats: number;
  };
}

// --- 4. EncryptedPayrollMetadata (Stored on IPFS) ---
// Sensitive data encrypted before IPFS upload
export interface EncryptedPayrollMetadata {
  // Core HR fields (encrypted)
  employeeName?: string;                      
  employeeWallet?: string;                     
  role: string;                                 // "Senior Rust Engineer"
  department: string;                           // "Engineering"
  
  // Compensation details (encrypted)
  baseSalarySats: number;                       // Per period
  bonusEligible: boolean;                       
  bonusStructure?: string;                        // "quarterly" | "milestone"
  
  // Employment terms (encrypted)
  startDate: string;                             // ISO string
  endDate?: string;                               // For fixed-term contracts
  reportingTo: string;                            // Manager name/ID
  
  // Freelancer-specific (encrypted)
  projectScope?: string;                          // Description of work
  deliverables?: string[];                         // Expected outputs
  approvalRequired: boolean;                        // Whether manager must sign
  
  // UI hints (not sensitive, can be public)
  uiTemplate: 'employee' | 'freelancer' | 'contractor';
  displayColor?: string;
  iconUrl?: string;
}

// --- 5. SubscriptionToken (Worker's Proof of Employment) ---
// The token minted to workers proving active status
export interface SubscriptionToken {
  utxoId: string;                              // txid:vout
  ownerAddress: string;                         // Worker's wallet
  planUtxoId: string;                            // Parent Plan NFT
  metadata: {
    period: string;                               // "March 2026" or "Week 12"
    validFrom: string;                             // ISO timestamp
    validTo: string;                                // ISO timestamp
    status: 'active' | 'completed' | 'pending_approval';
  };
  amount: number;                                 // Usually 1
}

// --- 6. SpellRequest (Protocol Interaction) ---
// Intent to perform Charms action
export interface SpellRequest {
  type: 'mint-nft' | 'mint-token' | 'send' | 'scroll-create' | 'scroll-release' | 'scroll-freeze';
  authorityUtxo?: string;
  anchorUtxo?: string;
  anchorValue?: number;
  fundingUtxo: string;
  fundingUtxoValue: number;
  changeAddress: string;
  feeRate: number;
  utxoAddress?: string;

  planMetadata?: {
    anchorUtxo?: string;
    [key: string]: any;
  };
  
  // Multi-signature support
  multiSigSigners?: string[];                    // For 2-of-3 treasury
  multiSigThreshold?: number;
  
  // Outputs
  outputs: Array<{
    address: string;
    tokenAmount?: number;
    nftMetadata?: CharmPlanNFT['metadata'];
    sats?: number;
  }>;
}

// --- 7. ScrollPolicy (Settlement Rules) ---
// Defines how and when Scroll releases funds
export interface ScrollPolicy {
  type: ScrollPolicyType;
  
  // For time-based (employees)
  intervalSeconds?: number;                        // e.g., 1209600 for 2 weeks
  startBlock?: number;                              // When policy begins
  endBlock?: number;                                 // Optional expiration
  
  // For proof-based (freelancers)
  requiredSigners?: string[];                        // Manager pubkeys
  requiredApprovals?: number;                         // e.g., 2 of 3
  
  // For hybrid
  approvalWindow?: number;                            // Time to approve before auto-release
}

// --- 8. TransactionRecord (Operational Tracking) ---
export interface TransactionRecord {
  id: string;
  planId?: string;
  workerAddress?: string;
  commitTxHex: string;
  spellTxHex: string;
  commitTxId?: string;
  spellTxId?: string;
  status: 'pending' | 'confirmed' | 'failed' | 'mined';
  type: 'plan-creation' | 'hire' | 'payment-release';
  createdAt: string;
  confirmedAt?: string;
}

// --- 9. ProverResult (Frontend Receipt) ---
// FIX: Updated to include dualUtxoContext for Sequential Signing [Source 769, 939]
export interface ProverResult {
  commitTxHex: string;
  spellTxHex: string;
  isSingle?: boolean;
  commitOutput?: {
    scriptPubKey: string;
    value: number;
  };
  // CRITICAL: Dual UTXO Context for Leather wallet to correctly sign
  // the Spell transaction after the Commit transaction is generated
  dualUtxoContext?: {
    anchor: {
      utxoId: string;
      hex: string;
      value: number;
    };
    fee: {
      utxoId: string;
      value: number;
    };
  };
}

// --- 10. Legacy Types (For SaaS Compatibility) ---
// Keep these if you still support SaaS customers
export type BillingCycle = 'weekly' | 'monthly' | 'yearly' | 'demo';

export interface SaaSPlan {
  id: string;
  serviceName: string;
  priceBtc: number;
  billingCycle: BillingCycle;
  merchantAddress: string;
  nftUtxoId: string;
  appId: string;
  appVk: string;
  createdAt: string;
}

// --- 11. WorkerStatus (For Dashboard UI) ---
export interface WorkerStatus {
  wallet: string;
  name?: string;
  role: string;
  engagementType: EngagementType;
  currentPeriod: {
    tokenId: string;
    validFrom: string;
    validTo: string;
    status: 'active' | 'pending' | 'completed';
  };
  lastPayment?: {
    amount: number;
    date: string;
    txid: string;
  };
  nextPayment?: {
    amount: number;
    estimatedDate: string;
  };
}

export interface EncryptedPayrollResult {
  version: '1.0';
  encryptedData: {
    iv: string;
    content: string;
    tag: string;
  };
  cid: string;
  metadataHash: string; // 64-char hex
}