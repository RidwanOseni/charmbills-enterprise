CharmBills - Bitcoin Subscription Engine


A full-stack Bitcoin subscription platform built on Charms protocol, enabling merchants to create on-chain subscription plans and users to subscribe using Taproot wallets.


## 🚀 Quick Start


### 1. Clone & Setup
```bash
git clone <repository-url>
cd charmbills-hackathon
2. Environment Setup
bash
# Copy environment templates
cp charmbills-backend/.env.example charmbills-backend/.env
3. Install Dependencies
Important: This is not a traditional monorepo with shared dependencies. Each directory must be installed separately:
bash
# Backend (Node.js/TypeScript)
cd charmbills-backend
npm install


# Frontend (Next.js)
cd ../charmbills-frontend
npm install


# Subscription Engine (Rust/Charms)
cd ../subscription-engine
# Install Rust if needed: https://rustup.rs/
cargo build
4. Charms App Setup
bash
cd subscription-engine
# Generate your Charms app verification key
charms app build > app.b64
charms app vk
# Update HARDCODED_APP_VK in shared/constants.ts with the output
5. Bitcoin Testnet Setup
Install Bitcoin Core v28+
Configure bitcoin.conf:
ini
testnet4=1
server=1
txindex=1
rpcuser=your_username
rpcpassword=your_password
Get testnet BTC from a faucet
Create/load a wallet:
bash
bitcoin-cli createwallet testwallet
bitcoin-cli loadwallet testwallet
6. Running the Application
bash
# Terminal 1: Backend API (Port 3001)
cd charmbills-backend
npm run dev


# Terminal 2: Frontend (Port 3000)
cd charmbills-frontend
npm run dev


# Terminal 3: Charms Prover (Optional - for local proving)
cd subscription-engine
charms server
# Then update PROVER_API_URL in backend/.env
📁 Project Structure
text
charmbills-hackathon/
├── charmbills-backend/     # Node.js API server (Express)
├── charmbills-frontend/    # Next.js React frontend
├── subscription-engine/    # Rust Charms app
└── shared/                 # TypeScript types & constants
Note: Each directory has independent package.json/Cargo.toml and must be installed/run separately.
🔧 Configuration
Backend (.env)
env
PROVER_API_URL=https://v8.charms.dev/spells/prove
# or use local: http://localhost:17784/spells/prove
APP_BINARY_BASE64=<base64-encoded-app-binary>
HARDCODED_APP_VK=<your-app-verification-key>
RPC_USER=bitcoin_username
RPC_PASSWORD=bitcoin_password

Shared Constants
Update shared/constants.ts with your Charms app verification key:

export const HARDCODED_APP_VK = "your_32_byte_hex_key_here";

🛠️ Key Features
Merchant Dashboard
Create on-chain subscription plan NFTs
Track remaining subscription capacity
View on-chain assets
Subscriber Portal
Browse available subscription plans
Mint subscription tokens with Leather wallet
Automatic subscription status detection
Charms Integration
NFT authority minting (Plan creation)
Fungible token minting (Subscription access)
ZK-proof generation via Charms prover
Package transaction broadcasting

🧩 Architecture
text
User Wallet (Leather)
    ↓
Frontend (Next.js) → Backend (Express) → Charms Prover API
    ↓                        ↓
Local Storage           Bitcoin RPC (testnet4)

📝 Usage Flow
Merchant creates plan:
Navigate to /dashboard
Connect Leather wallet
Fill plan details → Creates Plan NFT
User subscribes:
Navigate to /subscribe?id=<plan-id>
Connect wallet
Click "Subscribe" → Mints subscription token
Verification:
Backend checks on-chain token ownership
Frontend updates subscription status

🔍 Testing
Test Charms App Locally
bash
cd subscription-engine
# Test spell validation
cat spells/mint-nft.yaml | envsubst | charms spell check


# Generate test transactions
cat spells/mint-nft.yaml | envsubst | charms spell prove
Test API Endpoints
bash
# Create Plan NFT
curl -X POST http://localhost:3001/api/plans/mint \
  -H "Content-Type: application/json" \
  -d '{"anchorUtxo":"...", "anchorValue":1000, ...}'


# Mint Subscription Token
curl -X POST http://localhost:3001/api/subscriptions/mint \
  -H "Content-Type: application/json" \
  -d '{"authorityUtxo":"...", "subscriberAddress":"...", ...}'

⚠️ Important Notes
Testnet Only: This implementation uses Bitcoin testnet4
Wallet Required: Leather wallet with Taproot support
UTXO Management: The system tracks used UTXOs in localStorage
No Database: Uses localStorage for simplicity (production needs DB)

🐛 Troubleshooting
Common Issues
"No fresh UTXOs available"
Get more testnet BTC from faucet
Run clearUsedUtxos() in browser console
Prover API timeouts
Increase timeout in proverClient.ts
Run local prover: charms server
Transaction failures
Check Bitcoin node sync status
Verify UTXOs aren't already spent
Ensure sufficient fees
Debug Commands
javascript
// In browser console
await debugUtxos(yourAddress)
clearUsedUtxos()

📚 Resources

Charms Documentation
Bitcoin Testnet Faucet
Leather Wallet
Mempool Testnet Explorer

🎯 Vision: API/SDK Solution
CharmBills isn't just another subscription platform—it's a foundation for programmable digital relationships:
Why This Matters

True Digital Ownership: Subscriptions become transferable assets, not just access rights
Industry-Agnostic: From SaaS to gaming, one protocol fits all payment models
DeFi Integration: Subscription tokens can participate in broader crypto economy
User Empowerment: Customers control their subscriptions completely
Merchant Flexibility: Customize pricing, transfer rules, and token behavior

Target Developers
We plan to offer this as an API/SDK solution so developers don't need to build payment solutions from scratch. Ideal for:
SaaS platforms needing subscription management
Content creators wanting token-gated access
Game developers implementing premium features
DeFi protocols with recurring fee structures
Future Roadmap & Vision

Phase 1: Enhanced Token Economics
Transferable Subscriptions: Enable gifting, resale markets & corporate accounts
Auto-Subscription with Scrolls: Users can lock payments for automatic recurring billing
Flexible Token Rules: Merchants customize transferability and access controls


Phase 2: Diverse Payment Strategies
AI/API Services: Pay-per-use tokens, subscription bundles
Content Creators: Tiered subscriptions, time-limited access
DeFi & Gaming: One-time purchases, staking rewards, dynamic pricing

Phase 3: Production Features
Database integration (PostgreSQL/Redis)
Payment amount validation
Subscription renewal logic
Webhook system for real-time events
Mainnet deployment with security audits

Phase 4: Advanced Features
Token composability (subscriptions as collateral)
Revenue sharing between creators/platforms
Cross-chain support (Lightning Network integration)
Privacy features
Mobile SDK
Analytics dashboard

📄 License
MIT License - see LICENSE file for details.



