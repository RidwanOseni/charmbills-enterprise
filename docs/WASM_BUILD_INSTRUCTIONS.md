# WASM Build Instructions

The CharmBills frontend requires a WASM module for charm scanning functionality.

## Current Status
⚠️ **WASM module is missing** - The dashboard will work but charm scanning is disabled.

## To Build WASM Module

### Prerequisites
```powershell
# Install Rust if not already installed
# Visit: https://rustup.rs/

# Add WASM target
rustup target add wasm32-unknown-unknown

# Install wasm-pack
cargo install wasm-pack
```

### Build Steps
```powershell
cd subscription-engine
wasm-pack build --target web --out-dir ../charmbills-frontend/lib/wasm
```

This will generate:
- `charms_lib.js`
- `charms_lib_bg.wasm` (the missing file)
- `charms_lib.d.ts`
- `charms_lib_bg.wasm.d.ts`

### After Building
Restart the frontend server:
```powershell
cd charmbills-frontend
npm run dev
```

## What Works Without WASM
✅ Authentication (JWT/API Keys)
✅ Plan Management (Create, Read, Update, Delete)
✅ Database operations
✅ API endpoints
✅ Dashboard UI

## What Requires WASM
❌ Scanning addresses for on-chain charms
❌ Extracting spell data from transactions
❌ Verifying charm ownership

The application is fully functional for testing authentication, plan management, and database features without WASM.
