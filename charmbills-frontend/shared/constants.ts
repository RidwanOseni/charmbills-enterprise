// Core Protocol Constants
export const HARDCODED_APP_VK = "496d1661bb0fe62eb9fc49ae1956e9b45b01dfb5a8e4201333b1562c2fad5296";
export const PROVER_API_URL = "https://v12.charms.dev/spells/prove";
export const DEFAULT_FEE_RATE = 2;
export const MIN_OUTPUT_SATS = 1000;

// Asset Identifiers
export const PAYROLL_NFT_TICKER = "CHARMS-PAY"; // For payroll/employment plans

// Scroll Protocol Fees (as specified by Charms docs)
export const SCROLL_FIXED_COST = 895;           // Fixed cost per vault
export const SCROLL_FEE_PER_INPUT = 64;         // Per input fee
export const SCROLL_BASIS_POINTS = 10;          // 0.1% of total sats
export const SCROLL_FEE_ADDRESS_TESTNET4 = "tb1qrk6da5g0592sx6lmgpchaf5qy2lgn8am7cuf3a";

// Time Constants (in seconds)
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_WEEK = 604800;
export const SECONDS_PER_BIWEEK = 1209600;      // 2 weeks
export const SECONDS_PER_MONTH = 2592000;        // 30 days

// Demo Mode Constants (for investor presentation)
export const DEMO_SECONDS_PER_PERIOD = 480;       // 1 minute = 1 pay period for demo

// Multi-signature Defaults
export const DEFAULT_MULTISIG_THRESHOLD = 2;     // 2-of-3 default
export const MAX_MULTISIG_SIGNERS = 5;           // Maximum signers allowed

// IPFS/Pinata
export const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs";
export const PINATA_API_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

// Encryption
export const ENCRYPTION_VERSION = "1.0";
export const AES_256_GCM_IV_LENGTH = 12; // bytes

// For indexer
export const DEFAULT_RPC_URL = "http://localhost:8332";
export const DEFAULT_RPC_USER = "";     // Set via env
export const DEFAULT_RPC_PASSWORD = ""; // Set via env
export const INDEXER_BATCH_SIZE = 10;
export const INDEXER_SCAN_INTERVAL_MS = 30000;

export const DEFAULT_RPC_PORT = 48332; 
export const DEFAULT_RPC_HOST = "localhost";